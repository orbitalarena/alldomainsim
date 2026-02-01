#include "montecarlo/orbital_combat_ai.hpp"
#include "physics/vec3_ops.hpp"
#include <algorithm>
#include <cmath>
#include <limits>

namespace sim::mc {

void OrbitalCombatAI::update_all(double dt, MCWorld& world) {
    // Thread-local target buffer to avoid per-entity allocation
    static thread_local std::vector<TargetInfo> target_buf;

    for (auto& entity : world.entities()) {
        if (!entity.has_ai) continue;
        if (!entity.active || entity.destroyed) continue;

        // HVAs are passive
        if (entity.role == CombatRole::HVA) continue;

        // Periodic sensor sweep
        entity.scan_timer += dt;
        if (entity.scan_timer >= entity.scan_interval) {
            entity.scan_timer = 0.0;
            target_buf.clear();
            scan_for_targets(entity, world, target_buf);
        }

        // Target selection based on role
        switch (entity.role) {
            case CombatRole::DEFENDER:
                select_target_defender(entity, world, target_buf);
                break;
            case CombatRole::ATTACKER:
                select_target_attacker(entity, target_buf);
                break;
            case CombatRole::ESCORT:
                select_target_escort(entity, dt, world, target_buf);
                break;
            case CombatRole::SWEEP:
                select_target_sweep(entity, target_buf);
                break;
            default:
                break;
        }

        // Act on current target
        if (!entity.current_target.empty()) {
            MCEntity* target = world.get_entity(entity.current_target);
            if (target && target->active && !target->destroyed) {
                Vec3 delta = target->eci_pos - entity.eci_pos;
                double dist = delta.norm();

                if (dist < entity.kill_range) {
                    // Within kill range — signal weapon system
                    entity.kk_target_id = entity.current_target;
                } else {
                    // Close the distance
                    entity.kk_target_id.clear();
                    apply_thrust(entity, dt, target->eci_pos);
                }
                continue;
            }

            // Target became invalid
            entity.current_target.clear();
        }

        // No target
        entity.kk_target_id.clear();
    }
}

void OrbitalCombatAI::scan_for_targets(MCEntity& entity, MCWorld& world,
                                        std::vector<TargetInfo>& targets) {
    const auto& my_team = entity.team;
    const auto& my_pos = entity.eci_pos;
    double sensor_range = entity.sensor_range;
    double sr_sq = sensor_range * sensor_range;

    for (const auto& other : world.entities()) {
        // Skip self
        if (other.id == entity.id) continue;

        // Skip same team
        if (other.team == my_team) continue;

        // Skip inactive or destroyed
        if (!other.active || other.destroyed) continue;

        // Compute ECI distance (squared first for early rejection)
        double dx = other.eci_pos.x - my_pos.x;
        double dy = other.eci_pos.y - my_pos.y;
        double dz = other.eci_pos.z - my_pos.z;
        double dist_sq = dx * dx + dy * dy + dz * dz;

        if (dist_sq <= sr_sq) {
            double dist = std::sqrt(dist_sq);
            targets.push_back({other.id, dist, other.role});
        }
    }

    // Sort by distance ascending
    std::sort(targets.begin(), targets.end(),
              [](const TargetInfo& a, const TargetInfo& b) {
                  return a.distance < b.distance;
              });
}

void OrbitalCombatAI::select_target_defender(MCEntity& entity, MCWorld& world,
                                              const std::vector<TargetInfo>& targets) {
    // Get assigned HVA position
    MCEntity* hva = nullptr;
    if (!entity.assigned_hva_id.empty()) {
        hva = world.get_entity(entity.assigned_hva_id);
    }
    if (!hva || !hva->active) {
        entity.current_target.clear();
        return;
    }

    const Vec3& hva_pos = hva->eci_pos;
    double def_radius = entity.defense_radius;
    double def_radius_sq = def_radius * def_radius;
    std::string best_id;
    double best_dist = std::numeric_limits<double>::max();

    for (const auto& t : targets) {
        // Only engage offensive roles
        if (t.role != CombatRole::ATTACKER &&
            t.role != CombatRole::SWEEP &&
            t.role != CombatRole::ESCORT) continue;

        // Check if enemy is within defense radius of HVA
        MCEntity* enemy = world.get_entity(t.entity_id);
        if (!enemy) continue;

        double dx = enemy->eci_pos.x - hva_pos.x;
        double dy = enemy->eci_pos.y - hva_pos.y;
        double dz = enemy->eci_pos.z - hva_pos.z;
        double dist_to_hva_sq = dx * dx + dy * dy + dz * dz;

        if (dist_to_hva_sq <= def_radius_sq && t.distance < best_dist) {
            best_id = t.entity_id;
            best_dist = t.distance;
        }
    }

    entity.current_target = best_id;
}

void OrbitalCombatAI::select_target_attacker(MCEntity& entity,
                                              const std::vector<TargetInfo>& targets) {
    std::string best_id;
    double best_dist = std::numeric_limits<double>::max();

    for (const auto& t : targets) {
        if (t.role == CombatRole::HVA && t.distance < best_dist) {
            best_id = t.entity_id;
            best_dist = t.distance;
        }
    }

    entity.current_target = best_id;
}

void OrbitalCombatAI::select_target_escort(MCEntity& entity, double dt,
                                            MCWorld& world,
                                            const std::vector<TargetInfo>& targets) {
    // Priority 1: engage enemy defenders or sweeps
    std::string best_id;
    double best_dist = std::numeric_limits<double>::max();

    for (const auto& t : targets) {
        if ((t.role == CombatRole::DEFENDER || t.role == CombatRole::SWEEP) &&
            t.distance < best_dist) {
            best_id = t.entity_id;
            best_dist = t.distance;
        }
    }

    if (!best_id.empty()) {
        entity.current_target = best_id;
        return;
    }

    // Priority 2: drift toward nearest friendly attacker
    entity.current_target.clear();
    drift_toward_friendly_attacker(entity, dt, world);
}

void OrbitalCombatAI::select_target_sweep(MCEntity& entity,
                                           const std::vector<TargetInfo>& targets) {
    std::string best_id;
    double best_dist = std::numeric_limits<double>::max();

    for (const auto& t : targets) {
        if ((t.role == CombatRole::ATTACKER || t.role == CombatRole::ESCORT) &&
            t.distance < best_dist) {
            best_id = t.entity_id;
            best_dist = t.distance;
        }
    }

    entity.current_target = best_id;
}

void OrbitalCombatAI::drift_toward_friendly_attacker(MCEntity& entity, double dt,
                                                      MCWorld& world) {
    // Only do the expensive scan at scan boundaries
    if (entity.scan_timer > 0.01) return;

    const auto& my_pos = entity.eci_pos;
    std::string nearest_id;
    double nearest_dist = std::numeric_limits<double>::max();

    for (const auto& other : world.entities()) {
        if (other.id == entity.id) continue;
        if (other.team != entity.team) continue;
        if (!other.active || other.destroyed) continue;
        if (other.role != CombatRole::ATTACKER) continue;

        double dx = other.eci_pos.x - my_pos.x;
        double dy = other.eci_pos.y - my_pos.y;
        double dz = other.eci_pos.z - my_pos.z;
        double dist = std::sqrt(dx * dx + dy * dy + dz * dz);

        if (dist < nearest_dist) {
            nearest_dist = dist;
            nearest_id = other.id;
        }
    }

    if (!nearest_id.empty()) {
        MCEntity* friendly = world.get_entity(nearest_id);
        if (friendly) {
            apply_thrust_scaled(entity, dt, friendly->eci_pos, 0.3);
        }
    }
}

void OrbitalCombatAI::apply_thrust(MCEntity& entity, double dt,
                                    const Vec3& target_pos) {
    Vec3 delta = target_pos - entity.eci_pos;
    double dist = delta.norm();
    if (dist < 1.0) return;  // Guard against near-zero division

    double inv_dist = 1.0 / dist;
    double dv = entity.max_accel * dt;

    entity.eci_vel.x += delta.x * inv_dist * dv;
    entity.eci_vel.y += delta.y * inv_dist * dv;
    entity.eci_vel.z += delta.z * inv_dist * dv;
}

void OrbitalCombatAI::apply_thrust_scaled(MCEntity& entity, double dt,
                                           const Vec3& target_pos, double scale) {
    Vec3 delta = target_pos - entity.eci_pos;
    double dist = delta.norm();
    if (dist < 1.0) return;

    double inv_dist = 1.0 / dist;
    double effective_dt = dt > 0 ? dt : entity.scan_interval;
    double dv = entity.max_accel * scale * effective_dt;

    entity.eci_vel.x += delta.x * inv_dist * dv;
    entity.eci_vel.y += delta.y * inv_dist * dv;
    entity.eci_vel.z += delta.z * inv_dist * dv;
}

} // namespace sim::mc
