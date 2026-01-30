/**
 * 6DOF Aerodynamic Moment Model Implementation
 */

#include "aerodynamics_6dof.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

AeroMoments Aerodynamics6DOF::compute_aero_moments(
    double alpha, double beta,
    const Vec3& omega,
    double q_bar, double V,
    const ControlSurfaces& controls,
    const MomentCoefficients& config) {

    AeroMoments moments{0.0, 0.0, 0.0};

    // Guard against zero airspeed (no aero moments on the ground / in vacuum)
    if (V < 1.0 || q_bar < 0.1) {
        return moments;
    }

    double S = config.wing_area;
    double b = config.wing_span;
    double c = config.mean_chord;
    double p = omega.x;  // Roll rate
    double q = omega.y;  // Pitch rate
    double r = omega.z;  // Yaw rate

    // Nondimensional rate factors
    double b_2V = b / (2.0 * V);
    double c_2V = c / (2.0 * V);

    // Roll moment L = q_bar * S * b * (Cl_beta*beta + Cl_p*(p*b/2V) + Cl_da*delta_a)
    moments.L = q_bar * S * b * (
        config.Cl_beta * beta +
        config.Cl_p * p * b_2V +
        config.Cl_da * controls.aileron
    );

    // Pitch moment M = q_bar * S * c * (Cm_alpha*alpha + Cm_q*(q*c/2V) + Cm_de*delta_e)
    moments.M = q_bar * S * c * (
        config.Cm_alpha * alpha +
        config.Cm_q * q * c_2V +
        config.Cm_de * controls.elevator
    );

    // Yaw moment N = q_bar * S * b * (Cn_beta*beta + Cn_r*(r*b/2V) + Cn_dr*delta_r)
    moments.N = q_bar * S * b * (
        config.Cn_beta * beta +
        config.Cn_r * r * b_2V +
        config.Cn_dr * controls.rudder
    );

    return moments;
}

Vec3 Aerodynamics6DOF::compute_angular_acceleration(
    const Vec3& omega,
    const AeroMoments& moments,
    const InertiaMatrix& inertia) {

    double p = omega.x;
    double q = omega.y;
    double r = omega.z;

    // I * omega
    Vec3 Iw{inertia.Ixx * p, inertia.Iyy * q, inertia.Izz * r};

    // omega x (I * omega) — gyroscopic coupling
    Vec3 wxIw = cross(omega, Iw);

    // Euler's equation: I * dw/dt = M - w x (I*w)
    // dw/dt = I^-1 * (M - w x (I*w))
    return Vec3{
        (moments.L - wxIw.x) / inertia.Ixx,
        (moments.M - wxIw.y) / inertia.Iyy,
        (moments.N - wxIw.z) / inertia.Izz
    };
}

Quat Aerodynamics6DOF::integrate_attitude(
    const Quat& q,
    const Vec3& omega,
    double dt) {

    // Quaternion derivative: dq/dt = 0.5 * q ⊗ omega_quat
    // where omega_quat = (0, p, q, r)
    Quat omega_q{0.0, omega.x, omega.y, omega.z};
    Quat dq = quat_multiply(q, omega_q);

    // First-order integration: q_new = q + 0.5 * dq * dt
    Quat result{
        q.w + 0.5 * dq.w * dt,
        q.x + 0.5 * dq.x * dt,
        q.y + 0.5 * dq.y * dt,
        q.z + 0.5 * dq.z * dt
    };

    return quat_normalize(result);
}

void Aerodynamics6DOF::step_rotation(
    StateVector& state,
    double alpha, double beta,
    double q_bar, double V,
    const ControlSurfaces& controls,
    const MomentCoefficients& moment_config,
    const InertiaMatrix& inertia,
    double dt) {

    // 1. Compute aerodynamic moments
    AeroMoments moments = compute_aero_moments(
        alpha, beta, state.angular_velocity,
        q_bar, V, controls, moment_config);

    // 2. Euler's equation → angular acceleration
    Vec3 alpha_dot = compute_angular_acceleration(
        state.angular_velocity, moments, inertia);

    // 3. Semi-implicit Euler: update angular velocity first
    state.angular_velocity.x += alpha_dot.x * dt;
    state.angular_velocity.y += alpha_dot.y * dt;
    state.angular_velocity.z += alpha_dot.z * dt;

    // Clamp angular rates to prevent divergence (±5 rad/s ≈ ±286 deg/s)
    constexpr double MAX_RATE = 5.0;
    state.angular_velocity.x = std::clamp(state.angular_velocity.x, -MAX_RATE, MAX_RATE);
    state.angular_velocity.y = std::clamp(state.angular_velocity.y, -MAX_RATE, MAX_RATE);
    state.angular_velocity.z = std::clamp(state.angular_velocity.z, -MAX_RATE, MAX_RATE);

    // 4. Integrate attitude quaternion with updated angular velocity
    state.attitude = integrate_attitude(state.attitude, state.angular_velocity, dt);
}

}  // namespace sim
