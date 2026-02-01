#ifndef SIM_MC_RADAR_SENSOR_HPP
#define SIM_MC_RADAR_SENSOR_HPP

#include "mc_world.hpp"

namespace sim::mc {

class RadarSensor {
public:
    static void update_all(double dt, MCWorld& world);
private:
    static void update_entity(MCEntity& e, double dt, MCWorld& world);
};

} // namespace sim::mc
#endif
