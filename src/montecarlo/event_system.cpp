/**
 * EventSystem — Evaluates scenario event triggers and executes actions.
 *
 * Iterates over world.events each tick. For unfired events, checks the
 * trigger condition (time, proximity, detection) and executes the action
 * (message, change_rules, set_state) when triggered.
 */

#include "event_system.hpp"
#include "geo_utils.hpp"
#include <cmath>
#include <iostream>

namespace sim::mc {

static constexpr double OMEGA_EARTH = 7.2921159e-5;  // rad/s
static constexpr double DEG_TO_RAD  = M_PI / 180.0;

// ── ECI → ECEF rotation (GMST = 0 at t = 0) ──

static Vec3 eci_to_ecef(const Vec3& eci, double sim_time) {
    double gmst = OMEGA_EARTH * sim_time;
    double c = std::cos(gmst);
    double s = std::sin(gmst);
    return Vec3{
         c * eci.x + s * eci.y,
        -s * eci.x + c * eci.y,
         eci.z
    };
}

// ── Euclidean distance between two Vec3 positions ──

static double euclidean_distance(const Vec3& a, const Vec3& b) {
    double dx = b.x - a.x;
    double dy = b.y - a.y;
    double dz = b.z - a.z;
    return std::sqrt(dx * dx + dy * dy + dz * dz);
}

// ── Helper: get ECEF position for any entity ──

static Vec3 entity_ecef_position(const MCEntity& e, double sim_time) {
    if (e.physics_type == PhysicsType::ORBITAL_2BODY) {
        return eci_to_ecef(e.eci_pos, sim_time);
    }
    // Geodetic entity (FLIGHT_3DOF or STATIC) — convert degrees to radians
    return geodetic_to_ecef(e.geo_lat * DEG_TO_RAD,
                            e.geo_lon * DEG_TO_RAD,
                            e.geo_alt);
}

// ── Helper: is the entity geodetic (FLIGHT_3DOF or STATIC)? ──

static bool is_geodetic(const MCEntity& e) {
    return e.physics_type == PhysicsType::FLIGHT_3DOF
        || e.physics_type == PhysicsType::STATIC;
}

// ══════════════════════════════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════════════════════════════

void EventSystem::update_all(double /*dt*/, MCWorld& world) {
    for (auto& event : world.events) {
        if (event.fired) continue;

        if (check_trigger(event.trigger, world)) {
            execute_action(event.action, world);
            event.fired = true;
        }
    }
}

// ══════════════════════════════════════════════════════════════════
//  Trigger evaluation
// ══════════════════════════════════════════════════════════════════

bool EventSystem::check_trigger(const EventTrigger& trigger, MCWorld& world) {

    // ── Time trigger ──
    if (trigger.type == "time") {
        return world.sim_time >= trigger.time;
    }

    // ── Proximity trigger ──
    if (trigger.type == "proximity") {
        MCEntity* a = world.get_entity(trigger.entity_a);
        MCEntity* b = world.get_entity(trigger.entity_b);
        if (!a || !b) return false;
        if (!a->active || a->destroyed) return false;
        if (!b->active || b->destroyed) return false;

        double distance = 0.0;

        if (is_geodetic(*a) && is_geodetic(*b)) {
            // Both geodetic — use haversine (ground distance)
            distance = haversine_distance(
                a->geo_lat * DEG_TO_RAD, a->geo_lon * DEG_TO_RAD,
                b->geo_lat * DEG_TO_RAD, b->geo_lon * DEG_TO_RAD);
        } else {
            // At least one is orbital — compare ECEF positions (slant range)
            Vec3 pa = entity_ecef_position(*a, world.sim_time);
            Vec3 pb = entity_ecef_position(*b, world.sim_time);
            distance = euclidean_distance(pa, pb);
        }

        return distance <= trigger.range;
    }

    // ── Detection trigger ──
    if (trigger.type == "detection") {
        MCEntity* sensor = world.get_entity(trigger.sensor_entity);
        if (!sensor) return false;
        if (!sensor->has_radar) return false;

        for (const auto& det : sensor->radar_detections) {
            if (det.entity_id == trigger.target_entity) {
                return true;
            }
        }
        return false;
    }

    return false;
}

// ══════════════════════════════════════════════════════════════════
//  Action execution
// ══════════════════════════════════════════════════════════════════

void EventSystem::execute_action(const EventAction& action, MCWorld& world) {

    // ── Message ──
    if (action.type == "message") {
        // Log to stderr (replay writer can pick up fired events separately)
        std::cerr << "[EVENT] " << action.message << std::endl;
        return;
    }

    // ── Change engagement rules ──
    if (action.type == "change_rules") {
        MCEntity* entity = world.get_entity(action.entity_id);
        if (!entity) return;
        entity->engagement_rules = action.value;
        return;
    }

    // ── Set arbitrary state field ──
    if (action.type == "set_state") {
        MCEntity* entity = world.get_entity(action.entity_id);
        if (!entity) return;

        if (action.field == "engagementRules" || action.field == "engagement_rules") {
            entity->engagement_rules = action.value;
        } else if (action.field == "active") {
            entity->active = (action.value == "true");
        } else if (action.field == "destroyed") {
            entity->destroyed = (action.value == "true");
        }
        return;
    }
}

} // namespace sim::mc
