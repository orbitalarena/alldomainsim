#include "montecarlo/kinetic_kill.hpp"
#include "physics/vec3_ops.hpp"
#include <cmath>

namespace sim::mc {

void KineticKill::update_all(double dt, MCWorld& world) {
    for (auto& entity : world.entities()) {
        if (!entity.has_weapon) continue;
        if (!entity.active || entity.destroyed) continue;
        update_entity(entity, dt, world);
    }
}

void KineticKill::update_entity(MCEntity& entity, double dt, MCWorld& world) {
    // Handle cooldown after miss
    if (entity.cooldown_timer > 0.0) {
        entity.cooldown_timer -= dt;
        if (entity.cooldown_timer <= 0.0) {
            entity.cooldown_timer = 0.0;
        }
        return;
    }

    // Check if AI has designated a target
    if (entity.kk_target_id.empty()) return;

    MCEntity* target = world.get_entity(entity.kk_target_id);
    if (!target || !target->active || target->destroyed) {
        entity.kk_target_id.clear();
        return;
    }

    // Compute ECI distance
    double dx = target->eci_pos.x - entity.eci_pos.x;
    double dy = target->eci_pos.y - entity.eci_pos.y;
    double dz = target->eci_pos.z - entity.eci_pos.z;
    double dist = std::sqrt(dx * dx + dy * dy + dz * dz);

    // Log LAUNCH event when first engaging a new target
    if (entity.kk_target_id != entity.last_launch_target) {
        entity.last_launch_target = entity.kk_target_id;
        entity.engagements.push_back({
            entity.kk_target_id,
            target->name,
            "LAUNCH",
            world.sim_time
        });
    }

    // Check if within kill range
    if (dist <= entity.weapon_kill_range) {
        // Pk roll using seeded RNG
        bool hit = world.rng.bernoulli(entity.pk);

        if (hit) {
            // KILL — mutual destruction

            // Destroy target
            target->active = false;
            target->destroyed = true;

            // Log KILLED_BY on target
            target->engagements.push_back({
                entity.id,
                entity.name,
                "KILLED_BY",
                world.sim_time
            });

            // Destroy self (kinetic kill is sacrificial)
            entity.active = false;
            entity.destroyed = true;

            // Log engagement on attacker
            entity.engagements.push_back({
                entity.kk_target_id,
                target->name,
                "KILL",
                world.sim_time
            });
        } else {
            // MISS — enter cooldown
            entity.cooldown_timer = entity.cooldown_time;
            entity.kk_target_id.clear();

            // Log miss
            entity.engagements.push_back({
                entity.kk_target_id.empty() ? entity.last_launch_target : entity.kk_target_id,
                target->name,
                "MISS",
                world.sim_time
            });
        }
    }
}

} // namespace sim::mc
