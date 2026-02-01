/**
 * KeplerPropagator — Header-only analytical Kepler propagation.
 *
 * Wraps the existing OrbitalMechanics class for tick-based propagation.
 * Mirrors the JS orbital_2body component's propagation logic:
 *   state_to_elements → advance mean anomaly → solve Kepler → elements_to_state
 */

#ifndef SIM_MC_KEPLER_PROPAGATOR_HPP
#define SIM_MC_KEPLER_PROPAGATOR_HPP

#include "mc_entity.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/vec3_ops.hpp"
#include <cmath>

namespace sim::mc {

/**
 * Initialize entity ECI state from classical orbital elements.
 * JSON stores angles in degrees; this converts to radians internally.
 */
inline void init_from_elements(MCEntity& ent,
                               double sma, double ecc,
                               double inc_deg, double raan_deg,
                               double arg_pe_deg, double ma_deg)
{
    constexpr double DEG = M_PI / 180.0;

    sim::OrbitalElements elems;
    elems.semi_major_axis = sma;
    elems.eccentricity = ecc;
    elems.inclination = inc_deg * DEG;
    elems.raan = raan_deg * DEG;
    elems.arg_periapsis = arg_pe_deg * DEG;
    elems.mean_anomaly = ma_deg * DEG;

    // Convert mean anomaly to true anomaly for elements_to_state
    elems.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
        elems.mean_anomaly, elems.eccentricity);

    sim::StateVector sv = sim::OrbitalMechanics::elements_to_state(elems);
    ent.eci_pos = sv.position;
    ent.eci_vel = sv.velocity;

    // Cache orbital params
    ent.sma = sma;
    ent.ecc = ecc;
    ent.inc_rad = inc_deg * DEG;
    ent.raan_rad = raan_deg * DEG;
    ent.arg_pe_rad = arg_pe_deg * DEG;
    ent.mean_anomaly_rad = ma_deg * DEG;
    ent.has_physics = true;
}

/**
 * Propagate ECI state forward by dt seconds using analytical Kepler.
 * Mirrors JS TLEParser.propagateKepler: state→elements→advance M→elements→state.
 *
 * Modifies pos and vel in-place.
 */
inline void propagate_kepler(sim::Vec3& pos, sim::Vec3& vel, double dt) {
    double r_mag = pos.norm();
    double v_mag = vel.norm();

    // Guard: degenerate state
    if (r_mag < 1000.0 || v_mag < 0.1) return;

    // Angular momentum check
    sim::Vec3 h = cross(pos, vel);
    double h_mag = h.norm();
    if (h_mag < 1e3) {
        // Degenerate: linear propagation
        pos = pos + vel * dt;
        return;
    }

    // Orbital energy → semi-major axis
    double energy = 0.5 * v_mag * v_mag -
                    sim::OrbitalMechanics::MU_EARTH / r_mag;
    double sma = -sim::OrbitalMechanics::MU_EARTH / (2.0 * energy);

    if (!std::isfinite(sma) || sma <= 0.0) {
        // Hyperbolic or parabolic: linear propagation
        pos = pos + vel * dt;
        return;
    }

    // Convert current state to elements
    sim::StateVector sv;
    sv.position = pos;
    sv.velocity = vel;
    sim::OrbitalElements elems = sim::OrbitalMechanics::state_to_elements(sv);

    if (elems.eccentricity >= 1.0) {
        pos = pos + vel * dt;
        return;
    }

    // Advance mean anomaly
    double n = elems.mean_motion();
    double M_new = sim::OrbitalMechanics::propagate_mean_anomaly(
        elems.mean_anomaly, n, dt);

    // New true anomaly from updated mean anomaly
    elems.true_anomaly = sim::OrbitalMechanics::mean_to_true_anomaly(
        M_new, elems.eccentricity);
    elems.mean_anomaly = M_new;

    // Convert back to Cartesian state
    sim::StateVector new_sv = sim::OrbitalMechanics::elements_to_state(elems);

    // Guard NaN propagation
    if (std::isfinite(new_sv.position.x) && std::isfinite(new_sv.velocity.x)) {
        pos = new_sv.position;
        vel = new_sv.velocity;
    }
}

} // namespace sim::mc

#endif // SIM_MC_KEPLER_PROPAGATOR_HPP
