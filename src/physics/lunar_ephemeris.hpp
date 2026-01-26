/**
 * Lunar Ephemeris
 *
 * Simplified Moon position calculator using circular orbit approximation.
 * For higher fidelity, this could be extended to use JPL ephemerides.
 */

#ifndef SIM_LUNAR_EPHEMERIS_HPP
#define SIM_LUNAR_EPHEMERIS_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"

namespace sim {

/**
 * Lunar ephemeris calculator
 *
 * Uses a simplified circular orbit model for the Moon around Earth.
 * The Moon's orbit is inclined ~5.145° to the ecliptic, but for simplicity
 * we model it in the Earth's equatorial plane initially.
 */
class LunarEphemeris {
public:
    /**
     * Get Moon position in Earth-Centered Inertial (ECI) frame
     * @param jd Julian Date
     * @return Moon position vector in ECI (meters)
     */
    static Vec3 get_moon_position_eci(double jd);

    /**
     * Get Moon velocity in ECI frame
     * @param jd Julian Date
     * @return Moon velocity vector in ECI (m/s)
     */
    static Vec3 get_moon_velocity_eci(double jd);

    /**
     * Get Moon state (position and velocity) in ECI frame
     * @param jd Julian Date
     * @return StateVector with Moon's position and velocity
     */
    static StateVector get_moon_state_eci(double jd);

    /**
     * Get Moon's mean anomaly at given Julian Date
     * @param jd Julian Date
     * @return Mean anomaly in radians
     */
    static double get_moon_mean_anomaly(double jd);

    /**
     * Get Moon's orbital angular velocity
     * @return Angular velocity in rad/s
     */
    static constexpr double get_moon_mean_motion() {
        return MOON_MEAN_MOTION;
    }

    // Reference epoch: J2000.0 (2000-01-01 12:00:00 TT)
    static constexpr double J2000_EPOCH = 2451545.0;

    // Moon's mean longitude at J2000 epoch (radians)
    // Approximate value - for higher accuracy use full lunar theory
    static constexpr double MOON_L0_J2000 = 3.8104;  // ~218.32° in radians

    // Inclination of Moon's orbit to equator (radians)
    // Simplified: using mean inclination to ecliptic + Earth's obliquity
    static constexpr double MOON_INCLINATION = 0.0898;  // ~5.145° simplified

private:
    static constexpr double PI = 3.14159265358979323846;
    static constexpr double TWO_PI = 2.0 * PI;
    static constexpr double DEG_TO_RAD = PI / 180.0;
};

}  // namespace sim

#endif  // SIM_LUNAR_EPHEMERIS_HPP
