/**
 * "Crushed It" Scenario Demo
 *
 * Multi-phase mission demonstrating all subsystems:
 *   Phase 1: 2-stage rocket launch from Cape Canaveral → LEO (300 km)
 *   Phase 2: Circularize to 300 km orbit
 *   Phase 3: Hohmann transfer to 400 km target orbit
 *   Phase 4: Proximity operations — V-bar approach to 200 m
 *   Phase 5: Imaging pass — synthetic camera captures target
 *   Phase 6: Deorbit burn — retrograde impulse
 *   Phase 7: Reentry — command module with heat shield + parachutes
 *   Phase 8: Checkpoint — save full state to disk
 *
 * Output: crushed_it_data.json with trajectory + events per phase
 */

#include "core/simulation_engine.hpp"
#include "entities/satellite.hpp"
#include "entities/launch_vehicle.hpp"
#include "entities/command_module.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/maneuver_planner.hpp"
#include "physics/proximity_ops.hpp"
#include "physics/synthetic_camera.hpp"
#include "physics/vec3_ops.hpp"
#include "io/checkpoint.hpp"
#include "io/json_writer.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"
#include <iostream>
#include <fstream>
#include <iomanip>
#include <vector>
#include <memory>
#include <cmath>

namespace {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double MU_EARTH = 3.986004418e14;
constexpr double R_EARTH = 6378137.0;
constexpr double G0 = 9.80665;

// ═══════════════════════════════════════════════════════════════
// Target satellite entity (Keplerian propagation)
// ═══════════════════════════════════════════════════════════════

class TargetSat : public sim::Entity {
public:
    TargetSat(int id, const sim::OrbitalElements& elems)
        : sim::Entity("Target-400km", id), elements_(elems), elapsed_(0.0)
    {
        domain_ = sim::PhysicsDomain::ORBITAL;
        state_ = sim::OrbitalMechanics::elements_to_state(elements_);
        state_.time = 0.0;
    }

    void update(double dt) override {
        elapsed_ += dt;
        double n = elements_.mean_motion();
        elements_.mean_anomaly = sim::OrbitalMechanics::propagate_mean_anomaly(
            elements_.mean_anomaly, n, dt);
        elements_.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
            elements_.mean_anomaly, elements_.eccentricity);
        state_ = sim::OrbitalMechanics::elements_to_state(elements_);
        state_.time = elapsed_;
    }

    std::string entity_type() const override { return "Satellite"; }
    const sim::OrbitalElements& get_elements() const { return elements_; }

private:
    sim::OrbitalElements elements_;
    double elapsed_;
};

// ═══════════════════════════════════════════════════════════════
// Phase data structures
// ═══════════════════════════════════════════════════════════════

struct PhaseEvent {
    double time;
    std::string event;
    double altitude_km;
    double velocity_ms;
};

struct PhaseData {
    int phase_num;
    std::string name;
    double start_time;
    double end_time;
    std::vector<PhaseEvent> events;
    std::vector<sim::StateVector> trajectory;  // Sampled state vectors
};

// ═══════════════════════════════════════════════════════════════
// JSON export
// ═══════════════════════════════════════════════════════════════

void export_json(const std::string& filename,
                 const std::vector<PhaseData>& phases,
                 double epoch_jd) {
    std::ofstream file(filename);
    if (!file) {
        std::cerr << "Error: cannot open " << filename << "\n";
        return;
    }

    sim::JsonWriter w(file);
    w.begin_object();

    // Metadata
    w.key("metadata").begin_object();
    w.kv("scenario", "crushed_it");
    w.kv("epoch_jd", epoch_jd);
    w.kv("epoch_iso", sim::TimeUtils::jd_to_iso8601(epoch_jd));
    w.kv("total_phases", static_cast<int>(phases.size()));
    double total_time = phases.empty() ? 0.0 : phases.back().end_time;
    w.kv("total_duration_s", total_time);
    w.end_object();

    // Phases
    w.key("phases").begin_array();
    for (const auto& phase : phases) {
        w.begin_object();
        w.kv("phase", phase.phase_num);
        w.kv("name", phase.name);
        w.kv("start_time", phase.start_time);
        w.kv("end_time", phase.end_time);

        // Events
        w.key("events").begin_array();
        for (const auto& ev : phase.events) {
            w.begin_object();
            w.kv("time", ev.time);
            w.kv("event", ev.event);
            w.kv("altitude_km", ev.altitude_km);
            w.kv("velocity_ms", ev.velocity_ms);
            w.end_object();
        }
        w.end_array();

        // Trajectory (sampled)
        w.key("trajectory_count").value(static_cast<int>(phase.trajectory.size()));
        w.key("trajectory").begin_array();
        for (const auto& s : phase.trajectory) {
            w.begin_array();
            w.value(s.time);
            w.value(s.position.x); w.value(s.position.y); w.value(s.position.z);
            w.value(s.velocity.x); w.value(s.velocity.y); w.value(s.velocity.z);
            w.end_array();
        }
        w.end_array();

        w.end_object();
    }
    w.end_array();

    w.end_object();
    file << "\n";

    std::cout << "\n[Crushed It] Exported " << phases.size()
              << " phases to " << filename << "\n";
}

}  // anonymous namespace

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

int main() {
    using namespace sim;

    std::cout << "═══════════════════════════════════════════════════════════\n";
    std::cout << "  CRUSHED IT — Multi-Phase Mission Demo\n";
    std::cout << "═══════════════════════════════════════════════════════════\n\n";

    // Epoch: 2026-01-30 12:00:00 UTC
    // Julian date from calendar date (standard formula)
    // For 2026-01-30 12:00 UTC
    double epoch_jd = 2461045.0;  // JD for 2026-01-30 12:00 UTC
    double sim_time = 0.0;
    double dt = 1.0;

    std::vector<PhaseData> phases;

    // ─── Create target satellite at 400 km, 51.6° inclination ───
    OrbitalElements target_elems;
    target_elems.semi_major_axis = R_EARTH + 400000.0;
    target_elems.eccentricity = 0.0002;
    target_elems.inclination = 51.6 * DEG_TO_RAD;
    target_elems.raan = 30.0 * DEG_TO_RAD;
    target_elems.arg_periapsis = 0.0;
    target_elems.true_anomaly = 0.0;
    target_elems.mean_anomaly = 0.0;
    // mu is a global constant (MU_EARTH), not stored in OrbitalElements

    auto target = std::make_shared<TargetSat>(100, target_elems);

    std::cout << "Target satellite: " << target->get_name() << "\n";
    std::cout << "  Orbit: 400 km circular, 51.6° inclination\n";
    double target_period = target_elems.period();
    std::cout << "  Period: " << target_period / 60.0 << " min\n\n";

    // ═══════════════════════════════════════════════════════════
    // Phase 1: Launch from Cape Canaveral
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 1;
        phase.name = "Launch";
        phase.start_time = sim_time;

        std::cout << "── Phase 1: Launch from Cape Canaveral ──\n";

        // Cape Canaveral: 28.396°N, 80.605°W
        auto rocket = std::make_shared<LaunchVehicle>(
            "Crushed-1", 1, 28.396, -80.605, 0.0);

        // Stage 1: Falcon-9-like first stage
        RocketStage s1;
        s1.dry_mass = 22200.0;      // kg
        s1.propellant_mass = 395700.0;
        s1.thrust = 7607000.0;      // N (9 engines)
        s1.isp_sl = 282.0;
        s1.isp_vac = 311.0;
        s1.burn_time = 162.0;
        rocket->add_stage(s1);

        // Stage 2: Falcon-9-like second stage
        RocketStage s2;
        s2.dry_mass = 4000.0;
        s2.propellant_mass = 92670.0;
        s2.thrust = 981000.0;       // N (single Merlin Vacuum)
        s2.isp_sl = 311.0;
        s2.isp_vac = 348.0;
        s2.burn_time = 397.0;
        rocket->add_stage(s2);

        rocket->set_payload_mass(6000.0);  // Command module + cargo
        rocket->set_target_orbit(300000.0, 51.6);
        rocket->set_gravity_turn_start(1000.0, 0.3);
        rocket->ignite();

        // Propagate launch (600 seconds max)
        double launch_end = 600.0;
        int sample_interval = 10;
        int step_count = 0;

        while (sim_time < launch_end) {
            rocket->update(dt);
            target->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % sample_interval == 0) {
                phase.trajectory.push_back(rocket->get_state());
            }

            // Log events
            if (step_count == 1) {
                phase.events.push_back({sim_time, "IGNITION",
                    rocket->get_altitude() / 1000.0,
                    rocket->get_state().velocity.norm()});
            }

            auto fp = rocket->get_flight_phase();
            if (fp == FlightPhase::ORBITAL || fp == FlightPhase::CIRCULARIZATION) {
                double alt_km = rocket->get_altitude() / 1000.0;
                double v = rocket->get_state().velocity.norm();
                phase.events.push_back({sim_time, "ORBIT_INSERTION",
                    alt_km, v});
                std::cout << "  T+" << (int)sim_time << "s: Orbit insertion at "
                          << std::fixed << std::setprecision(1)
                          << alt_km << " km, " << v << " m/s\n";
                break;
            }
        }

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 1 complete: T+" << (int)sim_time << "s\n\n";

        // Transfer state to a free-flying object for remaining phases
        // We'll use the launch vehicle's final state
    }

    // For phases 2-5, we use a simple Keplerian chaser
    // Initialize chaser from approximate post-insertion state
    OrbitalElements chaser_elems;
    chaser_elems.semi_major_axis = R_EARTH + 300000.0;
    chaser_elems.eccentricity = 0.001;
    chaser_elems.inclination = 51.6 * DEG_TO_RAD;
    chaser_elems.raan = 30.0 * DEG_TO_RAD;
    chaser_elems.arg_periapsis = 0.0;
    chaser_elems.true_anomaly = PI;  // Opposite side of orbit from target
    chaser_elems.mean_anomaly = PI;
    // mu is a global constant (MU_EARTH), not stored in OrbitalElements

    StateVector chaser_state = OrbitalMechanics::elements_to_state(chaser_elems);
    chaser_state.time = sim_time;

    // ═══════════════════════════════════════════════════════════
    // Phase 2: Orbit stabilization (coast one orbit)
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 2;
        phase.name = "Orbit_Stabilization";
        phase.start_time = sim_time;

        std::cout << "── Phase 2: Orbit Stabilization ──\n";

        double chaser_period = chaser_elems.period();
        double coast_time = chaser_period;  // One full orbit
        double end = sim_time + coast_time;
        int sample_interval = 30;  // Every 30s
        int step_count = 0;

        while (sim_time < end) {
            // Simple Keplerian propagation for chaser
            double n = chaser_elems.mean_motion();
            chaser_elems.mean_anomaly = OrbitalMechanics::propagate_mean_anomaly(
                chaser_elems.mean_anomaly, n, dt);
            chaser_elems.true_anomaly = OrbitalMechanics::mean_to_true_anomaly(
                chaser_elems.mean_anomaly, chaser_elems.eccentricity);

            target->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % sample_interval == 0) {
                StateVector s = OrbitalMechanics::elements_to_state(chaser_elems);
                s.time = sim_time;
                phase.trajectory.push_back(s);
            }
        }

        chaser_state = OrbitalMechanics::elements_to_state(chaser_elems);
        chaser_state.time = sim_time;

        double alt_km = (chaser_state.position.norm() - R_EARTH) / 1000.0;
        phase.events.push_back({sim_time, "ORBIT_STABLE",
            alt_km, chaser_state.velocity.norm()});
        std::cout << "  Stable orbit at " << std::fixed << std::setprecision(1)
                  << alt_km << " km\n";

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 2 complete: T+" << (int)sim_time << "s\n\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 3: Hohmann transfer to 400 km
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 3;
        phase.name = "Hohmann_Transfer";
        phase.start_time = sim_time;

        std::cout << "── Phase 3: Hohmann Transfer (300→400 km) ──\n";

        double r1 = R_EARTH + 300000.0;
        double r2 = R_EARTH + 400000.0;
        auto transfer = ManeuverPlanner::hohmann_transfer(r1, r2, MU_EARTH);

        std::cout << "  ΔV1: " << std::fixed << std::setprecision(2)
                  << transfer.delta_v1 << " m/s (prograde)\n";
        std::cout << "  ΔV2: " << transfer.delta_v2 << " m/s (prograde)\n";
        std::cout << "  Transfer time: " << transfer.transfer_time / 60.0 << " min\n";
        std::cout << "  Total ΔV: " << transfer.total_delta_v << " m/s\n";

        // Apply burn 1 (prograde)
        Vec3 v_hat = normalized(chaser_state.velocity);
        chaser_state.velocity.x += v_hat.x * transfer.delta_v1;
        chaser_state.velocity.y += v_hat.y * transfer.delta_v1;
        chaser_state.velocity.z += v_hat.z * transfer.delta_v1;

        phase.events.push_back({sim_time, "BURN_1",
            (chaser_state.position.norm() - R_EARTH) / 1000.0,
            chaser_state.velocity.norm()});

        // Recompute elements on transfer orbit
        chaser_elems = OrbitalMechanics::state_to_elements(chaser_state);

        // Coast through transfer (half orbit)
        double transfer_end = sim_time + transfer.transfer_time;
        int sample_interval = 10;
        int step_count = 0;

        while (sim_time < transfer_end) {
            double n = chaser_elems.mean_motion();
            chaser_elems.mean_anomaly = OrbitalMechanics::propagate_mean_anomaly(
                chaser_elems.mean_anomaly, n, dt);
            chaser_elems.true_anomaly = OrbitalMechanics::mean_to_true_anomaly(
                chaser_elems.mean_anomaly, chaser_elems.eccentricity);

            target->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % sample_interval == 0) {
                StateVector s = OrbitalMechanics::elements_to_state(chaser_elems);
                s.time = sim_time;
                phase.trajectory.push_back(s);
            }
        }

        // Apply burn 2 (circularize at 400 km)
        chaser_state = OrbitalMechanics::elements_to_state(chaser_elems);
        chaser_state.time = sim_time;

        v_hat = normalized(chaser_state.velocity);
        chaser_state.velocity.x += v_hat.x * transfer.delta_v2;
        chaser_state.velocity.y += v_hat.y * transfer.delta_v2;
        chaser_state.velocity.z += v_hat.z * transfer.delta_v2;

        chaser_elems = OrbitalMechanics::state_to_elements(chaser_state);

        double alt_km = (chaser_state.position.norm() - R_EARTH) / 1000.0;
        phase.events.push_back({sim_time, "BURN_2_CIRCULARIZE",
            alt_km, chaser_state.velocity.norm()});
        std::cout << "  Circularized at " << alt_km << " km\n";

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 3 complete: T+" << (int)sim_time << "s\n\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 4: Proximity operations (approach to 200 m)
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 4;
        phase.name = "Proximity_Ops";
        phase.start_time = sim_time;

        std::cout << "── Phase 4: Proximity Operations ──\n";

        StateVector target_state = target->get_state();
        target_state.time = sim_time;

        // Compute relative state in RIC frame
        auto rel = ProximityOps::inertial_to_ric(chaser_state, target_state);

        double range = rel.position.norm();
        std::cout << "  Initial range: " << std::fixed << std::setprecision(0)
                  << range / 1000.0 << " km\n";

        // Plan V-bar approach to 200 m (V-bar = along-track)
        double n = ProximityOps::compute_mean_motion(target_state, MU_EARTH);
        double approach_time = 600.0;  // 10 minutes

        // Target relative position: 200m ahead on V-bar
        Vec3 target_rel_pos{0.0, 200.0, 0.0};  // RIC: 0 radial, 200m in-track, 0 cross

        // CW transfer
        auto [dv0, dvf] = ProximityOps::cw_transfer(
            rel.position, target_rel_pos, approach_time, n);

        // Apply initial impulse
        Vec3 dv_eci = ProximityOps::ric_to_inertial_dv(dv0, target_state);
        chaser_state.velocity.x += dv_eci.x;
        chaser_state.velocity.y += dv_eci.y;
        chaser_state.velocity.z += dv_eci.z;

        double dv_mag = dv0.norm();
        phase.events.push_back({sim_time, "PROX_BURN_1",
            (chaser_state.position.norm() - R_EARTH) / 1000.0, dv_mag});
        std::cout << "  Approach burn: " << std::setprecision(2)
                  << dv_mag << " m/s\n";

        // Propagate approach
        chaser_elems = OrbitalMechanics::state_to_elements(chaser_state);
        double approach_end = sim_time + approach_time;
        int step_count = 0;

        while (sim_time < approach_end) {
            double nn = chaser_elems.mean_motion();
            chaser_elems.mean_anomaly = OrbitalMechanics::propagate_mean_anomaly(
                chaser_elems.mean_anomaly, nn, dt);
            chaser_elems.true_anomaly = OrbitalMechanics::mean_to_true_anomaly(
                chaser_elems.mean_anomaly, chaser_elems.eccentricity);

            target->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % 30 == 0) {
                StateVector s = OrbitalMechanics::elements_to_state(chaser_elems);
                s.time = sim_time;
                phase.trajectory.push_back(s);
            }
        }

        // Apply braking impulse
        chaser_state = OrbitalMechanics::elements_to_state(chaser_elems);
        chaser_state.time = sim_time;

        Vec3 dvf_eci = ProximityOps::ric_to_inertial_dv(dvf, target->get_state());
        chaser_state.velocity.x += dvf_eci.x;
        chaser_state.velocity.y += dvf_eci.y;
        chaser_state.velocity.z += dvf_eci.z;

        // Final range
        target_state = target->get_state();
        rel = ProximityOps::inertial_to_ric(chaser_state, target_state);
        double final_range = rel.position.norm();

        phase.events.push_back({sim_time, "PROX_STATION_KEEPING",
            (chaser_state.position.norm() - R_EARTH) / 1000.0, final_range});
        std::cout << "  Final range: " << std::setprecision(0)
                  << final_range << " m\n";

        chaser_elems = OrbitalMechanics::state_to_elements(chaser_state);

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 4 complete: T+" << (int)sim_time << "s\n\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 5: Imaging pass
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 5;
        phase.name = "Imaging";
        phase.start_time = sim_time;

        std::cout << "── Phase 5: Imaging Pass ──\n";

        CameraConfig cam = CameraConfig::recon_default();
        StateVector target_state = target->get_state();

        // Point camera at target
        auto vis = SyntheticCamera::is_target_visible(
            chaser_state.position, chaser_state.attitude,
            chaser_state.velocity, target_state.position, cam);

        std::cout << "  Camera: recon (narrow FOV, 8192×8192 px)\n";
        std::cout << "  Target visible: " << (vis.is_visible ? "YES" : "NO") << "\n";
        std::cout << "  Slant range: " << std::fixed << std::setprecision(0)
                  << vis.slant_range << " m\n";

        // Also compute nadir footprint
        double alt = (chaser_state.position.norm() - R_EARTH);
        auto footprint = SyntheticCamera::compute_nadir_footprint(
            alt, 0.0, 0.0, cam);

        std::cout << "  Nadir GSD: " << std::setprecision(3)
                  << footprint.gsd_cross << " m/pixel\n";
        std::cout << "  Footprint area: " << std::setprecision(2)
                  << footprint.area_km2 << " km²\n";

        phase.events.push_back({sim_time, "IMAGE_CAPTURE",
            alt / 1000.0, vis.slant_range});

        // Coast 300 seconds during imaging window
        double img_end = sim_time + 300.0;
        int step_count = 0;
        while (sim_time < img_end) {
            double n = chaser_elems.mean_motion();
            chaser_elems.mean_anomaly = OrbitalMechanics::propagate_mean_anomaly(
                chaser_elems.mean_anomaly, n, dt);
            chaser_elems.true_anomaly = OrbitalMechanics::mean_to_true_anomaly(
                chaser_elems.mean_anomaly, chaser_elems.eccentricity);

            target->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % 30 == 0) {
                StateVector s = OrbitalMechanics::elements_to_state(chaser_elems);
                s.time = sim_time;
                phase.trajectory.push_back(s);
            }
        }

        chaser_state = OrbitalMechanics::elements_to_state(chaser_elems);
        chaser_state.time = sim_time;

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 5 complete: T+" << (int)sim_time << "s\n\n";
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 6: Deorbit burn
    // ═══════════════════════════════════════════════════════════
    {
        PhaseData phase;
        phase.phase_num = 6;
        phase.name = "Deorbit";
        phase.start_time = sim_time;

        std::cout << "── Phase 6: Deorbit Burn ──\n";

        // Retrograde burn to lower perigee to ~80 km
        double r_current = chaser_state.position.norm();
        double v_current = chaser_state.velocity.norm();
        double r_perigee_target = R_EARTH + 80000.0;

        // Vis-viva: v² = mu * (2/r - 1/a)
        // New a = (r_current + r_perigee_target) / 2
        double a_deorbit = (r_current + r_perigee_target) / 2.0;
        double v_deorbit = std::sqrt(MU_EARTH * (2.0 / r_current - 1.0 / a_deorbit));
        double dv_deorbit = v_deorbit - v_current;  // Negative = retrograde

        std::cout << "  Deorbit ΔV: " << std::fixed << std::setprecision(1)
                  << dv_deorbit << " m/s (retrograde)\n";

        // Apply retrograde burn
        Vec3 v_hat = normalized(chaser_state.velocity);
        chaser_state.velocity.x += v_hat.x * dv_deorbit;
        chaser_state.velocity.y += v_hat.y * dv_deorbit;
        chaser_state.velocity.z += v_hat.z * dv_deorbit;

        phase.events.push_back({sim_time, "DEORBIT_BURN",
            (r_current - R_EARTH) / 1000.0, std::abs(dv_deorbit)});

        // Create command module for reentry
        auto cm = std::make_shared<CommandModule>("Crushed-CM", 2);
        cm->set_state(chaser_state);
        cm->set_primary_body(PrimaryBody::EARTH);
        cm->set_flight_phase(CMFlightPhase::REENTRY);
        cm->set_physics_domain(PhysicsDomain::AERO);

        // Coast to atmosphere entry (~20 min)
        double coast_end = sim_time + 1200.0;
        int step_count = 0;

        while (sim_time < coast_end) {
            cm->update(dt);
            sim_time += dt;
            step_count++;

            if (step_count % 30 == 0) {
                phase.trajectory.push_back(cm->get_state());
            }

            double alt = cm->get_altitude();
            if (alt < 120000.0 && step_count > 10) {
                phase.events.push_back({sim_time, "ATMOSPHERE_ENTRY",
                    alt / 1000.0, cm->get_state().velocity.norm()});
                std::cout << "  Atmosphere entry at " << std::setprecision(0)
                          << alt / 1000.0 << " km, "
                          << cm->get_state().velocity.norm() << " m/s\n";
                break;
            }
        }

        phase.end_time = sim_time;
        phases.push_back(phase);
        std::cout << "  Phase 6 complete: T+" << (int)sim_time << "s\n\n";

        // ═══════════════════════════════════════════════════════
        // Phase 7: Reentry + descent
        // ═══════════════════════════════════════════════════════
        {
            PhaseData p7;
            p7.phase_num = 7;
            p7.name = "Reentry";
            p7.start_time = sim_time;

            std::cout << "── Phase 7: Reentry & Descent ──\n";

            double reentry_end = sim_time + 1800.0;  // Max 30 minutes
            int step7 = 0;
            bool drogue_logged = false;
            bool main_logged = false;

            while (sim_time < reentry_end) {
                cm->update(dt);
                sim_time += dt;
                step7++;

                if (step7 % 10 == 0) {
                    p7.trajectory.push_back(cm->get_state());
                }

                auto atm = cm->get_atmospheric_state();

                // Log peak heating
                if (step7 == 1) {
                    p7.events.push_back({sim_time, "REENTRY_START",
                        atm.altitude / 1000.0, atm.velocity});
                }

                // Drogue chute
                if (cm->is_drogue_deployed() && !drogue_logged) {
                    p7.events.push_back({sim_time, "DROGUE_DEPLOY",
                        atm.altitude / 1000.0, atm.velocity});
                    std::cout << "  Drogue deployed at " << std::setprecision(0)
                              << atm.altitude / 1000.0 << " km\n";
                    drogue_logged = true;
                }

                // Main chutes
                if (cm->is_main_deployed() && !main_logged) {
                    p7.events.push_back({sim_time, "MAIN_DEPLOY",
                        atm.altitude / 1000.0, atm.velocity});
                    std::cout << "  Main chutes at " << atm.altitude / 1000.0 << " km\n";
                    main_logged = true;
                }

                // Splashdown
                if (cm->get_flight_phase() == CMFlightPhase::SPLASHDOWN) {
                    p7.events.push_back({sim_time, "SPLASHDOWN",
                        0.0, atm.velocity});
                    std::cout << "  SPLASHDOWN at " << std::setprecision(1)
                              << atm.velocity << " m/s\n";
                    break;
                }

                // Safety: stop if altitude goes negative
                if (atm.altitude < 0.0) {
                    p7.events.push_back({sim_time, "GROUND_CONTACT",
                        0.0, atm.velocity});
                    std::cout << "  Ground contact at " << atm.velocity << " m/s\n";
                    break;
                }
            }

            p7.end_time = sim_time;
            phases.push_back(p7);
            std::cout << "  Phase 7 complete: T+" << (int)sim_time << "s\n\n";
        }

        // ═══════════════════════════════════════════════════════
        // Phase 8: Checkpoint
        // ═══════════════════════════════════════════════════════
        {
            PhaseData p8;
            p8.phase_num = 8;
            p8.name = "Checkpoint";
            p8.start_time = sim_time;

            std::cout << "── Phase 8: Checkpoint Save ──\n";

            SimulationEngine engine;
            engine.set_simulation_time(sim_time);
            engine.set_mode(SimulationMode::MODEL_MODE);
            engine.add_entity(target);
            engine.add_entity(cm);

            bool ok = engine.save_state("crushed_it_checkpoint.json");
            p8.events.push_back({sim_time,
                ok ? "CHECKPOINT_SAVED" : "CHECKPOINT_FAILED",
                0.0, 0.0});

            std::cout << "  Checkpoint: " << (ok ? "SUCCESS" : "FAILED") << "\n";

            p8.end_time = sim_time;
            phases.push_back(p8);
            std::cout << "  Phase 8 complete: T+" << (int)sim_time << "s\n\n";
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════

    std::cout << "═══════════════════════════════════════════════════════════\n";
    std::cout << "  MISSION COMPLETE\n";
    std::cout << "═══════════════════════════════════════════════════════════\n";
    std::cout << "  Total mission time: " << std::fixed << std::setprecision(0)
              << sim_time << " s (" << sim_time / 3600.0 << " hours)\n";
    std::cout << "  Phases completed: " << phases.size() << "\n\n";

    for (const auto& p : phases) {
        std::cout << "  Phase " << p.phase_num << ": " << p.name
                  << "  [" << (int)p.start_time << "s → " << (int)p.end_time << "s]\n";
        for (const auto& ev : p.events) {
            std::cout << "    T+" << (int)ev.time << "s: " << ev.event;
            if (ev.altitude_km > 0) std::cout << " (alt=" << ev.altitude_km << "km)";
            if (ev.velocity_ms > 0) std::cout << " (v=" << ev.velocity_ms << "m/s)";
            std::cout << "\n";
        }
    }

    // Export JSON
    export_json("crushed_it_data.json", phases, epoch_jd);

    std::cout << "\nFiles written:\n";
    std::cout << "  crushed_it_data.json        — Full phase/trajectory data\n";
    std::cout << "  crushed_it_checkpoint.json   — Checkpoint state\n";

    return 0;
}
