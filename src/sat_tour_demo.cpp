#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <algorithm>
#include <cmath>
#include <iomanip>

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "physics/nonlinear_rendezvous.hpp"
#include "propagators/rk4_integrator.hpp"
#include "io/tle_parser.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;

struct SatTarget {
    std::string name;
    int norad_id;
    StateVector state;
    double distance;  // From current chase position
    bool visited;
    double longitude; // Geodetic longitude for GEO sorting
    double latitude;
    double altitude;
};

struct HopResult {
    int hop_number;
    std::string target_name;
    int norad_id;
    double tof_hours;
    double dv1_mag;      // Intercept burn
    double dv2_mag;      // Braking burn
    double total_dv;
    Vec3 dv1;
    Vec3 dv2;
    double range_at_intercept;
    bool converged;
    Vec3 target_position;  // Position at rendezvous (ECI)
    double rendezvous_time; // Time of rendezvous
    double target_lat;     // Geodetic latitude (degrees)
    double target_lon;     // Geodetic longitude (degrees)
    double target_alt;     // Altitude (meters)
};

// Convert TLE to orbital elements
OrbitalElements tle_to_elements(const TLE& tle) {
    OrbitalElements elem;

    // Mean motion is in rev/day, convert to rad/s
    double n = tle.mean_motion * 2.0 * PI / 86400.0;

    // Semi-major axis from mean motion: n = sqrt(mu/a^3)
    double mu = GravityModel::EARTH_MU;
    elem.semi_major_axis = std::pow(mu / (n * n), 1.0/3.0);

    elem.eccentricity = tle.eccentricity;
    elem.inclination = tle.inclination * DEG_TO_RAD;
    elem.raan = tle.raan * DEG_TO_RAD;
    elem.arg_periapsis = tle.arg_perigee * DEG_TO_RAD;

    // Convert mean anomaly to true anomaly (simplified for near-circular)
    double M = tle.mean_anomaly * DEG_TO_RAD;
    double e = tle.eccentricity;

    // Newton's method for eccentric anomaly
    double E = M;
    for (int i = 0; i < 10; i++) {
        E = M + e * std::sin(E);
    }

    // True anomaly from eccentric anomaly
    double nu = 2.0 * std::atan2(
        std::sqrt(1 + e) * std::sin(E / 2),
        std::sqrt(1 - e) * std::cos(E / 2)
    );
    elem.true_anomaly = nu;

    return elem;
}

// Propagate state forward in time
StateVector propagate_state(const StateVector& state, double dt) {
    StateVector s = state;
    double step = 60.0;
    double t = 0;

    auto deriv = [](const StateVector& st) {
        return GravityModel::compute_derivatives(st, false);
    };

    while (t < dt) {
        double h = std::min(step, dt - t);
        s = RK4Integrator::step(s, h, deriv);
        t += h;
    }
    s.time = state.time + dt;
    return s;
}

int main(int argc, char* argv[]) {
    std::string tle_file = "data/tles/satcat.txt";
    int num_targets = 30;
    double tof_hours = 4.33;

    std::cout << std::fixed << std::setprecision(4);
    std::cout << "=== Satellite Tour: 30 Target Rendezvous ===" << std::endl;
    std::cout << "TOF per hop: " << tof_hours << " hours" << std::endl;
    std::cout << "Loading TLEs from: " << tle_file << std::endl;

    // Load TLEs
    std::vector<TLE> tles = TLEParser::parse_file(tle_file);

    if (tles.empty()) {
        std::cerr << "Failed to load TLEs" << std::endl;
        return 1;
    }
    std::cout << "Loaded " << tles.size() << " satellites" << std::endl;

    // Get initial states for all satellites at epoch
    double mu = GravityModel::EARTH_MU;
    double jd_epoch = TimeUtils::J2000_EPOCH_JD;
    std::vector<SatTarget> targets;

    for (const auto& tle : tles) {
        SatTarget t;
        t.name = tle.name;
        t.norad_id = tle.satellite_number;

        // Convert TLE to state vector
        OrbitalElements elem = tle_to_elements(tle);
        t.state = OrbitalMechanics::elements_to_state(elem, mu);
        t.state.time = 0.0;

        // Compute geodetic coordinates for sorting
        GeodeticCoord geo = FrameTransformer::eci_to_geodetic(t.state.position, jd_epoch);
        t.longitude = geo.longitude;
        t.latitude = geo.latitude;
        t.altitude = geo.altitude;

        t.visited = false;
        t.distance = 0;
        targets.push_back(t);
    }

    // Sort all satellites by longitude
    std::sort(targets.begin(), targets.end(), [](const SatTarget& a, const SatTarget& b) {
        return a.longitude < b.longitude;
    });

    std::cout << "Satellites sorted by longitude" << std::endl;
    std::cout << "Longitude range: " << targets.front().longitude << " to " << targets.back().longitude << " degrees" << std::endl;

    // Find the densest cluster of 30 satellites (smallest longitude span)
    int best_start = 0;
    double min_span = 360.0;
    for (size_t i = 0; i + num_targets <= targets.size(); i++) {
        double span = targets[i + num_targets - 1].longitude - targets[i].longitude;
        if (span < min_span) {
            min_span = span;
            best_start = i;
        }
    }

    std::cout << "Best cluster starts at index " << best_start << " (" << targets[best_start].name << ")" << std::endl;
    std::cout << "Cluster spans " << min_span << " degrees of longitude" << std::endl;

    // Initialize chase at first satellite in the cluster
    StateVector chase_state = targets[best_start].state;
    std::string chase_start_name = targets[best_start].name;
    targets[best_start].visited = true;

    std::cout << "Starting position: " << chase_start_name << " at lon=" << targets[best_start].longitude << std::endl;

    // Track current longitude for nearest-neighbor in longitude
    double current_lon = targets[best_start].longitude;

    // Find closest unvisited target by longitude (within the cluster range)
    auto find_closest_by_longitude = [&]() -> SatTarget* {
        SatTarget* closest = nullptr;
        double min_lon_diff = 360.0;
        for (size_t i = best_start; i < best_start + num_targets && i < targets.size(); i++) {
            auto& t = targets[i];
            if (!t.visited) {
                double lon_diff = std::abs(t.longitude - current_lon);
                if (lon_diff < min_lon_diff) {
                    min_lon_diff = lon_diff;
                    closest = &t;
                }
            }
        }
        return closest;
    };

    // Setup solver
    ForceModelConfig force_cfg;
    force_cfg.mu = mu;
    force_cfg.include_j2 = false;

    SolverConfig solver_cfg;
    solver_cfg.max_iterations = 50;
    solver_cfg.position_tol = 100.0;  // 100m tolerance for tour
    solver_cfg.verbose = false;

    NonlinearRendezvousSolver solver(force_cfg, solver_cfg);

    double tof_sec = tof_hours * 3600.0;
    double current_time = 0.0;

    std::vector<HopResult> results;
    std::vector<StateVector> chase_trajectory;
    chase_trajectory.push_back(chase_state);

    // Store all target trajectories for Cesium
    struct SatTrajectory {
        std::string name;
        std::vector<StateVector> positions;
    };
    std::vector<SatTrajectory> all_trajectories;

    double total_mission_dv = 0.0;

    std::cout << "\n=== Beginning Tour ===" << std::endl;

    for (int hop = 1; hop <= num_targets; hop++) {
        // Find closest unvisited target by longitude
        SatTarget* next_target = find_closest_by_longitude();
        if (!next_target) {
            std::cout << "No more targets available" << std::endl;
            break;
        }

        double lon_diff = std::abs(next_target->longitude - current_lon);
        std::cout << "\nHop " << hop << ": " << next_target->name
                  << " (lon=" << next_target->longitude << ")"
                  << " - Delta-lon: " << lon_diff << " deg" << std::endl;

        // Propagate target to intercept time
        StateVector target_at_intercept = propagate_state(next_target->state, current_time + tof_sec);

        // Solve two-impulse rendezvous
        RendezvousSolution sol = solver.solve_two_impulse(chase_state, next_target->state, tof_sec);

        HopResult hr;
        hr.hop_number = hop;
        hr.target_name = next_target->name;
        hr.norad_id = next_target->norad_id;
        hr.tof_hours = tof_hours;
        hr.converged = sol.converged;
        hr.rendezvous_time = current_time + tof_sec;
        hr.target_position = target_at_intercept.position;

        // Convert ECI to geodetic for Cesium visualization
        // Use a reference JD (J2000 + simulation time)
        double jd_rendezvous = TimeUtils::J2000_EPOCH_JD + hr.rendezvous_time / 86400.0;
        GeodeticCoord geo = FrameTransformer::eci_to_geodetic(hr.target_position, jd_rendezvous);
        hr.target_lat = geo.latitude;
        hr.target_lon = geo.longitude;
        hr.target_alt = geo.altitude;

        if (sol.converged) {
            hr.dv1 = sol.maneuvers[0].delta_v;
            hr.dv2 = sol.maneuvers[1].delta_v;
            hr.dv1_mag = sol.maneuvers[0].delta_v.norm();
            hr.dv2_mag = sol.maneuvers[1].delta_v.norm();
            hr.total_dv = sol.total_delta_v;
            hr.range_at_intercept = sol.final_position_error;

            std::cout << "  Intercept burn: " << hr.dv1_mag << " m/s" << std::endl;
            std::cout << "  Braking burn:   " << hr.dv2_mag << " m/s" << std::endl;
            std::cout << "  Total dV:       " << hr.total_dv << " m/s" << std::endl;

            total_mission_dv += hr.total_dv;
        } else {
            std::cout << "  WARNING: Failed to converge!" << std::endl;
            hr.dv1_mag = hr.dv2_mag = hr.total_dv = 0;
        }

        results.push_back(hr);

        // Apply maneuvers and propagate chase
        // Apply first burn
        chase_state.velocity.x += sol.maneuvers[0].delta_v.x;
        chase_state.velocity.y += sol.maneuvers[0].delta_v.y;
        chase_state.velocity.z += sol.maneuvers[0].delta_v.z;

        // Propagate during transfer, recording trajectory
        double record_interval = 300.0;  // 5 minutes
        double t = 0;
        while (t < tof_sec) {
            double step = std::min(60.0, tof_sec - t);
            chase_state = propagate_state(chase_state, step);
            t += step;

            if (std::fmod(t, record_interval) < 60.0) {
                StateVector record_state = chase_state;
                record_state.time = current_time + t;
                chase_trajectory.push_back(record_state);
            }
        }

        // Apply second burn (braking)
        chase_state.velocity.x += sol.maneuvers[1].delta_v.x;
        chase_state.velocity.y += sol.maneuvers[1].delta_v.y;
        chase_state.velocity.z += sol.maneuvers[1].delta_v.z;

        current_time += tof_sec;
        chase_state.time = current_time;
        chase_trajectory.push_back(chase_state);

        // Update all target states to current time
        for (auto& tgt : targets) {
            if (!tgt.visited) {
                tgt.state = propagate_state(tgt.state, tof_sec);
            }
        }

        // Mark as visited and move chase to target position
        next_target->visited = true;
        current_lon = next_target->longitude;  // Update for next nearest-neighbor search
        // After rendezvous, chase is co-located with target
        chase_state.position = next_target->state.position;
        chase_state.velocity = next_target->state.velocity;
    }

    // Print summary
    std::cout << "\n========================================" << std::endl;
    std::cout << "=== TOUR SUMMARY ===" << std::endl;
    std::cout << "========================================" << std::endl;
    std::cout << std::setw(4) << "#" << "  "
              << std::setw(24) << std::left << "Satellite"
              << std::setw(12) << std::right << "Intercept"
              << std::setw(12) << "Brake"
              << std::setw(12) << "Total dV" << std::endl;
    std::cout << std::string(64, '-') << std::endl;

    for (const auto& hr : results) {
        std::cout << std::setw(4) << hr.hop_number << "  "
                  << std::setw(24) << std::left << hr.target_name.substr(0, 23)
                  << std::setw(12) << std::right << std::setprecision(2) << hr.dv1_mag
                  << std::setw(12) << hr.dv2_mag
                  << std::setw(12) << hr.total_dv << " m/s" << std::endl;
    }
    std::cout << std::string(64, '-') << std::endl;
    std::cout << "Total Mission Delta-V: " << std::setprecision(2) << total_mission_dv << " m/s" << std::endl;
    std::cout << "Total Time: " << current_time/3600.0 << " hours ("
              << current_time/86400.0 << " days)" << std::endl;

    // Export to JSON for Cesium
    std::ofstream json("sat_tour_data.json");
    json << std::fixed << std::setprecision(6);
    json << "{\n";
    json << "  \"metadata\": {\n";
    json << "    \"scenario\": \"30-Satellite Rendezvous Tour\",\n";
    json << "    \"num_targets\": " << results.size() << ",\n";
    json << "    \"tof_per_hop_hours\": " << tof_hours << ",\n";
    json << "    \"total_duration_hours\": " << current_time/3600.0 << ",\n";
    json << "    \"total_delta_v_ms\": " << total_mission_dv << "\n";
    json << "  },\n";

    // Hop details with target positions
    json << "  \"hops\": [\n";
    for (size_t i = 0; i < results.size(); i++) {
        const auto& hr = results[i];
        json << "    {\"hop\": " << hr.hop_number
             << ", \"target\": \"" << hr.target_name << "\""
             << ", \"norad_id\": " << hr.norad_id
             << ", \"dv1\": " << hr.dv1_mag
             << ", \"dv2\": " << hr.dv2_mag
             << ", \"total_dv\": " << hr.total_dv
             << ", \"converged\": " << (hr.converged ? "true" : "false")
             << ", \"rendezvous_time\": " << hr.rendezvous_time
             << ", \"target_pos\": {\"x\": " << hr.target_position.x
             << ", \"y\": " << hr.target_position.y
             << ", \"z\": " << hr.target_position.z << "}"
             << ", \"target_geo\": {\"lat\": " << hr.target_lat
             << ", \"lon\": " << hr.target_lon
             << ", \"alt\": " << hr.target_alt << "}"
             << "}";
        if (i < results.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // Chase trajectory with geodetic coordinates
    json << "  \"chase_trajectory\": [\n";
    for (size_t i = 0; i < chase_trajectory.size(); i++) {
        const auto& s = chase_trajectory[i];
        // Convert ECI to geodetic
        double jd = TimeUtils::J2000_EPOCH_JD + s.time / 86400.0;
        GeodeticCoord geo = FrameTransformer::eci_to_geodetic(s.position, jd);
        json << "    {\"time\": " << s.time
             << ", \"x\": " << s.position.x
             << ", \"y\": " << s.position.y
             << ", \"z\": " << s.position.z
             << ", \"lat\": " << geo.latitude
             << ", \"lon\": " << geo.longitude
             << ", \"alt\": " << geo.altitude << "}";
        if (i < chase_trajectory.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ],\n";

    // All satellites from catalog for background visualization
    json << "  \"all_satellites\": [\n";
    for (size_t i = 0; i < targets.size(); i++) {
        const auto& t = targets[i];
        // Classify orbit type
        double alt_km = t.altitude / 1000.0;
        std::string orbit_type = "LEO";
        if (alt_km > 35000) orbit_type = "GEO";
        else if (alt_km > 2000) orbit_type = "MEO";

        json << "    {\"name\": \"" << t.name << "\""
             << ", \"norad_id\": " << t.norad_id
             << ", \"lat\": " << t.latitude
             << ", \"lon\": " << t.longitude
             << ", \"alt\": " << t.altitude
             << ", \"type\": \"" << orbit_type << "\""
             << ", \"visited\": " << (t.visited ? "true" : "false") << "}";
        if (i < targets.size() - 1) json << ",";
        json << "\n";
    }
    json << "  ]\n";
    json << "}\n";
    json.close();

    std::cout << "\nExported to: sat_tour_data.json" << std::endl;

    return 0;
}
