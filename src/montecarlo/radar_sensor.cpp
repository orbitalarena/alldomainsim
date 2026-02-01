#include "montecarlo/radar_sensor.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>

namespace sim::mc {

// Earth rotation rate (rad/s) for GMST computation
static constexpr double OMEGA_EARTH = 7.2921159e-5;

/**
 * Convert ECI position to ECEF via simple GMST rotation.
 * Suitable for short-duration sims where precession/nutation are negligible.
 */
static Vec3 eci_to_ecef(const Vec3& eci, double sim_time) {
    double gmst = OMEGA_EARTH * sim_time;
    double c = std::cos(gmst);
    double s = std::sin(gmst);
    return Vec3(
         c * eci.x + s * eci.y,
        -s * eci.x + c * eci.y,
        eci.z
    );
}

/**
 * Get ECEF position for any entity based on its physics type.
 * Ground/flight entities use geodetic_to_ecef; orbital entities use ECI→ECEF rotation.
 */
static Vec3 entity_ecef(const MCEntity& e, double sim_time) {
    if (e.physics_type == PhysicsType::ORBITAL_2BODY) {
        return eci_to_ecef(e.eci_pos, sim_time);
    }
    // Ground or flight: convert geodetic (degrees) to ECEF
    double lat_rad = e.geo_lat * M_PI / 180.0;
    double lon_rad = e.geo_lon * M_PI / 180.0;
    return geodetic_to_ecef(lat_rad, lon_rad, e.geo_alt);
}

/**
 * Compute bearing from observer ECEF position to target ECEF position.
 * Returns bearing in radians [0, 2*pi) from north.
 * Uses a simplified local-tangent-plane projection.
 */
static double compute_bearing_ecef(const Vec3& obs, const Vec3& tgt) {
    // Observer geodetic approximation for local frame
    double r_obs = std::sqrt(obs.x * obs.x + obs.y * obs.y + obs.z * obs.z);
    if (r_obs < 1.0) return 0.0;

    double lat = std::asin(obs.z / r_obs);
    double lon = std::atan2(obs.y, obs.x);

    double sin_lat = std::sin(lat);
    double cos_lat = std::cos(lat);
    double sin_lon = std::sin(lon);
    double cos_lon = std::cos(lon);

    // Difference vector in ECEF
    double dx = tgt.x - obs.x;
    double dy = tgt.y - obs.y;
    double dz = tgt.z - obs.z;

    // Project onto local ENU (East-North-Up)
    double east  = -sin_lon * dx + cos_lon * dy;
    double north = -sin_lat * cos_lon * dx - sin_lat * sin_lon * dy + cos_lat * dz;

    double bearing = std::atan2(east, north);
    if (bearing < 0.0) bearing += 2.0 * M_PI;
    return bearing;
}

void RadarSensor::update_all(double dt, MCWorld& world) {
    for (auto& entity : world.entities()) {
        if (!entity.has_radar) continue;
        if (!entity.active || entity.destroyed) continue;
        update_entity(entity, dt, world);
    }
}

void RadarSensor::update_entity(MCEntity& e, double dt, MCWorld& world) {
    // Increment sweep timer
    e.radar_sweep_timer += dt;
    if (e.radar_sweep_timer < e.radar_sweep_interval) return;

    // New sweep
    e.radar_sweep_timer = 0.0;
    e.radar_detections.clear();

    Vec3 sensor_ecef = entity_ecef(e, world.sim_time);

    for (auto& target : world.entities()) {
        // Skip self
        if (target.id == e.id) continue;
        // Skip same team
        if (target.team == e.team) continue;
        // Skip inactive/destroyed
        if (!target.active || target.destroyed) continue;

        Vec3 tgt_ecef = entity_ecef(target, world.sim_time);

        // Compute slant range (Euclidean distance in ECEF)
        double dx = tgt_ecef.x - sensor_ecef.x;
        double dy = tgt_ecef.y - sensor_ecef.y;
        double dz = tgt_ecef.z - sensor_ecef.z;
        double range = std::sqrt(dx * dx + dy * dy + dz * dz);

        // Range gate
        if (range > e.radar_max_range) continue;

        // Elevation angle check
        // Use geodetic approximation for the observer
        double lat_rad = e.geo_lat * M_PI / 180.0;
        double lon_rad = e.geo_lon * M_PI / 180.0;
        double tgt_lat_rad, tgt_lon_rad, tgt_alt;

        if (target.physics_type == PhysicsType::ORBITAL_2BODY) {
            // Approximate geodetic from ECEF for orbital targets
            double r = std::sqrt(tgt_ecef.x * tgt_ecef.x +
                                 tgt_ecef.y * tgt_ecef.y +
                                 tgt_ecef.z * tgt_ecef.z);
            tgt_lat_rad = std::asin(tgt_ecef.z / r);
            tgt_lon_rad = std::atan2(tgt_ecef.y, tgt_ecef.x);
            tgt_alt = r - R_EARTH_MEAN;
        } else {
            tgt_lat_rad = target.geo_lat * M_PI / 180.0;
            tgt_lon_rad = target.geo_lon * M_PI / 180.0;
            tgt_alt = target.geo_alt;
        }

        double elev = elevation_angle(lat_rad, lon_rad, e.geo_alt,
                                       tgt_lat_rad, tgt_lon_rad, tgt_alt);

        if (elev < e.radar_min_elev_deg || elev > e.radar_max_elev_deg) continue;

        // Probabilistic detection roll
        if (!world.rng.bernoulli(e.radar_p_detect)) continue;

        // Compute bearing from sensor to target
        double bearing = compute_bearing_ecef(sensor_ecef, tgt_ecef);

        // Detection!
        e.radar_detections.push_back(RadarDetection{
            target.id,
            range,
            bearing,
            world.sim_time
        });
    }
}

} // namespace sim::mc
