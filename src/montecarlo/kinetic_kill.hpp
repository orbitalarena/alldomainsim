/**
 * KineticKill — Proximity-triggered mutual destruction weapon.
 *
 * Direct port of js/components/weapons/kinetic_kill.js.
 * Uses world.rng for deterministic Pk rolls in MC mode.
 */

#ifndef SIM_MC_KINETIC_KILL_HPP
#define SIM_MC_KINETIC_KILL_HPP

#include "mc_world.hpp"

namespace sim::mc {

class KineticKill {
public:
    static void update_all(double dt, MCWorld& world);

private:
    static void update_entity(MCEntity& entity, double dt, MCWorld& world);
};

} // namespace sim::mc

#endif // SIM_MC_KINETIC_KILL_HPP
