/**
 * Flight3DOF — 3-DOF atmospheric flight propagator.
 *
 * Point-mass flight dynamics: speed, flight path angle, heading.
 * Uses US Standard Atmosphere for density/pressure, geodetic position
 * update via great-circle navigation.
 *
 * Processes all entities with physics_type == FLIGHT_3DOF.
 */

#ifndef SIM_MC_FLIGHT3DOF_HPP
#define SIM_MC_FLIGHT3DOF_HPP

#include "mc_world.hpp"

namespace sim::mc {

class Flight3DOF {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt);
};

} // namespace sim::mc
#endif // SIM_MC_FLIGHT3DOF_HPP
