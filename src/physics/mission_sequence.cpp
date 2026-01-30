/**
 * Mission Sequence Designer Implementation
 *
 * Assembles multi-leg interplanetary tours with Lambert transfers,
 * gravity assists, and delta-V budgeting.
 */

#include "mission_sequence.hpp"
#include "interplanetary_planner.hpp"
#include "gravity_assist.hpp"
#include "planetary_ephemeris.hpp"
#include "celestial_body.hpp"
#include <cmath>
#include <fstream>
#include <algorithm>
#include <limits>

namespace sim {

// ─────────────────────────────────────────────────────────────
// Build mission from body sequence and dates
// ─────────────────────────────────────────────────────────────

MissionSequence MissionDesigner::build_mission(
    const std::vector<Planet>& bodies,
    const std::vector<double>& dates_jd,
    double departure_parking_alt,
    double arrival_parking_alt)
{
    MissionSequence mission;
    mission.body_sequence = bodies;
    mission.epoch_jd = dates_jd;
    mission.total_delta_v = 0.0;
    mission.departure_c3 = 0.0;
    mission.valid = false;

    if (bodies.size() < 2 || bodies.size() != dates_jd.size()) {
        return mission;
    }

    int num_legs = static_cast<int>(bodies.size()) - 1;

    // Build name from body sequence
    mission.name = "";
    for (size_t i = 0; i < bodies.size(); i++) {
        if (i > 0) mission.name += " → ";
        mission.name += planet_to_string(bodies[i]);
    }

    // ── Compute each Lambert leg ──

    for (int leg = 0; leg < num_legs; leg++) {
        Planet dep = bodies[leg];
        Planet arr = bodies[leg + 1];
        double jd_dep = dates_jd[leg];
        double jd_arr = dates_jd[leg + 1];

        // Build the transfer leg with sampled trajectory
        MissionLeg ml = InterplanetaryPlanner::build_leg(dep, arr, jd_dep, jd_arr, 500);

        // If build_leg didn't set delta_v, compute it
        if (ml.delta_v <= 0.0) {
            C3Result c3 = InterplanetaryPlanner::compute_transfer(
                dep, arr, jd_dep, jd_arr, departure_parking_alt, arrival_parking_alt);
            if (!c3.valid) {
                // Mission infeasible at this leg
                mission.legs.push_back(ml);
                return mission;
            }
            ml.delta_v = c3.total_delta_v;
            ml.v_inf_departure = Vec3(
                c3.v_departure_hci.x - PlanetaryEphemeris::get_velocity_hci(dep, jd_dep).x,
                c3.v_departure_hci.y - PlanetaryEphemeris::get_velocity_hci(dep, jd_dep).y,
                c3.v_departure_hci.z - PlanetaryEphemeris::get_velocity_hci(dep, jd_dep).z
            );
            ml.v_inf_arrival = Vec3(
                c3.v_arrival_hci.x - PlanetaryEphemeris::get_velocity_hci(arr, jd_arr).x,
                c3.v_arrival_hci.y - PlanetaryEphemeris::get_velocity_hci(arr, jd_arr).y,
                c3.v_arrival_hci.z - PlanetaryEphemeris::get_velocity_hci(arr, jd_arr).z
            );

            // Store departure C3 for first leg
            if (leg == 0) {
                mission.departure_c3 = c3.c3_departure;
            }
        }

        mission.legs.push_back(ml);
    }

    // ── Compute gravity assists at intermediate bodies ──

    for (int i = 1; i < num_legs; i++) {
        // Incoming v_inf: from leg (i-1) arrival
        Vec3 v_inf_in = mission.legs[i - 1].v_inf_arrival;

        // Outgoing v_inf: from leg (i) departure
        Vec3 v_inf_out = mission.legs[i].v_inf_departure;

        Planet flyby_body = bodies[i];
        const PlanetaryConstants& pc = PlanetaryConstants::get(flyby_body);

        // Compute the turn angle between incoming and outgoing v-infinity
        double v_in_mag = v_inf_in.norm();
        double v_out_mag = v_inf_out.norm();

        if (v_in_mag < 1e-3 || v_out_mag < 1e-3) {
            // Degenerate — skip flyby
            FlybyResult fr;
            fr.valid = false;
            fr.v_out_hci = Vec3(0, 0, 0);
            fr.periapsis_alt = 0.0;
            fr.turn_angle = 0.0;
            fr.delta_v_gained = 0.0;
            mission.flybys.push_back(fr);
            continue;
        }

        // Dot product to get turn angle
        double cos_turn = (v_inf_in.x * v_inf_out.x +
                          v_inf_in.y * v_inf_out.y +
                          v_inf_in.z * v_inf_out.z) / (v_in_mag * v_out_mag);
        cos_turn = std::max(-1.0, std::min(1.0, cos_turn));
        double turn_angle = std::acos(cos_turn);

        // Compute periapsis needed for this turn angle
        // For unpowered flyby: v_inf_in magnitude = v_inf_out magnitude
        // Use average v_inf for computation
        double v_inf_avg = 0.5 * (v_in_mag + v_out_mag);

        double rp = GravityAssist::periapsis_for_turn_angle(v_inf_avg, turn_angle, pc.mu);

        // Check feasibility: periapsis must be above planet surface
        double min_alt = 200e3;  // Minimum 200 km altitude
        double min_rp = pc.radius + min_alt;

        FlybyResult fr;
        if (rp >= min_rp) {
            // Feasible unpowered flyby
            fr = GravityAssist::compute_flyby(v_inf_in, rp, pc.mu);
        } else {
            // Infeasible — would need powered flyby
            // Compute at minimum periapsis and note the deficit
            fr = GravityAssist::compute_flyby(v_inf_in, min_rp, pc.mu);
            // The remaining turn must be achieved by a burn
            // Approximate additional delta-V needed
            double achieved_turn = fr.turn_angle;
            double remaining_turn = turn_angle - achieved_turn;
            if (remaining_turn > 0.0) {
                // Powered flyby: delta-V ≈ 2 * v_inf * sin(remaining_turn / 2)
                double dv_powered = 2.0 * v_inf_avg * std::sin(remaining_turn / 2.0);
                mission.total_delta_v += dv_powered;
            }
        }

        mission.flybys.push_back(fr);
    }

    // ── Compute total delta-V ──

    // Departure burn from first body
    if (!mission.legs.empty()) {
        Planet dep_body = bodies[0];
        const PlanetaryConstants& dep_pc = PlanetaryConstants::get(dep_body);
        double dep_radius = dep_pc.radius + departure_parking_alt;
        double v_inf_dep = mission.legs[0].v_inf_departure.norm();
        double c3_dep = (v_inf_dep * v_inf_dep) / 1e6;  // Convert to km²/s²
        mission.departure_c3 = c3_dep;
        double dv_dep = InterplanetaryPlanner::departure_delta_v(c3_dep, dep_radius, dep_pc.mu);
        mission.total_delta_v += dv_dep;
    }

    // Capture burn at final body
    if (!mission.legs.empty()) {
        Planet arr_body = bodies.back();
        const PlanetaryConstants& arr_pc = PlanetaryConstants::get(arr_body);
        double arr_radius = arr_pc.radius + arrival_parking_alt;
        double v_inf_arr = mission.legs.back().v_inf_arrival.norm();
        double dv_arr = InterplanetaryPlanner::capture_delta_v(v_inf_arr, arr_radius, arr_pc.mu);
        mission.total_delta_v += dv_arr;
    }

    mission.valid = true;
    return mission;
}

// ─────────────────────────────────────────────────────────────
// Date optimizer (coordinate descent + golden section)
// ─────────────────────────────────────────────────────────────

MissionSequence MissionDesigner::optimize_dates(
    const std::vector<Planet>& bodies,
    const std::vector<double>& initial_dates_jd,
    int max_iterations)
{
    if (bodies.size() < 3) {
        // No intermediate dates to optimize
        return build_mission(bodies, initial_dates_jd);
    }

    std::vector<double> dates = initial_dates_jd;
    double best_dv = compute_total_dv(bodies, dates);

    // Golden ratio for 1D search
    constexpr double phi = 0.381966011250105;  // (3 - sqrt(5)) / 2

    for (int iter = 0; iter < max_iterations; iter++) {
        bool improved = false;

        // Optimize each intermediate date (skip first and last)
        for (size_t i = 1; i < dates.size() - 1; i++) {
            double lower = dates[i - 1] + 10.0;  // At least 10 days after previous
            double upper = dates[i + 1] - 10.0;  // At least 10 days before next

            if (lower >= upper) continue;

            // Golden section search
            double a = lower;
            double b = upper;

            double x1 = a + phi * (b - a);
            double x2 = b - phi * (b - a);

            dates[i] = x1;
            double f1 = compute_total_dv(bodies, dates);

            dates[i] = x2;
            double f2 = compute_total_dv(bodies, dates);

            for (int gs = 0; gs < 30; gs++) {
                if (f1 < f2) {
                    b = x2;
                    x2 = x1;
                    f2 = f1;
                    x1 = a + phi * (b - a);
                    dates[i] = x1;
                    f1 = compute_total_dv(bodies, dates);
                } else {
                    a = x1;
                    x1 = x2;
                    f1 = f2;
                    x2 = b - phi * (b - a);
                    dates[i] = x2;
                    f2 = compute_total_dv(bodies, dates);
                }

                if (b - a < 0.1) break;  // Converged to 0.1 day
            }

            // Pick the best
            double best_local = (f1 < f2) ? x1 : x2;
            dates[i] = best_local;

            double new_dv = compute_total_dv(bodies, dates);
            if (new_dv < best_dv - 0.1) {
                best_dv = new_dv;
                improved = true;
            }
        }

        if (!improved) break;
    }

    return build_mission(bodies, dates);
}

// ─────────────────────────────────────────────────────────────
// Encounter summaries
// ─────────────────────────────────────────────────────────────

std::vector<EncounterSummary> MissionDesigner::summarize_encounters(
    const MissionSequence& mission)
{
    std::vector<EncounterSummary> summaries;

    for (size_t i = 0; i < mission.body_sequence.size(); i++) {
        EncounterSummary es;
        es.body = mission.body_sequence[i];
        es.jd = mission.epoch_jd[i];
        es.delta_v = 0.0;
        es.turn_angle = 0.0;
        es.periapsis_alt = 0.0;
        es.v_inf_in = 0.0;
        es.v_inf_out = 0.0;

        if (i == 0) {
            // Departure
            if (!mission.legs.empty()) {
                es.v_inf_out = mission.legs[0].v_inf_departure.norm();
            }
            // Compute departure delta-V
            const PlanetaryConstants& pc = PlanetaryConstants::get(es.body);
            double v_inf = es.v_inf_out;
            double c3 = (v_inf * v_inf) / 1e6;
            es.delta_v = InterplanetaryPlanner::departure_delta_v(
                c3, pc.radius + 200e3, pc.mu);
        }
        else if (i == mission.body_sequence.size() - 1) {
            // Arrival
            if (!mission.legs.empty()) {
                es.v_inf_in = mission.legs.back().v_inf_arrival.norm();
            }
            const PlanetaryConstants& pc = PlanetaryConstants::get(es.body);
            es.delta_v = InterplanetaryPlanner::capture_delta_v(
                es.v_inf_in, pc.radius + 200e3, pc.mu);
        }
        else {
            // Intermediate flyby
            int flyby_idx = static_cast<int>(i) - 1;
            if (flyby_idx < static_cast<int>(mission.flybys.size())) {
                const FlybyResult& fr = mission.flybys[flyby_idx];
                es.turn_angle = fr.turn_angle;
                es.periapsis_alt = fr.periapsis_alt;
                es.v_inf_in = fr.b_plane.v_inf_in;
                es.v_inf_out = fr.b_plane.v_inf_out;
            }
            if (static_cast<int>(i) - 1 < static_cast<int>(mission.legs.size())) {
                es.v_inf_in = mission.legs[i - 1].v_inf_arrival.norm();
            }
            if (i < mission.legs.size()) {
                es.v_inf_out = mission.legs[i].v_inf_departure.norm();
            }
        }

        summaries.push_back(es);
    }

    return summaries;
}

// ─────────────────────────────────────────────────────────────
// JSON export
// ─────────────────────────────────────────────────────────────

void MissionDesigner::export_mission_json(
    const MissionSequence& mission,
    const std::string& filename)
{
    std::ofstream file(filename);
    if (!file.is_open()) return;

    file << "{\n";
    file << "  \"name\": \"" << mission.name << "\",\n";
    file << "  \"valid\": " << (mission.valid ? "true" : "false") << ",\n";
    file << "  \"total_delta_v_ms\": " << mission.total_delta_v << ",\n";
    file << "  \"departure_c3_km2s2\": " << mission.departure_c3 << ",\n";
    file << "  \"total_tof_days\": " << mission.total_tof_days() << ",\n";

    // Body sequence
    file << "  \"body_sequence\": [";
    for (size_t i = 0; i < mission.body_sequence.size(); i++) {
        if (i > 0) file << ", ";
        file << "\"" << planet_to_string(mission.body_sequence[i]) << "\"";
    }
    file << "],\n";

    // Epoch JDs
    file << "  \"epoch_jd\": [";
    for (size_t i = 0; i < mission.epoch_jd.size(); i++) {
        if (i > 0) file << ", ";
        file.precision(6);
        file << std::fixed << mission.epoch_jd[i];
    }
    file << "],\n";

    // Encounter summaries
    auto summaries = summarize_encounters(mission);
    file << "  \"encounters\": [\n";
    for (size_t i = 0; i < summaries.size(); i++) {
        const auto& es = summaries[i];
        file << "    {\n";
        file << "      \"body\": \"" << planet_to_string(es.body) << "\",\n";
        file.precision(6);
        file << "      \"jd\": " << std::fixed << es.jd << ",\n";
        file.precision(2);
        file << "      \"v_inf_in_ms\": " << std::fixed << es.v_inf_in << ",\n";
        file << "      \"v_inf_out_ms\": " << std::fixed << es.v_inf_out << ",\n";
        file << "      \"delta_v_ms\": " << std::fixed << es.delta_v << ",\n";
        file.precision(4);
        file << "      \"turn_angle_deg\": " << std::fixed << es.turn_angle * 180.0 / 3.14159265358979323846 << ",\n";
        file.precision(0);
        file << "      \"periapsis_alt_m\": " << std::fixed << es.periapsis_alt << "\n";
        file << "    }";
        if (i < summaries.size() - 1) file << ",";
        file << "\n";
    }
    file << "  ],\n";

    // Trajectory legs
    file << "  \"legs\": [\n";
    for (size_t leg = 0; leg < mission.legs.size(); leg++) {
        const auto& ml = mission.legs[leg];
        file << "    {\n";
        file << "      \"name\": \"" << ml.name << "\",\n";
        file << "      \"departure_body\": \"" << planet_to_string(ml.departure_body) << "\",\n";
        file << "      \"arrival_body\": \"" << planet_to_string(ml.arrival_body) << "\",\n";
        file.precision(6);
        file << "      \"departure_jd\": " << std::fixed << ml.departure_jd << ",\n";
        file << "      \"arrival_jd\": " << std::fixed << ml.arrival_jd << ",\n";
        file.precision(2);
        file << "      \"delta_v_ms\": " << std::fixed << ml.delta_v << ",\n";

        // Sampled trajectory positions (HCI)
        file << "      \"trajectory_hci\": [\n";
        // Sample at most 500 points for reasonable file size
        int stride = std::max(1, static_cast<int>(ml.trajectory.size()) / 500);
        bool first = true;
        for (size_t j = 0; j < ml.trajectory.size(); j += stride) {
            if (!first) file << ",\n";
            first = false;
            file.precision(0);
            file << "        [" << std::fixed
                 << ml.trajectory[j].position.x << ", "
                 << ml.trajectory[j].position.y << ", "
                 << ml.trajectory[j].position.z << "]";
        }
        file << "\n      ]\n";
        file << "    }";
        if (leg < mission.legs.size() - 1) file << ",";
        file << "\n";
    }
    file << "  ],\n";

    // Planet positions at encounters
    file << "  \"planet_positions_hci\": [\n";
    for (size_t i = 0; i < mission.body_sequence.size(); i++) {
        Vec3 pos = PlanetaryEphemeris::get_position_hci(mission.body_sequence[i], mission.epoch_jd[i]);
        file << "    {\n";
        file << "      \"body\": \"" << planet_to_string(mission.body_sequence[i]) << "\",\n";
        file.precision(6);
        file << "      \"jd\": " << std::fixed << mission.epoch_jd[i] << ",\n";
        file.precision(0);
        file << "      \"position\": [" << std::fixed << pos.x << ", " << pos.y << ", " << pos.z << "]\n";
        file << "    }";
        if (i < mission.body_sequence.size() - 1) file << ",";
        file << "\n";
    }
    file << "  ],\n";

    // Planet orbit paths (for context in visualization)
    file << "  \"planet_orbits\": {\n";
    // Generate orbit paths for departure, arrival, and flyby bodies
    bool first_orbit = true;
    for (const auto& body : mission.body_sequence) {
        if (!first_orbit) file << ",\n";
        first_orbit = false;

        const PlanetaryConstants& pc = PlanetaryConstants::get(body);
        double period_days = pc.orbital_period / 86400.0;

        file << "    \"" << planet_to_string(body) << "\": [\n";
        int orbit_points = 360;
        for (int j = 0; j <= orbit_points; j++) {
            double jd = mission.epoch_jd[0] + (j * period_days / orbit_points);
            Vec3 pos = PlanetaryEphemeris::get_position_hci(body, jd);
            if (j > 0) file << ",\n";
            file.precision(0);
            file << "      [" << std::fixed << pos.x << ", " << pos.y << ", " << pos.z << "]";
        }
        file << "\n    ]";
    }
    file << "\n  }\n";

    file << "}\n";
    file.close();
}

// ─────────────────────────────────────────────────────────────
// Total delta-V utility (for optimizer)
// ─────────────────────────────────────────────────────────────

double MissionDesigner::compute_total_dv(
    const std::vector<Planet>& bodies,
    const std::vector<double>& dates_jd,
    double departure_parking_alt,
    double arrival_parking_alt)
{
    if (bodies.size() < 2 || bodies.size() != dates_jd.size()) {
        return std::numeric_limits<double>::infinity();
    }

    double total_dv = 0.0;

    // Check date ordering
    for (size_t i = 1; i < dates_jd.size(); i++) {
        if (dates_jd[i] <= dates_jd[i - 1]) {
            return std::numeric_limits<double>::infinity();
        }
    }

    // Compute each leg's C3
    std::vector<C3Result> transfers;
    for (size_t i = 0; i < bodies.size() - 1; i++) {
        C3Result c3 = InterplanetaryPlanner::compute_transfer(
            bodies[i], bodies[i + 1], dates_jd[i], dates_jd[i + 1],
            departure_parking_alt, arrival_parking_alt);
        if (!c3.valid) return std::numeric_limits<double>::infinity();
        transfers.push_back(c3);
    }

    // Departure burn
    {
        const PlanetaryConstants& pc = PlanetaryConstants::get(bodies[0]);
        double r_park = pc.radius + departure_parking_alt;
        total_dv += InterplanetaryPlanner::departure_delta_v(
            transfers[0].c3_departure, r_park, pc.mu);
    }

    // Flyby delta-V at intermediate bodies (powered if needed)
    for (size_t i = 1; i < bodies.size() - 1; i++) {
        // v_inf incoming and outgoing should match for unpowered flyby
        // If they don't match in magnitude, we need a powered flyby
        double v_in = transfers[i - 1].v_inf_arrival;
        double v_out = transfers[i].v_inf_departure;

        // Magnitude mismatch requires delta-V
        double dv_magnitude = std::abs(v_out - v_in);

        // Direction mismatch: compute turn angle
        // Get v_inf vectors
        Vec3 dep_vel = PlanetaryEphemeris::get_velocity_hci(bodies[i], dates_jd[i]);
        Vec3 v_inf_in_vec(
            transfers[i - 1].v_arrival_hci.x - dep_vel.x,
            transfers[i - 1].v_arrival_hci.y - dep_vel.y,
            transfers[i - 1].v_arrival_hci.z - dep_vel.z
        );
        Vec3 v_inf_out_vec(
            transfers[i].v_departure_hci.x - dep_vel.x,
            transfers[i].v_departure_hci.y - dep_vel.y,
            transfers[i].v_departure_hci.z - dep_vel.z
        );

        double v_in_mag = v_inf_in_vec.norm();
        double v_out_mag = v_inf_out_vec.norm();

        if (v_in_mag > 1.0 && v_out_mag > 1.0) {
            double cos_turn = (v_inf_in_vec.x * v_inf_out_vec.x +
                              v_inf_in_vec.y * v_inf_out_vec.y +
                              v_inf_in_vec.z * v_inf_out_vec.z) / (v_in_mag * v_out_mag);
            cos_turn = std::max(-1.0, std::min(1.0, cos_turn));
            double turn_angle = std::acos(cos_turn);

            const PlanetaryConstants& pc = PlanetaryConstants::get(bodies[i]);
            double v_inf_avg = 0.5 * (v_in_mag + v_out_mag);

            // Check if achievable with unpowered flyby
            double rp_needed = GravityAssist::periapsis_for_turn_angle(v_inf_avg, turn_angle, pc.mu);
            double min_rp = pc.radius + 200e3;

            if (rp_needed < min_rp) {
                // Need powered flyby
                double max_turn = 2.0 * std::asin(1.0 / (1.0 + min_rp * v_inf_avg * v_inf_avg / pc.mu));
                double remaining = turn_angle - max_turn;
                if (remaining > 0.0) {
                    total_dv += 2.0 * v_inf_avg * std::sin(remaining / 2.0);
                }
            }
        }

        total_dv += dv_magnitude;
    }

    // Capture burn at final body
    {
        const PlanetaryConstants& pc = PlanetaryConstants::get(bodies.back());
        double r_cap = pc.radius + arrival_parking_alt;
        total_dv += InterplanetaryPlanner::capture_delta_v(
            transfers.back().v_inf_arrival, r_cap, pc.mu);
    }

    return total_dv;
}

}  // namespace sim
