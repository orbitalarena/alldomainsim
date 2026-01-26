/**
 * Multi-Body Gravity Implementation
 */

#include "multi_body_gravity.hpp"
#include <cmath>

namespace sim {

Vec3 MultiBodyGravity::compute_two_body(const Vec3& position, double mu) {
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

Vec3 MultiBodyGravity::compute_j2_perturbation(
    const Vec3& position, double mu, double j2, double radius) {

    double r = position.norm();
    if (r < radius) {
        return Vec3{0.0, 0.0, 0.0};
    }

    double r2 = r * r;
    double r5 = r2 * r2 * r;
    double z2 = position.z * position.z;

    // J2 perturbation formula
    double j2_coeff = 1.5 * j2 * mu * radius * radius / r5;
    double z_factor = 5.0 * z2 / r2;

    Vec3 a_j2;
    a_j2.x = j2_coeff * position.x * (z_factor - 1.0);
    a_j2.y = j2_coeff * position.y * (z_factor - 1.0);
    a_j2.z = j2_coeff * position.z * (z_factor - 3.0);

    return a_j2;
}

Vec3 MultiBodyGravity::compute_third_body_perturbation(
    const Vec3& pos_rel_primary,
    const Vec3& third_body_pos,
    double mu_third) {

    // Vector from spacecraft to third body
    Vec3 r_s3;
    r_s3.x = third_body_pos.x - pos_rel_primary.x;
    r_s3.y = third_body_pos.y - pos_rel_primary.y;
    r_s3.z = third_body_pos.z - pos_rel_primary.z;

    double d_s3 = r_s3.norm();
    double d_p3 = third_body_pos.norm();  // Distance from primary to third body

    if (d_s3 < 1.0 || d_p3 < 1.0) {
        return Vec3{0.0, 0.0, 0.0};
    }

    double d_s3_3 = d_s3 * d_s3 * d_s3;
    double d_p3_3 = d_p3 * d_p3 * d_p3;

    // Third-body perturbation: mu * (r_s3/|r_s3|³ - r_p3/|r_p3|³)
    Vec3 a_third;
    a_third.x = mu_third * (r_s3.x / d_s3_3 - third_body_pos.x / d_p3_3);
    a_third.y = mu_third * (r_s3.y / d_s3_3 - third_body_pos.y / d_p3_3);
    a_third.z = mu_third * (r_s3.z / d_s3_3 - third_body_pos.z / d_p3_3);

    return a_third;
}

Vec3 MultiBodyGravity::compute_acceleration(
    const Vec3& pos_eci,
    PrimaryBody primary,
    const Vec3& moon_pos_eci,
    bool include_j2,
    bool include_third_body) {

    Vec3 accel{0.0, 0.0, 0.0};

    if (primary == PrimaryBody::EARTH) {
        // Earth is primary - position is already relative to Earth
        accel = compute_two_body(pos_eci, EARTH_MU);

        if (include_j2) {
            Vec3 j2_accel = compute_j2_perturbation(
                pos_eci, EARTH_MU, EARTH_J2, EARTH_RADIUS);
            accel.x += j2_accel.x;
            accel.y += j2_accel.y;
            accel.z += j2_accel.z;
        }

        if (include_third_body) {
            // Moon as third body perturbation
            Vec3 moon_perturb = compute_third_body_perturbation(
                pos_eci, moon_pos_eci, MOON_MU);
            accel.x += moon_perturb.x;
            accel.y += moon_perturb.y;
            accel.z += moon_perturb.z;
        }
    }
    else {  // PrimaryBody::MOON
        // Moon is primary - convert to Moon-centered coordinates
        Vec3 pos_mci = eci_to_mci(pos_eci, moon_pos_eci);

        accel = compute_two_body(pos_mci, MOON_MU);

        if (include_j2) {
            Vec3 j2_accel = compute_j2_perturbation(
                pos_mci, MOON_MU, MOON_J2, MOON_RADIUS);
            accel.x += j2_accel.x;
            accel.y += j2_accel.y;
            accel.z += j2_accel.z;
        }

        if (include_third_body) {
            // Earth as third body perturbation
            // From Moon's perspective, Earth is at -moon_pos_eci
            Vec3 earth_pos_from_moon;
            earth_pos_from_moon.x = -moon_pos_eci.x;
            earth_pos_from_moon.y = -moon_pos_eci.y;
            earth_pos_from_moon.z = -moon_pos_eci.z;

            Vec3 earth_perturb = compute_third_body_perturbation(
                pos_mci, earth_pos_from_moon, EARTH_MU);
            accel.x += earth_perturb.x;
            accel.y += earth_perturb.y;
            accel.z += earth_perturb.z;
        }
    }

    return accel;
}

Vec3 MultiBodyGravity::compute_full_nbody(
    const Vec3& pos_eci,
    const Vec3& moon_pos_eci) {

    // Earth gravity (with J2)
    Vec3 accel = compute_two_body(pos_eci, EARTH_MU);
    Vec3 j2_earth = compute_j2_perturbation(pos_eci, EARTH_MU, EARTH_J2, EARTH_RADIUS);
    accel.x += j2_earth.x;
    accel.y += j2_earth.y;
    accel.z += j2_earth.z;

    // Moon gravity
    Vec3 pos_mci = eci_to_mci(pos_eci, moon_pos_eci);
    Vec3 moon_grav = compute_two_body(pos_mci, MOON_MU);
    accel.x += moon_grav.x;
    accel.y += moon_grav.y;
    accel.z += moon_grav.z;

    return accel;
}

PrimaryBody MultiBodyGravity::determine_primary(
    const Vec3& pos_eci,
    const Vec3& moon_pos_eci) {

    Vec3 pos_mci = eci_to_mci(pos_eci, moon_pos_eci);
    double dist_to_moon = pos_mci.norm();

    // Use Moon SOI with small hysteresis to prevent rapid switching
    if (dist_to_moon < MOON_SOI * (1.0 - SOI_HYSTERESIS)) {
        return PrimaryBody::MOON;
    }
    else if (dist_to_moon > MOON_SOI * (1.0 + SOI_HYSTERESIS)) {
        return PrimaryBody::EARTH;
    }

    // In hysteresis band - keep current primary (caller must track this)
    // Default to Earth if no previous state
    return PrimaryBody::EARTH;
}

bool MultiBodyGravity::is_in_moon_soi(
    const Vec3& pos_eci,
    const Vec3& moon_pos_eci) {

    Vec3 pos_mci = eci_to_mci(pos_eci, moon_pos_eci);
    return pos_mci.norm() < MOON_SOI;
}

Vec3 MultiBodyGravity::eci_to_mci(const Vec3& pos_eci, const Vec3& moon_pos_eci) {
    return Vec3{
        pos_eci.x - moon_pos_eci.x,
        pos_eci.y - moon_pos_eci.y,
        pos_eci.z - moon_pos_eci.z
    };
}

Vec3 MultiBodyGravity::mci_to_eci(const Vec3& pos_mci, const Vec3& moon_pos_eci) {
    return Vec3{
        pos_mci.x + moon_pos_eci.x,
        pos_mci.y + moon_pos_eci.y,
        pos_mci.z + moon_pos_eci.z
    };
}

Vec3 MultiBodyGravity::vel_eci_to_mci(const Vec3& vel_eci, const Vec3& moon_vel_eci) {
    return Vec3{
        vel_eci.x - moon_vel_eci.x,
        vel_eci.y - moon_vel_eci.y,
        vel_eci.z - moon_vel_eci.z
    };
}

Vec3 MultiBodyGravity::vel_mci_to_eci(const Vec3& vel_mci, const Vec3& moon_vel_eci) {
    return Vec3{
        vel_mci.x + moon_vel_eci.x,
        vel_mci.y + moon_vel_eci.y,
        vel_mci.z + moon_vel_eci.z
    };
}

}  // namespace sim
