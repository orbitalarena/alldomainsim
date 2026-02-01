/**
 * InterceptAI — Chase and engage a designated target entity.
 *
 * For each entity with ai_type == INTERCEPT:
 *   1. Resolve target by intercept_target_id
 *   2. Compute bearing and distance to target geodetic position
 *   3. Steer toward target (bank, alpha, throttle)
 *   4. Set intercept_state = 1 when within engage range
 *
 * Cannot intercept ORBITAL_2BODY targets (no atmospheric steering solution).
 */

#include "montecarlo/intercept_ai.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <algorithm>

namespace sim::mc {

void InterceptAI::update_all(double dt, MCWorld& world) {
    for (auto& e : world.entities()) {
        if (e.ai_type != AIType::INTERCEPT) continue;
        if (!e.active || e.destroyed) continue;
        update_entity(e, dt, world);
    }
}

void InterceptAI::update_entity(MCEntity& e, double dt, MCWorld& world) {
    // ── Resolve target ──
    if (e.intercept_target_id.empty()) return;

    MCEntity* target = world.get_entity(e.intercept_target_id);
    if (!target || !target->active || target->destroyed) {
        e.intercept_state = 0;
        return;
    }

    // Cannot intercept orbital targets with atmospheric flight
    if (target->physics_type == PhysicsType::ORBITAL_2BODY) {
        e.intercept_state = 0;
        return;
    }

    // ── Target geodetic position ──
    double tgt_lat = target->geo_lat;
    double tgt_lon = target->geo_lon;
    double tgt_alt = target->geo_alt;

    // Convert to radians for geo functions
    double lat_rad     = e.geo_lat * M_PI / 180.0;
    double lon_rad     = e.geo_lon * M_PI / 180.0;
    double tgt_lat_rad = tgt_lat * M_PI / 180.0;
    double tgt_lon_rad = tgt_lon * M_PI / 180.0;

    // ── Bearing and distance ──
    double bearing  = great_circle_bearing(lat_rad, lon_rad, tgt_lat_rad, tgt_lon_rad);
    double distance = haversine_distance(lat_rad, lon_rad, tgt_lat_rad, tgt_lon_rad);

    // Include altitude difference for 3D slant range
    double alt_diff = tgt_alt - e.geo_alt;
    double slant_distance = std::sqrt(distance * distance + alt_diff * alt_diff);

    // ── Pursuit steering (mode 0, 1, 2 all use pure pursuit for now) ──
    double desired_heading = bearing;

    // Desired altitude: match target for airborne targets, minimum 500m for ground
    double desired_alt;
    if (target->physics_type == PhysicsType::FLIGHT_3DOF) {
        desired_alt = tgt_alt;
    } else {
        // Ground/static target: maintain at least 500m altitude
        desired_alt = std::max(tgt_alt, 500.0);
    }

    // Max speed pursuit: full throttle
    e.flight_throttle = 1.0;

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

    // ── Engagement check ──
    if (e.intercept_engage_range > 0.0 && slant_distance < e.intercept_engage_range) {
        e.intercept_state = 1;  // Engaged — signals weapon system
    } else {
        e.intercept_state = 0;  // Still navigating
    }
}

} // namespace sim::mc
