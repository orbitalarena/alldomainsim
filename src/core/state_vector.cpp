#include "core/state_vector.hpp"
#include <cmath>

namespace sim {

double StateVector::altitude_msl() const {
    // Simple spherical Earth approximation for now
    // WGS84 Earth equatorial radius [m]
    const double EARTH_RADIUS = 6378137.0;
    
    double radius = position.norm();
    return radius - EARTH_RADIUS;
}

} // namespace sim
