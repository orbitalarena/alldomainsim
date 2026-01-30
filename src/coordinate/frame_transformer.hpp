#ifndef FRAME_TRANSFORMER_HPP
#define FRAME_TRANSFORMER_HPP

#include "core/state_vector.hpp"

// Forward declare Planet enum (defined in planetary_ephemeris.hpp)
namespace sim { enum class Planet; }

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

    // ── Heliocentric (HCI) conversions (Phase 4) ──

    /**
     * @brief Transform ECI position to Heliocentric J2000 Equatorial
     * HCI = ECI + Earth_position_HCI (Earth's position from Sun)
     * @param pos_eci Position in ECI frame [m]
     * @param jd Julian Date
     * @return Position in Heliocentric J2000 Equatorial [m]
     */
    static Vec3 eci_to_hci(const Vec3& pos_eci, double jd);

    /**
     * @brief Transform ECI velocity to HCI velocity
     * Accounts for Earth's orbital velocity
     */
    static Vec3 vel_eci_to_hci(const Vec3& vel_eci, double jd);

    /**
     * @brief Transform HCI position to ECI
     */
    static Vec3 hci_to_eci(const Vec3& pos_hci, double jd);

    /**
     * @brief Transform HCI velocity to ECI velocity
     */
    static Vec3 vel_hci_to_eci(const Vec3& vel_hci, double jd);

    /**
     * @brief Transform HCI position to planet-centered inertial
     */
    static Vec3 hci_to_planet_centered(const Vec3& pos_hci, Planet planet, double jd);

    /**
     * @brief Transform HCI velocity to planet-centered velocity
     */
    static Vec3 vel_hci_to_planet_centered(const Vec3& vel_hci, Planet planet, double jd);
};

} // namespace sim

#endif // FRAME_TRANSFORMER_HPP
