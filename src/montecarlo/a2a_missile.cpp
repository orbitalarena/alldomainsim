#include "montecarlo/a2a_missile.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <algorithm>
#include <limits>

namespace sim::mc {

// Default weapon specifications — initialized on first update if a2a_specs is empty
static void ensure_default_specs(MCEntity& e) {
    if (!e.a2a_specs.empty()) return;

    e.a2a_specs["aim120"] = WeaponSpec{"aim120", 80000.0, 0.75, 1400.0};
    e.a2a_specs["aim9"]   = WeaponSpec{"aim9",   18000.0, 0.85,  900.0};
    e.a2a_specs["r77"]    = WeaponSpec{"r77",    80000.0, 0.70, 1300.0};
    e.a2a_specs["r73"]    = WeaponSpec{"r73",    18000.0, 0.80,  850.0};
}

/**
 * Select the best weapon for a given range.
 * Prefers the shortest-range weapon that still covers the target (min-overkill).
 * Returns a reference to the chosen WeaponSpec (must have count > 0 in inventory).
 */
static const WeaponSpec* select_best_weapon(MCEntity& e, double range) {
    const WeaponSpec* best = nullptr;
    double best_range = std::numeric_limits<double>::max();

    for (const auto& [name, count] : e.a2a_inventory) {
        if (count <= 0) continue;

        auto spec_it = e.a2a_specs.find(name);
        if (spec_it == e.a2a_specs.end()) continue;

        const WeaponSpec& spec = spec_it->second;
        if (spec.range >= range && spec.range < best_range) {
            best = &spec;
            best_range = spec.range;
        }
    }

    return best;
}

/**
 * Check if any weapon remains in inventory.
 */
static bool has_any_ammo(const MCEntity& e) {
    for (const auto& [name, count] : e.a2a_inventory) {
        if (count > 0) return true;
    }
    return false;
}

void A2AMissile::update_all(double dt, MCWorld& world) {
    for (auto& entity : world.entities()) {
        if (entity.weapon_type != WeaponType::A2A_MISSILE) continue;
        if (!entity.active || entity.destroyed) continue;
        update_entity(entity, dt, world);
    }
}

void A2AMissile::update_entity(MCEntity& e, double dt, MCWorld& world) {
    // Weapons hold — don't engage
    if (e.engagement_rules == "weapons_hold") return;

    // Initialize default weapon specs if needed
    ensure_default_specs(e);

    // Winchester check — no weapons left
    if (!has_any_ammo(e)) return;

    double self_lat_rad = e.geo_lat * M_PI / 180.0;
    double self_lon_rad = e.geo_lon * M_PI / 180.0;

    // ── Advance existing engagements ──
    for (auto it = e.a2a_engagements.begin(); it != e.a2a_engagements.end(); ) {
        A2AEngagement& eng = *it;

        eng.phase_timer -= dt;
        if (eng.phase_timer > 0.0) {
            ++it;
            continue;
        }

        switch (eng.phase) {

        case 0: {
            // LOCK → FIRE
            MCEntity* target = world.get_entity(eng.target_id);
            if (!target || !target->active || target->destroyed) {
                it = e.a2a_engagements.erase(it);
                break;
            }

            // Check weapon availability
            auto inv_it = e.a2a_inventory.find(eng.weapon_type);
            if (inv_it == e.a2a_inventory.end() || inv_it->second <= 0) {
                it = e.a2a_engagements.erase(it);
                break;
            }

            // Decrement inventory
            inv_it->second--;

            // Log LAUNCH
            e.engagements.push_back(EngagementRecord{
                eng.target_id,
                target->name,
                "LAUNCH",
                world.sim_time
            });

            // Compute TOF
            double range = slant_range_ecef(
                self_lat_rad, self_lon_rad, e.geo_alt,
                target->geo_lat * M_PI / 180.0,
                target->geo_lon * M_PI / 180.0,
                target->geo_alt);

            auto spec_it = e.a2a_specs.find(eng.weapon_type);
            double missile_speed = (spec_it != e.a2a_specs.end())
                                   ? spec_it->second.speed : 1000.0;
            double tof = range / missile_speed;

            eng.phase = 1;
            eng.phase_timer = tof;
            ++it;
            break;
        }

        case 1: {
            // GUIDE complete → ASSESS
            MCEntity* target = world.get_entity(eng.target_id);

            // Roll Pk
            auto spec_it = e.a2a_specs.find(eng.weapon_type);
            double pk = (spec_it != e.a2a_specs.end()) ? spec_it->second.pk : 0.5;

            bool hit = world.rng.bernoulli(pk);

            if (hit && target && target->active && !target->destroyed) {
                target->active = false;
                target->destroyed = true;

                // Log KILL on shooter
                e.engagements.push_back(EngagementRecord{
                    eng.target_id,
                    target->name,
                    "KILL",
                    world.sim_time
                });

                // Log KILLED_BY on target
                target->engagements.push_back(EngagementRecord{
                    e.id,
                    e.name,
                    "KILLED_BY",
                    world.sim_time
                });
            } else {
                // Log MISS
                e.engagements.push_back(EngagementRecord{
                    eng.target_id,
                    target ? target->name : eng.target_id,
                    "MISS",
                    world.sim_time
                });
            }

            eng.phase = 2;
            eng.phase_timer = 2.0;  // assess time
            ++it;
            break;
        }

        case 2: {
            // ASSESS complete → remove
            it = e.a2a_engagements.erase(it);
            break;
        }

        default:
            it = e.a2a_engagements.erase(it);
            break;
        }
    }

    // ── Look for new targets ──

    // Helper: check if already engaging a target
    auto is_engaging = [&](const std::string& target_id) -> bool {
        for (const auto& eng : e.a2a_engagements) {
            if (eng.target_id == target_id) return true;
        }
        return false;
    };

    // Source 1: Own radar detections (if this entity has a radar)
    if (e.has_radar) {
        for (const auto& det : e.radar_detections) {
            if (is_engaging(det.entity_id)) continue;

            MCEntity* target = world.get_entity(det.entity_id);
            if (!target || !target->active || target->destroyed) continue;

            // Compute range from self to target
            double range = slant_range_ecef(
                self_lat_rad, self_lon_rad, e.geo_alt,
                target->geo_lat * M_PI / 180.0,
                target->geo_lon * M_PI / 180.0,
                target->geo_alt);

            // Select best weapon for this range
            const WeaponSpec* spec = select_best_weapon(e, range);
            if (!spec) continue;

            e.a2a_engagements.push_back(A2AEngagement{
                det.entity_id,
                0,                  // phase = LOCK
                e.a2a_lock_time,    // lock time
                spec->name          // weapon type
            });
        }
    }

    // Source 2: Intercept AI target assignment
    if (e.intercept_state == 1 && !e.intercept_target_id.empty()) {
        if (!is_engaging(e.intercept_target_id)) {
            MCEntity* target = world.get_entity(e.intercept_target_id);
            if (target && target->active && !target->destroyed) {
                double range = slant_range_ecef(
                    self_lat_rad, self_lon_rad, e.geo_alt,
                    target->geo_lat * M_PI / 180.0,
                    target->geo_lon * M_PI / 180.0,
                    target->geo_alt);

                const WeaponSpec* spec = select_best_weapon(e, range);
                if (spec) {
                    e.a2a_engagements.push_back(A2AEngagement{
                        e.intercept_target_id,
                        0,                  // phase = LOCK
                        e.a2a_lock_time,
                        spec->name
                    });
                }
            }
        }
    }
}

const WeaponSpec& A2AMissile::select_weapon(MCEntity& e, double range) {
    // Delegate to the free function, with a fallback to the first available spec
    const WeaponSpec* best = select_best_weapon(e, range);
    if (best) return *best;

    // Fallback: return any weapon spec that has inventory
    for (const auto& [name, count] : e.a2a_inventory) {
        if (count > 0) {
            auto it = e.a2a_specs.find(name);
            if (it != e.a2a_specs.end()) return it->second;
        }
    }

    // Last resort: return first spec (should not reach here if has_any_ammo passed)
    return e.a2a_specs.begin()->second;
}

} // namespace sim::mc
