/**
 * Checkpoint / Resume System
 *
 * Save and restore full simulation state as JSON.
 * Serializes all entities, simulation time, and mode.
 *
 * JSON format:
 * {
 *   "version": 1,
 *   "sim_time": 12345.0,
 *   "mode": "MODEL",
 *   "time_scale": 1.0,
 *   "entities": [
 *     {
 *       "type": "Satellite",
 *       "id": 1,
 *       "name": "ISS",
 *       "domain": "ORBITAL",
 *       "state": {
 *         "position": [x, y, z],
 *         "velocity": [vx, vy, vz],
 *         "attitude": [w, x, y, z],
 *         "angular_velocity": [wx, wy, wz],
 *         "time": 12345.0,
 *         "frame": "J2000_ECI"
 *       },
 *       "entity_data": { ... type-specific ... }
 *     },
 *     ...
 *   ]
 * }
 */

#ifndef SIM_CHECKPOINT_HPP
#define SIM_CHECKPOINT_HPP

#include "core/state_vector.hpp"
#include "core/physics_domain.hpp"
#include <string>
#include <memory>
#include <vector>

namespace sim {

class SimulationEngine;
class Entity;
class JsonWriter;
class JsonValue;

class Checkpoint {
public:
    /**
     * Save the current simulation state to a JSON file.
     *
     * @param engine The simulation engine to save
     * @param filename Output file path
     * @return true on success
     */
    static bool save(const SimulationEngine& engine, const std::string& filename);

    /**
     * Load simulation state from a JSON file.
     * Replaces all entities and resets simulation time.
     *
     * @param filename Input file path
     * @param engine The simulation engine to restore into
     * @return true on success
     */
    static bool load(const std::string& filename, SimulationEngine& engine);

private:
    // Serialize a StateVector to JSON
    static void write_state_vector(JsonWriter& w, const StateVector& s);

    // Deserialize a StateVector from JSON
    static StateVector read_state_vector(const JsonValue& json);

    // Serialize a single entity
    static void write_entity(JsonWriter& w, const Entity& entity);

    // Entity factory: create entity from type string
    static std::shared_ptr<Entity> create_entity(
        const std::string& type, int id, const std::string& name);

    // Frame name conversions
    static std::string frame_to_string(CoordinateFrame frame);
    static CoordinateFrame string_to_frame(const std::string& s);

    // Domain name conversions
    static std::string domain_to_string(PhysicsDomain domain);
    static PhysicsDomain string_to_domain(const std::string& s);
};

}  // namespace sim

#endif  // SIM_CHECKPOINT_HPP
