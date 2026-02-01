#ifndef SIM_MC_A2A_MISSILE_HPP
#define SIM_MC_A2A_MISSILE_HPP

#include "mc_world.hpp"

namespace sim::mc {

class A2AMissile {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt, MCWorld& world);
    static const WeaponSpec& select_weapon(MCEntity& e, double range);
};

} // namespace sim::mc
#endif
