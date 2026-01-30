/**
 * Solar Radiation Pressure Implementation
 */

#include "solar_radiation_pressure.hpp"
#include <cmath>

namespace sim {

Vec3 SolarRadiationPressure::compute_acceleration(
    const Vec3& pos_eci,
    const Vec3& sun_pos_eci,
    const SRPParameters& params) {

    // Check shadow first
    if (is_in_shadow(pos_eci, sun_pos_eci)) {
        return Vec3{0.0, 0.0, 0.0};
    }

    // Vector from spacecraft to Sun
    Vec3 r_to_sun{
        sun_pos_eci.x - pos_eci.x,
        sun_pos_eci.y - pos_eci.y,
        sun_pos_eci.z - pos_eci.z
    };
    double dist = r_to_sun.norm();
    if (dist < 1.0) {
        return Vec3{0.0, 0.0, 0.0};
    }

    // Unit vector from spacecraft toward Sun
    double inv_dist = 1.0 / dist;
    Vec3 r_hat{
        r_to_sun.x * inv_dist,
        r_to_sun.y * inv_dist,
        r_to_sun.z * inv_dist
    };

    // SRP acceleration magnitude
    // a = P * Cr * (A/m) * (AU/r)^2
    // Force points AWAY from Sun (radiation pushes spacecraft), so negate r_hat
    double au_over_r = AU / dist;
    double a_mag = P_SUN_1AU * params.cr * params.area_to_mass() * au_over_r * au_over_r;

    // Acceleration away from Sun (negative r_hat direction)
    return Vec3{
        -a_mag * r_hat.x,
        -a_mag * r_hat.y,
        -a_mag * r_hat.z
    };
}

bool SolarRadiationPressure::is_in_shadow(
    const Vec3& pos_eci,
    const Vec3& sun_pos_eci) {

    // Unit vector from Earth center to Sun
    double sun_dist = sun_pos_eci.norm();
    if (sun_dist < 1.0) return false;

    double inv_sun_dist = 1.0 / sun_dist;
    Vec3 s_hat{
        sun_pos_eci.x * inv_sun_dist,
        sun_pos_eci.y * inv_sun_dist,
        sun_pos_eci.z * inv_sun_dist
    };

    // Project spacecraft position onto Earth-Sun line
    double proj = pos_eci.x * s_hat.x + pos_eci.y * s_hat.y + pos_eci.z * s_hat.z;

    // If spacecraft is on the Sun-side of Earth, not in shadow
    if (proj >= 0.0) return false;

    // Perpendicular distance from Earth-Sun line
    Vec3 perp{
        pos_eci.x - proj * s_hat.x,
        pos_eci.y - proj * s_hat.y,
        pos_eci.z - proj * s_hat.z
    };
    double perp_dist = perp.norm();

    // In shadow if perpendicular distance < Earth radius
    return perp_dist < EARTH_RADIUS;
}

}  // namespace sim
