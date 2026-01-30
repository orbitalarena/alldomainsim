#include "coordinate/frame_transformer.hpp"
#include "coordinate/time_utils.hpp"
#include "physics/planetary_ephemeris.hpp"
#include <cmath>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double RAD_TO_DEG = 180.0 / PI;

Vec3 FrameTransformer::eci_to_ecef(const Vec3& pos_eci, double jd) {
    // Compute GMST (Greenwich Mean Sidereal Time)
    double gmst = TimeUtils::compute_gmst(jd);

    // Rotation about Z-axis by -GMST (ECEF rotates with Earth)
    double cos_gmst = std::cos(gmst);
    double sin_gmst = std::sin(gmst);

    // Apply rotation matrix:
    // | cos(gmst)   sin(gmst)  0 |
    // | -sin(gmst)  cos(gmst)  0 |
    // | 0           0          1 |
    Vec3 pos_ecef;
    pos_ecef.x = cos_gmst * pos_eci.x + sin_gmst * pos_eci.y;
    pos_ecef.y = -sin_gmst * pos_eci.x + cos_gmst * pos_eci.y;
    pos_ecef.z = pos_eci.z;

    return pos_ecef;
}

GeodeticCoord FrameTransformer::ecef_to_geodetic(const Vec3& pos_ecef) {
    // Bowring's iterative method for geodetic conversion
    // More accurate than simple approximations

    const double x = pos_ecef.x;
    const double y = pos_ecef.y;
    const double z = pos_ecef.z;

    // Longitude is straightforward
    double lon = std::atan2(y, x);

    // Distance from Z-axis
    double p = std::sqrt(x * x + y * y);

    // Initial estimate of latitude using spherical approximation
    double lat = std::atan2(z, p * (1.0 - WGS84_E2));

    // Bowring's iterative method (typically converges in 2-3 iterations)
    for (int iter = 0; iter < 10; iter++) {
        double sin_lat = std::sin(lat);
        double cos_lat = std::cos(lat);

        // Radius of curvature in prime vertical
        double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

        // Update latitude
        double lat_new = std::atan2(z + WGS84_E2 * N * sin_lat, p);

        if (std::abs(lat_new - lat) < 1e-12) {
            lat = lat_new;
            break;
        }
        lat = lat_new;
    }

    // Compute altitude
    double sin_lat = std::sin(lat);
    double cos_lat = std::cos(lat);
    double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

    double alt;
    if (std::abs(cos_lat) > 1e-10) {
        alt = p / cos_lat - N;
    } else {
        // Near poles, use Z component
        alt = std::abs(z) / std::abs(sin_lat) - N * (1.0 - WGS84_E2);
    }

    // Convert to degrees
    GeodeticCoord result;
    result.latitude = lat * RAD_TO_DEG;
    result.longitude = lon * RAD_TO_DEG;
    result.altitude = alt;

    return result;
}

GeodeticCoord FrameTransformer::eci_to_geodetic(const Vec3& pos_eci, double jd) {
    // First convert to ECEF
    Vec3 pos_ecef = eci_to_ecef(pos_eci, jd);

    // Then convert to geodetic
    return ecef_to_geodetic(pos_ecef);
}

// ─────────────────────────────────────────────────────────────
// Heliocentric J2000 (HCI) conversions
// ─────────────────────────────────────────────────────────────

Vec3 FrameTransformer::eci_to_hci(const Vec3& pos_eci, double jd) {
    // Earth's position in HCI = where Earth is relative to Sun
    Vec3 earth_hci = PlanetaryEphemeris::get_position_hci(Planet::EARTH, jd);
    return Vec3{
        pos_eci.x + earth_hci.x,
        pos_eci.y + earth_hci.y,
        pos_eci.z + earth_hci.z
    };
}

Vec3 FrameTransformer::vel_eci_to_hci(const Vec3& vel_eci, double jd) {
    Vec3 earth_vel = PlanetaryEphemeris::get_velocity_hci(Planet::EARTH, jd);
    return Vec3{
        vel_eci.x + earth_vel.x,
        vel_eci.y + earth_vel.y,
        vel_eci.z + earth_vel.z
    };
}

Vec3 FrameTransformer::hci_to_eci(const Vec3& pos_hci, double jd) {
    Vec3 earth_hci = PlanetaryEphemeris::get_position_hci(Planet::EARTH, jd);
    return Vec3{
        pos_hci.x - earth_hci.x,
        pos_hci.y - earth_hci.y,
        pos_hci.z - earth_hci.z
    };
}

Vec3 FrameTransformer::vel_hci_to_eci(const Vec3& vel_hci, double jd) {
    Vec3 earth_vel = PlanetaryEphemeris::get_velocity_hci(Planet::EARTH, jd);
    return Vec3{
        vel_hci.x - earth_vel.x,
        vel_hci.y - earth_vel.y,
        vel_hci.z - earth_vel.z
    };
}

Vec3 FrameTransformer::hci_to_planet_centered(const Vec3& pos_hci, Planet planet, double jd) {
    Vec3 planet_hci = PlanetaryEphemeris::get_position_hci(planet, jd);
    return Vec3{
        pos_hci.x - planet_hci.x,
        pos_hci.y - planet_hci.y,
        pos_hci.z - planet_hci.z
    };
}

Vec3 FrameTransformer::vel_hci_to_planet_centered(const Vec3& vel_hci, Planet planet, double jd) {
    Vec3 planet_vel = PlanetaryEphemeris::get_velocity_hci(planet, jd);
    return Vec3{
        vel_hci.x - planet_vel.x,
        vel_hci.y - planet_vel.y,
        vel_hci.z - planet_vel.z
    };
}

} // namespace sim
