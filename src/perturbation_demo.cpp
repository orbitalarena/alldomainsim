/**
 * Perturbation Fidelity Comparison Demo
 *
 * Propagates an ISS-like orbit (400 km, 51.6 deg inclination) for 30 days
 * with four fidelity levels:
 *
 *   Case A: Two-body only (Keplerian reference)
 *   Case B: J2 only (RAAN drift, omega precession)
 *   Case C: J2 + J3 + J4 (subtle corrections)
 *   Case D: Full fidelity (J2-J4 + Moon + Sun + SRP + drag)
 *
 * Outputs a comparison table and perturbation_data.json for visualization.
 */

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/orbital_perturbations.hpp"
#include "physics/gravity_utils.hpp"
#include "propagators/rk4_integrator.hpp"
#include "coordinate/frame_transformer.hpp"
#include "coordinate/time_utils.hpp"
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <vector>

using namespace sim;

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;

// ISS-like orbit
constexpr double ORBIT_ALT = 400000.0;        // 400 km altitude [m]
constexpr double ORBIT_INC = 51.6 * DEG_TO_RAD;  // ISS inclination
constexpr double ORBIT_ECC = 0.0005;           // Near-circular

// Propagation
constexpr double SIM_DURATION = 30.0 * 86400.0;  // 30 days [s]
constexpr double DT = 30.0;                       // 30 second time step
constexpr double OUTPUT_INTERVAL = 3600.0;        // Output every hour
constexpr double DAILY_INTERVAL = 86400.0;        // Summary every day

// Epoch: 2026-01-30 12:00:00 UTC
constexpr double EPOCH_JD = 2461045.0;

// Spacecraft properties (ISS-like)
constexpr double SC_MASS = 420000.0;    // kg
constexpr double SC_AREA = 1600.0;      // m^2 (cross-section)
constexpr double SC_CD = 2.2;           // Drag coefficient
constexpr double SC_CR = 1.5;           // Reflectivity

// ═══════════════════════════════════════════════════════════════
// PROPAGATION CASE
// ═══════════════════════════════════════════════════════════════

struct CaseResult {
    std::string name;
    std::vector<double> times;          // seconds
    std::vector<double> altitudes;      // km
    std::vector<double> sma;            // km
    std::vector<double> ecc;
    std::vector<double> inc_deg;
    std::vector<double> raan_deg;
    std::vector<double> argpe_deg;
    std::vector<StateVector> states;
};

CaseResult propagate_case(
    const std::string& name,
    const StateVector& initial_state,
    const PerturbationConfig& config) {

    CaseResult result;
    result.name = name;

    auto deriv_func = OrbitalPerturbations::make_derivative_function(config, EPOCH_JD);

    StateVector state = initial_state;
    double t = 0.0;
    double next_output = 0.0;

    while (t <= SIM_DURATION) {
        if (t >= next_output) {
            double alt_km = (state.position.norm() - EARTH_RADIUS) / 1000.0;
            OrbitalElements oe = OrbitalMechanics::state_to_elements(state);

            result.times.push_back(t);
            result.altitudes.push_back(alt_km);
            result.sma.push_back(oe.semi_major_axis / 1000.0);
            result.ecc.push_back(oe.eccentricity);
            result.inc_deg.push_back(oe.inclination * RAD_TO_DEG);
            result.raan_deg.push_back(oe.raan * RAD_TO_DEG);
            result.argpe_deg.push_back(oe.arg_periapsis * RAD_TO_DEG);
            result.states.push_back(state);

            next_output += OUTPUT_INTERVAL;
        }

        state = RK4Integrator::step(state, DT, deriv_func);
        t += DT;
        state.time = t;
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════
// INITIAL STATE
// ═══════════════════════════════════════════════════════════════

StateVector create_initial_state() {
    // Create ISS-like orbit from orbital elements
    double a = EARTH_RADIUS + ORBIT_ALT;
    OrbitalElements oe(a, ORBIT_ECC, ORBIT_INC, 0.0, 0.0, 0.0);

    StateVector state = OrbitalMechanics::elements_to_state(oe);
    state.time = 0.0;
    state.frame = CoordinateFrame::J2000_ECI;

    return state;
}

// ═══════════════════════════════════════════════════════════════
// PERTURBATION BREAKDOWN
// ═══════════════════════════════════════════════════════════════

void print_perturbation_magnitudes(const StateVector& state) {
    PerturbationConfig full = PerturbationConfig::full_fidelity();
    full.epoch_jd = EPOCH_JD;
    full.drag_mass = SC_MASS;
    full.drag_area = SC_AREA;
    full.drag_cd = SC_CD;
    full.srp_params = SRPParameters{SC_AREA, SC_MASS, SC_CR};

    PerturbationBreakdown bd = OrbitalPerturbations::compute_breakdown(
        state.position, state.velocity, full, EPOCH_JD);

    std::cout << "\n╔══════════════════════════════════════════════════╗\n";
    std::cout << "║       PERTURBATION MAGNITUDES AT EPOCH          ║\n";
    std::cout << "╠══════════════════════════════════════════════════╣\n";

    auto print_mag = [](const char* name, const Vec3& v) {
        double mag = v.norm();
        std::cout << "║  " << std::left << std::setw(20) << name
                  << std::right << std::scientific << std::setprecision(3)
                  << std::setw(12) << mag << " m/s²";
        if (mag > 0) {
            // Ratio to central body
            // (handled outside)
        }
        std::cout << "    ║\n";
    };

    print_mag("Central body", bd.central_body);
    print_mag("J2 oblateness", bd.j2);
    print_mag("J3 asymmetry", bd.j3);
    print_mag("J4 higher-order", bd.j4);
    print_mag("Moon (3rd body)", bd.moon);
    print_mag("Sun (3rd body)", bd.sun);
    print_mag("SRP", bd.srp);
    print_mag("Atm. drag", bd.drag);
    std::cout << "╠══════════════════════════════════════════════════╣\n";
    print_mag("TOTAL", bd.total);
    std::cout << "╚══════════════════════════════════════════════════╝\n\n";
}

// ═══════════════════════════════════════════════════════════════
// DAILY COMPARISON TABLE
// ═══════════════════════════════════════════════════════════════

void print_daily_table(
    const CaseResult& a,
    const CaseResult& b,
    const CaseResult& c,
    const CaseResult& d) {

    std::cout << "╔═════════════════════════════════════════════════════════════════════════════════════════╗\n";
    std::cout << "║                        30-DAY ORBITAL ELEMENT EVOLUTION                               ║\n";
    std::cout << "╠═════╦════════════════════╦════════════════════╦════════════════════╦════════════════════╣\n";
    std::cout << "║ Day ║   A: Two-Body      ║   B: J2            ║   C: J2+J3+J4      ║   D: Full          ║\n";
    std::cout << "║     ║ alt(km) RAAN(°)    ║ alt(km) RAAN(°)    ║ alt(km) RAAN(°)    ║ alt(km) RAAN(°)    ║\n";
    std::cout << "╠═════╬════════════════════╬════════════════════╬════════════════════╬════════════════════╣\n";

    // Find indices at daily intervals
    for (int day = 0; day <= 30; day++) {
        double target_t = day * DAILY_INTERVAL;
        // Find closest index in hourly data
        size_t idx = static_cast<size_t>(day * 24);
        if (idx >= a.altitudes.size()) idx = a.altitudes.size() - 1;

        std::cout << "║ " << std::setw(3) << day << " ";
        std::cout << std::fixed << std::setprecision(1);

        auto print_case = [&](const CaseResult& r) {
            if (idx < r.altitudes.size()) {
                std::cout << "║ " << std::setw(7) << r.altitudes[idx]
                          << " " << std::setw(9) << r.raan_deg[idx] << "  ";
            } else {
                std::cout << "║       ---     ---    ";
            }
        };

        print_case(a);
        print_case(b);
        print_case(c);
        print_case(d);

        std::cout << "║\n";
    }

    std::cout << "╚═════╩════════════════════╩════════════════════╩════════════════════╩════════════════════╝\n";
}

// ═══════════════════════════════════════════════════════════════
// JSON EXPORT
// ═══════════════════════════════════════════════════════════════

void export_json(
    const CaseResult& a,
    const CaseResult& b,
    const CaseResult& c,
    const CaseResult& d,
    const std::string& filename) {

    std::ofstream file(filename);
    if (!file.is_open()) {
        std::cerr << "Error: Could not open " << filename << " for writing\n";
        return;
    }

    auto write_case = [&](const CaseResult& r, bool last) {
        file << "    \"" << r.name << "\": {\n";
        file << "      \"times\": [";
        for (size_t i = 0; i < r.times.size(); i++) {
            if (i > 0) file << ",";
            // Sample every 6 hours for manageable file size
            if (i % 6 == 0) {
                file << r.times[i];
            }
        }
        // Re-do: write sampled data
        file.seekp(0); // can't seekp in the middle easily, just write all
        file.clear();
        // Simplified: write sampled arrays
        file << "    \"" << r.name << "\": {\n";

        // Write sampled time/element arrays (every 6 hours = every 6th index)
        auto write_array = [&](const char* name, const std::vector<double>& arr, int precision) {
            file << "      \"" << name << "\": [";
            bool first = true;
            for (size_t i = 0; i < arr.size(); i += 6) {
                if (!first) file << ",";
                file << std::fixed << std::setprecision(precision) << arr[i];
                first = false;
            }
            file << "],\n";
        };

        write_array("time_s", r.times, 0);
        write_array("altitude_km", r.altitudes, 3);
        write_array("sma_km", r.sma, 3);
        write_array("eccentricity", r.ecc, 8);
        write_array("inclination_deg", r.inc_deg, 4);
        write_array("raan_deg", r.raan_deg, 4);

        // Last array: no trailing comma
        file << "      \"argpe_deg\": [";
        bool first = true;
        for (size_t i = 0; i < r.argpe_deg.size(); i += 6) {
            if (!first) file << ",";
            file << std::fixed << std::setprecision(4) << r.argpe_deg[i];
            first = false;
        }
        file << "]\n";

        file << "    }" << (last ? "" : ",") << "\n";
    };

    // Restart file cleanly
    file.close();
    file.open(filename, std::ios::trunc);

    file << "{\n";
    file << "  \"description\": \"Perturbation fidelity comparison - ISS-like orbit, 30 days\",\n";
    file << "  \"epoch_jd\": " << std::fixed << std::setprecision(1) << EPOCH_JD << ",\n";
    file << "  \"orbit\": {\n";
    file << "    \"altitude_km\": " << ORBIT_ALT / 1000.0 << ",\n";
    file << "    \"inclination_deg\": " << ORBIT_INC * RAD_TO_DEG << ",\n";
    file << "    \"eccentricity\": " << ORBIT_ECC << "\n";
    file << "  },\n";
    file << "  \"spacecraft\": {\n";
    file << "    \"mass_kg\": " << SC_MASS << ",\n";
    file << "    \"area_m2\": " << SC_AREA << ",\n";
    file << "    \"cd\": " << SC_CD << ",\n";
    file << "    \"cr\": " << SC_CR << "\n";
    file << "  },\n";
    file << "  \"cases\": {\n";

    write_case(a, false);
    write_case(b, false);
    write_case(c, false);
    write_case(d, true);

    file << "  }\n";
    file << "}\n";

    file.close();
    std::cout << "Exported to " << filename << "\n";
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

int main() {
    std::cout << "═══════════════════════════════════════════════════════════════\n";
    std::cout << "  PHASE 2: ORBITAL PERTURBATION FIDELITY COMPARISON\n";
    std::cout << "═══════════════════════════════════════════════════════════════\n\n";

    std::cout << "Orbit: " << ORBIT_ALT / 1000.0 << " km altitude, "
              << ORBIT_INC * RAD_TO_DEG << " deg inclination, "
              << "e = " << ORBIT_ECC << "\n";
    std::cout << "Duration: 30 days | dt: " << DT << " s\n";
    std::cout << "Spacecraft: " << SC_MASS << " kg, "
              << SC_AREA << " m² cross-section\n\n";

    // Create initial state
    StateVector initial = create_initial_state();

    double alt_km = (initial.position.norm() - EARTH_RADIUS) / 1000.0;
    double v_kms = initial.velocity.norm() / 1000.0;
    std::cout << "Initial state: r = " << initial.position.norm() / 1000.0
              << " km, v = " << v_kms << " km/s, alt = " << alt_km << " km\n";

    // Print perturbation magnitudes at epoch
    print_perturbation_magnitudes(initial);

    // ─── Case A: Two-body only ───
    std::cout << "Propagating Case A (Two-body)...\n";
    PerturbationConfig config_a = PerturbationConfig::two_body_only();
    config_a.epoch_jd = EPOCH_JD;
    CaseResult case_a = propagate_case("two_body", initial, config_a);

    // ─── Case B: J2 only ───
    std::cout << "Propagating Case B (J2)...\n";
    PerturbationConfig config_b = PerturbationConfig::j2_only();
    config_b.epoch_jd = EPOCH_JD;
    CaseResult case_b = propagate_case("j2_only", initial, config_b);

    // ─── Case C: J2 + J3 + J4 ───
    std::cout << "Propagating Case C (J2+J3+J4)...\n";
    PerturbationConfig config_c = PerturbationConfig::full_harmonics();
    config_c.epoch_jd = EPOCH_JD;
    CaseResult case_c = propagate_case("j2_j3_j4", initial, config_c);

    // ─── Case D: Full fidelity ───
    std::cout << "Propagating Case D (Full: J2-J4 + Moon + Sun + SRP + drag)...\n";
    PerturbationConfig config_d = PerturbationConfig::full_fidelity();
    config_d.epoch_jd = EPOCH_JD;
    config_d.drag_mass = SC_MASS;
    config_d.drag_area = SC_AREA;
    config_d.drag_cd = SC_CD;
    config_d.srp_params = SRPParameters{SC_AREA, SC_MASS, SC_CR};
    CaseResult case_d = propagate_case("full_fidelity", initial, config_d);

    // Print daily comparison
    std::cout << "\n";
    print_daily_table(case_a, case_b, case_c, case_d);

    // Print final summary
    std::cout << "\n╔══════════════════════════════════════════════════╗\n";
    std::cout << "║              FINAL STATE (DAY 30)                ║\n";
    std::cout << "╠══════════════════════════════════════════════════╣\n";

    auto print_final = [](const char* label, const CaseResult& r) {
        size_t last = r.altitudes.size() - 1;
        std::cout << "║  " << std::left << std::setw(12) << label
                  << std::fixed << std::setprecision(2)
                  << " alt=" << std::setw(8) << r.altitudes[last] << " km"
                  << "  RAAN=" << std::setw(8) << r.raan_deg[last] << "°"
                  << " ║\n";
    };

    print_final("Two-body", case_a);
    print_final("J2", case_b);
    print_final("J2+J3+J4", case_c);
    print_final("Full", case_d);

    std::cout << "╠══════════════════════════════════════════════════╣\n";

    // Altitude difference between cases
    size_t last = case_a.altitudes.size() - 1;
    double delta_alt = case_a.altitudes[last] - case_d.altitudes[last];
    double delta_raan = case_a.raan_deg[last] - case_d.raan_deg[last];

    std::cout << "║  Altitude decay (full):  "
              << std::fixed << std::setprecision(2) << delta_alt << " km"
              << std::string(std::max(0, 14 - static_cast<int>(std::to_string(static_cast<int>(delta_alt)).size())), ' ')
              << "║\n";
    std::cout << "║  RAAN drift (J2 vs 2B):  "
              << std::fixed << std::setprecision(2)
              << (case_b.raan_deg[last] - case_a.raan_deg[last]) << "°"
              << std::string(13, ' ') << "║\n";
    std::cout << "╚══════════════════════════════════════════════════╝\n\n";

    // Export JSON
    export_json(case_a, case_b, case_c, case_d, "perturbation_data.json");

    std::cout << "\nDone. Phase 2 perturbation models operational.\n";

    return 0;
}
