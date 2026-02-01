/**
 * OrbitalCombatAI — Role-based AI for GEO space arena orbital combat.
 *
 * Direct port of js/components/ai/orbital_combat.js.
 * Static class with update_all() that processes all AI entities per tick.
 *
 * Roles: HVA (passive), Defender, Attacker, Escort, Sweep.
 * All operate in ECI coordinates, modifying eci_vel in-place.
 */

#ifndef SIM_MC_ORBITAL_COMBAT_AI_HPP
#define SIM_MC_ORBITAL_COMBAT_AI_HPP

#include "mc_world.hpp"
#include <vector>
#include <string>

namespace sim::mc {

struct TargetInfo {
    std::string entity_id;
    double distance;
    CombatRole role;
};

class OrbitalCombatAI {
public:
    static void update_all(double dt, MCWorld& world);

private:
    static void update_entity(MCEntity& entity, double dt, MCWorld& world);

    static void scan_for_targets(MCEntity& entity, MCWorld& world,
                                 std::vector<TargetInfo>& targets);

    static void select_target_defender(MCEntity& entity, MCWorld& world,
                                       const std::vector<TargetInfo>& targets);
    static void select_target_attacker(MCEntity& entity,
                                        const std::vector<TargetInfo>& targets);
    static void select_target_escort(MCEntity& entity, double dt, MCWorld& world,
                                      const std::vector<TargetInfo>& targets);
    static void select_target_sweep(MCEntity& entity,
                                     const std::vector<TargetInfo>& targets);

    static void drift_toward_friendly_attacker(MCEntity& entity, double dt,
                                                MCWorld& world);

    static void apply_thrust(MCEntity& entity, double dt, const Vec3& target_pos);
    static void apply_thrust_scaled(MCEntity& entity, double dt,
                                     const Vec3& target_pos, double scale);
};

} // namespace sim::mc

#endif // SIM_MC_ORBITAL_COMBAT_AI_HPP
