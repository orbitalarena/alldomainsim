/**
 * Launch-to-Intercept Trajectory Solver Demo
 *
 * Demonstrates the nonlinear trajectory solver:
 * 1. ORBIT_INSERTION: Solve for launch controls to reach 400km circular orbit
 * 2. POSITION_INTERCEPT: Solve to match a target satellite's position at TOF
 * 3. FULL_RENDEZVOUS: Match both position and velocity
 *
 * Exports trajectory JSON for Cesium visualization.
 */

#include "physics/launch_trajectory_solver.hpp"
#include "physics/orbital_elements.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"
#include <iostream>
#include <fstream>
#include <iomanip>
#include <cmath>

static constexpr double PI = 3.14159265358979323846;
static constexpr double DEG_TO_RAD = PI / 180.0;
static constexpr double EARTH_RADIUS = 6378137.0;

// ============================================================
// Vehicle Configuration (matches rendezvous_demo rocket)
// ============================================================

sim::SolverVehicleConfig create_vehicle() {
    sim::SolverVehicleConfig vehicle;

    // Stage 1: Boost phase
    sim::SolverRocketStage s1;
    s1.dry_mass = 20000.0;
    s1.propellant_mass = 280000.0;
    s1.thrust = 4500000.0;    // 4.5 MN
    s1.isp_sl = 295.0;
    s1.isp_vac = 320.0;
    vehicle.stages.push_back(s1);

    // Stage 2: Upper stage
    sim::SolverRocketStage s2;
    s2.dry_mass = 3500.0;
    s2.propellant_mass = 28000.0;
    s2.thrust = 450000.0;     // 450 kN
    s2.isp_sl = 320.0;
    s2.isp_vac = 355.0;
    vehicle.stages.push_back(s2);

    vehicle.payload_mass = 4500.0;
    vehicle.drag_coefficient = 0.4;
    vehicle.reference_area = 100.0;

    return vehicle;
}

// ============================================================
// JSON Export
// ============================================================

void export_trajectory_json(
    const std::string& filename,
    const sim::LaunchTrajectorySolution& solution,
    const sim::TerminalTarget& target,
    double epoch_jd)
{
    std::ofstream file(filename);
    if (!file.is_open()) {
        std::cerr << "ERROR: Cannot open " << filename << " for writing" << std::endl;
        return;
    }

    file << std::fixed << std::setprecision(6);
    file << "{\n";

    // Metadata
    file << "  \"metadata\": {\n";
    file << "    \"epoch_jd\": " << std::setprecision(8) << epoch_jd << ",\n";
    file << "    \"epoch_iso\": \"" << sim::TimeUtils::jd_to_iso8601(epoch_jd) << "\",\n";
    file << "    \"time_step\": 1.0,\n";
    file << "    \"duration\": " << std::setprecision(1)
         << solution.trajectory.back().time << ",\n";
    file << "    \"scenario\": \"launch_intercept\",\n";
    file << "    \"converged\": " << (solution.converged ? "true" : "false") << ",\n";
    file << "    \"iterations\": " << solution.iterations << ",\n";
    file << "    \"residual_norm\": " << std::scientific << std::setprecision(4)
         << solution.residual_norm << "\n";
    file << "  },\n";

    // Satellites array
    file << "  \"satellites\": [\n";

    // Launch vehicle trajectory
    file << "    {\n";
    file << "      \"name\": \"Launch Vehicle\",\n";
    file << "      \"id\": 0,\n";
    file << "      \"type\": \"launch_vehicle\",\n";
    file << "      \"positions\": [\n";

    // Sample trajectory at reasonable intervals for visualization
    double last_time = -10.0;
    double interval_atmo = 2.0;    // Every 2s in atmosphere
    double interval_space = 10.0;  // Every 10s in space
    int count = 0;

    for (size_t i = 0; i < solution.trajectory.size(); i++) {
        const auto& state = solution.trajectory[i];
        double interval = (state.altitude < 100000.0) ? interval_atmo : interval_space;

        // Always include first, last, and staging events
        bool include = (i == 0) || (i == solution.trajectory.size() - 1);
        if (!include && state.time - last_time >= interval) include = true;
        if (!include && i > 0 &&
            solution.trajectory[i].stage_index != solution.trajectory[i-1].stage_index) {
            include = true;
        }

        if (!include) continue;

        double jd = sim::TimeUtils::add_seconds_to_jd(epoch_jd, state.time);
        sim::GeodeticCoord geo = sim::FrameTransformer::eci_to_geodetic(
            state.position, jd);

        if (count > 0) file << ",\n";
        file << "        {\n";
        file << "          \"time\": " << std::fixed << std::setprecision(1)
             << state.time << ",\n";
        file << "          \"eci\": {\"x\": " << std::setprecision(2)
             << state.position.x << ", \"y\": " << state.position.y
             << ", \"z\": " << state.position.z << "},\n";
        file << "          \"geo\": {\"lat\": " << std::setprecision(4)
             << geo.latitude << ", \"lon\": " << geo.longitude
             << ", \"alt\": " << std::setprecision(1) << geo.altitude << "}\n";
        file << "        }";
        last_time = state.time;
        count++;
    }

    file << "\n      ]\n";
    file << "    }";

    // If intercept/rendezvous, include target satellite trajectory
    if (target.mode != sim::TargetingMode::ORBIT_INSERTION) {
        file << ",\n    {\n";
        file << "      \"name\": \"Target Satellite\",\n";
        file << "      \"id\": 1,\n";
        file << "      \"type\": \"target\",\n";
        file << "      \"positions\": [\n";

        // Propagate target and output positions
        sim::StateVector target_state = target.target_state_epoch;
        double total_time = solution.trajectory.back().time;
        double target_dt = 30.0;
        int tcount = 0;

        for (double t = 0.0; t <= total_time; t += target_dt) {
            // Simple Keplerian propagation for target
            sim::OrbitalElements elem = sim::OrbitalMechanics::state_to_elements(
                target.target_state_epoch);
            double n = elem.mean_motion();
            elem.mean_anomaly = sim::OrbitalMechanics::propagate_mean_anomaly(
                elem.mean_anomaly, n, t);
            elem.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
                elem.mean_anomaly, elem.eccentricity);
            sim::StateVector sv = sim::OrbitalMechanics::elements_to_state(elem);

            double jd = sim::TimeUtils::add_seconds_to_jd(epoch_jd, t);
            sim::GeodeticCoord geo = sim::FrameTransformer::eci_to_geodetic(
                sv.position, jd);

            if (tcount > 0) file << ",\n";
            file << "        {\n";
            file << "          \"time\": " << std::fixed << std::setprecision(1)
                 << t << ",\n";
            file << "          \"eci\": {\"x\": " << std::setprecision(2)
                 << sv.position.x << ", \"y\": " << sv.position.y
                 << ", \"z\": " << sv.position.z << "},\n";
            file << "          \"geo\": {\"lat\": " << std::setprecision(4)
                 << geo.latitude << ", \"lon\": " << geo.longitude
                 << ", \"alt\": " << std::setprecision(1) << geo.altitude << "}\n";
            file << "        }";
            tcount++;
        }

        file << "\n      ]\n";
        file << "    }";
    }

    file << "\n  ]\n";
    file << "}\n";

    file.close();
    std::cout << "Exported trajectory to: " << filename
              << " (" << count << " vehicle points)" << std::endl;
}

// ============================================================
// Print Solution Summary
// ============================================================

void print_solution(const std::string& label,
                    const sim::LaunchTrajectorySolution& solution) {
    std::cout << "\n" << label << std::endl;
    std::cout << std::string(label.size(), '=') << std::endl;

    std::cout << "Status: " << solution.status << std::endl;
    std::cout << "Iterations: " << solution.iterations << std::endl;
    std::cout << "Residual norm: " << std::scientific << std::setprecision(4)
              << solution.residual_norm << std::endl;

    std::cout << std::fixed;
    std::cout << "\nFinal State:" << std::endl;
    std::cout << "  Altitude: " << std::setprecision(1)
              << solution.final_state.altitude / 1000.0 << " km" << std::endl;
    std::cout << "  Velocity: " << std::setprecision(1)
              << solution.final_state.velocity.norm() << " m/s" << std::endl;
    std::cout << "  Mass:     " << std::setprecision(1)
              << solution.final_state.mass << " kg" << std::endl;
    std::cout << "  Time:     " << std::setprecision(1)
              << solution.final_state.time << " s ("
              << solution.final_state.time / 60.0 << " min)" << std::endl;

    std::cout << "\nOrbital Elements:" << std::endl;
    std::cout << "  SMA:  " << std::setprecision(1)
              << solution.final_elements.semi_major_axis / 1000.0 << " km" << std::endl;
    std::cout << "  Ecc:  " << std::setprecision(6)
              << solution.final_elements.eccentricity << std::endl;
    std::cout << "  Inc:  " << std::setprecision(2)
              << solution.final_elements.inclination / DEG_TO_RAD << " deg" << std::endl;
    std::cout << "  RAAN: " << std::setprecision(2)
              << solution.final_elements.raan / DEG_TO_RAD << " deg" << std::endl;
    std::cout << "  AoP:  " << std::setprecision(2)
              << solution.final_elements.arg_periapsis / DEG_TO_RAD << " deg" << std::endl;

    double r_peri = solution.final_elements.semi_major_axis *
                    (1.0 - solution.final_elements.eccentricity);
    double r_apo  = solution.final_elements.semi_major_axis *
                    (1.0 + solution.final_elements.eccentricity);
    std::cout << "  Periapsis: " << std::setprecision(1)
              << (r_peri - EARTH_RADIUS) / 1000.0 << " km" << std::endl;
    std::cout << "  Apoapsis:  " << std::setprecision(1)
              << (r_apo - EARTH_RADIUS) / 1000.0 << " km" << std::endl;

    std::cout << "\nLaunch Controls:" << std::endl;
    std::cout << "  Azimuth: " << std::setprecision(2)
              << solution.controls.launch_azimuth / DEG_TO_RAD << " deg" << std::endl;
    std::cout << "  Pitch S1: [" << std::setprecision(4)
              << solution.controls.pitch_s1[0] << ", "
              << solution.controls.pitch_s1[1] << ", "
              << solution.controls.pitch_s1[2] << "]" << std::endl;
    std::cout << "  Pitch S2: [" << std::setprecision(4)
              << solution.controls.pitch_s2[0] << ", "
              << solution.controls.pitch_s2[1] << ", "
              << solution.controls.pitch_s2[2] << "]" << std::endl;
    std::cout << "  Coast:    " << std::setprecision(1)
              << solution.controls.coast_after_burnout << " s" << std::endl;

    if (solution.stage_separation_time > 0.0) {
        std::cout << "\nEvents:" << std::endl;
        std::cout << "  Stage separation: T+" << solution.stage_separation_time << " s" << std::endl;
        std::cout << "  Burnout: T+" << solution.burnout_time << " s" << std::endl;
    }

    if (solution.total_delta_v > 0.0) {
        std::cout << "\nDelta-V Budget:" << std::endl;
        std::cout << "  Total: " << std::setprecision(1)
                  << solution.total_delta_v << " m/s" << std::endl;
    }

    if (solution.final_position_error > 0.0) {
        std::cout << "\nTarget Errors:" << std::endl;
        std::cout << "  Position: " << std::setprecision(1)
                  << solution.final_position_error / 1000.0 << " km" << std::endl;
        std::cout << "  Velocity: " << std::setprecision(2)
                  << solution.final_velocity_error << " m/s" << std::endl;
    }
}

// ============================================================
// Main
// ============================================================

int main() {
    std::cout << "============================================\n";
    std::cout << "Launch-to-Intercept Trajectory Solver Demo\n";
    std::cout << "============================================\n\n";

    double epoch_jd = 2460335.0;  // ~Jan 25, 2024

    // Create vehicle and launch site
    sim::SolverVehicleConfig vehicle = create_vehicle();
    sim::LaunchSite site = sim::LaunchSite::cape_canaveral();

    std::cout << "Vehicle Configuration:" << std::endl;
    std::cout << "  Total mass: " << vehicle.total_mass() << " kg" << std::endl;
    std::cout << "  Stages: " << vehicle.stages.size() << std::endl;
    std::cout << "  Stage 1: " << vehicle.stages[0].thrust / 1e6 << " MN thrust, "
              << vehicle.stages[0].propellant_mass / 1000.0 << "t prop" << std::endl;
    std::cout << "  Stage 2: " << vehicle.stages[1].thrust / 1e3 << " kN thrust, "
              << vehicle.stages[1].propellant_mass / 1000.0 << "t prop" << std::endl;
    std::cout << "  Payload: " << vehicle.payload_mass << " kg" << std::endl;
    std::cout << "\nLaunch Site: Cape Canaveral ("
              << site.latitude_deg << "N, " << site.longitude_deg << "E)" << std::endl;

    // ============================================================
    // Test 1: Orbit Insertion (solve for 400km circular at 28.5 deg)
    // ============================================================
    std::cout << "\n\n########################################\n";
    std::cout << "Test 1: ORBIT INSERTION (400 km, 28.5 deg)\n";
    std::cout << "########################################\n";

    sim::TerminalTarget oi_target;
    oi_target.mode = sim::TargetingMode::ORBIT_INSERTION;
    oi_target.target_elements.semi_major_axis = EARTH_RADIUS + 400000.0;
    oi_target.target_elements.eccentricity = 0.001;
    oi_target.target_elements.inclination = 28.5 * DEG_TO_RAD;
    oi_target.constrain_sma = true;
    oi_target.constrain_ecc = true;
    oi_target.constrain_inc = true;

    sim::LaunchSolverConfig config;
    config.max_iterations = 50;
    config.convergence_tol = 50.0;
    config.verbose = true;

    // For orbit insertion: 8 controls for 3 constraints (underdetermined)
    // All pitch polynomial coefficients + azimuth
    for (int i = 0; i < sim::LaunchControls::N_CONTROLS; i++) {
        config.free_controls[i] = false;
    }
    config.free_controls[0] = true;   // launch_azimuth → inclination
    config.free_controls[1] = true;   // pitch_s1[0] - initial kick angle
    config.free_controls[2] = true;   // pitch_s1[1] - S1 turn rate
    config.free_controls[3] = true;   // pitch_s1[2] - S1 turn acceleration
    config.free_controls[4] = true;   // pitch_s2[0] - S2 start angle
    config.free_controls[5] = true;   // pitch_s2[1] - S2 turn rate
    config.free_controls[6] = true;   // pitch_s2[2] - S2 turn acceleration
    config.free_controls[11] = true;  // coast_after_burnout

    sim::LaunchTrajectorySolver solver(vehicle, site, epoch_jd, config);

    std::cout << "\nSolving orbit insertion..." << std::endl;
    sim::LaunchTrajectorySolution oi_solution = solver.solve(oi_target);

    print_solution("Orbit Insertion Results", oi_solution);
    export_trajectory_json("launch_orbit_insertion.json", oi_solution, oi_target, epoch_jd);

    // ============================================================
    // Test 2: Position Intercept (match target satellite position)
    // ============================================================
    std::cout << "\n\n########################################\n";
    std::cout << "Test 2: POSITION INTERCEPT (target at 400 km)\n";
    std::cout << "########################################\n";

    // Create target satellite in 400km orbit
    sim::OrbitalElements target_elem;
    target_elem.semi_major_axis = EARTH_RADIUS + 400000.0;
    target_elem.eccentricity = 0.0005;
    target_elem.inclination = 28.5 * DEG_TO_RAD;
    target_elem.raan = 45.0 * DEG_TO_RAD;
    target_elem.arg_periapsis = 0.0;
    target_elem.true_anomaly = 220.0 * DEG_TO_RAD;
    target_elem.mean_anomaly = sim::OrbitalMechanics::true_to_mean_anomaly(
        target_elem.true_anomaly, target_elem.eccentricity);

    sim::StateVector target_state = sim::OrbitalMechanics::elements_to_state(target_elem);
    target_state.time = 0.0;

    double target_alt = (target_state.position.norm() - EARTH_RADIUS) / 1000.0;
    std::cout << "Target satellite:" << std::endl;
    std::cout << "  Altitude: " << target_alt << " km" << std::endl;
    std::cout << "  Inclination: " << target_elem.inclination / DEG_TO_RAD << " deg" << std::endl;
    std::cout << "  RAAN: " << target_elem.raan / DEG_TO_RAD << " deg" << std::endl;

    sim::TerminalTarget pi_target;
    pi_target.mode = sim::TargetingMode::POSITION_INTERCEPT;
    pi_target.target_state_epoch = target_state;
    pi_target.target_elements = target_elem;
    pi_target.time_of_flight = 3600.0;  // 1 hour total flight time
    pi_target.position_tol = 1000.0;

    sim::LaunchSolverConfig pi_config;
    pi_config.max_iterations = 50;
    pi_config.convergence_tol = 5000.0;  // 5 km position match
    pi_config.verbose = true;
    // For intercept: free azimuth + pitch + coast (8 controls for 3 constraints)
    for (int i = 0; i < sim::LaunchControls::N_CONTROLS; i++) {
        pi_config.free_controls[i] = false;
    }
    pi_config.free_controls[0] = true;   // launch_azimuth
    pi_config.free_controls[1] = true;   // pitch_s1[0]
    pi_config.free_controls[2] = true;   // pitch_s1[1]
    pi_config.free_controls[3] = true;   // pitch_s1[2]
    pi_config.free_controls[4] = true;   // pitch_s2[0]
    pi_config.free_controls[5] = true;   // pitch_s2[1]
    pi_config.free_controls[6] = true;   // pitch_s2[2]
    pi_config.free_controls[11] = true;  // coast_after_burnout

    sim::LaunchTrajectorySolver pi_solver(vehicle, site, epoch_jd, pi_config);

    std::cout << "\nSolving position intercept (TOF=" << pi_target.time_of_flight << "s)..."
              << std::endl;
    sim::LaunchTrajectorySolution pi_solution = pi_solver.solve(pi_target);

    print_solution("Position Intercept Results", pi_solution);
    export_trajectory_json("launch_intercept_data.json", pi_solution, pi_target, epoch_jd);

    // ============================================================
    // Test 3: Open-loop propagation (no solver, just default guess)
    // ============================================================
    std::cout << "\n\n########################################\n";
    std::cout << "Test 3: OPEN-LOOP PROPAGATION (baseline)\n";
    std::cout << "########################################\n";

    sim::LaunchControls default_controls = sim::LaunchControls::default_guess(
        28.5 * DEG_TO_RAD, site.latitude_deg * DEG_TO_RAD);

    std::cout << "Default controls:" << std::endl;
    std::cout << "  Azimuth: " << default_controls.launch_azimuth / DEG_TO_RAD << " deg" << std::endl;
    std::cout << "  Pitch S1: [" << default_controls.pitch_s1[0] << ", "
              << default_controls.pitch_s1[1] << ", "
              << default_controls.pitch_s1[2] << "]" << std::endl;
    std::cout << "  Pitch S2: [" << default_controls.pitch_s2[0] << ", "
              << default_controls.pitch_s2[1] << ", "
              << default_controls.pitch_s2[2] << "]" << std::endl;

    sim::LaunchTrajectorySolution ol_solution = solver.propagate(default_controls, oi_target);
    print_solution("Open-Loop Propagation Results", ol_solution);

    // ============================================================
    // Summary
    // ============================================================
    std::cout << "\n\n============================================\n";
    std::cout << "Summary\n";
    std::cout << "============================================\n";
    std::cout << "Orbit Insertion: "
              << (oi_solution.converged ? "CONVERGED" : "FAILED")
              << " (" << oi_solution.iterations << " iter, |r|="
              << std::scientific << oi_solution.residual_norm << ")" << std::endl;
    std::cout << "Position Intercept: "
              << (pi_solution.converged ? "CONVERGED" : "FAILED")
              << " (" << pi_solution.iterations << " iter, |r|="
              << std::scientific << pi_solution.residual_norm << ")" << std::endl;

    std::cout << std::fixed;
    std::cout << "\nOutput files:" << std::endl;
    std::cout << "  launch_orbit_insertion.json - Orbit insertion trajectory" << std::endl;
    std::cout << "  launch_intercept_data.json  - Position intercept trajectory" << std::endl;
    std::cout << "\nTo visualize:" << std::endl;
    std::cout << "  cp launch_intercept_data.json orbit_data.json" << std::endl;
    std::cout << "  cd visualization/cesium && python3 -m http.server 8000" << std::endl;
    std::cout << "  Open http://localhost:8000/orbit_viewer.html" << std::endl;

    return 0;
}
