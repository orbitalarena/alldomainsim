/**
 * Solar Ephemeris
 *
 * Low-precision analytical Sun position in ECI using the Meeus algorithm.
 * Accuracy ~0.01 degrees, sufficient for third-body perturbation and SRP.
 * Follows the same interface pattern as LunarEphemeris.
 */

#ifndef SIM_SOLAR_EPHEMERIS_HPP
#define SIM_SOLAR_EPHEMERIS_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"

namespace sim {

class SolarEphemeris {
public:
    /**
     * Get Sun position in Earth-Centered Inertial (ECI) frame
     * @param jd Julian Date
     * @return Sun position vector in ECI (meters)
     */
    static Vec3 get_sun_position_eci(double jd);

    /**
     * Get Sun velocity in ECI frame (numerical derivative)
     * @param jd Julian Date
     * @return Sun velocity vector in ECI (m/s)
     */
    static Vec3 get_sun_velocity_eci(double jd);

    /**
     * Get Sun state (position and velocity) in ECI frame
     * @param jd Julian Date
     * @return StateVector with Sun's position and velocity
     */
    static StateVector get_sun_state_eci(double jd);

    /**
     * Get Earth's mean anomaly in its orbit around the Sun
     * @param jd Julian Date
     * @return Mean anomaly in radians [0, 2pi)
     */
    static double get_earth_mean_anomaly(double jd);

    // Reference epoch: J2000.0
    static constexpr double J2000_EPOCH = 2451545.0;

private:
    static constexpr double PI = 3.14159265358979323846;
    static constexpr double TWO_PI = 2.0 * PI;
    static constexpr double DEG_TO_RAD = PI / 180.0;
};

}  // namespace sim

#endif  // SIM_SOLAR_EPHEMERIS_HPP
