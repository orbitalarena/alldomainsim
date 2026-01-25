#ifndef FRAME_TRANSFORMER_HPP
#define FRAME_TRANSFORMER_HPP

#include "core/state_vector.hpp"

namespace sim {

/**
 * @brief Geodetic coordinates (latitude, longitude, altitude)
 */
struct GeodeticCoord {
    double latitude;   // Degrees, positive north
    double longitude;  // Degrees, positive east
    double altitude;   // Meters above WGS84 ellipsoid
};

/**
 * @brief Coordinate frame transformations
 *
 * Provides conversions between ECI, ECEF, and geodetic coordinate systems
 */
class FrameTransformer {
public:
    // WGS84 ellipsoid parameters
    static constexpr double WGS84_A = 6378137.0;           // Semi-major axis [m]
    static constexpr double WGS84_F = 1.0 / 298.257223563; // Flattening
    static constexpr double WGS84_B = WGS84_A * (1.0 - WGS84_F); // Semi-minor axis [m]
    static constexpr double WGS84_E2 = 2.0 * WGS84_F - WGS84_F * WGS84_F; // Eccentricity squared

    /**
     * @brief Transform ECI position to ECEF
     * @param pos_eci Position in ECI frame [m]
     * @param jd Julian Date for Earth rotation angle
     * @return Position in ECEF frame [m]
     */
    static Vec3 eci_to_ecef(const Vec3& pos_eci, double jd);

    /**
     * @brief Transform ECEF position to geodetic coordinates
     * @param pos_ecef Position in ECEF frame [m]
     * @return Geodetic coordinates (lat, lon in degrees, alt in meters)
     */
    static GeodeticCoord ecef_to_geodetic(const Vec3& pos_ecef);

    /**
     * @brief Transform ECI position directly to geodetic coordinates
     * @param pos_eci Position in ECI frame [m]
     * @param jd Julian Date for Earth rotation angle
     * @return Geodetic coordinates (lat, lon in degrees, alt in meters)
     */
    static GeodeticCoord eci_to_geodetic(const Vec3& pos_eci, double jd);
};

} // namespace sim

#endif // FRAME_TRANSFORMER_HPP
