/**
 * Planetary Ephemeris Implementation
 *
 * Computes heliocentric positions using Standish (1992) mean orbital elements
 * with linear secular rates. Algorithm:
 *   1. Compute Julian centuries T since J2000
 *   2. Evaluate mean elements: a, e, i, L, ω̃, Ω at epoch T
 *   3. Derive argument of perihelion ω = ω̃ - Ω, mean anomaly M = L - ω̃
 *   4. Solve Kepler's equation for eccentric anomaly E
 *   5. Compute true anomaly ν and heliocentric distance r
 *   6. Transform (r, ν) through orbital plane rotations to ecliptic XYZ
 *   7. Rotate ecliptic → J2000 equatorial via obliquity
 *
 * Reference: Meeus, "Astronomical Algorithms" 2nd ed., Chapter 31
 *            Standish, "Orbital Ephemerides of the Sun, Moon, and Planets"
 */

#include "planetary_ephemeris.hpp"
#include <cmath>
#include <stdexcept>

namespace sim {

// ─────────────────────────────────────────────────────────────
// Standish (1992) mean orbital elements at J2000.0
// Source: JPL / Meeus Table 31.A
//
// Elements referenced to J2000 ecliptic and equinox.
// a in AU, e dimensionless, angles in degrees.
// Rates per Julian century (36525 days).
// ─────────────────────────────────────────────────────────────

static const PlanetaryEphemeris::OrbitalElementSet ELEMENTS[] = {
    // Mercury
    {
        0.38709927,   0.00000037,    // a, da
        0.20563593,   0.00001906,    // e, de
        7.00497902,  -0.00594749,    // i, di  (deg)
        252.25032350, 149472.67411175, // L, dL  (deg)
        77.45779628,  0.16047689,    // ω̃, dω̃ (deg)
        48.33076593, -0.12534081     // Ω, dΩ  (deg)
    },
    // Venus
    {
        0.72333566,   0.00000390,
        0.00677672,  -0.00004107,
        3.39467605,  -0.00078890,
        181.97909950, 58517.81538729,
        131.60246718, 0.00268329,
        76.67984255, -0.27769418
    },
    // Earth (Earth-Moon barycenter)
    {
        1.00000261,   0.00000562,
        0.01671123,  -0.00004392,
       -0.00001531,  -0.01294668,
        100.46457166, 35999.37244981,
        102.93768193, 0.32327364,
        0.0,          0.0
    },
    // Mars
    {
        1.52371034,   0.00001847,
        0.09339410,   0.00007882,
        1.84969142,  -0.00813131,
       -4.55343205,   19140.30268499,
       -23.94362959,  0.44441088,
        49.55953891, -0.29257343
    },
    // Jupiter
    {
        5.20288700,  -0.00011607,
        0.04838624,  -0.00013253,
        1.30439695,  -0.00183714,
        34.39644051,  3034.74612775,
        14.72847983,  0.21252668,
        100.47390909, 0.20469106
    },
    // Saturn
    {
        9.53667594,  -0.00125060,
        0.05386179,  -0.00050991,
        2.48599187,   0.00193609,
        49.95424423,  1222.49362201,
        92.59887831, -0.41897216,
        113.66242448,-0.28867794
    },
    // Uranus
    {
        19.18916464, -0.00196176,
        0.04725744,  -0.00004397,
        0.77263783,  -0.00242939,
        313.23810451, 428.48202785,
        170.95427630, 0.40805281,
        74.01692503,  0.04240589
    },
    // Neptune
    {
        30.06992276,  0.00026291,
        0.00859048,   0.00005105,
        1.77004347,   0.00035372,
       -55.12002969,  218.45945325,
        44.96476227, -0.32241464,
        131.78422574,-0.00508664
    },
    // Pluto
    {
        39.48211675, -0.00031596,
        0.24882730,   0.00005170,
        17.14001206,  0.00004818,
        238.92903833, 145.20780515,
        224.06891629,-0.04062942,
        110.30393684,-0.01183482
    }
};

const PlanetaryEphemeris::OrbitalElementSet& PlanetaryEphemeris::get_elements(Planet planet) {
    return ELEMENTS[static_cast<int>(planet)];
}

// ─────────────────────────────────────────────────────────────
// PlanetaryConstants
// ─────────────────────────────────────────────────────────────

static const PlanetaryConstants PLANET_DATA[] = {
    {"Mercury", MERCURY_MU, MERCURY_RADIUS, 1.124e8,  6.0e-5,   0.387, 7.600e6},
    {"Venus",   VENUS_MU,   VENUS_RADIUS,   6.162e8,  4.458e-6, 0.723, 1.941e7},
    {"Earth",   EARTH_MU,   EARTH_RADIUS,   EARTH_SOI,EARTH_J2, 1.000, 3.156e7},
    {"Mars",    MARS_MU,    MARS_RADIUS,    MARS_SOI, MARS_J2,  1.524, 5.935e7},
    {"Jupiter", JUPITER_MU, JUPITER_RADIUS, JUPITER_SOI, JUPITER_J2, 5.203, 3.743e8},
    {"Saturn",  SATURN_MU,  SATURN_RADIUS,  SATURN_SOI,  SATURN_J2,  9.537, 9.296e8},
    {"Uranus",  URANUS_MU,  URANUS_RADIUS,  URANUS_SOI,  URANUS_J2,  19.19, 2.651e9},
    {"Neptune", NEPTUNE_MU, NEPTUNE_RADIUS, NEPTUNE_SOI, NEPTUNE_J2, 30.07, 5.200e9},
    {"Pluto",   PLUTO_MU,   PLUTO_RADIUS,   PLUTO_SOI,   0.0,       39.48, 7.824e9}
};

const PlanetaryConstants& PlanetaryConstants::get(Planet planet) {
    return PLANET_DATA[static_cast<int>(planet)];
}

CelestialBody make_planet(Planet planet) {
    const auto& pc = PlanetaryConstants::get(planet);
    return CelestialBody{pc.name, pc.mu, pc.radius, pc.soi_radius, pc.j2};
}

// ─────────────────────────────────────────────────────────────
// Kepler solver
// ─────────────────────────────────────────────────────────────

double PlanetaryEphemeris::solve_kepler(double M, double e, double tol) {
    // Normalize M to [0, 2π)
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) M += TWO_PI;

    // Initial guess
    double E = (e < 0.8) ? M : PI;

    // Newton-Raphson iteration
    for (int iter = 0; iter < 50; ++iter) {
        double dE = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
        E -= dE;
        if (std::fabs(dE) < tol) break;
    }
    return E;
}

// ─────────────────────────────────────────────────────────────
// Ecliptic position from orbital elements
// ─────────────────────────────────────────────────────────────

void PlanetaryEphemeris::compute_ecliptic(Planet planet, double jd,
                                           double& x_ecl, double& y_ecl, double& z_ecl) {
    // Julian centuries since J2000
    double T = (jd - J2000_EPOCH) / 36525.0;

    const auto& el = get_elements(planet);

    // Evaluate elements at epoch T
    double a    = el.a0 + el.da * T;                    // AU
    double e    = el.e0 + el.de * T;
    double i    = (el.i0 + el.di * T) * DEG_TO_RAD;     // rad
    double L    = (el.L0 + el.dL * T) * DEG_TO_RAD;     // rad
    double w_bar= (el.long_peri0 + el.dlong_peri * T) * DEG_TO_RAD; // rad
    double Omega= (el.long_node0 + el.dlong_node * T) * DEG_TO_RAD; // rad

    // Argument of perihelion
    double omega = w_bar - Omega;

    // Mean anomaly
    double M = L - w_bar;

    // Solve Kepler's equation
    double E = solve_kepler(M, e);

    // True anomaly
    double sin_nu = std::sqrt(1.0 - e * e) * std::sin(E) / (1.0 - e * std::cos(E));
    double cos_nu = (std::cos(E) - e) / (1.0 - e * std::cos(E));
    double nu = std::atan2(sin_nu, cos_nu);

    // Heliocentric distance [m]
    double r = a * (1.0 - e * std::cos(E)) * AU;

    // Argument of latitude
    double u = omega + nu;

    // Ecliptic coordinates (heliocentric)
    double cos_u = std::cos(u);
    double sin_u = std::sin(u);
    double cos_O = std::cos(Omega);
    double sin_O = std::sin(Omega);
    double cos_i = std::cos(i);
    double sin_i = std::sin(i);

    x_ecl = r * (cos_O * cos_u - sin_O * sin_u * cos_i);
    y_ecl = r * (sin_O * cos_u + cos_O * sin_u * cos_i);
    z_ecl = r * (sin_u * sin_i);
}

// ─────────────────────────────────────────────────────────────
// Ecliptic → J2000 Equatorial rotation
// ─────────────────────────────────────────────────────────────

Vec3 PlanetaryEphemeris::ecliptic_to_equatorial(double x_ecl, double y_ecl, double z_ecl) {
    // Obliquity of the ecliptic at J2000
    constexpr double eps = OBLIQUITY_J2000;
    double cos_eps = std::cos(eps);
    double sin_eps = std::sin(eps);

    return Vec3{
        x_ecl,
        y_ecl * cos_eps - z_ecl * sin_eps,
        y_ecl * sin_eps + z_ecl * cos_eps
    };
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

Vec3 PlanetaryEphemeris::get_position_hci(Planet planet, double jd) {
    double x_ecl, y_ecl, z_ecl;
    compute_ecliptic(planet, jd, x_ecl, y_ecl, z_ecl);
    return ecliptic_to_equatorial(x_ecl, y_ecl, z_ecl);
}

Vec3 PlanetaryEphemeris::get_velocity_hci(Planet planet, double jd) {
    // Central difference with 10-second step
    constexpr double h = 10.0;
    double h_jd = h / 86400.0;

    Vec3 pos_plus  = get_position_hci(planet, jd + h_jd);
    Vec3 pos_minus = get_position_hci(planet, jd - h_jd);

    return Vec3{
        (pos_plus.x - pos_minus.x) / (2.0 * h),
        (pos_plus.y - pos_minus.y) / (2.0 * h),
        (pos_plus.z - pos_minus.z) / (2.0 * h)
    };
}

StateVector PlanetaryEphemeris::get_state_hci(Planet planet, double jd) {
    StateVector state;
    state.position = get_position_hci(planet, jd);
    state.velocity = get_velocity_hci(planet, jd);
    state.frame = CoordinateFrame::J2000_ECI;  // Will be HELIOCENTRIC_J2000 once enum extended
    state.time = (jd - J2000_EPOCH) * 86400.0;
    return state;
}

Vec3 PlanetaryEphemeris::get_position_eci(Planet planet, double jd) {
    // Planet position relative to Earth = planet_hci - earth_hci
    Vec3 planet_hci = get_position_hci(planet, jd);
    Vec3 earth_hci  = get_position_hci(Planet::EARTH, jd);
    return Vec3{
        planet_hci.x - earth_hci.x,
        planet_hci.y - earth_hci.y,
        planet_hci.z - earth_hci.z
    };
}

}  // namespace sim
