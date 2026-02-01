/**
 * MCWorld — Entity container for headless Monte Carlo simulation.
 *
 * Holds all entities in a contiguous vector for cache-friendly iteration.
 * Provides O(1) entity lookup by string ID via unordered_map index.
 * Also holds scenario events for trigger/action evaluation.
 */

#ifndef SIM_MC_MC_WORLD_HPP
#define SIM_MC_MC_WORLD_HPP

#include "mc_entity.hpp"
#include "sim_rng.hpp"
#include <vector>
#include <unordered_map>
#include <string>

namespace sim::mc {

// ── Scenario Events (trigger → action) ──

struct EventTrigger {
    std::string type;         // "time", "proximity", "detection"

    // time trigger
    double time = 0.0;

    // proximity trigger
    std::string entity_a;     // entityA or entityId
    std::string entity_b;     // entityB or targetId
    double range = 0.0;       // meters

    // detection trigger
    std::string sensor_entity;  // sensorEntityId
    std::string target_entity;  // targetEntityId
};

struct EventAction {
    std::string type;           // "message", "change_rules", "set_state"

    // message
    std::string message;

    // change_rules / set_state
    std::string entity_id;
    std::string field;          // e.g. "engagementRules"
    std::string value;          // e.g. "weapons_free"
};

struct ScenarioEvent {
    std::string id;
    std::string name;
    EventTrigger trigger;
    EventAction action;
    bool fired = false;
};

class MCWorld {
public:
    MCWorld() = default;

    void add_entity(MCEntity&& entity);

    MCEntity* get_entity(const std::string& id);
    const MCEntity* get_entity(const std::string& id) const;

    std::vector<MCEntity>& entities() { return entities_; }
    const std::vector<MCEntity>& entities() const { return entities_; }

    size_t entity_count() const { return entities_.size(); }

    double sim_time = 0.0;
    SimRNG rng{42};

    // Scenario events
    std::vector<ScenarioEvent> events;

private:
    std::vector<MCEntity> entities_;
    std::unordered_map<std::string, size_t> id_to_index_;
};

} // namespace sim::mc

#endif // SIM_MC_MC_WORLD_HPP
