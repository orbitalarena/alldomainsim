#include "missile_guidance.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

namespace {
    constexpr double DEG_TO_RAD = M_PI / 180.0;
    constexpr double RAD_TO_DEG = 180.0 / M_PI;
    constexpr double EARTH_RADIUS = 6371000.0;  // meters
    constexpr double GRAVITY = 9.81;

    // Compute range between two geodetic positions
    double compute_range(double lat1, double lon1, double lat2, double lon2) {
        double dlat = (lat2 - lat1) * DEG_TO_RAD;
        double dlon = (lon2 - lon1) * DEG_TO_RAD;
        double lat1_rad = lat1 * DEG_TO_RAD;
        double lat2_rad = lat2 * DEG_TO_RAD;

        double a = std::sin(dlat/2) * std::sin(dlat/2) +
                   std::cos(lat1_rad) * std::cos(lat2_rad) *
                   std::sin(dlon/2) * std::sin(dlon/2);
        double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1-a));
        return EARTH_RADIUS * c;
    }

    // Compute bearing from point 1 to point 2
    double compute_bearing(double lat1, double lon1, double lat2, double lon2) {
        double lat1_rad = lat1 * DEG_TO_RAD;
        double lat2_rad = lat2 * DEG_TO_RAD;
        double dlon = (lon2 - lon1) * DEG_TO_RAD;

        double y = std::sin(dlon) * std::cos(lat2_rad);
        double x = std::cos(lat1_rad) * std::sin(lat2_rad) -
                   std::sin(lat1_rad) * std::cos(lat2_rad) * std::cos(dlon);

        double bearing = std::atan2(y, x) * RAD_TO_DEG;
        while (bearing < 0) bearing += 360.0;
        while (bearing >= 360.0) bearing -= 360.0;
        return bearing;
    }

    double normalize_angle(double angle) {
        while (angle > 180.0) angle -= 360.0;
        while (angle < -180.0) angle += 360.0;
        return angle;
    }

    double normalize_heading(double heading) {
        while (heading < 0.0) heading += 360.0;
        while (heading >= 360.0) heading -= 360.0;
        return heading;
    }
}

GuidanceCommand proportional_navigation(
    const MissileState& missile,
    const GuidanceTarget& target,
    double N) {

    GuidanceCommand cmd;

    // Compute geometry
    double range_h = compute_range(missile.latitude, missile.longitude,
                                   target.latitude, target.longitude);
    double range_v = target.altitude - missile.altitude;
    double range_3d = std::sqrt(range_h * range_h + range_v * range_v);

    // Line of sight angles
    double los_azimuth = compute_bearing(missile.latitude, missile.longitude,
                                         target.latitude, target.longitude);
    double los_elevation = std::atan2(range_v, range_h) * RAD_TO_DEG;

    // Relative velocity components
    double v_m_north = missile.speed * std::cos(missile.heading * DEG_TO_RAD) *
                       std::cos(missile.flight_path_angle * DEG_TO_RAD);
    double v_m_east = missile.speed * std::sin(missile.heading * DEG_TO_RAD) *
                      std::cos(missile.flight_path_angle * DEG_TO_RAD);
    double v_m_up = missile.speed * std::sin(missile.flight_path_angle * DEG_TO_RAD);

    double v_t_north = target.speed * std::cos(target.heading * DEG_TO_RAD) *
                       std::cos(target.flight_path_angle * DEG_TO_RAD);
    double v_t_east = target.speed * std::sin(target.heading * DEG_TO_RAD) *
                      std::cos(target.flight_path_angle * DEG_TO_RAD);
    double v_t_up = target.speed * std::sin(target.flight_path_angle * DEG_TO_RAD);

    double v_rel_north = v_t_north - v_m_north;
    double v_rel_east = v_t_east - v_m_east;
    double v_rel_up = v_t_up - v_m_up;

    // Closing velocity (positive = closing)
    double los_unit_n = std::cos(los_azimuth * DEG_TO_RAD);
    double los_unit_e = std::sin(los_azimuth * DEG_TO_RAD);
    double los_unit_u = std::sin(los_elevation * DEG_TO_RAD);

    cmd.closing_velocity = -(v_rel_north * los_unit_n + v_rel_east * los_unit_e +
                             v_rel_up * los_unit_u * std::cos(los_elevation * DEG_TO_RAD));

    // Time to intercept (rough estimate)
    if (cmd.closing_velocity > 10.0) {
        cmd.time_to_intercept = range_3d / cmd.closing_velocity;
    } else {
        cmd.time_to_intercept = 999.0;
    }

    // LOS rate (simplified - using angle differences)
    // In a real implementation, this would use previous LOS measurements
    double los_rate_az = 0.0;
    double los_rate_el = 0.0;

    // Estimate LOS rate from perpendicular velocity components
    if (range_3d > 100.0) {
        double v_perp_az = -v_rel_north * std::sin(los_azimuth * DEG_TO_RAD) +
                           v_rel_east * std::cos(los_azimuth * DEG_TO_RAD);
        double v_perp_el = v_rel_up - (v_rel_north * los_unit_n + v_rel_east * los_unit_e) *
                           std::tan(los_elevation * DEG_TO_RAD);

        los_rate_az = v_perp_az / range_h * RAD_TO_DEG;
        los_rate_el = v_perp_el / range_3d * RAD_TO_DEG;
    }

    // PN command: a_cmd = N * Vc * LOS_rate
    double a_cmd_lat = N * cmd.closing_velocity * los_rate_az * DEG_TO_RAD;
    double a_cmd_vert = N * cmd.closing_velocity * los_rate_el * DEG_TO_RAD;

    // Convert to g's
    cmd.commanded_acceleration = std::sqrt(a_cmd_lat * a_cmd_lat + a_cmd_vert * a_cmd_vert) / GRAVITY;

    // Convert acceleration to heading/flight path commands
    // Simplified: point toward where the acceleration command points
    double heading_correction = std::atan2(a_cmd_lat, missile.speed) * RAD_TO_DEG;
    double fpa_correction = std::atan2(a_cmd_vert, missile.speed) * RAD_TO_DEG;

    cmd.commanded_heading = normalize_heading(los_azimuth + heading_correction * 0.5);
    cmd.commanded_flight_path = std::clamp(los_elevation + fpa_correction * 0.5, -45.0, 45.0);

    // Check if target in FOV
    double off_boresight = std::abs(normalize_angle(los_azimuth - missile.heading));
    cmd.target_in_fov = (off_boresight < missile.seeker_fov);

    return cmd;
}

GuidanceCommand augmented_pn(
    const MissileState& missile,
    const GuidanceTarget& target,
    double target_accel,
    double N) {

    // Start with standard PN
    GuidanceCommand cmd = proportional_navigation(missile, target, N);

    // Add target acceleration compensation
    // a_cmd += (N/2) * a_target (in direction normal to LOS)
    double accel_compensation = (N / 2.0) * target_accel;
    cmd.commanded_acceleration += accel_compensation;

    return cmd;
}

GuidanceCommand pure_pursuit(
    const MissileState& missile,
    const GuidanceTarget& target) {

    GuidanceCommand cmd;

    // Simply point at target
    double range_h = compute_range(missile.latitude, missile.longitude,
                                   target.latitude, target.longitude);
    double range_v = target.altitude - missile.altitude;
    double range_3d = std::sqrt(range_h * range_h + range_v * range_v);

    cmd.commanded_heading = compute_bearing(missile.latitude, missile.longitude,
                                            target.latitude, target.longitude);
    cmd.commanded_flight_path = std::atan2(range_v, range_h) * RAD_TO_DEG;
    cmd.commanded_flight_path = std::clamp(cmd.commanded_flight_path, -45.0, 45.0);

    // Compute required acceleration to turn
    double heading_error = std::abs(normalize_angle(cmd.commanded_heading - missile.heading));
    cmd.commanded_acceleration = (heading_error / 10.0) * (missile.speed / 100.0);

    // Closing velocity
    double v_m = missile.speed;
    double v_t = target.speed;
    double aa = (target.heading - cmd.commanded_heading) * DEG_TO_RAD;
    cmd.closing_velocity = v_m - v_t * std::cos(aa);

    if (cmd.closing_velocity > 10.0) {
        cmd.time_to_intercept = range_3d / cmd.closing_velocity;
    } else {
        cmd.time_to_intercept = 999.0;
    }

    double off_boresight = std::abs(normalize_angle(cmd.commanded_heading - missile.heading));
    cmd.target_in_fov = (off_boresight < missile.seeker_fov);

    return cmd;
}

GuidanceCommand lead_pursuit(
    const MissileState& missile,
    const GuidanceTarget& target,
    double lead_angle) {

    GuidanceCommand cmd;

    // Point ahead of target
    double bearing_to_target = compute_bearing(missile.latitude, missile.longitude,
                                               target.latitude, target.longitude);

    // Add lead in direction of target motion
    double target_velocity_heading = target.heading;
    double lead_direction = normalize_angle(target_velocity_heading - bearing_to_target);
    double lead_sign = (lead_direction > 0) ? 1.0 : -1.0;

    cmd.commanded_heading = normalize_heading(bearing_to_target + lead_sign * lead_angle);

    double range_h = compute_range(missile.latitude, missile.longitude,
                                   target.latitude, target.longitude);
    double range_v = target.altitude - missile.altitude;
    double range_3d = std::sqrt(range_h * range_h + range_v * range_v);

    cmd.commanded_flight_path = std::atan2(range_v, range_h) * RAD_TO_DEG;
    cmd.commanded_flight_path = std::clamp(cmd.commanded_flight_path, -45.0, 45.0);

    double heading_error = std::abs(normalize_angle(cmd.commanded_heading - missile.heading));
    cmd.commanded_acceleration = (heading_error / 10.0) * (missile.speed / 100.0);

    cmd.closing_velocity = missile.speed + target.speed * 0.5;  // Approximation
    cmd.time_to_intercept = range_3d / cmd.closing_velocity;

    double off_boresight = std::abs(normalize_angle(bearing_to_target - missile.heading));
    cmd.target_in_fov = (off_boresight < missile.seeker_fov);

    return cmd;
}

GuidanceCommand compute_guidance(
    const MissileState& missile,
    const GuidanceTarget& target,
    const GuidanceParams& params,
    double dt) {

    switch (params.law) {
        case GuidanceLaw::PROPORTIONAL_NAVIGATION:
            return proportional_navigation(missile, target, params.navigation_constant);

        case GuidanceLaw::AUGMENTED_PN:
            return augmented_pn(missile, target, 0.0, params.navigation_constant);

        case GuidanceLaw::PURE_PURSUIT:
            return pure_pursuit(missile, target);

        case GuidanceLaw::LEAD_PURSUIT:
            return lead_pursuit(missile, target, 15.0);

        default:
            return proportional_navigation(missile, target, params.navigation_constant);
    }
}

void update_missile_state(
    MissileState& missile,
    const GuidanceCommand& cmd,
    double dt) {

    if (!missile.is_active) return;

    // Limit acceleration
    double actual_accel = std::min(cmd.commanded_acceleration, missile.max_g);

    // Update heading with rate limit
    double heading_error = normalize_angle(cmd.commanded_heading - missile.heading);
    double max_heading_rate = (actual_accel * GRAVITY / missile.speed) * RAD_TO_DEG;
    double heading_change = std::clamp(heading_error, -max_heading_rate * dt, max_heading_rate * dt);
    missile.heading = normalize_heading(missile.heading + heading_change);

    // Update flight path angle
    double fpa_error = cmd.commanded_flight_path - missile.flight_path_angle;
    double fpa_change = std::clamp(fpa_error, -max_heading_rate * dt, max_heading_rate * dt);
    missile.flight_path_angle += fpa_change;
    missile.flight_path_angle = std::clamp(missile.flight_path_angle, -60.0, 60.0);

    // Update position
    double v_horizontal = missile.speed * std::cos(missile.flight_path_angle * DEG_TO_RAD);
    double v_vertical = missile.speed * std::sin(missile.flight_path_angle * DEG_TO_RAD);

    // Simple position update (flat earth approximation for small dt)
    double meters_per_deg_lat = 111132.0;
    double meters_per_deg_lon = 111132.0 * std::cos(missile.latitude * DEG_TO_RAD);

    double delta_north = v_horizontal * std::cos(missile.heading * DEG_TO_RAD) * dt;
    double delta_east = v_horizontal * std::sin(missile.heading * DEG_TO_RAD) * dt;

    missile.latitude += delta_north / meters_per_deg_lat;
    missile.longitude += delta_east / meters_per_deg_lon;
    missile.altitude += v_vertical * dt;

    missile.time_of_flight += dt;
}

bool check_hit(
    const MissileState& missile,
    const GuidanceTarget& target) {

    double range_h = compute_range(missile.latitude, missile.longitude,
                                   target.latitude, target.longitude);
    double range_v = std::abs(target.altitude - missile.altitude);
    double range_3d = std::sqrt(range_h * range_h + range_v * range_v);

    return (range_3d < missile.lethal_radius) && (missile.time_of_flight > 0.5);
}

bool check_miss(
    const MissileState& missile,
    const GuidanceTarget& target) {

    // Fuel exhausted (exceeded max range)
    double range_h = compute_range(missile.latitude, missile.longitude,
                                   target.latitude, target.longitude);
    double range_v = std::abs(target.altitude - missile.altitude);
    double range_3d = std::sqrt(range_h * range_h + range_v * range_v);

    // Miss conditions:
    // 1. Exceeded max flight time (approximation for fuel)
    double max_flight_time = missile.max_range / missile.max_speed * 1.5;
    if (missile.time_of_flight > max_flight_time) return true;

    // 2. Lost track (target outside FOV for extended time)
    double bearing = compute_bearing(missile.latitude, missile.longitude,
                                     target.latitude, target.longitude);
    double off_boresight = std::abs(normalize_angle(bearing - missile.heading));
    if (off_boresight > missile.seeker_fov * 2.0) return true;

    // 3. Below ground
    if (missile.altitude < 0.0) return true;

    // 4. Range increasing after closest approach
    // (Would need to track range history for this)

    return false;
}

MissileState simulate_missile(
    MissileState missile,
    const std::vector<GuidanceTarget>& target_trajectory,
    const GuidanceParams& params,
    double dt,
    double max_time) {

    missile.is_active = true;
    missile.has_hit = false;
    missile.time_of_flight = 0.0;

    int traj_idx = 0;
    double elapsed = 0.0;

    while (elapsed < max_time && missile.is_active) {
        // Get current target state (interpolate if needed)
        if (traj_idx >= static_cast<int>(target_trajectory.size()) - 1) {
            traj_idx = static_cast<int>(target_trajectory.size()) - 1;
        }
        const GuidanceTarget& target = target_trajectory[traj_idx];

        // Compute guidance
        GuidanceCommand cmd = compute_guidance(missile, target, params, dt);

        // Update missile
        update_missile_state(missile, cmd, dt);

        // Check for hit
        if (check_hit(missile, target)) {
            missile.has_hit = true;
            missile.is_active = false;
            break;
        }

        // Check for miss
        if (check_miss(missile, target)) {
            missile.is_active = false;
            break;
        }

        elapsed += dt;
        traj_idx++;  // Simple: assume target trajectory matches timestep
    }

    return missile;
}

MissileState create_bvr_missile(
    int id,
    int launcher_id,
    int target_id,
    double lat, double lon, double alt,
    double heading, double speed) {

    MissileState m;
    m.id = id;
    m.launcher_id = launcher_id;
    m.target_id = target_id;
    m.latitude = lat;
    m.longitude = lon;
    m.altitude = alt;
    m.heading = heading;
    m.speed = speed;
    m.flight_path_angle = 0.0;
    m.time_of_flight = 0.0;
    m.is_active = true;
    m.has_hit = false;

    // AIM-120 like parameters
    m.max_speed = 1400.0;      // ~Mach 4
    m.max_g = 40.0;
    m.max_range = 180000.0;    // 180 km
    m.min_range = 1000.0;      // 1 km arming
    m.seeker_fov = 60.0;       // +/- 60 degrees
    m.lethal_radius = 20.0;    // 20m lethal radius

    return m;
}

MissileState create_wvr_missile(
    int id,
    int launcher_id,
    int target_id,
    double lat, double lon, double alt,
    double heading, double speed) {

    MissileState m;
    m.id = id;
    m.launcher_id = launcher_id;
    m.target_id = target_id;
    m.latitude = lat;
    m.longitude = lon;
    m.altitude = alt;
    m.heading = heading;
    m.speed = speed;
    m.flight_path_angle = 0.0;
    m.time_of_flight = 0.0;
    m.is_active = true;
    m.has_hit = false;

    // AIM-9 like parameters
    m.max_speed = 900.0;       // ~Mach 2.5
    m.max_g = 35.0;
    m.max_range = 35000.0;     // 35 km
    m.min_range = 300.0;       // 300m arming
    m.seeker_fov = 45.0;       // +/- 45 degrees
    m.lethal_radius = 10.0;    // 10m lethal radius

    return m;
}

} // namespace sim
