#include "physics/maneuver_planner.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace sim {

constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;

double ManeuverPlanner::circular_velocity(double r, double mu) {
    return std::sqrt(mu / r);
}

HohmannTransfer ManeuverPlanner::hohmann_transfer(double r1, double r2, double mu) {
    HohmannTransfer result;

    // Semi-major axis of transfer ellipse
    result.transfer_sma = (r1 + r2) / 2.0;

    // Velocities in circular orbits
    double v_circ1 = std::sqrt(mu / r1);
    double v_circ2 = std::sqrt(mu / r2);

    // Velocities at periapsis and apoapsis of transfer ellipse
    double v_transfer_peri = std::sqrt(mu * (2.0/r1 - 1.0/result.transfer_sma));
    double v_transfer_apo = std::sqrt(mu * (2.0/r2 - 1.0/result.transfer_sma));

    // Delta-V for each burn
    if (r2 > r1) {
        // Raising orbit
        result.delta_v1 = v_transfer_peri - v_circ1;  // Burn at periapsis
        result.delta_v2 = v_circ2 - v_transfer_apo;   // Burn at apoapsis
    } else {
        // Lowering orbit
        result.delta_v1 = v_circ1 - v_transfer_peri;  // Retrograde at periapsis
        result.delta_v2 = v_transfer_apo - v_circ2;   // Retrograde at apoapsis
    }

    result.total_delta_v = std::abs(result.delta_v1) + std::abs(result.delta_v2);

    // Transfer time (half the period of the transfer ellipse)
    result.transfer_time = PI * std::sqrt(std::pow(result.transfer_sma, 3) / mu);

    // Burn directions (prograde for raising, retrograde for lowering)
    result.burn1_direction = Vec3(1, 0, 0);  // Placeholder - computed in context
    result.burn2_direction = Vec3(1, 0, 0);

    return result;
}

HohmannTransfer ManeuverPlanner::hohmann_transfer(const OrbitalElements& initial,
                                                   const OrbitalElements& target,
                                                   double mu) {
    // For non-circular orbits, use periapsis/apoapsis as transfer points
    double r1 = initial.semi_major_axis * (1.0 - initial.eccentricity);
    double r2 = target.semi_major_axis;

    return hohmann_transfer(r1, r2, mu);
}

LambertSolution ManeuverPlanner::solve_lambert(const Vec3& r1, const Vec3& r2,
                                                double tof, double mu, bool prograde) {
    // Universal variable Lambert solver (Curtis / Bate-Mueller-White)
    // Uses Stumpff functions — handles all transfer angles including near-π

    LambertSolution result;
    result.valid = false;

    double r1_mag = r1.norm();
    double r2_mag = r2.norm();

    if (r1_mag < 1e-6 || r2_mag < 1e-6 || tof <= 0.0) {
        return result;
    }

    // Cross product for transfer angle determination
    double cx = r1.y * r2.z - r1.z * r2.y;
    double cy = r1.z * r2.x - r1.x * r2.z;
    double cz = r1.x * r2.y - r1.y * r2.x;

    double dot_prod = r1.x * r2.x + r1.y * r2.y + r1.z * r2.z;
    double cos_theta = std::max(-1.0, std::min(1.0, dot_prod / (r1_mag * r2_mag)));

    double theta;
    if (prograde) {
        theta = (cz >= 0) ? std::acos(cos_theta) : TWO_PI - std::acos(cos_theta);
    } else {
        theta = (cz < 0) ? std::acos(cos_theta) : TWO_PI - std::acos(cos_theta);
    }

    // Coefficient A (uses half-angle form to avoid singularity near θ=π)
    // A = sin(θ) · √(r1·r2 / (1 - cos θ))
    //   = 2·sin(θ/2)·cos(θ/2) · √(r1·r2) / (√2·|sin(θ/2)|)
    //   = √(2·r1·r2) · cos(θ/2)  (for 0 < θ < 2π)
    // Sign: positive for short-way (θ < π), negative for long-way (θ > π)
    double A = std::sqrt(r1_mag * r2_mag * (1.0 + cos_theta));
    if (theta > PI) A = -A;

    // Guard against degenerate case (θ = 0 or π exactly)
    if (std::abs(A) < 1e-14 * std::sqrt(r1_mag * r2_mag)) {
        return result;
    }

    // Stumpff functions C(z) and S(z)
    auto stumpff_C = [](double z) -> double {
        if (std::abs(z) < 1e-6) return 0.5 - z / 24.0 + z * z / 720.0;
        if (z > 0) return (1.0 - std::cos(std::sqrt(z))) / z;
        return (std::cosh(std::sqrt(-z)) - 1.0) / (-z);
    };

    auto stumpff_S = [](double z) -> double {
        if (std::abs(z) < 1e-6) return 1.0 / 6.0 - z / 120.0 + z * z / 5040.0;
        if (z > 0) {
            double sq = std::sqrt(z);
            return (sq - std::sin(sq)) / (z * sq);
        }
        double sq = std::sqrt(-z);
        return (std::sinh(sq) - sq) / (-z * sq);
    };

    // y(z) function
    auto y_func = [&](double z) -> double {
        double Cz = stumpff_C(z);
        double Sz = stumpff_S(z);
        double sqrtCz = std::sqrt(Cz);
        if (sqrtCz < 1e-30) return r1_mag + r2_mag;
        return r1_mag + r2_mag + A * (z * Sz - 1.0) / sqrtCz;
    };

    // TOF as function of z
    auto tof_func = [&](double z) -> double {
        double Cz = stumpff_C(z);
        double Sz = stumpff_S(z);
        double y = y_func(z);
        if (y < 0.0) return -1.0;  // Invalid
        double x = std::sqrt(y / Cz);
        return (x * x * x * Sz + A * std::sqrt(y)) / std::sqrt(mu);
    };

    // Newton-Raphson iteration on z
    // z > 0: elliptic, z = 0: parabolic, z < 0: hyperbolic
    // Initial guess: z = 0 (parabolic)
    double z = 0.0;

    // Bracket search: find z range where TOF crosses target
    // For most transfers, z is in [0, (2π)²] for single-revolution elliptic
    double z_low = -4.0 * PI * PI;  // Hyperbolic limit
    double z_high = 4.0 * PI * PI * 4.0;  // ~2.5 revolutions

    // Ensure y > 0 at lower bound
    while (y_func(z_low) < 0.0 && z_low < z_high) {
        z_low += 0.1;
    }

    // Bisection + Newton hybrid for robustness
    for (int iter = 0; iter < 200; iter++) {
        double Cz = stumpff_C(z);
        double Sz = stumpff_S(z);
        double y = y_func(z);

        if (y < 0.0) {
            // y must be positive; shift z upward
            z = (z + z_high) * 0.5;
            continue;
        }

        double x = std::sqrt(y / Cz);
        double t_z = (x * x * x * Sz + A * std::sqrt(y)) / std::sqrt(mu);

        double residual = t_z - tof;
        if (std::abs(residual) < 1e-6) {
            break;  // Converged
        }

        // Analytical derivative dt/dz
        double dtdz;
        if (std::abs(z) < 1e-6) {
            // Near-parabolic: use series expansion
            double y_val = y;
            double sqrt_y = std::sqrt(y_val);
            dtdz = (std::sqrt(2.0) / 40.0 * y_val * y_val * sqrt_y +
                    A * (sqrt_y + A * std::sqrt(1.0 / (2.0 * y_val)))) /
                   std::sqrt(mu);
            // Fallback: finite difference
            double dz = 0.01;
            double t_z2 = tof_func(z + dz);
            if (t_z2 > 0) {
                dtdz = (t_z2 - t_z) / dz;
            }
        } else {
            double y_val = y;
            dtdz = (x * x * x * (Sz - 3.0 * Sz / (2.0 * z) + 1.0 / (2.0 * z) * stumpff_C(z))
                    + 3.0 * Sz * std::sqrt(y_val) * A / (2.0 * z)) / std::sqrt(mu);
            // Use finite difference as fallback (more robust)
            double dz = std::max(1e-4, std::abs(z) * 1e-6);
            double t_z2 = tof_func(z + dz);
            if (t_z2 > 0) {
                dtdz = (t_z2 - t_z) / dz;
            }
        }

        if (std::abs(dtdz) > 1e-30) {
            double z_new = z - residual / dtdz;
            // Clamp to bracket
            z_new = std::max(z_low, std::min(z_high, z_new));
            z = z_new;
        } else {
            // Bisection fallback
            if (residual > 0) {
                z_high = z;
            } else {
                z_low = z;
            }
            z = (z_low + z_high) * 0.5;
        }
    }

    // Final computation of f, g, g_dot from converged z
    double y = y_func(z);
    if (y < 0.0) return result;

    double f = 1.0 - y / r1_mag;
    double g_dot = 1.0 - y / r2_mag;
    double g = A * std::sqrt(y / mu);

    if (std::abs(g) < 1e-30) {
        return result;
    }

    // v1 = (r2 - f·r1) / g
    result.v1.x = (r2.x - f * r1.x) / g;
    result.v1.y = (r2.y - f * r1.y) / g;
    result.v1.z = (r2.z - f * r1.z) / g;

    // v2 = (g_dot·r2 - r1) / g
    result.v2.x = (g_dot * r2.x - r1.x) / g;
    result.v2.y = (g_dot * r2.y - r1.y) / g;
    result.v2.z = (g_dot * r2.z - r1.z) / g;

    result.tof = tof;
    result.valid = true;

    return result;
}

double ManeuverPlanner::compute_phase_angle(const StateVector& chaser_state,
                                            const StateVector& target_state) {
    // Phase angle in the orbital plane
    // Positive if target is ahead of chaser

    Vec3 r1 = chaser_state.position;
    Vec3 r2 = target_state.position;

    double r1_mag = r1.norm();
    double r2_mag = r2.norm();

    // Dot product for angle
    double dot = r1.x * r2.x + r1.y * r2.y + r1.z * r2.z;
    double cos_angle = dot / (r1_mag * r2_mag);
    cos_angle = std::max(-1.0, std::min(1.0, cos_angle));

    double angle = std::acos(cos_angle);

    // Determine sign using cross product with velocity
    Vec3 cross;
    cross.x = r1.y * r2.z - r1.z * r2.y;
    cross.y = r1.z * r2.x - r1.x * r2.z;
    cross.z = r1.x * r2.y - r1.y * r2.x;

    // If cross is in same direction as angular momentum, target is ahead
    Vec3 h;  // Angular momentum of chaser
    h.x = r1.y * chaser_state.velocity.z - r1.z * chaser_state.velocity.y;
    h.y = r1.z * chaser_state.velocity.x - r1.x * chaser_state.velocity.z;
    h.z = r1.x * chaser_state.velocity.y - r1.y * chaser_state.velocity.x;

    double h_dot_cross = h.x * cross.x + h.y * cross.y + h.z * cross.z;

    if (h_dot_cross < 0) {
        angle = TWO_PI - angle;
    }

    return angle;
}

double ManeuverPlanner::compute_wait_time(double phase_angle, double r1, double r2,
                                          double mu) {
    // Compute wait time for Hohmann transfer rendezvous

    // Angular velocities
    double n1 = std::sqrt(mu / (r1 * r1 * r1));  // Chaser
    double n2 = std::sqrt(mu / (r2 * r2 * r2));  // Target

    // Transfer time
    double a_transfer = (r1 + r2) / 2.0;
    double tof = PI * std::sqrt(std::pow(a_transfer, 3) / mu);

    // Required phase angle at departure for rendezvous
    // Target travels n2 * tof during transfer
    double phase_required = PI - n2 * tof;

    // Normalize to [0, 2*PI)
    while (phase_required < 0) phase_required += TWO_PI;
    while (phase_required >= TWO_PI) phase_required -= TWO_PI;

    // Phase rate (how fast the angle changes)
    double phase_rate = n1 - n2;

    // Time to reach required phase
    double phase_diff = phase_required - phase_angle;
    while (phase_diff < 0) phase_diff += TWO_PI;

    double wait_time;
    if (std::abs(phase_rate) > 1e-10) {
        wait_time = phase_diff / std::abs(phase_rate);
    } else {
        wait_time = 0;  // Same orbit
    }

    return wait_time;
}

RendezvousPlan ManeuverPlanner::plan_rendezvous(const StateVector& chaser_state,
                                                const StateVector& target_state,
                                                double current_time, double mu) {
    RendezvousPlan plan;

    // Get orbital elements
    OrbitalElements chaser_elem = OrbitalMechanics::state_to_elements(chaser_state, mu);
    OrbitalElements target_elem = OrbitalMechanics::state_to_elements(target_state, mu);

    // Use semi-major axis as radius for nearly circular orbits
    double r1 = chaser_elem.semi_major_axis;
    double r2 = target_elem.semi_major_axis;

    // Compute phase angle
    plan.phase_angle = compute_phase_angle(chaser_state, target_state);

    // Compute wait time
    plan.wait_time = compute_wait_time(plan.phase_angle, r1, r2, mu);

    // Compute Hohmann transfer
    plan.transfer = hohmann_transfer(r1, r2, mu);

    // Burn times
    plan.burn1_time = current_time + plan.wait_time;
    plan.burn2_time = plan.burn1_time + plan.transfer.transfer_time;

    // Compute delta-V vectors
    // First burn: prograde (or retrograde for lowering orbit)
    double v_chaser = chaser_state.velocity.norm();
    Vec3 prograde;
    if (v_chaser > 1.0) {
        prograde.x = chaser_state.velocity.x / v_chaser;
        prograde.y = chaser_state.velocity.y / v_chaser;
        prograde.z = chaser_state.velocity.z / v_chaser;
    } else {
        // Fallback if velocity is near zero
        prograde.x = 1.0; prograde.y = 0.0; prograde.z = 0.0;
    }

    plan.delta_v1.x = plan.transfer.delta_v1 * prograde.x;
    plan.delta_v1.y = plan.transfer.delta_v1 * prograde.y;
    plan.delta_v1.z = plan.transfer.delta_v1 * prograde.z;

    // Second burn: use target velocity direction as approximation
    // (At rendezvous, we want to match target's velocity)
    double v_target = target_state.velocity.norm();
    Vec3 target_prograde;
    if (v_target > 1.0) {
        target_prograde.x = target_state.velocity.x / v_target;
        target_prograde.y = target_state.velocity.y / v_target;
        target_prograde.z = target_state.velocity.z / v_target;
    } else {
        target_prograde = prograde;
    }

    plan.delta_v2.x = plan.transfer.delta_v2 * target_prograde.x;
    plan.delta_v2.y = plan.transfer.delta_v2 * target_prograde.y;
    plan.delta_v2.z = plan.transfer.delta_v2 * target_prograde.z;

    std::cout << "Rendezvous Plan:" << std::endl;
    std::cout << "  Phase angle: " << plan.phase_angle * 180.0 / PI << " deg" << std::endl;
    std::cout << "  Wait time: " << plan.wait_time << " s (" << plan.wait_time/3600.0 << " hr)" << std::endl;
    std::cout << "  Transfer time: " << plan.transfer.transfer_time << " s" << std::endl;
    std::cout << "  Delta-V 1: " << plan.transfer.delta_v1 << " m/s at T+" << plan.burn1_time << "s" << std::endl;
    std::cout << "  Delta-V 2: " << plan.transfer.delta_v2 << " m/s at T+" << plan.burn2_time << "s" << std::endl;
    std::cout << "  Total Delta-V: " << plan.transfer.total_delta_v << " m/s" << std::endl;

    return plan;
}

double ManeuverPlanner::plane_change_delta_v(double v, double delta_i) {
    // Delta-V for pure plane change
    return 2.0 * v * std::sin(delta_i / 2.0);
}

} // namespace sim
