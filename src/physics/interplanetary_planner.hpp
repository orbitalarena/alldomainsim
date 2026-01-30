/**
 * Interplanetary Transfer Planner
 *
 * Designs interplanetary transfer orbits between planets using Lambert's
 * problem. Generates porkchop plots (C3 as function of launch/arrival date),
 * computes departure and capture delta-V from parking orbits, and builds
 * sampled heliocentric trajectory legs for visualization.
 *
 * Uses PlanetaryEphemeris for planet positions, ManeuverPlanner::solve_lambert
 * for transfer orbit solutions, and OrbitalMechanics for Keplerian propagation.
 */

#ifndef SIM_INTERPLANETARY_PLANNER_HPP
#define SIM_INTERPLANETARY_PLANNER_HPP

#include "core/state_vector.hpp"
#include "planetary_ephemeris.hpp"
#include "maneuver_planner.hpp"
#include "celestial_body.hpp"
#include "orbital_elements.hpp"
#include <vector>
#include <string>

namespace sim {

/**
 * @brief Result of a single interplanetary transfer computation
 */
struct C3Result {
    double c3_departure;      // km^2/s^2 (characteristic energy at departure)
    double c3_arrival;        // km^2/s^2 (characteristic energy at arrival)
    double v_inf_departure;   // m/s (hyperbolic excess speed at departure)
    double v_inf_arrival;     // m/s (hyperbolic excess speed at arrival)
    double total_delta_v;     // m/s (from parking orbit, departure + capture)
    Vec3 v_departure_hci;     // Departure velocity in HCI [m/s]
    Vec3 v_arrival_hci;       // Arrival velocity in HCI [m/s]
    double tof;               // Time of flight [s]
    bool valid;
};

/**
 * @brief One grid point in a porkchop plot
 */
struct PorkchopPoint {
    double launch_jd;
    double arrival_jd;
    double c3_departure;      // km^2/s^2
    double c3_arrival;        // km^2/s^2
    double total_delta_v;     // m/s
    bool valid;
};

/**
 * @brief A single leg of an interplanetary mission
 */
struct MissionLeg {
    std::string name;
    Planet departure_body;
    Planet arrival_body;
    double departure_jd;
    double arrival_jd;
    Vec3 v_inf_departure;
    Vec3 v_inf_arrival;
    double delta_v;
    std::vector<StateVector> trajectory;  // Sampled HCI states along the arc
};

/**
 * @brief Interplanetary transfer design utilities
 *
 * All methods are static. Uses PlanetaryEphemeris for planet states,
 * ManeuverPlanner::solve_lambert for transfer orbit solutions, and
 * OrbitalMechanics for Keplerian element conversions and propagation.
 */
class InterplanetaryPlanner {
public:
    /**
     * @brief Compute a single interplanetary transfer
     *
     * Gets planet positions/velocities from PlanetaryEphemeris, solves
     * Lambert's problem with mu = SUN_MU, then computes v-infinity vectors,
     * C3 values, and total delta-V including parking orbit departure and
     * arrival capture burns.
     *
     * @param departure    Departure planet
     * @param arrival      Arrival planet
     * @param launch_jd    Launch Julian Date
     * @param arrival_jd   Arrival Julian Date
     * @param departure_parking_alt  Parking orbit altitude at departure [m] (default 200 km)
     * @param arrival_parking_alt    Capture orbit altitude at arrival [m] (default 200 km)
     * @return C3Result with transfer characteristics
     */
    static C3Result compute_transfer(Planet departure, Planet arrival,
                                     double launch_jd, double arrival_jd,
                                     double departure_parking_alt = 200e3,
                                     double arrival_parking_alt = 200e3);

    /**
     * @brief Generate a porkchop plot grid
     *
     * Sweeps launch and arrival dates in a grid, computing C3 and total
     * delta-V at each point. Results are stored in row-major order
     * (launch date varies fastest). Points where arrival_jd <= launch_jd
     * are skipped (marked invalid).
     *
     * @param departure        Departure planet
     * @param arrival          Arrival planet
     * @param launch_jd_start  Start of launch window [JD]
     * @param launch_jd_end    End of launch window [JD]
     * @param launch_steps     Number of launch date grid points
     * @param arrival_jd_start Start of arrival window [JD]
     * @param arrival_jd_end   End of arrival window [JD]
     * @param arrival_steps    Number of arrival date grid points
     * @return Vector of PorkchopPoint in row-major order (arrival row, launch col)
     */
    static std::vector<PorkchopPoint> generate_porkchop(
        Planet departure, Planet arrival,
        double launch_jd_start, double launch_jd_end, int launch_steps,
        double arrival_jd_start, double arrival_jd_end, int arrival_steps);

    /**
     * @brief Build a complete mission leg with sampled trajectory
     *
     * Computes the transfer orbit from Lambert's solution, converts to
     * Keplerian elements about the Sun, then propagates mean anomaly at
     * uniform time intervals to sample the heliocentric arc.
     *
     * @param departure    Departure planet
     * @param arrival      Arrival planet
     * @param launch_jd    Launch Julian Date
     * @param arrival_jd   Arrival Julian Date
     * @param num_samples  Number of trajectory sample points (default 500)
     * @return MissionLeg with sampled HCI states
     */
    static MissionLeg build_leg(Planet departure, Planet arrival,
                                double launch_jd, double arrival_jd,
                                int num_samples = 500);

    /**
     * @brief Compute departure delta-V from a circular parking orbit
     *
     * Calculates the burn to transition from a circular parking orbit to
     * a departure hyperbola with the given C3.
     *   v_park = sqrt(mu / r_park)
     *   v_hyp  = sqrt(C3 * 1e6 + 2 * mu / r_park)   [C3 in km^2/s^2]
     *   dv     = v_hyp - v_park
     *
     * @param c3             Characteristic energy [km^2/s^2]
     * @param parking_radius Parking orbit radius [m]
     * @param mu_body        Gravitational parameter of departure body [m^3/s^2]
     * @return Delta-V [m/s]
     */
    static double departure_delta_v(double c3, double parking_radius, double mu_body);

    /**
     * @brief Compute capture delta-V into a circular orbit
     *
     * Calculates the braking burn to transition from an arrival hyperbola
     * to a circular capture orbit.
     *   v_hyp  = sqrt(v_inf^2 + 2 * mu / r_cap)
     *   v_circ = sqrt(mu / r_cap)
     *   dv     = v_hyp - v_circ
     *
     * @param v_inf          Hyperbolic excess speed [m/s]
     * @param capture_radius Capture orbit radius [m]
     * @param mu_body        Gravitational parameter of arrival body [m^3/s^2]
     * @return Delta-V [m/s]
     */
    static double capture_delta_v(double v_inf, double capture_radius, double mu_body);

    /**
     * @brief Compute the departure v-infinity unit vector in HCI
     *
     * Returns the direction of the hyperbolic excess velocity at departure,
     * which defines the departure asymptote direction.
     *
     * @param departure   Departure planet
     * @param arrival     Arrival planet
     * @param launch_jd   Launch Julian Date
     * @param arrival_jd  Arrival Julian Date
     * @return Unit vector of departure v-infinity in HCI
     */
    static Vec3 compute_departure_asymptote(Planet departure, Planet arrival,
                                            double launch_jd, double arrival_jd);
};

}  // namespace sim

#endif  // SIM_INTERPLANETARY_PLANNER_HPP
