#ifndef MANEUVER_PLANNER_HPP
#define MANEUVER_PLANNER_HPP

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"

namespace sim {

/**
 * @brief Result of a Hohmann transfer calculation
 */
struct HohmannTransfer {
    double delta_v1;          // First burn magnitude [m/s]
    double delta_v2;          // Second burn magnitude [m/s]
    double total_delta_v;     // Total delta-V [m/s]
    double transfer_time;     // Time of flight [s]
    double transfer_sma;      // Semi-major axis of transfer orbit [m]

    Vec3 burn1_direction;     // Unit vector for first burn
    Vec3 burn2_direction;     // Unit vector for second burn
};

/**
 * @brief Result of a Lambert solver
 */
struct LambertSolution {
    Vec3 v1;                  // Initial velocity [m/s]
    Vec3 v2;                  // Final velocity [m/s]
    double delta_v1;          // First burn magnitude [m/s]
    double delta_v2;          // Second burn magnitude [m/s]
    double total_delta_v;     // Total delta-V [m/s]
    double tof;               // Time of flight [s]
    bool valid;               // Solution found
};

/**
 * @brief Rendezvous maneuver sequence
 */
struct RendezvousPlan {
    double phase_angle;       // Current phase angle [rad]
    double wait_time;         // Time until optimal transfer window [s]
    HohmannTransfer transfer; // Transfer orbit parameters
    double burn1_time;        // Time of first burn [s]
    double burn2_time;        // Time of second burn [s]

    // Delta-V vectors in ECI
    Vec3 delta_v1;
    Vec3 delta_v2;
};

/**
 * @brief Orbital maneuver planning utilities
 */
class ManeuverPlanner {
public:
    /**
     * @brief Compute Hohmann transfer between two circular orbits
     * @param r1 Initial orbit radius [m]
     * @param r2 Target orbit radius [m]
     * @param mu Gravitational parameter
     * @return Hohmann transfer parameters
     */
    static HohmannTransfer hohmann_transfer(double r1, double r2,
                                            double mu = OrbitalMechanics::MU_EARTH);

    /**
     * @brief Compute Hohmann transfer between two orbits (general)
     * @param initial Initial orbital elements
     * @param target Target orbital elements
     * @param mu Gravitational parameter
     * @return Hohmann transfer parameters
     */
    static HohmannTransfer hohmann_transfer(const OrbitalElements& initial,
                                            const OrbitalElements& target,
                                            double mu = OrbitalMechanics::MU_EARTH);

    /**
     * @brief Solve Lambert's problem
     * @param r1 Initial position [m]
     * @param r2 Final position [m]
     * @param tof Time of flight [s]
     * @param mu Gravitational parameter
     * @param prograde True for prograde transfer
     * @return Lambert solution
     */
    static LambertSolution solve_lambert(const Vec3& r1, const Vec3& r2,
                                         double tof,
                                         double mu = OrbitalMechanics::MU_EARTH,
                                         bool prograde = true);

    /**
     * @brief Plan rendezvous from chaser to target
     * @param chaser_state Current state of chaser
     * @param target_state Current state of target
     * @param current_time Current simulation time [s]
     * @param mu Gravitational parameter
     * @return Rendezvous plan with burn times and delta-V
     */
    static RendezvousPlan plan_rendezvous(const StateVector& chaser_state,
                                          const StateVector& target_state,
                                          double current_time,
                                          double mu = OrbitalMechanics::MU_EARTH);

    /**
     * @brief Compute phase angle between two satellites
     * @param chaser_state State of chaser satellite
     * @param target_state State of target satellite
     * @return Phase angle [rad], positive if target is ahead
     */
    static double compute_phase_angle(const StateVector& chaser_state,
                                      const StateVector& target_state);

    /**
     * @brief Compute optimal wait time for Hohmann transfer rendezvous
     * @param phase_angle Current phase angle [rad]
     * @param r1 Initial orbit radius [m]
     * @param r2 Target orbit radius [m]
     * @param mu Gravitational parameter
     * @return Wait time [s]
     */
    static double compute_wait_time(double phase_angle, double r1, double r2,
                                    double mu = OrbitalMechanics::MU_EARTH);

    /**
     * @brief Compute delta-V for plane change
     * @param v Orbital velocity [m/s]
     * @param delta_i Inclination change [rad]
     * @return Delta-V required [m/s]
     */
    static double plane_change_delta_v(double v, double delta_i);

    /**
     * @brief Compute circular orbit velocity
     */
    static double circular_velocity(double r, double mu = OrbitalMechanics::MU_EARTH);
};

} // namespace sim

#endif // MANEUVER_PLANNER_HPP
