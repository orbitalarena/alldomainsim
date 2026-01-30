/**
 * Asteroid Body Definitions
 *
 * Represents minor bodies with fixed Keplerian elements.
 * Positions propagated using Kepler's equation from osculating elements.
 * Header-only — no external data files.
 */

#ifndef SIM_ASTEROID_BODY_HPP
#define SIM_ASTEROID_BODY_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"
#include <string>
#include <cmath>

namespace sim {

struct AsteroidElements {
    std::string name;
    double epoch_jd;        // Epoch of osculating elements
    double sma;             // Semi-major axis [m]
    double ecc;             // Eccentricity
    double inc;             // Inclination [rad] (ecliptic)
    double raan;            // Longitude of ascending node [rad] (ecliptic)
    double arg_pe;          // Argument of perihelion [rad]
    double mean_anomaly;    // Mean anomaly at epoch [rad]
    double mu;              // GM [m³/s²] (negligible for trajectory design, nonzero for SOI)
    double radius;          // Mean radius [m]
};

// ─────────────────────────────────────────────────────────────
// Predefined asteroid catalog
// Elements from JPL Small-Body Database, epoch J2000 (approx.)
// ─────────────────────────────────────────────────────────────

namespace asteroids {

static constexpr double PI = 3.14159265358979323846;
static constexpr double DEG = PI / 180.0;

// 1 Ceres (dwarf planet)
inline AsteroidElements ceres() {
    return AsteroidElements{
        "1 Ceres",
        2451545.0,              // J2000
        2.7675 * AU,            // a = 2.767 AU
        0.0758,                 // e
        10.594 * DEG,           // i
        80.329 * DEG,           // Ω
        73.597 * DEG,           // ω
        77.372 * DEG,           // M at epoch
        6.26325e10,             // GM ~ 62.6 km³/s² → m³/s²
        473000.0                // mean radius 473 km
    };
}

// 4 Vesta
inline AsteroidElements vesta() {
    return AsteroidElements{
        "4 Vesta",
        2451545.0,
        2.3615 * AU,            // a = 2.362 AU
        0.0887,                 // e
        7.134 * DEG,            // i
        103.851 * DEG,          // Ω
        149.855 * DEG,          // ω
        20.864 * DEG,           // M at epoch
        1.7288e10,              // GM ~ 17.3 km³/s²
        262700.0                // mean radius 263 km
    };
}

// 433 Eros (near-Earth asteroid)
inline AsteroidElements eros() {
    return AsteroidElements{
        "433 Eros",
        2451545.0,
        1.4583 * AU,            // a = 1.458 AU
        0.2226,                 // e
        10.829 * DEG,           // i
        304.319 * DEG,          // Ω
        178.640 * DEG,          // ω
        320.313 * DEG,          // M at epoch
        4.463e5,                // GM ~ 0.000446 km³/s²
        8420.0                  // mean radius 8.42 km
    };
}

// 101955 Bennu (OSIRIS-REx target)
inline AsteroidElements bennu() {
    return AsteroidElements{
        "101955 Bennu",
        2451545.0,
        1.1264 * AU,            // a = 1.126 AU
        0.2037,                 // e
        6.035 * DEG,            // i
        2.061 * DEG,            // Ω
        66.223 * DEG,           // ω
        101.703 * DEG,          // M at epoch
        4.892,                  // GM very small
        245.0                   // mean radius 245 m
    };
}

}  // namespace asteroids

// ─────────────────────────────────────────────────────────────
// Propagation functions
// ─────────────────────────────────────────────────────────────

/**
 * Solve Kepler's equation for eccentric anomaly
 */
inline double asteroid_solve_kepler(double M, double e, double tol = 1e-12) {
    M = std::fmod(M, 2.0 * 3.14159265358979323846);
    if (M < 0.0) M += 2.0 * 3.14159265358979323846;

    double E = (e < 0.8) ? M : 3.14159265358979323846;
    for (int i = 0; i < 50; ++i) {
        double dE = (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
        E -= dE;
        if (std::fabs(dE) < tol) break;
    }
    return E;
}

/**
 * Compute asteroid position in Heliocentric J2000 Equatorial at given JD.
 * Propagates mean anomaly from epoch, solves Kepler, transforms to HCI.
 */
inline Vec3 asteroid_position_hci(const AsteroidElements& ast, double jd) {
    constexpr double PI = 3.14159265358979323846;
    constexpr double TWO_PI = 2.0 * PI;

    // Mean motion [rad/s]
    double n = std::sqrt(SUN_MU / (ast.sma * ast.sma * ast.sma));

    // Time since epoch [s]
    double dt = (jd - ast.epoch_jd) * 86400.0;

    // Propagated mean anomaly
    double M = ast.mean_anomaly + n * dt;
    M = std::fmod(M, TWO_PI);
    if (M < 0.0) M += TWO_PI;

    // Solve Kepler
    double E = asteroid_solve_kepler(M, ast.ecc);

    // True anomaly
    double sin_nu = std::sqrt(1.0 - ast.ecc * ast.ecc) * std::sin(E) / (1.0 - ast.ecc * std::cos(E));
    double cos_nu = (std::cos(E) - ast.ecc) / (1.0 - ast.ecc * std::cos(E));
    double nu = std::atan2(sin_nu, cos_nu);

    // Distance
    double r = ast.sma * (1.0 - ast.ecc * std::cos(E));

    // Argument of latitude
    double u = ast.arg_pe + nu;
    double cos_u = std::cos(u);
    double sin_u = std::sin(u);
    double cos_O = std::cos(ast.raan);
    double sin_O = std::sin(ast.raan);
    double cos_i = std::cos(ast.inc);
    double sin_i = std::sin(ast.inc);

    // Ecliptic coordinates
    double x_ecl = r * (cos_O * cos_u - sin_O * sin_u * cos_i);
    double y_ecl = r * (sin_O * cos_u + cos_O * sin_u * cos_i);
    double z_ecl = r * (sin_u * sin_i);

    // Rotate ecliptic → equatorial
    double cos_eps = std::cos(OBLIQUITY_J2000);
    double sin_eps = std::sin(OBLIQUITY_J2000);

    return Vec3{
        x_ecl,
        y_ecl * cos_eps - z_ecl * sin_eps,
        y_ecl * sin_eps + z_ecl * cos_eps
    };
}

/**
 * Compute asteroid full state in HCI (position + velocity via numerical derivative)
 */
inline StateVector asteroid_state_hci(const AsteroidElements& ast, double jd) {
    constexpr double h = 10.0;             // seconds
    constexpr double h_jd = h / 86400.0;

    StateVector state;
    state.position = asteroid_position_hci(ast, jd);

    Vec3 pos_p = asteroid_position_hci(ast, jd + h_jd);
    Vec3 pos_m = asteroid_position_hci(ast, jd - h_jd);
    state.velocity = Vec3{
        (pos_p.x - pos_m.x) / (2.0 * h),
        (pos_p.y - pos_m.y) / (2.0 * h),
        (pos_p.z - pos_m.z) / (2.0 * h)
    };

    state.frame = CoordinateFrame::J2000_ECI;  // Will be HELIOCENTRIC_J2000
    state.time = (jd - 2451545.0) * 86400.0;
    return state;
}

}  // namespace sim

#endif  // SIM_ASTEROID_BODY_HPP
