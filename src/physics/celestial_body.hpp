/**
 * Celestial Body Definitions
 *
 * Physical constants for celestial bodies used in multi-body simulations.
 */

#ifndef SIM_CELESTIAL_BODY_HPP
#define SIM_CELESTIAL_BODY_HPP

#include <string>

namespace sim {

/**
 * Celestial body physical parameters
 */
struct CelestialBody {
    std::string name;
    double mu;           // Gravitational parameter GM (m³/s²)
    double radius;       // Mean equatorial radius (m)
    double soi_radius;   // Sphere of influence radius (m)
    double j2;           // J2 oblateness coefficient (0 if not modeled)
};

// Earth - WGS84 parameters
constexpr double EARTH_MU = 3.986004418e14;      // m³/s²
constexpr double EARTH_RADIUS = 6378137.0;        // m (equatorial)
constexpr double EARTH_J2 = 1.08262668e-3;
constexpr double EARTH_SOI = 929000e3;            // m (from Sun, ~929,000 km)

// Moon parameters
constexpr double MOON_MU = 4.9048695e12;          // m³/s²
constexpr double MOON_RADIUS = 1737400.0;         // m
constexpr double MOON_J2 = 2.027e-4;              // Much smaller than Earth
constexpr double MOON_SOI = 66100e3;              // m (~66,100 km from Moon center)

// Earth-Moon system
constexpr double EARTH_MOON_DISTANCE = 384400e3;  // m (mean distance)
constexpr double MOON_ORBITAL_PERIOD = 27.321661 * 86400.0;  // seconds (sidereal)
constexpr double MOON_MEAN_MOTION = 2.0 * 3.14159265358979323846 / MOON_ORBITAL_PERIOD;

// Sun parameters (for future solar perturbations)
constexpr double SUN_MU = 1.32712440018e20;       // m³/s²
constexpr double AU = 1.495978707e11;             // Astronomical unit (m)

// Predefined body instances
inline CelestialBody make_earth() {
    return CelestialBody{
        "Earth",
        EARTH_MU,
        EARTH_RADIUS,
        EARTH_SOI,
        EARTH_J2
    };
}

inline CelestialBody make_moon() {
    return CelestialBody{
        "Moon",
        MOON_MU,
        MOON_RADIUS,
        MOON_SOI,
        MOON_J2
    };
}

// Physical constants
constexpr double G0 = 9.80665;                    // Standard gravity (m/s²)
constexpr double KARMAN_LINE = 100000.0;          // Edge of space (m)

}  // namespace sim

#endif  // SIM_CELESTIAL_BODY_HPP
