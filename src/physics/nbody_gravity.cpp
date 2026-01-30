/**
 * N-Body Gravity Implementation
 *
 * Computes gravitational acceleration from an arbitrary set of solar system
 * bodies in Heliocentric J2000 coordinates.  Sun is always at the origin.
 *
 * Uses consolidated gravity utilities from gravity_utils.hpp for two-body
 * and J2 perturbation formulas to stay consistent with the rest of the
 * codebase.
 */

#include "nbody_gravity.hpp"
#include "physics/gravity_utils.hpp"
#include <cmath>

namespace sim {

// =================================================================
// Preset configurations
// =================================================================

NBodyConfig NBodyConfig::earth_moon_sun() {
    NBodyConfig cfg;
    cfg.bodies = {
        {Planet::EARTH,   true},
        {Planet::VENUS,   false},
        {Planet::MARS,    false},
        {Planet::JUPITER, false}
    };
    cfg.central_body = Planet::EARTH;
    cfg.epoch_jd = PlanetaryEphemeris::J2000_EPOCH;
    return cfg;
}

NBodyConfig NBodyConfig::inner_solar_system() {
    NBodyConfig cfg;
    cfg.bodies = {
        {Planet::MERCURY, false},
        {Planet::VENUS,   false},
        {Planet::EARTH,   true},
        {Planet::MARS,    true},
        {Planet::JUPITER, false}
    };
    cfg.central_body = Planet::EARTH;
    cfg.epoch_jd = PlanetaryEphemeris::J2000_EPOCH;
    return cfg;
}

NBodyConfig NBodyConfig::full_solar_system() {
    NBodyConfig cfg;
    cfg.bodies = {
        {Planet::MERCURY, false},
        {Planet::VENUS,   false},
        {Planet::EARTH,   true},
        {Planet::MARS,    true},
        {Planet::JUPITER, true},
        {Planet::SATURN,  true},
        {Planet::URANUS,  false},
        {Planet::NEPTUNE, false},
        {Planet::PLUTO,   false}
    };
    cfg.central_body = Planet::EARTH;
    cfg.epoch_jd = PlanetaryEphemeris::J2000_EPOCH;
    return cfg;
}

NBodyConfig NBodyConfig::mars_mission() {
    NBodyConfig cfg;
    cfg.bodies = {
        {Planet::EARTH,   true},
        {Planet::MARS,    true},
        {Planet::JUPITER, false}
    };
    cfg.central_body = Planet::EARTH;
    cfg.epoch_jd = PlanetaryEphemeris::J2000_EPOCH;
    return cfg;
}

// =================================================================
// Acceleration computation
// =================================================================

Vec3 NBodyGravity::compute_acceleration_hci(
    const Vec3& pos_hci,
    double jd,
    const NBodyConfig& config) {

    // ── 1. Sun gravity (Sun is at HCI origin) ──
    double r_sun = pos_hci.norm();
    Vec3 accel{0.0, 0.0, 0.0};

    if (r_sun > 1.0) {
        double r_sun3 = r_sun * r_sun * r_sun;
        double coeff = -SUN_MU / r_sun3;
        accel.x = coeff * pos_hci.x;
        accel.y = coeff * pos_hci.y;
        accel.z = coeff * pos_hci.z;
    }

    // ── 2. Each configured body ──
    for (const auto& entry : config.bodies) {
        const auto& pc = PlanetaryConstants::get(entry.planet);
        Vec3 body_pos = PlanetaryEphemeris::get_position_hci(entry.planet, jd);

        // Vector from body to spacecraft
        Vec3 r_rel{
            pos_hci.x - body_pos.x,
            pos_hci.y - body_pos.y,
            pos_hci.z - body_pos.z
        };
        double dist = r_rel.norm();

        if (dist < 1.0) continue;  // avoid singularity

        // Point-mass gravity: a = -mu * r_rel / |r_rel|^3
        double dist3 = dist * dist * dist;
        double body_coeff = -pc.mu / dist3;
        accel.x += body_coeff * r_rel.x;
        accel.y += body_coeff * r_rel.y;
        accel.z += body_coeff * r_rel.z;

        // ── Optional J2 perturbation (only when close) ──
        if (entry.include_j2 && pc.j2 != 0.0 &&
            pc.soi_radius > 0.0 &&
            dist < pc.soi_radius * J2_RANGE_SOI_FACTOR) {

            Vec3 j2_acc = gravity::j2_perturbation(
                r_rel, pc.mu, pc.j2, pc.radius);
            accel.x += j2_acc.x;
            accel.y += j2_acc.y;
            accel.z += j2_acc.z;
        }
    }

    return accel;
}

// =================================================================
// Derivative function for AdaptiveIntegrator
// =================================================================

std::function<StateVector(const StateVector&)>
NBodyGravity::make_derivative_function(
    const NBodyConfig& config,
    double epoch_jd) {

    return [config, epoch_jd](const StateVector& state) -> StateVector {
        // Convert simulation elapsed time to Julian Date
        double jd = epoch_jd + state.time / 86400.0;

        Vec3 accel = compute_acceleration_hci(state.position, jd, config);

        StateVector deriv;
        // Position rate = velocity
        deriv.velocity = state.velocity;
        // Velocity rate = acceleration (stored in angular_velocity per
        // AdaptiveIntegrator convention)
        deriv.angular_velocity = accel;
        // Time rate
        deriv.time = 1.0;
        deriv.frame = CoordinateFrame::HELIOCENTRIC_J2000;

        return deriv;
    };
}

// =================================================================
// SOI transition detection
// =================================================================

std::pair<bool, Planet> NBodyGravity::check_soi_transition(
    const Vec3& pos_hci,
    double jd,
    Planet current_primary) {

    // Check every planet's SOI
    static constexpr Planet ALL_PLANETS[] = {
        Planet::MERCURY, Planet::VENUS, Planet::EARTH, Planet::MARS,
        Planet::JUPITER, Planet::SATURN, Planet::URANUS, Planet::NEPTUNE,
        Planet::PLUTO
    };

    for (Planet planet : ALL_PLANETS) {
        if (planet == current_primary) continue;

        const auto& pc = PlanetaryConstants::get(planet);
        if (pc.soi_radius <= 0.0) continue;

        Vec3 body_pos = PlanetaryEphemeris::get_position_hci(planet, jd);
        Vec3 r_rel{
            pos_hci.x - body_pos.x,
            pos_hci.y - body_pos.y,
            pos_hci.z - body_pos.z
        };
        double dist = r_rel.norm();

        if (dist < pc.soi_radius) {
            return {true, planet};
        }
    }

    // If currently inside a planet's SOI, check if we've left it
    if (current_primary != Planet::MERCURY) {  // use as proxy for "not Sun"
        const auto& pc = PlanetaryConstants::get(current_primary);
        if (pc.soi_radius > 0.0) {
            Vec3 body_pos = PlanetaryEphemeris::get_position_hci(current_primary, jd);
            Vec3 r_rel{
                pos_hci.x - body_pos.x,
                pos_hci.y - body_pos.y,
                pos_hci.z - body_pos.z
            };
            if (r_rel.norm() > pc.soi_radius) {
                // Left the current primary's SOI -- now in heliocentric space.
                // Return EARTH as a default; the caller should interpret this
                // as "no longer bound to current_primary".
                return {true, Planet::EARTH};
            }
        }
    }

    return {false, current_primary};
}

// =================================================================
// Frame conversions
// =================================================================

StateVector NBodyGravity::hci_to_body_centered(
    const StateVector& state_hci,
    Planet body,
    double jd) {

    Vec3 body_pos = PlanetaryEphemeris::get_position_hci(body, jd);
    Vec3 body_vel = PlanetaryEphemeris::get_velocity_hci(body, jd);

    StateVector state_bc = state_hci;
    state_bc.position.x -= body_pos.x;
    state_bc.position.y -= body_pos.y;
    state_bc.position.z -= body_pos.z;
    state_bc.velocity.x -= body_vel.x;
    state_bc.velocity.y -= body_vel.y;
    state_bc.velocity.z -= body_vel.z;
    state_bc.frame = CoordinateFrame::PLANET_CENTERED;

    return state_bc;
}

StateVector NBodyGravity::body_centered_to_hci(
    const StateVector& state_bc,
    Planet body,
    double jd) {

    Vec3 body_pos = PlanetaryEphemeris::get_position_hci(body, jd);
    Vec3 body_vel = PlanetaryEphemeris::get_velocity_hci(body, jd);

    StateVector state_hci = state_bc;
    state_hci.position.x += body_pos.x;
    state_hci.position.y += body_pos.y;
    state_hci.position.z += body_pos.z;
    state_hci.velocity.x += body_vel.x;
    state_hci.velocity.y += body_vel.y;
    state_hci.velocity.z += body_vel.z;
    state_hci.frame = CoordinateFrame::HELIOCENTRIC_J2000;

    return state_hci;
}

}  // namespace sim
