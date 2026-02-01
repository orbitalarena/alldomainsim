/**
 * MCRunner — Batch Monte Carlo orchestrator.
 *
 * Runs N independent simulations with seeded RNG, each creating a fresh
 * world from the scenario JSON. Collects engagements and survival data.
 * Supports early termination when combat is resolved.
 */

#ifndef SIM_MC_MC_RUNNER_HPP
#define SIM_MC_MC_RUNNER_HPP

#include "mc_world.hpp"
#include "mc_results.hpp"
#include "replay_writer.hpp"
#include "scenario_parser.hpp"
#include "io/json_reader.hpp"
#include <vector>
#include <functional>

namespace sim::mc {

class MCRunner {
public:
    using ProgressCallback = std::function<void(int completed, int total)>;

    explicit MCRunner(const MCConfig& config);

    /**
     * Run all MC iterations against the given scenario.
     * Returns per-run results array ready for JSON serialization.
     */
    std::vector<RunResult> run(const sim::JsonValue& scenario,
                               ProgressCallback on_progress = nullptr);

    /**
     * Run a single simulation with trajectory sampling for replay.
     * Outputs replay JSON directly to the given stream.
     */
    void run_replay(const sim::JsonValue& scenario, std::ostream& out);

private:
    MCConfig config_;

    /**
     * Run a single MC iteration.
     */
    RunResult run_single(const sim::JsonValue& scenario, int run_index, int seed);

    /**
     * Tick the world one timestep: AI → Physics → Weapons.
     */
    void tick(MCWorld& world, double dt);

    /**
     * Check if combat is resolved (early termination condition).
     * Returns true if all HVAs on one side are destroyed,
     * or all combat units on one side are destroyed.
     */
    bool all_combat_resolved(const MCWorld& world) const;

    /**
     * Collect engagement events from entity logs.
     * Deduplicates using the seen set.
     */
    void collect_engagements(MCWorld& world, double sim_time,
                             std::vector<EngagementEvent>& log,
                             std::unordered_map<std::string, bool>& seen);

    /**
     * Collect survival data at end of run.
     */
    std::unordered_map<std::string, EntitySurvival>
    collect_survival(const MCWorld& world) const;
};

} // namespace sim::mc

#endif // SIM_MC_MC_RUNNER_HPP
