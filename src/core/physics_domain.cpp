#include "core/physics_domain.hpp"

namespace sim {

PhysicsDomain DomainThresholds::determine_domain(double altitude, double velocity) const {
    // Priority: altitude is primary discriminator
    
    if (altitude < ground_to_aero_alt && velocity < ground_max_velocity) {
        return PhysicsDomain::GROUND;
    }
    
    if (altitude >= aero_to_orbital_alt) {
        return PhysicsDomain::ORBITAL;
    }
    
    // Between ground and orbital altitudes
    if (velocity > aero_max_velocity) {
        // High velocity in atmosphere = rocket
        return PhysicsDomain::ROCKET;
    }
    
    // Default atmospheric flight
    return PhysicsDomain::AERO;
}

} // namespace sim
