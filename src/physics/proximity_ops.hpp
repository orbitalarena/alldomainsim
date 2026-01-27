#ifndef PROXIMITY_OPS_HPP
#define PROXIMITY_OPS_HPP

#include "core/state_vector.hpp"
#include "targeting/cw_targeting.hpp"
#include <vector>

namespace sim {

/**
 * @brief Relative state in RIC/LVLH (Hill) frame
 *
 * This frame is centered on the target spacecraft and rotates with its orbit.
 * Also known as: RIC (Radial-Intrack-Crosstrack), RSW, Hill frame, or LVLH.
 *
 * Axis definitions:
 *   X / R (Radial):     Position unit vector, pointing away from central body
 *   Y / I (In-track):   C × R, approximately along velocity vector
 *   Z / C (Cross-track): Angular momentum direction (h = r × v), orbit normal
 *
 * This matches the RIC convention used in ric_frame.hpp where:
 *   position.x <-> R component
 *   position.y <-> I component
 *   position.z <-> C component
 *
 * Note: Some references define LVLH with different axis orientations. This
 * implementation uses the RIC convention which is standard for proximity ops.
 */
struct RelativeState {
    Vec3 position;   // [m] relative position (R, I, C components)
    Vec3 velocity;   // [m/s] relative velocity (R, I, C components)
};

// Type alias for RIC naming convention
using RICState = RelativeState;

/**
 * @brief Waypoint for proximity operations
 */
struct ProxOpsWaypoint {
    Vec3 position;     // Relative position in RIC frame [m] (R, I, C)
    double hold_time;  // Time to hold at waypoint [s]
    double approach_v; // Approach velocity [m/s]
};

/**
 * @brief Proximity operations trajectory
 */
struct ProxOpsTrajectory {
    std::vector<ProxOpsWaypoint> waypoints;
    std::vector<Vec3> delta_vs;        // Delta-V for each leg [m/s in RIC]
    std::vector<double> transfer_times; // Time for each leg [s]
    double total_delta_v;              // Total delta-V [m/s]
    double total_time;                 // Total time [s]
};

/**
 * @brief Clohessy-Wiltshire (Hill) equations for relative motion
 *
 * Linearized equations of motion for a chaser relative to a target
 * in a circular reference orbit. All relative coordinates use the
 * RIC (Radial-Intrack-Crosstrack) frame convention.
 */
class ProximityOps {
public:
    /**
     * @brief Convert inertial states to relative state in RIC frame
     * @param chaser_state Chaser state in ECI
     * @param target_state Target state in ECI
     * @return Relative state in RIC frame (R, I, C components in x, y, z)
     * @note Also available as inertial_to_lvlh() for backward compatibility
     */
    static RelativeState inertial_to_ric(const StateVector& chaser_state,
                                         const StateVector& target_state) {
        return inertial_to_lvlh(chaser_state, target_state);
    }

    // Legacy name - prefer inertial_to_ric()
    static RelativeState inertial_to_lvlh(const StateVector& chaser_state,
                                          const StateVector& target_state);

    /**
     * @brief Convert delta-V in RIC frame to inertial (ECI) frame
     * @param dv_ric Delta-V in RIC frame [m/s]
     * @param target_state Target state in ECI (defines RIC frame)
     * @return Delta-V in ECI frame [m/s]
     * @note Also available as lvlh_to_inertial_dv() for backward compatibility
     */
    static Vec3 ric_to_inertial_dv(const Vec3& dv_ric,
                                   const StateVector& target_state) {
        return lvlh_to_inertial_dv(dv_ric, target_state);
    }

    // Legacy name - prefer ric_to_inertial_dv()
    static Vec3 lvlh_to_inertial_dv(const Vec3& delta_v_lvlh,
                                    const StateVector& target_state);

    /**
     * @brief Propagate relative state using CW equations
     * @param initial Initial relative state in RIC
     * @param n Mean motion of reference orbit [rad/s]
     * @param dt Time step [s]
     * @return New relative state in RIC
     */
    static RelativeState propagate_cw(const RelativeState& initial,
                                      double n, double dt);

    /**
     * @brief Compute delta-V for CW two-impulse transfer
     * @param r0 Initial relative position in RIC [m]
     * @param rf Final relative position in RIC [m]
     * @param tof Time of flight [s]
     * @param n Mean motion [rad/s]
     * @return pair of delta-V vectors (start, end) in RIC
     */
    static std::pair<Vec3, Vec3> cw_transfer(const Vec3& r0, const Vec3& rf,
                                             double tof, double n);

    /**
     * @brief Plan circumnavigation trajectory around target
     * @param start_pos Starting relative position [m]
     * @param radius Circumnavigation radius [m]
     * @param num_waypoints Number of waypoints around the circle
     * @param n Mean motion [rad/s]
     * @return Trajectory with waypoints and maneuvers
     */
    static ProxOpsTrajectory plan_circumnavigation(const Vec3& start_pos,
                                                   double radius,
                                                   int num_waypoints,
                                                   double n);

    /**
     * @brief Plan V-bar approach (along velocity vector)
     * @param current_pos Current relative position [m]
     * @param final_range Final range from target [m]
     * @param approach_rate Approach rate [m/s]
     * @param n Mean motion [rad/s]
     * @return Trajectory
     */
    static ProxOpsTrajectory plan_vbar_approach(const Vec3& current_pos,
                                                double final_range,
                                                double approach_rate,
                                                double n);

    /**
     * @brief Plan R-bar approach (along radial vector)
     * @param current_pos Current relative position [m]
     * @param final_range Final range from target [m]
     * @param approach_rate Approach rate [m/s]
     * @param n Mean motion [rad/s]
     * @return Trajectory
     */
    static ProxOpsTrajectory plan_rbar_approach(const Vec3& current_pos,
                                                double final_range,
                                                double approach_rate,
                                                double n);

    /**
     * @brief Compute station-keeping delta-V to maintain position
     * @param rel_state Current relative state in RIC
     * @param target_pos Desired relative position in RIC [m]
     * @param n Mean motion [rad/s]
     * @return Delta-V to null drift [m/s in RIC]
     */
    static Vec3 station_keeping_dv(const RelativeState& rel_state,
                                   const Vec3& target_pos, double n);

    /**
     * @brief Compute mean motion from target state
     * @param target_state Target state in ECI
     * @param mu Gravitational parameter
     * @return Mean motion [rad/s]
     */
    static double compute_mean_motion(const StateVector& target_state,
                                      double mu = 3.986004418e14);

    /**
     * @brief Get natural motion football orbit parameters
     * @param x0 Initial radial offset [m]
     * @param n Mean motion [rad/s]
     * @return (along-track amplitude, radial amplitude, period)
     */
    static std::tuple<double, double, double> football_orbit(double x0, double n);
};

} // namespace sim

#endif // PROXIMITY_OPS_HPP
