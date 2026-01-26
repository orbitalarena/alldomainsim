#ifndef AIRCRAFT_HPP
#define AIRCRAFT_HPP

#include "entity.hpp"
#include "core/state_vector.hpp"
#include <string>
#include <vector>

namespace sim {

// Aircraft configuration parameters
struct AircraftConfig {
    std::string name = "Generic Aircraft";
    std::string model_path = "";  // Path to 3D model (.glb, .gltf)

    // Mass properties
    double empty_mass = 41000.0;      // kg (empty operating weight)
    double max_fuel = 20000.0;        // kg
    double payload_mass = 15000.0;    // kg (passengers + cargo)

    // Aerodynamic properties
    double wing_area = 125.0;         // m² (wing reference area)
    double wing_span = 35.8;          // m
    double aspect_ratio = 10.0;       // AR = b²/S
    double oswald_efficiency = 0.85;  // Oswald efficiency factor
    double cd0 = 0.025;               // Zero-lift drag coefficient
    double cl_max = 2.1;              // Maximum lift coefficient (with flaps)

    // Engine properties (twin-engine)
    int num_engines = 2;
    double max_thrust_per_engine = 120000.0;  // N (sea level static)
    double tsfc = 0.6;                // Thrust-specific fuel consumption (kg/N/hr)

    // Performance limits
    double max_mach = 0.82;           // Maximum operating Mach
    double service_ceiling = 12500.0; // m (~41,000 ft)
    double max_bank_angle = 30.0;     // degrees (standard turn limit)
    double max_climb_rate = 20.0;     // m/s
    double max_descent_rate = 15.0;   // m/s
};

// Flight phase enumeration
enum class FlightPhase {
    PARKED,
    TAXI,
    TAKEOFF,
    CLIMB,
    CRUISE,
    DESCENT,
    APPROACH,
    LANDING,
    LANDED
};

// Waypoint for flight planning
struct Waypoint {
    std::string name;
    double latitude;    // degrees
    double longitude;   // degrees
    double altitude;    // meters MSL
    double target_speed; // m/s (indicated airspeed)
    bool is_required = true;  // Must pass through vs can skip
};

// Wind vector at a point
struct WindVector {
    double speed;       // m/s
    double direction;   // degrees (from which wind blows, meteorological convention)
    double altitude;    // m (reference altitude)
};

// Flight state for telemetry/logging
struct FlightState {
    double time;
    FlightPhase phase;

    // Position
    double latitude;
    double longitude;
    double altitude_msl;    // meters above mean sea level
    double altitude_agl;    // meters above ground level

    // Velocities
    double groundspeed;     // m/s
    double true_airspeed;   // m/s
    double indicated_airspeed; // m/s
    double vertical_speed;  // m/s (positive = climbing)
    double mach_number;

    // Attitude
    double heading;         // degrees true
    double track;           // degrees true (ground track)
    double pitch;           // degrees (positive = nose up)
    double bank;            // degrees (positive = right wing down)

    // Performance
    double throttle;        // 0-1
    double thrust;          // N
    double drag;            // N
    double lift;            // N
    double fuel_remaining;  // kg
    double fuel_flow;       // kg/hr
    double range_remaining; // km (estimated)

    // Environment
    double wind_speed;      // m/s
    double wind_direction;  // degrees
    double air_temperature; // K
    double air_density;     // kg/m³
};

class Aircraft : public Entity {
public:
    Aircraft(int id, const std::string& callsign, const AircraftConfig& config);

    // Entity interface
    void update(double dt) override;
    std::string get_model_path() const override { return config_.model_path; }

    // Flight plan
    void set_flight_plan(const std::vector<Waypoint>& waypoints);
    void add_waypoint(const Waypoint& wp);
    const std::vector<Waypoint>& get_flight_plan() const { return flight_plan_; }
    int get_current_waypoint_index() const { return current_waypoint_; }

    // State control
    void set_initial_position(double lat, double lon, double alt_msl);
    void set_fuel(double fuel_kg);
    void set_throttle(double throttle);  // 0-1
    void set_target_altitude(double alt_m);
    void set_target_speed(double speed_ms);
    void set_target_heading(double heading_deg);

    // State queries
    FlightState get_flight_state() const;
    FlightPhase get_phase() const { return phase_; }
    void set_phase(FlightPhase phase) { phase_ = phase; }
    double get_fuel_remaining() const { return fuel_mass_; }
    double get_total_mass() const;
    bool has_reached_destination() const;

    // Wind
    void set_wind(const WindVector& wind);
    void set_wind_field(const std::vector<WindVector>& winds);  // Altitude-varying

    // Configuration
    const AircraftConfig& get_config() const { return config_; }

    // Bank angle control (for derived classes)
    void set_bank_angle(double bank) { bank_angle_ = bank; }
    double get_bank_angle() const { return bank_angle_; }

    // Direct heading/speed/altitude setters for maneuvers
    void set_heading(double hdg) { heading_ = hdg; }
    double get_heading() const { return heading_; }
    void set_true_airspeed(double tas) { true_airspeed_ = tas; }
    double get_true_airspeed() const { return true_airspeed_; }

protected:
    AircraftConfig config_;
    std::string callsign_;

    // Flight plan
    std::vector<Waypoint> flight_plan_;
    int current_waypoint_ = 0;

    // Current state
    FlightPhase phase_ = FlightPhase::PARKED;
    double fuel_mass_;
    double throttle_ = 0.0;

    // Targets (for autopilot)
    double target_altitude_ = 0.0;
    double target_speed_ = 0.0;
    double target_heading_ = 0.0;
    bool heading_hold_ = false;

    // Derived state
    double true_airspeed_ = 0.0;
    double groundspeed_ = 0.0;
    double mach_ = 0.0;
    double angle_of_attack_ = 0.0;
    double bank_angle_ = 0.0;
    double pitch_angle_ = 0.0;
    double heading_ = 0.0;
    double track_ = 0.0;

    // Wind
    std::vector<WindVector> wind_field_;

    // Physics helpers
    void update_autopilot(double dt);
    void update_aerodynamics(double dt);
    void update_propulsion(double dt);
    void update_kinematics(double dt);
    void update_fuel(double dt);
    void update_phase();

    double compute_lift_coefficient() const;
    double compute_drag_coefficient(double cl) const;
    double compute_thrust() const;
    double get_air_density() const;
    double get_speed_of_sound() const;
    WindVector get_wind_at_altitude(double alt) const;

    // Navigation
    double distance_to_waypoint(const Waypoint& wp) const;
    double bearing_to_waypoint(const Waypoint& wp) const;
    void navigate_to_waypoint(double dt);

    // Coordinate helpers
    void geodetic_to_ecef(double lat, double lon, double alt,
                          double& x, double& y, double& z) const;
    void ecef_to_geodetic(double x, double y, double z,
                          double& lat, double& lon, double& alt) const;
};

// Utility: Create a great circle route between two points
std::vector<Waypoint> create_flight_route(
    const std::string& departure_name, double dep_lat, double dep_lon,
    const std::string& arrival_name, double arr_lat, double arr_lon,
    double cruise_altitude_m, double cruise_speed_ms,
    int num_intermediate_waypoints = 5);

} // namespace sim

#endif // AIRCRAFT_HPP
