#include "montecarlo/scenario_parser.hpp"
#include "montecarlo/kepler_propagator.hpp"
#include "montecarlo/aircraft_configs.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>

namespace sim::mc {

MCWorld ScenarioParser::parse(const sim::JsonValue& scenario) {
    MCWorld world;

    // Parse entities array
    const auto& entities = scenario["entities"];
    if (!entities.is_array()) return world;

    for (size_t i = 0; i < entities.size(); i++) {
        MCEntity ent = parse_entity(entities[i]);
        world.add_entity(std::move(ent));
    }

    // Parse events array
    const auto& events = scenario["events"];
    if (events.is_array()) {
        for (size_t i = 0; i < events.size(); i++) {
            const auto& ev = events[i];
            ScenarioEvent se;
            se.id = ev["id"].get_string("");
            se.name = ev["name"].get_string(se.id);

            // Parse trigger
            const auto& trig = ev["trigger"];
            se.trigger.type = trig["type"].get_string("");

            if (se.trigger.type == "time") {
                se.trigger.time = trig["time"].get_number(0.0);

            } else if (se.trigger.type == "proximity") {
                // Handle both naming conventions
                se.trigger.entity_a = trig["entityA"].get_string(
                    trig["entityId"].get_string(""));
                se.trigger.entity_b = trig["entityB"].get_string(
                    trig["targetId"].get_string(""));
                se.trigger.range = trig["range_m"].get_number(
                    trig["range"].get_number(0.0));

            } else if (se.trigger.type == "detection") {
                se.trigger.sensor_entity = trig["sensorEntityId"].get_string(
                    trig["entityA"].get_string(""));
                se.trigger.target_entity = trig["targetEntityId"].get_string(
                    trig["entityB"].get_string(""));
            }

            // Parse action
            const auto& act = ev["action"];
            se.action.type = act["type"].get_string("");

            if (se.action.type == "message") {
                se.action.message = act["text"].get_string(
                    act["message"].get_string(""));

            } else if (se.action.type == "set_state") {
                se.action.entity_id = act["entity"].get_string(
                    act["entityId"].get_string(""));
                se.action.field = act["field"].get_string("");
                se.action.value = act["value"].get_string("");

            } else if (se.action.type == "change_rules") {
                se.action.entity_id = act["entity"].get_string(
                    act["entityId"].get_string(""));
                se.action.field = "engagementRules";
                se.action.value = act["engagementRules"].get_string(
                    act["value"].get_string(""));
            }

            world.events.push_back(std::move(se));
        }
    }

    return world;
}

static void apply_aircraft_config(MCEntity& ent, const std::string& config_name) {
    const auto& cfg = get_aircraft_config(config_name);
    ent.ac_mass       = cfg.mass_loaded;
    ent.ac_wing_area  = cfg.wing_area;
    ent.ac_ar         = cfg.aspect_ratio;
    ent.ac_cd0        = cfg.cd0;
    ent.ac_oswald     = cfg.oswald;
    // Convert cl_alpha from per-degree to per-radian
    ent.ac_cl_alpha   = cfg.cl_alpha * (180.0 / M_PI);
    ent.ac_cl_max     = cfg.cl_max;
    ent.ac_thrust_mil = cfg.thrust_mil;
    ent.ac_thrust_ab  = cfg.thrust_ab;
    ent.ac_max_g      = cfg.max_g;
    ent.ac_max_aoa_rad = cfg.max_aoa_rad;
}

MCEntity ScenarioParser::parse_entity(const sim::JsonValue& def) {
    MCEntity ent;

    // ── Identity ──
    ent.id   = def["id"].get_string("");
    ent.name = def["name"].get_string(ent.id);
    ent.type = def["type"].get_string("satellite");
    ent.team = def["team"].get_string("");

    // ── Initial State (for atmospheric / ground entities) ──
    const auto& state = def["initialState"];
    if (!state.is_null()) {
        ent.geo_lat       = state["lat"].get_number(0.0);
        ent.geo_lon       = state["lon"].get_number(0.0);
        ent.geo_alt       = state["alt"].get_number(0.0);
        ent.flight_speed   = state["speed"].get_number(0.0);
        ent.flight_heading = state["heading"].get_number(0.0) * M_PI / 180.0; // deg→rad
        ent.flight_gamma   = state["gamma"].get_number(0.0) * M_PI / 180.0;
        ent.flight_throttle = state["throttle"].get_number(0.8);
        ent.flight_engine_on = state["engineOn"].get_bool(true);
    }

    // ── Components ──
    const auto& components = def["components"];

    // ── Physics ──
    if (components.has("physics")) {
        const auto& phys = components["physics"];
        std::string phys_type = phys["type"].get_string("");

        if (phys_type == "orbital_2body") {
            ent.physics_type = PhysicsType::ORBITAL_2BODY;
            ent.has_physics = true;

            std::string source = phys["source"].get_string("elements");
            if (source == "elements") {
                double sma    = phys["sma"].get_number(42164000.0);
                double ecc    = phys["ecc"].get_number(0.0001);
                double inc    = phys["inc"].get_number(0.001);
                double raan   = phys["raan"].get_number(0.0);
                double argpe  = phys["argPerigee"].get_number(0.0);
                double ma     = phys["meanAnomaly"].get_number(0.0);
                init_from_elements(ent, sma, ecc, inc, raan, argpe, ma);
            }

        } else if (phys_type == "flight3dof") {
            ent.physics_type = PhysicsType::FLIGHT_3DOF;
            ent.has_physics = true;

            // Apply aircraft config
            std::string config_name = phys["config"].get_string("f16");
            apply_aircraft_config(ent, config_name);
        }
    }

    // Ground / static entities without explicit physics component
    if (ent.physics_type == PhysicsType::NONE &&
        (ent.type == "ground" || ent.type == "sam" || ent.type == "radar")) {
        ent.physics_type = PhysicsType::STATIC;
        ent.has_physics = true;
    }

    // ── AI ──
    if (components.has("ai")) {
        const auto& ai = components["ai"];
        std::string ai_type = ai["type"].get_string("");

        if (ai_type == "orbital_combat") {
            ent.ai_type = AIType::ORBITAL_COMBAT;
            ent.has_ai = true;

            std::string role_str = ai["role"].get_string("attacker");
            ent.role = string_to_role(role_str);

            ent.sensor_range   = ai["sensorRange"].get_number(1000000.0);
            ent.defense_radius = ai["defenseRadius"].get_number(500000.0);
            ent.max_accel      = ai["maxAccel"].get_number(50.0);
            ent.kill_range     = ai["killRange"].get_number(50000.0);
            ent.scan_interval  = ai["scanInterval"].get_number(1.0);

            if (ai.has("assignedHvaId")) {
                ent.assigned_hva_id = ai["assignedHvaId"].get_string("");
            }

        } else if (ai_type == "waypoint_patrol") {
            ent.ai_type = AIType::WAYPOINT_PATROL;
            ent.has_ai = true;

            // Parse waypoints array
            const auto& wps = ai["waypoints"];
            if (wps.is_array()) {
                for (size_t i = 0; i < wps.size(); i++) {
                    Waypoint wp;
                    wp.lat   = wps[i]["lat"].get_number(0.0);
                    wp.lon   = wps[i]["lon"].get_number(0.0);
                    wp.alt   = wps[i]["alt"].get_number(0.0);
                    wp.speed = wps[i]["speed"].get_number(0.0);
                    ent.waypoints.push_back(wp);
                }
            }

            std::string loop = ai["loopMode"].get_string("cycle");
            ent.waypoint_loop = (loop == "cycle" || loop == "loop");

        } else if (ai_type == "intercept") {
            ent.ai_type = AIType::INTERCEPT;
            ent.has_ai = true;

            ent.intercept_target_id = ai["targetId"].get_string("");

            std::string mode = ai["mode"].get_string("pursuit");
            if (mode == "pursuit")   ent.intercept_mode = 0;
            else if (mode == "lead") ent.intercept_mode = 1;
            else if (mode == "stern") ent.intercept_mode = 2;

            ent.intercept_engage_range = ai["engageRange_m"].get_number(
                ai["engageRange"].get_number(0.0));
        }
    }

    // ── Control: player_input → auto-assign waypoint_patrol AI ──
    if (components.has("control")) {
        const auto& ctrl = components["control"];
        std::string ctrl_type = ctrl["type"].get_string("");

        if (ctrl_type == "player_input" && ent.ai_type == AIType::NONE) {
            // Auto-assign waypoint patrol: racetrack orbit pattern
            ent.ai_type = AIType::WAYPOINT_PATROL;
            ent.has_ai = true;
            ent.waypoint_loop = true;

            // Build a 50km x 20km racetrack: fwd, right, back, left
            double heading = ent.flight_heading;  // already in radians
            double lat0 = ent.geo_lat * M_PI / 180.0;
            double lon0 = ent.geo_lon * M_PI / 180.0;
            double alt  = ent.geo_alt;
            double spd  = ent.flight_speed;

            double leg_fwd  = 50000.0;  // 50km forward leg
            double leg_side = 20000.0;  // 20km lateral offset
            double right_hdg = heading + M_PI / 2.0;

            // WP1: 50km ahead
            auto p1 = destination_point(lat0, lon0, heading, leg_fwd);
            // WP2: 50km ahead + 20km right
            auto p2 = destination_point(p1.first, p1.second, right_hdg, leg_side);
            // WP3: back to start longitude, 20km right
            auto p3 = destination_point(lat0, lon0, right_hdg, leg_side);

            auto add_wp = [&](double lat_r, double lon_r) {
                Waypoint wp;
                wp.lat   = lat_r * 180.0 / M_PI;
                wp.lon   = lon_r * 180.0 / M_PI;
                wp.alt   = alt;
                wp.speed = spd;
                ent.waypoints.push_back(wp);
            };

            add_wp(p1.first, p1.second);   // forward
            add_wp(p2.first, p2.second);   // forward-right
            add_wp(p3.first, p3.second);   // back-right
            add_wp(lat0, lon0);            // back to start
        }
    }

    // ── Sensors ──
    if (components.has("sensors")) {
        const auto& sens = components["sensors"];
        std::string sens_type = sens["type"].get_string("");

        if (sens_type == "radar") {
            ent.has_radar = true;
            ent.radar_max_range     = sens["maxRange_m"].get_number(
                sens["maxRange"].get_number(300000.0));
            ent.radar_fov_deg       = sens["fov_deg"].get_number(360.0);
            ent.radar_p_detect      = sens["detectionProbability"].get_number(0.9);
            ent.radar_min_elev_deg  = sens["minElevation_deg"].get_number(-5.0);
            ent.radar_max_elev_deg  = sens["maxElevation_deg"].get_number(80.0);

            // Convert scan rate to interval (if provided)
            double scan_rate = sens["scanRate_dps"].get_number(0.0);
            if (scan_rate > 0.0) {
                ent.radar_sweep_interval = 360.0 / scan_rate;
            }
        }
    }

    // ── Weapons ──
    if (components.has("weapons")) {
        const auto& wpn = components["weapons"];
        std::string wpn_type = wpn["type"].get_string("");

        if (wpn_type == "kinetic_kill") {
            ent.weapon_type = WeaponType::KINETIC_KILL;
            ent.has_weapon = true;
            ent.pk               = wpn["Pk"].get_number(0.7);
            ent.weapon_kill_range = wpn["killRange"].get_number(50000.0);
            ent.cooldown_time    = wpn["cooldown"].get_number(5.0);

        } else if (wpn_type == "sam_battery") {
            ent.weapon_type = WeaponType::SAM_BATTERY;
            ent.has_weapon = true;
            ent.sam_max_range     = wpn["maxRange_m"].get_number(
                wpn["maxRange"].get_number(150000.0));
            ent.sam_min_range     = wpn["minRange_m"].get_number(
                wpn["minRange"].get_number(5000.0));
            ent.sam_missile_speed = wpn["missileSpeed"].get_number(1200.0);
            ent.sam_missiles_ready = wpn["missiles"].get_int(8);
            ent.sam_salvo_size    = wpn["salvoSize"].get_int(2);
            ent.sam_pk_per_missile = wpn["pkPerMissile"].get_number(0.7);

            // Engagement rules from weapons component
            std::string rules = wpn["engagementRules"].get_string("");
            if (!rules.empty()) {
                ent.engagement_rules = rules;
            }

        } else if (wpn_type == "fighter_loadout" || wpn_type == "a2a_missile") {
            ent.weapon_type = WeaponType::A2A_MISSILE;
            ent.has_weapon = true;

            // Parse loadout array
            const auto& loadout = wpn["loadout"];
            if (loadout.is_array()) {
                for (size_t i = 0; i < loadout.size(); i++) {
                    std::string weapon_name = loadout[i].get_string("");
                    if (!weapon_name.empty()) {
                        ent.a2a_loadout.push_back(weapon_name);
                        ent.a2a_inventory[weapon_name]++;
                    }
                }
            }
        }
    }

    return ent;
}

} // namespace sim::mc
