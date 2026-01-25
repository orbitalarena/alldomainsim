#ifndef GRAVITY_MODEL_HPP
#define GRAVITY_MODEL_HPP

#include "core/state_vector.hpp"

namespace sim {

/**
 * @brief Earth gravity model with perturbations
 * 
 * Computes gravitational acceleration including:
 * - Two-body point mass
 * - J2 oblateness perturbation (optional)
 * - Higher order harmonics (future)
 */
class GravityModel {
public:
    // WGS84 Earth parameters
    static constexpr double EARTH_MU = 398600.4418e9;      // [m^3/s^2]
    static constexpr double EARTH_RADIUS = 6378137.0;      // [m]
    static constexpr double J2 = 1.08262668e-3;            // J2 coefficient (oblateness)
    
    /**
     * @brief Compute gravitational acceleration (two-body only)
     * 
     * @param position Position vector in ECI [m]
     * @return Acceleration vector [m/s^2]
     */
    static Vec3 compute_two_body(const Vec3& position);
    
    /**
     * @brief Compute gravitational acceleration with J2 perturbation
     * 
     * Accounts for Earth's oblateness (equatorial bulge)
     * 
     * @param position Position vector in ECI [m]
     * @return Acceleration vector [m/s^2]
     */
    static Vec3 compute_with_j2(const Vec3& position);
    
    /**
     * @brief Compute state derivatives for orbital propagation
     * 
     * Returns [velocity, acceleration] for use with integrators
     * 
     * @param state Current state (position, velocity)
     * @param use_j2 Whether to include J2 perturbations
     * @return State derivative (velocity, acceleration)
     */
    static StateVector compute_derivatives(const StateVector& state, bool use_j2 = true);
};

} // namespace sim

#endif // GRAVITY_MODEL_HPP
