#ifndef SIMULATION_MODE_HPP
#define SIMULATION_MODE_HPP

namespace sim {

/**
 * @brief Simulation execution modes
 * 
 * MODEL_MODE: Run at maximum computational speed for data generation
 * SIMULATION_MODE: Run in real-time (or scaled) for interactive scenarios
 */
enum class SimulationMode {
    MODEL_MODE,      // Maximum speed computation
    SIMULATION_MODE  // Real-time with human/AI in-the-loop
};

/**
 * @brief Time scale factor for simulation mode
 * 
 * 1.0 = real-time
 * > 1.0 = faster than real-time
 * < 1.0 = slower than real-time
 */
struct TimeScale {
    double factor = 1.0;
    
    bool is_realtime() const { return factor == 1.0; }
    bool is_accelerated() const { return factor > 1.0; }
    bool is_slowed() const { return factor < 1.0; }
};

} // namespace sim

#endif // SIMULATION_MODE_HPP
