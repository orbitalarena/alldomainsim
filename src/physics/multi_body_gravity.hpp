/**
 * Multi-Body Gravity Model
 *
 * Handles gravitational acceleration from multiple bodies (Earth, Moon)
 * with sphere of influence (SOI) detection for patched conic transitions.
 */

#ifndef SIM_MULTI_BODY_GRAVITY_HPP
#define SIM_MULTI_BODY_GRAVITY_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"

namespace sim {

/**
 * Primary gravitational body for patched conic model
 */
enum class PrimaryBody {
    EARTH,
    MOON
};

/**
 * Multi-body gravity calculator
 *
 * Supports two modes:
 * 1. Patched conic: Single primary body with optional third-body perturbation
 * 2. Full N-body: Sum of all gravitational accelerations (more accurate but slower)
 */
class MultiBodyGravity {
public:
    /**
     * Compute gravitational acceleration using patched conic model
     *
     * @param pos_eci Position in Earth-Centered Inertial frame (m)
     * @param primary Current primary gravitational body
     * @param moon_pos_eci Moon position in ECI (m)
     * @param include_j2 Include J2 oblateness for primary body
     * @param include_third_body Include third-body perturbation
     * @return Gravitational acceleration vector (m/s²)
     */
    static Vec3 compute_acceleration(
        const Vec3& pos_eci,
        PrimaryBody primary,
        const Vec3& moon_pos_eci,
        bool include_j2 = true,
        bool include_third_body = true);

    /**
     * Compute full N-body gravitational acceleration
     * Sum of Earth and Moon gravity (no patched conic switching)
     *
     * @param pos_eci Position in ECI frame (m)
     * @param moon_pos_eci Moon position in ECI (m)
     * @return Total gravitational acceleration (m/s²)
     */
    static Vec3 compute_full_nbody(
        const Vec3& pos_eci,
        const Vec3& moon_pos_eci);

    /**
     * Determine which body should be the primary based on SOI
     *
     * @param pos_eci Position in ECI frame (m)
     * @param moon_pos_eci Moon position in ECI (m)
     * @return Primary body (EARTH or MOON)
     */
    static PrimaryBody determine_primary(
        const Vec3& pos_eci,
        const Vec3& moon_pos_eci);

    /**
     * Check if a position is inside the Moon's SOI
     *
     * @param pos_eci Position in ECI frame (m)
     * @param moon_pos_eci Moon position in ECI (m)
     * @return True if inside Moon SOI
     */
    static bool is_in_moon_soi(
        const Vec3& pos_eci,
        const Vec3& moon_pos_eci);

    /**
     * Convert position from ECI to Moon-Centered Inertial (MCI) frame
     *
     * @param pos_eci Position in ECI (m)
     * @param moon_pos_eci Moon position in ECI (m)
     * @return Position relative to Moon center (m)
     */
    static Vec3 eci_to_mci(const Vec3& pos_eci, const Vec3& moon_pos_eci);

    /**
     * Convert position from MCI to ECI frame
     *
     * @param pos_mci Position in MCI (m)
     * @param moon_pos_eci Moon position in ECI (m)
     * @return Position in ECI (m)
     */
    static Vec3 mci_to_eci(const Vec3& pos_mci, const Vec3& moon_pos_eci);

    /**
     * Convert velocity from ECI to MCI frame
     * Note: This is a simplified conversion that only accounts for position offset
     *
     * @param vel_eci Velocity in ECI (m/s)
     * @param moon_vel_eci Moon velocity in ECI (m/s)
     * @return Velocity relative to Moon (m/s)
     */
    static Vec3 vel_eci_to_mci(const Vec3& vel_eci, const Vec3& moon_vel_eci);

    /**
     * Convert velocity from MCI to ECI frame
     *
     * @param vel_mci Velocity in MCI (m/s)
     * @param moon_vel_eci Moon velocity in ECI (m/s)
     * @return Velocity in ECI (m/s)
     */
    static Vec3 vel_mci_to_eci(const Vec3& vel_mci, const Vec3& moon_vel_eci);

    /**
     * Compute two-body gravitational acceleration
     *
     * @param position Position relative to body center (m)
     * @param mu Gravitational parameter (m³/s²)
     * @return Gravitational acceleration (m/s²)
     */
    static Vec3 compute_two_body(const Vec3& position, double mu);

    /**
     * Compute J2 perturbation acceleration
     *
     * @param position Position relative to body center (m)
     * @param mu Gravitational parameter (m³/s²)
     * @param j2 J2 oblateness coefficient
     * @param radius Body equatorial radius (m)
     * @return J2 perturbation acceleration (m/s²)
     */
    static Vec3 compute_j2_perturbation(
        const Vec3& position, double mu, double j2, double radius);

    /**
     * Compute third-body perturbation
     * Formula: a = mu_3 * (r_s3/|r_s3|³ - r_p3/|r_p3|³)
     * where r_s3 = third body - spacecraft, r_p3 = third body - primary
     *
     * @param pos_rel_primary Position relative to primary body (m)
     * @param third_body_pos Position of third body relative to primary (m)
     * @param mu_third GM of third body (m³/s²)
     * @return Third-body perturbation acceleration (m/s²)
     */
    static Vec3 compute_third_body_perturbation(
        const Vec3& pos_rel_primary,
        const Vec3& third_body_pos,
        double mu_third);

private:
    static constexpr double SOI_HYSTERESIS = 0.05;  // 5% hysteresis to prevent oscillation
};

/**
 * String representation of primary body
 */
inline const char* primary_body_to_string(PrimaryBody body) {
    switch (body) {
        case PrimaryBody::EARTH: return "Earth";
        case PrimaryBody::MOON: return "Moon";
        default: return "Unknown";
    }
}

}  // namespace sim

#endif  // SIM_MULTI_BODY_GRAVITY_HPP
