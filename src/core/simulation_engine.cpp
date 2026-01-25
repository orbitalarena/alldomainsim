#include "core/simulation_engine.hpp"
#include <algorithm>
#include <thread>

namespace sim {

SimulationEngine::SimulationEngine()
    : mode_(SimulationMode::SIMULATION_MODE),
      sim_time_(0.0),
      is_running_(false) {
    time_scale_.factor = 1.0;
}

void SimulationEngine::add_entity(std::shared_ptr<Entity> entity) {
    entities_.push_back(entity);
}

void SimulationEngine::remove_entity(int entity_id) {
    entities_.erase(
        std::remove_if(entities_.begin(), entities_.end(),
            [entity_id](const std::shared_ptr<Entity>& e) {
                return e->get_id() == entity_id;
            }),
        entities_.end()
    );
}

std::shared_ptr<Entity> SimulationEngine::get_entity(int entity_id) {
    auto it = std::find_if(entities_.begin(), entities_.end(),
        [entity_id](const std::shared_ptr<Entity>& e) {
            return e->get_id() == entity_id;
        });
    
    return (it != entities_.end()) ? *it : nullptr;
}

const std::vector<std::shared_ptr<Entity>>& SimulationEngine::get_all_entities() const {
    return entities_;
}

void SimulationEngine::set_mode(SimulationMode mode) {
    mode_ = mode;
}

void SimulationEngine::set_time_scale(double scale) {
    time_scale_.factor = scale;
}

void SimulationEngine::initialize() {
    sim_time_ = 0.0;
    last_update_time_ = std::chrono::high_resolution_clock::now();
}

void SimulationEngine::step(double dt) {
    // Apply time scale
    double scaled_dt = dt * time_scale_.factor;
    
    // Update all entities
    update_entities(scaled_dt);
    
    // Check for domain transitions
    handle_domain_transitions();
    
    // Advance simulation time
    sim_time_ += scaled_dt;
}

void SimulationEngine::run_until(double end_time) {
    is_running_ = true;
    
    if (mode_ == SimulationMode::MODEL_MODE) {
        // Model mode: run as fast as possible
        double dt = 0.1;  // 100ms time steps (configurable)
        while (sim_time_ < end_time && is_running_) {
            step(dt);
        }
    } else {
        // Simulation mode: respect real-time constraints
        while (sim_time_ < end_time && is_running_) {
            auto now = std::chrono::high_resolution_clock::now();
            auto elapsed = std::chrono::duration<double>(now - last_update_time_).count();
            
            if (elapsed > 0.0) {
                step(elapsed);
                last_update_time_ = now;
            }
            
            // Small sleep to prevent CPU spinning
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void SimulationEngine::pause() {
    is_running_ = false;
}

void SimulationEngine::resume() {
    is_running_ = true;
    last_update_time_ = std::chrono::high_resolution_clock::now();
}

void SimulationEngine::update_entities(double dt) {
    for (auto& entity : entities_) {
        entity->update(dt);
    }
}

void SimulationEngine::handle_domain_transitions() {
    DomainThresholds thresholds;
    
    for (auto& entity : entities_) {
        const StateVector& state = entity->get_state();
        double altitude = state.altitude_msl();
        double velocity = state.velocity.norm();
        
        PhysicsDomain new_domain = thresholds.determine_domain(altitude, velocity);
        
        if (new_domain != entity->get_physics_domain()) {
            entity->set_physics_domain(new_domain);
            // TODO: Log domain transition
        }
    }
}

} // namespace sim
