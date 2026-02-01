#ifndef SIM_MC_EVENT_SYSTEM_HPP
#define SIM_MC_EVENT_SYSTEM_HPP

#include "mc_world.hpp"

namespace sim::mc {

class EventSystem {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static bool check_trigger(const EventTrigger& trigger, MCWorld& world);
    static void execute_action(const EventAction& action, MCWorld& world);
};

} // namespace sim::mc
#endif
