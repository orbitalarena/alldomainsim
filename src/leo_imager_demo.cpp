/**
 * LEO Imaging Satellite Constellation Demo
 *
 * Generates 40 sun-synchronous orbit imaging satellites with camera sensors.
 * Each satellite has a downward-pointing wide-angle camera.
 */

#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <random>
#include <iomanip>
#include <sstream>

#include "core/state_vector.hpp"
#include "physics/gravity_model.hpp"

using namespace sim;

const double PI = 3.14159265358979323846;
const double DEG_TO_RAD = PI / 180.0;
const double RAD_TO_DEG = 180.0 / PI;
const double MU = 3.986004418e14;  // Earth GM (m^3/s^2)
const double RE = 6378137.0;       // Earth radius (m)
const double J2 = 1.08263e-3;      // J2 coefficient

struct ImagingSatellite {
    int id;
    std::string name;
    double altitude_km;      // Orbital altitude
    double inclination_deg;  // Orbital inclination (sun-sync ~97-99)
    double raan_deg;         // Right ascension of ascending node
    double arg_lat_deg;      // Argument of latitude (position in orbit)
    double fov_deg;          // Camera field of view (full angle)
    double swath_km;         // Ground swath width
    StateVector state;       // Current ECI state
    std::vector<StateVector> trajectory;
};

// Compute sun-synchronous inclination for given altitude
double compute_sunsync_inclination(double alt_km) {
    // For sun-sync: dRAAN/dt = 360 deg/year = 1.991e-7 rad/s
    // dRAAN/dt = -1.5 * n * J2 * (RE/a)^2 * cos(i)
    // Solving for i:
    double a = (RE + alt_km * 1000.0);
    double n = std::sqrt(MU / (a * a * a));
    double target_rate = 2.0 * PI / (365.25 * 86400.0);  // rad/s

    double cos_i = -target_rate / (1.5 * n * J2 * std::pow(RE / a, 2));
    cos_i = std::max(-1.0, std::min(1.0, cos_i));  // Clamp

    return std::acos(cos_i) * RAD_TO_DEG;
}

// Compute ground swath from altitude and FOV
double compute_swath(double alt_km, double fov_deg) {
    // Simple approximation: swath = 2 * alt * tan(fov/2)
    double alt_m = alt_km * 1000.0;
    double half_fov_rad = (fov_deg / 2.0) * DEG_TO_RAD;
    return 2.0 * alt_m * std::tan(half_fov_rad) / 1000.0;  // km
}

// Initialize satellite state from orbital elements
StateVector elements_to_state(double alt_km, double inc_deg, double raan_deg, double arg_lat_deg) {
    double a = RE + alt_km * 1000.0;
    double inc = inc_deg * DEG_TO_RAD;
    double raan = raan_deg * DEG_TO_RAD;
    double u = arg_lat_deg * DEG_TO_RAD;  // Argument of latitude

    // Circular orbit: e = 0, so arg_lat = true_anomaly + arg_perigee
    double r = a;  // Circular orbit
    double v = std::sqrt(MU / a);  // Circular velocity

    // Position in orbital plane
    double x_orb = r * std::cos(u);
    double y_orb = r * std::sin(u);

    // Velocity in orbital plane (perpendicular to position for circular)
    double vx_orb = -v * std::sin(u);
    double vy_orb = v * std::cos(u);

    // Rotate to ECI
    StateVector state;

    // Position
    state.position.x = x_orb * (std::cos(raan) * std::cos(u) - std::sin(raan) * std::sin(u) * std::cos(inc))
                     - y_orb * (std::cos(raan) * std::sin(u) + std::sin(raan) * std::cos(u) * std::cos(inc));
    state.position.y = x_orb * (std::sin(raan) * std::cos(u) + std::cos(raan) * std::sin(u) * std::cos(inc))
                     - y_orb * (std::sin(raan) * std::sin(u) - std::cos(raan) * std::cos(u) * std::cos(inc));
    state.position.z = x_orb * std::sin(u) * std::sin(inc) + y_orb * std::cos(u) * std::sin(inc);

    // Velocity (derived from orbital mechanics)
    double cos_raan = std::cos(raan);
    double sin_raan = std::sin(raan);
    double cos_inc = std::cos(inc);
    double sin_inc = std::sin(inc);
    double cos_u = std::cos(u);
    double sin_u = std::sin(u);

    state.velocity.x = vx_orb * (cos_raan * cos_u - sin_raan * sin_u * cos_inc)
                     + vy_orb * (-cos_raan * sin_u - sin_raan * cos_u * cos_inc);
    state.velocity.y = vx_orb * (sin_raan * cos_u + cos_raan * sin_u * cos_inc)
                     + vy_orb * (-sin_raan * sin_u + cos_raan * cos_u * cos_inc);
    state.velocity.z = vx_orb * sin_u * sin_inc + vy_orb * cos_u * sin_inc;

    return state;
}

// RK4 propagation step
void propagate_rk4(StateVector& state, double dt) {
    auto accel = [](const Vec3& pos) {
        double r = pos.norm();
        double r3 = r * r * r;
        double r5 = r3 * r * r;
        double z2 = pos.z * pos.z;

        Vec3 a;
        // Two-body
        a.x = -MU * pos.x / r3;
        a.y = -MU * pos.y / r3;
        a.z = -MU * pos.z / r3;

        // J2
        double j2_coeff = 1.5 * J2 * MU * RE * RE / r5;
        double z_factor = 5.0 * z2 / (r * r);
        a.x += j2_coeff * pos.x * (z_factor - 1.0);
        a.y += j2_coeff * pos.y * (z_factor - 1.0);
        a.z += j2_coeff * pos.z * (z_factor - 3.0);

        return a;
    };

    Vec3 p0 = state.position;
    Vec3 v0 = state.velocity;

    Vec3 a1 = accel(p0);
    Vec3 p1 = {p0.x + 0.5*dt*v0.x, p0.y + 0.5*dt*v0.y, p0.z + 0.5*dt*v0.z};
    Vec3 v1 = {v0.x + 0.5*dt*a1.x, v0.y + 0.5*dt*a1.y, v0.z + 0.5*dt*a1.z};

    Vec3 a2 = accel(p1);
    Vec3 p2 = {p0.x + 0.5*dt*v1.x, p0.y + 0.5*dt*v1.y, p0.z + 0.5*dt*v1.z};
    Vec3 v2 = {v0.x + 0.5*dt*a2.x, v0.y + 0.5*dt*a2.y, v0.z + 0.5*dt*a2.z};

    Vec3 a3 = accel(p2);
    Vec3 p3 = {p0.x + dt*v2.x, p0.y + dt*v2.y, p0.z + dt*v2.z};
    Vec3 v3 = {v0.x + dt*a3.x, v0.y + dt*a3.y, v0.z + dt*a3.z};

    Vec3 a4 = accel(p3);

    state.position.x = p0.x + (dt/6.0) * (v0.x + 2*v1.x + 2*v2.x + v3.x);
    state.position.y = p0.y + (dt/6.0) * (v0.y + 2*v1.y + 2*v2.y + v3.y);
    state.position.z = p0.z + (dt/6.0) * (v0.z + 2*v1.z + 2*v2.z + v3.z);

    state.velocity.x = v0.x + (dt/6.0) * (a1.x + 2*a2.x + 2*a3.x + a4.x);
    state.velocity.y = v0.y + (dt/6.0) * (a1.y + 2*a2.y + 2*a3.y + a4.y);
    state.velocity.z = v0.z + (dt/6.0) * (a1.z + 2*a2.z + 2*a3.z + a4.z);
}

int main() {
    std::cout << "=== LEO Imaging Satellite Constellation ===\n\n";

    std::mt19937 rng(42);  // Fixed seed for reproducibility
    std::uniform_real_distribution<double> alt_dist(500.0, 800.0);    // km
    std::uniform_real_distribution<double> raan_dist(0.0, 360.0);     // deg
    std::uniform_real_distribution<double> arg_lat_dist(0.0, 360.0);  // deg
    std::uniform_real_distribution<double> fov_dist(30.0, 60.0);      // deg

    std::vector<ImagingSatellite> satellites;

    // Generate 40 satellites
    for (int i = 0; i < 40; i++) {
        ImagingSatellite sat;
        sat.id = i;

        std::ostringstream name;
        name << "IMAGER-" << std::setfill('0') << std::setw(2) << (i + 1);
        sat.name = name.str();

        sat.altitude_km = alt_dist(rng);
        sat.inclination_deg = compute_sunsync_inclination(sat.altitude_km);
        sat.raan_deg = raan_dist(rng);
        sat.arg_lat_deg = arg_lat_dist(rng);
        sat.fov_deg = fov_dist(rng);
        sat.swath_km = compute_swath(sat.altitude_km, sat.fov_deg);

        sat.state = elements_to_state(sat.altitude_km, sat.inclination_deg,
                                       sat.raan_deg, sat.arg_lat_deg);

        satellites.push_back(sat);

        std::cout << sat.name << ": Alt=" << std::fixed << std::setprecision(1)
                  << sat.altitude_km << "km, Inc=" << sat.inclination_deg
                  << "°, FOV=" << sat.fov_deg << "°, Swath=" << sat.swath_km << "km\n";
    }

    // Propagate for 2 hours with 30-second steps
    double duration = 2 * 3600;  // 2 hours
    double dt = 30.0;            // 30 second steps
    int steps = static_cast<int>(duration / dt);

    std::cout << "\nPropagating " << satellites.size() << " satellites for "
              << (duration/3600) << " hours...\n";

    for (auto& sat : satellites) {
        sat.trajectory.push_back(sat.state);

        StateVector state = sat.state;
        for (int step = 0; step < steps; step++) {
            propagate_rk4(state, dt);
            sat.trajectory.push_back(state);
        }
    }

    std::cout << "Propagation complete. " << satellites[0].trajectory.size()
              << " points per satellite.\n";

    // Export to JSON
    std::string filename = "visualization/cesium/leo_imagers_data.json";
    std::ofstream out(filename);

    out << "{\n";
    out << "  \"metadata\": {\n";
    out << "    \"description\": \"LEO Imaging Satellite Constellation\",\n";
    out << "    \"satellite_count\": " << satellites.size() << ",\n";
    out << "    \"duration_hours\": " << (duration / 3600) << ",\n";
    out << "    \"time_step_seconds\": " << dt << ",\n";
    out << "    \"points_per_satellite\": " << satellites[0].trajectory.size() << "\n";
    out << "  },\n";

    out << "  \"satellites\": [\n";
    for (size_t i = 0; i < satellites.size(); i++) {
        const auto& sat = satellites[i];
        out << "    {\n";
        out << "      \"id\": " << sat.id << ",\n";
        out << "      \"name\": \"" << sat.name << "\",\n";
        out << "      \"altitude_km\": " << std::fixed << std::setprecision(2) << sat.altitude_km << ",\n";
        out << "      \"inclination_deg\": " << sat.inclination_deg << ",\n";
        out << "      \"raan_deg\": " << sat.raan_deg << ",\n";
        out << "      \"fov_deg\": " << sat.fov_deg << ",\n";
        out << "      \"swath_km\": " << sat.swath_km << ",\n";
        out << "      \"trajectory\": [\n";

        for (size_t j = 0; j < sat.trajectory.size(); j++) {
            const auto& s = sat.trajectory[j];
            out << "        {\"t\": " << (j * dt)
                << ", \"x\": " << std::setprecision(1) << s.position.x
                << ", \"y\": " << s.position.y
                << ", \"z\": " << s.position.z << "}";
            if (j < sat.trajectory.size() - 1) out << ",";
            out << "\n";
        }

        out << "      ]\n";
        out << "    }";
        if (i < satellites.size() - 1) out << ",";
        out << "\n";
    }
    out << "  ]\n";
    out << "}\n";

    out.close();
    std::cout << "\nExported to " << filename << "\n";

    return 0;
}
