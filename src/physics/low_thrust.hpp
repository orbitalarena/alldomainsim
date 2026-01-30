/**
 * Low-Thrust Propulsion Model
 *
 * Solar electric propulsion (SEP) for interplanetary trajectory design.
 * Models thrust that varies with solar distance (power ∝ 1/r²),
 * specific impulse, propellant mass depletion, and configurable
 * thrust pointing directions.
 *
 * Designed to integrate with NBodyGravity and AdaptiveIntegrator:
 *   make_derivative_function() returns a lambda compatible with
 *   AdaptiveIntegrator::propagate().
 */

#ifndef SIM_LOW_THRUST_HPP
#define SIM_LOW_THRUST_HPP

#include "core/state_vector.hpp"
#include "nbody_gravity.hpp"
#include "propagators/adaptive_integrator.hpp"
#include <functional>
#include <vector>

namespace sim {

// -----------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------

/**
 * Low-thrust engine parameters
 */
struct LowThrustConfig {
    double thrust;          // Maximum thrust at 1 AU [N]
    double isp;             // Specific impulse [s]
    double mass_initial;    // Wet mass at start of segment [kg]
    double power_at_1au;    // Solar array power at 1 AU [W] (informational)
    bool solar_scaling;     // If true, thrust ∝ 1/r² (r in AU)

    // ── Presets ──

    /** Dawn spacecraft: NSTAR ion thruster */
    static LowThrustConfig dawn() {
        return LowThrustConfig{
            0.092,      // 92 mN max thrust
            3100.0,     // 3100 s Isp
            1217.7,     // Dawn wet mass [kg]
            10300.0,    // 10.3 kW solar array
            true
        };
    }

    /** Generic Hall-effect thruster (BHT-600 class) */
    static LowThrustConfig hall_thruster() {
        return LowThrustConfig{
            0.040,      // 40 mN
            1500.0,     // 1500 s Isp
            500.0,      // Generic 500 kg spacecraft
            1000.0,     // 1 kW
            true
        };
    }

    /** High-power SEP (e.g., AEPS / Advanced Electric Propulsion) */
    static LowThrustConfig high_power_sep() {
        return LowThrustConfig{
            0.600,      // 600 mN
            2600.0,     // 2600 s Isp
            5000.0,     // 5000 kg spacecraft
            50000.0,    // 50 kW solar array
            true
        };
    }
};

/**
 * Thrust pointing direction strategy
 */
enum class ThrustDirection {
    PROGRADE,           // Along velocity vector
    ANTI_VELOCITY,      // Opposite to velocity (braking)
    SUN_POINTING,       // Radially away from Sun
    ANTI_SUN,           // Radially toward Sun
    FIXED_INERTIAL,     // Fixed direction in HCI (set via custom_direction)
    CUSTOM              // User-supplied function (not yet implemented)
};

// -----------------------------------------------------------------
// Low-Thrust Propagator
// -----------------------------------------------------------------

class LowThrustPropagator {
public:
    /**
     * Compute thrust acceleration vector in HCI frame.
     *
     * Thrust magnitude:
     *   If solar_scaling: T_actual = T_max / r_au²  (r_au = |pos| / AU)
     *   Else:             T_actual = T_max
     *
     * Acceleration: a = T_actual / current_mass
     *
     * Direction is determined by ThrustDirection enum:
     *   PROGRADE:       along velocity vector
     *   ANTI_VELOCITY:  opposite velocity vector
     *   SUN_POINTING:   along position vector (radially outward from Sun)
     *   ANTI_SUN:       opposite position vector
     *   FIXED_INERTIAL: along config-specified direction
     *
     * @param state           Spacecraft state in HCI
     * @param config          Low-thrust engine parameters
     * @param direction       Pointing strategy
     * @param current_mass    Current spacecraft mass [kg]
     * @param custom_dir      Fixed direction unit vector (for FIXED_INERTIAL)
     * @return Thrust acceleration [m/s²] in HCI
     */
    static Vec3 compute_thrust_acceleration(
        const StateVector& state,
        const LowThrustConfig& config,
        ThrustDirection direction,
        double current_mass,
        const Vec3& custom_dir = Vec3(1, 0, 0));

    /**
     * Create a derivative function for AdaptiveIntegrator that includes
     * both N-body gravity and low-thrust acceleration.
     *
     * The mass_tracker reference is decremented each evaluation:
     *   dm/dt = -T / (Isp * g0)
     *
     * Returns a lambda with signature StateVector(const StateVector&) where:
     *   result.velocity        = input state.velocity   (dr/dt)
     *   result.angular_velocity = gravity + thrust accel (dv/dt)
     *   result.time            = 1.0                     (dt/dt)
     *
     * @param nbody_config    N-body gravity configuration
     * @param thrust_config   Low-thrust engine parameters
     * @param direction       Thrust pointing strategy
     * @param epoch_jd        Julian Date when state.time == 0
     * @param mass_tracker    Reference to mass variable (updated each call)
     * @param custom_dir      Fixed direction for FIXED_INERTIAL mode
     * @return Derivative function for AdaptiveIntegrator
     */
    static std::function<StateVector(const StateVector&)>
    make_derivative_function(
        const NBodyConfig& nbody_config,
        const LowThrustConfig& thrust_config,
        ThrustDirection direction,
        double epoch_jd,
        double& mass_tracker,
        const Vec3& custom_dir = Vec3(1, 0, 0));

    /**
     * Propagate a low-thrust trajectory segment.
     *
     * Combines N-body gravity with continuous thrust and propagates
     * using the adaptive Dormand-Prince integrator. Returns sampled
     * states at uniform intervals.
     *
     * @param initial         Initial spacecraft state in HCI
     * @param duration        Propagation duration [s]
     * @param nbody_config    N-body gravity configuration
     * @param thrust_config   Low-thrust engine parameters
     * @param direction       Thrust pointing strategy
     * @param int_config      Adaptive integrator settings
     * @param sample_interval Output sample spacing [s] (0 = final state only)
     * @return Vector of sampled HCI states
     */
    static std::vector<StateVector> propagate_segment(
        const StateVector& initial,
        double duration,
        const NBodyConfig& nbody_config,
        const LowThrustConfig& thrust_config,
        ThrustDirection direction,
        const AdaptiveConfig& int_config,
        double sample_interval = 86400.0);

    /**
     * Compute propellant mass consumed over a thrust duration.
     *   dm = T * dt / (Isp * g0)
     */
    static double propellant_consumed(const LowThrustConfig& config, double duration);

private:
    static constexpr double G0 = 9.80665;                      // Standard gravity [m/s²]
    static constexpr double AU = 149597870700.0;                // Astronomical unit [m]
};

}  // namespace sim

#endif  // SIM_LOW_THRUST_HPP
