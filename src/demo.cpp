#include "core/simulation_engine.hpp"
#include "entities/satellite.hpp"
#include "io/tle_parser.hpp"
#include "coordinate/time_utils.hpp"
#include "coordinate/frame_transformer.hpp"
#include <iostream>
#include <fstream>
#include <iomanip>

void print_state(const sim::StateVector& state, const std::string& name) {
    double r = state.position.norm();
    double alt_km = (r - 6378137.0) / 1000.0;
    double v = state.velocity.norm();

    std::cout << std::fixed << std::setprecision(2);
    std::cout << name << " | "
              << "Time: " << std::setw(8) << state.time << "s | "
              << "Alt: " << std::setw(8) << alt_km << " km | "
              << "Vel: " << std::setw(8) << v << " m/s" << std::endl;
}

void export_to_json(const std::string& filename,
                    const std::vector<std::shared_ptr<sim::Entity>>& entities,
                    const std::vector<std::vector<sim::StateVector>>& history,
                    double epoch_jd, double time_step, double duration) {
    std::ofstream file(filename);
    file << std::fixed << std::setprecision(6);

    file << "{\n";

    // Metadata section
    file << "  \"metadata\": {\n";
    file << "    \"epoch_jd\": " << std::setprecision(8) << epoch_jd << ",\n";
    file << "    \"epoch_iso\": \"" << sim::TimeUtils::jd_to_iso8601(epoch_jd) << "\",\n";
    file << "    \"time_step\": " << std::setprecision(1) << time_step << ",\n";
    file << "    \"duration\": " << duration << "\n";
    file << "  },\n";

    // Satellites section
    file << "  \"satellites\": [\n";

    for (size_t i = 0; i < entities.size(); i++) {
        file << "    {\n";
        file << "      \"name\": \"" << entities[i]->get_name() << "\",\n";
        file << "      \"id\": " << entities[i]->get_id() << ",\n";
        file << "      \"positions\": [\n";

        for (size_t j = 0; j < history[i].size(); j++) {
            const auto& state = history[i][j];

            // Calculate Julian Date for this time step
            double current_jd = sim::TimeUtils::add_seconds_to_jd(epoch_jd, state.time);

            // Convert ECI to geodetic
            sim::GeodeticCoord geo = sim::FrameTransformer::eci_to_geodetic(
                state.position, current_jd);

            file << "        {\n";
            file << "          \"time\": " << std::setprecision(1) << state.time << ",\n";
            file << "          \"eci\": {"
                 << "\"x\": " << std::setprecision(2) << state.position.x << ", "
                 << "\"y\": " << state.position.y << ", "
                 << "\"z\": " << state.position.z << "},\n";
            file << "          \"geo\": {"
                 << "\"lat\": " << std::setprecision(4) << geo.latitude << ", "
                 << "\"lon\": " << geo.longitude << ", "
                 << "\"alt\": " << std::setprecision(1) << geo.altitude << "}\n";
            file << "        }";
            if (j < history[i].size() - 1) file << ",";
            file << "\n";
        }

        file << "      ]\n";
        file << "    }";
        if (i < entities.size() - 1) file << ",";
        file << "\n";
    }

    file << "  ]\n";
    file << "}\n";

    file.close();
    std::cout << "\nExported orbit data to: " << filename << std::endl;
}

int main(int argc, char* argv[]) {
    std::cout << "===========================================\n";
    std::cout << "All-Domain Simulation - TLE Demo\n";
    std::cout << "===========================================\n\n";

    // Determine TLE file
    std::string tle_file = "data/tles/example_satcat.txt";
    if (argc > 1) {
        tle_file = argv[1];
    }

    // Parse TLEs
    std::cout << "Loading TLEs from: " << tle_file << std::endl;
    auto tles = sim::TLEParser::parse_file(tle_file);

    if (tles.empty()) {
        std::cerr << "ERROR: No TLEs loaded. Check file path." << std::endl;
        return 1;
    }

    // Create simulation engine
    sim::SimulationEngine engine;
    engine.set_mode(sim::SimulationMode::MODEL_MODE);
    engine.initialize();

    // Limit to first 10 satellites for demo
    int num_sats = std::min(10, (int)tles.size());
    std::cout << "\nCreating " << num_sats << " satellite entities...\n" << std::endl;

    // Create satellite entities and get epoch from first satellite
    std::vector<std::vector<sim::StateVector>> state_history;
    double epoch_jd = 0.0;

    for (int i = 0; i < num_sats; i++) {
        auto satellite = std::make_shared<sim::Satellite>(tles[i].name, i, tles[i]);
        engine.add_entity(satellite);
        state_history.push_back(std::vector<sim::StateVector>());

        // Use first satellite's epoch as reference
        if (i == 0) {
            epoch_jd = satellite->get_epoch_jd();
            std::cout << "Reference epoch: " << sim::TimeUtils::jd_to_iso8601(epoch_jd)
                      << " (JD " << std::fixed << std::setprecision(4) << epoch_jd << ")\n";
        }
    }

    std::cout << "\n=== Starting Orbit Propagation ===\n" << std::endl;

    // Simulation parameters
    double dt = 10.0;           // 10 second time steps
    double sim_duration = 600.0; // 10 minutes
    double output_interval = 60.0; // Output every 60 seconds
    double next_output = 0.0;

    std::cout << "Simulation parameters:" << std::endl;
    std::cout << "  Time step: " << dt << " seconds" << std::endl;
    std::cout << "  Duration: " << sim_duration << " seconds ("
              << sim_duration/60.0 << " minutes)" << std::endl;
    std::cout << "  Output interval: " << output_interval << " seconds\n" << std::endl;

    // Run simulation
    int step_count = 0;
    while (engine.get_simulation_time() < sim_duration) {
        engine.step(dt);
        step_count++;

        // Store states for JSON export
        const auto& entities = engine.get_all_entities();
        for (size_t i = 0; i < entities.size(); i++) {
            state_history[i].push_back(entities[i]->get_state());
        }

        // Print status at intervals
        if (engine.get_simulation_time() >= next_output) {
            std::cout << "\n--- Time: " << engine.get_simulation_time() << " seconds ---" << std::endl;
            for (const auto& entity : entities) {
                print_state(entity->get_state(), entity->get_name());
            }
            next_output += output_interval;
        }
    }

    std::cout << "\n=== Simulation Complete ===" << std::endl;
    std::cout << "Total steps: " << step_count << std::endl;
    std::cout << "Final time: " << engine.get_simulation_time() << " seconds" << std::endl;

    // Export to JSON with enhanced format
    export_to_json("orbit_data.json", engine.get_all_entities(), state_history,
                   epoch_jd, dt, sim_duration);

    std::cout << "\n=== Demo Complete ===" << std::endl;
    std::cout << "Next steps:" << std::endl;
    std::cout << "  1. View orbit_data.json for position history" << std::endl;
    std::cout << "  2. Visualize in Cesium: cd visualization/cesium && python3 -m http.server 8000" << std::endl;
    std::cout << "  3. Try with your satcat.txt: ./demo data/tles/satcat.txt" << std::endl;

    return 0;
}
