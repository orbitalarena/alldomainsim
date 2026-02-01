/**
 * WaypointPatrolAI — Fly a sequence of waypoints with optional looping.
 *
 * Controls flight_roll, flight_alpha, and flight_throttle to steer
 * toward each waypoint in sequence. Advances on arrival within 2 km.
 *
 * Processes all entities with ai_type == WAYPOINT_PATROL.
 */

#ifndef SIM_MC_WAYPOINT_PATROL_AI_HPP
#define SIM_MC_WAYPOINT_PATROL_AI_HPP

#include "mc_world.hpp"

namespace sim::mc {

class WaypointPatrolAI {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt);
};

} // namespace sim::mc
#endif // SIM_MC_WAYPOINT_PATROL_AI_HPP
