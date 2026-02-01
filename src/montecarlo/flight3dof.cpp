/**
 * Flight3DOF — 3-DOF atmospheric flight propagator.
 *
 * Equations of motion for a point-mass aircraft:
 *   dV/dt      = (T·cos(α) - D) / m  -  g·sin(γ)
 *   dγ/dt      = (L·cos(φ) + T·sin(α) - m·g·cos(γ)) / (m·V)
 *   dψ/dt      = L·sin(φ) / (m·V·cos(γ))
 *
 * Position update via geodetic great-circle propagation.
 */

#include "montecarlo/flight3dof.hpp"
#include "montecarlo/atmosphere.hpp"
#include "montecarlo/geo_utils.hpp"
#include <cmath>
#include <algorithm>

namespace sim::mc {

void Flight3DOF::update_all(double dt, MCWorld& world) {
    for (auto& e : world.entities()) {
        if (e.physics_type != PhysicsType::FLIGHT_3DOF) continue;
        if (!e.active || e.destroyed) continue;
        update_entity(e, dt);
    }
}

void Flight3DOF::update_entity(MCEntity& e, double dt) {
    // ── Atmosphere at current altitude ──
    auto atmo = get_atmosphere(e.geo_alt);

    double V       = e.flight_speed;
    double gamma   = e.flight_gamma;
    double heading = e.flight_heading;
    double alpha   = e.flight_alpha;
    double roll    = e.flight_roll;
    double mass    = e.ac_mass;

    // ── Dynamic pressure ──
    double q = 0.5 * atmo.density * V * V;

    // ── Lift coefficient from alpha ──
    double CL = std::clamp(e.ac_cl_alpha * alpha, -e.ac_cl_max, e.ac_cl_max);

    // ── Drag coefficient: CD0 + induced + wave drag ──
    double CD = e.ac_cd0 + CL * CL / (M_PI * e.ac_oswald * e.ac_ar);

    // Wave drag above Mach 0.85
    double mach = (atmo.speed_of_sound > 1.0) ? V / atmo.speed_of_sound : 0.0;
    if (mach > 0.85) {
        double dm = mach - 0.85;
        CD += 0.1 * dm * dm;
    }

    // ── Aerodynamic forces ──
    double L = q * e.ac_wing_area * CL;
    double D = q * e.ac_wing_area * CD;

    // ── Thrust ──
    double T = 0.0;
    if (e.flight_engine_on) {
        double thrust_base = (e.flight_throttle > 0.95)
                             ? e.ac_thrust_ab
                             : e.ac_thrust_mil;
        // Density lapse: thrust decreases with altitude
        double density_ratio = atmo.density / RHO0;
        T = e.flight_throttle * thrust_base * std::pow(density_ratio, 0.7);
    }

    // ── Gravity ──
    constexpr double g = 9.80665;

    // ── Equations of motion ──
    double dV = (T * std::cos(alpha) - D) / mass - g * std::sin(gamma);

    double dGamma = 0.0;
    if (V > 1.0) {
        dGamma = (L * std::cos(roll) + T * std::sin(alpha) - mass * g * std::cos(gamma))
                 / (mass * V);
    }

    double dHeading = 0.0;
    if (V > 1.0 && std::abs(std::cos(gamma)) > 0.01) {
        dHeading = L * std::sin(roll) / (mass * V * std::cos(gamma));
    }

    // ── Integrate ──
    V       += dV * dt;
    gamma   += dGamma * dt;
    heading += dHeading * dt;

    // ── Clamp ──
    if (V < 50.0) V = 50.0;

    constexpr double gamma_limit = 80.0 * M_PI / 180.0;
    gamma = std::clamp(gamma, -gamma_limit, gamma_limit);

    // Wrap heading to [0, 2π)
    heading = std::fmod(heading, 2.0 * M_PI);
    if (heading < 0.0) heading += 2.0 * M_PI;

    // ── Position update (geodetic) ──
    double dAlt = V * std::sin(gamma) * dt;
    double dist = V * std::cos(gamma) * dt;

    // Convert degrees to radians for geo functions
    double lat_rad = e.geo_lat * M_PI / 180.0;
    double lon_rad = e.geo_lon * M_PI / 180.0;

    auto [new_lat_rad, new_lon_rad] = destination_point(lat_rad, lon_rad, heading, dist);

    // Convert back to degrees
    e.geo_lat = new_lat_rad * 180.0 / M_PI;
    e.geo_lon = new_lon_rad * 180.0 / M_PI;

    e.geo_alt += dAlt;
    if (e.geo_alt < 0.0) e.geo_alt = 0.0;

    // ── Update Mach number ──
    e.flight_mach = (atmo.speed_of_sound > 1.0) ? V / atmo.speed_of_sound : 0.0;

    // ── Store back ──
    e.flight_speed   = V;
    e.flight_heading = heading;
    e.flight_gamma   = gamma;
}

} // namespace sim::mc
