#include "montecarlo/sam_battery.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <algorithm>

namespace sim::mc {

void SAMBattery::update_all(double dt, MCWorld& world) {
    for (auto& entity : world.entities()) {
        if (entity.weapon_type != WeaponType::SAM_BATTERY) continue;
        if (!entity.active || entity.destroyed) continue;
        update_entity(entity, dt, world);
    }
}

void SAMBattery::update_entity(MCEntity& e, double dt, MCWorld& world) {
    // Weapons hold — don't engage
    if (e.engagement_rules == "weapons_hold") return;

    double sam_lat_rad = e.geo_lat * M_PI / 180.0;
    double sam_lon_rad = e.geo_lon * M_PI / 180.0;

    // ── Advance existing engagements through the kill chain ──
    for (auto it = e.sam_engagements.begin(); it != e.sam_engagements.end(); ) {
        SAMEngagement& eng = *it;

        eng.phase_timer -= dt;
        if (eng.phase_timer > 0.0) {
            ++it;
            continue;
        }

        // Phase transition
        switch (eng.phase) {

        case 0: {
            // DETECT → TRACK
            eng.phase = 1;
            eng.phase_timer = 2.0;
            ++it;
            break;
        }

        case 1: {
            // TRACK → ENGAGE
            MCEntity* target = world.get_entity(eng.target_id);
            if (!target || !target->active || target->destroyed) {
                it = e.sam_engagements.erase(it);
                break;
            }
            if (e.sam_missiles_ready <= 0) {
                it = e.sam_engagements.erase(it);
                break;
            }

            // Compute range to target for TOF
            double range = slant_range_ecef(
                sam_lat_rad, sam_lon_rad, e.geo_alt,
                target->geo_lat * M_PI / 180.0,
                target->geo_lon * M_PI / 180.0,
                target->geo_alt);

            double tof = range / e.sam_missile_speed;

            // Fire salvo
            eng.missiles_fired = 0;
            int to_fire = std::min(e.sam_salvo_size, e.sam_missiles_ready);
            for (int i = 0; i < to_fire; ++i) {
                eng.missiles_fired++;
                e.sam_missiles_ready--;

                // Log LAUNCH
                e.engagements.push_back(EngagementRecord{
                    eng.target_id,
                    target->name,
                    "LAUNCH",
                    world.sim_time
                });
            }

            eng.phase = 2;
            eng.phase_timer = tof;
            ++it;
            break;
        }

        case 2: {
            // ENGAGE → ASSESS
            MCEntity* target = world.get_entity(eng.target_id);

            bool any_hit = false;
            for (int i = 0; i < eng.missiles_fired; ++i) {
                if (world.rng.bernoulli(e.sam_pk_per_missile)) {
                    any_hit = true;
                }
            }

            if (any_hit && target && target->active && !target->destroyed) {
                target->active = false;
                target->destroyed = true;

                // Log KILL on SAM
                e.engagements.push_back(EngagementRecord{
                    eng.target_id,
                    target ? target->name : eng.target_id,
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

            eng.phase = 3;
            eng.phase_timer = 3.0;  // assess time
            ++it;
            break;
        }

        case 3: {
            // ASSESS complete → remove engagement
            it = e.sam_engagements.erase(it);
            break;
        }

        default:
            it = e.sam_engagements.erase(it);
            break;
        }
    }

    // ── Look for new targets from same-team radar detections ──
    for (const auto& radar_entity : world.entities()) {
        if (!radar_entity.has_radar) continue;
        if (radar_entity.team != e.team) continue;
        if (!radar_entity.active || radar_entity.destroyed) continue;

        for (const auto& det : radar_entity.radar_detections) {
            // Already engaging this target?
            bool already = false;
            for (const auto& eng : e.sam_engagements) {
                if (eng.target_id == det.entity_id) {
                    already = true;
                    break;
                }
            }
            if (already) continue;

            // Get target entity to check range from THIS SAM
            MCEntity* target = world.get_entity(det.entity_id);
            if (!target || !target->active || target->destroyed) continue;

            // Skip ground/static targets (SAMs shouldn't waste missiles on buildings)
            if (target->physics_type == PhysicsType::STATIC) continue;
            if (target->geo_alt < 100.0) continue;

            // Compute slant range from SAM to target
            double range = slant_range_ecef(
                sam_lat_rad, sam_lon_rad, e.geo_alt,
                target->geo_lat * M_PI / 180.0,
                target->geo_lon * M_PI / 180.0,
                target->geo_alt);

            if (range > e.sam_max_range || range < e.sam_min_range) continue;

            // Create new engagement at DETECT phase
            e.sam_engagements.push_back(SAMEngagement{
                det.entity_id,
                0,      // phase = DETECT
                1.0,    // detect time
                0       // missiles_fired
            });
        }
    }
}

} // namespace sim::mc
