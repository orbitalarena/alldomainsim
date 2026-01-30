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
constexpr double EARTH_J3 = -2.53265648e-6;       // EGM96 pear-shaped asymmetry
constexpr double EARTH_J4 = -1.61098761e-6;       // EGM96 higher-order oblateness
constexpr double EARTH_SOI = 929000e3;            // m (from Sun, ~929,000 km)
constexpr double EARTH_OMEGA = 7.2921159e-5;      // rad/s (rotation rate)

// Moon parameters
constexpr double MOON_MU = 4.9048695e12;          // m³/s²
constexpr double MOON_RADIUS = 1737400.0;         // m
constexpr double MOON_J2 = 2.027e-4;              // Much smaller than Earth
constexpr double MOON_SOI = 66100e3;              // m (~66,100 km from Moon center)

// Earth-Moon system
constexpr double EARTH_MOON_DISTANCE = 384400e3;  // m (mean distance)
constexpr double MOON_ORBITAL_PERIOD = 27.321661 * 86400.0;  // seconds (sidereal)
constexpr double MOON_MEAN_MOTION = 2.0 * 3.14159265358979323846 / MOON_ORBITAL_PERIOD;

// Sun parameters
constexpr double SUN_MU = 1.32712440018e20;       // m³/s²
constexpr double SUN_RADIUS = 696340000.0;        // m (mean radius)
constexpr double AU = 1.495978707e11;             // Astronomical unit (m)
constexpr double OBLIQUITY_J2000 = 0.4090928;     // rad (23.4393° obliquity of ecliptic)

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

inline CelestialBody make_sun() {
    return CelestialBody{
        "Sun",
        SUN_MU,
        SUN_RADIUS,
        0.0,    // SOI not meaningful for Sun as primary in Earth-centric sim
        0.0     // J2 not modeled
    };
}

// Physical constants
constexpr double G0 = 9.80665;                    // Standard gravity (m/s²)
constexpr double KARMAN_LINE = 100000.0;          // Edge of space (m)

}  // namespace sim

#endif  // SIM_CELESTIAL_BODY_HPP
