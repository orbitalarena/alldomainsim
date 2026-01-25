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

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;

/**
 * @brief Target satellite initialized from classical orbital elements
 */
class TargetSatellite : public sim::Entity {
public:
    TargetSatellite(const std::string& name, int id, const sim::OrbitalElements& elements)
        : sim::Entity(name, id), elements_(elements)
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
        // Simple Keplerian propagation using mean anomaly
        double n = elements_.mean_motion();
        elements_.mean_anomaly = sim::OrbitalMechanics::propagate_mean_anomaly(
            elements_.mean_anomaly, n, dt);
        elements_.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
            elements_.mean_anomaly, elements_.eccentricity);

        // Update state from elements
        state_ = sim::OrbitalMechanics::elements_to_state(elements_);
        state_.time += dt;
    }

    const sim::OrbitalElements& get_elements() const { return elements_; }

private:
    sim::OrbitalElements elements_;
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

    sim::OrbitalElements target_elements;
    target_elements.semi_major_axis = 6378137.0 + 400000.0;  // 400 km altitude
    target_elements.eccentricity = 0.001;                     // Near-circular
    target_elements.inclination = 28.5 * DEG_TO_RAD;          // Cape Canaveral latitude
    target_elements.raan = 45.0 * DEG_TO_RAD;                 // Arbitrary RAAN
    target_elements.arg_periapsis = 0.0;
    target_elements.true_anomaly = 90.0 * DEG_TO_RAD;         // Start 90 deg ahead
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

    // Configure rocket stages (optimized two-stage to LEO)
    // Stage 1: Boost phase
    sim::RocketStage stage1;
    stage1.dry_mass = 20000.0;        // kg
    stage1.propellant_mass = 300000.0; // kg
    stage1.thrust = 5000000.0;        // 5 MN (T/W ~1.5 at liftoff)
    stage1.isp_sl = 290.0;            // s
    stage1.isp_vac = 320.0;           // s
    shuttle->add_stage(stage1);

    // Stage 2: Upper stage + orbital insertion
    sim::RocketStage stage2;
    stage2.dry_mass = 3000.0;
    stage2.propellant_mass = 30000.0;
    stage2.thrust = 500000.0;         // 500 kN
    stage2.isp_sl = 320.0;
    stage2.isp_vac = 360.0;
    shuttle->add_stage(stage2);

    shuttle->set_payload_mass(5000.0);  // 5 ton payload
    shuttle->set_target_orbit(400000.0, 28.5);  // 400 km, 28.5 deg inclination
    shuttle->set_drag_coefficient(0.5);
    shuttle->set_reference_area(150.0);  // m^2

    // ============================================
    // Run simulation
    // ============================================
    std::cout << "\n=== Starting Simulation ===\n";

    std::vector<sim::StateVector> shuttle_history;
    std::vector<sim::StateVector> target_history;

    double dt = 1.0;  // 1 second time steps for launch
    double sim_time = 0.0;

    // Phase 1: Launch (T-0 to orbit insertion, ~8 minutes)
    std::cout << "\n--- Phase 1: Launch ---\n";
    shuttle->ignite();

    while (!shuttle->is_in_orbit() && sim_time < 600.0) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record at 10s intervals
        if (static_cast<int>(sim_time) % 10 == 0) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
        }

        // Progress updates
        if (static_cast<int>(sim_time) % 60 == 0) {
            std::cout << "T+" << sim_time << "s: Alt=" << shuttle->get_altitude()/1000.0
                      << " km, V=" << shuttle->get_velocity_magnitude() << " m/s"
                      << ", Q=" << shuttle->get_dynamic_pressure()/1000.0 << " kPa" << std::endl;
        }
    }

    if (!shuttle->is_in_orbit()) {
        std::cout << "WARNING: Orbit not achieved after 10 minutes" << std::endl;
    }

    // Phase 2: Coast and plan transfer
    std::cout << "\n--- Phase 2: Transfer Planning ---\n";

    // Plan rendezvous
    sim::RendezvousPlan plan = sim::ManeuverPlanner::plan_rendezvous(
        shuttle->get_state(), target->get_state(), sim_time);

    // Add transfer maneuvers to shuttle
    sim::Maneuver burn1(plan.burn1_time, 60.0, plan.delta_v1);  // 60s burn duration
    sim::Maneuver burn2(plan.burn2_time, 60.0, plan.delta_v2);
    shuttle->add_maneuver(burn1);
    shuttle->add_maneuver(burn2);

    // Phase 3: Execute transfer (use larger time step)
    std::cout << "\n--- Phase 3: Hohmann Transfer ---\n";
    dt = 10.0;  // 10 second steps

    double transfer_end = plan.burn2_time + 120.0;  // Continue past second burn

    while (sim_time < transfer_end && sim_time < 20000.0) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record at 60s intervals
        if (static_cast<int>(sim_time) % 60 == 0) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
        }

        // Progress updates every 5 minutes
        if (static_cast<int>(sim_time) % 300 == 0) {
            double range = std::sqrt(
                std::pow(shuttle->get_state().position.x - target->get_state().position.x, 2) +
                std::pow(shuttle->get_state().position.y - target->get_state().position.y, 2) +
                std::pow(shuttle->get_state().position.z - target->get_state().position.z, 2)
            );
            std::cout << "T+" << sim_time << "s: Range to target = " << range/1000.0 << " km" << std::endl;
        }
    }

    // Phase 4: Proximity operations
    std::cout << "\n--- Phase 4: Proximity Operations ---\n";

    // Get relative state
    sim::RelativeState rel = sim::ProximityOps::inertial_to_lvlh(
        shuttle->get_state(), target->get_state());

    std::cout << "Relative position (LVLH): X=" << rel.position.x
              << " Y=" << rel.position.y << " Z=" << rel.position.z << " m" << std::endl;

    // Plan circumnavigation
    double n = sim::ProximityOps::compute_mean_motion(target->get_state());
    sim::ProxOpsTrajectory circum = sim::ProximityOps::plan_circumnavigation(
        rel.position, 500.0,  // 500m radius
        8,                     // 8 waypoints
        n);

    // Simulate proximity ops (simplified - just propagate both objects)
    dt = 10.0;
    double proxops_duration = 7200.0;  // 2 hours of proximity ops

    while (sim_time < transfer_end + proxops_duration) {
        shuttle->update(dt);
        target->update(dt);
        sim_time += dt;

        // Record
        if (static_cast<int>(sim_time) % 60 == 0) {
            shuttle_history.push_back(shuttle->get_state());
            target_history.push_back(target->get_state());
        }
    }

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
