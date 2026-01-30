/**
 * Checkpoint / Resume Implementation
 */

#include "checkpoint.hpp"
#include "json_writer.hpp"
#include "json_reader.hpp"
#include "core/simulation_engine.hpp"
#include "entities/entity.hpp"
#include "entities/satellite.hpp"
#include "entities/launch_vehicle.hpp"
#include "entities/aircraft.hpp"
#include "entities/fighter.hpp"
#include "entities/command_module.hpp"
#include <fstream>
#include <iostream>

namespace sim {

// ─────────────────────────────────────────────────────────────
// String conversions
// ─────────────────────────────────────────────────────────────

std::string Checkpoint::frame_to_string(CoordinateFrame frame) {
    switch (frame) {
        case CoordinateFrame::TEME:               return "TEME";
        case CoordinateFrame::J2000_ECI:          return "J2000_ECI";
        case CoordinateFrame::ECEF:               return "ECEF";
        case CoordinateFrame::BODY:               return "BODY";
        case CoordinateFrame::HELIOCENTRIC_J2000: return "HELIOCENTRIC_J2000";
        case CoordinateFrame::PLANET_CENTERED:    return "PLANET_CENTERED";
        default:                                  return "J2000_ECI";
    }
}

CoordinateFrame Checkpoint::string_to_frame(const std::string& s) {
    if (s == "TEME")               return CoordinateFrame::TEME;
    if (s == "ECEF")               return CoordinateFrame::ECEF;
    if (s == "BODY")               return CoordinateFrame::BODY;
    if (s == "HELIOCENTRIC_J2000") return CoordinateFrame::HELIOCENTRIC_J2000;
    if (s == "PLANET_CENTERED")    return CoordinateFrame::PLANET_CENTERED;
    return CoordinateFrame::J2000_ECI;
}

std::string Checkpoint::domain_to_string(PhysicsDomain domain) {
    switch (domain) {
        case PhysicsDomain::GROUND:  return "GROUND";
        case PhysicsDomain::AERO:    return "AERO";
        case PhysicsDomain::ROCKET:  return "ROCKET";
        case PhysicsDomain::ORBITAL: return "ORBITAL";
        default:                     return "GROUND";
    }
}

PhysicsDomain Checkpoint::string_to_domain(const std::string& s) {
    if (s == "AERO")    return PhysicsDomain::AERO;
    if (s == "ROCKET")  return PhysicsDomain::ROCKET;
    if (s == "ORBITAL") return PhysicsDomain::ORBITAL;
    return PhysicsDomain::GROUND;
}

// ─────────────────────────────────────────────────────────────
// StateVector serialization
// ─────────────────────────────────────────────────────────────

void Checkpoint::write_state_vector(JsonWriter& w, const StateVector& s) {
    w.begin_object();
    w.key("position").begin_array();
      w.value(s.position.x); w.value(s.position.y); w.value(s.position.z);
    w.end_array();
    w.key("velocity").begin_array();
      w.value(s.velocity.x); w.value(s.velocity.y); w.value(s.velocity.z);
    w.end_array();
    w.key("attitude").begin_array();
      w.value(s.attitude.w); w.value(s.attitude.x);
      w.value(s.attitude.y); w.value(s.attitude.z);
    w.end_array();
    w.key("angular_velocity").begin_array();
      w.value(s.angular_velocity.x); w.value(s.angular_velocity.y);
      w.value(s.angular_velocity.z);
    w.end_array();
    w.kv("time", s.time);
    w.kv("frame", frame_to_string(s.frame));
    w.end_object();
}

StateVector Checkpoint::read_state_vector(const JsonValue& json) {
    StateVector s;

    if (json.has("position")) {
        const auto& p = json["position"];
        s.position = Vec3(p[0].get_number(), p[1].get_number(), p[2].get_number());
    }
    if (json.has("velocity")) {
        const auto& v = json["velocity"];
        s.velocity = Vec3(v[0].get_number(), v[1].get_number(), v[2].get_number());
    }
    if (json.has("attitude")) {
        const auto& a = json["attitude"];
        s.attitude = Quat(a[0].get_number(1.0), a[1].get_number(),
                          a[2].get_number(), a[3].get_number());
    }
    if (json.has("angular_velocity")) {
        const auto& w = json["angular_velocity"];
        s.angular_velocity = Vec3(w[0].get_number(), w[1].get_number(), w[2].get_number());
    }
    s.time = json["time"].get_number();
    s.frame = string_to_frame(json["frame"].get_string("J2000_ECI"));

    return s;
}

// ─────────────────────────────────────────────────────────────
// Entity serialization
// ─────────────────────────────────────────────────────────────

void Checkpoint::write_entity(JsonWriter& w, const Entity& entity) {
    w.begin_object();
    w.kv("type", entity.entity_type());
    w.kv("id", entity.get_id());
    w.kv("name", entity.get_name());
    w.kv("domain", domain_to_string(entity.get_physics_domain()));

    w.key("state");
    write_state_vector(w, entity.get_state());

    // Type-specific data
    w.key("entity_data");
    w.begin_object();
    entity.serialize_entity(w);
    w.end_object();

    w.end_object();
}

std::shared_ptr<Entity> Checkpoint::create_entity(
    const std::string& type, int id, const std::string& name) {

    if (type == "Satellite") {
        // Create with dummy TLE — state will be overwritten from checkpoint
        TLE dummy_tle;
        dummy_tle.name = name;
        dummy_tle.satellite_number = id;
        return std::make_shared<Satellite>(name, id, dummy_tle, false);
    }
    if (type == "LaunchVehicle") {
        // Create at origin — state will be overwritten from checkpoint
        return std::make_shared<LaunchVehicle>(name, id, 0.0, 0.0, 0.0);
    }
    if (type == "Aircraft") {
        AircraftConfig config;
        config.name = name;
        return std::make_shared<Aircraft>(id, name, config);
    }
    if (type == "Fighter") {
        FighterConfig config;
        return std::make_shared<Fighter>(id, name, Team::BLUE, config);
    }
    if (type == "CommandModule") {
        return std::make_shared<CommandModule>(name, id);
    }

    // Unknown type — create a command module as generic placeholder
    std::cerr << "[Checkpoint] Unknown entity type '" << type
              << "', creating CommandModule placeholder\n";
    return std::make_shared<CommandModule>(name, id);
}

// ─────────────────────────────────────────────────────────────
// Save / Load
// ─────────────────────────────────────────────────────────────

bool Checkpoint::save(const SimulationEngine& engine, const std::string& filename) {
    std::ofstream file(filename);
    if (!file.is_open()) {
        std::cerr << "[Checkpoint] Cannot open file for writing: " << filename << "\n";
        return false;
    }

    JsonWriter w(file);
    w.begin_object();

    w.kv("version", 1);
    w.kv("sim_time", engine.get_simulation_time());

    std::string mode_str = (engine.get_mode() == SimulationMode::MODEL_MODE)
                            ? "MODEL" : "SIMULATION";
    w.kv("mode", mode_str);
    w.kv("time_scale", engine.get_time_scale());

    // Entities
    const auto& entities = engine.get_all_entities();
    w.key("entities").begin_array();
    for (const auto& e : entities) {
        write_entity(w, *e);
    }
    w.end_array();

    w.end_object();
    file << "\n";

    std::cout << "[Checkpoint] Saved " << entities.size()
              << " entities to " << filename << "\n";
    return true;
}

bool Checkpoint::load(const std::string& filename, SimulationEngine& engine) {
    JsonValue root;
    try {
        root = JsonReader::parse_file(filename);
    } catch (const std::exception& e) {
        std::cerr << "[Checkpoint] Parse error: " << e.what() << "\n";
        return false;
    }

    // Version check
    int version = root["version"].get_int(0);
    if (version < 1) {
        std::cerr << "[Checkpoint] Unsupported version: " << version << "\n";
        return false;
    }

    // Restore simulation time
    engine.set_simulation_time(root["sim_time"].get_number());

    // Restore mode
    std::string mode_str = root["mode"].get_string("MODEL");
    engine.set_mode(mode_str == "SIMULATION" ? SimulationMode::SIMULATION_MODE
                                              : SimulationMode::MODEL_MODE);
    engine.set_time_scale(root["time_scale"].get_number(1.0));

    // Clear existing entities and load from checkpoint
    // Note: We can't remove entities by ID easily, so we need to access the engine differently.
    // For now, we assume the engine starts fresh for loading.

    // Load entities
    const auto& entities_json = root["entities"];
    int loaded = 0;
    for (size_t i = 0; i < entities_json.size(); i++) {
        const auto& ej = entities_json[i];

        std::string type = ej["type"].get_string("Entity");
        int id = ej["id"].get_int(static_cast<int>(i));
        std::string name = ej["name"].get_string("Unknown");

        auto entity = create_entity(type, id, name);
        if (!entity) continue;

        // Restore state
        if (ej.has("state")) {
            entity->set_state(read_state_vector(ej["state"]));
        }

        // Restore domain
        entity->set_physics_domain(
            string_to_domain(ej["domain"].get_string("GROUND")));

        // Type-specific restoration
        if (ej.has("entity_data")) {
            entity->deserialize_entity(ej["entity_data"]);
        }

        engine.add_entity(entity);
        loaded++;
    }

    std::cout << "[Checkpoint] Loaded " << loaded
              << " entities from " << filename << "\n";
    return true;
}

}  // namespace sim
