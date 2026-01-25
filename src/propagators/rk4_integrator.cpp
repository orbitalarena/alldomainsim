#include "propagators/rk4_integrator.hpp"

namespace sim {

StateVector RK4Integrator::step(const StateVector& state, 
                                 double dt, 
                                 DerivativeFunction compute_derivatives) {
    // Classic RK4: y(t+dt) = y(t) + (k1 + 2*k2 + 2*k3 + k4) / 6
    
    // k1 = f(t, y)
    StateVector k1 = compute_derivatives(state);
    
    // k2 = f(t + dt/2, y + k1*dt/2)
    StateVector state_k2 = add_scaled(state, k1, dt / 2.0);
    StateVector k2 = compute_derivatives(state_k2);
    
    // k3 = f(t + dt/2, y + k2*dt/2)
    StateVector state_k3 = add_scaled(state, k2, dt / 2.0);
    StateVector k3 = compute_derivatives(state_k3);
    
    // k4 = f(t + dt, y + k3*dt)
    StateVector state_k4 = add_scaled(state, k3, dt);
    StateVector k4 = compute_derivatives(state_k4);
    
    // Combine: new_state = state + dt * (k1 + 2*k2 + 2*k3 + k4) / 6
    StateVector new_state = state;
    
    new_state.position.x += dt * (k1.velocity.x + 2*k2.velocity.x + 2*k3.velocity.x + k4.velocity.x) / 6.0;
    new_state.position.y += dt * (k1.velocity.y + 2*k2.velocity.y + 2*k3.velocity.y + k4.velocity.y) / 6.0;
    new_state.position.z += dt * (k1.velocity.z + 2*k2.velocity.z + 2*k3.velocity.z + k4.velocity.z) / 6.0;
    
    // For derivatives, velocity is stored in velocity field, acceleration in position field
    new_state.velocity.x += dt * (k1.position.x + 2*k2.position.x + 2*k3.position.x + k4.position.x) / 6.0;
    new_state.velocity.y += dt * (k1.position.y + 2*k2.position.y + 2*k3.position.y + k4.position.y) / 6.0;
    new_state.velocity.z += dt * (k1.position.z + 2*k2.position.z + 2*k3.position.z + k4.position.z) / 6.0;
    
    new_state.time += dt;
    
    return new_state;
}

StateVector RK4Integrator::add_scaled(const StateVector& s1, const StateVector& s2, double scale) {
    StateVector result = s1;
    
    // Add scaled velocity (for position update)
    result.position.x += s2.velocity.x * scale;
    result.position.y += s2.velocity.y * scale;
    result.position.z += s2.velocity.z * scale;
    
    // Add scaled acceleration (stored in position field of derivative, for velocity update)
    result.velocity.x += s2.position.x * scale;
    result.velocity.y += s2.position.y * scale;
    result.velocity.z += s2.position.z * scale;
    
    result.time += scale;
    
    return result;
}

} // namespace sim
