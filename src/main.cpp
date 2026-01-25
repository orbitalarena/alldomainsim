#include "core/simulation_engine.hpp"
#include <iostream>

int main(int argc, char* argv[]) {
    std::cout << "All-Domain Simulation Environment v0.1.0" << std::endl;
    std::cout << "==========================================" << std::endl;
    
    // Create simulation engine
    sim::SimulationEngine engine;
    
    // Initialize
    engine.initialize();
    
    std::cout << "Simulation engine initialized." << std::endl;
    std::cout << "Mode: " << (engine.get_mode() == sim::SimulationMode::MODEL_MODE ? 
                               "MODEL" : "SIMULATION") << std::endl;
    std::cout << "Time scale: " << engine.get_time_scale() << "x" << std::endl;
    
    // TODO: Load scenario, add entities, run simulation
    
    std::cout << "\nSimulation framework ready." << std::endl;
    std::cout << "Next steps: Add entities and run scenarios." << std::endl;
    
    return 0;
}
