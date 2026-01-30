/**
 * N-Body Gravity System
 *
 * Generalized gravitational acceleration from an arbitrary set of solar
 * system bodies, working in Heliocentric J2000 (HCI) coordinates.
 * Uses PlanetaryEphemeris for body positions at each time step.
 *
 * Designed for interplanetary trajectory propagation with the
 * AdaptiveIntegrator (Dormand-Prince 4(5)).
 *
 * Features:
 *   - Configurable body list with optional J2 for each body
 *   - Sun gravity always included (origin of HCI frame)
 *   - SOI transition detection for patched-conic switching
 *   - HCI <-> body-centered frame conversions
 *   - Preset configurations for common mission profiles
 */

#ifndef SIM_NBODY_GRAVITY_HPP
#define SIM_NBODY_GRAVITY_HPP

#include "core/state_vector.hpp"
#include "planetary_ephemeris.hpp"
#include "celestial_body.hpp"
#include <vector>
#include <functional>
#include <utility>

namespace sim {

// -----------------------------------------------------------------
// Configuration structs
// -----------------------------------------------------------------

/**
 * A single gravitating body in the N-body system.
 */
struct NBodyEntry {
    Planet planet;      ///< Which planet
    bool include_j2;    ///< Whether to add J2 perturbation when close
};

/**
 * Full N-body configuration: which bodies to include,
 * which body the spacecraft is currently orbiting, and the
 * simulation epoch.
 */
struct NBodyConfig {
    std::vector<NBodyEntry> bodies;   ///< Gravitating bodies (Sun is implicit)
    Planet central_body;              ///< Current primary for SOI context
    double epoch_jd;                  ///< Julian Date at simulation time = 0

    // ── Preset configurations ──

    /** Earth-Moon-Sun system (cislunar / LEO / GEO) */
    static NBodyConfig earth_moon_sun();

    /** Inner solar system: Mercury through Mars + Jupiter perturbation */
    static NBodyConfig inner_solar_system();

    /** Full solar system: all nine planets */
    static NBodyConfig full_solar_system();

    /** Mars mission: Sun + Earth + Mars + Jupiter */
    static NBodyConfig mars_mission();
};

// -----------------------------------------------------------------
// N-Body Gravity Calculator
// -----------------------------------------------------------------

/**
 * Static methods for N-body gravitational computations in HCI frame.
 *
 * All positions are in Heliocentric J2000 Equatorial coordinates [m].
 * The Sun sits at the origin; its gravity is always included.
 */
class NBodyGravity {
public:
    /**
     * Compute total gravitational acceleration at a point in HCI space.
     *
     * Sums:
     *   1. Sun gravity:  a_sun = -SUN_MU * r_sc / |r_sc|^3
     *   2. For each body: a_i  = -mu_i * (r_sc - r_i) / |r_sc - r_i|^3
     *   3. Optional J2 when spacecraft is within 10 SOI radii of a body
     *
     * @param pos_hci   Spacecraft position in HCI [m]
     * @param jd        Current Julian Date
     * @param config    N-body configuration
     * @return Total acceleration [m/s^2] in HCI
     */
    static Vec3 compute_acceleration_hci(
        const Vec3& pos_hci,
        double jd,
        const NBodyConfig& config);

    /**
     * Create a derivative function for AdaptiveIntegrator.
     *
     * Returns a lambda with signature StateVector(const StateVector&) where:
     *   result.velocity        = input state.velocity   (dr/dt)
     *   result.angular_velocity = acceleration           (dv/dt)
     *   result.time            = 1.0                     (dt/dt)
     *
     * The Julian Date for ephemeris lookups is computed as:
     *   jd = epoch_jd + state.time / 86400.0
     *
     * @param config    N-body configuration
     * @param epoch_jd  Julian Date when state.time == 0
     * @return Derivative function for AdaptiveIntegrator
     */
    static std::function<StateVector(const StateVector&)>
    make_derivative_function(const NBodyConfig& config, double epoch_jd);

    /**
     * Check whether the spacecraft has crossed a sphere-of-influence boundary.
     *
     * Compares the spacecraft's distance to each configured body against
     * that body's SOI radius (from PlanetaryConstants).
     *
     * @param pos_hci         Spacecraft position in HCI [m]
     * @param jd              Current Julian Date
     * @param current_primary The body the spacecraft is currently orbiting
     * @return {true, new_primary} if a transition occurred, {false, current_primary} otherwise
     */
    static std::pair<bool, Planet> check_soi_transition(
        const Vec3& pos_hci,
        double jd,
        Planet current_primary);

    /**
     * Convert an HCI state to body-centered inertial coordinates.
     *
     * Subtracts the body's HCI position and velocity from the spacecraft state.
     *
     * @param state_hci  Spacecraft state in HCI
     * @param body       Target body
     * @param jd         Current Julian Date
     * @return State relative to the body center
     */
    static StateVector hci_to_body_centered(
        const StateVector& state_hci,
        Planet body,
        double jd);

    /**
     * Convert a body-centered state back to HCI coordinates.
     *
     * Adds the body's HCI position and velocity to the spacecraft state.
     *
     * @param state_bc   Spacecraft state relative to body
     * @param body       Reference body
     * @param jd         Current Julian Date
     * @return State in HCI
     */
    static StateVector body_centered_to_hci(
        const StateVector& state_bc,
        Planet body,
        double jd);

private:
    /// Maximum distance (in SOI radii) at which J2 perturbation is applied
    static constexpr double J2_RANGE_SOI_FACTOR = 10.0;
};

}  // namespace sim

#endif  // SIM_NBODY_GRAVITY_HPP
