#ifndef SIMULATION_ENGINE_HPP
#define SIMULATION_ENGINE_HPP

#include "core/simulation_mode.hpp"
#include "entities/entity.hpp"
#include <vector>
#include <memory>
#include <chrono>

namespace sim {

/**
 * @brief Main simulation engine
 * 
 * Manages all entities, time progression, and mode switching
 * Orchestrates physics updates and output generation
 */
class SimulationEngine {
public:
    SimulationEngine();
    ~SimulationEngine() = default;
    
    // Entity management
    void add_entity(std::shared_ptr<Entity> entity);
    void remove_entity(int entity_id);
    std::shared_ptr<Entity> get_entity(int entity_id);
    const std::vector<std::shared_ptr<Entity>>& get_all_entities() const;
    
    // Mode control
    void set_mode(SimulationMode mode);
    SimulationMode get_mode() const { return mode_; }
    void set_time_scale(double scale);
    double get_time_scale() const { return time_scale_.factor; }
    
    // Simulation control
    void initialize();
    void step(double dt);  // Single time step
    void run_until(double end_time);  // Run until specified time
    void pause();
    void resume();
    bool is_running() const { return is_running_; }
    
    // Time management
    double get_simulation_time() const { return sim_time_; }
    void set_simulation_time(double time) { sim_time_ = time; }
    
private:
    SimulationMode mode_;
    TimeScale time_scale_;
    double sim_time_;  // Simulation time [seconds since epoch]
    bool is_running_;
    
    std::vector<std::shared_ptr<Entity>> entities_;
    
    // Internal update loop
    void update_entities(double dt);
    void handle_domain_transitions();
    
    // Timing for real-time mode
    std::chrono::high_resolution_clock::time_point last_update_time_;
};

} // namespace sim

#endif // SIMULATION_ENGINE_HPP
