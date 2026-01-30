/**
 * Synthetic Camera System Implementation
 */

#include "synthetic_camera.hpp"
#include "coordinate/time_utils.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

// Earth ellipsoid (WGS84)
static constexpr double RE_A = 6378137.0;         // Semi-major axis [m]
static constexpr double RE_B = 6356752.314245;     // Semi-minor axis [m]
static constexpr double RE_A2 = RE_A * RE_A;
static constexpr double RE_B2 = RE_B * RE_B;
static constexpr double DEG = 3.14159265358979323846 / 180.0;

// ─────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────

Vec3 SyntheticCamera::boresight_body(const CameraConfig& config) {
    // Body frame: X = forward, Y = right, Z = down
    // Elevation: angle from horizontal (-90 = straight down = +Z)
    // Azimuth: angle from forward in horizontal plane
    double el = config.point_elevation * DEG;
    double az = config.point_azimuth * DEG;

    // For nadir pointing (el = -90°): cos(el)=0, sin(el)=-1 → (0,0,1) in body Z-down
    return Vec3{
        std::cos(el) * std::cos(az),
        std::cos(el) * std::sin(az),
        -std::sin(el)
    };
}

void SyntheticCamera::fov_corner_rays(const CameraConfig& config, Vec3 rays[4]) {
    Vec3 boresight = boresight_body(config);

    double half_cross = config.fov_cross_track * 0.5;
    double half_along = config.fov_along_track * 0.5;

    // Build a local frame around the boresight
    // For near-nadir pointing, we use body X (forward) as the "up" reference
    Vec3 ref = Vec3{1.0, 0.0, 0.0};
    if (std::abs(dot(boresight, ref)) > 0.99) {
        ref = Vec3{0.0, 1.0, 0.0};  // fallback if boresight ≈ forward
    }

    Vec3 right = normalized(cross(boresight, ref));  // cross-track direction
    Vec3 up = normalized(cross(right, boresight));    // along-track direction

    // Corner offsets: TL, TR, BR, BL
    double dc[4] = {-half_cross, +half_cross, +half_cross, -half_cross};
    double da[4] = {+half_along, +half_along, -half_along, -half_along};

    for (int i = 0; i < 4; i++) {
        // Small-angle rotation around boresight
        Vec3 ray = boresight + right * std::tan(dc[i]) + up * std::tan(da[i]);
        rays[i] = normalized(ray);
    }
}

bool SyntheticCamera::ray_earth_intersect(
    const Vec3& origin, const Vec3& dir, Vec3& hit) {

    // Ellipsoid: x²/a² + y²/a² + z²/b² = 1
    // Substitute ray: P = O + t*D
    // (Ox+t*Dx)²/a² + (Oy+t*Dy)²/a² + (Oz+t*Dz)²/b² = 1
    double dx = dir.x, dy = dir.y, dz = dir.z;
    double ox = origin.x, oy = origin.y, oz = origin.z;

    double a_coeff = dx * dx / RE_A2 + dy * dy / RE_A2 + dz * dz / RE_B2;
    double b_coeff = 2.0 * (ox * dx / RE_A2 + oy * dy / RE_A2 + oz * dz / RE_B2);
    double c_coeff = ox * ox / RE_A2 + oy * oy / RE_A2 + oz * oz / RE_B2 - 1.0;

    double discriminant = b_coeff * b_coeff - 4.0 * a_coeff * c_coeff;
    if (discriminant < 0.0) {
        return false;  // Ray misses Earth
    }

    double sqrt_disc = std::sqrt(discriminant);
    double t1 = (-b_coeff - sqrt_disc) / (2.0 * a_coeff);
    double t2 = (-b_coeff + sqrt_disc) / (2.0 * a_coeff);

    // Take nearest positive intersection
    double t = (t1 > 0.0) ? t1 : t2;
    if (t < 0.0) {
        return false;  // Earth is behind us
    }

    hit = Vec3{ox + t * dx, oy + t * dy, oz + t * dz};
    return true;
}

GeoPoint SyntheticCamera::ecef_to_geodetic(const Vec3& ecef) {
    GeoPoint gp;
    gp.lon = std::atan2(ecef.y, ecef.x) / DEG;

    double p = std::sqrt(ecef.x * ecef.x + ecef.y * ecef.y);
    double e2 = 1.0 - RE_B2 / RE_A2;
    double lat_rad = std::atan2(ecef.z, p * (1.0 - e2));

    // Bowring's iterative method (5 iterations)
    for (int i = 0; i < 5; i++) {
        double sin_lat = std::sin(lat_rad);
        double N = RE_A / std::sqrt(1.0 - e2 * sin_lat * sin_lat);
        lat_rad = std::atan2(ecef.z + e2 * N * sin_lat, p);
    }

    gp.lat = lat_rad / DEG;

    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N = RE_A / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    if (std::abs(cos_lat) > 1e-10) {
        gp.alt = p / cos_lat - N;
    } else {
        gp.alt = std::abs(ecef.z) - RE_B;
    }

    return gp;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

double SyntheticCamera::compute_gsd(double altitude, double fov, int pixel_count) {
    if (pixel_count <= 0 || altitude <= 0.0) return 0.0;
    // Ground swath = 2 * alt * tan(fov/2), GSD = swath / pixels
    double swath = 2.0 * altitude * std::tan(fov * 0.5);
    return swath / pixel_count;
}

GroundFootprint SyntheticCamera::compute_nadir_footprint(
    double alt_m, double lat_deg, double lon_deg,
    const CameraConfig& config) {

    GroundFootprint fp{};
    fp.valid = false;

    if (alt_m <= 0.0) return fp;

    // GSD
    fp.gsd_cross = compute_gsd(alt_m, config.fov_cross_track, config.pixels_cross);
    fp.gsd_along = compute_gsd(alt_m, config.fov_along_track, config.pixels_along);
    fp.slant_range = alt_m;

    // Ground swath dimensions [m]
    double swath_cross = 2.0 * alt_m * std::tan(config.fov_cross_track * 0.5);
    double swath_along = 2.0 * alt_m * std::tan(config.fov_along_track * 0.5);

    // Convert swath to degrees at given latitude
    double m_per_deg_lat = 111320.0;
    double m_per_deg_lon = 111320.0 * std::cos(lat_deg * DEG);
    if (m_per_deg_lon < 1.0) m_per_deg_lon = 1.0;

    double d_lat = (swath_along * 0.5) / m_per_deg_lat;
    double d_lon = (swath_cross * 0.5) / m_per_deg_lon;

    // Corners: TL, TR, BR, BL
    fp.corners[0] = {lat_deg + d_lat, lon_deg - d_lon, 0.0};
    fp.corners[1] = {lat_deg + d_lat, lon_deg + d_lon, 0.0};
    fp.corners[2] = {lat_deg - d_lat, lon_deg + d_lon, 0.0};
    fp.corners[3] = {lat_deg - d_lat, lon_deg - d_lon, 0.0};
    fp.center = {lat_deg, lon_deg, 0.0};

    fp.area_km2 = (swath_cross * swath_along) / 1e6;
    fp.valid = true;

    return fp;
}

GroundFootprint SyntheticCamera::compute_footprint(
    const Vec3& position,
    const Quat& attitude,
    const Vec3& velocity,
    const CameraConfig& config,
    double jd) {

    GroundFootprint fp{};
    fp.valid = false;

    // Altitude check
    double r = position.norm();
    double alt = r - RE_A;  // approximate
    if (alt < 100.0) return fp;

    // ECI → ECEF rotation (Earth rotation angle from Julian date)
    double gmst = TimeUtils::compute_gmst(jd);
    double cos_g = std::cos(gmst);
    double sin_g = std::sin(gmst);

    // Rotate position to ECEF
    Vec3 pos_ecef{
        position.x * cos_g + position.y * sin_g,
       -position.x * sin_g + position.y * cos_g,
        position.z
    };

    // Compute FOV corner rays in body frame
    Vec3 body_rays[4];
    fov_corner_rays(config, body_rays);

    // Rotate each corner ray from body → ECI → ECEF and intersect with Earth
    Vec3 ecef_hits[4];
    for (int i = 0; i < 4; i++) {
        // Body → ECI via attitude quaternion
        Vec3 eci_ray = quat_rotate(attitude, body_rays[i]);

        // ECI → ECEF
        Vec3 ecef_ray{
            eci_ray.x * cos_g + eci_ray.y * sin_g,
           -eci_ray.x * sin_g + eci_ray.y * cos_g,
            eci_ray.z
        };

        if (!ray_earth_intersect(pos_ecef, ecef_ray, ecef_hits[i])) {
            return fp;  // Corner misses Earth → invalid footprint
        }

        fp.corners[i] = ecef_to_geodetic(ecef_hits[i]);
    }

    // Boresight intersection for center
    Vec3 bore_body = boresight_body(config);
    Vec3 bore_eci = quat_rotate(attitude, bore_body);
    Vec3 bore_ecef{
        bore_eci.x * cos_g + bore_eci.y * sin_g,
       -bore_eci.x * sin_g + bore_eci.y * cos_g,
        bore_eci.z
    };
    Vec3 center_hit;
    if (ray_earth_intersect(pos_ecef, bore_ecef, center_hit)) {
        fp.center = ecef_to_geodetic(center_hit);
        fp.slant_range = distance(pos_ecef, center_hit);
    } else {
        // Fallback: average corners
        fp.center.lat = 0.25 * (fp.corners[0].lat + fp.corners[1].lat +
                                 fp.corners[2].lat + fp.corners[3].lat);
        fp.center.lon = 0.25 * (fp.corners[0].lon + fp.corners[1].lon +
                                 fp.corners[2].lon + fp.corners[3].lon);
        fp.center.alt = 0.0;
        fp.slant_range = alt;
    }

    // GSD from slant range
    fp.gsd_cross = compute_gsd(fp.slant_range, config.fov_cross_track, config.pixels_cross);
    fp.gsd_along = compute_gsd(fp.slant_range, config.fov_along_track, config.pixels_along);

    // Approximate area from corner diagonal distances
    double d1 = distance(ecef_hits[0], ecef_hits[2]);
    double d2 = distance(ecef_hits[1], ecef_hits[3]);
    fp.area_km2 = 0.5 * d1 * d2 / 1e6;  // Quadrilateral area from diagonals

    fp.valid = true;
    return fp;
}

VisibilityResult SyntheticCamera::is_target_visible(
    const Vec3& camera_pos,
    const Quat& camera_att,
    const Vec3& camera_vel,
    const Vec3& target_pos,
    const CameraConfig& config) {

    VisibilityResult result{};
    result.is_visible = false;

    // Vector from camera to target in ECI
    Vec3 to_target = target_pos - camera_pos;
    result.slant_range = to_target.norm();

    if (result.slant_range < 1.0) {
        return result;  // Co-located
    }

    // Transform to body frame
    Vec3 target_body = quat_rotate_inverse(camera_att, to_target);
    Vec3 target_dir = normalized(target_body);

    // Boresight in body frame
    Vec3 bore = boresight_body(config);

    // Off-boresight angle
    double cos_angle = dot(target_dir, bore);
    cos_angle = std::clamp(cos_angle, -1.0, 1.0);
    result.off_boresight = std::acos(cos_angle);

    // Check if within FOV
    double max_half_fov = std::max(config.fov_cross_track, config.fov_along_track) * 0.5;
    if (result.off_boresight > max_half_fov * 1.2) {
        return result;  // Outside FOV (with 20% margin for rectangular)
    }

    // Decompose into cross-track and along-track components
    // Build local FOV frame
    Vec3 ref{1.0, 0.0, 0.0};
    if (std::abs(dot(bore, ref)) > 0.99) ref = Vec3{0.0, 1.0, 0.0};
    Vec3 right = normalized(cross(bore, ref));
    Vec3 up = normalized(cross(right, bore));

    // Project target direction onto FOV plane
    double cross_comp = dot(target_dir - bore * cos_angle, right);
    double along_comp = dot(target_dir - bore * cos_angle, up);

    // Normalize to FOV half-angles
    double half_cross = std::tan(config.fov_cross_track * 0.5);
    double half_along = std::tan(config.fov_along_track * 0.5);

    result.fov_x = (half_cross > 1e-10) ? cross_comp / half_cross : 0.0;
    result.fov_y = (half_along > 1e-10) ? along_comp / half_along : 0.0;

    // Within rectangular FOV?
    if (std::abs(result.fov_x) > 1.0 || std::abs(result.fov_y) > 1.0) {
        return result;
    }

    // Line-of-sight check: is Earth between camera and target?
    // Check if the closest point on the ray to Earth center is below surface
    Vec3 dir = normalized(to_target);
    double t_closest = dot(Vec3{0,0,0} - camera_pos, dir);  // project origin onto ray

    if (t_closest > 0.0 && t_closest < result.slant_range) {
        Vec3 closest = camera_pos + dir * t_closest;
        double r_closest = closest.norm();
        // Use mean Earth radius for quick LOS check
        if (r_closest < RE_A * 0.99) {
            return result;  // Occluded by Earth
        }
    }

    result.is_visible = true;
    return result;
}

std::vector<GroundFootprint> SyntheticCamera::compute_coverage_strip(
    const std::vector<StateVector>& states,
    const CameraConfig& config,
    double epoch_jd) {

    std::vector<GroundFootprint> strip;
    strip.reserve(states.size());

    for (size_t i = 0; i < states.size(); i++) {
        const auto& s = states[i];
        double jd = epoch_jd + s.time / 86400.0;

        GroundFootprint fp = compute_footprint(
            s.position, s.attitude, s.velocity, config, jd);

        strip.push_back(fp);
    }

    return strip;
}

}  // namespace sim
