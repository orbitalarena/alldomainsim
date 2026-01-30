/**
 * Planetary Ephemeris
 *
 * Analytical positions of Mercury through Pluto in Heliocentric J2000
 * Equatorial coordinates. Uses Standish (1992) mean orbital elements
 * with linear rates — the same approach as Meeus "Astronomical Algorithms"
 * Chapter 31. Accuracy ~1 arcminute over several centuries around J2000.
 *
 * No external data files — all coefficients are hardcoded.
 */

#ifndef SIM_PLANETARY_EPHEMERIS_HPP
#define SIM_PLANETARY_EPHEMERIS_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"
#include <string>

namespace sim {

// ─────────────────────────────────────────────────────────────
// Planet identifiers
// ─────────────────────────────────────────────────────────────

enum class Planet {
    MERCURY, VENUS, EARTH, MARS,
    JUPITER, SATURN, URANUS, NEPTUNE,
    PLUTO
};

inline const char* planet_to_string(Planet p) {
    switch (p) {
        case Planet::MERCURY: return "Mercury";
        case Planet::VENUS:   return "Venus";
        case Planet::EARTH:   return "Earth";
        case Planet::MARS:    return "Mars";
        case Planet::JUPITER: return "Jupiter";
        case Planet::SATURN:  return "Saturn";
        case Planet::URANUS:  return "Uranus";
        case Planet::NEPTUNE: return "Neptune";
        case Planet::PLUTO:   return "Pluto";
        default:              return "Unknown";
    }
}

constexpr int PLANET_COUNT = 9;

// ─────────────────────────────────────────────────────────────
// Physical constants for each planet
// ─────────────────────────────────────────────────────────────

struct PlanetaryConstants {
    std::string name;
    double mu;              // GM [m³/s²]
    double radius;          // Mean equatorial radius [m]
    double soi_radius;      // Sphere of influence from Sun [m]
    double j2;              // J2 oblateness coefficient
    double sma_au;          // Semi-major axis [AU]
    double orbital_period;  // Sidereal period [s]

    static const PlanetaryConstants& get(Planet planet);
};

// Convenience constants for frequently-used planets
constexpr double MERCURY_MU     = 2.2032e13;
constexpr double MERCURY_RADIUS = 2439700.0;

constexpr double VENUS_MU       = 3.24859e14;
constexpr double VENUS_RADIUS   = 6051800.0;

constexpr double MARS_MU        = 4.282837e13;
constexpr double MARS_RADIUS    = 3396200.0;
constexpr double MARS_J2        = 1.96045e-3;
constexpr double MARS_SOI       = 5.774e8;

constexpr double JUPITER_MU     = 1.26686534e17;
constexpr double JUPITER_RADIUS = 71492000.0;
constexpr double JUPITER_J2     = 1.4736e-2;
constexpr double JUPITER_SOI    = 4.82e10;

constexpr double SATURN_MU      = 3.7931187e16;
constexpr double SATURN_RADIUS  = 60268000.0;
constexpr double SATURN_J2      = 1.6298e-2;
constexpr double SATURN_SOI     = 5.468e10;

constexpr double URANUS_MU      = 5.793939e15;
constexpr double URANUS_RADIUS  = 25559000.0;
constexpr double URANUS_J2      = 3.343e-3;
constexpr double URANUS_SOI     = 5.178e10;

constexpr double NEPTUNE_MU     = 6.836529e15;
constexpr double NEPTUNE_RADIUS = 24764000.0;
constexpr double NEPTUNE_J2     = 3.411e-3;
constexpr double NEPTUNE_SOI    = 8.678e10;

constexpr double PLUTO_MU       = 8.71e11;
constexpr double PLUTO_RADIUS   = 1188300.0;
constexpr double PLUTO_SOI      = 3.13e9;

// ─────────────────────────────────────────────────────────────
// Factory functions for CelestialBody (extend existing pattern)
// ─────────────────────────────────────────────────────────────

inline CelestialBody make_mercury() {
    return CelestialBody{"Mercury", MERCURY_MU, MERCURY_RADIUS, 1.124e8, 6.0e-5};
}
inline CelestialBody make_venus() {
    return CelestialBody{"Venus", VENUS_MU, VENUS_RADIUS, 6.162e8, 4.458e-6};
}
inline CelestialBody make_mars() {
    return CelestialBody{"Mars", MARS_MU, MARS_RADIUS, MARS_SOI, MARS_J2};
}
inline CelestialBody make_jupiter() {
    return CelestialBody{"Jupiter", JUPITER_MU, JUPITER_RADIUS, JUPITER_SOI, JUPITER_J2};
}
inline CelestialBody make_saturn() {
    return CelestialBody{"Saturn", SATURN_MU, SATURN_RADIUS, SATURN_SOI, SATURN_J2};
}
inline CelestialBody make_uranus() {
    return CelestialBody{"Uranus", URANUS_MU, URANUS_RADIUS, URANUS_SOI, URANUS_J2};
}
inline CelestialBody make_neptune() {
    return CelestialBody{"Neptune", NEPTUNE_MU, NEPTUNE_RADIUS, NEPTUNE_SOI, NEPTUNE_J2};
}
inline CelestialBody make_pluto() {
    return CelestialBody{"Pluto", PLUTO_MU, PLUTO_RADIUS, PLUTO_SOI, 0.0};
}

// Get CelestialBody for any planet
CelestialBody make_planet(Planet planet);

// ─────────────────────────────────────────────────────────────
// Ephemeris calculator
// ─────────────────────────────────────────────────────────────

class PlanetaryEphemeris {
public:
    /**
     * Get planet position in Heliocentric J2000 Equatorial frame
     * @param planet Planet identifier
     * @param jd Julian Date
     * @return Position vector [m] in HCI
     */
    static Vec3 get_position_hci(Planet planet, double jd);

    /**
     * Get planet velocity in HCI frame (numerical derivative)
     * @param planet Planet identifier
     * @param jd Julian Date
     * @return Velocity vector [m/s] in HCI
     */
    static Vec3 get_velocity_hci(Planet planet, double jd);

    /**
     * Get full state (position + velocity) in HCI frame
     */
    static StateVector get_state_hci(Planet planet, double jd);

    /**
     * Get planet position in Earth-Centered Inertial frame
     * Convenience: planet_hci - earth_hci
     */
    static Vec3 get_position_eci(Planet planet, double jd);

    // J2000 epoch
    static constexpr double J2000_EPOCH = 2451545.0;

    // ── Standish (1992) mean orbital elements ──
    // (public so the .cpp static array can use this type)

    // Elements at J2000 epoch and their rates per Julian century.
    // Order: [a(AU), e, i(deg), L(deg), long_peri(deg), long_node(deg)]
    // Rates: [da, de, di, dL, dlong_peri, dlong_node] per century

    struct OrbitalElementSet {
        double a0, da;              // Semi-major axis [AU] and rate [AU/cy]
        double e0, de;              // Eccentricity and rate [/cy]
        double i0, di;              // Inclination [deg] and rate [deg/cy]
        double L0, dL;              // Mean longitude [deg] and rate [deg/cy]
        double long_peri0, dlong_peri; // Longitude of perihelion [deg] and rate
        double long_node0, dlong_node; // Longitude of ascending node [deg] and rate
    };

private:
    static constexpr double PI = 3.14159265358979323846;
    static constexpr double TWO_PI = 2.0 * PI;
    static constexpr double DEG_TO_RAD = PI / 180.0;

    static const OrbitalElementSet& get_elements(Planet planet);

    /**
     * Compute heliocentric ecliptic position from orbital elements
     * @param planet Planet
     * @param jd Julian Date
     * @param lon Output: ecliptic longitude [rad]
     * @param lat Output: ecliptic latitude [rad]
     * @param r Output: heliocentric distance [m]
     */
    static void compute_ecliptic(Planet planet, double jd,
                                  double& x_ecl, double& y_ecl, double& z_ecl);

    /**
     * Rotate ecliptic coordinates to J2000 equatorial
     */
    static Vec3 ecliptic_to_equatorial(double x_ecl, double y_ecl, double z_ecl);

    /**
     * Solve Kepler's equation M = E - e*sin(E)
     */
    static double solve_kepler(double M, double e, double tol = 1e-12);
};

}  // namespace sim

#endif  // SIM_PLANETARY_EPHEMERIS_HPP
