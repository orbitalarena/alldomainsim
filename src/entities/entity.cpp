#include "entities/entity.hpp"

namespace sim {

Entity::Entity(const std::string& name, int id)
    : id_(id), name_(name), domain_(PhysicsDomain::GROUND) {
}

} // namespace sim
