#include "physics/nonlinear_rendezvous.hpp"
#include <cmath>
#include <iostream>
#include <iomanip>
#include <algorithm>

namespace sim {

constexpr double PI = 3.14159265358979323846;

NonlinearRendezvousSolver::NonlinearRendezvousSolver(
    const ForceModelConfig& force_config,
    const SolverConfig& solver_config)
    : force_config_(force_config), solver_config_(solver_config) {}

Vec3 NonlinearRendezvousSolver::compute_acceleration(const Vec3& pos) const {
    double r = pos.norm();
    double r3 = r * r * r;

    Vec3 acc;
    // Two-body gravity
    acc.x = -force_config_.mu * pos.x / r3;
    acc.y = -force_config_.mu * pos.y / r3;
    acc.z = -force_config_.mu * pos.z / r3;

    // J2 perturbation
    if (force_config_.include_j2) {
        double r2 = r * r;
        double r5 = r2 * r3;
        double Re2 = force_config_.body_radius * force_config_.body_radius;
        double z2 = pos.z * pos.z;
        double factor = 1.5 * force_config_.j2 * force_config_.mu * Re2 / r5;

        acc.x += factor * pos.x * (5.0 * z2 / r2 - 1.0);
        acc.y += factor * pos.y * (5.0 * z2 / r2 - 1.0);
        acc.z += factor * pos.z * (5.0 * z2 / r2 - 3.0);
    }

    return acc;
}

void NonlinearRendezvousSolver::compute_gravity_gradient(const Vec3& pos, double G[3][3]) const {
    double r = pos.norm();
    double r2 = r * r;
    double r3 = r2 * r;
    double r5 = r2 * r3;
    double mu = force_config_.mu;

    // Gradient of two-body gravity: G_ij = -mu/r^3 * (delta_ij - 3*r_i*r_j/r^2)
    G[0][0] = -mu / r3 * (1.0 - 3.0 * pos.x * pos.x / r2);
    G[0][1] = -mu / r3 * (-3.0 * pos.x * pos.y / r2);
    G[0][2] = -mu / r3 * (-3.0 * pos.x * pos.z / r2);
    G[1][0] = G[0][1];
    G[1][1] = -mu / r3 * (1.0 - 3.0 * pos.y * pos.y / r2);
    G[1][2] = -mu / r3 * (-3.0 * pos.y * pos.z / r2);
    G[2][0] = G[0][2];
    G[2][1] = G[1][2];
    G[2][2] = -mu / r3 * (1.0 - 3.0 * pos.z * pos.z / r2);

    // J2 contribution to gradient would go here for higher fidelity
    // (omitted for clarity - adds significant complexity)
}

ExtendedState NonlinearRendezvousSolver::rk4_step_extended(const ExtendedState& es, double dt) const {
    // State vector: [x, y, z, vx, vy, vz]
    // STM derivative: Phi_dot = A * Phi where A = [0, I; G, 0]

    auto compute_derivatives = [this](const ExtendedState& s) {
        ExtendedState deriv;

        // State derivatives
        deriv.state.position = s.state.velocity;
        Vec3 acc = compute_acceleration(s.state.position);
        deriv.state.velocity = acc;

        // Gravity gradient for STM
        double G[3][3];
        compute_gravity_gradient(s.state.position, G);

        // STM derivative: Phi_dot = A * Phi
        // A = [0(3x3), I(3x3)]
        //     [G(3x3), 0(3x3)]
        for (int i = 0; i < 6; i++) {
            for (int j = 0; j < 6; j++) {
                double sum = 0.0;
                for (int k = 0; k < 6; k++) {
                    // A matrix elements
                    double A_ik = 0.0;
                    if (i < 3 && k >= 3 && k - 3 == i) A_ik = 1.0;  // Upper right identity
                    if (i >= 3 && k < 3) A_ik = G[i-3][k];          // Lower left gravity gradient

                    sum += A_ik * s.phi(k, j);
                }
                deriv.phi(i, j) = sum;
            }
        }

        return deriv;
    };

    auto add_states = [](const ExtendedState& a, const ExtendedState& b, double scale) {
        ExtendedState result;
        result.state.position.x = a.state.position.x + scale * b.state.position.x;
        result.state.position.y = a.state.position.y + scale * b.state.position.y;
        result.state.position.z = a.state.position.z + scale * b.state.position.z;
        result.state.velocity.x = a.state.velocity.x + scale * b.state.velocity.x;
        result.state.velocity.y = a.state.velocity.y + scale * b.state.velocity.y;
        result.state.velocity.z = a.state.velocity.z + scale * b.state.velocity.z;
        for (int i = 0; i < 6; i++) {
            for (int j = 0; j < 6; j++) {
                result.phi(i, j) = a.phi(i, j) + scale * b.phi(i, j);
            }
        }
        return result;
    };

    // RK4 stages
    ExtendedState k1 = compute_derivatives(es);
    ExtendedState s2 = add_states(es, k1, 0.5 * dt);
    ExtendedState k2 = compute_derivatives(s2);
    ExtendedState s3 = add_states(es, k2, 0.5 * dt);
    ExtendedState k3 = compute_derivatives(s3);
    ExtendedState s4 = add_states(es, k3, dt);
    ExtendedState k4 = compute_derivatives(s4);

    // Combine
    ExtendedState result;
    result.state.position.x = es.state.position.x + dt/6.0 * (k1.state.position.x + 2*k2.state.position.x + 2*k3.state.position.x + k4.state.position.x);
    result.state.position.y = es.state.position.y + dt/6.0 * (k1.state.position.y + 2*k2.state.position.y + 2*k3.state.position.y + k4.state.position.y);
    result.state.position.z = es.state.position.z + dt/6.0 * (k1.state.position.z + 2*k2.state.position.z + 2*k3.state.position.z + k4.state.position.z);
    result.state.velocity.x = es.state.velocity.x + dt/6.0 * (k1.state.velocity.x + 2*k2.state.velocity.x + 2*k3.state.velocity.x + k4.state.velocity.x);
    result.state.velocity.y = es.state.velocity.y + dt/6.0 * (k1.state.velocity.y + 2*k2.state.velocity.y + 2*k3.state.velocity.y + k4.state.velocity.y);
    result.state.velocity.z = es.state.velocity.z + dt/6.0 * (k1.state.velocity.z + 2*k2.state.velocity.z + 2*k3.state.velocity.z + k4.state.velocity.z);

    for (int i = 0; i < 6; i++) {
        for (int j = 0; j < 6; j++) {
            result.phi(i, j) = es.phi(i, j) + dt/6.0 * (k1.phi(i, j) + 2*k2.phi(i, j) + 2*k3.phi(i, j) + k4.phi(i, j));
        }
    }

    result.state.time = es.state.time + dt;
    return result;
}

ExtendedState NonlinearRendezvousSolver::propagate_with_stm(const StateVector& state, double total_dt) const {
    ExtendedState es;
    es.state = state;
    // STM initialized to identity in constructor

    double dt = solver_config_.step_size;
    double t = 0.0;

    while (t < total_dt) {
        double step = std::min(dt, total_dt - t);
        es = rk4_step_extended(es, step);
        t += step;
    }

    return es;
}

StateVector NonlinearRendezvousSolver::propagate_target(const StateVector& target, double total_dt) const {
    StateVector state = target;
    double dt = solver_config_.step_size;
    double t = 0.0;

    while (t < total_dt) {
        double step = std::min(dt, total_dt - t);

        // RK4 for state only
        auto deriv = [this](const StateVector& s) {
            StateVector d;
            d.position = s.velocity;
            d.velocity = compute_acceleration(s.position);
            return d;
        };

        StateVector k1 = deriv(state);
        StateVector s2; s2.position.x = state.position.x + 0.5*step*k1.position.x;
                        s2.position.y = state.position.y + 0.5*step*k1.position.y;
                        s2.position.z = state.position.z + 0.5*step*k1.position.z;
                        s2.velocity.x = state.velocity.x + 0.5*step*k1.velocity.x;
                        s2.velocity.y = state.velocity.y + 0.5*step*k1.velocity.y;
                        s2.velocity.z = state.velocity.z + 0.5*step*k1.velocity.z;
        StateVector k2 = deriv(s2);
        StateVector s3; s3.position.x = state.position.x + 0.5*step*k2.position.x;
                        s3.position.y = state.position.y + 0.5*step*k2.position.y;
                        s3.position.z = state.position.z + 0.5*step*k2.position.z;
                        s3.velocity.x = state.velocity.x + 0.5*step*k2.velocity.x;
                        s3.velocity.y = state.velocity.y + 0.5*step*k2.velocity.y;
                        s3.velocity.z = state.velocity.z + 0.5*step*k2.velocity.z;
        StateVector k3 = deriv(s3);
        StateVector s4; s4.position.x = state.position.x + step*k3.position.x;
                        s4.position.y = state.position.y + step*k3.position.y;
                        s4.position.z = state.position.z + step*k3.position.z;
                        s4.velocity.x = state.velocity.x + step*k3.velocity.x;
                        s4.velocity.y = state.velocity.y + step*k3.velocity.y;
                        s4.velocity.z = state.velocity.z + step*k3.velocity.z;
        StateVector k4 = deriv(s4);

        state.position.x += step/6.0 * (k1.position.x + 2*k2.position.x + 2*k3.position.x + k4.position.x);
        state.position.y += step/6.0 * (k1.position.y + 2*k2.position.y + 2*k3.position.y + k4.position.y);
        state.position.z += step/6.0 * (k1.position.z + 2*k2.position.z + 2*k3.position.z + k4.position.z);
        state.velocity.x += step/6.0 * (k1.velocity.x + 2*k2.velocity.x + 2*k3.velocity.x + k4.velocity.x);
        state.velocity.y += step/6.0 * (k1.velocity.y + 2*k2.velocity.y + 2*k3.velocity.y + k4.velocity.y);
        state.velocity.z += step/6.0 * (k1.velocity.z + 2*k2.velocity.z + 2*k3.velocity.z + k4.velocity.z);

        t += step;
    }

    state.time = target.time + total_dt;
    return state;
}

std::vector<double> NonlinearRendezvousSolver::compute_residuals(
    const StateVector& final_chaser,
    const StateVector& final_target,
    bool match_velocity) const {

    std::vector<double> r;

    // Position residuals
    r.push_back(final_chaser.position.x - final_target.position.x);
    r.push_back(final_chaser.position.y - final_target.position.y);
    r.push_back(final_chaser.position.z - final_target.position.z);

    // Velocity residuals (optional)
    if (match_velocity) {
        r.push_back(final_chaser.velocity.x - final_target.velocity.x);
        r.push_back(final_chaser.velocity.y - final_target.velocity.y);
        r.push_back(final_chaser.velocity.z - final_target.velocity.z);
    }

    return r;
}

std::vector<std::vector<double>> NonlinearRendezvousSolver::extract_jacobian(
    const STM& phi, bool match_velocity) const {

    // For single impulse at t=0, control variables are delta-V components (dv_x, dv_y, dv_z)
    // Jacobian maps d(dv) to d(final_state)
    // From STM: d(r_f)/d(v_0) = Phi_rv (upper right 3x3 of STM columns 3-5, rows 0-2)
    //           d(v_f)/d(v_0) = Phi_vv (lower right 3x3 of STM columns 3-5, rows 3-5)

    int n_constraints = match_velocity ? 6 : 3;
    int n_controls = 3;  // dv_x, dv_y, dv_z

    std::vector<std::vector<double>> J(n_constraints, std::vector<double>(n_controls));

    // Position sensitivity to initial velocity: rows 0-2, cols 3-5 of STM
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 3; j++) {
            J[i][j] = phi(i, j + 3);
        }
    }

    // Velocity sensitivity (if needed): rows 3-5, cols 3-5 of STM
    if (match_velocity) {
        for (int i = 0; i < 3; i++) {
            for (int j = 0; j < 3; j++) {
                J[i + 3][j] = phi(i + 3, j + 3);
            }
        }
    }

    return J;
}

std::vector<double> NonlinearRendezvousSolver::solve_linear_system(
    const std::vector<std::vector<double>>& J,
    const std::vector<double>& r) const {

    int m = J.size();     // Number of constraints (rows)
    int n = J[0].size();  // Number of controls (cols)

    std::vector<double> dx(n, 0.0);

    if (m == n) {
        // Square system: direct solve using Gaussian elimination
        std::vector<std::vector<double>> A = J;
        std::vector<double> b = r;

        // Forward elimination with partial pivoting
        for (int k = 0; k < n; k++) {
            // Find pivot
            int max_row = k;
            double max_val = std::abs(A[k][k]);
            for (int i = k + 1; i < n; i++) {
                if (std::abs(A[i][k]) > max_val) {
                    max_val = std::abs(A[i][k]);
                    max_row = i;
                }
            }

            // Swap rows
            std::swap(A[k], A[max_row]);
            std::swap(b[k], b[max_row]);

            // Eliminate
            for (int i = k + 1; i < n; i++) {
                double factor = A[i][k] / A[k][k];
                for (int j = k; j < n; j++) {
                    A[i][j] -= factor * A[k][j];
                }
                b[i] -= factor * b[k];
            }
        }

        // Back substitution
        for (int i = n - 1; i >= 0; i--) {
            dx[i] = b[i];
            for (int j = i + 1; j < n; j++) {
                dx[i] -= A[i][j] * dx[j];
            }
            dx[i] /= A[i][i];
        }
    } else if (m > n) {
        // Overdetermined: least squares via normal equations
        // J^T * J * dx = J^T * r
        std::vector<std::vector<double>> JTJ(n, std::vector<double>(n, 0.0));
        std::vector<double> JTr(n, 0.0);

        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                for (int k = 0; k < m; k++) {
                    JTJ[i][j] += J[k][i] * J[k][j];
                }
            }
            for (int k = 0; k < m; k++) {
                JTr[i] += J[k][i] * r[k];
            }
        }

        // Solve JTJ * dx = JTr (recursive call with square system)
        dx = solve_linear_system(JTJ, JTr);
    }

    return dx;
}

Vec3 NonlinearRendezvousSolver::cw_initial_guess(
    const StateVector& chaser,
    const StateVector& target,
    double tof) {

    // Compute mean motion from chaser orbit
    double r = chaser.position.norm();
    double n = std::sqrt(force_config_.mu / (r * r * r));

    // Relative position in ECI (approximate RIC by assuming circular equatorial)
    Vec3 dr;
    dr.x = chaser.position.x - target.position.x;
    dr.y = chaser.position.y - target.position.y;
    dr.z = chaser.position.z - target.position.z;

    // Simple CW-based guess: for half-period, radial burn dominates
    // For full-period, in-track burn dominates
    double period = 2.0 * PI / n;
    double half_period = period / 2.0;

    Vec3 dv_guess = {0, 0, 0};

    // In-track separation (approximate)
    double in_track_sep = std::sqrt(dr.x*dr.x + dr.y*dr.y);  // Simplified

    if (std::abs(tof - half_period) < 0.2 * half_period) {
        // Near half-period: use radial
        double dv_radial = in_track_sep * n / 4.0;
        // Apply in radial direction (position direction)
        double r_mag = chaser.position.norm();
        dv_guess.x = -dv_radial * chaser.position.x / r_mag;
        dv_guess.y = -dv_radial * chaser.position.y / r_mag;
        dv_guess.z = -dv_radial * chaser.position.z / r_mag;
    } else {
        // Use in-track
        double v_circ = std::sqrt(force_config_.mu / r);
        double delta_theta = in_track_sep / r;
        double dv_intrack = v_circ * delta_theta / (3.0 * tof * n);
        // Apply in velocity direction
        double v_mag = chaser.velocity.norm();
        dv_guess.x = -dv_intrack * chaser.velocity.x / v_mag;
        dv_guess.y = -dv_intrack * chaser.velocity.y / v_mag;
        dv_guess.z = -dv_intrack * chaser.velocity.z / v_mag;
    }

    return dv_guess;
}

RendezvousSolution NonlinearRendezvousSolver::solve_single_impulse(
    const StateVector& chaser,
    const StateVector& target,
    double tof,
    bool match_velocity,
    const Vec3* initial_guess) {

    RendezvousSolution solution;
    solution.converged = false;
    solution.iterations = 0;

    // Get target state at final time
    StateVector target_final = propagate_target(target, tof);

    // Initial guess for delta-V
    Vec3 dv;
    if (initial_guess) {
        dv = *initial_guess;
    } else {
        dv = cw_initial_guess(chaser, target, tof);
    }

    if (solver_config_.verbose) {
        std::cout << "Initial guess: dv = (" << dv.x << ", " << dv.y << ", " << dv.z
                  << ") m/s, mag = " << dv.norm() << " m/s" << std::endl;
    }

    // Newton-Raphson iteration
    for (int iter = 0; iter < solver_config_.max_iterations; iter++) {
        solution.iterations = iter + 1;

        // Apply delta-V to chaser
        StateVector chaser_post_burn = chaser;
        chaser_post_burn.velocity.x += dv.x;
        chaser_post_burn.velocity.y += dv.y;
        chaser_post_burn.velocity.z += dv.z;

        // Propagate with STM
        ExtendedState es = propagate_with_stm(chaser_post_burn, tof);

        // Compute residuals
        std::vector<double> residuals = compute_residuals(es.state, target_final, match_velocity);

        // Check convergence
        double pos_err = std::sqrt(residuals[0]*residuals[0] +
                                    residuals[1]*residuals[1] +
                                    residuals[2]*residuals[2]);
        double vel_err = 0.0;
        if (match_velocity) {
            vel_err = std::sqrt(residuals[3]*residuals[3] +
                                residuals[4]*residuals[4] +
                                residuals[5]*residuals[5]);
        }

        if (solver_config_.verbose) {
            std::cout << "Iter " << iter << ": pos_err = " << pos_err/1000.0
                      << " km, vel_err = " << vel_err << " m/s, dv_mag = "
                      << dv.norm() << " m/s" << std::endl;
        }

        solution.final_position_error = pos_err;
        solution.final_velocity_error = vel_err;

        bool pos_converged = pos_err < solver_config_.position_tol;
        bool vel_converged = !match_velocity || vel_err < solver_config_.velocity_tol;

        if (pos_converged && vel_converged) {
            solution.converged = true;
            solution.status = "Converged";
            break;
        }

        // Extract Jacobian and solve for correction
        std::vector<std::vector<double>> J = extract_jacobian(es.phi, match_velocity);
        std::vector<double> correction = solve_linear_system(J, residuals);

        // Line search (optional damping)
        double alpha = 1.0;
        if (solver_config_.use_line_search) {
            // Simple backtracking
            Vec3 dv_new;
            for (int ls = 0; ls < 10; ls++) {
                dv_new.x = dv.x - alpha * correction[0];
                dv_new.y = dv.y - alpha * correction[1];
                dv_new.z = dv.z - alpha * correction[2];

                StateVector chaser_test = chaser;
                chaser_test.velocity.x += dv_new.x;
                chaser_test.velocity.y += dv_new.y;
                chaser_test.velocity.z += dv_new.z;

                ExtendedState es_test = propagate_with_stm(chaser_test, tof);
                std::vector<double> res_test = compute_residuals(es_test.state, target_final, match_velocity);

                double err_test = 0;
                for (double r : res_test) err_test += r * r;
                double err_curr = 0;
                for (double r : residuals) err_curr += r * r;

                if (err_test < err_curr) break;
                alpha *= solver_config_.line_search_alpha;
            }
        }

        // Update delta-V
        dv.x -= alpha * correction[0];
        dv.y -= alpha * correction[1];
        dv.z -= alpha * correction[2];
    }

    if (!solution.converged) {
        solution.status = "Max iterations reached";
    }

    // Store solution
    Maneuver m;
    m.epoch = 0.0;
    m.delta_v = dv;
    m.is_free_epoch = false;
    m.is_free_dv = true;
    solution.maneuvers.push_back(m);
    solution.total_delta_v = dv.norm();

    return solution;
}

RendezvousSolution NonlinearRendezvousSolver::solve_two_impulse(
    const StateVector& chaser,
    const StateVector& target,
    double tof) {

    // First solve position-only intercept
    RendezvousSolution sol1 = solve_single_impulse(chaser, target, tof, false);

    if (!sol1.converged) {
        sol1.status = "First burn failed to converge";
        return sol1;
    }

    // Now compute second burn to match velocity
    StateVector chaser_post_burn = chaser;
    chaser_post_burn.velocity.x += sol1.maneuvers[0].delta_v.x;
    chaser_post_burn.velocity.y += sol1.maneuvers[0].delta_v.y;
    chaser_post_burn.velocity.z += sol1.maneuvers[0].delta_v.z;

    // Propagate chaser to intercept
    StateVector chaser_final = propagate_target(chaser_post_burn, tof);
    StateVector target_final = propagate_target(target, tof);

    // Second burn = target_velocity - chaser_velocity
    Maneuver m2;
    m2.epoch = tof;
    m2.delta_v.x = target_final.velocity.x - chaser_final.velocity.x;
    m2.delta_v.y = target_final.velocity.y - chaser_final.velocity.y;
    m2.delta_v.z = target_final.velocity.z - chaser_final.velocity.z;
    m2.is_free_epoch = false;
    m2.is_free_dv = true;

    RendezvousSolution solution;
    solution.converged = true;
    solution.iterations = sol1.iterations;
    solution.maneuvers = sol1.maneuvers;
    solution.maneuvers.push_back(m2);
    solution.total_delta_v = sol1.maneuvers[0].delta_v.norm() + m2.delta_v.norm();
    solution.final_position_error = sol1.final_position_error;
    solution.final_velocity_error = 0.0;  // Exact match by construction
    solution.status = "Converged (two-impulse)";

    return solution;
}

} // namespace sim
