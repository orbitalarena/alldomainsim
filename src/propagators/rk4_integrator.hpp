#ifndef RK4_INTEGRATOR_HPP
#define RK4_INTEGRATOR_HPP

#include "core/state_vector.hpp"
#include <functional>

namespace sim {

/**
 * @brief Runge-Kutta 4th order integrator
 * 
 * Provides accurate numerical integration for orbital dynamics
 * Much more stable than simple Euler integration
 */
class RK4Integrator {
public:
    /**
     * @brief Function signature for computing state derivatives
     * 
     * Takes current state and returns derivative (velocity, acceleration)
     * f(state) -> dstate/dt
     */
    using DerivativeFunction = std::function<StateVector(const StateVector&)>;
    
    /**
     * @brief Integrate state forward by one time step using RK4
     * 
     * @param state Current state
     * @param dt Time step [seconds]
     * @param compute_derivatives Function to compute state derivatives
     * @return New state after integration
     */
    static StateVector step(const StateVector& state, 
                           double dt, 
                           DerivativeFunction compute_derivatives);

private:
    // Helper to add two state vectors (for RK4 intermediate steps)
    static StateVector add_scaled(const StateVector& s1, const StateVector& s2, double scale);
};

} // namespace sim

#endif // RK4_INTEGRATOR_HPP
