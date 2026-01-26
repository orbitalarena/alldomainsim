#include "ric_frame.hpp"
#include <cmath>

namespace sim {

RICFrame RICFrameUtils::compute_frame(const StateVector& state) {
    RICFrame ric;

    // R = position / |position|
    double r_mag = state.position.norm();
    ric.R.x = state.position.x / r_mag;
    ric.R.y = state.position.y / r_mag;
    ric.R.z = state.position.z / r_mag;

    // C = h / |h| where h = r x v (angular momentum)
    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();
    ric.C.x = h.x / h_mag;
    ric.C.y = h.y / h_mag;
    ric.C.z = h.z / h_mag;

    // I = C x R (completes right-handed system)
    ric.I.x = ric.C.y * ric.R.z - ric.C.z * ric.R.y;
    ric.I.y = ric.C.z * ric.R.x - ric.C.x * ric.R.z;
    ric.I.z = ric.C.x * ric.R.y - ric.C.y * ric.R.x;

    return ric;
}

Vec3 RICFrameUtils::compute_relative_position(const StateVector& chase, const StateVector& target) {
    // Vector from target to chase in ECI
    Vec3 rel_eci;
    rel_eci.x = chase.position.x - target.position.x;
    rel_eci.y = chase.position.y - target.position.y;
    rel_eci.z = chase.position.z - target.position.z;

    // Transform to target's RIC frame
    return eci_to_ric(rel_eci, target);
}

Vec3 RICFrameUtils::compute_relative_velocity(const StateVector& chase, const StateVector& target, double n) {
    // Relative velocity in ECI
    Vec3 rel_vel_eci;
    rel_vel_eci.x = chase.velocity.x - target.velocity.x;
    rel_vel_eci.y = chase.velocity.y - target.velocity.y;
    rel_vel_eci.z = chase.velocity.z - target.velocity.z;

    // Transform to RIC (inertial measurement)
    Vec3 v_inertial = eci_to_ric(rel_vel_eci, target);

    // Get relative position for frame rotation correction
    Vec3 r_ric = compute_relative_position(chase, target);

    // In rotating frame: v_rotating = v_inertial - omega x r
    // omega = (0, 0, n) in RIC, so omega x r = (-n*I, n*R, 0)
    Vec3 v_rotating;
    v_rotating.x = v_inertial.x + n * r_ric.y;  // - (-n*I)
    v_rotating.y = v_inertial.y - n * r_ric.x;  // - (n*R)
    v_rotating.z = v_inertial.z;

    return v_rotating;
}

Vec3 RICFrameUtils::ric_to_eci(const Vec3& vec_ric, const StateVector& reference) {
    RICFrame ric = compute_frame(reference);

    Vec3 vec_eci;
    vec_eci.x = vec_ric.x * ric.R.x + vec_ric.y * ric.I.x + vec_ric.z * ric.C.x;
    vec_eci.y = vec_ric.x * ric.R.y + vec_ric.y * ric.I.y + vec_ric.z * ric.C.y;
    vec_eci.z = vec_ric.x * ric.R.z + vec_ric.y * ric.I.z + vec_ric.z * ric.C.z;

    return vec_eci;
}

Vec3 RICFrameUtils::eci_to_ric(const Vec3& vec_eci, const StateVector& reference) {
    RICFrame ric = compute_frame(reference);

    Vec3 vec_ric;
    vec_ric.x = vec_eci.x * ric.R.x + vec_eci.y * ric.R.y + vec_eci.z * ric.R.z;
    vec_ric.y = vec_eci.x * ric.I.x + vec_eci.y * ric.I.y + vec_eci.z * ric.I.z;
    vec_ric.z = vec_eci.x * ric.C.x + vec_eci.y * ric.C.y + vec_eci.z * ric.C.z;

    return vec_ric;
}

double RICFrameUtils::compute_range(const StateVector& chase, const StateVector& target) {
    Vec3 rel;
    rel.x = chase.position.x - target.position.x;
    rel.y = chase.position.y - target.position.y;
    rel.z = chase.position.z - target.position.z;
    return rel.norm();
}

double RICFrameUtils::compute_range_rate(const StateVector& chase, const StateVector& target) {
    Vec3 rel_pos;
    rel_pos.x = chase.position.x - target.position.x;
    rel_pos.y = chase.position.y - target.position.y;
    rel_pos.z = chase.position.z - target.position.z;

    Vec3 rel_vel;
    rel_vel.x = chase.velocity.x - target.velocity.x;
    rel_vel.y = chase.velocity.y - target.velocity.y;
    rel_vel.z = chase.velocity.z - target.velocity.z;

    double range = rel_pos.norm();
    if (range < 1e-10) return 0.0;

    // Range rate = (r . v) / |r|
    double dot = rel_pos.x * rel_vel.x + rel_pos.y * rel_vel.y + rel_pos.z * rel_vel.z;
    return dot / range;
}

} // namespace sim
