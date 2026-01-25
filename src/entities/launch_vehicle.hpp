#ifndef LAUNCH_VEHICLE_HPP
#define LAUNCH_VEHICLE_HPP

#include "entities/entity.hpp"
#include "coordinate/frame_transformer.hpp"
#include <vector>
#include <functional>

namespace sim {

/**
 * @brief Rocket stage configuration
 */
struct RocketStage {
    double dry_mass;        // kg (structure, engines)
    double propellant_mass; // kg
    double thrust;          // N (vacuum thrust)
    double isp_sl;          // s (sea level specific impulse)
    double isp_vac;         // s (vacuum specific impulse)
    double burn_time;       // s (optional, computed from mass flow if 0)

    // Computed at runtime
    double mass_flow_rate() const;  // kg/s
    double current_isp(double altitude) const;  // Interpolate based on altitude
};

/**
 * @brief Flight phase enumeration
 */
enum class FlightPhase {
    PRE_LAUNCH,      // On pad, waiting for ignition
    VERTICAL_ASCENT, // Initial vertical climb
    GRAVITY_TURN,    // Pitching over
    COAST,           // Engine off, coasting
    CIRCULARIZATION, // Final burn for orbit insertion
    ORBITAL,         // In stable orbit
    MANEUVER         // Executing a planned maneuver
};

/**
 * @brief Scheduled maneuver for the vehicle
 */
struct Maneuver {
    double start_time;      // Simulation time to start [s]
    double duration;        // Burn duration [s]
    Vec3 delta_v;           // Delta-V vector in current frame [m/s]
    bool completed;

    Maneuver() : start_time(0), duration(0), completed(false) {}
    Maneuver(double t, double dur, const Vec3& dv)
        : start_time(t), duration(dur), delta_v(dv), completed(false) {}
};

/**
 * @brief Launch vehicle entity
 *
 * Simulates a multi-stage rocket from ground launch through orbit insertion.
 * Includes thrust, mass flow, atmospheric drag, and gravity turn guidance.
 */
class LaunchVehicle : public Entity {
public:
    /**
     * @brief Construct launch vehicle at ground position
     * @param name Vehicle name
     * @param id Entity ID
     * @param latitude Launch site latitude [deg]
     * @param longitude Launch site longitude [deg]
     * @param altitude Launch site altitude [m] (above sea level)
     */
    LaunchVehicle(const std::string& name, int id,
                  double latitude, double longitude, double altitude = 0.0);

    virtual ~LaunchVehicle() = default;

    // Entity interface
    virtual void update(double dt) override;

    // Stage configuration
    void add_stage(const RocketStage& stage);
    void set_payload_mass(double mass) { payload_mass_ = mass; }

    // Launch control
    void ignite();  // Start engines, begin launch sequence
    void abort();   // Emergency shutdown

    // Guidance
    void set_target_orbit(double altitude, double inclination);
    void set_gravity_turn_start(double altitude, double pitch_rate);

    // Maneuver scheduling
    void add_maneuver(const Maneuver& maneuver);
    void clear_maneuvers();

    // State queries
    FlightPhase get_flight_phase() const { return phase_; }
    int get_current_stage() const { return current_stage_; }
    double get_total_mass() const;
    double get_propellant_remaining() const;
    double get_altitude() const;
    double get_downrange() const;
    double get_velocity_magnitude() const;
    double get_dynamic_pressure() const;
    bool is_in_orbit() const;

    // Aerodynamics
    void set_drag_coefficient(double cd) { drag_coefficient_ = cd; }
    void set_reference_area(double area) { reference_area_ = area; }

    // Cape Canaveral coordinates (default launch site)
    static constexpr double CAPE_CANAVERAL_LAT = 28.5623;   // deg N
    static constexpr double CAPE_CANAVERAL_LON = -80.5774;  // deg W
    static constexpr double CAPE_CANAVERAL_ALT = 0.0;       // m

private:
    // Stage data
    std::vector<RocketStage> stages_;
    int current_stage_;
    double payload_mass_;

    // Propellant tracking
    std::vector<double> propellant_remaining_;

    // Flight state
    FlightPhase phase_;
    double launch_time_;
    bool engines_on_;

    // Guidance parameters
    double target_altitude_;
    double target_inclination_;
    double gravity_turn_start_alt_;
    double gravity_turn_rate_;  // rad/s pitch rate during turn
    double initial_heading_;    // Launch azimuth [rad]

    // Aerodynamics
    double drag_coefficient_;
    double reference_area_;

    // Launch site (for downrange calculation)
    GeodeticCoord launch_site_;
    Vec3 launch_position_ecef_;

    // Maneuver queue
    std::vector<Maneuver> maneuvers_;

    // Internal methods
    void update_pre_launch(double dt);
    void update_powered_flight(double dt);
    void update_coast(double dt);
    void update_orbital(double dt);

    void stage_separation();
    Vec3 compute_thrust_direction() const;
    Vec3 compute_gravity(const Vec3& position) const;
    double compute_current_thrust() const;
    double compute_current_isp() const;

    void check_orbit_insertion();
    void execute_maneuvers(double dt);

    // Convert geodetic to ECI for initialization
    void initialize_from_geodetic(double lat, double lon, double alt);
};

} // namespace sim

#endif // LAUNCH_VEHICLE_HPP
