/**
 * Low-Thrust Propulsion Implementation
 *
 * Solar electric propulsion with solar-distance-dependent thrust,
 * mass depletion, and configurable pointing directions.
 */

#include "low_thrust.hpp"
#include "nbody_gravity.hpp"
#include "celestial_body.hpp"
#include "propagators/adaptive_integrator.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

Vec3 LowThrustPropagator::compute_thrust_acceleration(
    const StateVector& state,
    const LowThrustConfig& config,
    ThrustDirection direction,
    double current_mass,
    const Vec3& custom_dir)
{
    if (current_mass <= 0.0) return Vec3(0, 0, 0);

    // Compute thrust magnitude
    double T = config.thrust;

    if (config.solar_scaling) {
        // Scale thrust by inverse square of solar distance
        double r = state.position.norm();
        double r_au = r / AU;
        if (r_au < 0.1) r_au = 0.1;  // Clamp to avoid singularity near Sun
        T = config.thrust / (r_au * r_au);
    }

    double accel_mag = T / current_mass;

    // Compute direction unit vector
    Vec3 dir;

    switch (direction) {
        case ThrustDirection::PROGRADE: {
            double v_mag = state.velocity.norm();
            if (v_mag < 1e-10) return Vec3(0, 0, 0);
            dir = Vec3(state.velocity.x / v_mag,
                       state.velocity.y / v_mag,
                       state.velocity.z / v_mag);
            break;
        }
        case ThrustDirection::ANTI_VELOCITY: {
            double v_mag = state.velocity.norm();
            if (v_mag < 1e-10) return Vec3(0, 0, 0);
            dir = Vec3(-state.velocity.x / v_mag,
                       -state.velocity.y / v_mag,
                       -state.velocity.z / v_mag);
            break;
        }
        case ThrustDirection::SUN_POINTING: {
            double r_mag = state.position.norm();
            if (r_mag < 1e-10) return Vec3(0, 0, 0);
            dir = Vec3(state.position.x / r_mag,
                       state.position.y / r_mag,
                       state.position.z / r_mag);
            break;
        }
        case ThrustDirection::ANTI_SUN: {
            double r_mag = state.position.norm();
            if (r_mag < 1e-10) return Vec3(0, 0, 0);
            dir = Vec3(-state.position.x / r_mag,
                       -state.position.y / r_mag,
                       -state.position.z / r_mag);
            break;
        }
        case ThrustDirection::FIXED_INERTIAL: {
            double d_mag = custom_dir.norm();
            if (d_mag < 1e-10) return Vec3(0, 0, 0);
            dir = Vec3(custom_dir.x / d_mag,
                       custom_dir.y / d_mag,
                       custom_dir.z / d_mag);
            break;
        }
        case ThrustDirection::CUSTOM:
            // Not implemented — fall through to zero
            return Vec3(0, 0, 0);
    }

    return Vec3(accel_mag * dir.x,
                accel_mag * dir.y,
                accel_mag * dir.z);
}

std::function<StateVector(const StateVector&)>
LowThrustPropagator::make_derivative_function(
    const NBodyConfig& nbody_config,
    const LowThrustConfig& thrust_config,
    ThrustDirection direction,
    double epoch_jd,
    double& mass_tracker,
    const Vec3& custom_dir)
{
    // Capture by value for N-body and thrust configs, by reference for mass
    return [nbody_config, thrust_config, direction, epoch_jd, &mass_tracker, custom_dir]
           (const StateVector& state) -> StateVector
    {
        StateVector deriv;

        // dr/dt = v
        deriv.velocity = state.velocity;

        // Current Julian Date
        double jd = epoch_jd + state.time / 86400.0;

        // Gravitational acceleration from N-body system
        Vec3 a_grav = NBodyGravity::compute_acceleration_hci(state.position, jd, nbody_config);

        // Thrust acceleration (only if we have propellant)
        Vec3 a_thrust(0, 0, 0);
        if (mass_tracker > thrust_config.mass_initial * 0.01) {
            // Keep 1% as dry mass floor
            a_thrust = compute_thrust_acceleration(
                state, thrust_config, direction, mass_tracker, custom_dir);

            // Mass flow rate: dm/dt = -T / (Isp * g0)
            // We approximate mass depletion per evaluation
            // (the integrator calls this multiple times per step,
            //  but the mass change per evaluation is small for low-thrust)
            double T = thrust_config.thrust;
            if (thrust_config.solar_scaling) {
                double r_au = state.position.norm() / AU;
                if (r_au < 0.1) r_au = 0.1;
                T = thrust_config.thrust / (r_au * r_au);
            }
            double mdot = T / (thrust_config.isp * G0);

            // Don't modify mass_tracker here — the integrator calls this
            // multiple times per step. Instead, we track mass depletion
            // at the step level in propagate_segment.
            // The mass_tracker is updated externally between steps.
            (void)mdot;
        }

        // dv/dt = gravity + thrust
        deriv.angular_velocity = Vec3(
            a_grav.x + a_thrust.x,
            a_grav.y + a_thrust.y,
            a_grav.z + a_thrust.z
        );

        // dt/dt = 1
        deriv.time = 1.0;

        return deriv;
    };
}

std::vector<StateVector> LowThrustPropagator::propagate_segment(
    const StateVector& initial,
    double duration,
    const NBodyConfig& nbody_config,
    const LowThrustConfig& thrust_config,
    ThrustDirection direction,
    const AdaptiveConfig& int_config,
    double sample_interval)
{
    double mass = thrust_config.mass_initial;
    double dry_mass_floor = mass * 0.01;  // 1% dry mass floor

    // Mass flow rate for depletion tracking
    double mdot_ref = thrust_config.thrust / (thrust_config.isp * G0);

    auto deriv_fn = make_derivative_function(
        nbody_config, thrust_config, direction,
        nbody_config.epoch_jd, mass);

    // Step-by-step propagation with mass tracking
    std::vector<StateVector> result;
    StateVector current = initial;
    double t_elapsed = 0.0;
    double next_sample = sample_interval;
    double dt_try = int_config.dt_min * 10.0;  // Initial step guess

    if (sample_interval > 0.0) {
        result.push_back(current);
    }

    int step_count = 0;

    while (t_elapsed < duration && step_count < int_config.max_steps) {
        // Don't overshoot duration
        double dt_remaining = duration - t_elapsed;
        double dt_attempt = std::min(dt_try, dt_remaining);

        // Take one adaptive step
        IntegrationStep step_result = AdaptiveIntegrator::step(
            current, dt_attempt, deriv_fn, int_config);

        double dt_used = step_result.dt_used;
        t_elapsed += dt_used;

        // Update mass based on thrust and time step
        if (mass > dry_mass_floor) {
            // Account for solar scaling: approximate thrust at midpoint
            double r_au = 1.0;
            if (thrust_config.solar_scaling) {
                r_au = step_result.state.position.norm() / AU;
                if (r_au < 0.1) r_au = 0.1;
            }
            double T_actual = thrust_config.solar_scaling
                ? thrust_config.thrust / (r_au * r_au)
                : thrust_config.thrust;
            double dm = T_actual / (thrust_config.isp * G0) * dt_used;
            mass = std::max(dry_mass_floor, mass - dm);
        }

        current = step_result.state;
        dt_try = step_result.dt_next;

        // Sample at uniform intervals
        if (sample_interval > 0.0 && t_elapsed >= next_sample) {
            result.push_back(current);
            next_sample += sample_interval;
        }

        step_count++;
    }

    // Always include final state
    if (sample_interval <= 0.0) {
        result.push_back(current);
    } else if (result.empty() || result.back().time != current.time) {
        result.push_back(current);
    }

    return result;
}

double LowThrustPropagator::propellant_consumed(const LowThrustConfig& config, double duration) {
    // Simple estimate assuming constant thrust at 1 AU
    double mdot = config.thrust / (config.isp * G0);
    return mdot * duration;
}

}  // namespace sim
