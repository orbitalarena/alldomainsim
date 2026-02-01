#ifndef SIM_MC_GEO_UTILS_HPP
#define SIM_MC_GEO_UTILS_HPP

#include "core/state_vector.hpp"
#include <cmath>
#include <utility>

namespace sim {
namespace mc {

// WGS84 ellipsoid constants
inline constexpr double WGS84_A    = 6378137.0;          // semi-major axis (meters)
inline constexpr double WGS84_E2   = 0.00669437999014;   // first eccentricity squared
inline constexpr double R_EARTH_MEAN = 6371000.0;        // mean Earth radius (meters)

/**
 * Convert geodetic coordinates to ECEF (Earth-Centered Earth-Fixed).
 * @param lat_rad  Geodetic latitude in radians
 * @param lon_rad  Geodetic longitude in radians
 * @param alt_m    Altitude above ellipsoid in meters
 * @return ECEF position as Vec3 (meters)
 */
inline Vec3 geodetic_to_ecef(double lat_rad, double lon_rad, double alt_m) {
    const double sin_lat = std::sin(lat_rad);
    const double cos_lat = std::cos(lat_rad);
    const double sin_lon = std::sin(lon_rad);
    const double cos_lon = std::cos(lon_rad);

    const double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

    return Vec3(
        (N + alt_m) * cos_lat * cos_lon,
        (N + alt_m) * cos_lat * sin_lon,
        (N * (1.0 - WGS84_E2) + alt_m) * sin_lat
    );
}

/**
 * Haversine great-circle distance between two points on the sphere.
 * @param lat1  Latitude of point 1 in radians
 * @param lon1  Longitude of point 1 in radians
 * @param lat2  Latitude of point 2 in radians
 * @param lon2  Longitude of point 2 in radians
 * @return Distance in meters (on mean-radius sphere)
 */
inline double haversine_distance(double lat1, double lon1, double lat2, double lon2) {
    const double dlat = lat2 - lat1;
    const double dlon = lon2 - lon1;

    const double a = std::sin(dlat * 0.5) * std::sin(dlat * 0.5)
                   + std::cos(lat1) * std::cos(lat2)
                   * std::sin(dlon * 0.5) * std::sin(dlon * 0.5);
    const double c = 2.0 * std::atan2(std::sqrt(a), std::sqrt(1.0 - a));

    return R_EARTH_MEAN * c;
}

/**
 * Initial great-circle bearing from point 1 to point 2.
 * @param lat1  Latitude of point 1 in radians
 * @param lon1  Longitude of point 1 in radians
 * @param lat2  Latitude of point 2 in radians
 * @param lon2  Longitude of point 2 in radians
 * @return Bearing in radians, range [0, 2*pi)
 */
inline double great_circle_bearing(double lat1, double lon1, double lat2, double lon2) {
    const double dlon = lon2 - lon1;

    const double y = std::sin(dlon) * std::cos(lat2);
    const double x = std::cos(lat1) * std::sin(lat2)
                   - std::sin(lat1) * std::cos(lat2) * std::cos(dlon);
    const double theta = std::atan2(y, x);

    return std::fmod(theta + 2.0 * M_PI, 2.0 * M_PI);
}

/**
 * Shortest signed angular difference from b to a.
 * @param a  Angle a in radians
 * @param b  Angle b in radians
 * @return Signed difference in radians, range [-pi, pi]
 */
inline double angle_diff(double a, double b) {
    double d = a - b;
    while (d > M_PI)  d -= 2.0 * M_PI;
    while (d < -M_PI) d += 2.0 * M_PI;
    return d;
}

/**
 * Euclidean (slant) range between two geodetic points via ECEF.
 * @param lat1  Latitude of point 1 in radians
 * @param lon1  Longitude of point 1 in radians
 * @param alt1  Altitude of point 1 in meters
 * @param lat2  Latitude of point 2 in radians
 * @param lon2  Longitude of point 2 in radians
 * @param alt2  Altitude of point 2 in meters
 * @return Euclidean distance in meters
 */
inline double slant_range_ecef(double lat1, double lon1, double alt1,
                               double lat2, double lon2, double alt2) {
    const Vec3 p1 = geodetic_to_ecef(lat1, lon1, alt1);
    const Vec3 p2 = geodetic_to_ecef(lat2, lon2, alt2);

    const double dx = p2.x - p1.x;
    const double dy = p2.y - p1.y;
    const double dz = p2.z - p1.z;

    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Compute destination point given start, bearing, and distance on great circle.
 * @param lat       Start latitude in radians
 * @param lon       Start longitude in radians
 * @param bearing   Initial bearing in radians
 * @param distance  Distance to travel in meters
 * @return {lat2, lon2} in radians
 */
inline std::pair<double, double> destination_point(double lat, double lon,
                                                   double bearing, double distance) {
    const double delta = distance / R_EARTH_MEAN;

    const double sin_lat  = std::sin(lat);
    const double cos_lat  = std::cos(lat);
    const double sin_d    = std::sin(delta);
    const double cos_d    = std::cos(delta);

    const double lat2 = std::asin(sin_lat * cos_d + cos_lat * sin_d * std::cos(bearing));
    const double lon2 = lon + std::atan2(std::sin(bearing) * sin_d * cos_lat,
                                         cos_d - sin_lat * std::sin(lat2));

    return {lat2, lon2};
}

/**
 * Elevation angle from point 1 looking toward point 2.
 * @param lat1  Latitude of observer in radians
 * @param lon1  Longitude of observer in radians
 * @param alt1  Altitude of observer in meters
 * @param lat2  Latitude of target in radians
 * @param lon2  Longitude of target in radians
 * @param alt2  Altitude of target in meters
 * @return Elevation angle in degrees
 */
inline double elevation_angle(double lat1, double lon1, double alt1,
                              double lat2, double lon2, double alt2) {
    const double ground_dist = haversine_distance(lat1, lon1, lat2, lon2);
    const double alt_diff = alt2 - alt1;

    if (ground_dist < 1.0) {
        return (alt_diff > 0.0) ? 90.0 : -90.0;
    }

    return std::atan2(alt_diff, ground_dist) * 180.0 / M_PI;
}

} // namespace mc
} // namespace sim

#endif // SIM_MC_GEO_UTILS_HPP
