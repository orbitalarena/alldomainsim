/**
 * GPS PDOP Implementation
 */

#include "gps_pdop.hpp"
#include "physics/gravity_model.hpp"
#include "io/tle_parser.hpp"
#include <cmath>
#include <algorithm>

namespace sim {
namespace fom {

GPSPDOP::GPSPDOP(const FOMGrid& grid, const std::vector<GPSSatellite>& satellites,
                 double min_elevation_deg)
    : grid_(grid)
    , satellites_(satellites)
    , min_elevation_deg_(min_elevation_deg)
    , epoch_jd_(2460000.5)  // Default epoch ~2023
{
}

GPSPDOP GPSPDOP::from_tle_file(const FOMGrid& grid, const std::string& tle_file,
                                double min_elevation_deg) {
    auto tles = TLEParser::parse_file(tle_file);

    std::vector<GPSSatellite> satellites;
    for (const auto& tle : tles) {
        // Filter for GPS satellites (NAVSTAR, GPS, etc.)
        if (tle.name.find("GPS") != std::string::npos ||
            tle.name.find("NAVSTAR") != std::string::npos) {
            GPSSatellite sat;

            // Convert TLE to orbital elements
            // Mean motion is in revs/day, convert to semi-major axis
            double n_rad_per_sec = tle.mean_motion * 2.0 * PI / 86400.0;
            double mu = GravityModel::EARTH_MU;
            sat.elements.semi_major_axis = std::pow(mu / (n_rad_per_sec * n_rad_per_sec), 1.0/3.0);
            sat.elements.eccentricity = tle.eccentricity;
            sat.elements.inclination = tle.inclination * DEG_TO_RAD;
            sat.elements.raan = tle.raan * DEG_TO_RAD;
            sat.elements.arg_periapsis = tle.arg_perigee * DEG_TO_RAD;
            sat.elements.mean_anomaly = tle.mean_anomaly * DEG_TO_RAD;
            sat.elements.true_anomaly = sat.elements.mean_anomaly; // Approximate

            sat.prn = tle.name;
            satellites.push_back(sat);
        }
    }

    return GPSPDOP(grid, satellites, min_elevation_deg);
}

FOMMetadata GPSPDOP::get_metadata() const {
    FOMMetadata meta;
    meta.name = "GPS PDOP";
    meta.unit = "";
    meta.min_value = 1.0;
    meta.max_value = 10.0;
    meta.invalid_value = 99.0;
    meta.lower_is_better = true;
    return meta;
}

Vec3 GPSPDOP::get_satellite_ecef(const GPSSatellite& sat, double t) const {
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

    return ecef;
}

bool GPSPDOP::is_visible(const Vec3& sat_ecef, double ground_lat, double ground_lon) const {
    // Ground point in ECEF
    double lat_rad = ground_lat * DEG_TO_RAD;
    double lon_rad = ground_lon * DEG_TO_RAD;
    double Re = 6378137.0;

    Vec3 ground;
    ground.x = Re * std::cos(lat_rad) * std::cos(lon_rad);
    ground.y = Re * std::cos(lat_rad) * std::sin(lon_rad);
    ground.z = Re * std::sin(lat_rad);

    // Vector from ground to satellite
    Vec3 to_sat;
    to_sat.x = sat_ecef.x - ground.x;
    to_sat.y = sat_ecef.y - ground.y;
    to_sat.z = sat_ecef.z - ground.z;

    // Local up vector (radial from Earth center)
    double ground_r = ground.norm();
    Vec3 up;
    up.x = ground.x / ground_r;
    up.y = ground.y / ground_r;
    up.z = ground.z / ground_r;

    // Elevation angle
    double to_sat_r = to_sat.norm();
    double dot = (to_sat.x * up.x + to_sat.y * up.y + to_sat.z * up.z);
    double cos_zenith = dot / to_sat_r;
    double elevation = 90.0 - std::acos(cos_zenith) * RAD_TO_DEG;

    return elevation >= min_elevation_deg_;
}

double GPSPDOP::compute_pdop(double lat, double lon, double time,
                             const std::vector<Vec3>& sat_positions) const {
    // Collect visible satellites
    std::vector<Vec3> visible_sats;
    for (const auto& pos : sat_positions) {
        if (is_visible(pos, lat, lon)) {
            visible_sats.push_back(pos);
        }
    }

    // Need at least 4 satellites for PDOP
    if (visible_sats.size() < 4) {
        return 99.0;  // Invalid
    }

    // Ground point in ECEF
    double lat_rad = lat * DEG_TO_RAD;
    double lon_rad = lon * DEG_TO_RAD;
    double Re = 6378137.0;

    Vec3 ground;
    ground.x = Re * std::cos(lat_rad) * std::cos(lon_rad);
    ground.y = Re * std::cos(lat_rad) * std::sin(lon_rad);
    ground.z = Re * std::sin(lat_rad);

    // Build geometry matrix (H)
    // Each row: [dx/r, dy/r, dz/r, 1] where (dx,dy,dz) is unit vector to satellite
    size_t n = visible_sats.size();
    std::vector<double> H(n * 4);

    for (size_t i = 0; i < n; i++) {
        double dx = visible_sats[i].x - ground.x;
        double dy = visible_sats[i].y - ground.y;
        double dz = visible_sats[i].z - ground.z;
        double r = std::sqrt(dx*dx + dy*dy + dz*dz);

        H[i*4 + 0] = dx / r;
        H[i*4 + 1] = dy / r;
        H[i*4 + 2] = dz / r;
        H[i*4 + 3] = 1.0;
    }

    // Compute (H'H)^-1 for PDOP
    // G = H'H is 4x4
    double G[16] = {0};
    for (size_t i = 0; i < 4; i++) {
        for (size_t j = 0; j < 4; j++) {
            for (size_t k = 0; k < n; k++) {
                G[i*4 + j] += H[k*4 + i] * H[k*4 + j];
            }
        }
    }

    // Invert 4x4 matrix using Gauss-Jordan
    double inv[16];
    for (int i = 0; i < 16; i++) inv[i] = (i % 5 == 0) ? 1.0 : 0.0;
    double temp[16];
    for (int i = 0; i < 16; i++) temp[i] = G[i];

    for (int col = 0; col < 4; col++) {
        // Find pivot
        int pivot = col;
        for (int row = col + 1; row < 4; row++) {
            if (std::abs(temp[row*4 + col]) > std::abs(temp[pivot*4 + col])) {
                pivot = row;
            }
        }

        // Swap rows
        if (pivot != col) {
            for (int j = 0; j < 4; j++) {
                std::swap(temp[col*4 + j], temp[pivot*4 + j]);
                std::swap(inv[col*4 + j], inv[pivot*4 + j]);
            }
        }

        double diag = temp[col*4 + col];
        if (std::abs(diag) < 1e-10) {
            return 99.0;  // Singular matrix
        }

        // Scale row
        for (int j = 0; j < 4; j++) {
            temp[col*4 + j] /= diag;
            inv[col*4 + j] /= diag;
        }

        // Eliminate column
        for (int row = 0; row < 4; row++) {
            if (row != col) {
                double factor = temp[row*4 + col];
                for (int j = 0; j < 4; j++) {
                    temp[row*4 + j] -= factor * temp[col*4 + j];
                    inv[row*4 + j] -= factor * inv[col*4 + j];
                }
            }
        }
    }

    // PDOP = sqrt(trace of position part of inverse)
    // Position is first 3 diagonal elements
    double pdop = std::sqrt(inv[0] + inv[5] + inv[10]);

    return std::min(pdop, 99.0);
}

std::vector<double> GPSPDOP::compute(double time) {
    std::vector<double> values(grid_.size(), 99.0);

    // Pre-compute all satellite positions
    std::vector<Vec3> sat_positions(satellites_.size());
    for (size_t i = 0; i < satellites_.size(); i++) {
        sat_positions[i] = get_satellite_ecef(satellites_[i], time);
    }

    // Compute PDOP for each grid cell
    for (const auto& cell : grid_.cells()) {
        values[cell.index] = compute_pdop(cell.lat, cell.lon, time, sat_positions);
    }

    return values;
}

} // namespace fom
} // namespace sim
