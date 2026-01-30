/**
 * Synthetic Camera System
 *
 * Computes ground footprints, GSD, and target visibility for
 * nadir/off-nadir imaging sensors on spacecraft and aircraft.
 *
 * Key capabilities:
 * - FOV corner ray → Earth intersection → geodetic footprint
 * - Ground sample distance (GSD) from altitude and pixel pitch
 * - Target visibility check (within FOV cone + line of sight)
 * - Coverage strip computation along an orbit arc
 */

#ifndef SIM_SYNTHETIC_CAMERA_HPP
#define SIM_SYNTHETIC_CAMERA_HPP

#include "core/state_vector.hpp"
#include "physics/vec3_ops.hpp"
#include <vector>

namespace sim {

// ═══════════════════════════════════════════════════════════════
// Data Structures
// ═══════════════════════════════════════════════════════════════

/**
 * Camera sensor configuration
 */
struct CameraConfig {
    double fov_cross_track = 0.05;   // Cross-track FOV [rad] (~2.86°)
    double fov_along_track = 0.05;   // Along-track FOV [rad]
    int pixels_cross = 4096;          // Cross-track pixel count
    int pixels_along = 4096;          // Along-track pixel count
    double point_elevation = -90.0;   // Pointing elevation [deg] (-90 = nadir)
    double point_azimuth = 0.0;       // Pointing azimuth [deg] (0 = forward)

    static CameraConfig recon_default() {
        CameraConfig c;
        c.fov_cross_track = 0.02;    // ~1.15° narrow FOV
        c.fov_along_track = 0.02;
        c.pixels_cross = 8192;
        c.pixels_along = 8192;
        c.point_elevation = -90.0;
        return c;
    }

    static CameraConfig wide_area() {
        CameraConfig c;
        c.fov_cross_track = 0.524;   // 30° FOV
        c.fov_along_track = 0.524;
        c.pixels_cross = 2048;
        c.pixels_along = 2048;
        c.point_elevation = -90.0;
        return c;
    }
};

/**
 * Geodetic point on Earth's surface
 */
struct GeoPoint {
    double lat;   // [deg]
    double lon;   // [deg]
    double alt;   // [m] (0 for surface)
};

/**
 * Ground footprint of the camera FOV
 */
struct GroundFootprint {
    GeoPoint corners[4];     // TL, TR, BR, BL in geodetic
    GeoPoint center;         // Center of footprint
    double area_km2;         // Approximate footprint area [km²]
    double gsd_cross;        // Ground sample distance cross-track [m/pixel]
    double gsd_along;        // Ground sample distance along-track [m/pixel]
    double slant_range;      // Slant range to center [m]
    bool valid;              // False if any corner misses Earth
};

/**
 * Result of target visibility check
 */
struct VisibilityResult {
    bool is_visible;         // Target within FOV and not occluded
    double slant_range;      // Distance to target [m]
    double off_boresight;    // Angle from boresight [rad]
    double fov_x;            // Normalized position in FOV (-1 to +1 cross-track)
    double fov_y;            // Normalized position in FOV (-1 to +1 along-track)
};

// ═══════════════════════════════════════════════════════════════
// Synthetic Camera Class
// ═══════════════════════════════════════════════════════════════

class SyntheticCamera {
public:
    /**
     * Compute the ground footprint for a given camera and platform state.
     *
     * @param position  Platform position in ECI [m]
     * @param attitude  Platform attitude quaternion (body→ECI)
     * @param velocity  Platform velocity in ECI [m/s] (for along-track reference)
     * @param config    Camera configuration
     * @param jd        Julian date (for ECI→ECEF rotation)
     * @return Ground footprint with corners, area, GSD
     */
    static GroundFootprint compute_footprint(
        const Vec3& position,
        const Quat& attitude,
        const Vec3& velocity,
        const CameraConfig& config,
        double jd);

    /**
     * Simplified nadir-only footprint (no attitude needed).
     * Assumes camera points straight down from given geodetic position.
     *
     * @param alt_m   Altitude above surface [m]
     * @param lat_deg Sub-satellite latitude [deg]
     * @param lon_deg Sub-satellite longitude [deg]
     * @param config  Camera configuration
     * @return Ground footprint
     */
    static GroundFootprint compute_nadir_footprint(
        double alt_m, double lat_deg, double lon_deg,
        const CameraConfig& config);

    /**
     * Compute ground sample distance.
     *
     * @param altitude    Height above ground [m]
     * @param fov         Field of view [rad]
     * @param pixel_count Number of pixels across the FOV
     * @return GSD [m/pixel]
     */
    static double compute_gsd(double altitude, double fov, int pixel_count);

    /**
     * Check if a target point is visible in the camera FOV.
     *
     * @param camera_pos  Camera position in ECI [m]
     * @param camera_att  Camera attitude quaternion (body→ECI)
     * @param camera_vel  Camera velocity in ECI [m/s]
     * @param target_pos  Target position in ECI [m]
     * @param config      Camera configuration
     * @return Visibility result with range and FOV coordinates
     */
    static VisibilityResult is_target_visible(
        const Vec3& camera_pos,
        const Quat& camera_att,
        const Vec3& camera_vel,
        const Vec3& target_pos,
        const CameraConfig& config);

    /**
     * Compute a strip of footprints along a trajectory.
     *
     * @param states    Sequence of state vectors (ECI)
     * @param config    Camera configuration
     * @param epoch_jd  Julian date of first state (for GMST computation)
     * @return Vector of footprints (one per state)
     */
    static std::vector<GroundFootprint> compute_coverage_strip(
        const std::vector<StateVector>& states,
        const CameraConfig& config,
        double epoch_jd);

private:
    /**
     * Ray-Earth intersection.
     * Finds where a ray from origin in direction dir hits the Earth ellipsoid.
     *
     * @param origin Ray origin in ECEF [m]
     * @param dir    Ray direction (unit vector) in ECEF
     * @param hit    Output: intersection point in ECEF [m]
     * @return True if the ray hits Earth
     */
    static bool ray_earth_intersect(
        const Vec3& origin, const Vec3& dir, Vec3& hit);

    /**
     * Convert ECEF position to geodetic coordinates.
     */
    static GeoPoint ecef_to_geodetic(const Vec3& ecef);

    /**
     * Compute the boresight direction in body frame from pointing angles.
     */
    static Vec3 boresight_body(const CameraConfig& config);

    /**
     * Compute the 4 FOV corner rays in body frame.
     */
    static void fov_corner_rays(const CameraConfig& config, Vec3 rays[4]);
};

}  // namespace sim

#endif  // SIM_SYNTHETIC_CAMERA_HPP
