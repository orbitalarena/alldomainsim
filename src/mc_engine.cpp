/**
 * mc_engine — Headless Monte Carlo simulation engine.
 *
 * Reads scenario JSON produced by the browser scenario builder,
 * runs N MC iterations at native speed, outputs results JSON
 * compatible with the browser MC Analysis panel.
 *
 * Replay mode: single run with trajectory sampling for Cesium playback.
 *
 * Usage:
 *   mc_engine --scenario <path> [--runs N] [--seed S] [--max-time T]
 *             [--dt D] [--output <path>] [--verbose]
 *   mc_engine --replay --scenario <path> [--seed S] [--max-time T]
 *             [--sample-interval I] [--output <path>] [--verbose]
 */

#include "montecarlo/mc_runner.hpp"
#include "montecarlo/mc_results.hpp"
#include "io/json_reader.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <chrono>

static void print_usage(const char* prog) {
    std::cerr << "Usage: " << prog << " --scenario <path> [options]\n"
              << "\n"
              << "Modes:\n"
              << "  (default)          Batch Monte Carlo mode\n"
              << "  --replay           Single-run replay mode (trajectory output)\n"
              << "\n"
              << "Options:\n"
              << "  --scenario <path>    Scenario JSON file (required)\n"
              << "  --runs N             Number of MC runs (default: 100)\n"
              << "  --seed S             Base RNG seed (default: 42)\n"
              << "  --max-time T         Max sim time in seconds (default: 600)\n"
              << "  --dt D               Timestep in seconds (default: 0.1)\n"
              << "  --sample-interval I  Replay: seconds between samples (default: 2.0)\n"
              << "  --output <path>      Output JSON file (default: stdout)\n"
              << "  --verbose            Progress to stderr\n"
              << "  --progress           JSON-Lines progress to stderr (for server)\n"
              << "  --help               Show this message\n";
}

int main(int argc, char* argv[]) {
    sim::mc::MCConfig config;

    // Parse CLI arguments
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];

        if (arg == "--help" || arg == "-h") {
            print_usage(argv[0]);
            return 0;
        } else if (arg == "--scenario" && i + 1 < argc) {
            config.scenario_path = argv[++i];
        } else if (arg == "--replay") {
            config.replay_mode = true;
        } else if (arg == "--runs" && i + 1 < argc) {
            config.num_runs = std::stoi(argv[++i]);
        } else if (arg == "--seed" && i + 1 < argc) {
            config.base_seed = std::stoi(argv[++i]);
        } else if (arg == "--max-time" && i + 1 < argc) {
            config.max_sim_time = std::stod(argv[++i]);
        } else if (arg == "--dt" && i + 1 < argc) {
            config.dt = std::stod(argv[++i]);
        } else if (arg == "--sample-interval" && i + 1 < argc) {
            config.sample_interval = std::stod(argv[++i]);
        } else if (arg == "--output" && i + 1 < argc) {
            config.output_path = argv[++i];
        } else if (arg == "--verbose" || arg == "-v") {
            config.verbose = true;
        } else if (arg == "--progress") {
            config.progress = true;
        } else {
            std::cerr << "Unknown argument: " << arg << "\n";
            print_usage(argv[0]);
            return 1;
        }
    }

    if (config.scenario_path.empty()) {
        std::cerr << "Error: --scenario is required\n\n";
        print_usage(argv[0]);
        return 1;
    }

    // Load scenario JSON
    sim::JsonValue scenario;
    try {
        scenario = sim::JsonReader::parse_file(config.scenario_path);
    } catch (const std::exception& e) {
        std::cerr << "Error loading scenario: " << e.what() << "\n";
        return 1;
    }

    // Validate
    if (!scenario["entities"].is_array() || scenario["entities"].size() == 0) {
        std::cerr << "Error: scenario has no entities\n";
        return 1;
    }

    sim::mc::MCRunner runner(config);

    if (config.replay_mode) {
        // ── Replay mode: single run with trajectory sampling ──
        if (config.verbose) {
            std::cerr << "=== Replay Mode ===\n"
                      << "Scenario: " << config.scenario_path << "\n"
                      << "Entities: " << scenario["entities"].size() << "\n"
                      << "Seed: " << config.base_seed << "\n"
                      << "Max time: " << config.max_sim_time << "s\n"
                      << "Sample interval: " << config.sample_interval << "s\n"
                      << "Timestep: " << config.dt << "s\n"
                      << "Output: " << (config.output_path.empty() ? "stdout" : config.output_path)
                      << "\n\n";
        }

        auto t_start = std::chrono::high_resolution_clock::now();

        if (config.output_path.empty()) {
            runner.run_replay(scenario, std::cout);
        } else {
            std::ofstream out(config.output_path);
            if (!out.is_open()) {
                std::cerr << "Error: cannot open output file: "
                          << config.output_path << "\n";
                return 1;
            }
            runner.run_replay(scenario, out);
        }

        auto t_end = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double>(t_end - t_start).count();

        if (config.progress) {
            std::cerr << "{\"type\":\"done\",\"mode\":\"replay\",\"elapsed\":"
                      << elapsed << "}\n" << std::flush;
        }
        if (config.verbose) {
            std::cerr << "\nReplay generated in " << elapsed << "s\n";
            if (!config.output_path.empty()) {
                std::cerr << "Written to: " << config.output_path << "\n";
            }
        }

    } else {
        // ── Batch MC mode ──
        if (config.verbose) {
            std::cerr << "=== MC Engine ===\n"
                      << "Scenario: " << config.scenario_path << "\n"
                      << "Entities: " << scenario["entities"].size() << "\n"
                      << "Runs: " << config.num_runs << "\n"
                      << "Base seed: " << config.base_seed << "\n"
                      << "Max time: " << config.max_sim_time << "s\n"
                      << "Timestep: " << config.dt << "s\n"
                      << "Output: " << (config.output_path.empty() ? "stdout" : config.output_path)
                      << "\n\n";
        }

        auto t_start = std::chrono::high_resolution_clock::now();

        sim::mc::MCRunner::ProgressCallback progress_cb = nullptr;
        if (config.progress) {
            progress_cb = [&](int completed, int total) {
                std::cerr << "{\"type\":\"run_complete\",\"run\":" << completed
                          << ",\"total\":" << total << "}\n" << std::flush;
            };
        }

        auto results = runner.run(scenario, progress_cb);

        auto t_end = std::chrono::high_resolution_clock::now();
        double elapsed = std::chrono::duration<double>(t_end - t_start).count();

        if (config.verbose) {
            int total_engagements = 0;
            int total_kills = 0;
            int errors = 0;
            for (const auto& r : results) {
                if (!r.error.empty()) { errors++; continue; }
                total_engagements += static_cast<int>(r.engagement_log.size());
                for (const auto& e : r.engagement_log) {
                    if (e.result == "KILL") total_kills++;
                }
            }

            std::cerr << "\n=== Results ===\n"
                      << "Completed: " << results.size() << " runs in "
                      << elapsed << "s\n"
                      << "Errors: " << errors << "\n"
                      << "Total engagements: " << total_engagements << "\n"
                      << "Total kills: " << total_kills << "\n"
                      << "Avg kills/run: "
                      << (results.size() > 0 ? static_cast<double>(total_kills) / results.size() : 0)
                      << "\n";
        }

        // Write output
        if (config.output_path.empty()) {
            sim::mc::write_results_json(results, config.num_runs,
                                        config.base_seed, config.max_sim_time,
                                        std::cout);
        } else {
            std::ofstream out(config.output_path);
            if (!out.is_open()) {
                std::cerr << "Error: cannot open output file: "
                          << config.output_path << "\n";
                return 1;
            }
            sim::mc::write_results_json(results, config.num_runs,
                                        config.base_seed, config.max_sim_time,
                                        out);
            if (config.verbose) {
                std::cerr << "Results written to: " << config.output_path << "\n";
            }
        }

        if (config.progress) {
            std::cerr << "{\"type\":\"done\",\"mode\":\"batch\",\"runs\":"
                      << results.size() << ",\"elapsed\":" << elapsed << "}\n"
                      << std::flush;
        }
    }

    return 0;
}
