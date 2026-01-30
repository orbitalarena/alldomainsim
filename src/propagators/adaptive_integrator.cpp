/**
 * Adaptive Integrator Implementation (Dormand-Prince 4(5))
 *
 * 7-stage embedded RK pair with FSAL property.
 * Step size is adjusted to maintain error within configured tolerances.
 * The error estimate comes from the difference between the 4th and 5th
 * order solutions computed from the same derivative evaluations.
 */

#include "adaptive_integrator.hpp"
#include <cmath>
#include <algorithm>
#include <stdexcept>

namespace sim {

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

StateVector AdaptiveIntegrator::add_states(const StateVector& base,
                                            const StateVector& deriv,
                                            double h) {
    StateVector result = base;
    result.position.x += h * deriv.velocity.x;
    result.position.y += h * deriv.velocity.y;
    result.position.z += h * deriv.velocity.z;
    result.velocity.x += h * deriv.angular_velocity.x;  // angular_velocity stores dv/dt
    result.velocity.y += h * deriv.angular_velocity.y;
    result.velocity.z += h * deriv.angular_velocity.z;
    return result;
}

double AdaptiveIntegrator::compute_error(const StateVector& y4, const StateVector& y5,
                                          const AdaptiveConfig& config) {
    // Error in position components (primary metric for orbit propagation)
    double scale_x = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.position.x), std::fabs(y5.position.x));
    double scale_y = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.position.y), std::fabs(y5.position.y));
    double scale_z = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.position.z), std::fabs(y5.position.z));

    double ex = (y5.position.x - y4.position.x) / scale_x;
    double ey = (y5.position.y - y4.position.y) / scale_y;
    double ez = (y5.position.z - y4.position.z) / scale_z;

    // Also include velocity error
    double vscale_x = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.velocity.x), std::fabs(y5.velocity.x));
    double vscale_y = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.velocity.y), std::fabs(y5.velocity.y));
    double vscale_z = config.abs_tolerance + config.rel_tolerance *
        std::max(std::fabs(y4.velocity.z), std::fabs(y5.velocity.z));

    double evx = (y5.velocity.x - y4.velocity.x) / vscale_x;
    double evy = (y5.velocity.y - y4.velocity.y) / vscale_y;
    double evz = (y5.velocity.z - y4.velocity.z) / vscale_z;

    // RMS error (6 components)
    return std::sqrt((ex*ex + ey*ey + ez*ez + evx*evx + evy*evy + evz*evz) / 6.0);
}

// ─────────────────────────────────────────────────────────────
// Single adaptive step
// ─────────────────────────────────────────────────────────────

IntegrationStep AdaptiveIntegrator::step(
    const StateVector& state,
    double dt_try,
    DerivativeFunction compute_derivatives,
    const AdaptiveConfig& config) {

    double h = dt_try;
    StateVector y = state;

    for (int attempts = 0; attempts < 100; ++attempts) {
        // Clamp step size
        h = std::max(h, config.dt_min);
        h = std::min(h, config.dt_max);

        // ── Stage 1 (evaluate at current state) ──
        StateVector k1 = compute_derivatives(y);

        // ── Stage 2 ──
        StateVector y2 = y;
        y2.position.x = y.position.x + h * a21 * k1.velocity.x;
        y2.position.y = y.position.y + h * a21 * k1.velocity.y;
        y2.position.z = y.position.z + h * a21 * k1.velocity.z;
        y2.velocity.x = y.velocity.x + h * a21 * k1.angular_velocity.x;
        y2.velocity.y = y.velocity.y + h * a21 * k1.angular_velocity.y;
        y2.velocity.z = y.velocity.z + h * a21 * k1.angular_velocity.z;
        y2.time = y.time + h * c2;
        StateVector k2 = compute_derivatives(y2);

        // ── Stage 3 ──
        StateVector y3 = y;
        y3.position.x = y.position.x + h * (a31 * k1.velocity.x + a32 * k2.velocity.x);
        y3.position.y = y.position.y + h * (a31 * k1.velocity.y + a32 * k2.velocity.y);
        y3.position.z = y.position.z + h * (a31 * k1.velocity.z + a32 * k2.velocity.z);
        y3.velocity.x = y.velocity.x + h * (a31 * k1.angular_velocity.x + a32 * k2.angular_velocity.x);
        y3.velocity.y = y.velocity.y + h * (a31 * k1.angular_velocity.y + a32 * k2.angular_velocity.y);
        y3.velocity.z = y.velocity.z + h * (a31 * k1.angular_velocity.z + a32 * k2.angular_velocity.z);
        y3.time = y.time + h * c3;
        StateVector k3 = compute_derivatives(y3);

        // ── Stage 4 ──
        StateVector y4s = y;
        y4s.position.x = y.position.x + h * (a41 * k1.velocity.x + a42 * k2.velocity.x + a43 * k3.velocity.x);
        y4s.position.y = y.position.y + h * (a41 * k1.velocity.y + a42 * k2.velocity.y + a43 * k3.velocity.y);
        y4s.position.z = y.position.z + h * (a41 * k1.velocity.z + a42 * k2.velocity.z + a43 * k3.velocity.z);
        y4s.velocity.x = y.velocity.x + h * (a41 * k1.angular_velocity.x + a42 * k2.angular_velocity.x + a43 * k3.angular_velocity.x);
        y4s.velocity.y = y.velocity.y + h * (a41 * k1.angular_velocity.y + a42 * k2.angular_velocity.y + a43 * k3.angular_velocity.y);
        y4s.velocity.z = y.velocity.z + h * (a41 * k1.angular_velocity.z + a42 * k2.angular_velocity.z + a43 * k3.angular_velocity.z);
        y4s.time = y.time + h * c4;
        StateVector k4 = compute_derivatives(y4s);

        // ── Stage 5 ──
        StateVector y5s = y;
        y5s.position.x = y.position.x + h * (a51*k1.velocity.x + a52*k2.velocity.x + a53*k3.velocity.x + a54*k4.velocity.x);
        y5s.position.y = y.position.y + h * (a51*k1.velocity.y + a52*k2.velocity.y + a53*k3.velocity.y + a54*k4.velocity.y);
        y5s.position.z = y.position.z + h * (a51*k1.velocity.z + a52*k2.velocity.z + a53*k3.velocity.z + a54*k4.velocity.z);
        y5s.velocity.x = y.velocity.x + h * (a51*k1.angular_velocity.x + a52*k2.angular_velocity.x + a53*k3.angular_velocity.x + a54*k4.angular_velocity.x);
        y5s.velocity.y = y.velocity.y + h * (a51*k1.angular_velocity.y + a52*k2.angular_velocity.y + a53*k3.angular_velocity.y + a54*k4.angular_velocity.y);
        y5s.velocity.z = y.velocity.z + h * (a51*k1.angular_velocity.z + a52*k2.angular_velocity.z + a53*k3.angular_velocity.z + a54*k4.angular_velocity.z);
        y5s.time = y.time + h * c5;
        StateVector k5 = compute_derivatives(y5s);

        // ── Stage 6 ──
        StateVector y6s = y;
        y6s.position.x = y.position.x + h * (a61*k1.velocity.x + a62*k2.velocity.x + a63*k3.velocity.x + a64*k4.velocity.x + a65*k5.velocity.x);
        y6s.position.y = y.position.y + h * (a61*k1.velocity.y + a62*k2.velocity.y + a63*k3.velocity.y + a64*k4.velocity.y + a65*k5.velocity.y);
        y6s.position.z = y.position.z + h * (a61*k1.velocity.z + a62*k2.velocity.z + a63*k3.velocity.z + a64*k4.velocity.z + a65*k5.velocity.z);
        y6s.velocity.x = y.velocity.x + h * (a61*k1.angular_velocity.x + a62*k2.angular_velocity.x + a63*k3.angular_velocity.x + a64*k4.angular_velocity.x + a65*k5.angular_velocity.x);
        y6s.velocity.y = y.velocity.y + h * (a61*k1.angular_velocity.y + a62*k2.angular_velocity.y + a63*k3.angular_velocity.y + a64*k4.angular_velocity.y + a65*k5.angular_velocity.y);
        y6s.velocity.z = y.velocity.z + h * (a61*k1.angular_velocity.z + a62*k2.angular_velocity.z + a63*k3.angular_velocity.z + a64*k4.angular_velocity.z + a65*k5.angular_velocity.z);
        y6s.time = y.time + h;
        StateVector k6 = compute_derivatives(y6s);

        // ── 5th order solution (y_5) ──
        StateVector y5_result = y;
        y5_result.position.x = y.position.x + h * (b1*k1.velocity.x + b3*k3.velocity.x + b4*k4.velocity.x + b5*k5.velocity.x + b6*k6.velocity.x);
        y5_result.position.y = y.position.y + h * (b1*k1.velocity.y + b3*k3.velocity.y + b4*k4.velocity.y + b5*k5.velocity.y + b6*k6.velocity.y);
        y5_result.position.z = y.position.z + h * (b1*k1.velocity.z + b3*k3.velocity.z + b4*k4.velocity.z + b5*k5.velocity.z + b6*k6.velocity.z);
        y5_result.velocity.x = y.velocity.x + h * (b1*k1.angular_velocity.x + b3*k3.angular_velocity.x + b4*k4.angular_velocity.x + b5*k5.angular_velocity.x + b6*k6.angular_velocity.x);
        y5_result.velocity.y = y.velocity.y + h * (b1*k1.angular_velocity.y + b3*k3.angular_velocity.y + b4*k4.angular_velocity.y + b5*k5.angular_velocity.y + b6*k6.angular_velocity.y);
        y5_result.velocity.z = y.velocity.z + h * (b1*k1.angular_velocity.z + b3*k3.angular_velocity.z + b4*k4.angular_velocity.z + b5*k5.angular_velocity.z + b6*k6.angular_velocity.z);
        y5_result.time = y.time + h;

        // ── Stage 7 (FSAL: k7 = f(y5_result), reused as k1 of next step) ──
        StateVector k7 = compute_derivatives(y5_result);

        // ── 4th order solution (y_4) for error estimate ──
        StateVector y4_result = y;
        y4_result.position.x = y.position.x + h * (bs1*k1.velocity.x + bs3*k3.velocity.x + bs4*k4.velocity.x + bs5*k5.velocity.x + bs6*k6.velocity.x + bs7*k7.velocity.x);
        y4_result.position.y = y.position.y + h * (bs1*k1.velocity.y + bs3*k3.velocity.y + bs4*k4.velocity.y + bs5*k5.velocity.y + bs6*k6.velocity.y + bs7*k7.velocity.y);
        y4_result.position.z = y.position.z + h * (bs1*k1.velocity.z + bs3*k3.velocity.z + bs4*k4.velocity.z + bs5*k5.velocity.z + bs6*k6.velocity.z + bs7*k7.velocity.z);
        y4_result.velocity.x = y.velocity.x + h * (bs1*k1.angular_velocity.x + bs3*k3.angular_velocity.x + bs4*k4.angular_velocity.x + bs5*k5.angular_velocity.x + bs6*k6.angular_velocity.x + bs7*k7.angular_velocity.x);
        y4_result.velocity.y = y.velocity.y + h * (bs1*k1.angular_velocity.y + bs3*k3.angular_velocity.y + bs4*k4.angular_velocity.y + bs5*k5.angular_velocity.y + bs6*k6.angular_velocity.y + bs7*k7.angular_velocity.y);
        y4_result.velocity.z = y.velocity.z + h * (bs1*k1.angular_velocity.z + bs3*k3.angular_velocity.z + bs4*k4.angular_velocity.z + bs5*k5.angular_velocity.z + bs6*k6.angular_velocity.z + bs7*k7.angular_velocity.z);

        // ── Error estimate ──
        double error = compute_error(y4_result, y5_result, config);

        if (error <= 1.0) {
            // Step accepted — compute next step size
            double dt_next;
            if (error < 1e-30) {
                dt_next = h * 5.0;  // Error negligible, grow aggressively
            } else {
                // Optimal step factor for 5th order method: (1/error)^(1/5)
                dt_next = h * config.safety_factor * std::pow(1.0 / error, 0.2);
            }
            dt_next = std::min(dt_next, config.dt_max);
            dt_next = std::max(dt_next, config.dt_min);

            // Don't grow more than 5x per step
            dt_next = std::min(dt_next, h * 5.0);

            return IntegrationStep{y5_result, h, dt_next, error};
        }

        // Step rejected — reduce step size and retry
        double factor = config.safety_factor * std::pow(1.0 / error, 0.25);
        factor = std::max(factor, 0.1);  // Don't shrink more than 10x
        h *= factor;

        if (h < config.dt_min) {
            // Step size underflow — accept with minimum step
            y5_result.time = y.time + config.dt_min;
            return IntegrationStep{y5_result, config.dt_min, config.dt_min, error};
        }
    }

    // Should not reach here
    return IntegrationStep{state, dt_try, dt_try, 1e10};
}

// ─────────────────────────────────────────────────────────────
// Propagation routines
// ─────────────────────────────────────────────────────────────

std::vector<StateVector> AdaptiveIntegrator::propagate(
    const StateVector& initial,
    double duration,
    DerivativeFunction compute_derivatives,
    const AdaptiveConfig& config,
    double sample_interval) {

    std::vector<StateVector> trajectory;
    StateVector current = initial;
    double t_end = initial.time + duration;
    double dt = std::min(duration * 0.001, config.dt_max);  // Initial step guess
    dt = std::max(dt, config.dt_min);

    double next_sample = initial.time;
    if (sample_interval > 0.0) {
        trajectory.push_back(initial);
        next_sample += sample_interval;
    }

    int step_count = 0;
    while (current.time < t_end && step_count < config.max_steps) {
        // Don't overshoot end time
        double dt_try = std::min(dt, t_end - current.time);
        if (dt_try < 1e-10) break;

        auto result = step(current, dt_try, compute_derivatives, config);
        current = result.state;
        dt = result.dt_next;
        step_count++;

        // Sample at uniform intervals
        if (sample_interval > 0.0) {
            while (next_sample <= current.time && next_sample <= t_end) {
                trajectory.push_back(current);  // Nearest-neighbor for now
                next_sample += sample_interval;
            }
        }
    }

    // Always include final state
    if (sample_interval > 0.0) {
        if (trajectory.empty() || trajectory.back().time < current.time) {
            trajectory.push_back(current);
        }
    } else {
        trajectory.push_back(current);
    }

    return trajectory;
}

StateVector AdaptiveIntegrator::propagate_until(
    const StateVector& initial,
    DerivativeFunction compute_derivatives,
    std::function<bool(const StateVector&)> stop_condition,
    const AdaptiveConfig& config,
    double max_duration) {

    StateVector current = initial;
    double t_end = initial.time + max_duration;
    double dt = std::min(max_duration * 0.001, config.dt_max);
    dt = std::max(dt, config.dt_min);

    int step_count = 0;
    while (current.time < t_end && step_count < config.max_steps) {
        double dt_try = std::min(dt, t_end - current.time);
        if (dt_try < 1e-10) break;

        auto result = step(current, dt_try, compute_derivatives, config);
        current = result.state;
        dt = result.dt_next;
        step_count++;

        if (stop_condition(current)) {
            return current;
        }
    }

    return current;
}

}  // namespace sim
