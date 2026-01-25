#ifndef NONLINEAR_RENDEZVOUS_HPP
#define NONLINEAR_RENDEZVOUS_HPP

#include "core/state_vector.hpp"
#include <vector>
#include <functional>
#include <array>
#include <string>

namespace sim {

/**
 * @brief 6x6 State Transition Matrix
 */
struct STM {
    std::array<std::array<double, 6>, 6> data;

    STM() {
        // Initialize to identity
        for (int i = 0; i < 6; i++) {
            for (int j = 0; j < 6; j++) {
                data[i][j] = (i == j) ? 1.0 : 0.0;
            }
        }
    }

    double& operator()(int i, int j) { return data[i][j]; }
    double operator()(int i, int j) const { return data[i][j]; }
};

/**
 * @brief Extended state: position, velocity, and 6x6 STM (42 elements total)
 */
struct ExtendedState {
    StateVector state;
    STM phi;  // State transition matrix
};

/**
 * @brief Maneuver definition
 */
struct Maneuver {
    double epoch;           // Burn time [s]
    Vec3 delta_v;          // Impulsive delta-V [m/s]
    bool is_free_epoch;    // True if epoch is a free variable
    bool is_free_dv;       // True if delta-V components are free
};

/**
 * @brief Terminal constraints
 */
struct TerminalConstraints {
    bool constrain_position;    // Match target position
    bool constrain_velocity;    // Match target velocity (full rendezvous)
    double position_tol;        // Position tolerance [m]
    double velocity_tol;        // Velocity tolerance [m/s]
};

/**
 * @brief Solution result
 */
struct RendezvousSolution {
    std::vector<Maneuver> maneuvers;
    double total_delta_v;
    int iterations;
    double final_position_error;
    double final_velocity_error;
    bool converged;
    std::string status;

    // Trajectory for visualization
    std::vector<StateVector> trajectory;
};

/**
 * @brief Force model configuration
 */
struct ForceModelConfig {
    double mu;              // Gravitational parameter
    bool include_j2;        // Include J2 perturbation
    double j2;              // J2 coefficient
    double body_radius;     // Central body radius

    ForceModelConfig() : mu(3.986004418e14), include_j2(false),
                         j2(1.08263e-3), body_radius(6378137.0) {}
};

/**
 * @brief Solver configuration
 */
struct SolverConfig {
    int max_iterations;
    double position_tol;        // meters
    double velocity_tol;        // m/s
    double step_size;           // Integration step [s]
    bool use_line_search;       // Damped Newton
    double line_search_alpha;   // Step size reduction factor
    bool verbose;

    SolverConfig() : max_iterations(50), position_tol(1.0), velocity_tol(0.01),
                     step_size(60.0), use_line_search(true),
                     line_search_alpha(0.5), verbose(false) {}  // 50 iterations default
};

/**
 * @brief Nonlinear Rendezvous Solver
 *
 * Solves spacecraft intercept/rendezvous using differential correction
 * (Newton-Raphson shooting) under full nonlinear dynamics.
 */
class NonlinearRendezvousSolver {
public:
    NonlinearRendezvousSolver(const ForceModelConfig& force_config = ForceModelConfig(),
                               const SolverConfig& solver_config = SolverConfig());

    /**
     * @brief Solve single-impulse intercept problem
     *
     * Find delta-V at t=0 to reach target position at t=tof
     *
     * @param chaser Initial chaser state
     * @param target Initial target state
     * @param tof Time of flight [s]
     * @param match_velocity If true, also match target velocity
     * @param initial_guess Optional initial delta-V guess
     * @return Solution with converged maneuver
     */
    RendezvousSolution solve_single_impulse(
        const StateVector& chaser,
        const StateVector& target,
        double tof,
        bool match_velocity = false,
        const Vec3* initial_guess = nullptr);

    /**
     * @brief Solve two-impulse rendezvous
     *
     * First burn at t=0, second burn at t=tof to match velocity
     *
     * @param chaser Initial chaser state
     * @param target Initial target state
     * @param tof Time of flight [s]
     * @return Solution with two maneuvers
     */
    RendezvousSolution solve_two_impulse(
        const StateVector& chaser,
        const StateVector& target,
        double tof);

    /**
     * @brief Generate initial guess using CW equations
     */
    Vec3 cw_initial_guess(const StateVector& chaser, const StateVector& target, double tof);

private:
    ForceModelConfig force_config_;
    SolverConfig solver_config_;

    /**
     * @brief Compute acceleration (force model)
     */
    Vec3 compute_acceleration(const Vec3& pos) const;

    /**
     * @brief Compute gravity gradient matrix (for STM propagation)
     */
    void compute_gravity_gradient(const Vec3& pos, double G[3][3]) const;

    /**
     * @brief Propagate state and STM together
     */
    ExtendedState propagate_with_stm(const StateVector& state, double dt) const;

    /**
     * @brief Single RK4 step for extended state
     */
    ExtendedState rk4_step_extended(const ExtendedState& es, double dt) const;

    /**
     * @brief Compute constraint residuals
     */
    std::vector<double> compute_residuals(
        const StateVector& final_chaser,
        const StateVector& final_target,
        bool match_velocity) const;

    /**
     * @brief Extract Jacobian from STM for the constraint mapping
     */
    std::vector<std::vector<double>> extract_jacobian(
        const STM& phi, bool match_velocity) const;

    /**
     * @brief Solve linear system (Jacobian \ residuals)
     */
    std::vector<double> solve_linear_system(
        const std::vector<std::vector<double>>& J,
        const std::vector<double>& r) const;

    /**
     * @brief Propagate target to future time
     */
    StateVector propagate_target(const StateVector& target, double dt) const;
};

} // namespace sim

#endif // NONLINEAR_RENDEZVOUS_HPP
