/**
 * Sensor Revisit Time Figure of Merit
 *
 * Computes the time since each grid cell was last observed by a sensor.
 * Useful for assessing ISR (Intelligence, Surveillance, Reconnaissance)
 * coverage and revisit rates.
 *
 * Values represent seconds since last observation:
 *   0 - Currently being observed
 *   > 0 - Seconds since last seen
 *   -1 - Never observed (invalid)
 */

#pragma once

#include "figure_of_merit.hpp"
#include "physics/orbital_elements.hpp"
#include <vector>

namespace sim {
namespace fom {

/**
 * Sensor configuration
 */
struct SensorConfig {
    double half_angle_deg;      // Sensor half-angle (degrees)
    double footprint_radius_km; // Computed footprint on ground (km)

    SensorConfig(double half_angle = 25.0) : half_angle_deg(half_angle) {
        footprint_radius_km = 0;  // Computed based on altitude
    }

    // Compute footprint radius based on altitude
    void compute_footprint(double altitude_km) {
        footprint_radius_km = altitude_km * std::tan(half_angle_deg * DEG_TO_RAD);
    }
};

/**
 * Sensor satellite configuration
 */
struct SensorSatellite {
    OrbitalElements elements;
    SensorConfig sensor;
    std::string name;

    SensorSatellite() = default;
    SensorSatellite(const OrbitalElements& elem, const SensorConfig& sens,
                    const std::string& id = "")
        : elements(elem), sensor(sens), name(id) {}
};

/**
 * Sensor Revisit Time Calculator
 *
 * Tracks time since each grid cell was last within a sensor's footprint.
 * Supports multiple satellites with different sensors.
 */
class SensorRevisit : public FigureOfMerit {
public:
    /**
     * Create a sensor revisit calculator
     * @param grid The spatial grid to compute revisit times over
     * @param satellites Vector of sensor satellites
     */
    SensorRevisit(const FOMGrid& grid, const std::vector<SensorSatellite>& satellites);

    /**
     * Create with a single satellite for simple cases
     * @param grid The spatial grid
     * @param altitude_km Satellite altitude in km
     * @param inclination_deg Orbital inclination in degrees
     * @param sensor_half_angle_deg Sensor half-angle in degrees
     */
    static SensorRevisit single_satellite(const FOMGrid& grid,
                                          double altitude_km,
                                          double inclination_deg,
                                          double sensor_half_angle_deg);

    // FigureOfMerit interface
    FOMMetadata get_metadata() const override;
    std::vector<double> compute(double time) override;
    const FOMGrid& get_grid() const override { return grid_; }

    /**
     * Override compute_series to properly track state over time
     * The base implementation doesn't maintain state between frames
     */
    FOMResult compute_series(double start_time, double end_time, double time_step) override;

    // Accessors
    size_t num_satellites() const { return satellites_.size(); }
    const std::vector<SensorSatellite>& satellites() const { return satellites_; }

    // Get satellite ground track for smart grid creation
    std::vector<std::pair<double, double>> compute_ground_track(
        double start_time, double end_time, double time_step) const;

private:
    FOMGrid grid_;
    std::vector<SensorSatellite> satellites_;

    // State tracking for revisit computation
    std::vector<double> last_seen_times_;  // Last time each cell was observed
    double current_time_ = 0;

    // Get satellite sub-point (lat, lon) at time t
    std::pair<double, double> get_subsatellite_point(const SensorSatellite& sat, double t) const;

    // Check if ground point is within sensor footprint
    bool is_in_footprint(double sat_lat, double sat_lon, double ground_lat, double ground_lon,
                         double footprint_km) const;

    // Reset state for new computation
    void reset_state();
};

} // namespace fom
} // namespace sim
