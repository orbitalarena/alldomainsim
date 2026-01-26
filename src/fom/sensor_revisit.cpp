/**
 * Sensor Revisit Time Implementation
 */

#include "sensor_revisit.hpp"
#include "physics/gravity_model.hpp"
#include <cmath>

namespace sim {
namespace fom {

SensorRevisit::SensorRevisit(const FOMGrid& grid, const std::vector<SensorSatellite>& satellites)
    : grid_(grid)
    , satellites_(satellites)
{
    reset_state();
}

SensorRevisit SensorRevisit::single_satellite(const FOMGrid& grid,
                                               double altitude_km,
                                               double inclination_deg,
                                               double sensor_half_angle_deg) {
    // Create orbital elements for the satellite
    OrbitalElements elements;
    elements.semi_major_axis = (EARTH_RADIUS_KM + altitude_km) * 1000.0;  // Convert to meters
    elements.eccentricity = 0.0001;  // Near-circular
    elements.inclination = inclination_deg * DEG_TO_RAD;
    elements.raan = 0.0;
    elements.arg_periapsis = 0.0;
    elements.true_anomaly = 0.0;
    elements.mean_anomaly = 0.0;

    // Create sensor config
    SensorConfig sensor(sensor_half_angle_deg);
    sensor.compute_footprint(altitude_km);

    // Create satellite
    SensorSatellite sat(elements, sensor, "SENSOR-1");

    return SensorRevisit(grid, {sat});
}

FOMMetadata SensorRevisit::get_metadata() const {
    FOMMetadata meta;
    meta.name = "Sensor Revisit Time";
    meta.unit = "seconds";
    meta.min_value = 0.0;
    meta.max_value = 3600.0;  // 1 hour
    meta.invalid_value = -1.0;
    meta.lower_is_better = true;
    return meta;
}

void SensorRevisit::reset_state() {
    last_seen_times_.assign(grid_.size(), -1.0);  // Never seen
    current_time_ = 0;
}

std::pair<double, double> SensorRevisit::get_subsatellite_point(const SensorSatellite& sat, double t) const {
    // Propagate using Keplerian motion
    double mu = GravityModel::EARTH_MU;
    double n = std::sqrt(mu / std::pow(sat.elements.semi_major_axis, 3));
    double new_M = sat.elements.mean_anomaly + n * t;

    // Normalize mean anomaly
    while (new_M > 2.0 * PI) new_M -= 2.0 * PI;
    while (new_M < 0) new_M += 2.0 * PI;

    // Solve Kepler's equation
    double e = sat.elements.eccentricity;
    double E = new_M;
    for (int i = 0; i < 10; i++) {
        E = new_M + e * std::sin(E);
    }

    // True anomaly
    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );

    // Position in orbital plane
    double r = sat.elements.semi_major_axis * (1 - e * std::cos(E));
    double x_orb = r * std::cos(nu);
    double y_orb = r * std::sin(nu);

    // Transform to ECI
    double i = sat.elements.inclination;
    double omega = sat.elements.arg_periapsis;
    double Omega = sat.elements.raan;

    double cos_O = std::cos(Omega), sin_O = std::sin(Omega);
    double cos_i = std::cos(i), sin_i = std::sin(i);
    double cos_w = std::cos(omega), sin_w = std::sin(omega);

    Vec3 eci;
    eci.x = (cos_O * cos_w - sin_O * sin_w * cos_i) * x_orb +
            (-cos_O * sin_w - sin_O * cos_w * cos_i) * y_orb;
    eci.y = (sin_O * cos_w + cos_O * sin_w * cos_i) * x_orb +
            (-sin_O * sin_w + cos_O * cos_w * cos_i) * y_orb;
    eci.z = (sin_w * sin_i) * x_orb + (cos_w * sin_i) * y_orb;

    // Convert ECI to ECEF (account for Earth rotation)
    double earth_rotation = t * 7.2921159e-5;
    double cos_rot = std::cos(earth_rotation);
    double sin_rot = std::sin(earth_rotation);

    Vec3 ecef;
    ecef.x = eci.x * cos_rot + eci.y * sin_rot;
    ecef.y = -eci.x * sin_rot + eci.y * cos_rot;
    ecef.z = eci.z;

    // Convert ECEF to lat/lon
    double r_ecef = ecef.norm();
    double lat = std::asin(ecef.z / r_ecef) * RAD_TO_DEG;
    double lon = std::atan2(ecef.y, ecef.x) * RAD_TO_DEG;

    return {lat, lon};
}

bool SensorRevisit::is_in_footprint(double sat_lat, double sat_lon,
                                     double ground_lat, double ground_lon,
                                     double footprint_km) const {
    double dist = great_circle_distance_km(sat_lat, sat_lon, ground_lat, ground_lon);
    return dist <= footprint_km;
}

std::vector<double> SensorRevisit::compute(double time) {
    std::vector<double> values(grid_.size());

    // Update last seen times for all satellites
    for (const auto& sat : satellites_) {
        auto [sat_lat, sat_lon] = get_subsatellite_point(sat, time);

        for (const auto& cell : grid_.cells()) {
            if (is_in_footprint(sat_lat, sat_lon, cell.lat, cell.lon,
                               sat.sensor.footprint_radius_km)) {
                last_seen_times_[cell.index] = time;
            }
        }
    }

    // Compute time since last seen
    for (size_t i = 0; i < grid_.size(); i++) {
        if (last_seen_times_[i] < 0) {
            values[i] = -1.0;  // Never seen
        } else {
            values[i] = time - last_seen_times_[i];
        }
    }

    current_time_ = time;
    return values;
}

FOMResult SensorRevisit::compute_series(double start_time, double end_time, double time_step) {
    reset_state();

    FOMResult result;
    result.metadata = get_metadata();
    result.grid = grid_;

    // Use smaller internal time step for accuracy, but output at requested rate
    double internal_step = std::min(time_step, 1.0);
    double output_step = time_step;

    double next_output = start_time;

    for (double t = start_time; t <= end_time; t += internal_step) {
        // Always update state
        auto values = compute(t);

        // Output frame at requested intervals
        if (t >= next_output - internal_step/2) {
            FOMFrame frame(t, grid_.size());
            frame.values = values;
            result.frames.push_back(std::move(frame));
            next_output += output_step;
        }
    }

    return result;
}

std::vector<std::pair<double, double>> SensorRevisit::compute_ground_track(
    double start_time, double end_time, double time_step) const {

    std::vector<std::pair<double, double>> track;

    for (double t = start_time; t <= end_time; t += time_step) {
        for (const auto& sat : satellites_) {
            track.push_back(get_subsatellite_point(sat, t));
        }
    }

    return track;
}

} // namespace fom
} // namespace sim
