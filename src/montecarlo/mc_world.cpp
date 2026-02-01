#include "montecarlo/mc_world.hpp"

namespace sim::mc {

void MCWorld::add_entity(MCEntity&& entity) {
    size_t index = entities_.size();
    id_to_index_[entity.id] = index;
    entities_.push_back(std::move(entity));
}

MCEntity* MCWorld::get_entity(const std::string& id) {
    auto it = id_to_index_.find(id);
    if (it == id_to_index_.end()) return nullptr;
    return &entities_[it->second];
}

const MCEntity* MCWorld::get_entity(const std::string& id) const {
    auto it = id_to_index_.find(id);
    if (it == id_to_index_.end()) return nullptr;
    return &entities_[it->second];
}

} // namespace sim::mc
