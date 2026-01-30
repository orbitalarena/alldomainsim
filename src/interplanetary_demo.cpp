/**
 * Earth-to-Mars Interplanetary Transfer Demo
 *
 * Demonstrates Phase 4 interplanetary trajectory design capabilities:
 *
 * 1. Select 2026 Earth-Mars launch window (July-August)
 * 2. Generate porkchop plot (C3 vs launch/arrival date)
 * 3. Find optimal minimum-energy transfer
 * 4. Compute detailed Lambert solution
 * 5. Build trajectory with sampled heliocentric states
 * 6. Compare Lambert (patched-conic) with N-body propagation
 * 7. Mars orbit capture burn
 * 8. Export mission data as JSON for CesiumJS visualization
 *
 * Expected results for 2026 Mars window:
 *   C3 departure: ~10-15 km²/s²
 *   Departure ΔV: ~3.7 km/s (from 200 km LEO)
 *   Capture ΔV:   ~2.1 km/s (into 200 km Mars orbit)
 *   Total ΔV:     ~5.8 km/s
 *   TOF:          ~180-260 days
 */

#include "physics/planetary_ephemeris.hpp"
#include "physics/interplanetary_planner.hpp"
#include "physics/mars_atmosphere.hpp"
#include "physics/nbody_gravity.hpp"
#include "physics/gravity_assist.hpp"
#include "physics/mission_sequence.hpp"
#include "physics/celestial_body.hpp"
#include "propagators/adaptive_integrator.hpp"
#include "coordinate/frame_transformer.hpp"
#include "coordinate/time_utils.hpp"
#include <iostream>
#include <iomanip>
#include <fstream>
#include <vector>
#include <cmath>
#include <limits>
#include <algorithm>

using namespace sim;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

constexpr double PI = 3.14159265358979323846;
constexpr double AU_M = 149597870700.0;
constexpr double AU_KM = 149597870.7;

/// Convert calendar date to approximate Julian Date
double calendar_to_jd(int year, int month, double day) {
    // Meeus, Astronomical Algorithms, Ch.7
    if (month <= 2) { year--; month += 12; }
    int A = year / 100;
    int B = 2 - A + A / 4;
    return std::floor(365.25 * (year + 4716)) +
           std::floor(30.6001 * (month + 1)) +
           day + B - 1524.5;
}

/// Convert JD to calendar string (approximate)
std::string jd_to_date_string(double jd) {
    // Meeus inverse algorithm
    double Z = std::floor(jd + 0.5);
    double F = jd + 0.5 - Z;
    double A;
    if (Z < 2299161) {
        A = Z;
    } else {
        double alpha = std::floor((Z - 1867216.25) / 36524.25);
        A = Z + 1 + alpha - std::floor(alpha / 4);
    }
    double B = A + 1524;
    double C = std::floor((B - 122.1) / 365.25);
    double D = std::floor(365.25 * C);
    double E = std::floor((B - D) / 30.6001);

    double day = B - D - std::floor(30.6001 * E) + F;
    int month = (E < 14) ? static_cast<int>(E) - 1 : static_cast<int>(E) - 13;
    int year = (month > 2) ? static_cast<int>(C) - 4716 : static_cast<int>(C) - 4715;

    char buf[32];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%05.2f", year, month, day);
    return std::string(buf);
}

void print_separator(const std::string& title) {
    std::cout << "\n╔══════════════════════════════════════════════════════════════╗\n";
    std::cout << "║ " << std::left << std::setw(61) << title << "║\n";
    std::cout << "╚══════════════════════════════════════════════════════════════╝\n\n";
}

void print_subsection(const std::string& title) {
    std::cout << "── " << title << " ──\n";
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

int main() {
    std::cout << std::fixed;

    print_separator("EARTH-TO-MARS INTERPLANETARY TRANSFER");
    std::cout << "Phase 4 demonstration: interplanetary trajectory design\n";
    std::cout << "using Lambert's problem, porkchop plots, and N-body propagation.\n\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 1: Verify planetary ephemeris
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 1: PLANETARY EPHEMERIS VERIFICATION");

    // Today's date: 2026-01-30
    double jd_now = calendar_to_jd(2026, 1, 30.0);
    std::cout << "Reference date: 2026-01-30 (JD " << std::setprecision(1) << jd_now << ")\n\n";

    // Print planet positions
    Planet planets[] = {Planet::MERCURY, Planet::VENUS, Planet::EARTH,
                        Planet::MARS, Planet::JUPITER};
    const char* names[] = {"Mercury", "Venus", "Earth", "Mars", "Jupiter"};

    std::cout << std::setw(10) << "Planet"
              << std::setw(15) << "Distance [AU]"
              << std::setw(18) << "X_HCI [AU]"
              << std::setw(18) << "Y_HCI [AU]"
              << std::setw(18) << "Z_HCI [AU]" << "\n";
    std::cout << std::string(79, '-') << "\n";

    for (int i = 0; i < 5; i++) {
        Vec3 pos = PlanetaryEphemeris::get_position_hci(planets[i], jd_now);
        double dist_au = pos.norm() / AU_M;
        std::cout << std::setw(10) << names[i]
                  << std::setprecision(4)
                  << std::setw(15) << dist_au
                  << std::setw(18) << pos.x / AU_M
                  << std::setw(18) << pos.y / AU_M
                  << std::setw(18) << pos.z / AU_M << "\n";
    }

    // Earth-Mars distance
    Vec3 earth_pos = PlanetaryEphemeris::get_position_hci(Planet::EARTH, jd_now);
    Vec3 mars_pos = PlanetaryEphemeris::get_position_hci(Planet::MARS, jd_now);
    Vec3 diff(mars_pos.x - earth_pos.x, mars_pos.y - earth_pos.y, mars_pos.z - earth_pos.z);
    double earth_mars_dist = diff.norm();
    std::cout << "\nEarth-Mars distance: " << std::setprecision(4)
              << earth_mars_dist / AU_M << " AU ("
              << std::setprecision(0) << earth_mars_dist / 1e9 << " million km)\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 2: Generate Porkchop Plot
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 2: PORKCHOP PLOT GENERATION");

    // 2026 Earth-Mars launch window: July-August 2026
    // Arrival: January-March 2027
    double launch_start = calendar_to_jd(2026, 6, 15.0);
    double launch_end   = calendar_to_jd(2026, 10, 15.0);
    double arrival_start = calendar_to_jd(2026, 12, 1.0);
    double arrival_end   = calendar_to_jd(2027, 6, 1.0);

    int launch_steps = 40;
    int arrival_steps = 40;

    std::cout << "Launch window:  " << jd_to_date_string(launch_start) << " to "
              << jd_to_date_string(launch_end) << "\n";
    std::cout << "Arrival window: " << jd_to_date_string(arrival_start) << " to "
              << jd_to_date_string(arrival_end) << "\n";
    std::cout << "Grid: " << launch_steps << " x " << arrival_steps << " = "
              << launch_steps * arrival_steps << " transfer solutions\n\n";

    std::cout << "Computing porkchop plot..." << std::flush;

    auto porkchop = InterplanetaryPlanner::generate_porkchop(
        Planet::EARTH, Planet::MARS,
        launch_start, launch_end, launch_steps,
        arrival_start, arrival_end, arrival_steps);

    std::cout << " done (" << porkchop.size() << " points computed)\n";

    // Find optimal transfer (minimum total delta-V)
    double best_dv = std::numeric_limits<double>::infinity();
    double best_c3 = std::numeric_limits<double>::infinity();
    PorkchopPoint best_point;
    int valid_count = 0;

    for (const auto& pt : porkchop) {
        if (pt.valid) {
            valid_count++;
            if (pt.total_delta_v < best_dv) {
                best_dv = pt.total_delta_v;
                best_point = pt;
            }
            if (pt.c3_departure < best_c3 && pt.c3_departure > 0.0) {
                best_c3 = pt.c3_departure;
            }
        }
    }

    std::cout << "Valid solutions: " << valid_count << " / " << porkchop.size() << "\n\n";

    print_subsection("Optimal Transfer (Minimum ΔV)");
    std::cout << "Launch date:     " << jd_to_date_string(best_point.launch_jd) << "\n";
    std::cout << "Arrival date:    " << jd_to_date_string(best_point.arrival_jd) << "\n";
    std::cout << "TOF:             " << std::setprecision(1)
              << (best_point.arrival_jd - best_point.launch_jd) << " days\n";
    std::cout << "C3 departure:    " << std::setprecision(2) << best_point.c3_departure
              << " km²/s²\n";
    std::cout << "C3 arrival:      " << std::setprecision(2) << best_point.c3_arrival
              << " km²/s²\n";
    std::cout << "Total ΔV:        " << std::setprecision(1) << best_point.total_delta_v
              << " m/s (" << std::setprecision(2) << best_point.total_delta_v / 1000.0
              << " km/s)\n";
    std::cout << "Min C3 in grid:  " << std::setprecision(2) << best_c3 << " km²/s²\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 3: Detailed Lambert Transfer
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 3: DETAILED LAMBERT TRANSFER");

    double launch_jd = best_point.launch_jd;
    double arrival_jd = best_point.arrival_jd;

    C3Result transfer = InterplanetaryPlanner::compute_transfer(
        Planet::EARTH, Planet::MARS, launch_jd, arrival_jd);

    std::cout << "Transfer orbit solution:\n";
    std::cout << "  Launch:           " << jd_to_date_string(launch_jd) << "\n";
    std::cout << "  Arrival:          " << jd_to_date_string(arrival_jd) << "\n";
    std::cout << "  TOF:              " << std::setprecision(1) << transfer.tof / 86400.0
              << " days\n\n";

    std::cout << "Departure (from 200 km LEO):\n";
    std::cout << "  C3:               " << std::setprecision(3) << transfer.c3_departure
              << " km²/s²\n";
    std::cout << "  V∞ departure:     " << std::setprecision(1) << transfer.v_inf_departure
              << " m/s (" << std::setprecision(2) << transfer.v_inf_departure / 1000.0
              << " km/s)\n";

    // Departure delta-V from 200 km LEO
    double park_r_earth = 6371000.0 + 200e3;  // 200 km altitude
    double dv_depart = InterplanetaryPlanner::departure_delta_v(
        transfer.c3_departure, park_r_earth, OrbitalMechanics::MU_EARTH);
    std::cout << "  ΔV departure:     " << std::setprecision(1) << dv_depart
              << " m/s (" << std::setprecision(3) << dv_depart / 1000.0 << " km/s)\n";

    double v_park = std::sqrt(OrbitalMechanics::MU_EARTH / park_r_earth);
    std::cout << "  V_circular (LEO): " << std::setprecision(1) << v_park << " m/s\n\n";

    std::cout << "Arrival (into 200 km Mars orbit):\n";
    std::cout << "  C3:               " << std::setprecision(3) << transfer.c3_arrival
              << " km²/s²\n";
    std::cout << "  V∞ arrival:       " << std::setprecision(1) << transfer.v_inf_arrival
              << " m/s (" << std::setprecision(2) << transfer.v_inf_arrival / 1000.0
              << " km/s)\n";

    double park_r_mars = MARS_RADIUS + 200e3;
    double dv_capture = InterplanetaryPlanner::capture_delta_v(
        transfer.v_inf_arrival, park_r_mars, MARS_MU);
    std::cout << "  ΔV capture:       " << std::setprecision(1) << dv_capture
              << " m/s (" << std::setprecision(3) << dv_capture / 1000.0 << " km/s)\n\n";

    double dv_total = dv_depart + dv_capture;
    std::cout << "Mission ΔV budget:\n";
    std::cout << "  Departure:        " << std::setprecision(1) << dv_depart << " m/s\n";
    std::cout << "  Capture:          " << std::setprecision(1) << dv_capture << " m/s\n";
    std::cout << "  Total:            " << std::setprecision(1) << dv_total
              << " m/s (" << std::setprecision(2) << dv_total / 1000.0 << " km/s)\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 4: Build Trajectory Arc
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 4: TRAJECTORY ARC (1000 SAMPLES)");

    MissionLeg leg = InterplanetaryPlanner::build_leg(
        Planet::EARTH, Planet::MARS, launch_jd, arrival_jd, 1000);

    std::cout << "Trajectory: " << leg.name << "\n";
    std::cout << "  Samples: " << leg.trajectory.size() << "\n";

    if (!leg.trajectory.empty()) {
        // Show a few waypoints
        std::cout << "\n  Sample waypoints (heliocentric, AU):\n";
        std::cout << "  " << std::setw(8) << "Day" << std::setw(12) << "R [AU]"
                  << std::setw(12) << "X [AU]" << std::setw(12) << "Y [AU]"
                  << std::setw(12) << "Z [AU]" << "\n";
        std::cout << "  " << std::string(56, '-') << "\n";

        int indices[] = {0, 100, 250, 500, 750, 999};
        for (int idx : indices) {
            if (idx < static_cast<int>(leg.trajectory.size())) {
                const auto& sv = leg.trajectory[idx];
                double r_au = sv.position.norm() / AU_M;
                double day = sv.time / 86400.0;
                std::cout << "  " << std::setprecision(1) << std::setw(8) << day
                          << std::setprecision(4)
                          << std::setw(12) << r_au
                          << std::setw(12) << sv.position.x / AU_M
                          << std::setw(12) << sv.position.y / AU_M
                          << std::setw(12) << sv.position.z / AU_M << "\n";
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 5: N-Body Propagation Comparison
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 5: N-BODY vs LAMBERT COMPARISON");

    std::cout << "Setting up N-body propagation (Sun + Mars + Jupiter)...\n";
    std::cout << "(Earth excluded — spacecraft starts from Earth's center)\n\n";

    // Create N-body configuration for heliocentric transfer comparison
    // Exclude Earth since we start at its center (patched-conic departure)
    NBodyConfig nbody_config;
    nbody_config.bodies = {
        {Planet::MARS,    false},
        {Planet::JUPITER, false}
    };
    nbody_config.central_body = Planet::EARTH;
    nbody_config.epoch_jd = launch_jd;

    // Initial state: spacecraft departing Earth on transfer orbit
    // Use Lambert's departure velocity in HCI
    StateVector initial_hci;
    initial_hci.position = PlanetaryEphemeris::get_position_hci(Planet::EARTH, launch_jd);
    initial_hci.velocity = transfer.v_departure_hci;
    initial_hci.time = 0.0;
    initial_hci.frame = CoordinateFrame::HELIOCENTRIC_J2000;

    // Propagate with adaptive integrator
    AdaptiveConfig adapt_config = AdaptiveConfig::interplanetary();
    auto deriv_fn = NBodyGravity::make_derivative_function(nbody_config, launch_jd);

    double tof = transfer.tof;
    std::cout << "Propagating " << std::setprecision(1) << tof / 86400.0
              << " days with Dormand-Prince adaptive integrator...\n";

    auto nbody_traj = AdaptiveIntegrator::propagate(
        initial_hci, tof, deriv_fn, adapt_config, tof / 100.0);

    std::cout << "N-body propagation: " << nbody_traj.size() << " output points\n\n";

    // Compare final positions
    if (!nbody_traj.empty() && !leg.trajectory.empty()) {
        Vec3 lambert_final = leg.trajectory.back().position;
        Vec3 nbody_final = nbody_traj.back().position;

        // Mars position at arrival
        Vec3 mars_arrival = PlanetaryEphemeris::get_position_hci(Planet::MARS, arrival_jd);

        // Position differences
        Vec3 diff_lm(lambert_final.x - mars_arrival.x,
                     lambert_final.y - mars_arrival.y,
                     lambert_final.z - mars_arrival.z);
        Vec3 diff_nb(nbody_final.x - mars_arrival.x,
                     nbody_final.y - mars_arrival.y,
                     nbody_final.z - mars_arrival.z);
        Vec3 diff_ln(nbody_final.x - lambert_final.x,
                     nbody_final.y - lambert_final.y,
                     nbody_final.z - lambert_final.z);

        std::cout << "Arrival accuracy (distance from Mars):\n";
        std::cout << "  Lambert (patched-conic): " << std::setprecision(0)
                  << diff_lm.norm() / 1e3 << " km\n";
        std::cout << "  N-body (Dormand-Prince): " << std::setprecision(0)
                  << diff_nb.norm() / 1e3 << " km\n";
        std::cout << "  Lambert vs N-body diff:  " << std::setprecision(0)
                  << diff_ln.norm() / 1e3 << " km\n\n";

        std::cout << "This difference represents the perturbation from Jupiter's gravity\n";
        std::cout << "and other bodies not captured in the two-body Lambert solution.\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 6: Mars Atmosphere Check
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 6: MARS ATMOSPHERE MODEL");

    std::cout << "Mars atmospheric profile:\n\n";
    std::cout << std::setw(12) << "Altitude"
              << std::setw(15) << "Density"
              << std::setw(12) << "Pressure"
              << std::setw(12) << "Temp"
              << std::setw(15) << "Speed of Sound" << "\n";
    std::cout << std::setw(12) << "[km]"
              << std::setw(15) << "[kg/m³]"
              << std::setw(12) << "[Pa]"
              << std::setw(12) << "[K]"
              << std::setw(15) << "[m/s]" << "\n";
    std::cout << std::string(66, '-') << "\n";

    double altitudes[] = {0, 5, 10, 20, 40, 60, 80, 100, 150, 200};
    for (double alt_km : altitudes) {
        MarsAtmosphereState atm = MarsAtmosphereModel::get_atmosphere(alt_km * 1000.0);
        std::cout << std::setprecision(0) << std::setw(12) << alt_km;
        std::cout << std::setprecision(6) << std::setw(15) << atm.density;
        std::cout << std::setprecision(3) << std::setw(12) << atm.pressure;
        std::cout << std::setprecision(1) << std::setw(12) << atm.temperature;
        std::cout << std::setprecision(1) << std::setw(15) << atm.speed_of_sound << "\n";
    }

    std::cout << "\nMars Kármán line: " << MarsAtmosphereModel::MARS_KARMAN / 1000.0 << " km\n";
    std::cout << "Surface gravity:  " << MarsAtmosphereModel::MARS_G0 << " m/s²\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 7: Mission Sequence (Earth-Venus-Mars Tour)
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 7: MULTI-LEG MISSION DESIGN (E-V-M)");

    std::cout << "Building Earth → Venus → Mars tour...\n\n";

    // Earth-Venus-Mars approximate dates
    double jd_dep_evm = calendar_to_jd(2026, 8, 1.0);
    double jd_venus   = calendar_to_jd(2026, 12, 15.0);
    double jd_arr_evm = calendar_to_jd(2027, 7, 1.0);

    std::vector<Planet> evm_bodies = {Planet::EARTH, Planet::VENUS, Planet::MARS};
    std::vector<double> evm_dates = {jd_dep_evm, jd_venus, jd_arr_evm};

    MissionSequence evm_mission = MissionDesigner::build_mission(evm_bodies, evm_dates);

    if (evm_mission.valid) {
        std::cout << "Mission:     " << evm_mission.name << "\n";
        std::cout << "Total ΔV:    " << std::setprecision(1) << evm_mission.total_delta_v
                  << " m/s (" << std::setprecision(2) << evm_mission.total_delta_v / 1000.0
                  << " km/s)\n";
        std::cout << "Total TOF:   " << std::setprecision(1) << evm_mission.total_tof_days()
                  << " days\n";
        std::cout << "Departure C3: " << std::setprecision(2) << evm_mission.departure_c3
                  << " km²/s²\n\n";

        auto summaries = MissionDesigner::summarize_encounters(evm_mission);
        for (const auto& es : summaries) {
            std::cout << "  " << planet_to_string(es.body) << " (JD "
                      << std::setprecision(1) << es.jd << "):\n";
            if (es.v_inf_in > 0.0)
                std::cout << "    V∞ in:     " << std::setprecision(0) << es.v_inf_in << " m/s\n";
            if (es.v_inf_out > 0.0)
                std::cout << "    V∞ out:    " << std::setprecision(0) << es.v_inf_out << " m/s\n";
            if (es.delta_v > 0.0)
                std::cout << "    ΔV:        " << std::setprecision(0) << es.delta_v << " m/s\n";
            if (es.turn_angle > 0.01)
                std::cout << "    Turn:      " << std::setprecision(1)
                          << es.turn_angle * 180.0 / PI << "°\n";
            if (es.periapsis_alt > 0.0)
                std::cout << "    Periapsis: " << std::setprecision(0)
                          << es.periapsis_alt / 1000.0 << " km\n";
        }
    } else {
        std::cout << "  (Mission design did not converge — dates may need adjustment)\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 8: Export JSON for Visualization
    // ═══════════════════════════════════════════════════════════

    print_separator("PHASE 8: JSON EXPORT FOR VISUALIZATION");

    // Export porkchop data
    {
        std::string porkchop_file = "interplanetary_porkchop.json";
        std::ofstream file(porkchop_file);
        if (file.is_open()) {
            file << "{\n";
            file << "  \"departure_planet\": \"Earth\",\n";
            file << "  \"arrival_planet\": \"Mars\",\n";
            file << std::fixed;
            file << "  \"launch_jd_start\": " << std::setprecision(1) << launch_start << ",\n";
            file << "  \"launch_jd_end\": " << std::setprecision(1) << launch_end << ",\n";
            file << "  \"arrival_jd_start\": " << std::setprecision(1) << arrival_start << ",\n";
            file << "  \"arrival_jd_end\": " << std::setprecision(1) << arrival_end << ",\n";
            file << "  \"launch_steps\": " << launch_steps << ",\n";
            file << "  \"arrival_steps\": " << arrival_steps << ",\n";

            // Best point
            file << "  \"optimal\": {\n";
            file << "    \"launch_jd\": " << std::setprecision(2) << best_point.launch_jd << ",\n";
            file << "    \"arrival_jd\": " << std::setprecision(2) << best_point.arrival_jd << ",\n";
            file << "    \"c3_departure\": " << std::setprecision(3) << best_point.c3_departure << ",\n";
            file << "    \"total_delta_v\": " << std::setprecision(1) << best_point.total_delta_v << "\n";
            file << "  },\n";

            // Grid data
            file << "  \"grid\": [\n";
            bool first = true;
            for (const auto& pt : porkchop) {
                if (!first) file << ",\n";
                first = false;
                file << "    {"
                     << "\"lj\":" << std::setprecision(2) << pt.launch_jd << ","
                     << "\"aj\":" << std::setprecision(2) << pt.arrival_jd << ","
                     << "\"c3\":" << std::setprecision(3) << (pt.valid ? pt.c3_departure : -1.0) << ","
                     << "\"dv\":" << std::setprecision(1) << (pt.valid ? pt.total_delta_v : -1.0) << ","
                     << "\"v\":" << (pt.valid ? "true" : "false")
                     << "}";
            }
            file << "\n  ]\n";
            file << "}\n";
            file.close();
            std::cout << "Porkchop data: " << porkchop_file << " (" << porkchop.size() << " points)\n";
        }
    }

    // Export direct transfer trajectory
    {
        std::string traj_file = "interplanetary_trajectory.json";
        std::ofstream file(traj_file);
        if (file.is_open()) {
            file << "{\n";
            file << std::fixed;
            file << "  \"mission\": \"Earth to Mars Direct Transfer\",\n";
            file << "  \"launch_jd\": " << std::setprecision(2) << launch_jd << ",\n";
            file << "  \"arrival_jd\": " << std::setprecision(2) << arrival_jd << ",\n";
            file << "  \"tof_days\": " << std::setprecision(1) << (arrival_jd - launch_jd) << ",\n";
            file << "  \"c3_departure\": " << std::setprecision(3) << transfer.c3_departure << ",\n";
            file << "  \"total_delta_v\": " << std::setprecision(1) << dv_total << ",\n";

            // Lambert trajectory (HCI)
            file << "  \"trajectory_hci\": [\n";
            for (size_t i = 0; i < leg.trajectory.size(); i++) {
                if (i > 0) file << ",\n";
                file << std::setprecision(0)
                     << "    [" << leg.trajectory[i].position.x
                     << ", " << leg.trajectory[i].position.y
                     << ", " << leg.trajectory[i].position.z << "]";
            }
            file << "\n  ],\n";

            // N-body trajectory (HCI)
            file << "  \"nbody_trajectory_hci\": [\n";
            for (size_t i = 0; i < nbody_traj.size(); i++) {
                if (i > 0) file << ",\n";
                file << std::setprecision(0)
                     << "    [" << nbody_traj[i].position.x
                     << ", " << nbody_traj[i].position.y
                     << ", " << nbody_traj[i].position.z << "]";
            }
            file << "\n  ],\n";

            // Planet positions at departure and arrival
            file << "  \"earth_departure\": [" << std::setprecision(0)
                 << earth_pos.x << ", " << earth_pos.y << ", " << earth_pos.z << "],\n";

            Vec3 earth_arr = PlanetaryEphemeris::get_position_hci(Planet::EARTH, arrival_jd);
            Vec3 mars_arr = PlanetaryEphemeris::get_position_hci(Planet::MARS, arrival_jd);
            file << "  \"earth_arrival\": [" << std::setprecision(0)
                 << earth_arr.x << ", " << earth_arr.y << ", " << earth_arr.z << "],\n";
            file << "  \"mars_arrival\": [" << std::setprecision(0)
                 << mars_arr.x << ", " << mars_arr.y << ", " << mars_arr.z << "],\n";

            // Planet orbits for context
            file << "  \"earth_orbit\": [\n";
            for (int j = 0; j <= 360; j++) {
                double t = launch_jd + j * 365.25 / 360;
                Vec3 p = PlanetaryEphemeris::get_position_hci(Planet::EARTH, t);
                if (j > 0) file << ",\n";
                file << "    [" << std::setprecision(0) << p.x << ", " << p.y << ", " << p.z << "]";
            }
            file << "\n  ],\n";

            file << "  \"mars_orbit\": [\n";
            for (int j = 0; j <= 360; j++) {
                double t = launch_jd + j * 687.0 / 360;
                Vec3 p = PlanetaryEphemeris::get_position_hci(Planet::MARS, t);
                if (j > 0) file << ",\n";
                file << "    [" << std::setprecision(0) << p.x << ", " << p.y << ", " << p.z << "]";
            }
            file << "\n  ]\n";

            file << "}\n";
            file.close();
            std::cout << "Trajectory data: " << traj_file << "\n";
        }
    }

    // Export EVM mission if valid
    if (evm_mission.valid) {
        std::string evm_file = "interplanetary_evm_mission.json";
        MissionDesigner::export_mission_json(evm_mission, evm_file);
        std::cout << "E-V-M mission:  " << evm_file << "\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════

    print_separator("MISSION SUMMARY");

    std::cout << "Direct Earth-Mars Transfer (2026 Window)\n";
    std::cout << "  Launch:       " << jd_to_date_string(launch_jd) << "\n";
    std::cout << "  Arrival:      " << jd_to_date_string(arrival_jd) << "\n";
    std::cout << "  TOF:          " << std::setprecision(0)
              << (arrival_jd - launch_jd) << " days\n";
    std::cout << "  C3:           " << std::setprecision(2)
              << transfer.c3_departure << " km²/s²\n";
    std::cout << "  Departure ΔV: " << std::setprecision(0) << dv_depart << " m/s\n";
    std::cout << "  Capture ΔV:   " << std::setprecision(0) << dv_capture << " m/s\n";
    std::cout << "  Total ΔV:     " << std::setprecision(0) << dv_total
              << " m/s (" << std::setprecision(2) << dv_total / 1000.0 << " km/s)\n\n";

    std::cout << "Phase 4 interplanetary trajectory design complete.\n";
    std::cout << "JSON files exported for CesiumJS solar system visualization.\n";

    return 0;
}
