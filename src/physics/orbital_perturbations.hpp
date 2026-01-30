/**
 * Unified Orbital Perturbation Model
 *
 * Accumulates all enabled perturbation accelerations into a single
 * derivative function compatible with RK4Integrator.
 *
 * Perturbations available:
 *   - Central body (two-body gravity)
 *   - J2, J3, J4 zonal harmonics
 *   - Third-body: Moon, Sun
 *   - Solar radiation pressure (cannonball + shadow)
 *   - Atmospheric drag (LEO, co-rotating atmosphere)
 */

#ifndef SIM_ORBITAL_PERTURBATIONS_HPP
#define SIM_ORBITAL_PERTURBATIONS_HPP

#include "core/state_vector.hpp"
#include "physics/solar_radiation_pressure.hpp"
#include <functional>

namespace sim {

/**
 * Configuration for which perturbations to include.
 * Each flag can be independently toggled.
 */
struct PerturbationConfig {
    // Gravity harmonics
    bool j2 = true;
    bool j3 = false;
    bool j4 = false;

    // Third-body effects
    bool moon = false;
    bool sun = false;

    // Non-gravitational forces
    bool srp = false;
    bool drag = false;

    // SRP parameters
    SRPParameters srp_params = SRPParameters::default_satellite();

    // Drag parameters
    double drag_cd = 2.2;       // Drag coefficient
    double drag_area = 10.0;    // Cross-sectional area [m^2]
    double drag_mass = 500.0;   // Spacecraft mass [kg]

    // Time reference for ephemeris
    double epoch_jd = 2451545.0;  // J2000.0 default

    // Convenience constructors
    static PerturbationConfig two_body_only() {
        PerturbationConfig c;
        c.j2 = false;
        return c;
    }

    static PerturbationConfig j2_only() {
        return PerturbationConfig{};  // j2=true by default
    }

    static PerturbationConfig full_harmonics() {
        PerturbationConfig c;
        c.j3 = true;
        c.j4 = true;
        return c;
    }

    static PerturbationConfig full_fidelity() {
        PerturbationConfig c;
        c.j3 = true;
        c.j4 = true;
        c.moon = true;
        c.sun = true;
        c.srp = true;
        c.drag = true;
        return c;
    }

    static PerturbationConfig leo_satellite(double mass, double area, double cd) {
        PerturbationConfig c;
        c.j3 = true;
        c.j4 = true;
        c.moon = true;
        c.sun = true;
        c.srp = true;
        c.drag = true;
        c.drag_cd = cd;
        c.drag_area = area;
        c.drag_mass = mass;
        c.srp_params = SRPParameters{area, mass, 1.5};
        return c;
    }

    static PerturbationConfig geo_satellite(double mass, double area, double cr) {
        PerturbationConfig c;
        c.j3 = true;
        c.j4 = true;
        c.moon = true;
        c.sun = true;
        c.srp = true;
        c.drag = false;  // No drag at GEO
        c.srp_params = SRPParameters{area, mass, cr};
        return c;
    }
};

/**
 * Individual perturbation accelerations for diagnostics
 */
struct PerturbationBreakdown {
    Vec3 central_body;
    Vec3 j2;
    Vec3 j3;
    Vec3 j4;
    Vec3 moon;
    Vec3 sun;
    Vec3 srp;
    Vec3 drag;
    Vec3 total;
};

/**
 * Unified orbital perturbation model
 */
class OrbitalPerturbations {
public:
    /**
     * Compute total acceleration from all enabled perturbations
     *
     * @param position Spacecraft position in ECI [m]
     * @param velocity Spacecraft velocity in ECI [m/s]
     * @param config Perturbation configuration
     * @param jd Current Julian Date
     * @return Total acceleration [m/s^2]
     */
    static Vec3 compute_total_acceleration(
        const Vec3& position,
        const Vec3& velocity,
        const PerturbationConfig& config,
        double jd);

    /**
     * Compute state derivatives for RK4 integration
     *
     * Returns StateVector where:
     *   .velocity = input velocity (dr/dt)
     *   .position = total acceleration (dv/dt)
     *
     * @param state Current state
     * @param config Perturbation configuration
     * @param jd Current Julian Date
     * @return State derivatives
     */
    static StateVector compute_derivatives(
        const StateVector& state,
        const PerturbationConfig& config,
        double jd);

    /**
     * Create a derivative function lambda for RK4Integrator::step()
     *
     * Captures config and epoch_jd. The lambda converts state.time
     * (seconds since epoch) to Julian Date for ephemeris lookups.
     *
     * @param config Perturbation configuration
     * @param epoch_jd Julian Date at simulation time = 0
     * @return Lambda matching RK4Integrator::DerivativeFunction
     */
    static std::function<StateVector(const StateVector&)>
    make_derivative_function(const PerturbationConfig& config, double epoch_jd);

    /**
     * Compute individual perturbation accelerations for diagnostics
     */
    static PerturbationBreakdown compute_breakdown(
        const Vec3& position,
        const Vec3& velocity,
        const PerturbationConfig& config,
        double jd);
};

}  // namespace sim

#endif  // SIM_ORBITAL_PERTURBATIONS_HPP
