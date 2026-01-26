#ifndef CW_TARGETING_HPP
#define CW_TARGETING_HPP

#include <string>
#include "core/state_vector.hpp"
#include "ric_frame.hpp"

namespace sim {

/**
 * Clohessy-Wiltshire (CW) Targeting Solutions
 *
 * The CW equations describe linearized relative motion in a circular orbit.
 * They are the foundation for proximity operations and rendezvous targeting.
 *
 * Assumptions:
 * - Target is in a circular orbit
 * - Chase is close to target (linear approximation valid)
 * - No perturbations (two-body problem)
 */

/**
 * Result structure for CW maneuver solutions
 */
struct CWManeuver {
    Vec3 dv1_ric;      // First burn in RIC frame (m/s)
    Vec3 dv2_ric;      // Second burn in RIC frame (m/s)
    double dv1_mag;    // First burn magnitude (m/s)
    double dv2_mag;    // Second burn magnitude (m/s)
    double total_dv;   // Total delta-V (m/s)
    double transfer_time;  // Transfer time (seconds)
    bool valid;        // Solution validity flag
    std::string method; // Method used
};

/**
 * CW State Transition Matrix components
 * Used for propagating relative state in CW frame
 */
struct CWStateMatrix {
    double Phi_rr[3][3];  // Position to position
    double Phi_rv[3][3];  // Velocity to position
    double Phi_vr[3][3];  // Position to velocity
    double Phi_vv[3][3];  // Velocity to velocity
};

class CWTargeting {
public:
    /**
     * Compute CW state transition matrices
     * @param n Mean motion of the reference orbit (rad/s)
     * @param dt Time interval (seconds)
     * @return State transition matrix components
     */
    static CWStateMatrix compute_state_matrix(double n, double dt);

    /**
     * Propagate relative state using CW equations
     * @param r0_ric Initial relative position in RIC (m)
     * @param v0_ric Initial relative velocity in RIC (m/s)
     * @param n Mean motion (rad/s)
     * @param dt Time to propagate (seconds)
     * @param r_ric Output: final relative position
     * @param v_ric Output: final relative velocity
     */
    static void propagate_relative_state(
        const Vec3& r0_ric, const Vec3& v0_ric,
        double n, double dt,
        Vec3& r_ric, Vec3& v_ric);

    /**
     * Two-burn CW rendezvous solution
     * Computes delta-V to achieve both position and velocity match at target.
     * @param r0_ric Initial relative position in RIC (m)
     * @param v0_ric Initial relative velocity in RIC (m/s)
     * @param transfer_time Time of flight (seconds)
     * @param n Mean motion (rad/s)
     * @return Maneuver solution with two burns
     */
    static CWManeuver solve_two_burn_rendezvous(
        const Vec3& r0_ric, const Vec3& v0_ric,
        double transfer_time, double n);

    /**
     * Single-burn CW intercept solution
     * Computes delta-V to intercept target position (velocity not matched).
     * @param r0_ric Initial relative position in RIC (m)
     * @param transfer_time Time of flight (seconds)
     * @param n Mean motion (rad/s)
     * @return Maneuver solution with single burn
     */
    static CWManeuver solve_single_burn_intercept(
        const Vec3& r0_ric,
        double transfer_time, double n);

    /**
     * Simple radial burn targeting for half-period transfers
     * At T = pi/n (half period), a radial burn creates in-track displacement.
     * Rule: dv_R = I0 * n / 4
     * @param r0_ric Initial relative position in RIC (m)
     * @param n Mean motion (rad/s)
     * @return Maneuver solution
     */
    static CWManeuver solve_half_period_radial(
        const Vec3& r0_ric, double n);

    /**
     * Phasing maneuver with in-track burns
     * Two equal in-track burns for drift maneuvers.
     * @param r0_ric Initial relative position in RIC (m)
     * @param transfer_time Time of flight (seconds)
     * @param n Mean motion (rad/s)
     * @param v_circ Circular velocity (m/s)
     * @return Maneuver solution
     */
    static CWManeuver solve_phasing_maneuver(
        const Vec3& r0_ric,
        double transfer_time, double n, double v_circ);

    /**
     * Select appropriate targeting method based on transfer time
     * @param r0_ric Initial relative position in RIC (m)
     * @param v0_ric Initial relative velocity in RIC (m/s)
     * @param transfer_time Desired transfer time (seconds)
     * @param n Mean motion (rad/s)
     * @param v_circ Circular velocity (m/s)
     * @return Best maneuver solution
     */
    static CWManeuver solve_optimal(
        const Vec3& r0_ric, const Vec3& v0_ric,
        double transfer_time, double n, double v_circ);
};

} // namespace sim

#endif // CW_TARGETING_HPP
