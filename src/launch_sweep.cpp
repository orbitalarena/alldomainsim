/**
 * Launch Profile Sweep
 *
 * Brute-force search over pitch profiles to find one that achieves LEO.
 * No solver, no targeting — just propagate and check orbital elements.
 *
 * Sweeps over:
 *   - S1 end pitch angle (how much to turn during stage 1)
 *   - S2 turn rate (how quickly to reach horizontal in stage 2)
 *   - S2 propellant (how much of S2 to burn — controls total delta-V)
 *
 * Reports: SMA, eccentricity, periapsis, apoapsis, altitude at burnout
 */

#include "physics/launch_trajectory_solver.hpp"
#include "physics/orbital_elements.hpp"
#include "coordinate/time_utils.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <vector>
#include <algorithm>

static constexpr double PI = 3.14159265358979323846;
static constexpr double DEG = PI / 180.0;
static constexpr double RE = 6378137.0;

struct Result {
    double s1_end_deg;
    double s2_rate;
    double s2_prop_t;
    double sma_km;
    double ecc;
    double inc_deg;
    double peri_km;
    double apo_km;
    double alt_km;
    double vel;
};

int main() {
    std::cout << "=== Launch Profile Sweep (3D) ===" << std::endl;
    std::cout << "Finding pitch profiles + S2 propellant that achieve circular LEO\n" << std::endl;

    double epoch_jd = 2460335.0;
    sim::LaunchSite site = sim::LaunchSite::cape_canaveral();

    // Azimuth for ~28.5 deg inclination from Cape Canaveral
    double azimuth = 90.0 * DEG;

    std::vector<Result> results;

    // Sweep S2 propellant from 12t to 28t in steps of 2t
    // Sweep S1_end from 30° to 80° in steps of 5°
    // Sweep S2_rate from 0.4 to 3.0 in steps of 0.4
    std::cout << "Sweeping S2_prop=[12t..28t] x S1_end=[30°..80°] x S2_rate=[0.4..3.0]...\n"
              << std::endl;

    for (double s2_prop = 12000.0; s2_prop <= 28000.0; s2_prop += 2000.0) {
        // Build vehicle with this S2 propellant
        sim::SolverVehicleConfig vehicle;

        sim::SolverRocketStage s1;
        s1.dry_mass = 20000.0;
        s1.propellant_mass = 280000.0;
        s1.thrust = 4500000.0;
        s1.isp_sl = 295.0;
        s1.isp_vac = 320.0;
        vehicle.stages.push_back(s1);

        sim::SolverRocketStage s2;
        s2.dry_mass = 3500.0;
        s2.propellant_mass = s2_prop;
        s2.thrust = 450000.0;
        s2.isp_sl = 320.0;
        s2.isp_vac = 355.0;
        vehicle.stages.push_back(s2);

        vehicle.payload_mass = 4500.0;
        vehicle.drag_coefficient = 0.4;
        vehicle.reference_area = 100.0;

        sim::LaunchSolverConfig config;
        config.verbose = false;
        sim::LaunchTrajectorySolver solver(vehicle, site, epoch_jd, config);

        for (double s1_end_deg = 30.0; s1_end_deg <= 80.0; s1_end_deg += 5.0) {
            for (double s2_rate = 0.4; s2_rate <= 3.2; s2_rate += 0.4) {
                double s1_end = s1_end_deg * DEG;

                sim::LaunchControls ctrl;
                ctrl.launch_azimuth = azimuth;
                ctrl.pitch_s1[0] = 0.05;
                ctrl.pitch_s1[1] = s1_end - 0.05;
                ctrl.pitch_s1[2] = 0.0;
                ctrl.pitch_s2[0] = s1_end;
                ctrl.pitch_s2[1] = s2_rate;
                ctrl.pitch_s2[2] = 0.0;
                ctrl.yaw_s1[0] = 0.0; ctrl.yaw_s1[1] = 0.0;
                ctrl.yaw_s2[0] = 0.0; ctrl.yaw_s2[1] = 0.0;
                ctrl.coast_after_burnout = 0.0;
                ctrl.epoch_offset = 0.0;

                sim::TerminalTarget tgt;
                tgt.mode = sim::TargetingMode::ORBIT_INSERTION;
                tgt.target_elements.semi_major_axis = RE + 400000.0;
                tgt.target_elements.eccentricity = 0.001;
                tgt.target_elements.inclination = 28.5 * DEG;

                sim::LaunchTrajectorySolution sol = solver.propagate(ctrl, tgt);

                double sma = sol.final_elements.semi_major_axis;
                double ecc = sol.final_elements.eccentricity;
                double peri = sma * (1.0 - ecc) - RE;
                double apo = sma * (1.0 + ecc) - RE;

                Result r;
                r.s1_end_deg = s1_end_deg;
                r.s2_rate = s2_rate;
                r.s2_prop_t = s2_prop / 1000.0;
                r.sma_km = sma / 1000.0;
                r.ecc = ecc;
                r.inc_deg = sol.final_elements.inclination / DEG;
                r.peri_km = peri / 1000.0;
                r.apo_km = apo / 1000.0;
                r.alt_km = sol.final_state.altitude / 1000.0;
                r.vel = sol.final_state.velocity.norm();
                results.push_back(r);
            }
        }
    }

    std::cout << "Total profiles tested: " << results.size() << "\n" << std::endl;

    // Sort by eccentricity and show best with periapsis > 150 km
    std::vector<Result> good;
    for (auto& r : results) {
        if (r.peri_km > 150.0 && r.ecc < 0.5 && r.sma_km > 6400.0 && r.sma_km < 8000.0) {
            good.push_back(r);
        }
    }
    std::sort(good.begin(), good.end(), [](const Result& a, const Result& b) {
        return a.ecc < b.ecc;
    });

    std::cout << "=== BEST ORBITS (peri>150km, SMA<8000km, sorted by ecc) ===" << std::endl;
    std::cout << std::setw(7) << "S1end"
              << std::setw(7) << "S2rat"
              << std::setw(7) << "S2t"
              << std::setw(9) << "SMA_km"
              << std::setw(9) << "ecc"
              << std::setw(9) << "peri"
              << std::setw(9) << "apo"
              << std::setw(9) << "alt_km"
              << std::setw(8) << "vel"
              << std::setw(7) << "inc"
              << std::endl;
    std::cout << std::string(81, '-') << std::endl;

    int shown = 0;
    for (auto& r : good) {
        std::cout << std::fixed
                  << std::setw(7) << std::setprecision(0) << r.s1_end_deg
                  << std::setw(7) << std::setprecision(1) << r.s2_rate
                  << std::setw(7) << std::setprecision(0) << r.s2_prop_t
                  << std::setw(9) << std::setprecision(1) << r.sma_km
                  << std::setw(9) << std::setprecision(4) << r.ecc
                  << std::setw(9) << std::setprecision(1) << r.peri_km
                  << std::setw(9) << std::setprecision(1) << r.apo_km
                  << std::setw(9) << std::setprecision(1) << r.alt_km
                  << std::setw(8) << std::setprecision(0) << r.vel
                  << std::setw(7) << std::setprecision(1) << r.inc_deg
                  << std::endl;
        if (++shown >= 40) break;
    }

    if (good.empty()) {
        std::cout << "  No matching orbits found!" << std::endl;
        std::cout << "\n  Lowest-ecc results overall:" << std::endl;
        std::sort(results.begin(), results.end(), [](const Result& a, const Result& b) {
            return a.ecc < b.ecc;
        });
        for (int i = 0; i < 30 && i < (int)results.size(); i++) {
            auto& r = results[i];
            std::cout << std::fixed
                      << "  S1=" << std::setprecision(0) << r.s1_end_deg << "°"
                      << "  S2rate=" << std::setprecision(1) << r.s2_rate
                      << "  S2prop=" << r.s2_prop_t << "t"
                      << "  SMA=" << std::setprecision(1) << r.sma_km
                      << "  ecc=" << std::setprecision(4) << r.ecc
                      << "  peri=" << std::setprecision(1) << r.peri_km
                      << "  apo=" << std::setprecision(1) << r.apo_km
                      << "  alt=" << std::setprecision(1) << r.alt_km
                      << std::endl;
        }
    }

    return 0;
}
