/**
 * 6DOF Aerodynamic Moment Model
 *
 * Adds rotational dynamics to the existing 3DOF translational model:
 * - Aerodynamic moment computation from stability/control derivatives
 * - Rigid-body angular acceleration (Euler's equation)
 * - Quaternion attitude integration
 *
 * The 3DOF translational equations (V, gamma, heading) remain unchanged.
 * This layer adds: moments → angular rates → attitude quaternion.
 */

#ifndef SIM_AERODYNAMICS_6DOF_HPP
#define SIM_AERODYNAMICS_6DOF_HPP

#include "core/state_vector.hpp"
#include "physics/vec3_ops.hpp"

namespace sim {

// ═══════════════════════════════════════════════════════════════
// Data Structures
// ═══════════════════════════════════════════════════════════════

/**
 * Aerodynamic moments in body frame [N·m]
 */
struct AeroMoments {
    double L;  // Roll moment (about body X-axis)
    double M;  // Pitch moment (about body Y-axis)
    double N;  // Yaw moment (about body Z-axis)
};

/**
 * Stability and control derivatives
 * Signs follow standard aero convention:
 *   Cm_alpha < 0 means statically stable in pitch
 *   Cn_beta  > 0 means statically stable in yaw (weathercock)
 *   Cl_beta  < 0 means dihedral effect (roll due to sideslip)
 */
struct MomentCoefficients {
    // Static stability derivatives [per radian]
    double Cm_alpha = -2.3;    // Pitch moment vs AoA
    double Cn_beta  = 0.17;    // Yaw moment vs sideslip
    double Cl_beta  = -0.06;   // Roll moment vs sideslip (dihedral)

    // Damping derivatives [nondimensional, referenced to b/(2V) or c/(2V)]
    double Cm_q = -15.0;       // Pitch rate damping
    double Cn_r = -0.15;       // Yaw rate damping
    double Cl_p = -0.30;       // Roll rate damping

    // Control derivatives [per radian of deflection]
    double Cm_de = -1.1;       // Elevator effectiveness
    double Cn_dr = -0.08;      // Rudder effectiveness
    double Cl_da = 0.18;       // Aileron effectiveness

    // Reference lengths [m]
    double mean_chord = 3.45;  // Mean aerodynamic chord (pitch reference)
    double wing_span  = 9.96;  // Wingspan (roll/yaw reference)

    // Wing area used for moment nondimensionalization [m²]
    double wing_area  = 27.87;

    static MomentCoefficients f16_defaults() {
        return MomentCoefficients{};  // defaults are already F-16
    }

    static MomentCoefficients transport_defaults() {
        MomentCoefficients c;
        c.Cm_alpha = -1.5;
        c.Cn_beta  = 0.12;
        c.Cl_beta  = -0.04;
        c.Cm_q = -20.0;
        c.Cn_r = -0.20;
        c.Cl_p = -0.40;
        c.Cm_de = -1.5;
        c.Cn_dr = -0.10;
        c.Cl_da = 0.12;
        c.mean_chord = 6.6;
        c.wing_span  = 35.8;
        c.wing_area  = 125.0;
        return c;
    }
};

/**
 * Diagonal inertia tensor for symmetric aircraft [kg·m²]
 */
struct InertiaMatrix {
    double Ixx = 12875.0;   // Roll inertia
    double Iyy = 75674.0;   // Pitch inertia
    double Izz = 85552.0;   // Yaw inertia

    static InertiaMatrix f16_defaults() {
        return InertiaMatrix{};  // defaults are F-16
    }

    static InertiaMatrix transport_defaults() {
        return InertiaMatrix{1500000.0, 3500000.0, 4500000.0};
    }
};

/**
 * Control surface deflections [radians]
 */
struct ControlSurfaces {
    double elevator = 0.0;  // Positive = trailing edge up → pitch-up moment
    double aileron  = 0.0;  // Positive = right wing down → roll-right moment
    double rudder   = 0.0;  // Positive = trailing edge left → nose-right moment
};

// ═══════════════════════════════════════════════════════════════
// 6DOF Aerodynamics Class
// ═══════════════════════════════════════════════════════════════

class Aerodynamics6DOF {
public:
    /**
     * Compute aerodynamic moments from flight condition
     *
     * @param alpha Angle of attack [rad]
     * @param beta  Sideslip angle [rad]
     * @param omega Body angular rates (p, q, r) [rad/s]
     * @param q_bar Dynamic pressure [Pa]
     * @param V     Airspeed [m/s]
     * @param controls Surface deflections
     * @param config Moment coefficient data
     * @return Aerodynamic moments in body frame [N·m]
     */
    static AeroMoments compute_aero_moments(
        double alpha, double beta,
        const Vec3& omega,
        double q_bar, double V,
        const ControlSurfaces& controls,
        const MomentCoefficients& config);

    /**
     * Euler's equation: dω/dt = I⁻¹(M - ω × Iω)
     *
     * @param omega Current angular velocity [rad/s] (body frame: p, q, r)
     * @param moments Total moments [N·m] (body frame: L, M, N)
     * @param inertia Moment of inertia
     * @return Angular acceleration [rad/s²]
     */
    static Vec3 compute_angular_acceleration(
        const Vec3& omega,
        const AeroMoments& moments,
        const InertiaMatrix& inertia);

    /**
     * Integrate attitude quaternion forward by dt
     * Uses first-order quaternion kinematics: dq/dt = 0.5 * q ⊗ ω_quat
     *
     * @param q     Current attitude quaternion (body-to-inertial)
     * @param omega Body angular velocity [rad/s]
     * @param dt    Time step [s]
     * @return New attitude quaternion (normalized)
     */
    static Quat integrate_attitude(
        const Quat& q,
        const Vec3& omega,
        double dt);

    /**
     * Full 6DOF rotational step:
     * 1. Compute aerodynamic moments
     * 2. Euler's equation → angular acceleration
     * 3. Integrate angular velocity (semi-implicit Euler)
     * 4. Integrate quaternion
     *
     * Modifies state.attitude and state.angular_velocity in-place.
     */
    static void step_rotation(
        StateVector& state,
        double alpha, double beta,
        double q_bar, double V,
        const ControlSurfaces& controls,
        const MomentCoefficients& moment_config,
        const InertiaMatrix& inertia,
        double dt);
};

}  // namespace sim

#endif  // SIM_AERODYNAMICS_6DOF_HPP
