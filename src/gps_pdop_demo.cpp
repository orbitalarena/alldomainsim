/**
 * GPS PDOP (Position Dilution of Precision) Grid Calculator
 *
 * Computes PDOP across a global grid based on GPS satellite geometry.
 * Outputs time-varying PDOP data for Cesium visualization.
 */

#include "io/tle_parser.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "coordinate/time_utils.hpp"
#include <fstream>
#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include <chrono>

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;

// Structure for ground grid point
struct GridPoint {
    double lat;       // degrees
    double lon;       // degrees
    double alt;       // meters (0 for ground)
    Vec3 ecef;        // ECEF position
};

// Structure for PDOP result at a grid point
struct PDOPResult {
    double pdop;
    double hdop;
    double vdop;
    int numSats;      // Number of visible satellites
};

// GPS satellite with orbital elements for propagation
struct GPSSatellite {
    std::string name;
    OrbitalElements elements;
    double mean_motion;  // rad/s
    double initial_mean_anomaly;  // rad (at epoch)
};

// Convert lat/lon/alt to ECEF
Vec3 lla_to_ecef(double lat_deg, double lon_deg, double alt_m) {
    const double a = 6378137.0;           // WGS84 semi-major axis
    const double e2 = 0.00669437999014;   // WGS84 eccentricity squared

    double lat = lat_deg * DEG_TO_RAD;
    double lon = lon_deg * DEG_TO_RAD;

    double sin_lat = std::sin(lat);
    double cos_lat = std::cos(lat);
    double sin_lon = std::sin(lon);
    double cos_lon = std::cos(lon);

    double N = a / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    Vec3 ecef;
    ecef.x = (N + alt_m) * cos_lat * cos_lon;
    ecef.y = (N + alt_m) * cos_lat * sin_lon;
    ecef.z = (N * (1.0 - e2) + alt_m) * sin_lat;

    return ecef;
}

// Convert TLE to orbital elements (like export_all_sats.cpp)
OrbitalElements tle_to_elements(const TLE& tle) {
    OrbitalElements elem;
    double n = tle.mean_motion * 2.0 * PI / 86400.0;  // rev/day to rad/s
    double mu = GravityModel::EARTH_MU;
    elem.semi_major_axis = std::pow(mu / (n * n), 1.0/3.0);
    elem.eccentricity = tle.eccentricity;
    elem.inclination = tle.inclination * DEG_TO_RAD;
    elem.raan = tle.raan * DEG_TO_RAD;
    elem.arg_periapsis = tle.arg_perigee * DEG_TO_RAD;
    elem.mean_anomaly = tle.mean_anomaly * DEG_TO_RAD;

    // Convert mean anomaly to true anomaly via eccentric anomaly
    double M = tle.mean_anomaly * DEG_TO_RAD;
    double e = tle.eccentricity;
    double E = M;
    for (int i = 0; i < 10; i++) {
        E = M + e * std::sin(E);
    }
    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );
    elem.true_anomaly = nu;
    return elem;
}

// Propagate satellite forward in time
StateVector propagate_satellite(const GPSSatellite& sat, double dt_seconds) {
    // Update mean anomaly
    double new_M = sat.initial_mean_anomaly + sat.mean_motion * dt_seconds;

    // Normalize to [0, 2*PI]
    while (new_M > 2.0 * PI) new_M -= 2.0 * PI;
    while (new_M < 0) new_M += 2.0 * PI;

    // Convert mean anomaly to true anomaly
    double e = sat.elements.eccentricity;
    double E = new_M;
    for (int i = 0; i < 10; i++) {
        E = new_M + e * std::sin(E);
    }
    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );

    // Create updated elements
    OrbitalElements prop_elem = sat.elements;
    prop_elem.true_anomaly = nu;

    // Convert to state vector
    return OrbitalMechanics::elements_to_state(prop_elem, GravityModel::EARTH_MU);
}

// Compute elevation angle from ground point to satellite
double compute_elevation(const Vec3& ground_ecef, const Vec3& sat_eci,
                         double lat_deg, double lon_deg) {
    // For simplicity, treat ECI as ECEF (valid for short time periods)
    // Vector from ground to satellite
    Vec3 los;
    los.x = sat_eci.x - ground_ecef.x;
    los.y = sat_eci.y - ground_ecef.y;
    los.z = sat_eci.z - ground_ecef.z;

    double range = los.norm();
    if (range < 1.0) return -90.0;

    // Local up vector (radial from Earth center)
    Vec3 up;
    up.x = ground_ecef.x;
    up.y = ground_ecef.y;
    up.z = ground_ecef.z;
    double up_mag = up.norm();
    up.x /= up_mag;
    up.y /= up_mag;
    up.z /= up_mag;

    // Elevation = 90 - angle between LOS and up
    double dot = (los.x * up.x + los.y * up.y + los.z * up.z) / range;
    double elevation = std::asin(std::min(1.0, std::max(-1.0, dot))) * RAD_TO_DEG;

    return elevation;
}

// Simple 4x4 matrix inversion for DOP calculation
bool invert4x4(double A[4][4], double Ainv[4][4]) {
    // Using cofactor expansion
    double adj[4][4];

    // Calculate cofactors
    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) {
            // 3x3 minor
            double m[3][3];
            int mi = 0;
            for (int k = 0; k < 4; k++) {
                if (k == i) continue;
                int mj = 0;
                for (int l = 0; l < 4; l++) {
                    if (l == j) continue;
                    m[mi][mj] = A[k][l];
                    mj++;
                }
                mi++;
            }
            // Determinant of 3x3
            double det3 = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

            adj[j][i] = ((i + j) % 2 == 0 ? 1 : -1) * det3;
        }
    }

    // Calculate determinant
    double det = A[0][0] * adj[0][0] + A[0][1] * adj[1][0] +
                 A[0][2] * adj[2][0] + A[0][3] * adj[3][0];

    if (std::abs(det) < 1e-10) return false;

    for (int i = 0; i < 4; i++) {
        for (int j = 0; j < 4; j++) {
            Ainv[i][j] = adj[i][j] / det;
        }
    }

    return true;
}

// Calculate PDOP for a ground point given visible satellites
PDOPResult calculate_pdop(const Vec3& ground_ecef, double lat, double lon,
                          const std::vector<Vec3>& sat_positions,
                          double min_elevation = 5.0) {
    PDOPResult result = {99.9, 99.9, 99.9, 0};

    // Find visible satellites and build geometry matrix
    std::vector<Vec3> unit_vectors;

    for (const auto& sat_pos : sat_positions) {
        double elev = compute_elevation(ground_ecef, sat_pos, lat, lon);
        if (elev >= min_elevation) {
            // Unit vector from receiver to satellite
            Vec3 los;
            los.x = sat_pos.x - ground_ecef.x;
            los.y = sat_pos.y - ground_ecef.y;
            los.z = sat_pos.z - ground_ecef.z;
            double range = los.norm();
            los.x /= range;
            los.y /= range;
            los.z /= range;
            unit_vectors.push_back(los);
        }
    }

    result.numSats = unit_vectors.size();

    // Need at least 4 satellites for 3D position + time
    if (result.numSats < 4) {
        return result;
    }

    // Build A^T * A matrix (4x4)
    double ATA[4][4] = {{0}};

    for (const auto& u : unit_vectors) {
        // Row of A is [ux, uy, uz, 1]
        double row[4] = {u.x, u.y, u.z, 1.0};

        for (int i = 0; i < 4; i++) {
            for (int j = 0; j < 4; j++) {
                ATA[i][j] += row[i] * row[j];
            }
        }
    }

    // Invert to get Q = (A^T * A)^-1
    double Q[4][4];
    if (!invert4x4(ATA, Q)) {
        return result;
    }

    // PDOP = sqrt(Qxx + Qyy + Qzz)
    // HDOP = sqrt(Qxx + Qyy) - simplified, should transform to local coords
    // VDOP = sqrt(Qzz) - simplified
    result.pdop = std::sqrt(Q[0][0] + Q[1][1] + Q[2][2]);
    result.hdop = std::sqrt(Q[0][0] + Q[1][1]);
    result.vdop = std::sqrt(Q[2][2]);

    // Clamp to reasonable values
    if (result.pdop > 99.9) result.pdop = 99.9;
    if (result.hdop > 99.9) result.hdop = 99.9;
    if (result.vdop > 99.9) result.vdop = 99.9;

    return result;
}

int main(int argc, char* argv[]) {
    // Configuration
    double grid_size_km = 200.0;  // Grid cell size in km
    double sim_duration_hours = 2.0;
    double time_step_minutes = 5.0;

    if (argc > 1) {
        grid_size_km = std::atof(argv[1]);
    }
    if (argc > 2) {
        sim_duration_hours = std::atof(argv[2]);
    }

    std::cout << "GPS PDOP Calculator\n";
    std::cout << "Grid size: " << grid_size_km << " km\n";
    std::cout << "Duration: " << sim_duration_hours << " hours\n";

    // Load GPS TLEs
    std::string tle_file = "data/tles/gps.txt";
    std::vector<TLE> tles = TLEParser::parse_file(tle_file);
    std::cout << "Loaded " << tles.size() << " GPS satellites\n";

    if (tles.empty()) {
        std::cerr << "No TLEs loaded!\n";
        return 1;
    }

    // Create GPS satellites with propagation data
    std::vector<GPSSatellite> satellites;
    for (const auto& tle : tles) {
        GPSSatellite sat;
        sat.name = tle.name;
        sat.elements = tle_to_elements(tle);
        sat.mean_motion = tle.mean_motion * 2.0 * PI / 86400.0;  // rad/s
        sat.initial_mean_anomaly = tle.mean_anomaly * DEG_TO_RAD;
        satellites.push_back(sat);
    }

    // Create ground grid
    // Grid spacing in degrees (approximate)
    double lat_spacing = grid_size_km / 111.0;  // ~111 km per degree latitude
    double lon_spacing_equator = grid_size_km / 111.0;

    std::vector<GridPoint> grid_points;

    for (double lat = -90.0; lat <= 90.0; lat += lat_spacing) {
        // Adjust longitude spacing for latitude
        double lon_spacing = lon_spacing_equator / std::max(0.1, std::cos(lat * DEG_TO_RAD));
        lon_spacing = std::min(lon_spacing, 30.0);  // Cap at 30 degrees

        for (double lon = -180.0; lon < 180.0; lon += lon_spacing) {
            GridPoint gp;
            gp.lat = lat;
            gp.lon = lon;
            gp.alt = 0.0;
            gp.ecef = lla_to_ecef(lat, lon, 0.0);
            grid_points.push_back(gp);
        }
    }

    std::cout << "Created " << grid_points.size() << " grid points\n";

    // Time parameters
    int num_steps = static_cast<int>(sim_duration_hours * 60.0 / time_step_minutes) + 1;
    double dt_seconds = time_step_minutes * 60.0;

    std::cout << "Computing PDOP for " << num_steps << " time steps...\n";

    // Open output file
    std::ofstream out("visualization/cesium/gps_pdop_data.json");
    out << std::fixed << std::setprecision(4);

    out << "{\n";
    out << "  \"metadata\": {\n";
    out << "    \"grid_size_km\": " << grid_size_km << ",\n";
    out << "    \"num_satellites\": " << satellites.size() << ",\n";
    out << "    \"num_grid_points\": " << grid_points.size() << ",\n";
    out << "    \"num_time_steps\": " << num_steps << ",\n";
    out << "    \"time_step_minutes\": " << time_step_minutes << ",\n";
    out << "    \"duration_hours\": " << sim_duration_hours << "\n";
    out << "  },\n";

    // Output grid points
    out << "  \"grid\": [\n";
    for (size_t i = 0; i < grid_points.size(); i++) {
        out << "    {\"lat\": " << grid_points[i].lat
            << ", \"lon\": " << grid_points[i].lon << "}";
        if (i < grid_points.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ],\n";

    // Output satellite names
    out << "  \"satellites\": [\n";
    for (size_t i = 0; i < satellites.size(); i++) {
        out << "    \"" << satellites[i].name << "\"";
        if (i < satellites.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ],\n";

    // Output time-varying PDOP data and satellite positions
    out << "  \"pdop_data\": [\n";

    auto start_time = std::chrono::high_resolution_clock::now();

    for (int step = 0; step < num_steps; step++) {
        double t = step * dt_seconds;

        // Propagate all satellites
        std::vector<Vec3> sat_positions;
        for (const auto& sat : satellites) {
            StateVector sv = propagate_satellite(sat, t);
            sat_positions.push_back(sv.position);
        }

        // Compute PDOP for each grid point
        out << "    {\"t\": " << t << ", \"pdop\": [";

        for (size_t i = 0; i < grid_points.size(); i++) {
            PDOPResult result = calculate_pdop(
                grid_points[i].ecef,
                grid_points[i].lat,
                grid_points[i].lon,
                sat_positions
            );

            out << result.pdop;
            if (i < grid_points.size() - 1) out << ", ";
        }

        // Also output satellite positions (ECI, in km for readability)
        out << "], \"sat_pos\": [";
        for (size_t i = 0; i < sat_positions.size(); i++) {
            out << "[" << sat_positions[i].x / 1000.0 << ", "
                << sat_positions[i].y / 1000.0 << ", "
                << sat_positions[i].z / 1000.0 << "]";
            if (i < sat_positions.size() - 1) out << ", ";
        }

        out << "]}";
        if (step < num_steps - 1) out << ",";
        out << "\n";

        // Progress update
        if ((step + 1) % 5 == 0 || step == num_steps - 1) {
            auto now = std::chrono::high_resolution_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - start_time).count();
            double progress = (step + 1) * 100.0 / num_steps;
            std::cout << "\rStep " << (step + 1) << "/" << num_steps
                      << " (" << std::fixed << std::setprecision(1) << progress << "%) "
                      << elapsed << " ms" << std::flush;
        }
    }

    out << "  ]\n";
    out << "}\n";
    out.close();

    auto end_time = std::chrono::high_resolution_clock::now();
    auto total_ms = std::chrono::duration_cast<std::chrono::milliseconds>(end_time - start_time).count();

    std::cout << "\n\nCompleted in " << total_ms << " ms\n";
    std::cout << "Output: visualization/cesium/gps_pdop_data.json\n";

    return 0;
}
