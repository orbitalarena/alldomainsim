#include "physics/gravity_model.hpp"
#include <cmath>

namespace sim {

Vec3 GravityModel::compute_two_body(const Vec3& position) {
    double r = position.norm();
    double r3 = r * r * r;
    
    Vec3 acceleration;
    acceleration.x = -EARTH_MU * position.x / r3;
    acceleration.y = -EARTH_MU * position.y / r3;
    acceleration.z = -EARTH_MU * position.z / r3;
    
    return acceleration;
}

Vec3 GravityModel::compute_with_j2(const Vec3& position) {
    double r = position.norm();
    double r2 = r * r;
    double r3 = r * r2;
    double r5 = r3 * r2;
    
    // Two-body term
    Vec3 acc_two_body = compute_two_body(position);
    
    // J2 perturbation
    // a_J2 = -(3/2) * J2 * (mu/r^2) * (Re/r)^2 * 
    //        [ (1 - 5*(z/r)^2) * (x, y, z) + (3 - 5*(z/r)^2) * (0, 0, z) ]
    
    double z_over_r = position.z / r;
    double z_over_r_squared = z_over_r * z_over_r;
    
    double re_over_r = EARTH_RADIUS / r;
    double re_over_r_squared = re_over_r * re_over_r;
    
    double factor = -1.5 * J2 * EARTH_MU * re_over_r_squared / r2;
    
    Vec3 j2_term;
    double term1 = 1.0 - 5.0 * z_over_r_squared;
    double term2 = 3.0 - 5.0 * z_over_r_squared;
    
    j2_term.x = factor * term1 * position.x / r;
    j2_term.y = factor * term1 * position.y / r;
    j2_term.z = factor * (term1 * position.z / r + 2.0 * term2 * position.z / r);
    
    Vec3 total_acceleration;
    total_acceleration.x = acc_two_body.x + j2_term.x;
    total_acceleration.y = acc_two_body.y + j2_term.y;
    total_acceleration.z = acc_two_body.z + j2_term.z;
    
    return total_acceleration;
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
