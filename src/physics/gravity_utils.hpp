/**
 * Gravity Utilities
 *
 * Consolidated gravitational computation functions used by:
 * - GravityModel (Earth-specific)
 * - MultiBodyGravity (Earth-Moon)
 * - NonlinearRendezvousSolver (targeting)
 *
 * These are the canonical implementations - all gravity computations
 * should flow through these functions to ensure consistency.
 */

#ifndef SIM_GRAVITY_UTILS_HPP
#define SIM_GRAVITY_UTILS_HPP

#include "core/state_vector.hpp"
#include <cmath>

namespace sim {
namespace gravity {

/**
 * Physical constants for common celestial bodies
 */
struct BodyConstants {
    double mu;      // Gravitational parameter [m³/s²]
    double radius;  // Equatorial radius [m]
    double j2;      // J2 oblateness coefficient [-]

    static const BodyConstants EARTH;
    static const BodyConstants MOON;
};

// Define constants inline
inline const BodyConstants BodyConstants::EARTH = {
    3.986004418e14,  // mu [m³/s²]
    6378137.0,       // radius [m]
    1.08262668e-3    // J2
};

inline const BodyConstants BodyConstants::MOON = {
    4.9028e12,       // mu [m³/s²]
    1737400.0,       // radius [m]
    2.027e-4         // J2
};

/**
 * Compute two-body gravitational acceleration
 *
 * Formula: a = -mu * r / |r|³
 *
 * @param position Position relative to body center [m]
 * @param mu Gravitational parameter [m³/s²]
 * @return Acceleration vector [m/s²]
 */
inline Vec3 two_body_acceleration(const Vec3& position, double mu) {
    double r = position.norm();
    if (r < 1.0) {
        // Prevent division by zero at center
        return Vec3{0.0, 0.0, 0.0};
    }

    double r3 = r * r * r;
    double coeff = -mu / r3;

    return Vec3{
        coeff * position.x,
        coeff * position.y,
        coeff * position.z
    };
}

/**
 * Compute J2 oblateness perturbation acceleration
 *
 * Accounts for the equatorial bulge of an oblate body.
 * The J2 effect is strongest near the equator and at low altitudes.
 *
 * @param position Position relative to body center [m]
 * @param mu Gravitational parameter [m³/s²]
 * @param j2 J2 oblateness coefficient
 * @param radius Body equatorial radius [m]
 * @return J2 perturbation acceleration [m/s²]
 */
inline Vec3 j2_perturbation(const Vec3& position, double mu, double j2, double radius) {
    double r = position.norm();
    if (r < radius) {
        // Inside body - return zero
        return Vec3{0.0, 0.0, 0.0};
    }

    double r2 = r * r;
    double r5 = r2 * r2 * r;
    double z2 = position.z * position.z;

    // J2 perturbation formula:
    // a_J2 = (3/2) * J2 * mu * R²/r⁵ * [(5z²/r² - 1)*x, (5z²/r² - 1)*y, (5z²/r² - 3)*z]
    double j2_coeff = 1.5 * j2 * mu * radius * radius / r5;
    double z_factor = 5.0 * z2 / r2;

    return Vec3{
        j2_coeff * position.x * (z_factor - 1.0),
        j2_coeff * position.y * (z_factor - 1.0),
        j2_coeff * position.z * (z_factor - 3.0)
    };
}

/**
 * Compute combined two-body + J2 acceleration
 *
 * @param position Position relative to body center [m]
 * @param body Body constants (mu, radius, j2)
 * @param include_j2 Whether to include J2 perturbation
 * @return Total acceleration [m/s²]
 */
inline Vec3 body_acceleration(const Vec3& position, const BodyConstants& body, bool include_j2 = true) {
    Vec3 acc = two_body_acceleration(position, body.mu);

    if (include_j2) {
        Vec3 j2_acc = j2_perturbation(position, body.mu, body.j2, body.radius);
        acc.x += j2_acc.x;
        acc.y += j2_acc.y;
        acc.z += j2_acc.z;
    }

    return acc;
}

/**
 * Compute gravity gradient matrix (3x3) for STM propagation
 *
 * This is the Jacobian of gravitational acceleration with respect to position:
 * G_ij = ∂a_i/∂r_j = -mu/r³ * (δ_ij - 3*r_i*r_j/r²)
 *
 * Used by Newton-Raphson targeting for State Transition Matrix propagation.
 *
 * @param position Position relative to body center [m]
 * @param mu Gravitational parameter [m³/s²]
 * @param G Output 3x3 gradient matrix [1/s²]
 */
inline void gravity_gradient(const Vec3& position, double mu, double G[3][3]) {
    double r = position.norm();
    double r2 = r * r;
    double r3 = r2 * r;
    double r5 = r2 * r3;

    // G_ij = -mu/r³ * (δ_ij - 3*r_i*r_j/r²)
    G[0][0] = -mu / r3 * (1.0 - 3.0 * position.x * position.x / r2);
    G[0][1] = -mu / r3 * (-3.0 * position.x * position.y / r2);
    G[0][2] = -mu / r3 * (-3.0 * position.x * position.z / r2);

    G[1][0] = G[0][1];  // Symmetric
    G[1][1] = -mu / r3 * (1.0 - 3.0 * position.y * position.y / r2);
    G[1][2] = -mu / r3 * (-3.0 * position.y * position.z / r2);

    G[2][0] = G[0][2];  // Symmetric
    G[2][1] = G[1][2];  // Symmetric
    G[2][2] = -mu / r3 * (1.0 - 3.0 * position.z * position.z / r2);
}

/**
 * Compute third-body perturbation
 *
 * Formula: a = mu₃ * (r_s3/|r_s3|³ - r_p3/|r_p3|³)
 * where r_s3 = third body - spacecraft, r_p3 = third body - primary
 *
 * @param pos_rel_primary Position relative to primary body [m]
 * @param third_body_pos Position of third body relative to primary [m]
 * @param mu_third GM of third body [m³/s²]
 * @return Third-body perturbation acceleration [m/s²]
 */
inline Vec3 third_body_perturbation(
    const Vec3& pos_rel_primary,
    const Vec3& third_body_pos,
    double mu_third) {

    // Vector from spacecraft to third body
    Vec3 r_s3{
        third_body_pos.x - pos_rel_primary.x,
        third_body_pos.y - pos_rel_primary.y,
        third_body_pos.z - pos_rel_primary.z
    };

    double d_s3 = r_s3.norm();
    double d_p3 = third_body_pos.norm();

    if (d_s3 < 1.0 || d_p3 < 1.0) {
        return Vec3{0.0, 0.0, 0.0};
    }

    double d_s3_3 = d_s3 * d_s3 * d_s3;
    double d_p3_3 = d_p3 * d_p3 * d_p3;

    return Vec3{
        mu_third * (r_s3.x / d_s3_3 - third_body_pos.x / d_p3_3),
        mu_third * (r_s3.y / d_s3_3 - third_body_pos.y / d_p3_3),
        mu_third * (r_s3.z / d_s3_3 - third_body_pos.z / d_p3_3)
    };
}

}  // namespace gravity
}  // namespace sim

#endif  // SIM_GRAVITY_UTILS_HPP
