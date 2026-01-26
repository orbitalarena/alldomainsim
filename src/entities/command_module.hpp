/**
 * Command Module Entity
 *
 * Apollo-style command module for re-entry simulations.
 * Handles orbital flight, aerobraking, re-entry, and parachute descent.
 */

#ifndef SIM_COMMAND_MODULE_HPP
#define SIM_COMMAND_MODULE_HPP

#include "entity.hpp"
#include "physics/celestial_body.hpp"
#include "physics/multi_body_gravity.hpp"
#include "physics/aerobraking.hpp"
#include <vector>

namespace sim {

/**
 * Flight phase for command module
 */
enum class CMFlightPhase {
    ORBITAL,           // Coasting in orbit (any body)
    POWERED,           // Engine firing (RCS/main)
    AEROBRAKING,       // Atmospheric pass for orbit adjustment
    REENTRY,           // Final atmospheric entry
    DROGUE_DESCENT,    // Drogue parachute deployed
    MAIN_DESCENT,      // Main parachutes deployed
    SPLASHDOWN         // Landed/recovered
};

/**
 * Command module state during atmospheric flight
 */
struct CMAtmosphericState {
    double altitude;           // m
    double velocity;           // m/s
    double mach;               // Mach number
    double dynamic_pressure;   // Pa
    double heat_flux;          // W/m²
    double g_load;             // g's
    double flight_path_angle;  // radians
};

/**
 * Maneuver for impulsive burns
 */
struct CMManeuver {
    double start_time;     // Mission time to start (seconds)
    double duration;       // Burn duration (seconds)
    Vec3 delta_v;          // Delta-V vector in current frame (m/s)
    std::string name;      // Descriptive name
    bool executed;         // Has this maneuver been performed?
};

/**
 * Apollo-style Command Module
 */
class CommandModule : public Entity {
public:
    /**
     * Create a command module
     * @param name Name identifier
     * @param id Unique ID
     */
    CommandModule(const std::string& name, int id);

    // Mass properties (kg)
    double dry_mass = 5500.0;           // CM structure + systems
    double heat_shield_mass = 800.0;     // Ablative heat shield
    double propellant_mass = 100.0;      // RCS propellant

    // Aerodynamic properties
    double Cd = 1.2;                     // Drag coefficient
    double cross_section = 12.0;         // m² (base area)
    double nose_radius = 4.7;            // m (effective for heating)
    double CL = 0.0;                     // Lift coefficient (ballistic entry)

    // Parachute properties
    double drogue_Cd = 1.5;              // Drogue chute drag
    double drogue_area = 25.0;           // m² (drogue deployed area)
    double main_Cd = 1.2;                // Main chutes drag
    double main_area = 300.0;            // m² (3 main chutes total)
    double drogue_deploy_alt = 7000.0;   // m
    double drogue_deploy_mach = 0.7;     // Max Mach for drogue
    double main_deploy_alt = 3000.0;     // m

    /**
     * Update state for one timestep
     * @param dt Time step (seconds)
     */
    void update(double dt) override;

    // State queries
    CMFlightPhase get_flight_phase() const { return flight_phase_; }
    PrimaryBody get_primary_body() const { return primary_body_; }
    double get_mission_time() const { return mission_time_; }
    double get_total_mass() const;
    CMAtmosphericState get_atmospheric_state() const;

    // Parachute state
    bool is_drogue_deployed() const { return drogue_deployed_; }
    bool is_main_deployed() const { return main_deployed_; }
    double get_heat_shield_remaining() const { return heat_shield_remaining_; }

    // Orbital state
    void get_orbit_params(double& apogee, double& perigee, double& eccentricity) const;
    double get_altitude() const;  // Above current primary body

    // Control
    void set_primary_body(PrimaryBody body) { primary_body_ = body; }
    void set_flight_phase(CMFlightPhase phase) { flight_phase_ = phase; }
    void set_moon_state(const StateVector& moon_state) { moon_state_ = moon_state; }

    /**
     * Apply an impulsive delta-V
     * @param dv Delta-V vector in ECI frame (m/s)
     */
    void apply_delta_v(const Vec3& dv);

    /**
     * Schedule a maneuver
     * @param maneuver Maneuver to add to queue
     */
    void add_maneuver(const CMManeuver& maneuver);

    /**
     * Deploy drogue parachute (manual override)
     */
    void deploy_drogue();

    /**
     * Deploy main parachutes (manual override)
     */
    void deploy_main();

    // Statistics
    int aerobrake_pass_count = 0;
    double total_heat_absorbed = 0.0;    // J/m²
    double max_g_experienced = 0.0;

private:
    // Flight state
    CMFlightPhase flight_phase_ = CMFlightPhase::ORBITAL;
    PrimaryBody primary_body_ = PrimaryBody::EARTH;
    double mission_time_ = 0.0;

    // Moon state for multi-body gravity
    StateVector moon_state_;

    // Heat shield
    double heat_shield_remaining_ = 1.0;  // Fraction remaining

    // Parachutes
    bool drogue_deployed_ = false;
    bool main_deployed_ = false;

    // Aerobraking tracking
    bool in_atmosphere_ = false;  // Currently in atmosphere during aerobraking

    // Maneuver queue
    std::vector<CMManeuver> maneuvers_;

    // Update functions for each phase
    void update_orbital(double dt);
    void update_atmospheric(double dt);
    void update_parachute(double dt);

    // Check and execute scheduled maneuvers
    void check_maneuvers();

    // Check for automatic parachute deployment
    void check_parachute_deployment();

    // Determine if we've entered atmosphere
    bool check_atmosphere_entry();
};

/**
 * Convert flight phase to string
 */
inline const char* cm_phase_to_string(CMFlightPhase phase) {
    switch (phase) {
        case CMFlightPhase::ORBITAL:        return "Orbital";
        case CMFlightPhase::POWERED:        return "Powered";
        case CMFlightPhase::AEROBRAKING:    return "Aerobraking";
        case CMFlightPhase::REENTRY:        return "Re-entry";
        case CMFlightPhase::DROGUE_DESCENT: return "Drogue Descent";
        case CMFlightPhase::MAIN_DESCENT:   return "Main Descent";
        case CMFlightPhase::SPLASHDOWN:     return "Splashdown";
        default:                            return "Unknown";
    }
}

}  // namespace sim

#endif  // SIM_COMMAND_MODULE_HPP
