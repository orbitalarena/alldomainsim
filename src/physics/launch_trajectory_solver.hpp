/**
 * Nonlinear Launch-to-Intercept/Rendezvous Trajectory Solver
 *
 * Newton-Raphson differential correction solver that computes optimal launch
 * parameters (azimuth, pitch/yaw steering polynomials) to deliver a rocket
 * from a rotating-Earth launch site to a target orbit or satellite.
 *
 * Dynamics: two-body + J2 gravity, atmospheric drag with Earth-relative
 * velocity, thrust with altitude-dependent Isp, mass depletion, staging.
 *
 * All propagation in ECI frame. Numerical Jacobian via finite differences.
 */

#ifndef LAUNCH_TRAJECTORY_SOLVER_HPP
#define LAUNCH_TRAJECTORY_SOLVER_HPP

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include <vector>
#include <string>

namespace sim {

// ============================================================
// Vehicle Configuration
// ============================================================

/**
 * Rocket stage for the trajectory solver.
 */
struct SolverRocketStage {
    double dry_mass;         // kg
    double propellant_mass;  // kg
    double thrust;           // N (vacuum reference)
    double isp_sl;           // s (sea level)
    double isp_vac;          // s (vacuum)

    /** Effective Isp interpolated between sea level and vacuum */
    double effective_isp(double altitude) const {
        double frac = altitude / 40000.0;
        if (frac > 1.0) frac = 1.0;
        if (frac < 0.0) frac = 0.0;
        return isp_sl + (isp_vac - isp_sl) * frac;
    }

    /** Mass flow rate at given altitude [kg/s] */
    double mass_flow_rate(double altitude) const {
        constexpr double G0 = 9.80665;
        return thrust / (effective_isp(altitude) * G0);
    }

    /** Approximate burn duration at average altitude [s] */
    double burn_duration(double avg_altitude) const {
        double mdot = mass_flow_rate(avg_altitude);
        return (mdot > 0.0) ? propellant_mass / mdot : 0.0;
    }
};

/**
 * Complete vehicle configuration: stages + aerodynamics + payload.
 */
struct SolverVehicleConfig {
    std::vector<SolverRocketStage> stages;
    double payload_mass;        // kg
    double drag_coefficient;    // Cd
    double reference_area;      // m^2

    /** Total vehicle mass (all stages + payload) */
    double total_mass() const {
        double m = payload_mass;
        for (const auto& s : stages) {
            m += s.dry_mass + s.propellant_mass;
        }
        return m;
    }

    /** Mass from stage_idx onward (including that stage's dry+prop + all later + payload) */
    double mass_from_stage(int stage_idx) const {
        double m = payload_mass;
        for (int i = stage_idx; i < (int)stages.size(); i++) {
            m += stages[i].dry_mass + stages[i].propellant_mass;
        }
        return m;
    }
};

// ============================================================
// Launch Site
// ============================================================

/**
 * Launch site with geodetic coordinates.
 */
struct LaunchSite {
    double latitude_deg;
    double longitude_deg;
    double altitude_m;

    /** Compute ECI position and velocity at given epoch (accounts for Earth rotation) */
    StateVector compute_eci_state(double epoch_jd) const;

    static LaunchSite cape_canaveral() {
        return {28.5623, -80.5774, 0.0};
    }

    static LaunchSite vandenberg() {
        return {34.7420, -120.5724, 0.0};
    }
};

// ============================================================
// Control Variables
// ============================================================

/**
 * Control vector for the trajectory solver.
 *
 * Parameterizes the complete ascent trajectory:
 * - Launch azimuth
 * - Pitch polynomial coefficients per stage: theta(tau) = p[0] + p[1]*tau + p[2]*tau^2
 *   where tau is normalized time within the segment [0,1]
 *   theta is pitch from vertical [rad]: 0=up, pi/2=horizontal
 * - Yaw polynomial per stage: psi(tau) = y[0] + y[1]*tau
 * - Coast time after burnout
 * - Launch epoch offset
 */
struct LaunchControls {
    double launch_azimuth;      // rad, clockwise from north

    double pitch_s1[3];         // Stage 1 pitch polynomial {p0, p1, p2}
    double pitch_s2[3];         // Stage 2 pitch polynomial {q0, q1, q2}

    double yaw_s1[2];           // Stage 1 yaw {y0, y1}
    double yaw_s2[2];           // Stage 2 yaw

    double coast_after_burnout; // s, coast time after S2 burnout
    double epoch_offset;        // s, launch time offset from nominal

    static constexpr int N_CONTROLS = 13;

    void to_array(double x[N_CONTROLS]) const;
    void from_array(const double x[N_CONTROLS]);

    /** Default initial guess for a standard gravity turn */
    static LaunchControls default_guess(double target_inclination_rad,
                                         double launch_latitude_rad);
};

// ============================================================
// Propagation State
// ============================================================

/**
 * Extended state for launch trajectory propagation.
 */
struct LaunchState {
    Vec3 position;         // ECI [m]
    Vec3 velocity;         // ECI [m/s]
    double mass;           // Current vehicle mass [kg]
    double time;           // Elapsed time from launch [s]
    int stage_index;       // Current stage (0-based)
    bool engines_on;       // Whether thrust is active

    // Derived quantities (updated during propagation)
    double altitude;       // Above WGS84 [m]
    double dynamic_pressure; // Pa

    // Fuel tracking
    double fuel_remaining[4]; // Propellant remaining per stage [kg] (up to 4 stages)
};

// ============================================================
// Targeting
// ============================================================

enum class TargetingMode {
    ORBIT_INSERTION,    // Match target orbital elements (a, e, i)
    POSITION_INTERCEPT, // Match target position at specified TOF
    FULL_RENDEZVOUS     // Match target position + velocity
};

/**
 * Terminal constraint specification.
 */
struct TerminalTarget {
    TargetingMode mode;

    // ORBIT_INSERTION: desired elements
    OrbitalElements target_elements;
    bool constrain_sma;    // default true
    bool constrain_ecc;    // default true
    bool constrain_inc;    // default true
    bool constrain_raan;   // default false
    bool constrain_argp;   // default false

    // POSITION_INTERCEPT / FULL_RENDEZVOUS: target satellite state at launch epoch
    StateVector target_state_epoch;
    double time_of_flight;     // Desired TOF from launch to intercept [s]

    // Tolerances
    double position_tol;   // m (default 1000)
    double velocity_tol;   // m/s (default 1.0)

    /** Number of active constraints */
    int num_constraints() const;

    TerminalTarget();
};

// ============================================================
// Solver Configuration
// ============================================================

struct LaunchSolverConfig {
    int max_iterations;
    double fd_step_size;         // Relative FD perturbation
    double convergence_tol;      // Residual norm threshold
    bool use_line_search;
    double line_search_alpha;    // Backtracking factor
    int line_search_max;         // Max backtracking steps
    double atmo_step_size;       // Integration step in atmosphere [s]
    double vacuum_step_size;     // Integration step in vacuum [s]
    bool verbose;

    // Which controls are free for optimization
    bool free_controls[LaunchControls::N_CONTROLS];

    int num_free_controls() const;

    LaunchSolverConfig();
};

// ============================================================
// Solution
// ============================================================

struct LaunchTrajectorySolution {
    bool converged;
    int iterations;
    double residual_norm;
    std::string status;

    LaunchControls controls;
    std::vector<LaunchState> trajectory;

    // Key events
    double stage_separation_time;
    double burnout_time;
    double total_delta_v;
    double gravity_losses;
    double drag_losses;

    // Terminal state
    LaunchState final_state;
    OrbitalElements final_elements;
    double final_position_error;
    double final_velocity_error;
};

// ============================================================
// Solver Class
// ============================================================

/**
 * Nonlinear launch-to-intercept trajectory solver.
 *
 * Uses Newton-Raphson with numerical Jacobian (finite differences) to solve
 * for launch control parameters that satisfy terminal constraints.
 */
class LaunchTrajectorySolver {
public:
    LaunchTrajectorySolver(const SolverVehicleConfig& vehicle,
                            const LaunchSite& site,
                            double epoch_jd,
                            const LaunchSolverConfig& config = LaunchSolverConfig());

    /** Solve the trajectory optimization problem */
    LaunchTrajectorySolution solve(const TerminalTarget& target,
                                    const LaunchControls* initial_guess = nullptr);

    /** Generate initial guess from Lambert solution */
    LaunchControls generate_initial_guess(const TerminalTarget& target) const;

    /** Propagate trajectory with given controls (no optimization) */
    LaunchTrajectorySolution propagate(const LaunchControls& controls,
                                        const TerminalTarget& target) const;

private:
    SolverVehicleConfig vehicle_;
    LaunchSite site_;
    double epoch_jd_;
    LaunchSolverConfig config_;

    // --- Propagation ---

    struct LaunchDerivatives {
        Vec3 acceleration;  // m/s^2 in ECI
        double mass_rate;   // kg/s (negative during burn)
    };

    /** Full trajectory propagation */
    LaunchState propagate_trajectory(const LaunchControls& controls,
                                      std::vector<LaunchState>* trajectory = nullptr) const;

    /** Single RK4 step for 7-element state (pos, vel, mass) */
    LaunchState rk4_step(const LaunchState& state,
                          const LaunchControls& controls,
                          double dt) const;

    /** Compute state derivatives */
    LaunchDerivatives compute_derivatives(const LaunchState& state,
                                           const LaunchControls& controls) const;

    // --- Steering ---

    /** Compute thrust direction unit vector in ECI */
    Vec3 compute_thrust_direction(const LaunchState& state,
                                   const LaunchControls& controls) const;

    /** Evaluate pitch and yaw from control polynomials */
    void evaluate_steering(const LaunchState& state,
                           const LaunchControls& controls,
                           double& pitch, double& yaw) const;

    // --- Targeting ---

    /** Compute residual vector for current state vs target */
    std::vector<double> compute_residuals(const LaunchState& final_state,
                                           const TerminalTarget& target) const;

    /** Compute numerical Jacobian via forward finite differences */
    void compute_jacobian(const LaunchControls& controls,
                           const TerminalTarget& target,
                           const std::vector<double>& residuals_nominal,
                           std::vector<std::vector<double>>& jacobian) const;

    /** Solve linear system J*dx = r (handles square, over/underdetermined) */
    std::vector<double> solve_linear_system(
        const std::vector<std::vector<double>>& J,
        const std::vector<double>& r,
        int num_rows, int num_cols,
        double damping = 1e-8) const;

    /** Apply correction to controls with optional scaling */
    void apply_correction(LaunchControls& controls,
                           const std::vector<double>& dx,
                           double alpha) const;

    // --- Target propagation ---

    /** Propagate target satellite under J2 gravity */
    StateVector propagate_target(const StateVector& target, double dt) const;

    // --- Utilities ---

    std::vector<double> pack_free_controls(const LaunchControls& controls) const;
    void unpack_free_controls(LaunchControls& controls,
                               const std::vector<double>& x) const;

    double eci_altitude(const Vec3& position) const;

    Vec3 earth_relative_velocity(const Vec3& position, const Vec3& velocity) const;
};

} // namespace sim

#endif // LAUNCH_TRAJECTORY_SOLVER_HPP
