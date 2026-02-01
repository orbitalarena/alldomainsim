#include "montecarlo/mc_results.hpp"
#include "io/json_writer.hpp"

namespace sim::mc {

void write_results_json(const std::vector<RunResult>& results,
                        int num_runs, int base_seed, double max_sim_time,
                        std::ostream& out) {
    sim::JsonWriter w(out);

    w.begin_object();

    // ── config ──
    w.key("config").begin_object();
    w.kv("numRuns", num_runs);
    w.kv("baseSeed", base_seed);
    w.kv("maxSimTime", max_sim_time);
    w.end_object();

    // ── runs ──
    w.key("runs").begin_array();

    for (const auto& run : results) {
        w.begin_object();

        w.kv("runIndex", run.run_index);
        w.kv("seed", run.seed);
        w.kv("simTimeFinal", run.sim_time_final);

        // error: null or string
        if (run.error.empty()) {
            w.key("error").null_value();
        } else {
            w.kv("error", run.error);
        }

        // ── engagementLog ──
        w.key("engagementLog").begin_array();
        for (const auto& evt : run.engagement_log) {
            w.begin_object();
            w.kv("time", evt.time);
            w.kv("sourceId", evt.source_id);
            w.kv("sourceName", evt.source_name);
            w.kv("sourceTeam", evt.source_team);
            w.kv("targetId", evt.target_id);
            w.kv("targetName", evt.target_name);
            w.kv("result", evt.result);
            w.kv("weaponType", evt.weapon_type);
            w.end_object();
        }
        w.end_array();

        // ── entitySurvival ──
        w.key("entitySurvival").begin_object();
        for (const auto& [id, surv] : run.entity_survival) {
            w.key(id).begin_object();
            w.kv("name", surv.name);
            w.kv("team", surv.team);
            w.kv("type", surv.type);

            if (surv.role.empty()) {
                w.key("role").null_value();
            } else {
                w.kv("role", surv.role);
            }

            w.kv("alive", surv.alive);
            w.kv("destroyed", surv.destroyed);
            w.end_object();
        }
        w.end_object();

        w.end_object();
    }

    w.end_array();

    w.end_object();
    out << '\n';
}

} // namespace sim::mc
