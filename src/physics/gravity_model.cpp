#include "physics/gravity_model.hpp"
#include "physics/gravity_utils.hpp"

namespace sim {

Vec3 GravityModel::compute_two_body(const Vec3& position) {
    // Use consolidated utility function
    return gravity::two_body_acceleration(position, EARTH_MU);
}

Vec3 GravityModel::compute_with_j2(const Vec3& position) {
    // Use consolidated utility function with Earth constants
    return gravity::body_acceleration(position, gravity::BodyConstants::EARTH, true);
}

StateVector GravityModel::compute_derivatives(const StateVector& state, bool use_j2) {
    StateVector derivative;
    
    // Derivative of position is velocity
    derivative.velocity = state.velocity;
    
    // Derivative of velocity is acceleration (stored in position field for integrator)
    Vec3 acceleration = use_j2 ? compute_with_j2(state.position) 
                                : compute_two_body(state.position);
    
    derivative.position = acceleration;  // Store acceleration in position field
    
    derivative.time = 1.0;  // dt/dt = 1
    derivative.frame = state.frame;
    
    return derivative;
}

} // namespace sim
