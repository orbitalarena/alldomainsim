/**
 * InterceptAI — Chase and engage a designated target entity.
 *
 * Pursuit steering toward a target entity identified by intercept_target_id.
 * Sets intercept_state = 1 (engaged) when within intercept_engage_range,
 * signaling the weapon system to fire.
 *
 * Supports pursuit (mode 0), lead pursuit (mode 1), and stern conversion
 * (mode 2) — currently all aliases for pure pursuit.
 *
 * Processes all entities with ai_type == INTERCEPT.
 */

#ifndef SIM_MC_INTERCEPT_AI_HPP
#define SIM_MC_INTERCEPT_AI_HPP

#include "mc_world.hpp"

namespace sim::mc {

class InterceptAI {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt, MCWorld& world);
};

} // namespace sim::mc
#endif // SIM_MC_INTERCEPT_AI_HPP
