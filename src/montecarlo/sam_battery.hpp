#ifndef SIM_MC_SAM_BATTERY_HPP
#define SIM_MC_SAM_BATTERY_HPP

#include "mc_world.hpp"

namespace sim::mc {

class SAMBattery {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt, MCWorld& world);
};

} // namespace sim::mc
#endif
