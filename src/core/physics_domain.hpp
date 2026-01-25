#ifndef PHYSICS_DOMAIN_HPP
#define PHYSICS_DOMAIN_HPP

namespace sim {

/**
 * @brief Physics domains for modular simulation
 * 
 * Different physics models are activated based on flight regime
 * Transitions occur based on altitude and velocity thresholds
 */
enum class PhysicsDomain {
    GROUND,      // Taxi, runway operations
    AERO,        // Atmospheric flight with aerodynamic forces
    ROCKET,      // Multi-stage rocket propulsion
    ORBITAL      // Orbital mechanics (multi-body, perturbations)
};

/**
 * @brief Domain transition thresholds
 * 
 * Default values based on typical atmospheric boundaries
 * Can be overridden for specific scenarios
 */
struct DomainThresholds {
    // Altitude thresholds [m]
    double ground_to_aero_alt = 10.0;          // Take-off/landing threshold
    double aero_to_orbital_alt = 50000.0;      // ~50km, negligible atmosphere
    
    // Velocity thresholds [m/s]
    double ground_max_velocity = 100.0;        // Taxi speed limit
    double aero_max_velocity = 8000.0;         // Hypersonic boundary
    
    // Current domain determination
    PhysicsDomain determine_domain(double altitude, double velocity) const;
};

} // namespace sim

#endif // PHYSICS_DOMAIN_HPP
