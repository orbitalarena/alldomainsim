/**
 * ScenarioParser — Parse builder scenario JSON into MCWorld.
 *
 * Reads the same JSON format produced by the browser scenario builder.
 * Handles orbital_2body physics, orbital_combat AI, and kinetic_kill weapons.
 */

#ifndef SIM_MC_SCENARIO_PARSER_HPP
#define SIM_MC_SCENARIO_PARSER_HPP

#include "mc_world.hpp"
#include "io/json_reader.hpp"
#include <string>

namespace sim::mc {

struct MCConfig {
    int num_runs = 100;
    int base_seed = 42;
    double max_sim_time = 600.0;
    double dt = 0.1;                // matches JS HEADLESS_DT
    std::string scenario_path;
    std::string output_path;        // empty = stdout
    bool verbose = false;

    // Replay mode: single run with trajectory sampling
    bool replay_mode = false;
    double sample_interval = 2.0;   // seconds between position samples
};

class ScenarioParser {
public:
    /**
     * Parse a scenario JSON value and build a fresh MCWorld.
     * Called once per MC run to get a clean initial state.
     */
    static MCWorld parse(const sim::JsonValue& scenario);

    /**
     * Parse a single entity definition from the scenario JSON.
     */
    static MCEntity parse_entity(const sim::JsonValue& entity_def);
};

} // namespace sim::mc

#endif // SIM_MC_SCENARIO_PARSER_HPP
