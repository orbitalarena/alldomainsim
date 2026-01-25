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
    LambertSolution result;
    result.valid = false;

    double r1_mag = r1.norm();
    double r2_mag = r2.norm();

    // Cross product for transfer angle
    Vec3 cross;
    cross.x = r1.y * r2.z - r1.z * r2.y;
    cross.y = r1.z * r2.x - r1.x * r2.z;
    cross.z = r1.x * r2.y - r1.y * r2.x;

    // Dot product
    double dot = r1.x * r2.x + r1.y * r2.y + r1.z * r2.z;

    // Transfer angle
    double cos_theta = dot / (r1_mag * r2_mag);
    cos_theta = std::max(-1.0, std::min(1.0, cos_theta));

    double theta;
    if (prograde) {
        if (cross.z >= 0) {
            theta = std::acos(cos_theta);
        } else {
            theta = TWO_PI - std::acos(cos_theta);
        }
    } else {
        if (cross.z < 0) {
            theta = std::acos(cos_theta);
        } else {
            theta = TWO_PI - std::acos(cos_theta);
        }
    }

    // Chord
    double c = std::sqrt(r1_mag*r1_mag + r2_mag*r2_mag - 2*r1_mag*r2_mag*std::cos(theta));

    // Semi-perimeter
    double s = (r1_mag + r2_mag + c) / 2.0;

    // Minimum energy semi-major axis
    double a_min = s / 2.0;

    // Minimum energy time of flight
    double alpha_min = PI;
    double beta_min = 2.0 * std::asin(std::sqrt((s - c) / s));
    if (theta > PI) beta_min = -beta_min;

    double tof_min = std::sqrt(std::pow(a_min, 3) / mu) *
                     (alpha_min - beta_min - (std::sin(alpha_min) - std::sin(beta_min)));

    if (tof < tof_min * 0.5) {
        // Time of flight too short
        return result;
    }

    // Iterative solution for semi-major axis
    // Using bisection method for robustness
    double a_low = a_min;
    double a_high = s * 10.0;  // Upper bound

    double a = (a_low + a_high) / 2.0;

    for (int iter = 0; iter < 100; iter++) {
        a = (a_low + a_high) / 2.0;

        double alpha = 2.0 * std::asin(std::sqrt(s / (2.0 * a)));
        double beta = 2.0 * std::asin(std::sqrt((s - c) / (2.0 * a)));

        if (theta > PI) beta = -beta;

        double tof_calc = std::sqrt(std::pow(a, 3) / mu) *
                         (alpha - beta - (std::sin(alpha) - std::sin(beta)));

        if (std::abs(tof_calc - tof) < 1.0) {  // Within 1 second
            break;
        }

        if (tof_calc < tof) {
            a_low = a;
        } else {
            a_high = a;
        }
    }

    // Compute velocities using f and g functions
    double p = a * (1.0 - std::pow((s - c) / (2.0 * a), 2));  // Semi-latus rectum approximation

    // f and g functions
    double f = 1.0 - r2_mag / p * (1.0 - std::cos(theta));
    double g = r1_mag * r2_mag * std::sin(theta) / std::sqrt(mu * p);
    double g_dot = 1.0 - r1_mag / p * (1.0 - std::cos(theta));

    // Initial velocity
    result.v1.x = (r2.x - f * r1.x) / g;
    result.v1.y = (r2.y - f * r1.y) / g;
    result.v1.z = (r2.z - f * r1.z) / g;

    // Final velocity
    result.v2.x = (g_dot * r2.x - r1.x) / g + f * result.v1.x;
    result.v2.y = (g_dot * r2.y - r1.y) / g + f * result.v1.y;
    result.v2.z = (g_dot * r2.z - r1.z) / g + f * result.v1.z;

    // Actually, let's use the proper formula
    double f_dot = std::sqrt(mu / p) * std::tan(theta / 2.0) *
                   ((1.0 - std::cos(theta)) / p - 1.0/r1_mag - 1.0/r2_mag);

    result.v1.x = (r2.x - f * r1.x) / g;
    result.v1.y = (r2.y - f * r1.y) / g;
    result.v1.z = (r2.z - f * r1.z) / g;

    result.v2.x = f_dot * r1.x + g_dot * result.v1.x;
    result.v2.y = f_dot * r1.y + g_dot * result.v1.y;
    result.v2.z = f_dot * r1.z + g_dot * result.v1.z;

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
    prograde.x = chaser_state.velocity.x / v_chaser;
    prograde.y = chaser_state.velocity.y / v_chaser;
    prograde.z = chaser_state.velocity.z / v_chaser;

    plan.delta_v1.x = plan.transfer.delta_v1 * prograde.x;
    plan.delta_v1.y = plan.transfer.delta_v1 * prograde.y;
    plan.delta_v1.z = plan.transfer.delta_v1 * prograde.z;

    // Second burn will be computed at the transfer orbit apoapsis
    // For now, store magnitude
    plan.delta_v2.x = plan.transfer.delta_v2 * prograde.x;
    plan.delta_v2.y = plan.transfer.delta_v2 * prograde.y;
    plan.delta_v2.z = plan.transfer.delta_v2 * prograde.z;

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
