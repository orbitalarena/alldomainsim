/**
 * MCResults — Result data structures and JSON serialization.
 *
 * Output format matches what the browser MCAnalysis.aggregate() expects,
 * so results can be loaded directly into the MC Analysis panel.
 */

#ifndef SIM_MC_MC_RESULTS_HPP
#define SIM_MC_MC_RESULTS_HPP

#include <string>
#include <vector>
#include <unordered_map>
#include <ostream>

namespace sim::mc {

struct EngagementEvent {
    double time = 0.0;
    std::string source_id;
    std::string source_name;
    std::string source_team;
    std::string target_id;
    std::string target_name;
    std::string result;        // "LAUNCH", "KILL", "MISS", "KILLED_BY"
    std::string weapon_type;   // "KKV"
};

struct EntitySurvival {
    std::string name;
    std::string team;
    std::string type;
    std::string role;          // empty if no role
    bool alive = true;
    bool destroyed = false;
};

struct RunResult {
    int run_index = 0;
    int seed = 0;
    double sim_time_final = 0.0;
    std::vector<EngagementEvent> engagement_log;
    std::unordered_map<std::string, EntitySurvival> entity_survival;
    std::string error;         // empty = success
};

/**
 * Write results as JSON consumable by browser MCAnalysis.
 * Format: { "config": {...}, "runs": [...] }
 * The "runs" array passes directly to MCAnalysis.aggregate().
 */
void write_results_json(const std::vector<RunResult>& results,
                        int num_runs, int base_seed, double max_sim_time,
                        std::ostream& out);

} // namespace sim::mc

#endif // SIM_MC_MC_RESULTS_HPP
