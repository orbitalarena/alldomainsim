/**
 * LEO Sensor Revisit Time Calculator
 *
 * Simulates a LEO satellite with a nadir-pointing sensor cone.
 * Uses a SMART GRID that only covers the satellite's ground track.
 * Tracks time since each grid cell was last within the sensor footprint.
 */

#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "coordinate/frame_transformer.hpp"
#include "coordinate/time_utils.hpp"
#include <fstream>
#include <iostream>
#include <iomanip>
#include <vector>
#include <set>
#include <cmath>
#include <chrono>

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_RADIUS = 6378137.0;

// Grid cell structure
struct GridCell {
    double lat;
    double lon;
    double lastSeen;
};

// Satellite configuration
struct SatelliteConfig {
    double altitude_km;
    double inclination_deg;
    double sensor_half_angle_deg;
    double raan_deg;
};

// Calculate sensor footprint radius on ground (km)
double sensor_footprint_radius(double altitude_km, double half_angle_deg) {
    double gamma = half_angle_deg * DEG_TO_RAD;
    return altitude_km * std::tan(gamma);
}

// Get sub-satellite point
void get_subsatellite_point(const Vec3& sat_ecef, double& lat_deg, double& lon_deg) {
    double r = sat_ecef.norm();
    lat_deg = std::asin(sat_ecef.z / r) * RAD_TO_DEG;
    lon_deg = std::atan2(sat_ecef.y, sat_ecef.x) * RAD_TO_DEG;
}

// Great circle distance in km
double great_circle_distance(double lat1, double lon1, double lat2, double lon2) {
    double phi1 = lat1 * DEG_TO_RAD;
    double phi2 = lat2 * DEG_TO_RAD;
    double dlon = (lon2 - lon1) * DEG_TO_RAD;

    double cos_d = std::sin(phi1) * std::sin(phi2) +
                   std::cos(phi1) * std::cos(phi2) * std::cos(dlon);
    cos_d = std::max(-1.0, std::min(1.0, cos_d));
    return std::acos(cos_d) * EARTH_RADIUS / 1000.0;
}

// Check if point is in sensor footprint
bool is_in_footprint(double sat_lat, double sat_lon, double ground_lat, double ground_lon,
                     double footprint_km) {
    double dist = great_circle_distance(sat_lat, sat_lon, ground_lat, ground_lon);
    return dist <= footprint_km;
}

// Propagate satellite
StateVector propagate_satellite(const OrbitalElements& initial_elements,
                                double dt_seconds, double mu) {
    OrbitalElements elem = initial_elements;
    double n = std::sqrt(mu / std::pow(elem.semi_major_axis, 3));
    double new_M = elem.mean_anomaly + n * dt_seconds;

    while (new_M > 2.0 * PI) new_M -= 2.0 * PI;
    while (new_M < 0) new_M += 2.0 * PI;

    double e = elem.eccentricity;
    double E = new_M;
    for (int i = 0; i < 10; i++) {
        E = new_M + e * std::sin(E);
    }

    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );

    elem.true_anomaly = nu;
    elem.mean_anomaly = new_M;
    return OrbitalMechanics::elements_to_state(elem, mu);
}

// Convert ECI to ECEF
Vec3 eci_to_ecef(const Vec3& eci, double t) {
    double earth_rotation = t * 7.2921159e-5;
    double cos_rot = std::cos(earth_rotation);
    double sin_rot = std::sin(earth_rotation);

    Vec3 ecef;
    ecef.x = eci.x * cos_rot + eci.y * sin_rot;
    ecef.y = -eci.x * sin_rot + eci.y * cos_rot;
    ecef.z = eci.z;
    return ecef;
}

int main(int argc, char* argv[]) {
    // Configuration
    double grid_size_km = 50.0;
    double sim_duration_minutes = 30.0;
    double time_step_seconds = 1.0;
    double output_step_seconds = 2.0;

    SatelliteConfig sat;
    sat.altitude_km = 400.0;
    sat.inclination_deg = 51.6;
    sat.sensor_half_angle_deg = 25.0;
    sat.raan_deg = 0.0;

    if (argc > 1) grid_size_km = std::atof(argv[1]);
    if (argc > 2) sim_duration_minutes = std::atof(argv[2]);
    if (argc > 3) sat.sensor_half_angle_deg = std::atof(argv[3]);
    if (argc > 4) output_step_seconds = std::atof(argv[4]);

    double footprint_km = sensor_footprint_radius(sat.altitude_km, sat.sensor_half_angle_deg);
    // Buffer distance: footprint + some margin for grid cells
    double buffer_km = footprint_km + grid_size_km * 2;

    std::cout << "LEO Sensor Revisit Calculator (Smart Grid)\n";
    std::cout << "Grid size: " << grid_size_km << " km\n";
    std::cout << "Duration: " << sim_duration_minutes << " minutes\n";
    std::cout << "Sensor footprint: " << footprint_km << " km\n";
    std::cout << "Grid buffer: " << buffer_km << " km\n";

    // Create orbital elements
    double mu = GravityModel::EARTH_MU;
    double altitude_m = sat.altitude_km * 1000.0;
    double semi_major = EARTH_RADIUS + altitude_m;

    OrbitalElements elements;
    elements.semi_major_axis = semi_major;
    elements.eccentricity = 0.0001;
    elements.inclination = sat.inclination_deg * DEG_TO_RAD;
    elements.raan = sat.raan_deg * DEG_TO_RAD;
    elements.arg_periapsis = 0.0;
    elements.true_anomaly = 0.0;
    elements.mean_anomaly = 0.0;

    double period = 2.0 * PI * std::sqrt(std::pow(semi_major, 3) / mu);
    std::cout << "Orbital period: " << period / 60.0 << " minutes\n";

    // PHASE 1: Pre-compute ground track to build smart grid
    std::cout << "Phase 1: Computing ground track...\n";

    std::set<std::pair<int, int>> covered_cells;  // (lat_idx, lon_idx)
    double lat_spacing = grid_size_km / 111.0;

    int num_sim_steps = static_cast<int>(sim_duration_minutes * 60.0 / time_step_seconds) + 1;

    for (int step = 0; step < num_sim_steps; step++) {
        double t = step * time_step_seconds;
        StateVector sv = propagate_satellite(elements, t, mu);
        Vec3 sat_ecef = eci_to_ecef(sv.position, t);

        double sat_lat, sat_lon;
        get_subsatellite_point(sat_ecef, sat_lat, sat_lon);

        // Mark all cells within buffer distance
        for (double lat = -90.0; lat <= 90.0; lat += lat_spacing) {
            double lon_spacing = lat_spacing / std::max(0.1, std::cos(lat * DEG_TO_RAD));
            lon_spacing = std::min(lon_spacing, 30.0);

            for (double lon = -180.0; lon < 180.0; lon += lon_spacing) {
                double dist = great_circle_distance(sat_lat, sat_lon, lat, lon);
                if (dist <= buffer_km) {
                    int lat_idx = static_cast<int>((lat + 90.0) / lat_spacing);
                    int lon_idx = static_cast<int>((lon + 180.0) / lon_spacing);
                    covered_cells.insert({lat_idx, lon_idx});
                }
            }
        }
    }

    std::cout << "Ground track covers " << covered_cells.size() << " unique cell positions\n";

    // PHASE 2: Build smart grid from covered cells only
    std::cout << "Phase 2: Building smart grid...\n";

    std::vector<GridCell> grid;
    for (const auto& cell : covered_cells) {
        GridCell gc;
        gc.lat = cell.first * lat_spacing - 90.0;
        // Recalculate lon_spacing for this latitude
        double lon_spacing = lat_spacing / std::max(0.1, std::cos(gc.lat * DEG_TO_RAD));
        lon_spacing = std::min(lon_spacing, 30.0);
        gc.lon = cell.second * lon_spacing - 180.0;
        gc.lastSeen = -1.0;
        grid.push_back(gc);
    }

    std::cout << "Smart grid: " << grid.size() << " cells (vs ~13000 for full globe)\n";

    // Time parameters
    int output_interval = static_cast<int>(output_step_seconds / time_step_seconds);
    int num_output_frames = num_sim_steps / output_interval + 1;

    std::cout << "Outputting " << num_output_frames << " frames...\n";

    // Open output file
    std::ofstream out("visualization/cesium/sensor_revisit_data.json");
    out << std::fixed << std::setprecision(4);

    out << "{\n";
    out << "  \"metadata\": {\n";
    out << "    \"grid_size_km\": " << grid_size_km << ",\n";
    out << "    \"num_grid_cells\": " << grid.size() << ",\n";
    out << "    \"num_time_steps\": " << num_output_frames << ",\n";
    out << "    \"time_step_seconds\": " << output_step_seconds << ",\n";
    out << "    \"duration_minutes\": " << sim_duration_minutes << ",\n";
    out << "    \"altitude_km\": " << sat.altitude_km << ",\n";
    out << "    \"inclination_deg\": " << sat.inclination_deg << ",\n";
    out << "    \"sensor_half_angle_deg\": " << sat.sensor_half_angle_deg << ",\n";
    out << "    \"footprint_radius_km\": " << footprint_km << ",\n";
    out << "    \"orbital_period_minutes\": " << period / 60.0 << ",\n";
    out << "    \"smart_grid\": true\n";
    out << "  },\n";

    // Output grid points
    out << "  \"grid\": [\n";
    for (size_t i = 0; i < grid.size(); i++) {
        out << "    {\"lat\": " << grid[i].lat << ", \"lon\": " << grid[i].lon << "}";
        if (i < grid.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ],\n";

    // PHASE 3: Simulate and output frames
    out << "  \"frames\": [\n";

    auto start_time = std::chrono::high_resolution_clock::now();
    int frames_written = 0;

    for (int step = 0; step < num_sim_steps; step++) {
        double t = step * time_step_seconds;

        StateVector sv = propagate_satellite(elements, t, mu);
        Vec3 sat_ecef = eci_to_ecef(sv.position, t);

        double sat_lat, sat_lon;
        get_subsatellite_point(sat_ecef, sat_lat, sat_lon);

        // Update coverage
        for (auto& cell : grid) {
            if (is_in_footprint(sat_lat, sat_lon, cell.lat, cell.lon, footprint_km)) {
                cell.lastSeen = t;
            }
        }

        // Output frame at intervals
        if (step % output_interval == 0) {
            out << "    {\n";
            out << "      \"t\": " << t << ",\n";
            out << "      \"sat\": {\"lat\": " << sat_lat << ", \"lon\": " << sat_lon
                << ", \"alt\": " << sat.altitude_km * 1000.0 << "},\n";
            out << "      \"sat_eci\": [" << sv.position.x << ", " << sv.position.y
                << ", " << sv.position.z << "],\n";

            out << "      \"age\": [";
            for (size_t i = 0; i < grid.size(); i++) {
                double age = (grid[i].lastSeen < 0) ? -1.0 : (t - grid[i].lastSeen);
                out << std::setprecision(1) << age;
                if (i < grid.size() - 1) out << ",";
            }
            out << "]\n";

            frames_written++;
            out << "    }";
            if (step + output_interval < num_sim_steps) out << ",";
            out << "\n";
        }

        if ((step + 1) % 500 == 0 || step == num_sim_steps - 1) {
            std::cout << "\rStep " << (step + 1) << "/" << num_sim_steps << std::flush;
        }
    }

    out << "  ]\n";
    out << "}\n";
    out.close();

    auto end_time = std::chrono::high_resolution_clock::now();
    auto total_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time).count();

    std::cout << "\n\nCompleted in " << total_ms << " ms\n";
    std::cout << "Output: visualization/cesium/sensor_revisit_data.json\n";

    return 0;
}
