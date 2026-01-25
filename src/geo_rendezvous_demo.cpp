#include <iostream>
#include <fstream>
#include <cmath>
#include <vector>
#include <iomanip>

#include "core/state_vector.hpp"
#include "physics/orbital_elements.hpp"
#include "physics/gravity_model.hpp"
#include "propagators/rk4_integrator.hpp"

using namespace sim;

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;

// GEO parameters (in meters)
constexpr double GEO_RADIUS = 42164.0e3;  // m from Earth center

struct SatelliteState {
    std::string name;
    StateVector state;
    std::vector<StateVector> trajectory;
};

// RIC frame computation
struct RICFrame {
    Vec3 R, I, C;  // Unit vectors
};

RICFrame compute_ric_frame(const StateVector& state) {
    RICFrame ric;

    double r_mag = state.position.norm();
    ric.R.x = state.position.x / r_mag;
    ric.R.y = state.position.y / r_mag;
    ric.R.z = state.position.z / r_mag;

    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();
    ric.C.x = h.x / h_mag;
    ric.C.y = h.y / h_mag;
    ric.C.z = h.z / h_mag;

    ric.I.x = ric.C.y * ric.R.z - ric.C.z * ric.R.y;
    ric.I.y = ric.C.z * ric.R.x - ric.C.x * ric.R.z;
    ric.I.z = ric.C.x * ric.R.y - ric.C.y * ric.R.x;

    return ric;
}

// Compute relative position of chase w.r.t. target in target's RIC frame
// This is what CW equations expect: chaser position relative to target at origin
Vec3 compute_ric_position(const StateVector& chase, const StateVector& target) {
    // Vector from target to chase (chase position relative to target)
    Vec3 rel_eci;
    rel_eci.x = chase.position.x - target.position.x;
    rel_eci.y = chase.position.y - target.position.y;
    rel_eci.z = chase.position.z - target.position.z;

    // Use target's RIC frame (target is at origin)
    RICFrame ric = compute_ric_frame(target);

    Vec3 rel_ric;
    rel_ric.x = rel_eci.x * ric.R.x + rel_eci.y * ric.R.y + rel_eci.z * ric.R.z;
    rel_ric.y = rel_eci.x * ric.I.x + rel_eci.y * ric.I.y + rel_eci.z * ric.I.z;
    rel_ric.z = rel_eci.x * ric.C.x + rel_eci.y * ric.C.y + rel_eci.z * ric.C.z;

    return rel_ric;
}

// Compute relative velocity of chase w.r.t. target in target's rotating RIC frame
// Must account for frame rotation: v_rotating = v_inertial - ω × r
// where ω = (0, 0, n) in RIC coordinates
Vec3 compute_ric_velocity(const StateVector& chase, const StateVector& target, double n) {
    // Chase velocity relative to target in ECI
    Vec3 rel_vel_eci;
    rel_vel_eci.x = chase.velocity.x - target.velocity.x;
    rel_vel_eci.y = chase.velocity.y - target.velocity.y;
    rel_vel_eci.z = chase.velocity.z - target.velocity.z;

    // Use target's RIC frame
    RICFrame ric = compute_ric_frame(target);

    // Project relative velocity into RIC frame (inertial measurement)
    Vec3 v_inertial;
    v_inertial.x = rel_vel_eci.x * ric.R.x + rel_vel_eci.y * ric.R.y + rel_vel_eci.z * ric.R.z;
    v_inertial.y = rel_vel_eci.x * ric.I.x + rel_vel_eci.y * ric.I.y + rel_vel_eci.z * ric.I.z;
    v_inertial.z = rel_vel_eci.x * ric.C.x + rel_vel_eci.y * ric.C.y + rel_vel_eci.z * ric.C.z;

    // Get relative position in RIC for frame rotation correction
    Vec3 r_ric = compute_ric_position(chase, target);

    // ω × r = (0, 0, n) × (R, I, C) = (-n*I, n*R, 0)
    // v_rotating = v_inertial - ω × r
    Vec3 v_rotating;
    v_rotating.x = v_inertial.x - (-n * r_ric.y);  // + n*I
    v_rotating.y = v_inertial.y - (n * r_ric.x);   // - n*R
    v_rotating.z = v_inertial.z;

    return v_rotating;
}

// Convert RIC delta-V to ECI (using target's frame since CW is in target's frame)
Vec3 ric_to_eci_velocity(const Vec3& dv_ric, const StateVector& target) {
    RICFrame ric = compute_ric_frame(target);

    Vec3 dv_eci;
    dv_eci.x = dv_ric.x * ric.R.x + dv_ric.y * ric.I.x + dv_ric.z * ric.C.x;
    dv_eci.y = dv_ric.x * ric.R.y + dv_ric.y * ric.I.y + dv_ric.z * ric.C.y;
    dv_eci.z = dv_ric.x * ric.R.z + dv_ric.y * ric.I.z + dv_ric.z * ric.C.z;

    return dv_eci;
}

/**
 * CW (Clohessy-Wiltshire) Targeting Solutions
 *
 * Two targeting modes:
 * 1. Single-burn intercept: One radial burn to achieve position intercept
 *    (does not match velocity - chaser passes through target position)
 * 2. Two-burn rendezvous: Two burns to match both position and velocity
 */
struct CWRendezvous {
    Vec3 dv1_ric;      // First burn in RIC (m/s)
    Vec3 dv2_ric;      // Second burn in RIC (m/s)
    double dv1_mag;    // First burn magnitude
    double dv2_mag;    // Second burn magnitude
    double total_dv;   // Total delta-V
    bool valid;
};

/**
 * Simplified CW targeting for GEO phasing
 *
 * For near half-period transfers, use the fundamental relationship:
 * At T = π/n, a radial burn δvR creates in-track displacement ΔI = -4×δvR/n
 *
 * User's rule of thumb: ~13.1 m/s radial moves 1 degree at GEO in 12 hours
 */
CWRendezvous solve_cw_single_burn(const Vec3& r0_ric, double transfer_time, double n) {
    CWRendezvous result;
    result.valid = false;

    double T = transfer_time;
    double nT = n * T;
    double c = std::cos(nT);
    double s = std::sin(nT);

    // For radial burn targeting, solve the 2x2 in-plane system:
    // R(T) = (4-3c)*R0 + (s/n)*dvR + (2(1-c)/n)*dvI
    // I(T) = 6(s-nT)*R0 + I0 + (2(c-1)/n)*dvR + ((4s-3nT)/n)*dvI
    //
    // For single radial burn (dvI=0), I(T)=0 gives:
    // dvR = -n*(I0 + 6(s-nT)*R0) / (2(c-1))

    double denom_r = 2.0 * (c - 1.0);

    if (std::abs(denom_r) < 1e-10) {
        std::cerr << "CW: Near-singular at full period" << std::endl;
        return result;
    }

    // Solve for radial burn to zero in-track at time T
    double dvR = -n * (r0_ric.y + 6.0 * (s - nT) * r0_ric.x) / denom_r;

    // Predicted positions at T
    double R_at_T = (4.0 - 3.0*c) * r0_ric.x + (s/n) * dvR;
    double I_at_T = 6.0*(s - nT)*r0_ric.x + r0_ric.y + (2.0*(c-1.0)/n)*dvR;

    std::cout << "CW predicts at T=" << T/3600 << "h: R=" << R_at_T/1000.0
              << " km, I=" << I_at_T/1000.0 << " km" << std::endl;

    result.dv1_ric.x = dvR;
    result.dv1_ric.y = 0.0;
    result.dv1_ric.z = 0.0;
    result.dv1_mag = std::sqrt(dvR*dvR);

    result.dv2_ric = {0, 0, 0};
    result.dv2_mag = 0.0;
    result.total_dv = result.dv1_mag;
    result.valid = true;

    return result;
}

/**
 * User's rule-of-thumb targeting for GEO
 *
 * For half-period transfers (12h at GEO):
 *   δvR = I0 × n / 4  (pure radial burn)
 *   Rule: 13.1 m/s radial ≈ 1 degree over 12 hours
 *
 * For full-period or longer transfers (≥24h at GEO):
 *   Use phasing with in-track burns
 *   δv_total = v × |Δθ| / (3 × TOF × n)
 *   Rule: 2.84 m/s in-track ≈ 1 degree over 24 hours
 */
CWRendezvous solve_simple_radial(const Vec3& r0_ric, double n, double v_circ) {
    CWRendezvous result;

    // At half period, I(T) = I0 - 4*δvR/n
    // For I(T) = 0: δvR = I0 * n / 4
    double dvR = r0_ric.y * n / 4.0;

    std::cout << "Simple radial targeting (T=π/n, half-period):" << std::endl;
    std::cout << "  δvR = I0 × n / 4 = " << dvR << " m/s" << std::endl;

    result.dv1_ric.x = dvR;
    result.dv1_ric.y = 0.0;
    result.dv1_ric.z = 0.0;
    result.dv1_mag = std::abs(dvR);

    result.dv2_ric = {0, 0, 0};
    result.dv2_mag = 0.0;
    result.total_dv = result.dv1_mag;
    result.valid = true;

    return result;
}

/**
 * Phasing maneuver with in-track burns for longer transfers
 *
 * Two equal in-track burns separated by TOF to drift Δθ
 * δv_total = v × |Δθ| / (3 × TOF × n)
 * Each burn = δv_total / 2
 */
CWRendezvous solve_phasing(const Vec3& r0_ric, double transfer_time, double n, double v_circ) {
    CWRendezvous result;

    // In-track separation in radians: I0 / R (at GEO, R = a)
    double radius = v_circ / std::sqrt(n * n * n);  // a = (v^2/mu)... simplified
    double delta_theta = std::abs(r0_ric.y) / (42164.0e3);  // Approximate angle

    // Phasing formula: δv_total = v × |Δθ| / (3 × TOF × n)
    double dv_total = v_circ * delta_theta / (3.0 * transfer_time * n);

    // Direction: if chase behind (I0 < 0), need to speed up to catch up
    // Speed up = burn retrograde to lower orbit (negative in-track)
    // Then restore after drift
    double sign = (r0_ric.y < 0) ? -1.0 : 1.0;

    std::cout << "Phasing maneuver (in-track burns):" << std::endl;
    std::cout << "  Δθ = " << delta_theta * 180.0/PI << " deg" << std::endl;
    std::cout << "  δv_total = v × |Δθ| / (3 × TOF × n) = " << dv_total << " m/s" << std::endl;
    std::cout << "  Each burn = " << dv_total/2.0 << " m/s" << std::endl;

    result.dv1_ric.x = 0.0;
    result.dv1_ric.y = sign * dv_total / 2.0;
    result.dv1_ric.z = 0.0;
    result.dv1_mag = dv_total / 2.0;

    result.dv2_ric.x = 0.0;
    result.dv2_ric.y = -sign * dv_total / 2.0;  // Opposite to restore
    result.dv2_ric.z = 0.0;
    result.dv2_mag = dv_total / 2.0;

    result.total_dv = dv_total;
    result.valid = true;

    return result;
}

CWRendezvous solve_cw_rendezvous(const Vec3& r0_ric, const Vec3& v0_ric,
                                   double transfer_time, double n) {
    CWRendezvous result;
    result.valid = false;

    double T = transfer_time;
    double nT = n * T;
    double c = std::cos(nT);
    double s = std::sin(nT);

    // CW State Transition Matrices
    // Position: r(T) = Phi_rr * r0 + Phi_rv * v0
    // Velocity: v(T) = Phi_vr * r0 + Phi_vv * v0

    // Phi_rr (3x3)
    double Phi_rr[3][3] = {
        {4.0 - 3.0*c,    0.0,   0.0},
        {6.0*(s - nT),   1.0,   0.0},
        {0.0,            0.0,   c  }
    };

    // Phi_rv (3x3)
    double Phi_rv[3][3] = {
        {s/n,            2.0*(1.0-c)/n,   0.0},
        {2.0*(c-1.0)/n,  (4.0*s - 3.0*nT)/n, 0.0},
        {0.0,            0.0,             s/n}
    };

    // Phi_vr (3x3)
    double Phi_vr[3][3] = {
        {3.0*n*s,        0.0,   0.0},
        {6.0*n*(c-1.0),  0.0,   0.0},
        {0.0,            0.0,  -n*s}
    };

    // Phi_vv (3x3)
    double Phi_vv[3][3] = {
        {c,              2.0*s,           0.0},
        {-2.0*s,         4.0*c - 3.0,     0.0},
        {0.0,            0.0,             c  }
    };

    // For rendezvous: r(T) = 0
    // 0 = Phi_rr * r0 + Phi_rv * (v0 + dv1)
    // dv1 = -Phi_rv^(-1) * (Phi_rr * r0 + Phi_rv * v0)
    // dv1 = -Phi_rv^(-1) * Phi_rr * r0 - v0

    // Compute Phi_rr * r0
    double Prr_r0[3];
    Prr_r0[0] = Phi_rr[0][0]*r0_ric.x + Phi_rr[0][1]*r0_ric.y + Phi_rr[0][2]*r0_ric.z;
    Prr_r0[1] = Phi_rr[1][0]*r0_ric.x + Phi_rr[1][1]*r0_ric.y + Phi_rr[1][2]*r0_ric.z;
    Prr_r0[2] = Phi_rr[2][0]*r0_ric.x + Phi_rr[2][1]*r0_ric.y + Phi_rr[2][2]*r0_ric.z;

    // Compute Phi_rv * v0
    double Prv_v0[3];
    Prv_v0[0] = Phi_rv[0][0]*v0_ric.x + Phi_rv[0][1]*v0_ric.y + Phi_rv[0][2]*v0_ric.z;
    Prv_v0[1] = Phi_rv[1][0]*v0_ric.x + Phi_rv[1][1]*v0_ric.y + Phi_rv[1][2]*v0_ric.z;
    Prv_v0[2] = Phi_rv[2][0]*v0_ric.x + Phi_rv[2][1]*v0_ric.y + Phi_rv[2][2]*v0_ric.z;

    // b = Phi_rr * r0 + Phi_rv * v0 (what we need to cancel)
    double b[3] = {Prr_r0[0] + Prv_v0[0], Prr_r0[1] + Prv_v0[1], Prr_r0[2] + Prv_v0[2]};

    // Invert Phi_rv (block diagonal for in-plane and out-of-plane)
    // In-plane 2x2: [[s/n, 2(1-c)/n], [2(c-1)/n, (4s-3nT)/n]]
    double a11 = s/n;
    double a12 = 2.0*(1.0-c)/n;
    double a21 = 2.0*(c-1.0)/n;
    double a22 = (4.0*s - 3.0*nT)/n;

    double det_inplane = a11*a22 - a12*a21;

    if (std::abs(det_inplane) < 1e-12) {
        std::cerr << "CW: In-plane matrix singular (det=" << det_inplane << ")" << std::endl;
        return result;
    }

    // Inverse of in-plane 2x2
    double inv11 = a22 / det_inplane;
    double inv12 = -a12 / det_inplane;
    double inv21 = -a21 / det_inplane;
    double inv22 = a11 / det_inplane;

    // Out-of-plane: s/n (scalar)
    double det_outplane = s/n;
    if (std::abs(det_outplane) < 1e-12 && std::abs(b[2]) > 1e-6) {
        std::cerr << "CW: Out-of-plane singular at this transfer time" << std::endl;
        return result;
    }

    // Compute dv1 = -Phi_rv^(-1) * b
    result.dv1_ric.x = -(inv11 * b[0] + inv12 * b[1]);  // Radial
    result.dv1_ric.y = -(inv21 * b[0] + inv22 * b[1]);  // In-track

    if (std::abs(det_outplane) > 1e-12) {
        result.dv1_ric.z = -b[2] / det_outplane;  // Cross-track
    } else {
        result.dv1_ric.z = 0.0;
    }

    // Compute velocity at T after first burn
    // v0_new = v0 + dv1
    double v0_new[3] = {v0_ric.x + result.dv1_ric.x,
                         v0_ric.y + result.dv1_ric.y,
                         v0_ric.z + result.dv1_ric.z};

    // v(T) = Phi_vr * r0 + Phi_vv * v0_new
    double vT[3];
    vT[0] = Phi_vr[0][0]*r0_ric.x + Phi_vr[0][1]*r0_ric.y + Phi_vr[0][2]*r0_ric.z
          + Phi_vv[0][0]*v0_new[0] + Phi_vv[0][1]*v0_new[1] + Phi_vv[0][2]*v0_new[2];
    vT[1] = Phi_vr[1][0]*r0_ric.x + Phi_vr[1][1]*r0_ric.y + Phi_vr[1][2]*r0_ric.z
          + Phi_vv[1][0]*v0_new[0] + Phi_vv[1][1]*v0_new[1] + Phi_vv[1][2]*v0_new[2];
    vT[2] = Phi_vr[2][0]*r0_ric.x + Phi_vr[2][1]*r0_ric.y + Phi_vr[2][2]*r0_ric.z
          + Phi_vv[2][0]*v0_new[0] + Phi_vv[2][1]*v0_new[1] + Phi_vv[2][2]*v0_new[2];

    // Second burn to null the arrival velocity (for station-keeping)
    result.dv2_ric.x = -vT[0];
    result.dv2_ric.y = -vT[1];
    result.dv2_ric.z = -vT[2];

    result.dv1_mag = std::sqrt(result.dv1_ric.x*result.dv1_ric.x +
                                result.dv1_ric.y*result.dv1_ric.y +
                                result.dv1_ric.z*result.dv1_ric.z);
    result.dv2_mag = std::sqrt(result.dv2_ric.x*result.dv2_ric.x +
                                result.dv2_ric.y*result.dv2_ric.y +
                                result.dv2_ric.z*result.dv2_ric.z);
    result.total_dv = result.dv1_mag + result.dv2_mag;
    result.valid = true;

    return result;
}

int main(int argc, char* argv[]) {
    double transfer_hours = 12.0;  // Default: 12 hours
    bool two_burn_mode = false;    // Default: single-burn intercept

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--two-burn" || arg == "-2") {
            two_burn_mode = true;
        } else {
            transfer_hours = std::stod(arg);
            if (transfer_hours <= 0 || transfer_hours > 168) {
                std::cerr << "Error: Transfer time must be between 0 and 168 hours" << std::endl;
                return 1;
            }
        }
    }

    std::cout << "=== GEO Rendezvous with CW Targeting ===" << std::endl;
    std::cout << "Usage: " << argv[0] << " [transfer_hours] [--two-burn]" << std::endl;
    std::cout << "Mode: " << (two_burn_mode ? "Two-burn rendezvous" : "Single-burn intercept") << std::endl;

    double mu = GravityModel::EARTH_MU;
    double n_geo = std::sqrt(mu / std::pow(GEO_RADIUS, 3));
    double v_geo = std::sqrt(mu / GEO_RADIUS);
    double geo_period = 2.0 * PI / n_geo;

    std::cout << "GEO radius: " << GEO_RADIUS / 1e3 << " km" << std::endl;
    std::cout << "GEO period: " << geo_period / 3600.0 << " hours" << std::endl;
    std::cout << "GEO mean motion: " << n_geo << " rad/s" << std::endl;

    // Define orbital elements
    OrbitalElements chase_elements, target_elements;

    chase_elements.semi_major_axis = GEO_RADIUS;
    chase_elements.eccentricity = 0.0;
    chase_elements.inclination = 0.0;
    chase_elements.raan = 0.0;
    chase_elements.arg_periapsis = 0.0;
    chase_elements.true_anomaly = 0.0;

    double separation_deg = 1.0;
    target_elements.semi_major_axis = GEO_RADIUS;
    target_elements.eccentricity = 0.0;
    target_elements.inclination = 0.0;
    target_elements.raan = 0.0;
    target_elements.arg_periapsis = 0.0;
    target_elements.true_anomaly = separation_deg * DEG_TO_RAD;

    SatelliteState chase, target;
    chase.name = "Chase";
    chase.state = OrbitalMechanics::elements_to_state(chase_elements, mu);
    chase.state.time = 0.0;

    target.name = "Target";
    target.state = OrbitalMechanics::elements_to_state(target_elements, mu);
    target.state.time = 0.0;

    std::cout << "\n=== Initial Conditions ===" << std::endl;

    Vec3 r0_ric = compute_ric_position(chase.state, target.state);
    Vec3 v0_ric = compute_ric_velocity(chase.state, target.state, n_geo);

    double init_range = std::sqrt(r0_ric.x*r0_ric.x + r0_ric.y*r0_ric.y + r0_ric.z*r0_ric.z);

    std::cout << "Initial relative position (RIC): R=" << r0_ric.x/1e3 << " km, I="
              << r0_ric.y/1e3 << " km, C=" << r0_ric.z/1e3 << " km" << std::endl;
    std::cout << "Initial relative velocity (RIC): R=" << v0_ric.x << " m/s, I="
              << v0_ric.y << " m/s, C=" << v0_ric.z << " m/s" << std::endl;
    std::cout << "Initial range: " << init_range/1e3 << " km" << std::endl;

    // Solve CW targeting
    std::cout << "\n=== CW Targeting Solution ===" << std::endl;
    std::cout << "Transfer time: " << transfer_hours << " hours" << std::endl;

    double transfer_time = transfer_hours * 3600.0;
    double half_period = PI / n_geo;     // ~12h at GEO
    double full_period = 2 * PI / n_geo; // ~24h at GEO

    CWRendezvous cw;
    if (two_burn_mode) {
        cw = solve_cw_rendezvous(r0_ric, v0_ric, transfer_time, n_geo);
        std::cout << "\nUsing two-burn rendezvous solution:" << std::endl;
    } else {
        // Choose targeting method based on transfer time:
        // - Near half-period: radial burns work best
        // - Near full-period or longer: use phasing (in-track burns)
        bool near_half_period = std::abs(transfer_time - half_period) < 0.15 * half_period;
        bool near_or_beyond_full = transfer_time > 0.85 * full_period;

        if (near_half_period) {
            cw = solve_simple_radial(r0_ric, n_geo, v_geo);
            std::cout << "\nUsing simple radial formula (near half-period transfer):" << std::endl;
        } else if (near_or_beyond_full) {
            cw = solve_phasing(r0_ric, transfer_time, n_geo, v_geo);
            std::cout << "\nUsing phasing formula (≥full-period transfer):" << std::endl;
        } else {
            cw = solve_cw_single_burn(r0_ric, transfer_time, n_geo);
            std::cout << "\nUsing CW single-burn solution:" << std::endl;
        }
    }

    if (!cw.valid) {
        std::cerr << "Failed to compute CW solution" << std::endl;
        return 1;
    }

    std::cout << std::fixed << std::setprecision(2);
    std::cout << "\nBurn 1 (at T=0):" << std::endl;
    std::cout << "  Radial:     " << cw.dv1_ric.x << " m/s" << std::endl;
    std::cout << "  In-track:   " << cw.dv1_ric.y << " m/s" << std::endl;
    std::cout << "  Cross-track:" << cw.dv1_ric.z << " m/s" << std::endl;
    std::cout << "  Magnitude:  " << cw.dv1_mag << " m/s" << std::endl;

    std::cout << "\nBurn 2 (at T=" << transfer_hours << "h):" << std::endl;
    std::cout << "  Radial:     " << cw.dv2_ric.x << " m/s" << std::endl;
    std::cout << "  In-track:   " << cw.dv2_ric.y << " m/s" << std::endl;
    std::cout << "  Cross-track:" << cw.dv2_ric.z << " m/s" << std::endl;
    std::cout << "  Magnitude:  " << cw.dv2_mag << " m/s" << std::endl;

    std::cout << "\nTotal Delta-V: " << cw.total_dv << " m/s" << std::endl;

    // Simulate
    std::cout << "\n=== Simulating Transfer ===" << std::endl;

    double total_duration = 48.0 * 3600.0;
    double dt = 60.0;
    double record_interval = 300.0;

    // Reset and apply first burn
    chase.state = OrbitalMechanics::elements_to_state(chase_elements, mu);
    chase.state.time = 0.0;
    target.state = OrbitalMechanics::elements_to_state(target_elements, mu);
    target.state.time = 0.0;

    // Convert dv1 from RIC to ECI and apply
    Vec3 dv1_eci = ric_to_eci_velocity(cw.dv1_ric, target.state);
    chase.state.velocity.x += dv1_eci.x;
    chase.state.velocity.y += dv1_eci.y;
    chase.state.velocity.z += dv1_eci.z;

    std::cout << "Applied Burn 1 at T=0" << std::endl;

    chase.trajectory.push_back(chase.state);
    target.trajectory.push_back(target.state);

    struct RICData {
        double time;
        double range;
        double R, I, C;
    };
    std::vector<RICData> ric_history;

    Vec3 ric0 = compute_ric_position(chase.state, target.state);
    double range0 = std::sqrt(ric0.x*ric0.x + ric0.y*ric0.y + ric0.z*ric0.z);
    ric_history.push_back({0.0, range0, ric0.x, ric0.y, ric0.z});

    double last_record_time = 0.0;
    bool burn2_done = false;
    double min_range = range0;
    double min_range_time = 0;

    auto deriv_func = [](const StateVector& s) {
        return GravityModel::compute_derivatives(s, false);
    };

    for (double t = dt; t <= total_duration; t += dt) {
        chase.state = RK4Integrator::step(chase.state, dt, deriv_func);
        chase.state.time = t;

        target.state = RK4Integrator::step(target.state, dt, deriv_func);
        target.state.time = t;

        // Apply second burn at transfer time
        if (!burn2_done && t >= transfer_time) {
            Vec3 dv2_eci = ric_to_eci_velocity(cw.dv2_ric, target.state);
            chase.state.velocity.x += dv2_eci.x;
            chase.state.velocity.y += dv2_eci.y;
            chase.state.velocity.z += dv2_eci.z;
            burn2_done = true;

            Vec3 ric_at_burn = compute_ric_position(chase.state, target.state);
            double range_at_burn = std::sqrt(ric_at_burn.x*ric_at_burn.x +
                                              ric_at_burn.y*ric_at_burn.y +
                                              ric_at_burn.z*ric_at_burn.z);
            std::cout << "Applied Burn 2 at T=" << t/3600.0 << "h" << std::endl;
            std::cout << "  Range at burn: " << range_at_burn/1e3 << " km" << std::endl;
            std::cout << "  RIC: R=" << ric_at_burn.x/1e3 << " I=" << ric_at_burn.y/1e3
                      << " C=" << ric_at_burn.z/1e3 << " km" << std::endl;
        }

        Vec3 ric = compute_ric_position(chase.state, target.state);
        double range = std::sqrt(ric.x*ric.x + ric.y*ric.y + ric.z*ric.z);

        if (range < min_range) {
            min_range = range;
            min_range_time = t;
        }

        if (t - last_record_time >= record_interval) {
            chase.trajectory.push_back(chase.state);
            target.trajectory.push_back(target.state);
            ric_history.push_back({t, range, ric.x, ric.y, ric.z});
            last_record_time = t;

            if (std::fmod(t, 6.0 * 3600.0) < record_interval) {
                std::cout << "T+" << t/3600.0 << "h: Range=" << range/1e3 << " km, R="
                          << ric.x/1e3 << ", I=" << ric.y/1e3 << ", C=" << ric.z/1e3 << std::endl;
            }
        }
    }

    std::cout << "\n=== Results ===" << std::endl;
    std::cout << "Minimum range: " << min_range/1e3 << " km at T=" << min_range_time/3600.0 << "h" << std::endl;

    Vec3 final_ric = compute_ric_position(chase.state, target.state);
    double final_range = std::sqrt(final_ric.x*final_ric.x + final_ric.y*final_ric.y + final_ric.z*final_ric.z);
    std::cout << "Final range: " << final_range/1e3 << " km" << std::endl;
    std::cout << "Final RIC: R=" << final_ric.x/1e3 << ", I=" << final_ric.y/1e3
              << ", C=" << final_ric.z/1e3 << " km" << std::endl;

    // Export JSON
    std::ofstream json_file("geo_rendezvous_data.json");
    json_file << std::fixed << std::setprecision(6);
    json_file << "{\n";
    json_file << "  \"metadata\": {\n";
    json_file << "    \"scenario\": \"GEO CW Rendezvous\",\n";
    json_file << "    \"geo_radius_km\": " << GEO_RADIUS/1e3 << ",\n";
    json_file << "    \"separation_deg\": " << separation_deg << ",\n";
    json_file << "    \"transfer_tof_hours\": " << transfer_hours << ",\n";
    json_file << "    \"dv1_radial_ms\": " << cw.dv1_ric.x << ",\n";
    json_file << "    \"dv1_intrack_ms\": " << cw.dv1_ric.y << ",\n";
    json_file << "    \"dv1_crosstrack_ms\": " << cw.dv1_ric.z << ",\n";
    json_file << "    \"dv1_total_ms\": " << cw.dv1_mag << ",\n";
    json_file << "    \"dv2_radial_ms\": " << cw.dv2_ric.x << ",\n";
    json_file << "    \"dv2_intrack_ms\": " << cw.dv2_ric.y << ",\n";
    json_file << "    \"dv2_crosstrack_ms\": " << cw.dv2_ric.z << ",\n";
    json_file << "    \"dv2_total_ms\": " << cw.dv2_mag << ",\n";
    json_file << "    \"dv_total_ms\": " << cw.total_dv << ",\n";
    json_file << "    \"duration_hours\": 48.0,\n";
    json_file << "    \"time_step_seconds\": " << record_interval << ",\n";
    json_file << "    \"min_range_km\": " << min_range/1e3 << ",\n";
    json_file << "    \"min_range_time_hours\": " << min_range_time/3600.0 << "\n";
    json_file << "  },\n";

    json_file << "  \"ric_history\": [\n";
    for (size_t i = 0; i < ric_history.size(); i++) {
        json_file << "    {\"time\": " << ric_history[i].time
                  << ", \"range\": " << ric_history[i].range
                  << ", \"R\": " << ric_history[i].R
                  << ", \"I\": " << ric_history[i].I
                  << ", \"C\": " << ric_history[i].C << "}";
        if (i < ric_history.size() - 1) json_file << ",";
        json_file << "\n";
    }
    json_file << "  ],\n";

    json_file << "  \"satellites\": [\n";
    json_file << "    {\"name\": \"" << chase.name << "\", \"color\": \"#00FF00\", \"positions\": [\n";
    for (size_t i = 0; i < chase.trajectory.size(); i++) {
        json_file << "      {\"time\": " << chase.trajectory[i].time
                  << ", \"x\": " << chase.trajectory[i].position.x
                  << ", \"y\": " << chase.trajectory[i].position.y
                  << ", \"z\": " << chase.trajectory[i].position.z << "}";
        if (i < chase.trajectory.size() - 1) json_file << ",";
        json_file << "\n";
    }
    json_file << "    ]},\n";

    json_file << "    {\"name\": \"" << target.name << "\", \"color\": \"#FF0000\", \"positions\": [\n";
    for (size_t i = 0; i < target.trajectory.size(); i++) {
        json_file << "      {\"time\": " << target.trajectory[i].time
                  << ", \"x\": " << target.trajectory[i].position.x
                  << ", \"y\": " << target.trajectory[i].position.y
                  << ", \"z\": " << target.trajectory[i].position.z << "}";
        if (i < target.trajectory.size() - 1) json_file << ",";
        json_file << "\n";
    }
    json_file << "    ]}\n";
    json_file << "  ]\n";
    json_file << "}\n";
    json_file.close();

    std::cout << "\nExported to: geo_rendezvous_data.json" << std::endl;

    return 0;
}
