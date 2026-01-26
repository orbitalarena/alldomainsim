#include "cw_targeting.hpp"
#include <cmath>
#include <stdexcept>

namespace sim {

CWStateMatrix CWTargeting::compute_state_matrix(double n, double dt) {
    CWStateMatrix m;

    double nt = n * dt;
    double c = std::cos(nt);
    double s = std::sin(nt);

    // Position to position (Phi_rr)
    // R row
    m.Phi_rr[0][0] = 4.0 - 3.0 * c;
    m.Phi_rr[0][1] = 0.0;
    m.Phi_rr[0][2] = 0.0;
    // I row
    m.Phi_rr[1][0] = 6.0 * (s - nt);
    m.Phi_rr[1][1] = 1.0;
    m.Phi_rr[1][2] = 0.0;
    // C row
    m.Phi_rr[2][0] = 0.0;
    m.Phi_rr[2][1] = 0.0;
    m.Phi_rr[2][2] = c;

    // Velocity to position (Phi_rv)
    // R row
    m.Phi_rv[0][0] = s / n;
    m.Phi_rv[0][1] = 2.0 * (1.0 - c) / n;
    m.Phi_rv[0][2] = 0.0;
    // I row
    m.Phi_rv[1][0] = 2.0 * (c - 1.0) / n;
    m.Phi_rv[1][1] = (4.0 * s - 3.0 * nt) / n;
    m.Phi_rv[1][2] = 0.0;
    // C row
    m.Phi_rv[2][0] = 0.0;
    m.Phi_rv[2][1] = 0.0;
    m.Phi_rv[2][2] = s / n;

    // Position to velocity (Phi_vr)
    // R row
    m.Phi_vr[0][0] = 3.0 * n * s;
    m.Phi_vr[0][1] = 0.0;
    m.Phi_vr[0][2] = 0.0;
    // I row
    m.Phi_vr[1][0] = 6.0 * n * (c - 1.0);
    m.Phi_vr[1][1] = 0.0;
    m.Phi_vr[1][2] = 0.0;
    // C row
    m.Phi_vr[2][0] = 0.0;
    m.Phi_vr[2][1] = 0.0;
    m.Phi_vr[2][2] = -n * s;

    // Velocity to velocity (Phi_vv)
    // R row
    m.Phi_vv[0][0] = c;
    m.Phi_vv[0][1] = 2.0 * s;
    m.Phi_vv[0][2] = 0.0;
    // I row
    m.Phi_vv[1][0] = -2.0 * s;
    m.Phi_vv[1][1] = 4.0 * c - 3.0;
    m.Phi_vv[1][2] = 0.0;
    // C row
    m.Phi_vv[2][0] = 0.0;
    m.Phi_vv[2][1] = 0.0;
    m.Phi_vv[2][2] = c;

    return m;
}

void CWTargeting::propagate_relative_state(
    const Vec3& r0_ric, const Vec3& v0_ric,
    double n, double dt,
    Vec3& r_ric, Vec3& v_ric) {

    CWStateMatrix m = compute_state_matrix(n, dt);

    // r(t) = Phi_rr * r0 + Phi_rv * v0
    r_ric.x = m.Phi_rr[0][0] * r0_ric.x + m.Phi_rr[0][1] * r0_ric.y + m.Phi_rr[0][2] * r0_ric.z
            + m.Phi_rv[0][0] * v0_ric.x + m.Phi_rv[0][1] * v0_ric.y + m.Phi_rv[0][2] * v0_ric.z;
    r_ric.y = m.Phi_rr[1][0] * r0_ric.x + m.Phi_rr[1][1] * r0_ric.y + m.Phi_rr[1][2] * r0_ric.z
            + m.Phi_rv[1][0] * v0_ric.x + m.Phi_rv[1][1] * v0_ric.y + m.Phi_rv[1][2] * v0_ric.z;
    r_ric.z = m.Phi_rr[2][0] * r0_ric.x + m.Phi_rr[2][1] * r0_ric.y + m.Phi_rr[2][2] * r0_ric.z
            + m.Phi_rv[2][0] * v0_ric.x + m.Phi_rv[2][1] * v0_ric.y + m.Phi_rv[2][2] * v0_ric.z;

    // v(t) = Phi_vr * r0 + Phi_vv * v0
    v_ric.x = m.Phi_vr[0][0] * r0_ric.x + m.Phi_vr[0][1] * r0_ric.y + m.Phi_vr[0][2] * r0_ric.z
            + m.Phi_vv[0][0] * v0_ric.x + m.Phi_vv[0][1] * v0_ric.y + m.Phi_vv[0][2] * v0_ric.z;
    v_ric.y = m.Phi_vr[1][0] * r0_ric.x + m.Phi_vr[1][1] * r0_ric.y + m.Phi_vr[1][2] * r0_ric.z
            + m.Phi_vv[1][0] * v0_ric.x + m.Phi_vv[1][1] * v0_ric.y + m.Phi_vv[1][2] * v0_ric.z;
    v_ric.z = m.Phi_vr[2][0] * r0_ric.x + m.Phi_vr[2][1] * r0_ric.y + m.Phi_vr[2][2] * r0_ric.z
            + m.Phi_vv[2][0] * v0_ric.x + m.Phi_vv[2][1] * v0_ric.y + m.Phi_vv[2][2] * v0_ric.z;
}

CWManeuver CWTargeting::solve_two_burn_rendezvous(
    const Vec3& r0_ric, const Vec3& v0_ric,
    double transfer_time, double n) {

    CWManeuver result;
    result.transfer_time = transfer_time;
    result.method = "two_burn_rendezvous";
    result.valid = false;

    CWStateMatrix m = compute_state_matrix(n, transfer_time);

    // We need to find dv1 such that after transfer_time:
    // r_final = 0 (position match)
    // Then dv2 cancels any remaining velocity

    // r_final = Phi_rr * r0 + Phi_rv * (v0 + dv1) = 0
    // So: Phi_rv * dv1 = -Phi_rr * r0 - Phi_rv * v0

    // Compute RHS: -Phi_rr * r0 - Phi_rv * v0
    Vec3 rhs;
    rhs.x = -(m.Phi_rr[0][0] * r0_ric.x + m.Phi_rr[0][1] * r0_ric.y + m.Phi_rr[0][2] * r0_ric.z)
           -(m.Phi_rv[0][0] * v0_ric.x + m.Phi_rv[0][1] * v0_ric.y + m.Phi_rv[0][2] * v0_ric.z);
    rhs.y = -(m.Phi_rr[1][0] * r0_ric.x + m.Phi_rr[1][1] * r0_ric.y + m.Phi_rr[1][2] * r0_ric.z)
           -(m.Phi_rv[1][0] * v0_ric.x + m.Phi_rv[1][1] * v0_ric.y + m.Phi_rv[1][2] * v0_ric.z);
    rhs.z = -(m.Phi_rr[2][0] * r0_ric.x + m.Phi_rr[2][1] * r0_ric.y + m.Phi_rr[2][2] * r0_ric.z)
           -(m.Phi_rv[2][0] * v0_ric.x + m.Phi_rv[2][1] * v0_ric.y + m.Phi_rv[2][2] * v0_ric.z);

    // Solve Phi_rv * dv1 = rhs
    // Phi_rv is:
    // [s/n,      2(1-c)/n,  0    ]
    // [2(c-1)/n, (4s-3nt)/n, 0   ]
    // [0,        0,         s/n  ]

    // In-plane (R,I) is 2x2 system, cross-track (C) is decoupled
    double det_ri = m.Phi_rv[0][0] * m.Phi_rv[1][1] - m.Phi_rv[0][1] * m.Phi_rv[1][0];

    if (std::abs(det_ri) < 1e-12) {
        // Singular - likely at resonance (nt = k*pi)
        result.valid = false;
        return result;
    }

    // Solve 2x2 for R and I components
    result.dv1_ric.x = (m.Phi_rv[1][1] * rhs.x - m.Phi_rv[0][1] * rhs.y) / det_ri;
    result.dv1_ric.y = (-m.Phi_rv[1][0] * rhs.x + m.Phi_rv[0][0] * rhs.y) / det_ri;

    // Cross-track is independent
    if (std::abs(m.Phi_rv[2][2]) > 1e-12) {
        result.dv1_ric.z = rhs.z / m.Phi_rv[2][2];
    } else {
        result.dv1_ric.z = 0.0;
    }

    // Compute velocity at arrival (before dv2)
    // v_arrive = Phi_vr * r0 + Phi_vv * (v0 + dv1)
    Vec3 v0_plus_dv1;
    v0_plus_dv1.x = v0_ric.x + result.dv1_ric.x;
    v0_plus_dv1.y = v0_ric.y + result.dv1_ric.y;
    v0_plus_dv1.z = v0_ric.z + result.dv1_ric.z;

    Vec3 v_arrive;
    v_arrive.x = m.Phi_vr[0][0] * r0_ric.x + m.Phi_vr[0][1] * r0_ric.y + m.Phi_vr[0][2] * r0_ric.z
               + m.Phi_vv[0][0] * v0_plus_dv1.x + m.Phi_vv[0][1] * v0_plus_dv1.y + m.Phi_vv[0][2] * v0_plus_dv1.z;
    v_arrive.y = m.Phi_vr[1][0] * r0_ric.x + m.Phi_vr[1][1] * r0_ric.y + m.Phi_vr[1][2] * r0_ric.z
               + m.Phi_vv[1][0] * v0_plus_dv1.x + m.Phi_vv[1][1] * v0_plus_dv1.y + m.Phi_vv[1][2] * v0_plus_dv1.z;
    v_arrive.z = m.Phi_vr[2][0] * r0_ric.x + m.Phi_vr[2][1] * r0_ric.y + m.Phi_vr[2][2] * r0_ric.z
               + m.Phi_vv[2][0] * v0_plus_dv1.x + m.Phi_vv[2][1] * v0_plus_dv1.y + m.Phi_vv[2][2] * v0_plus_dv1.z;

    // Second burn cancels arrival velocity
    result.dv2_ric.x = -v_arrive.x;
    result.dv2_ric.y = -v_arrive.y;
    result.dv2_ric.z = -v_arrive.z;

    // Compute magnitudes
    result.dv1_mag = result.dv1_ric.norm();
    result.dv2_mag = result.dv2_ric.norm();
    result.total_dv = result.dv1_mag + result.dv2_mag;
    result.valid = true;

    return result;
}

CWManeuver CWTargeting::solve_single_burn_intercept(
    const Vec3& r0_ric,
    double transfer_time, double n) {

    CWManeuver result;
    result.transfer_time = transfer_time;
    result.method = "single_burn_intercept";
    result.valid = false;

    // Assume zero initial relative velocity
    Vec3 v0_ric = {0.0, 0.0, 0.0};

    CWStateMatrix m = compute_state_matrix(n, transfer_time);

    // r_final = Phi_rr * r0 + Phi_rv * dv1 = 0
    // Phi_rv * dv1 = -Phi_rr * r0

    Vec3 rhs;
    rhs.x = -(m.Phi_rr[0][0] * r0_ric.x + m.Phi_rr[0][1] * r0_ric.y + m.Phi_rr[0][2] * r0_ric.z);
    rhs.y = -(m.Phi_rr[1][0] * r0_ric.x + m.Phi_rr[1][1] * r0_ric.y + m.Phi_rr[1][2] * r0_ric.z);
    rhs.z = -(m.Phi_rr[2][0] * r0_ric.x + m.Phi_rr[2][1] * r0_ric.y + m.Phi_rr[2][2] * r0_ric.z);

    double det_ri = m.Phi_rv[0][0] * m.Phi_rv[1][1] - m.Phi_rv[0][1] * m.Phi_rv[1][0];

    if (std::abs(det_ri) < 1e-12) {
        result.valid = false;
        return result;
    }

    result.dv1_ric.x = (m.Phi_rv[1][1] * rhs.x - m.Phi_rv[0][1] * rhs.y) / det_ri;
    result.dv1_ric.y = (-m.Phi_rv[1][0] * rhs.x + m.Phi_rv[0][0] * rhs.y) / det_ri;

    if (std::abs(m.Phi_rv[2][2]) > 1e-12) {
        result.dv1_ric.z = rhs.z / m.Phi_rv[2][2];
    } else {
        result.dv1_ric.z = 0.0;
    }

    result.dv2_ric = {0.0, 0.0, 0.0};
    result.dv1_mag = result.dv1_ric.norm();
    result.dv2_mag = 0.0;
    result.total_dv = result.dv1_mag;
    result.valid = true;

    return result;
}

CWManeuver CWTargeting::solve_half_period_radial(
    const Vec3& r0_ric, double n) {

    CWManeuver result;
    result.method = "half_period_radial";

    // At T = pi/n (half period), a radial burn creates in-track displacement
    // For pure in-track offset I0, a radial burn dv_R = I0 * n / 4
    // moves the chaser to the target

    double T_half = M_PI / n;
    result.transfer_time = T_half;

    // This only works for pure in-track offset
    double I0 = r0_ric.y;  // In-track component

    result.dv1_ric.x = I0 * n / 4.0;  // Radial burn
    result.dv1_ric.y = 0.0;
    result.dv1_ric.z = 0.0;

    // After half period, need return burn to stop drift
    result.dv2_ric.x = -result.dv1_ric.x;
    result.dv2_ric.y = 0.0;
    result.dv2_ric.z = 0.0;

    result.dv1_mag = std::abs(result.dv1_ric.x);
    result.dv2_mag = std::abs(result.dv2_ric.x);
    result.total_dv = result.dv1_mag + result.dv2_mag;
    result.valid = true;

    return result;
}

CWManeuver CWTargeting::solve_phasing_maneuver(
    const Vec3& r0_ric,
    double transfer_time, double n, double v_circ) {

    CWManeuver result;
    result.transfer_time = transfer_time;
    result.method = "phasing";

    // For pure in-track phasing, use Hohmann-like approach
    // Delta-V to change period for phase shift

    double I0 = r0_ric.y;  // In-track distance to close

    // Approximate: phase rate from altitude change
    // delta_a ~ 2 * I0 / (3 * n * transfer_time)
    // delta_v ~ n * delta_a / 2

    double delta_a = 2.0 * I0 / (3.0 * n * transfer_time);
    double dv = n * std::abs(delta_a) / 2.0;

    // If behind target (I0 > 0), raise orbit to slow down (negative dv_I)
    // If ahead of target (I0 < 0), lower orbit to speed up (positive dv_I)
    result.dv1_ric.x = 0.0;
    result.dv1_ric.y = (I0 > 0) ? -dv : dv;
    result.dv1_ric.z = 0.0;

    // Return burn at end
    result.dv2_ric.x = 0.0;
    result.dv2_ric.y = -result.dv1_ric.y;
    result.dv2_ric.z = 0.0;

    result.dv1_mag = dv;
    result.dv2_mag = dv;
    result.total_dv = 2.0 * dv;
    result.valid = true;

    return result;
}

CWManeuver CWTargeting::solve_optimal(
    const Vec3& r0_ric, const Vec3& v0_ric,
    double transfer_time, double n, double v_circ) {

    // Try different methods and pick the minimum delta-V solution

    CWManeuver best_result;
    best_result.valid = false;
    best_result.total_dv = 1e12;

    // Method 1: Two-burn rendezvous (general solution)
    CWManeuver two_burn = solve_two_burn_rendezvous(r0_ric, v0_ric, transfer_time, n);
    if (two_burn.valid && two_burn.total_dv < best_result.total_dv) {
        best_result = two_burn;
    }

    // Method 2: Half-period radial (if transfer time is close to T/2)
    double T_half = M_PI / n;
    if (std::abs(transfer_time - T_half) / T_half < 0.1) {
        CWManeuver half_period = solve_half_period_radial(r0_ric, n);
        if (half_period.valid && half_period.total_dv < best_result.total_dv) {
            best_result = half_period;
        }
    }

    // Method 3: Phasing (if primarily in-track offset)
    double R_mag = std::abs(r0_ric.x);
    double I_mag = std::abs(r0_ric.y);
    if (I_mag > 5.0 * R_mag && transfer_time > T_half) {
        CWManeuver phasing = solve_phasing_maneuver(r0_ric, transfer_time, n, v_circ);
        if (phasing.valid && phasing.total_dv < best_result.total_dv) {
            best_result = phasing;
        }
    }

    if (!best_result.valid) {
        // Fall back to two-burn if nothing else worked
        best_result = two_burn;
    }

    best_result.method = "optimal_" + best_result.method;
    return best_result;
}

} // namespace sim
