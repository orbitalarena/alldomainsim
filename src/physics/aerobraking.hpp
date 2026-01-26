/**
 * Aerobraking Calculator
 *
 * Simulates atmospheric passes for orbit circularization via drag.
 */

#ifndef SIM_AEROBRAKING_HPP
#define SIM_AEROBRAKING_HPP

#include "core/state_vector.hpp"
#include <vector>

namespace sim {

/**
 * Results from a single aerobraking pass
 */
struct AerobrakePassResult {
    // Entry conditions
    double entry_altitude;       // m
    double entry_velocity;       // m/s
    double entry_flight_path;    // radians (negative = descending)

    // Pass statistics
    double min_altitude;         // m (periapsis during pass)
    double exit_velocity;        // m/s
    double delta_v_loss;         // m/s (velocity lost to drag)
    double pass_duration;        // seconds in atmosphere

    // Peak values
    double max_g_load;           // g's
    double max_heat_flux;        // W/m²
    double max_dynamic_pressure; // Pa

    // Resulting orbit
    double new_apogee;           // m (altitude)
    double new_perigee;          // m (altitude)
    double new_eccentricity;

    // Heat shield
    double total_heat_load;      // J/m² (integrated heat flux)
};

/**
 * Vehicle aerodynamic properties for aerobraking
 */
struct AerobrakeVehicle {
    double mass;              // kg
    double drag_coefficient;  // Cd (typical ~1.2 for blunt body)
    double cross_section;     // m² (reference area)
    double nose_radius;       // m (for heating calculation)
    double lift_coefficient;  // CL (typically small for capsule)

    // Apollo CM defaults
    static AerobrakeVehicle apollo_cm() {
        return AerobrakeVehicle{
            5500.0,   // kg (CM alone)
            1.2,      // Cd
            12.0,     // m² (base area)
            4.7,      // m (effective nose radius)
            0.0       // CL (ballistic)
        };
    }
};

/**
 * Aerobraking simulation and planning
 */
class AerobrakingCalculator {
public:
    /**
     * Simulate a single atmospheric pass
     *
     * @param entry_state State at atmospheric entry (~120km)
     * @param vehicle Vehicle properties
     * @param dt Integration timestep (default 0.1s for accuracy)
     * @return Pass results including new orbital parameters
     */
    static AerobrakePassResult simulate_pass(
        const StateVector& entry_state,
        const AerobrakeVehicle& vehicle,
        double dt = 0.1);

    /**
     * Estimate number of passes needed to circularize
     *
     * @param initial_apogee Initial apogee altitude (m)
     * @param initial_perigee Initial perigee altitude (m)
     * @param target_apogee Target apogee altitude (m)
     * @param vehicle Vehicle properties
     * @return Estimated number of passes
     */
    static int estimate_passes_needed(
        double initial_apogee,
        double initial_perigee,
        double target_apogee,
        const AerobrakeVehicle& vehicle);

    /**
     * Compute orbital elements from state
     * Helper function for orbit determination after pass
     *
     * @param state Current state vector (ECI)
     * @param mu Gravitational parameter (default Earth)
     * @return Tuple of (semi_major_axis, eccentricity, apogee_alt, perigee_alt)
     */
    static void compute_orbit_params(
        const StateVector& state,
        double mu,
        double& a, double& e, double& apogee_alt, double& perigee_alt);

    /**
     * Check if current orbit will result in atmospheric capture
     *
     * @param state Current state
     * @param mu Gravitational parameter
     * @param atm_altitude Atmosphere altitude threshold (default 120km)
     * @return True if perigee is below atmosphere
     */
    static bool will_enter_atmosphere(
        const StateVector& state,
        double mu,
        double atm_altitude = 120000.0);

    // Entry interface altitude (where significant drag begins)
    static constexpr double ENTRY_INTERFACE = 120000.0;  // 120 km

private:
    // Earth parameters (for default calculations)
    static constexpr double EARTH_MU = 3.986004418e14;
    static constexpr double EARTH_RADIUS = 6378137.0;
};

}  // namespace sim

#endif  // SIM_AEROBRAKING_HPP
