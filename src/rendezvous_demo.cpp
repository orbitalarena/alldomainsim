#include "core/simulation_engine.hpp"
#include "entities/satellite.hpp"
#include "entities/launch_vehicle.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/maneuver_planner.hpp"
#include "physics/proximity_ops.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"
#include <iostream>
#include <fstream>
#include <iomanip>
#include <vector>
#include <memory>
#include <cmath>

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;

/**
 * @brief Target satellite initialized from classical orbital elements
 */
class TargetSatellite : public sim::Entity {
public:
    TargetSatellite(const std::string& name, int id, const sim::OrbitalElements& elements)
        : sim::Entity(name, id), elements_(elements), accumulated_time_(0.0)
    {
        domain_ = sim::PhysicsDomain::ORBITAL;

        // Initialize state from orbital elements
        state_ = sim::OrbitalMechanics::elements_to_state(elements_);
        state_.time = 0.0;

        double alt_km = (state_.position.norm() - 6378137.0) / 1000.0;
        std::cout << "Target satellite " << name_ << " initialized:" << std::endl;
        std::cout << "  Altitude: " << alt_km << " km" << std::endl;
        std::cout << "  Inclination: " << elements_.inclination * 180.0 / PI << " deg" << std::endl;
        std::cout << "  Period: " << elements_.period() / 60.0 << " min" << std::endl;
    }

    void update(double dt) override {
        // Accumulate time first
        accumulated_time_ += dt;

        // Simple Keplerian propagation using mean anomaly
        double n = elements_.mean_motion();
        elements_.mean_anomaly = sim::OrbitalMechanics::propagate_mean_anomaly(
            elements_.mean_anomaly, n, dt);
        elements_.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
            elements_.mean_anomaly, elements_.eccentricity);

        // Update state from elements
        state_ = sim::OrbitalMechanics::elements_to_state(elements_);
        state_.time = accumulated_time_;
    }

    const sim::OrbitalElements& get_elements() const { return elements_; }

private:
    sim::OrbitalElements elements_;
    double accumulated_time_;  // Track time separately
};

void export_rendezvous_json(
    const std::string& filename,
    const std::vector<sim::StateVector>& shuttle_history,
    const std::vector<sim::StateVector>& target_history,
    double epoch_jd, double time_step)
{
    std::ofstream file(filename);
    file << std::fixed << std::setprecision(6);

    file << "{\n";

    // Metadata
    file << "  \"metadata\": {\n";
    file << "    \"epoch_jd\": " << std::setprecision(8) << epoch_jd << ",\n";
    file << "    \"epoch_iso\": \"" << sim::TimeUtils::jd_to_iso8601(epoch_jd) << "\",\n";
    file << "    \"time_step\": " << std::setprecision(1) << time_step << ",\n";
    file << "    \"duration\": " << shuttle_history.back().time << ",\n";
    file << "    \"scenario\": \"rendezvous\"\n";
    file << "  },\n";

    // Satellites array
    file << "  \"satellites\": [\n";

    // Shuttle
    file << "    {\n";
    file << "      \"name\": \"Space Shuttle\",\n";
    file << "      \"id\": 0,\n";
    file << "      \"type\": \"launch_vehicle\",\n";
    file << "      \"positions\": [\n";

    for (size_t i = 0; i < shuttle_history.size(); i++) {
        const auto& state = shuttle_history[i];
        double jd = sim::TimeUtils::add_seconds_to_jd(epoch_jd, state.time);
        sim::GeodeticCoord geo = sim::FrameTransformer::eci_to_geodetic(state.position, jd);

        file << "        {\n";
        file << "          \"time\": " << state.time << ",\n";
        file << "          \"eci\": {\"x\": " << std::setprecision(2) << state.position.x
             << ", \"y\": " << state.position.y << ", \"z\": " << state.position.z << "},\n";
        file << "          \"geo\": {\"lat\": " << std::setprecision(4) << geo.latitude
             << ", \"lon\": " << geo.longitude << ", \"alt\": " << std::setprecision(1) << geo.altitude << "}\n";
        file << "        }";
        if (i < shuttle_history.size() - 1) file << ",";
        file << "\n";
    }

    file << "      ]\n";
    file << "    },\n";

    // Target satellite
    file << "    {\n";
    file << "      \"name\": \"Target LEO-Sat\",\n";
    file << "      \"id\": 1,\n";
    file << "      \"type\": \"target\",\n";
    file << "      \"positions\": [\n";

    for (size_t i = 0; i < target_history.size(); i++) {
        const auto& state = target_history[i];
        double jd = sim::TimeUtils::add_seconds_to_jd(epoch_jd, state.time);
        sim::GeodeticCoord geo = sim::FrameTransformer::eci_to_geodetic(state.position, jd);

        file << "        {\n";
        file << "          \"time\": " << state.time << ",\n";
        file << "          \"eci\": {\"x\": " << std::setprecision(2) << state.position.x
             << ", \"y\": " << state.position.y << ", \"z\": " << state.position.z << "},\n";
        file << "          \"geo\": {\"lat\": " << std::setprecision(4) << geo.latitude
             << ", \"lon\": " << geo.longitude << ", \"alt\": " << std::setprecision(1) << geo.altitude << "}\n";
        file << "        }";
        if (i < target_history.size() - 1) file << ",";
        file << "\n";
    }

    file << "      ]\n";
    file << "    }\n";

    file << "  ]\n";
    file << "}\n";

    file.close();
    std::cout << "\nExported rendezvous data to: " << filename << std::endl;
}

int main() {
    std::cout << "============================================\n";
    std::cout << "All-Domain Simulation - Rendezvous Demo\n";
    std::cout << "============================================\n\n";

    // Reference epoch (now)
    double epoch_jd = 2460335.0;  // ~Jan 25, 2024

    // ============================================
    // Create target satellite from orbital elements
    // ============================================
    std::cout << "=== Creating Target Satellite ===\n";

    // Calculate optimal target position for launch-timed rendezvous
    // Key timing:
    //   - Launch to orbit: ~395s
    //   - Transfer time: ~45 min (2720s)
    //   - Total time from T=0 to rendezvous: ~395 + 2720 = 3115s
    //
    // Target mean motion at 400km: n = sqrt(mu/a^3) ≈ 0.00113 rad/s
    // In 3115s, target travels: 0.00113 * 3115 = 3.52 rad = 202 deg
    //
    // For Hohmann transfer rendezvous:
    //   - Shuttle travels 180 deg in transfer ellipse
    //   - Target should arrive at same point when shuttle does
    //   - So target needs to be (180 - 202) = -22 deg relative to shuttle's insertion point
    //   - But shuttle inserts roughly overhead of Cape Canaveral
    //
    // Shuttle insertion position (roughly): Based on Cape Canaveral at RAAN=45 deg
    // Setting target to start ~158 deg (180 - 22) so it arrives at rendezvous point

    sim::OrbitalElements target_elements;
    target_elements.semi_major_axis = 6378137.0 + 400000.0;  // 400 km altitude
    target_elements.eccentricity = 0.0005;                    // Very circular
    target_elements.inclination = 28.5 * DEG_TO_RAD;          // Cape Canaveral latitude
    target_elements.raan = 45.0 * DEG_TO_RAD;                 // Match RAAN for co-planar transfer
    target_elements.arg_periapsis = 0.0;
    target_elements.true_anomaly = 220.0 * DEG_TO_RAD;        // Tuned for close approach
    target_elements.mean_anomaly = sim::OrbitalMechanics::true_to_mean_anomaly(
        target_elements.true_anomaly, target_elements.eccentricity);

    auto target = std::make_shared<TargetSatellite>("Target LEO-Sat", 1, target_elements);

    // ============================================
    // Create launch vehicle at Cape Canaveral
    // ============================================
    std::cout << "\n=== Creating Launch Vehicle ===\n";

    auto shuttle = std::make_shared<sim::LaunchVehicle>(
        "Space Shuttle", 0,
        sim::LaunchVehicle::CAPE_CANAVERAL_LAT,
        sim::LaunchVehicle::CAPE_CANAVERAL_LON,
        sim::LaunchVehicle::CAPE_CANAVERAL_ALT
    );

    // Configure rocket stages - tuned for ~300km orbit
    // Stage 1: Boost phase
    sim::RocketStage stage1;
    stage1.dry_mass = 20000.0;         // kg
    stage1.propellant_mass = 280000.0; // kg
    stage1.thrust = 4500000.0;         // 4.5 MN
    stage1.isp_sl = 295.0;             // s
    stage1.isp_vac = 320.0;            // s
    shuttle->add_stage(stage1);

    // Stage 2: Upper stage
    sim::RocketStage stage2;
    stage2.dry_mass = 3500.0;
    stage2.propellant_mass = 28000.0;  // Good balance
    stage2.thrust = 450000.0;          // 450 kN
    stage2.isp_sl = 320.0;
    stage2.isp_vac = 355.0;
    shuttle->add_stage(stage2);

    shuttle->set_payload_mass(4500.0);  // 4.5 ton payload
    shuttle->set_target_orbit(300000.0, 28.5);  // 300 km target
    shuttle->set_drag_coefficient(0.4);
    shuttle->set_reference_area(100.0);  // m^2

    // ============================================
    // Run simulation
    // ============================================
    std::cout << "\n=== Starting Simulation ===\n";

    std::vector<sim::StateVector> shuttle_history;
    std::vector<sim::StateVector> target_history;

    double dt = 1.0;  // 1 second time steps for launch
    double sim_time = 0.0;
    double last_record_time = -10.0;  // Track when we last recorded
    double last_print_time = -60.0;   // Track when we last printed status
    double record_interval = 10.0;    // Record every 10s during launch

    // Record initial state
    shuttle_history.push_back(shuttle->get_state());
    target_history.push_back(target->get_state());

    // Phase 1: Launch (T-0 to orbit insertion, ~8 minutes)
    std::cout << "\n--- Phase 1: Launch ---\n";
    shuttle->ignite();

    while (!shuttle->is_in_orbit() && sim_time < 600.0) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record at intervals
        if (sim_time - last_record_time >= record_interval) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
            last_record_time = sim_time;
        }

        // Progress updates
        if (sim_time - last_print_time >= 60.0) {
            std::cout << "T+" << sim_time << "s: Alt=" << shuttle->get_altitude()/1000.0
                      << " km, V=" << shuttle->get_velocity_magnitude() << " m/s"
                      << ", Q=" << shuttle->get_dynamic_pressure()/1000.0 << " kPa" << std::endl;
            last_print_time = sim_time;
        }
    }

    if (!shuttle->is_in_orbit()) {
        std::cout << "WARNING: Orbit not achieved after 10 minutes" << std::endl;
    }

    // Phase 2: Coast and plan transfer with proper phasing
    std::cout << "\n--- Phase 2: Transfer Planning with Phasing ---\n";

    // Show current orbit status
    double shuttle_r = shuttle->get_state().position.norm();
    double shuttle_v = shuttle->get_state().velocity.norm();
    double shuttle_alt = (shuttle_r - 6378137.0)/1000.0;
    std::cout << "Shuttle orbit achieved: alt=" << shuttle_alt
              << " km, v=" << shuttle_v << " m/s" << std::endl;

    // Compute current orbital elements for shuttle
    sim::OrbitalElements shuttle_elem = sim::OrbitalMechanics::state_to_elements(
        shuttle->get_state(), sim::OrbitalMechanics::MU_EARTH);
    std::cout << "Shuttle elements: a=" << shuttle_elem.semi_major_axis/1000.0
              << " km, e=" << shuttle_elem.eccentricity << std::endl;

    // Plan a Hohmann transfer from shuttle's current orbit to target altitude
    double target_r = 6378137.0 + 400000.0;  // Target orbital radius
    double current_r = shuttle_elem.semi_major_axis;  // Use SMA for more accurate transfer

    sim::HohmannTransfer transfer = sim::ManeuverPlanner::hohmann_transfer(
        current_r, target_r, sim::OrbitalMechanics::MU_EARTH);

    std::cout << "Hohmann transfer:" << std::endl;
    std::cout << "  From r=" << current_r/1000.0 << " km to r=" << target_r/1000.0 << " km" << std::endl;
    std::cout << "  dV1=" << transfer.delta_v1 << " m/s (prograde burn)" << std::endl;
    std::cout << "  dV2=" << transfer.delta_v2 << " m/s (circularization)" << std::endl;
    std::cout << "  Transfer time=" << transfer.transfer_time << " s (" << transfer.transfer_time/60.0 << " min)" << std::endl;

    // Calculate current phase angle for display
    sim::Vec3 r_shuttle = shuttle->get_state().position;
    sim::Vec3 r_target = target->get_state().position;
    double dot = r_shuttle.x * r_target.x + r_shuttle.y * r_target.y + r_shuttle.z * r_target.z;
    double r1_mag = r_shuttle.norm();
    double r2_mag = r_target.norm();
    double current_phase = std::acos(dot / (r1_mag * r2_mag));

    // Check sign using cross product
    double cross_z = r_shuttle.x * r_target.y - r_shuttle.y * r_target.x;
    if (cross_z < 0) current_phase = 2*PI - current_phase;

    double n_target = target->get_elements().mean_motion();
    double target_travel = n_target * transfer.transfer_time;

    std::cout << "Phasing:" << std::endl;
    std::cout << "  Current phase angle: " << current_phase * 180.0/PI << " deg" << std::endl;
    std::cout << "  Target travels " << target_travel * 180.0/PI << " deg during transfer" << std::endl;

    // Execute transfer immediately (target positioned for rendezvous)
    double burn1_time = sim_time + 30.0;  // Start burn 30s after orbit insertion
    double burn2_time = burn1_time + transfer.transfer_time;

    // Get prograde direction (will be recomputed at burn time by maneuver system)
    sim::Vec3 prograde;
    double v_mag = shuttle->get_state().velocity.norm();
    prograde.x = shuttle->get_state().velocity.x / v_mag;
    prograde.y = shuttle->get_state().velocity.y / v_mag;
    prograde.z = shuttle->get_state().velocity.z / v_mag;

    // Create delta-V vectors
    sim::Vec3 dv1, dv2;
    dv1.x = transfer.delta_v1 * prograde.x;
    dv1.y = transfer.delta_v1 * prograde.y;
    dv1.z = transfer.delta_v1 * prograde.z;

    dv2.x = transfer.delta_v2 * prograde.x;
    dv2.y = transfer.delta_v2 * prograde.y;
    dv2.z = transfer.delta_v2 * prograde.z;

    sim::Maneuver burn1(burn1_time, 30.0, dv1);  // 30s burn duration
    sim::Maneuver burn2(burn2_time, 30.0, dv2);
    shuttle->add_maneuver(burn1);
    shuttle->add_maneuver(burn2);

    std::cout << "Maneuvers scheduled:" << std::endl;
    std::cout << "  Burn 1: T+" << burn1_time << "s (" << burn1_time/60.0 << " min)" << std::endl;
    std::cout << "  Burn 2: T+" << burn2_time << "s (" << burn2_time/60.0 << " min)" << std::endl;

    // Phase 3: Execute transfer (use larger time step)
    std::cout << "\n--- Phase 3: Phasing and Hohmann Transfer ---\n";
    dt = 10.0;  // 10 second steps
    record_interval = 30.0;  // Record every 30s during transfer

    double transfer_end = burn2_time + 300.0;  // Continue 5 minutes past second burn

    while (sim_time < transfer_end) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record at intervals
        if (sim_time - last_record_time >= record_interval) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
            last_record_time = sim_time;
        }

        // Progress updates every 5 minutes
        if (sim_time - last_print_time >= 300.0) {
            auto shuttle_pos = shuttle->get_state().position;
            auto target_pos = target->get_state().position;
            double shuttle_r = shuttle_pos.norm();
            double target_r = target_pos.norm();
            double range = std::sqrt(
                std::pow(shuttle_pos.x - target_pos.x, 2) +
                std::pow(shuttle_pos.y - target_pos.y, 2) +
                std::pow(shuttle_pos.z - target_pos.z, 2)
            );
            std::cout << "T+" << sim_time << "s: Shuttle r=" << shuttle_r/1000.0 << " km"
                      << ", Target r=" << target_r/1000.0 << " km"
                      << ", Range=" << range/1000.0 << " km" << std::endl;
            last_print_time = sim_time;
        }
    }

    // Phase 4: Extended orbital operations (observe full orbits)
    std::cout << "\n--- Phase 4: Extended Orbital Operations ---\n";

    // Simulate extended orbital period (5 hours total from launch)
    dt = 10.0;
    record_interval = 60.0;  // Record every 60s
    double total_duration = 5.0 * 3600.0;  // 5 hours total

    std::cout << "Continuing simulation to " << total_duration/3600.0 << " hours total\n";

    // Get relative state
    sim::RelativeState rel = sim::ProximityOps::inertial_to_lvlh(
        shuttle->get_state(), target->get_state());

    double range_final = std::sqrt(rel.position.x*rel.position.x +
                                   rel.position.y*rel.position.y +
                                   rel.position.z*rel.position.z);
    std::cout << "Current range to target: " << range_final/1000.0 << " km" << std::endl;

    while (sim_time < total_duration) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record at intervals
        if (sim_time - last_record_time >= record_interval) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
            last_record_time = sim_time;
        }
    }

    // Record final state
    shuttle_history.push_back(shuttle->get_state());
    target_history.push_back(target->get_state());

    // ============================================
    // Export results
    // ============================================
    std::cout << "\n=== Simulation Complete ===\n";
    std::cout << "Total simulation time: " << sim_time << " s (" << sim_time/3600.0 << " hours)" << std::endl;
    std::cout << "Shuttle data points: " << shuttle_history.size() << std::endl;
    std::cout << "Target data points: " << target_history.size() << std::endl;

    export_rendezvous_json("rendezvous_data.json", shuttle_history, target_history, epoch_jd, dt);

    std::cout << "\nTo visualize:\n";
    std::cout << "  1. Copy rendezvous_data.json to orbit_data.json\n";
    std::cout << "  2. cd visualization/cesium && python3 -m http.server 8000\n";
    std::cout << "  3. Open http://localhost:8000/orbit_viewer.html\n";

    return 0;
}
