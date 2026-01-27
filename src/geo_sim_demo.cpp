/**
 * GEO Interactive Simulation Demo
 *
 * Two modes:
 *   --model: Pre-computed trajectories (generates geo_sim_data.json)
 *   --sim:   Initial conditions for interactive JS simulation (generates geo_sim_initial.json)
 */

#include <iostream>
#include <fstream>
#include <cmath>
#include <vector>
#include <iomanip>
#include <string>

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "propagators/rk4_integrator.hpp"

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;

// GEO parameters
constexpr double GEO_RADIUS = 42164.0e3;  // meters from Earth center
constexpr double EARTH_MU = 3.986004418e14;  // m^3/s^2

// Compute GEO orbital velocity
double compute_geo_velocity() {
    return std::sqrt(EARTH_MU / GEO_RADIUS);
}

// Compute GEO mean motion
double compute_geo_mean_motion() {
    return std::sqrt(EARTH_MU / std::pow(GEO_RADIUS, 3));
}

struct SatelliteState {
    std::string name;
    StateVector state;
    std::vector<StateVector> trajectory;
};

// RIC frame computation
struct RICFrame {
    Vec3 R, I, C;
};

RICFrame compute_ric_frame(const StateVector& state) {
    RICFrame ric;

    double r_mag = state.position.norm();
    ric.R.x = state.position.x / r_mag;
    ric.R.y = state.position.y / r_mag;
    ric.R.z = state.position.z / r_mag;

    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();
    ric.C.x = h.x / h_mag;
    ric.C.y = h.y / h_mag;
    ric.C.z = h.z / h_mag;

    ric.I.x = ric.C.y * ric.R.z - ric.C.z * ric.R.y;
    ric.I.y = ric.C.z * ric.R.x - ric.C.x * ric.R.z;
    ric.I.z = ric.C.x * ric.R.y - ric.C.y * ric.R.x;

    return ric;
}

Vec3 compute_ric_position(const StateVector& chase, const StateVector& target) {
    Vec3 rel_eci;
    rel_eci.x = chase.position.x - target.position.x;
    rel_eci.y = chase.position.y - target.position.y;
    rel_eci.z = chase.position.z - target.position.z;

    RICFrame ric = compute_ric_frame(target);

    Vec3 rel_ric;
    rel_ric.x = rel_eci.x * ric.R.x + rel_eci.y * ric.R.y + rel_eci.z * ric.R.z;
    rel_ric.y = rel_eci.x * ric.I.x + rel_eci.y * ric.I.y + rel_eci.z * ric.I.z;
    rel_ric.z = rel_eci.x * ric.C.x + rel_eci.y * ric.C.y + rel_eci.z * ric.C.z;

    return rel_ric;
}

void export_initial_state(const std::string& filename, double separation_deg) {
    std::cout << "=== Exporting Initial State for Interactive Simulation ===" << std::endl;

    double n_geo = compute_geo_mean_motion();
    double v_geo = compute_geo_velocity();

    // Chase satellite at 0 degrees longitude
    OrbitalElements chase_elements;
    chase_elements.semi_major_axis = GEO_RADIUS;
    chase_elements.eccentricity = 0.0;
    chase_elements.inclination = 0.0;
    chase_elements.raan = 0.0;
    chase_elements.arg_periapsis = 0.0;
    chase_elements.true_anomaly = 0.0;

    // Target satellite ahead by separation_deg
    OrbitalElements target_elements = chase_elements;
    target_elements.true_anomaly = separation_deg * DEG_TO_RAD;

    StateVector chase_state = OrbitalMechanics::elements_to_state(chase_elements, EARTH_MU);
    StateVector target_state = OrbitalMechanics::elements_to_state(target_elements, EARTH_MU);

    // Compute initial RIC for reference
    Vec3 ric_pos = compute_ric_position(chase_state, target_state);
    double range = std::sqrt(ric_pos.x*ric_pos.x + ric_pos.y*ric_pos.y + ric_pos.z*ric_pos.z);

    std::cout << "Initial separation: " << separation_deg << " degrees" << std::endl;
    std::cout << "Initial range: " << range/1000.0 << " km" << std::endl;
    std::cout << "Initial RIC: R=" << ric_pos.x/1000.0 << " km, I=" << ric_pos.y/1000.0
              << " km, C=" << ric_pos.z/1000.0 << " km" << std::endl;

    // Export JSON
    std::ofstream file(filename);
    file << std::fixed << std::setprecision(10);

    file << "{\n";
    file << "  \"mode\": \"sim\",\n";
    file << "  \"metadata\": {\n";
    file << "    \"scenario\": \"GEO Interactive Simulation\",\n";
    file << "    \"geo_radius_m\": " << GEO_RADIUS << ",\n";
    file << "    \"geo_mean_motion\": " << n_geo << ",\n";
    file << "    \"geo_velocity_ms\": " << v_geo << ",\n";
    file << "    \"duration_days\": 7,\n";
    file << "    \"separation_deg\": " << separation_deg << ",\n";
    file << "    \"earth_mu\": " << EARTH_MU << "\n";
    file << "  },\n";

    file << "  \"chase\": {\n";
    file << "    \"name\": \"Chase\",\n";
    file << "    \"position_eci_m\": [" << chase_state.position.x << ", "
         << chase_state.position.y << ", " << chase_state.position.z << "],\n";
    file << "    \"velocity_eci_ms\": [" << chase_state.velocity.x << ", "
         << chase_state.velocity.y << ", " << chase_state.velocity.z << "],\n";
    file << "    \"model\": \"models/webb.glb\",\n";
    file << "    \"color\": \"#00FF00\"\n";
    file << "  },\n";

    file << "  \"target\": {\n";
    file << "    \"name\": \"Target\",\n";
    file << "    \"position_eci_m\": [" << target_state.position.x << ", "
         << target_state.position.y << ", " << target_state.position.z << "],\n";
    file << "    \"velocity_eci_ms\": [" << target_state.velocity.x << ", "
         << target_state.velocity.y << ", " << target_state.velocity.z << "],\n";
    file << "    \"model\": \"models/webb.glb\",\n";
    file << "    \"color\": \"#FF0000\"\n";
    file << "  },\n";

    file << "  \"burn_budget_ms\": 50.0,\n";
    file << "  \"initial_ric\": {\n";
    file << "    \"R_m\": " << ric_pos.x << ",\n";
    file << "    \"I_m\": " << ric_pos.y << ",\n";
    file << "    \"C_m\": " << ric_pos.z << ",\n";
    file << "    \"range_m\": " << range << "\n";
    file << "  }\n";
    file << "}\n";

    file.close();
    std::cout << "\nExported to: " << filename << std::endl;
}

void run_full_simulation(const std::string& filename, double separation_deg) {
    std::cout << "=== Running Full Pre-computed Simulation ===" << std::endl;

    double n_geo = compute_geo_mean_motion();

    // Create satellites
    OrbitalElements chase_elements;
    chase_elements.semi_major_axis = GEO_RADIUS;
    chase_elements.eccentricity = 0.0;
    chase_elements.inclination = 0.0;
    chase_elements.raan = 0.0;
    chase_elements.arg_periapsis = 0.0;
    chase_elements.true_anomaly = 0.0;

    OrbitalElements target_elements = chase_elements;
    target_elements.true_anomaly = separation_deg * DEG_TO_RAD;

    SatelliteState chase, target;
    chase.name = "Chase";
    chase.state = OrbitalMechanics::elements_to_state(chase_elements, EARTH_MU);
    chase.state.time = 0.0;

    target.name = "Target";
    target.state = OrbitalMechanics::elements_to_state(target_elements, EARTH_MU);
    target.state.time = 0.0;

    // Simulate for 7 days
    double total_duration = 7.0 * 24.0 * 3600.0;
    double dt = 60.0;
    double record_interval = 300.0;

    chase.trajectory.push_back(chase.state);
    target.trajectory.push_back(target.state);

    struct RICData {
        double time;
        double range;
        double R, I, C;
    };
    std::vector<RICData> ric_history;

    Vec3 ric0 = compute_ric_position(chase.state, target.state);
    double range0 = std::sqrt(ric0.x*ric0.x + ric0.y*ric0.y + ric0.z*ric0.z);
    ric_history.push_back({0.0, range0, ric0.x, ric0.y, ric0.z});

    double last_record_time = 0.0;

    auto deriv_func = [](const StateVector& s) {
        return GravityModel::compute_derivatives(s, false);
    };

    std::cout << "Simulating " << total_duration/3600.0 << " hours..." << std::endl;

    for (double t = dt; t <= total_duration; t += dt) {
        chase.state = RK4Integrator::step(chase.state, dt, deriv_func);
        chase.state.time = t;

        target.state = RK4Integrator::step(target.state, dt, deriv_func);
        target.state.time = t;

        if (t - last_record_time >= record_interval) {
            chase.trajectory.push_back(chase.state);
            target.trajectory.push_back(target.state);

            Vec3 ric = compute_ric_position(chase.state, target.state);
            double range = std::sqrt(ric.x*ric.x + ric.y*ric.y + ric.z*ric.z);
            ric_history.push_back({t, range, ric.x, ric.y, ric.z});

            last_record_time = t;

            // Progress every 24h
            if (std::fmod(t, 24.0 * 3600.0) < record_interval) {
                std::cout << "T+" << t/3600.0 << "h (Day " << t/(24.0*3600.0) << ")" << std::endl;
            }
        }
    }

    // Export JSON
    std::ofstream file(filename);
    file << std::fixed << std::setprecision(6);

    file << "{\n";
    file << "  \"mode\": \"model\",\n";
    file << "  \"metadata\": {\n";
    file << "    \"scenario\": \"GEO Pre-computed Simulation\",\n";
    file << "    \"geo_radius_m\": " << GEO_RADIUS << ",\n";
    file << "    \"geo_mean_motion\": " << n_geo << ",\n";
    file << "    \"duration_days\": 7,\n";
    file << "    \"separation_deg\": " << separation_deg << ",\n";
    file << "    \"time_step_seconds\": " << record_interval << "\n";
    file << "  },\n";

    file << "  \"ric_history\": [\n";
    for (size_t i = 0; i < ric_history.size(); i++) {
        file << "    {\"time\": " << ric_history[i].time
             << ", \"range\": " << ric_history[i].range
             << ", \"R\": " << ric_history[i].R
             << ", \"I\": " << ric_history[i].I
             << ", \"C\": " << ric_history[i].C << "}";
        if (i < ric_history.size() - 1) file << ",";
        file << "\n";
    }
    file << "  ],\n";

    file << "  \"satellites\": [\n";

    // Chase
    file << "    {\"name\": \"" << chase.name << "\", \"color\": \"#00FF00\", \"model\": \"models/webb.glb\", \"positions\": [\n";
    for (size_t i = 0; i < chase.trajectory.size(); i++) {
        file << "      {\"time\": " << chase.trajectory[i].time
             << ", \"x\": " << chase.trajectory[i].position.x
             << ", \"y\": " << chase.trajectory[i].position.y
             << ", \"z\": " << chase.trajectory[i].position.z << "}";
        if (i < chase.trajectory.size() - 1) file << ",";
        file << "\n";
    }
    file << "    ]},\n";

    // Target
    file << "    {\"name\": \"" << target.name << "\", \"color\": \"#FF0000\", \"model\": \"models/webb.glb\", \"positions\": [\n";
    for (size_t i = 0; i < target.trajectory.size(); i++) {
        file << "      {\"time\": " << target.trajectory[i].time
             << ", \"x\": " << target.trajectory[i].position.x
             << ", \"y\": " << target.trajectory[i].position.y
             << ", \"z\": " << target.trajectory[i].position.z << "}";
        if (i < target.trajectory.size() - 1) file << ",";
        file << "\n";
    }
    file << "    ]}\n";

    file << "  ]\n";
    file << "}\n";

    file.close();
    std::cout << "\nExported to: " << filename << std::endl;
    std::cout << "Data points per satellite: " << chase.trajectory.size() << std::endl;
}

void print_usage(const char* prog_name) {
    std::cout << "Usage: " << prog_name << " [--sim|--model] [separation_deg]" << std::endl;
    std::cout << std::endl;
    std::cout << "Modes:" << std::endl;
    std::cout << "  --sim    Export initial conditions for interactive JS simulation" << std::endl;
    std::cout << "           (default, generates geo_sim_initial.json)" << std::endl;
    std::cout << "  --model  Run full pre-computed simulation" << std::endl;
    std::cout << "           (generates geo_sim_data.json)" << std::endl;
    std::cout << std::endl;
    std::cout << "Options:" << std::endl;
    std::cout << "  separation_deg  Initial angular separation (default: 1.0)" << std::endl;
}

int main(int argc, char* argv[]) {
    bool sim_mode = true;  // Default to sim mode
    double separation_deg = 1.0;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--sim") {
            sim_mode = true;
        } else if (arg == "--model") {
            sim_mode = false;
        } else if (arg == "--help" || arg == "-h") {
            print_usage(argv[0]);
            return 0;
        } else {
            try {
                separation_deg = std::stod(arg);
                if (separation_deg <= 0 || separation_deg > 10) {
                    std::cerr << "Error: Separation must be between 0 and 10 degrees" << std::endl;
                    return 1;
                }
            } catch (...) {
                std::cerr << "Error: Invalid argument: " << arg << std::endl;
                print_usage(argv[0]);
                return 1;
            }
        }
    }

    std::cout << "=== GEO Interactive Simulation Demo ===" << std::endl;
    std::cout << "Mode: " << (sim_mode ? "Interactive (--sim)" : "Pre-computed (--model)") << std::endl;
    std::cout << "Separation: " << separation_deg << " degrees" << std::endl;
    std::cout << std::endl;

    double n_geo = compute_geo_mean_motion();
    double v_geo = compute_geo_velocity();
    double period = 2.0 * PI / n_geo;

    std::cout << "GEO Parameters:" << std::endl;
    std::cout << "  Radius: " << GEO_RADIUS / 1e3 << " km" << std::endl;
    std::cout << "  Velocity: " << v_geo << " m/s" << std::endl;
    std::cout << "  Mean motion: " << n_geo << " rad/s" << std::endl;
    std::cout << "  Period: " << period / 3600.0 << " hours" << std::endl;
    std::cout << std::endl;

    if (sim_mode) {
        export_initial_state("visualization/cesium/geo_sim_initial.json", separation_deg);
    } else {
        run_full_simulation("visualization/cesium/geo_sim_data.json", separation_deg);
    }

    std::cout << "\nTo visualize:" << std::endl;
    std::cout << "  cd visualization/cesium && python3 -m http.server 8080" << std::endl;
    std::cout << "  Open http://localhost:8080/geo_sim_viewer.html" << std::endl;

    return 0;
}
