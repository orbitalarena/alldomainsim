/**
 * MCEntity — Flat entity struct for headless Monte Carlo simulation.
 *
 * All component data (physics, AI, weapons, sensors) inlined into a single
 * struct for cache locality and zero virtual dispatch. No ECS overhead.
 *
 * Multi-domain: supports orbital (Kepler), atmospheric (3-DOF flight),
 * ground/static, radar sensors, SAM batteries, A2A missiles, and events.
 */

#ifndef SIM_MC_MC_ENTITY_HPP
#define SIM_MC_MC_ENTITY_HPP

#include <string>
#include <vector>
#include <unordered_map>
#include "core/state_vector.hpp"

namespace sim::mc {

// ── Type enums ──

enum class PhysicsType {
    NONE,
    ORBITAL_2BODY,    // Kepler propagation (ECI)
    FLIGHT_3DOF,      // Atmospheric flight (geodetic)
    STATIC            // Ground station, SAM site (fixed geodetic)
};

enum class AIType {
    NONE,
    ORBITAL_COMBAT,   // Original orbital AI (defend/attack HVAs)
    WAYPOINT_PATROL,  // Fly waypoint route
    INTERCEPT         // Chase and engage a target entity
};

enum class WeaponType {
    NONE,
    KINETIC_KILL,     // Orbital KKV
    SAM_BATTERY,      // Surface-to-air missile
    A2A_MISSILE       // Air-to-air missile
};

enum class CombatRole {
    HVA,
    DEFENDER,
    ATTACKER,
    ESCORT,
    SWEEP,
    NONE
};

inline const char* role_to_string(CombatRole role) {
    switch (role) {
        case CombatRole::HVA:      return "hva";
        case CombatRole::DEFENDER:  return "defender";
        case CombatRole::ATTACKER:  return "attacker";
        case CombatRole::ESCORT:    return "escort";
        case CombatRole::SWEEP:     return "sweep";
        default:                    return "";
    }
}

inline CombatRole string_to_role(const std::string& s) {
    if (s == "hva")       return CombatRole::HVA;
    if (s == "defender")  return CombatRole::DEFENDER;
    if (s == "attacker")  return CombatRole::ATTACKER;
    if (s == "escort")    return CombatRole::ESCORT;
    if (s == "sweep")     return CombatRole::SWEEP;
    return CombatRole::NONE;
}

inline PhysicsType string_to_physics_type(const std::string& s) {
    if (s == "orbital_2body") return PhysicsType::ORBITAL_2BODY;
    if (s == "flight3dof")    return PhysicsType::FLIGHT_3DOF;
    if (s == "static")        return PhysicsType::STATIC;
    if (s == "ground")        return PhysicsType::STATIC;
    return PhysicsType::NONE;
}

inline AIType string_to_ai_type(const std::string& s) {
    if (s == "orbital_combat")   return AIType::ORBITAL_COMBAT;
    if (s == "waypoint_patrol")  return AIType::WAYPOINT_PATROL;
    if (s == "intercept")        return AIType::INTERCEPT;
    return AIType::NONE;
}

inline WeaponType string_to_weapon_type(const std::string& s) {
    if (s == "kinetic_kill")  return WeaponType::KINETIC_KILL;
    if (s == "sam_battery")   return WeaponType::SAM_BATTERY;
    if (s == "a2a_missile")   return WeaponType::A2A_MISSILE;
    if (s == "fighter_loadout") return WeaponType::A2A_MISSILE;
    return WeaponType::NONE;
}

// ── Sub-structs ──

struct EngagementRecord {
    std::string target_id;
    std::string target_name;
    std::string result;   // "LAUNCH", "KILL", "MISS", "KILLED_BY"
    double time = 0.0;
};

struct Waypoint {
    double lat = 0.0;    // degrees
    double lon = 0.0;    // degrees
    double alt = 0.0;    // meters
    double speed = 0.0;  // m/s (0 = maintain current)
};

struct RadarDetection {
    std::string entity_id;
    double range = 0.0;      // meters
    double bearing = 0.0;    // radians
    double time = 0.0;
};

struct SAMEngagement {
    std::string target_id;
    int phase = 0;            // 0=DETECT, 1=TRACK, 2=ENGAGE, 3=ASSESS
    double phase_timer = 0.0;
    int missiles_fired = 0;
};

struct A2AEngagement {
    std::string target_id;
    int phase = 0;            // 0=LOCK, 1=FIRE, 2=GUIDE, 3=ASSESS
    double phase_timer = 0.0;
    std::string weapon_type;  // "aim120", "aim9", etc.
};

struct WeaponSpec {
    std::string name;
    double range = 0.0;      // meters
    double pk = 0.0;
    double speed = 0.0;      // m/s (for TOF calculation)
};

struct MCEntity {
    // ── Identity ──
    std::string id;
    std::string name;
    std::string type;     // "satellite", "aircraft", "ground", "sam", "radar", etc.
    std::string team;     // "blue", "red"

    // ── State ──
    bool active = true;
    bool destroyed = false;

    // ── Type discriminators ──
    PhysicsType physics_type = PhysicsType::NONE;
    AIType ai_type = AIType::NONE;
    WeaponType weapon_type = WeaponType::NONE;

    // ── ECI state (orbital entities) ──
    Vec3 eci_pos{0, 0, 0};   // meters, ECI
    Vec3 eci_vel{0, 0, 0};   // m/s, ECI

    // ── Orbital elements (cached from init) ──
    double sma = 0.0;
    double ecc = 0.0;
    double inc_rad = 0.0;
    double raan_rad = 0.0;
    double arg_pe_rad = 0.0;
    double mean_anomaly_rad = 0.0;

    // ── Geodetic position (atmospheric / ground entities) ──
    double geo_lat = 0.0;    // degrees
    double geo_lon = 0.0;    // degrees
    double geo_alt = 0.0;    // meters

    // ── Flight state (3-DOF atmospheric) ──
    double flight_speed = 0.0;    // m/s TAS
    double flight_heading = 0.0;  // radians, true north CW
    double flight_gamma = 0.0;    // radians, flight path angle
    double flight_roll = 0.0;     // radians, bank angle
    double flight_alpha = 0.0;    // radians, angle of attack
    double flight_mach = 0.0;     // current Mach number
    double flight_throttle = 0.8; // 0-1 throttle position
    bool   flight_engine_on = true;

    // ── Aircraft parameters ──
    double ac_mass = 12000.0;
    double ac_wing_area = 28.0;
    double ac_ar = 3.0;            // aspect ratio
    double ac_cd0 = 0.025;
    double ac_oswald = 0.8;
    double ac_cl_alpha = 5.5;      // per radian
    double ac_cl_max = 1.5;
    double ac_thrust_mil = 80000.0;
    double ac_thrust_ab = 130000.0;
    double ac_max_g = 9.0;
    double ac_max_aoa_rad = 0.35;  // ~20 degrees

    // ── Waypoint patrol state ──
    std::vector<Waypoint> waypoints;
    int waypoint_index = 0;
    bool waypoint_loop = true;

    // ── Intercept AI state ──
    std::string intercept_target_id;
    int intercept_mode = 0;          // 0=pursuit, 1=lead, 2=stern
    double intercept_engage_range = 0.0;
    int intercept_state = 0;         // 0=navigating, 1=engaged

    // ── Radar sensor state ──
    bool has_radar = false;
    double radar_max_range = 300000.0;    // meters
    double radar_fov_deg = 360.0;
    double radar_min_elev_deg = -5.0;
    double radar_max_elev_deg = 80.0;
    double radar_sweep_interval = 0.5;    // seconds
    double radar_sweep_timer = 0.0;
    double radar_p_detect = 0.9;
    std::vector<RadarDetection> radar_detections;

    // ── SAM battery state ──
    double sam_max_range = 150000.0;
    double sam_min_range = 5000.0;
    double sam_missile_speed = 1200.0;    // m/s
    int sam_missiles_ready = 8;
    int sam_salvo_size = 2;
    double sam_pk_per_missile = 0.7;
    std::vector<SAMEngagement> sam_engagements;

    // ── A2A missile state ──
    std::vector<std::string> a2a_loadout;   // ordered list: ["aim120","aim120","aim9","aim9"]
    std::unordered_map<std::string, int> a2a_inventory; // "aim120" -> count
    std::unordered_map<std::string, WeaponSpec> a2a_specs; // weapon type -> spec
    std::vector<A2AEngagement> a2a_engagements;
    double a2a_lock_time = 1.5;

    // ── Engagement rules ──
    std::string engagement_rules = "weapons_free";  // "weapons_free", "weapons_hold", "weapons_tight"

    // ── Legacy compatibility flags (mapped from type discriminators) ──
    bool has_physics = false;  // = physics_type != NONE
    bool has_ai = false;       // = ai_type != NONE
    bool has_weapon = false;   // = weapon_type != NONE

    // ── Orbital Combat AI fields (original) ──
    CombatRole role = CombatRole::NONE;
    double sensor_range = 1000000.0;
    double defense_radius = 500000.0;
    double max_accel = 50.0;
    double kill_range = 50000.0;
    double scan_interval = 1.0;
    double scan_timer = 0.0;
    std::string assigned_hva_id;
    std::string current_target;      // entity ID of current target
    std::string kk_target_id;        // signal to weapon system

    // ── Kinetic Kill weapon fields (original) ──
    double pk = 0.7;
    double weapon_kill_range = 50000.0;
    double cooldown_time = 5.0;
    double cooldown_timer = 0.0;
    std::string last_launch_target;

    // ── Per-entity engagement log ──
    std::vector<EngagementRecord> engagements;
};

} // namespace sim::mc

#endif // SIM_MC_MC_ENTITY_HPP
