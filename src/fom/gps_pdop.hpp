/**
 * GPS PDOP Figure of Merit
 *
 * Computes Position Dilution of Precision (PDOP) across a spatial grid
 * based on GPS satellite geometry. Lower PDOP indicates better positioning accuracy.
 *
 * PDOP ranges:
 *   1.0 - 2.0: Excellent
 *   2.0 - 3.0: Good
 *   3.0 - 5.0: Moderate
 *   5.0 - 6.0: Fair
 *   > 6.0: Poor
 */

#pragma once

#include "figure_of_merit.hpp"
#include "physics/orbital_elements.hpp"
#include <vector>

namespace sim {
namespace fom {

/**
 * GPS Satellite state for PDOP computation
 */
struct GPSSatellite {
    OrbitalElements elements;
    std::string prn;  // PRN identifier (e.g., "G01")

    GPSSatellite() = default;
    GPSSatellite(const OrbitalElements& elem, const std::string& id = "")
        : elements(elem), prn(id) {}
};

/**
 * GPS PDOP Calculator
 */
class GPSPDOP : public FigureOfMerit {
public:
    /**
     * Create a GPS PDOP calculator
     * @param grid The spatial grid to compute PDOP over
     * @param satellites Vector of GPS satellites
     * @param min_elevation_deg Minimum elevation angle for visibility (default 5 degrees)
     */
    GPSPDOP(const FOMGrid& grid, const std::vector<GPSSatellite>& satellites,
            double min_elevation_deg = 5.0);

    /**
     * Create from TLE catalog file
     * @param grid The spatial grid
     * @param tle_file Path to TLE file containing GPS satellites
     * @param min_elevation_deg Minimum elevation angle
     */
    static GPSPDOP from_tle_file(const FOMGrid& grid, const std::string& tle_file,
                                  double min_elevation_deg = 5.0);

    // FigureOfMerit interface
    FOMMetadata get_metadata() const override;
    std::vector<double> compute(double time) override;
    const FOMGrid& get_grid() const override { return grid_; }

    // Accessors
    size_t num_satellites() const { return satellites_.size(); }
    const std::vector<GPSSatellite>& satellites() const { return satellites_; }

private:
    FOMGrid grid_;
    std::vector<GPSSatellite> satellites_;
    double min_elevation_deg_;
    double epoch_jd_;  // Julian date epoch for propagation

    // Compute satellite ECEF position at time t
    Vec3 get_satellite_ecef(const GPSSatellite& sat, double t) const;

    // Check if satellite is visible from ground point
    bool is_visible(const Vec3& sat_ecef, double ground_lat, double ground_lon) const;

    // Compute PDOP at a single grid point
    double compute_pdop(double lat, double lon, double time,
                        const std::vector<Vec3>& sat_positions) const;
};

} // namespace fom
} // namespace sim
