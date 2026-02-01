/**
 * WaypointPatrolAI — Fly a sequence of waypoints with optional looping.
 *
 * Steering logic:
 *   - Bank toward desired heading (proportional to heading error)
 *   - Alpha for altitude hold (proportional to altitude error)
 *   - Throttle for speed hold (bang-bang with ramp)
 *
 * Waypoint arrival threshold: 2000 m great-circle distance.
 */

#include "montecarlo/waypoint_patrol_ai.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <algorithm>

namespace sim::mc {

void WaypointPatrolAI::update_all(double dt, MCWorld& world) {
    for (auto& e : world.entities()) {
        if (e.ai_type != AIType::WAYPOINT_PATROL) continue;
        if (!e.active || e.destroyed) continue;
        if (e.waypoints.empty()) continue;
        update_entity(e, dt);
    }
}

void WaypointPatrolAI::update_entity(MCEntity& e, double dt) {
    // ── Current waypoint ──
    const Waypoint& wp = e.waypoints[e.waypoint_index];

    // Convert positions to radians for geo functions
    double lat_rad = e.geo_lat * M_PI / 180.0;
    double lon_rad = e.geo_lon * M_PI / 180.0;
    double wp_lat_rad = wp.lat * M_PI / 180.0;
    double wp_lon_rad = wp.lon * M_PI / 180.0;

    // ── Bearing and distance to waypoint ──
    double bearing = great_circle_bearing(lat_rad, lon_rad, wp_lat_rad, wp_lon_rad);
    double distance = haversine_distance(lat_rad, lon_rad, wp_lat_rad, wp_lon_rad);

    // ── Desired state ──
    double desired_heading = bearing;
    double desired_alt = wp.alt;
    double desired_speed = (wp.speed > 0.0) ? wp.speed : e.flight_speed;

    // ── Heading steering ──
    double heading_error = angle_diff(desired_heading, e.flight_heading);

    // Roll command: proportional to heading error, max ~40 degrees bank
    double roll_cmd = std::clamp(heading_error * 2.0, -0.7, 0.7);

    // Smooth roll convergence
    double roll_rate = std::min(dt * 3.0, 1.0);
    e.flight_roll += (roll_cmd - e.flight_roll) * roll_rate;

    // ── Altitude steering via alpha ──
    double alt_error = desired_alt - e.geo_alt;
    e.flight_alpha = std::clamp(alt_error * 0.001, -0.15, 0.15);

    // ── Speed control via throttle ──
    if (e.flight_speed < desired_speed * 0.95) {
        e.flight_throttle += 0.1 * dt;
    } else if (e.flight_speed > desired_speed * 1.05) {
        e.flight_throttle -= 0.1 * dt;
    }
    e.flight_throttle = std::clamp(e.flight_throttle, 0.3, 1.0);

    // ── Waypoint arrival check ──
    if (distance < 2000.0) {
        e.waypoint_index++;
        if (e.waypoint_index >= static_cast<int>(e.waypoints.size())) {
            if (e.waypoint_loop) {
                e.waypoint_index = 0;
            } else {
                // Stay at last waypoint
                e.waypoint_index = static_cast<int>(e.waypoints.size()) - 1;
            }
        }
    }
}

} // namespace sim::mc
