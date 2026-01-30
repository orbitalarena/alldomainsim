#ifndef ENTITY_HPP
#define ENTITY_HPP

#include "core/state_vector.hpp"
#include "core/physics_domain.hpp"
#include <string>
#include <memory>

// Forward declarations for serialization
namespace sim {
class JsonWriter;
class JsonValue;
}

namespace sim {

/**
 * @brief Base class for all simulated entities
 * 
 * Entities represent spacecraft, satellites, aircraft, ground vehicles, etc.
 * Each entity has a unique ID, name, state, and applicable physics domain
 */
class Entity {
public:
    Entity(const std::string& name, int id);
    virtual ~Entity() = default;
    
    // Getters
    int get_id() const { return id_; }
    const std::string& get_name() const { return name_; }
    const StateVector& get_state() const { return state_; }
    StateVector& get_state() { return state_; }
    PhysicsDomain get_physics_domain() const { return domain_; }
    
    // Setters
    void set_state(const StateVector& state) { state_ = state; }
    void set_physics_domain(PhysicsDomain domain) { domain_ = domain; }
    
    // Update state based on time step
    virtual void update(double dt) = 0;
    
    // Get 3D model path (if applicable)
    virtual std::string get_model_path() const { return ""; }

    // Serialization support for checkpoint/resume
    virtual std::string entity_type() const { return "Entity"; }
    virtual void serialize_entity(JsonWriter& writer) const;
    virtual void deserialize_entity(const JsonValue& json);

protected:
    int id_;
    std::string name_;
    StateVector state_;
    PhysicsDomain domain_;
};

} // namespace sim

#endif // ENTITY_HPP
