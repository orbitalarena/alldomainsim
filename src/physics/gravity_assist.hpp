/**
 * Gravity Assist (Flyby) Calculator
 *
 * Computes hyperbolic flyby trajectories for interplanetary mission design.
 * Implements B-plane targeting, turn angle computation, and feasibility checks.
 */

#ifndef SIM_GRAVITY_ASSIST_HPP
#define SIM_GRAVITY_ASSIST_HPP

#include "core/state_vector.hpp"
#include <cmath>

namespace sim {

/**
 * B-plane targeting parameters for a flyby encounter
 *
 * The B-plane is perpendicular to the incoming asymptote and passes through
 * the center of the flyby body. T and R are components in this plane.
 */
struct BPlaneTarget {
    double b_dot_t;     // B-plane T component [m]
    double b_dot_r;     // B-plane R component [m]
    double b_mag;       // B-plane magnitude [m]
    double v_inf_in;    // Incoming v-infinity magnitude [m/s]
    double v_inf_out;   // Outgoing v-infinity magnitude [m/s]
    double turn_angle;  // Hyperbolic turn angle [rad]
};

/**
 * Result of a gravity assist (flyby) computation
 */
struct FlybyResult {
    Vec3 v_out_hci;         // Post-flyby heliocentric velocity [m/s]
    double periapsis_alt;   // Closest approach altitude [m] (above surface)
    double turn_angle;      // Achieved turn angle [rad]
    double delta_v_gained;  // Effective delta-V from flyby [m/s]
    BPlaneTarget b_plane;
    bool valid;
};

/**
 * Gravity assist trajectory calculations
 *
 * All methods are static. Velocities are in a heliocentric or
 * planet-centered inertial frame as noted per method.
 */
class GravityAssist {
public:
    /**
     * Compute an unpowered gravity assist flyby
     *
     * Given the incoming hyperbolic excess velocity (planet-centered),
     * periapsis radius, and planet mu, computes the outgoing velocity
     * and flyby parameters.
     *
     * The outgoing v-infinity has the same magnitude as the incoming
     * (energy conservation for an unpowered flyby). The velocity vector
     * is rotated by the hyperbolic turn angle using Rodrigues' formula
     * in the plane defined by v_inf_in and a perpendicular axis.
     *
     * @param v_inf_in     Incoming hyperbolic excess velocity (planet-centered) [m/s]
     * @param periapsis_radius Distance of closest approach from planet center [m]
     * @param mu_planet    Gravitational parameter of flyby body [m^3/s^2]
     * @return FlybyResult with outgoing velocity and flyby parameters
     */
    static FlybyResult compute_flyby(const Vec3& v_inf_in,
                                     double periapsis_radius,
                                     double mu_planet);

    /**
     * Compute the periapsis radius required to achieve a desired turn angle
     *
     * Inverts the relation: delta = 2 * arcsin(1 / e_hyp)
     * where e_hyp = 1 + rp * v_inf^2 / mu
     *
     * @param v_inf              Hyperbolic excess speed [m/s]
     * @param desired_turn_angle Desired turn angle [rad]
     * @param mu_planet          Gravitational parameter of flyby body [m^3/s^2]
     * @return Periapsis radius [m] (from planet center)
     */
    static double periapsis_for_turn_angle(double v_inf,
                                           double desired_turn_angle,
                                           double mu_planet);

    /**
     * Compute B-plane parameters for a desired flyby geometry
     *
     * Given incoming and desired outgoing v-infinity vectors, determines
     * the B-plane targeting parameters (B dot T, B dot R) that achieve
     * the desired deflection.
     *
     * B = rp * sqrt(1 + 2*mu / (rp * v_inf^2))
     *
     * @param v_inf_in          Incoming v-infinity (planet-centered) [m/s]
     * @param v_inf_out_desired Desired outgoing v-infinity (planet-centered) [m/s]
     * @param mu_planet         Gravitational parameter of flyby body [m^3/s^2]
     * @return BPlaneTarget with B-plane components and turn angle
     */
    static BPlaneTarget compute_b_plane(const Vec3& v_inf_in,
                                        const Vec3& v_inf_out_desired,
                                        double mu_planet);

    /**
     * Check if a flyby with the required turn angle is feasible
     *
     * Verifies that the periapsis needed for the turn angle between
     * the incoming and outgoing v-infinity vectors does not violate
     * the minimum periapsis constraint (e.g., planet surface or atmosphere).
     *
     * @param v_inf_in       Incoming v-infinity magnitude [m/s]
     * @param v_inf_out      Outgoing v-infinity magnitude [m/s] (must equal v_inf_in for unpowered)
     * @param min_periapsis  Minimum allowable periapsis radius [m] (from planet center)
     * @param mu_planet      Gravitational parameter of flyby body [m^3/s^2]
     * @return True if the flyby is achievable above min_periapsis
     */
    static bool is_feasible(double v_inf_in,
                            double v_inf_out,
                            double min_periapsis,
                            double mu_planet);
};

} // namespace sim

#endif // SIM_GRAVITY_ASSIST_HPP
