#ifndef PROXIMITY_OPS_HPP
#define PROXIMITY_OPS_HPP

#include "core/state_vector.hpp"
#include <vector>

namespace sim {

/**
 * @brief Relative state in LVLH (Hill) frame
 *
 * LVLH = Local Vertical Local Horizontal frame centered on target
 * X: Radial (outward from Earth)
 * Y: Along-track (in direction of velocity)
 * Z: Cross-track (completes right-handed system)
 */
struct RelativeState {
    Vec3 position;   // [m] relative position
    Vec3 velocity;   // [m/s] relative velocity
};

/**
 * @brief Waypoint for proximity operations
 */
struct ProxOpsWaypoint {
    Vec3 position;     // Relative position in LVLH [m]
    double hold_time;  // Time to hold at waypoint [s]
    double approach_v; // Approach velocity [m/s]
};

/**
 * @brief Proximity operations trajectory
 */
struct ProxOpsTrajectory {
    std::vector<ProxOpsWaypoint> waypoints;
    std::vector<Vec3> delta_vs;        // Delta-V for each leg [m/s in LVLH]
    std::vector<double> transfer_times; // Time for each leg [s]
    double total_delta_v;              // Total delta-V [m/s]
    double total_time;                 // Total time [s]
};

/**
 * @brief Clohessy-Wiltshire (Hill) equations for relative motion
 *
 * Linearized equations of motion for a chaser relative to a target
 * in a circular reference orbit.
 */
class ProximityOps {
public:
    /**
     * @brief Convert inertial states to relative state in LVLH frame
     * @param chaser_state Chaser state in ECI
     * @param target_state Target state in ECI
     * @return Relative state in LVLH frame
     */
    static RelativeState inertial_to_lvlh(const StateVector& chaser_state,
                                          const StateVector& target_state);

    /**
     * @brief Convert relative state in LVLH to inertial delta-V
     * @param delta_v_lvlh Delta-V in LVLH frame [m/s]
     * @param target_state Target state in ECI (defines LVLH frame)
     * @return Delta-V in ECI frame [m/s]
     */
    static Vec3 lvlh_to_inertial_dv(const Vec3& delta_v_lvlh,
                                    const StateVector& target_state);

    /**
     * @brief Propagate relative state using CW equations
     * @param initial Initial relative state in LVLH
     * @param n Mean motion of reference orbit [rad/s]
     * @param dt Time step [s]
     * @return New relative state
     */
    static RelativeState propagate_cw(const RelativeState& initial,
                                      double n, double dt);

    /**
     * @brief Compute delta-V for CW two-impulse transfer
     * @param r0 Initial relative position [m]
     * @param rf Final relative position [m]
     * @param tof Time of flight [s]
     * @param n Mean motion [rad/s]
     * @return pair of delta-V vectors (start, end) in LVLH
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
     * @param rel_state Current relative state
     * @param target_pos Desired relative position [m]
     * @param n Mean motion [rad/s]
     * @return Delta-V to null drift [m/s in LVLH]
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
