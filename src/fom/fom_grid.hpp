/**
 * FOM Grid - Spatial grid for Figure of Merit calculations
 *
 * Provides common grid functionality for computing metrics across
 * geographic areas. Supports both full-globe and smart (path-based) grids.
 */

#pragma once

#include <vector>
#include <set>
#include <cmath>
#include <functional>

namespace sim {
namespace fom {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_RADIUS_KM = 6378.137;

/**
 * A single cell in the FOM grid
 */
struct GridCell {
    double lat;         // Latitude in degrees
    double lon;         // Longitude in degrees
    int index;          // Cell index in the grid

    GridCell() : lat(0), lon(0), index(0) {}
    GridCell(double lat_, double lon_, int idx) : lat(lat_), lon(lon_), index(idx) {}
};

/**
 * Great circle distance between two points in km
 */
inline double great_circle_distance_km(double lat1, double lon1, double lat2, double lon2) {
    double phi1 = lat1 * DEG_TO_RAD;
    double phi2 = lat2 * DEG_TO_RAD;
    double dlon = (lon2 - lon1) * DEG_TO_RAD;

    double cos_d = std::sin(phi1) * std::sin(phi2) +
                   std::cos(phi1) * std::cos(phi2) * std::cos(dlon);
    cos_d = std::max(-1.0, std::min(1.0, cos_d));
    return std::acos(cos_d) * EARTH_RADIUS_KM;
}

/**
 * FOM Grid class - manages spatial grid for figure of merit calculations
 */
class FOMGrid {
public:
    /**
     * Create a full-globe grid with specified cell size
     * @param grid_size_km Approximate cell size in kilometers
     */
    static FOMGrid create_global(double grid_size_km) {
        FOMGrid grid;
        grid.grid_size_km_ = grid_size_km;
        grid.is_smart_grid_ = false;

        double lat_step = grid_size_km / 111.0;  // ~111 km per degree latitude

        int idx = 0;
        for (double lat = -90.0 + lat_step/2; lat < 90.0; lat += lat_step) {
            // Longitude step varies with latitude to keep cells roughly square
            double lon_step = lat_step / std::max(0.1, std::cos(lat * DEG_TO_RAD));
            lon_step = std::min(lon_step, 30.0);  // Cap at 30 degrees

            for (double lon = -180.0 + lon_step/2; lon < 180.0; lon += lon_step) {
                grid.cells_.emplace_back(lat, lon, idx++);
            }
        }

        return grid;
    }

    /**
     * Create a smart grid that only covers a specified ground track
     * @param grid_size_km Approximate cell size in kilometers
     * @param buffer_km Distance from track to include cells
     * @param track_points Vector of (lat, lon) pairs defining the ground track
     */
    static FOMGrid create_smart(double grid_size_km, double buffer_km,
                                const std::vector<std::pair<double, double>>& track_points) {
        FOMGrid grid;
        grid.grid_size_km_ = grid_size_km;
        grid.is_smart_grid_ = true;

        double lat_step = grid_size_km / 111.0;

        // Use set to track unique cell indices
        std::set<std::pair<int, int>> covered_cells;

        for (const auto& point : track_points) {
            double track_lat = point.first;
            double track_lon = point.second;

            // Check all cells within buffer distance
            for (double lat = -90.0; lat <= 90.0; lat += lat_step) {
                double lon_step = lat_step / std::max(0.1, std::cos(lat * DEG_TO_RAD));
                lon_step = std::min(lon_step, 30.0);

                for (double lon = -180.0; lon < 180.0; lon += lon_step) {
                    double dist = great_circle_distance_km(track_lat, track_lon, lat, lon);
                    if (dist <= buffer_km) {
                        int lat_idx = static_cast<int>((lat + 90.0) / lat_step);
                        int lon_idx = static_cast<int>((lon + 180.0) / lon_step);
                        covered_cells.insert({lat_idx, lon_idx});
                    }
                }
            }
        }

        // Convert to grid cells
        int idx = 0;
        for (const auto& cell : covered_cells) {
            double lat = cell.first * lat_step - 90.0;
            double lon_step = lat_step / std::max(0.1, std::cos(lat * DEG_TO_RAD));
            lon_step = std::min(lon_step, 30.0);
            double lon = cell.second * lon_step - 180.0;
            grid.cells_.emplace_back(lat, lon, idx++);
        }

        return grid;
    }

    // Accessors
    const std::vector<GridCell>& cells() const { return cells_; }
    size_t size() const { return cells_.size(); }
    double grid_size_km() const { return grid_size_km_; }
    bool is_smart_grid() const { return is_smart_grid_; }

    // Get cell bounds for visualization
    void get_cell_bounds(const GridCell& cell, double& west, double& east,
                         double& south, double& north) const {
        double lat_step = grid_size_km_ / 111.0;
        double lon_step = lat_step / std::max(0.1, std::cos(cell.lat * DEG_TO_RAD));
        lon_step = std::min(lon_step, 30.0);

        west = std::max(-180.0, cell.lon - lon_step / 2);
        east = std::min(180.0, cell.lon + lon_step / 2);
        south = std::max(-90.0, cell.lat - lat_step / 2);
        north = std::min(90.0, cell.lat + lat_step / 2);
    }

private:
    std::vector<GridCell> cells_;
    double grid_size_km_ = 50.0;
    bool is_smart_grid_ = false;
};

} // namespace fom
} // namespace sim
