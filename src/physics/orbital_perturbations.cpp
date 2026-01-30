/**
 * Unified Orbital Perturbation Model Implementation
 */

#include "orbital_perturbations.hpp"
#include "physics/gravity_utils.hpp"
#include "physics/atmosphere_model.hpp"
#include "physics/lunar_ephemeris.hpp"
#include "physics/solar_ephemeris.hpp"
#include "physics/solar_radiation_pressure.hpp"
#include <cmath>

namespace sim {

static const Vec3 ZERO_VEC{0.0, 0.0, 0.0};

Vec3 OrbitalPerturbations::compute_total_acceleration(
    const Vec3& position,
    const Vec3& velocity,
    const PerturbationConfig& config,
    double jd) {

    const auto& earth = gravity::BodyConstants::EARTH;

    // Central body (always included)
    Vec3 accel = gravity::two_body_acceleration(position, earth.mu);

    // J2 oblateness
    if (config.j2) {
        Vec3 a_j2 = gravity::j2_perturbation(position, earth.mu, earth.j2, earth.radius);
        accel.x += a_j2.x;
        accel.y += a_j2.y;
        accel.z += a_j2.z;
    }

    // J3 pear-shaped asymmetry
    if (config.j3) {
        Vec3 a_j3 = gravity::j3_perturbation(position, earth.mu, earth.j3, earth.radius);
        accel.x += a_j3.x;
        accel.y += a_j3.y;
        accel.z += a_j3.z;
    }

    // J4 higher-order oblateness
    if (config.j4) {
        Vec3 a_j4 = gravity::j4_perturbation(position, earth.mu, earth.j4, earth.radius);
        accel.x += a_j4.x;
        accel.y += a_j4.y;
        accel.z += a_j4.z;
    }

    // Lunar third-body perturbation
    if (config.moon) {
        Vec3 moon_pos = LunarEphemeris::get_moon_position_eci(jd);
        Vec3 a_moon = gravity::third_body_perturbation(position, moon_pos, MOON_MU);
        accel.x += a_moon.x;
        accel.y += a_moon.y;
        accel.z += a_moon.z;
    }

    // Solar third-body perturbation
    if (config.sun) {
        Vec3 sun_pos = SolarEphemeris::get_sun_position_eci(jd);
        Vec3 a_sun = gravity::third_body_perturbation(position, sun_pos, SUN_MU);
        accel.x += a_sun.x;
        accel.y += a_sun.y;
        accel.z += a_sun.z;
    }

    // Solar radiation pressure
    if (config.srp) {
        Vec3 sun_pos = SolarEphemeris::get_sun_position_eci(jd);
        Vec3 a_srp = SolarRadiationPressure::compute_acceleration(
            position, sun_pos, config.srp_params);
        accel.x += a_srp.x;
        accel.y += a_srp.y;
        accel.z += a_srp.z;
    }

    // Atmospheric drag
    if (config.drag) {
        double alt = position.norm() - EARTH_RADIUS;
        if (alt > 0.0 && alt < 200000.0) {  // Below 200 km atmosphere limit
            // Atmosphere co-rotates with Earth
            // v_rel = v_inertial - omega_earth x r
            Vec3 v_atm{
                -EARTH_OMEGA * position.y,
                 EARTH_OMEGA * position.x,
                 0.0
            };
            Vec3 v_rel{
                velocity.x - v_atm.x,
                velocity.y - v_atm.y,
                velocity.z - v_atm.z
            };

            double v_mag = v_rel.norm();
            if (v_mag > 1.0) {
                double rho = AtmosphereModel::get_density_extended(alt);
                if (rho > 1e-20) {
                    // a_drag = -0.5 * rho * v^2 * Cd * A / m * v_hat
                    double bc_inv = config.drag_cd * config.drag_area / config.drag_mass;
                    double drag_mag = 0.5 * rho * v_mag * v_mag * bc_inv;
                    double inv_v = 1.0 / v_mag;
                    accel.x -= drag_mag * v_rel.x * inv_v;
                    accel.y -= drag_mag * v_rel.y * inv_v;
                    accel.z -= drag_mag * v_rel.z * inv_v;
                }
            }
        }
    }

    return accel;
}

StateVector OrbitalPerturbations::compute_derivatives(
    const StateVector& state,
    const PerturbationConfig& config,
    double jd) {

    Vec3 accel = compute_total_acceleration(
        state.position, state.velocity, config, jd);

    StateVector deriv;
    // Position derivative = velocity
    deriv.velocity = state.velocity;
    // Velocity derivative = acceleration (stored in .position per convention)
    deriv.position = accel;
    deriv.time = 1.0;

    return deriv;
}

std::function<StateVector(const StateVector&)>
OrbitalPerturbations::make_derivative_function(
    const PerturbationConfig& config,
    double epoch_jd) {

    return [config, epoch_jd](const StateVector& state) -> StateVector {
        // Convert simulation time to Julian Date
        double jd = epoch_jd + state.time / 86400.0;
        return compute_derivatives(state, config, jd);
    };
}

PerturbationBreakdown OrbitalPerturbations::compute_breakdown(
    const Vec3& position,
    const Vec3& velocity,
    const PerturbationConfig& config,
    double jd) {

    PerturbationBreakdown bd;
    const auto& earth = gravity::BodyConstants::EARTH;

    // Central body
    bd.central_body = gravity::two_body_acceleration(position, earth.mu);

    // Harmonics
    bd.j2 = config.j2 ? gravity::j2_perturbation(position, earth.mu, earth.j2, earth.radius) : ZERO_VEC;
    bd.j3 = config.j3 ? gravity::j3_perturbation(position, earth.mu, earth.j3, earth.radius) : ZERO_VEC;
    bd.j4 = config.j4 ? gravity::j4_perturbation(position, earth.mu, earth.j4, earth.radius) : ZERO_VEC;

    // Third bodies
    if (config.moon) {
        Vec3 moon_pos = LunarEphemeris::get_moon_position_eci(jd);
        bd.moon = gravity::third_body_perturbation(position, moon_pos, MOON_MU);
    } else {
        bd.moon = ZERO_VEC;
    }

    if (config.sun) {
        Vec3 sun_pos = SolarEphemeris::get_sun_position_eci(jd);
        bd.sun = gravity::third_body_perturbation(position, sun_pos, SUN_MU);
    } else {
        bd.sun = ZERO_VEC;
    }

    // SRP
    if (config.srp) {
        Vec3 sun_pos = SolarEphemeris::get_sun_position_eci(jd);
        bd.srp = SolarRadiationPressure::compute_acceleration(
            position, sun_pos, config.srp_params);
    } else {
        bd.srp = ZERO_VEC;
    }

    // Drag
    bd.drag = ZERO_VEC;
    if (config.drag) {
        double alt = position.norm() - EARTH_RADIUS;
        if (alt > 0.0 && alt < 200000.0) {
            Vec3 v_atm{
                -EARTH_OMEGA * position.y,
                 EARTH_OMEGA * position.x,
                 0.0
            };
            Vec3 v_rel{
                velocity.x - v_atm.x,
                velocity.y - v_atm.y,
                velocity.z - v_atm.z
            };
            double v_mag = v_rel.norm();
            if (v_mag > 1.0) {
                double rho = AtmosphereModel::get_density_extended(alt);
                if (rho > 1e-20) {
                    double bc_inv = config.drag_cd * config.drag_area / config.drag_mass;
                    double drag_mag = 0.5 * rho * v_mag * v_mag * bc_inv;
                    double inv_v = 1.0 / v_mag;
                    bd.drag = Vec3{
                        -drag_mag * v_rel.x * inv_v,
                        -drag_mag * v_rel.y * inv_v,
                        -drag_mag * v_rel.z * inv_v
                    };
                }
            }
        }
    }

    // Total
    bd.total = Vec3{
        bd.central_body.x + bd.j2.x + bd.j3.x + bd.j4.x +
        bd.moon.x + bd.sun.x + bd.srp.x + bd.drag.x,
        bd.central_body.y + bd.j2.y + bd.j3.y + bd.j4.y +
        bd.moon.y + bd.sun.y + bd.srp.y + bd.drag.y,
        bd.central_body.z + bd.j2.z + bd.j3.z + bd.j4.z +
        bd.moon.z + bd.sun.z + bd.srp.z + bd.drag.z
    };

    return bd;
}

}  // namespace sim
