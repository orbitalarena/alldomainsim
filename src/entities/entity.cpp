#include "entities/entity.hpp"
#include "io/json_writer.hpp"
#include "io/json_reader.hpp"

namespace sim {

Entity::Entity(const std::string& name, int id)
    : id_(id), name_(name), domain_(PhysicsDomain::GROUND) {
}

void Entity::serialize_entity(JsonWriter& /*writer*/) const {
    // Base class has no extra fields — subclasses override
}

void Entity::deserialize_entity(const JsonValue& /*json*/) {
    // Base class has no extra fields — subclasses override
}

} // namespace sim
