#include "montecarlo/mc_runner.hpp"
#include "montecarlo/orbital_combat_ai.hpp"
#include "montecarlo/kinetic_kill.hpp"
#include "montecarlo/kepler_propagator.hpp"
#include "montecarlo/replay_writer.hpp"
#include "montecarlo/flight3dof.hpp"
#include "montecarlo/waypoint_patrol_ai.hpp"
#include "montecarlo/intercept_ai.hpp"
#include "montecarlo/radar_sensor.hpp"
#include "montecarlo/sam_battery.hpp"
#include "montecarlo/a2a_missile.hpp"
#include "montecarlo/event_system.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <iostream>

namespace sim::mc {

MCRunner::MCRunner(const MCConfig& config)
    : config_(config) {}

std::vector<RunResult> MCRunner::run(const sim::JsonValue& scenario,
                                     ProgressCallback on_progress) {
    std::vector<RunResult> results;
    results.reserve(config_.num_runs);

    for (int i = 0; i < config_.num_runs; i++) {
        int seed = config_.base_seed + i;

        if (config_.verbose) {
            std::cerr << "Run " << (i + 1) << "/" << config_.num_runs
                      << " (seed=" << seed << ")..." << std::flush;
        }

        RunResult result = run_single(scenario, i, seed);
        results.push_back(std::move(result));

        if (config_.verbose) {
            std::cerr << " done (t=" << results.back().sim_time_final
                      << "s, engagements=" << results.back().engagement_log.size()
                      << ")\n";
        }

        if (on_progress) {
            on_progress(i + 1, config_.num_runs);
        }
    }

    return results;
}

RunResult MCRunner::run_single(const sim::JsonValue& scenario,
                               int run_index, int seed) {
    RunResult result;
    result.run_index = run_index;
    result.seed = seed;

    try {
        // Build fresh world from scenario
        MCWorld world = ScenarioParser::parse(scenario);
        world.rng.setSeed(seed);
        world.sim_time = 0.0;

        int total_steps = static_cast<int>(
            std::ceil(config_.max_sim_time / config_.dt));
        double dt = config_.dt;

        std::unordered_map<std::string, bool> seen_engagements;

        for (int step = 0; step < total_steps; step++) {
            world.sim_time += dt;

            // System execution order: AI → Physics → Sensors → Weapons → Events
            tick(world, dt);

            // Collect engagements periodically (every 200 steps like JS)
            if (step % 200 == 199 || step == total_steps - 1) {
                collect_engagements(world, world.sim_time,
                                    result.engagement_log, seen_engagements);
            }

            // Early termination check
            if (all_combat_resolved(world)) {
                // Final engagement collection
                collect_engagements(world, world.sim_time,
                                    result.engagement_log, seen_engagements);
                break;
            }
        }

        result.sim_time_final = world.sim_time;
        result.entity_survival = collect_survival(world);

    } catch (const std::exception& e) {
        result.error = std::string("Run error: ") + e.what();
    }

    return result;
}

void MCRunner::tick(MCWorld& world, double dt) {
    // 1. AI systems
    OrbitalCombatAI::update_all(dt, world);
    WaypointPatrolAI::update_all(dt, world);
    InterceptAI::update_all(dt, world);

    // 2. Physics systems
    for (auto& entity : world.entities()) {
        if (!entity.active || entity.destroyed) continue;

        switch (entity.physics_type) {
            case PhysicsType::ORBITAL_2BODY:
                propagate_kepler(entity.eci_pos, entity.eci_vel, dt);
                break;
            case PhysicsType::FLIGHT_3DOF:
                // Handled by Flight3DOF::update_all below
                break;
            case PhysicsType::STATIC:
            case PhysicsType::NONE:
                break;
        }
    }
    Flight3DOF::update_all(dt, world);

    // 3. Sensors
    RadarSensor::update_all(dt, world);

    // 4. Weapon systems
    KineticKill::update_all(dt, world);
    SAMBattery::update_all(dt, world);
    A2AMissile::update_all(dt, world);

    // 5. Events
    EventSystem::update_all(dt, world);
}

bool MCRunner::all_combat_resolved(const MCWorld& world) const {
    // Orbital combat resolution (existing)
    int blue_hva_alive = 0, red_hva_alive = 0;
    int blue_combat_alive = 0, red_combat_alive = 0;
    bool has_orbital_combat = false;

    // Atmospheric combat resolution
    int blue_atmo_alive = 0, red_atmo_alive = 0;
    bool has_atmo_combat = false;

    for (const auto& entity : world.entities()) {
        bool alive = entity.active && !entity.destroyed;

        // Orbital combat entities (have orbital AI with roles)
        if (entity.ai_type == AIType::ORBITAL_COMBAT &&
            entity.role != CombatRole::NONE) {
            has_orbital_combat = true;
            if (entity.role == CombatRole::HVA) {
                if (alive) {
                    if (entity.team == "blue") blue_hva_alive++;
                    else if (entity.team == "red") red_hva_alive++;
                }
            } else {
                if (alive) {
                    if (entity.team == "blue") blue_combat_alive++;
                    else if (entity.team == "red") red_combat_alive++;
                }
            }
        }

        // Atmospheric combat entities (aircraft with AI or weapons)
        if (entity.physics_type == PhysicsType::FLIGHT_3DOF &&
            (entity.has_ai || entity.has_weapon)) {
            has_atmo_combat = true;
            if (alive) {
                if (entity.team == "blue") blue_atmo_alive++;
                else if (entity.team == "red") red_atmo_alive++;
            }
        }
    }

    // Orbital: terminate if all HVAs or all combat units on one side destroyed
    if (has_orbital_combat) {
        if (blue_hva_alive == 0 || red_hva_alive == 0) return true;
        if (blue_combat_alive == 0 || red_combat_alive == 0) return true;
    }

    // Atmospheric: terminate if all aircraft on one side destroyed
    if (has_atmo_combat) {
        if (blue_atmo_alive == 0 || red_atmo_alive == 0) return true;
    }

    return false;
}

void MCRunner::collect_engagements(MCWorld& world, double sim_time,
                                   std::vector<EngagementEvent>& log,
                                   std::unordered_map<std::string, bool>& seen) {
    for (const auto& entity : world.entities()) {
        for (const auto& eng : entity.engagements) {
            // Deduplication key
            std::string key = entity.id + "_" + eng.target_id +
                              "_" + eng.result + "_" +
                              std::to_string(eng.time);

            if (seen.count(key)) continue;
            seen[key] = true;

            // Filter: only LAUNCH, KILL, MISS (not KILLED_BY — that's the victim side)
            if (eng.result != "LAUNCH" && eng.result != "KILL" && eng.result != "MISS") {
                continue;
            }

            EngagementEvent evt;
            evt.time = eng.time;
            evt.source_id = entity.id;
            evt.source_name = entity.name;
            evt.source_team = entity.team;
            evt.target_id = eng.target_id;
            evt.target_name = eng.target_name;
            evt.result = eng.result;

            // Weapon type from entity
            if (entity.weapon_type == WeaponType::KINETIC_KILL) evt.weapon_type = "KKV";
            else if (entity.weapon_type == WeaponType::SAM_BATTERY) evt.weapon_type = "SAM";
            else if (entity.weapon_type == WeaponType::A2A_MISSILE) evt.weapon_type = "A2A";
            else evt.weapon_type = "UNK";

            log.push_back(std::move(evt));
        }
    }
}

std::unordered_map<std::string, EntitySurvival>
MCRunner::collect_survival(const MCWorld& world) const {
    std::unordered_map<std::string, EntitySurvival> survival;

    for (const auto& entity : world.entities()) {
        EntitySurvival s;
        s.name = entity.name;
        s.team = entity.team;
        s.type = entity.type;
        s.role = role_to_string(entity.role);
        s.alive = entity.active && !entity.destroyed;
        s.destroyed = entity.destroyed;
        survival[entity.id] = std::move(s);
    }

    return survival;
}

// Helper: get ECEF position for any entity type
static Vec3 entity_ecef(const MCEntity& e, double sim_time) {
    static constexpr double DEG_TO_RAD = M_PI / 180.0;

    switch (e.physics_type) {
        case PhysicsType::ORBITAL_2BODY:
            return ReplayWriter::eci_to_ecef(e.eci_pos, sim_time);
        case PhysicsType::FLIGHT_3DOF:
        case PhysicsType::STATIC:
            return geodetic_to_ecef(e.geo_lat * DEG_TO_RAD,
                                    e.geo_lon * DEG_TO_RAD,
                                    e.geo_alt);
        default:
            return Vec3{0, 0, 0};
    }
}

void MCRunner::run_replay(const sim::JsonValue& scenario,
                          std::ostream& out) {
    MCWorld world = ScenarioParser::parse(scenario);
    world.rng.setSeed(config_.base_seed);
    world.sim_time = 0.0;

    // Save initial entity list (before any mutations)
    std::vector<MCEntity> initial_entities = world.entities();

    ReplayWriter writer;
    writer.init(initial_entities, config_.sample_interval);

    int total_steps = static_cast<int>(
        std::ceil(config_.max_sim_time / config_.dt));
    double dt = config_.dt;

    // Track which entities were alive last step (for death detection)
    std::vector<bool> was_alive(world.entity_count(), true);

    // Track per-entity engagement record counts to detect new events
    std::vector<size_t> prev_eng_counts(world.entity_count(), 0);

    // Initial sample at t=0
    writer.sample(world);

    for (int step = 0; step < total_steps; step++) {
        world.sim_time += dt;

        // System execution order: AI → Physics → Sensors → Weapons → Events
        tick(world, dt);

        // Sample positions at interval
        writer.sample(world);

        // Detect deaths and new engagement events
        const auto& entities = world.entities();
        for (size_t i = 0; i < entities.size(); i++) {
            const auto& e = entities[i];

            // Death detection
            if (was_alive[i] && (e.destroyed || !e.active)) {
                was_alive[i] = false;
                writer.record_death(e.id, world.sim_time);
            }

            // Scan only NEW engagement records (append-only per entity)
            for (size_t j = prev_eng_counts[i]; j < e.engagements.size(); j++) {
                const auto& eng = e.engagements[j];
                if (eng.result != "LAUNCH" && eng.result != "KILL" && eng.result != "MISS") {
                    continue;
                }

                // Get source and target positions in ECEF
                Vec3 source_ecef = entity_ecef(e, world.sim_time);

                Vec3 target_ecef{0, 0, 0};
                const MCEntity* target = world.get_entity(eng.target_id);
                if (target) {
                    target_ecef = entity_ecef(*target, world.sim_time);
                }

                ReplayEvent evt;
                evt.time = eng.time;
                evt.type = eng.result;
                evt.source_id = e.id;
                evt.target_id = eng.target_id;
                evt.source_pos = source_ecef;
                evt.target_pos = target_ecef;
                writer.record_event(evt);
            }
            prev_eng_counts[i] = e.engagements.size();
        }

        // Progress reporting
        if (config_.verbose && step % 1000 == 999) {
            std::cerr << "  Step " << (step + 1) << "/" << total_steps
                      << " (t=" << world.sim_time << "s)\n";
        }

        // Early termination
        if (all_combat_resolved(world)) {
            // Final sample
            writer.sample(world);

            if (config_.verbose) {
                std::cerr << "  Combat resolved at t=" << world.sim_time
                          << "s (step " << (step + 1) << ")\n";
            }
            break;
        }
    }

    // Write replay JSON
    writer.write_json(out, config_, initial_entities);
}

} // namespace sim::mc
