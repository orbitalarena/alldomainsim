#ifndef MISSILE_GUIDANCE_HPP
#define MISSILE_GUIDANCE_HPP

#include <vector>
#include <string>

namespace sim {

/**
 * Missile Guidance Laws
 *
 * Implements various guidance algorithms for air-to-air missiles:
 * - Proportional Navigation (PN)
 * - Augmented Proportional Navigation (APN)
 * - Pure Pursuit
 * - Lead Pursuit
 */

/**
 * Missile state structure
 */
struct MissileState {
    int id;
    int launcher_id;           // Aircraft that launched
    int target_id;             // Intended target

    // Position (geodetic)
    double latitude;           // degrees
    double longitude;          // degrees
    double altitude;           // meters

    // Velocity
    double speed;              // m/s
    double heading;            // degrees (0 = North)
    double flight_path_angle;  // degrees (positive = climbing)

    // Guidance state
    double time_of_flight;     // seconds since launch
    bool is_active;            // Still tracking
    bool has_hit;              // Target destroyed

    // Performance
    double max_speed;          // m/s
    double max_g;              // g's
    double max_range;          // m
    double min_range;          // m (arming distance)
    double seeker_fov;         // degrees (half-angle)
    double lethal_radius;      // m
};

/**
 * Target state for guidance computation
 */
struct GuidanceTarget {
    double latitude;
    double longitude;
    double altitude;
    double speed;
    double heading;
    double flight_path_angle;
};

/**
 * Guidance command output
 */
struct GuidanceCommand {
    double commanded_heading;        // degrees
    double commanded_flight_path;    // degrees
    double commanded_acceleration;   // g's (lateral)
    bool target_in_fov;              // Seeker can see target
    double time_to_intercept;        // Estimated seconds
    double closing_velocity;         // m/s
};

/**
 * Guidance law enumeration
 */
enum class GuidanceLaw {
    PROPORTIONAL_NAVIGATION,
    AUGMENTED_PN,
    PURE_PURSUIT,
    LEAD_PURSUIT
};

/**
 * Missile guidance parameters
 */
struct GuidanceParams {
    GuidanceLaw law = GuidanceLaw::PROPORTIONAL_NAVIGATION;
    double navigation_constant = 3.0;  // N for PN (typically 3-5)
    double seeker_rate_limit = 30.0;   // deg/s max seeker gimbal rate
    double min_intercept_time = 0.5;   // seconds (avoid division by zero)
};

/**
 * Compute guidance command using specified law
 *
 * @param missile Current missile state
 * @param target Target state
 * @param params Guidance parameters
 * @param dt Timestep for integration
 * @return Guidance command
 */
GuidanceCommand compute_guidance(
    const MissileState& missile,
    const GuidanceTarget& target,
    const GuidanceParams& params,
    double dt);

/**
 * Proportional Navigation guidance
 *
 * The classic guidance law: acceleration proportional to line-of-sight rate.
 * a_cmd = N * V_c * LOS_rate
 *
 * @param missile Current missile state
 * @param target Target state
 * @param N Navigation constant (typically 3-5)
 * @return Guidance command
 */
GuidanceCommand proportional_navigation(
    const MissileState& missile,
    const GuidanceTarget& target,
    double N = 3.0);

/**
 * Augmented Proportional Navigation
 *
 * PN with target acceleration compensation:
 * a_cmd = N * V_c * LOS_rate + (N/2) * a_target
 *
 * @param missile Current missile state
 * @param target Target state
 * @param target_accel Estimated target acceleration (g's)
 * @param N Navigation constant
 * @return Guidance command
 */
GuidanceCommand augmented_pn(
    const MissileState& missile,
    const GuidanceTarget& target,
    double target_accel,
    double N = 4.0);

/**
 * Pure Pursuit guidance
 *
 * Simply points directly at the target.
 * Simple but inefficient (tail chase).
 *
 * @param missile Current missile state
 * @param target Target state
 * @return Guidance command
 */
GuidanceCommand pure_pursuit(
    const MissileState& missile,
    const GuidanceTarget& target);

/**
 * Lead Pursuit guidance
 *
 * Points ahead of target based on estimated intercept.
 *
 * @param missile Current missile state
 * @param target Target state
 * @param lead_angle Lead angle in degrees
 * @return Guidance command
 */
GuidanceCommand lead_pursuit(
    const MissileState& missile,
    const GuidanceTarget& target,
    double lead_angle);

/**
 * Update missile state based on guidance command
 *
 * @param missile Missile state (modified in place)
 * @param cmd Guidance command
 * @param dt Timestep
 */
void update_missile_state(
    MissileState& missile,
    const GuidanceCommand& cmd,
    double dt);

/**
 * Check if missile has hit target
 *
 * @param missile Missile state
 * @param target Target position
 * @return True if within lethal radius
 */
bool check_hit(
    const MissileState& missile,
    const GuidanceTarget& target);

/**
 * Check if missile has missed (fuel exhausted, etc.)
 *
 * @param missile Missile state
 * @param target Target for range check
 * @return True if missile should be deactivated
 */
bool check_miss(
    const MissileState& missile,
    const GuidanceTarget& target);

/**
 * Simple missile simulation
 *
 * Simulates a missile from launch to impact/miss.
 *
 * @param missile Initial missile state
 * @param target_trajectory Vector of target states over time
 * @param params Guidance parameters
 * @param dt Simulation timestep
 * @param max_time Maximum flight time
 * @return Final missile state
 */
MissileState simulate_missile(
    MissileState missile,
    const std::vector<GuidanceTarget>& target_trajectory,
    const GuidanceParams& params,
    double dt = 0.1,
    double max_time = 60.0);

/**
 * Create a standard BVR missile (e.g., AIM-120 like)
 */
MissileState create_bvr_missile(
    int id,
    int launcher_id,
    int target_id,
    double lat, double lon, double alt,
    double heading, double speed);

/**
 * Create a standard WVR missile (e.g., AIM-9 like)
 */
MissileState create_wvr_missile(
    int id,
    int launcher_id,
    int target_id,
    double lat, double lon, double alt,
    double heading, double speed);

} // namespace sim

#endif // MISSILE_GUIDANCE_HPP
