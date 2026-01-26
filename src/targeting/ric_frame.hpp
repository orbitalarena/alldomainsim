#ifndef RIC_FRAME_HPP
#define RIC_FRAME_HPP

#include "core/state_vector.hpp"

namespace sim {

/**
 * RIC (Radial-Intrack-Crosstrack) Reference Frame
 *
 * Also known as LVLH (Local Vertical Local Horizontal) or RSW frame.
 * Used for relative motion analysis in orbital mechanics.
 *
 * - R (Radial): Points from Earth center through the satellite
 * - I (In-track): In the orbital plane, perpendicular to R, in velocity direction
 * - C (Cross-track): Completes right-handed system, along angular momentum
 */
struct RICFrame {
    Vec3 R;  // Radial unit vector
    Vec3 I;  // In-track unit vector
    Vec3 C;  // Cross-track unit vector
};

/**
 * RIC Frame Utilities
 *
 * Provides coordinate transformations between ECI (Earth-Centered Inertial)
 * and the RIC frame of a reference spacecraft.
 */
class RICFrameUtils {
public:
    /**
     * Compute the RIC frame unit vectors for a given state
     * @param state The reference spacecraft state in ECI
     * @return RIC frame with unit vectors
     */
    static RICFrame compute_frame(const StateVector& state);

    /**
     * Compute relative position of chase w.r.t. target in target's RIC frame
     * @param chase Chase spacecraft state in ECI
     * @param target Target spacecraft state in ECI
     * @return Relative position vector in RIC coordinates (meters)
     */
    static Vec3 compute_relative_position(const StateVector& chase, const StateVector& target);

    /**
     * Compute relative velocity in the rotating RIC frame
     * Accounts for frame rotation: v_rotating = v_inertial - omega x r
     * @param chase Chase spacecraft state in ECI
     * @param target Target spacecraft state in ECI
     * @param n Mean motion of the target orbit (rad/s)
     * @return Relative velocity in rotating RIC frame (m/s)
     */
    static Vec3 compute_relative_velocity(const StateVector& chase, const StateVector& target, double n);

    /**
     * Convert a vector from RIC frame to ECI frame
     * @param vec_ric Vector in RIC coordinates
     * @param reference Reference spacecraft state (defines the RIC frame)
     * @return Vector in ECI coordinates
     */
    static Vec3 ric_to_eci(const Vec3& vec_ric, const StateVector& reference);

    /**
     * Convert a vector from ECI frame to RIC frame
     * @param vec_eci Vector in ECI coordinates
     * @param reference Reference spacecraft state (defines the RIC frame)
     * @return Vector in RIC coordinates
     */
    static Vec3 eci_to_ric(const Vec3& vec_eci, const StateVector& reference);

    /**
     * Compute range between two spacecraft
     * @param chase Chase spacecraft state
     * @param target Target spacecraft state
     * @return Range in meters
     */
    static double compute_range(const StateVector& chase, const StateVector& target);

    /**
     * Compute range rate (closing velocity)
     * @param chase Chase spacecraft state
     * @param target Target spacecraft state
     * @return Range rate in m/s (positive = opening, negative = closing)
     */
    static double compute_range_rate(const StateVector& chase, const StateVector& target);
};

} // namespace sim

#endif // RIC_FRAME_HPP
