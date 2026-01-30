/**
 * Adaptive Step-Size Integrator (Dormand-Prince 4(5))
 *
 * Embedded Runge-Kutta pair for automatic step-size control.
 * Uses FSAL (First Same As Last) property for efficiency:
 * only 6 derivative evaluations per step instead of 7.
 *
 * Ideal for interplanetary trajectories where the natural time scale
 * varies from seconds (planetary flyby) to days (heliocentric cruise).
 */

#ifndef SIM_ADAPTIVE_INTEGRATOR_HPP
#define SIM_ADAPTIVE_INTEGRATOR_HPP

#include "core/state_vector.hpp"
#include <functional>
#include <vector>

namespace sim {

/// Result of a single adaptive step
struct IntegrationStep {
    StateVector state;
    double dt_used;         // Actual step size taken [s]
    double dt_next;         // Suggested next step size [s]
    double error_estimate;  // Relative error of this step
};

/// Configuration for adaptive integration
struct AdaptiveConfig {
    double dt_min = 0.1;           // Minimum step size [s]
    double dt_max = 86400.0;       // Maximum step size [s] (1 day)
    double abs_tolerance = 1.0;    // Absolute tolerance [m] for position
    double rel_tolerance = 1e-10;  // Relative tolerance
    double safety_factor = 0.9;    // Step size safety factor
    int max_steps = 1000000;       // Max steps before aborting

    // Presets
    static AdaptiveConfig interplanetary() {
        return AdaptiveConfig{1.0, 86400.0 * 7, 100.0, 1e-8, 0.9, 2000000};
    }
    static AdaptiveConfig flyby() {
        return AdaptiveConfig{0.01, 3600.0, 0.1, 1e-12, 0.9, 5000000};
    }
    static AdaptiveConfig earth_orbit() {
        return AdaptiveConfig{0.1, 600.0, 1.0, 1e-10, 0.9, 1000000};
    }
};

/// Dormand-Prince 4(5) adaptive integrator
class AdaptiveIntegrator {
public:
    using DerivativeFunction = std::function<StateVector(const StateVector&)>;

    /**
     * Single adaptive step: attempts dt_try, may reduce if error too large.
     * Returns the step result with the actual dt used and suggested next dt.
     */
    static IntegrationStep step(
        const StateVector& state,
        double dt_try,
        DerivativeFunction compute_derivatives,
        const AdaptiveConfig& config);

    /**
     * Propagate from initial state for given duration.
     * If sample_interval > 0, returns states at uniform intervals (interpolated).
     * If sample_interval == 0, returns only the final state.
     */
    static std::vector<StateVector> propagate(
        const StateVector& initial,
        double duration,
        DerivativeFunction compute_derivatives,
        const AdaptiveConfig& config,
        double sample_interval = 0.0);

    /**
     * Propagate until a stop condition is met.
     * Returns the state at which stop_condition returned true.
     */
    static StateVector propagate_until(
        const StateVector& initial,
        DerivativeFunction compute_derivatives,
        std::function<bool(const StateVector&)> stop_condition,
        const AdaptiveConfig& config,
        double max_duration = 365.25 * 86400.0);

private:
    // ── Dormand-Prince coefficients (Butcher tableau) ──
    // 7-stage embedded pair, FSAL property

    // Time fractions
    static constexpr double c2 = 1.0/5.0;
    static constexpr double c3 = 3.0/10.0;
    static constexpr double c4 = 4.0/5.0;
    static constexpr double c5 = 8.0/9.0;
    // c6 = 1, c7 = 1

    // Stage coefficients (a_ij)
    static constexpr double a21 = 1.0/5.0;
    static constexpr double a31 = 3.0/40.0;
    static constexpr double a32 = 9.0/40.0;
    static constexpr double a41 = 44.0/45.0;
    static constexpr double a42 = -56.0/15.0;
    static constexpr double a43 = 32.0/9.0;
    static constexpr double a51 = 19372.0/6561.0;
    static constexpr double a52 = -25360.0/2187.0;
    static constexpr double a53 = 64448.0/6561.0;
    static constexpr double a54 = -212.0/729.0;
    static constexpr double a61 = 9017.0/3168.0;
    static constexpr double a62 = -355.0/33.0;
    static constexpr double a63 = 46732.0/5247.0;
    static constexpr double a64 = 49.0/176.0;
    static constexpr double a65 = -5103.0/18656.0;
    static constexpr double a71 = 35.0/384.0;
    // a72 = 0
    static constexpr double a73 = 500.0/1113.0;
    static constexpr double a74 = 125.0/192.0;
    static constexpr double a75 = -2187.0/6784.0;
    static constexpr double a76 = 11.0/84.0;

    // 5th order weights (b_i) — same as a7i (FSAL)
    static constexpr double b1 = 35.0/384.0;
    // b2 = 0
    static constexpr double b3 = 500.0/1113.0;
    static constexpr double b4 = 125.0/192.0;
    static constexpr double b5 = -2187.0/6784.0;
    static constexpr double b6 = 11.0/84.0;
    // b7 = 0

    // 4th order weights for error estimate (b*_i)
    static constexpr double bs1 = 5179.0/57600.0;
    // bs2 = 0
    static constexpr double bs3 = 7571.0/16695.0;
    static constexpr double bs4 = 393.0/640.0;
    static constexpr double bs5 = -92097.0/339200.0;
    static constexpr double bs6 = 187.0/2100.0;
    static constexpr double bs7 = 1.0/40.0;

    // Error coefficients: e_i = b_i - b*_i
    static constexpr double e1 = b1 - bs1;   // 71/57600
    static constexpr double e3 = b3 - bs3;   // -71/16695
    static constexpr double e4 = b4 - bs4;   // 71/1920
    static constexpr double e5 = b5 - bs5;   // -17253/339200
    static constexpr double e6 = b6 - bs6;   // 22/525
    static constexpr double e7 = -bs7;        // -1/40

    // Helper: add scaled state vectors
    static StateVector add_states(const StateVector& base,
                                   const StateVector& deriv,
                                   double scale);

    // Helper: estimate error from two solutions
    static double compute_error(const StateVector& y4, const StateVector& y5,
                                 const AdaptiveConfig& config);
};

}  // namespace sim

#endif  // SIM_ADAPTIVE_INTEGRATOR_HPP
