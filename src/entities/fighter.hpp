#ifndef FIGHTER_HPP
#define FIGHTER_HPP

#include "aircraft.hpp"
#include <vector>
#include <memory>
#include <functional>

namespace sim {

// Forward declarations
class Missile;
class Fighter;

// Team affiliation
enum class Team {
    BLUE,
    RED
};

// Tactical AI states for BVR combat
enum class TacticalState {
    PATROL,      // Flying assigned heading, searching
    DETECTED,    // Enemy detected, evaluating
    COMMIT,      // Committed to engage, turning hot
    LAUNCH,      // In launch envelope, firing
    CRANK,       // Guiding missile, beam maneuver (perpendicular)
    PUMP,        // Turned cold, extending, will recommit
    DEFEND,      // Defending against incoming missile
    MERGE,       // Close-in dogfight (WVR)
    DISENGAGE,   // Breaking off engagement
    KILLED       // Aircraft destroyed
};

// Radar contact
struct RadarContact {
    int target_id;
    double range;           // meters
    double bearing;         // degrees relative to nose
    double aspect_angle;    // degrees (0 = head-on, 180 = tail)
    double closure_rate;    // m/s (positive = closing)
    double altitude;        // meters
    bool is_locked;
    double time_since_update;
};

// Missile loadout
struct MissileLoadout {
    int aim120_count = 4;   // AMRAAM (active radar, BVR)
    int aim9_count = 2;     // Sidewinder (IR, WVR)
};

// Fighter configuration
struct FighterConfig : public AircraftConfig {
    // Combat parameters
    double radar_range = 150000.0;      // 150 km radar range
    double radar_fov = 120.0;           // degrees (±60° from nose)
    double rwr_range = 200000.0;        // Radar Warning Receiver range
    double max_g = 9.0;                 // Maximum G loading
    double corner_speed = 180.0;        // m/s - best turn rate speed

    // Missile parameters
    double aim120_max_range = 100000.0; // 100 km
    double aim120_min_range = 3000.0;   // 3 km
    double aim120_nez = 50000.0;        // No-Escape Zone
    double aim9_max_range = 18000.0;    // 18 km
    double aim9_min_range = 500.0;      // 500 m

    // Tactical thresholds
    double commit_range = 80000.0;      // Range to commit
    double crank_angle = 70.0;          // Degrees off-boresight for crank
    double pump_range = 40000.0;        // Range to start pump
    double merge_range = 5000.0;        // WVR merge range
    double disengage_range = 150000.0;  // Range to break off

    FighterConfig() {
        // Override aircraft defaults for fighter
        name = "F-16C Fighting Falcon";
        empty_mass = 8570.0;
        max_fuel = 3200.0;
        payload_mass = 500.0;
        wing_area = 27.87;
        wing_span = 9.96;
        aspect_ratio = 3.56;
        cd0 = 0.022;
        cl_max = 1.6;
        max_thrust_per_engine = 127000.0;  // With afterburner
        num_engines = 1;
        max_mach = 2.0;
        service_ceiling = 15000.0;
        max_bank_angle = 80.0;
        max_climb_rate = 250.0;
        max_descent_rate = 150.0;
    }
};

// Missile class
class Missile {
public:
    enum class Type { AIM120, AIM9 };
    enum class State { ON_RAIL, FLYING, ACTIVE, TERMINAL, HIT, MISS };

    int id;
    Type type;
    State state = State::ON_RAIL;
    int shooter_id;
    int target_id;
    Team team;

    // Position and velocity
    double lat, lon, alt;
    double heading;
    double speed;           // m/s
    double time_of_flight;

    // Guidance
    double target_lat, target_lon, target_alt;
    bool has_lock;
    double seeker_gimbal_limit = 40.0;  // degrees

    // Performance
    double max_speed = 1400.0;      // m/s (Mach 4+)
    double max_range;
    double max_g = 40.0;
    double motor_burn_time = 8.0;   // seconds
    double coast_time = 30.0;       // seconds after motor burnout

    Missile(int id, Type type, int shooter, int target, Team team);
    void launch(double lat, double lon, double alt, double hdg, double spd);
    void update(double dt, double tgt_lat, double tgt_lon, double tgt_alt);
    double distance_to_target() const;
    bool is_active() const { return state == State::FLYING || state == State::ACTIVE || state == State::TERMINAL; }
};

// Debris piece from destroyed aircraft
class Debris {
public:
    int id;
    int source_fighter_id;
    Team team;

    // Position (geodetic)
    double lat, lon, alt;

    // Velocity in local ENU frame (m/s)
    double vel_east, vel_north, vel_up;

    // Physical properties
    double mass;            // kg (varies per piece)
    double drag_area;       // m² (effective drag area)
    double drag_coeff;      // ~1.0-2.0 for tumbling debris

    // State
    bool is_falling = true;
    double time_since_creation = 0.0;

    Debris(int id, int source_id, Team team,
           double lat, double lon, double alt,
           double vel_e, double vel_n, double vel_u,
           double mass, double drag_area);

    void update(double dt);
    bool has_landed() const { return !is_falling; }
};

// Generate debris from destroyed fighter
std::vector<Debris> create_debris_field(int fighter_id, Team team,
                                        double lat, double lon, double alt,
                                        double heading, double speed,
                                        int num_pieces = 12);

class Fighter : public Aircraft {
public:
    Fighter(int id, const std::string& callsign, Team team, const FighterConfig& config);

    // Override update
    void update(double dt) override;

    // Team
    Team get_team() const { return team_; }
    void set_team(Team t) { team_ = t; }

    // Combat state
    TacticalState get_tactical_state() const { return tactical_state_; }
    bool is_alive() const { return !killed_; }
    void kill() { killed_ = true; tactical_state_ = TacticalState::KILLED; }

    // Radar and targeting
    void update_radar(const std::vector<Fighter*>& all_fighters);
    const std::vector<RadarContact>& get_contacts() const { return radar_contacts_; }
    Fighter* get_locked_target() const { return locked_target_; }
    void lock_target(Fighter* target);
    void break_lock();

    // Weapons
    const MissileLoadout& get_loadout() const { return loadout_; }
    const std::vector<std::shared_ptr<Missile>>& get_missiles() const { return missiles_; }
    bool can_fire_aim120() const;
    bool can_fire_aim9() const;
    std::shared_ptr<Missile> fire_aim120();
    std::shared_ptr<Missile> fire_aim9();

    // Tactical AI
    void set_patrol_heading(double hdg) { patrol_heading_ = hdg; }
    void run_tactical_ai(const std::vector<Fighter*>& friendlies,
                         const std::vector<Fighter*>& enemies,
                         const std::vector<std::shared_ptr<Missile>>& incoming);

    // RWR (Radar Warning Receiver)
    bool is_spiked() const { return is_spiked_; }
    bool is_missile_inbound() const { return missile_inbound_; }

    // Maneuvers
    void execute_maneuver_to_heading(double target_heading, double dt);
    void execute_crank(double dt);
    void execute_pump(double dt);
    void execute_break(double dt);
    void execute_pursuit(double dt);

    // Config access
    const FighterConfig& get_fighter_config() const { return fighter_config_; }

private:
    Team team_;
    FighterConfig fighter_config_;
    TacticalState tactical_state_ = TacticalState::PATROL;
    bool killed_ = false;

    // Radar
    std::vector<RadarContact> radar_contacts_;
    Fighter* locked_target_ = nullptr;
    double radar_sweep_time_ = 0.0;

    // RWR
    bool is_spiked_ = false;
    bool missile_inbound_ = false;
    std::vector<int> rwr_contacts_;

    // Weapons
    MissileLoadout loadout_;
    std::vector<std::shared_ptr<Missile>> missiles_;
    int next_missile_id_ = 0;
    double time_since_last_shot_ = 10.0;

    // Tactical AI state
    double patrol_heading_ = 0.0;
    double crank_direction_ = 1.0;  // +1 or -1 for left/right crank
    double pump_timer_ = 0.0;
    double state_timer_ = 0.0;
    int shots_fired_this_engagement_ = 0;

    // Helper functions
    double compute_aspect_angle(const Fighter* target) const;
    double compute_antenna_train_angle(const Fighter* target) const;
    bool is_in_radar_cone(const Fighter* target) const;
    double bearing_to(double lat, double lon) const;
    double range_to(double lat, double lon, double alt) const;
};

// State name helper
const char* tactical_state_name(TacticalState state);

} // namespace sim

#endif // FIGHTER_HPP
