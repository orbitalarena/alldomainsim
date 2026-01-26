/**
 * Lunar Ephemeris Implementation
 */

#include "lunar_ephemeris.hpp"
#include <cmath>

namespace sim {

double LunarEphemeris::get_moon_mean_anomaly(double jd) {
    // Time since J2000 epoch in days
    double days_since_j2000 = jd - J2000_EPOCH;

    // Convert to seconds
    double seconds_since_j2000 = days_since_j2000 * 86400.0;

    // Mean anomaly = initial longitude + n * t
    double mean_anomaly = MOON_L0_J2000 + MOON_MEAN_MOTION * seconds_since_j2000;

    // Normalize to [0, 2π]
    mean_anomaly = std::fmod(mean_anomaly, TWO_PI);
    if (mean_anomaly < 0) {
        mean_anomaly += TWO_PI;
    }

    return mean_anomaly;
}

Vec3 LunarEphemeris::get_moon_position_eci(double jd) {
    // Get mean anomaly (treating as true anomaly for circular orbit)
    double theta = get_moon_mean_anomaly(jd);

    // For circular orbit, position is straightforward
    // Using simplified model: Moon orbits in a plane inclined to equator
    double r = EARTH_MOON_DISTANCE;

    // Position in orbital plane
    double x_orb = r * std::cos(theta);
    double y_orb = r * std::sin(theta);

    // Rotate by inclination (simplified - orbit node at vernal equinox)
    // For more accuracy, would need to track RAAN of lunar orbit
    double cos_i = std::cos(MOON_INCLINATION);
    double sin_i = std::sin(MOON_INCLINATION);

    Vec3 pos;
    pos.x = x_orb;
    pos.y = y_orb * cos_i;
    pos.z = y_orb * sin_i;

    return pos;
}

Vec3 LunarEphemeris::get_moon_velocity_eci(double jd) {
    // Get mean anomaly
    double theta = get_moon_mean_anomaly(jd);

    // Circular orbital velocity
    double v = EARTH_MOON_DISTANCE * MOON_MEAN_MOTION;  // ~1022 m/s

    // Velocity in orbital plane (perpendicular to position for circular orbit)
    double vx_orb = -v * std::sin(theta);
    double vy_orb = v * std::cos(theta);

    // Rotate by inclination
    double cos_i = std::cos(MOON_INCLINATION);
    double sin_i = std::sin(MOON_INCLINATION);

    Vec3 vel;
    vel.x = vx_orb;
    vel.y = vy_orb * cos_i;
    vel.z = vy_orb * sin_i;

    return vel;
}

StateVector LunarEphemeris::get_moon_state_eci(double jd) {
    StateVector state;
    state.position = get_moon_position_eci(jd);
    state.velocity = get_moon_velocity_eci(jd);
    state.frame = CoordinateFrame::J2000_ECI;
    state.time = (jd - J2000_EPOCH) * 86400.0;  // Seconds since J2000

    return state;
}

}  // namespace sim
