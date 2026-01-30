/**
 * Vec3 and Quat Operations
 *
 * Free-function operator overloads and utilities for Vec3/Quat.
 * Header-only — include wherever vector/quaternion math is needed.
 * Does not modify state_vector.hpp.
 */

#ifndef SIM_VEC3_OPS_HPP
#define SIM_VEC3_OPS_HPP

#include "core/state_vector.hpp"
#include <cmath>

namespace sim {

// ═══════════════════════════════════════════════════════════════
// Vec3 operators
// ═══════════════════════════════════════════════════════════════

inline Vec3 operator+(const Vec3& a, const Vec3& b) {
    return Vec3{a.x + b.x, a.y + b.y, a.z + b.z};
}

inline Vec3 operator-(const Vec3& a, const Vec3& b) {
    return Vec3{a.x - b.x, a.y - b.y, a.z - b.z};
}

inline Vec3 operator-(const Vec3& a) {
    return Vec3{-a.x, -a.y, -a.z};
}

inline Vec3 operator*(double s, const Vec3& v) {
    return Vec3{s * v.x, s * v.y, s * v.z};
}

inline Vec3 operator*(const Vec3& v, double s) {
    return Vec3{v.x * s, v.y * s, v.z * s};
}

inline Vec3 operator/(const Vec3& v, double s) {
    double inv = 1.0 / s;
    return Vec3{v.x * inv, v.y * inv, v.z * inv};
}

inline Vec3& operator+=(Vec3& a, const Vec3& b) {
    a.x += b.x; a.y += b.y; a.z += b.z;
    return a;
}

inline Vec3& operator-=(Vec3& a, const Vec3& b) {
    a.x -= b.x; a.y -= b.y; a.z -= b.z;
    return a;
}

// ═══════════════════════════════════════════════════════════════
// Vec3 functions
// ═══════════════════════════════════════════════════════════════

inline double dot(const Vec3& a, const Vec3& b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

inline Vec3 cross(const Vec3& a, const Vec3& b) {
    return Vec3{
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    };
}

inline Vec3 normalized(const Vec3& v) {
    double n = v.norm();
    if (n < 1e-15) return Vec3::Zero();
    double inv = 1.0 / n;
    return Vec3{v.x * inv, v.y * inv, v.z * inv};
}

inline double distance(const Vec3& a, const Vec3& b) {
    return (a - b).norm();
}

// ═══════════════════════════════════════════════════════════════
// Quat operators and functions
// ═══════════════════════════════════════════════════════════════

// Hamilton product: q1 * q2 (applies q2 then q1)
inline Quat quat_multiply(const Quat& q1, const Quat& q2) {
    return Quat{
        q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
        q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
        q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
        q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w
    };
}

inline Quat quat_conjugate(const Quat& q) {
    return Quat{q.w, -q.x, -q.y, -q.z};
}

inline double quat_norm(const Quat& q) {
    return std::sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
}

inline Quat quat_normalize(const Quat& q) {
    double n = quat_norm(q);
    if (n < 1e-15) return Quat::Identity();
    double inv = 1.0 / n;
    return Quat{q.w * inv, q.x * inv, q.y * inv, q.z * inv};
}

// Rotate vector by quaternion: q * v * q^-1
inline Vec3 quat_rotate(const Quat& q, const Vec3& v) {
    // Efficient formula: v' = v + 2*w*(u x v) + 2*(u x (u x v))
    // where q = (w, u)
    Vec3 u{q.x, q.y, q.z};
    Vec3 uv = cross(u, v);
    Vec3 uuv = cross(u, uv);
    return v + 2.0 * (q.w * uv + uuv);
}

// Inverse rotation: q^-1 * v * q
inline Vec3 quat_rotate_inverse(const Quat& q, const Vec3& v) {
    return quat_rotate(quat_conjugate(q), v);
}

// Create quaternion from axis-angle
inline Quat quat_from_axis_angle(const Vec3& axis, double angle) {
    Vec3 a = normalized(axis);
    double half = angle * 0.5;
    double s = std::sin(half);
    return Quat{std::cos(half), a.x * s, a.y * s, a.z * s};
}

// Create quaternion from Euler angles (ZYX convention: yaw, pitch, roll)
inline Quat quat_from_euler(double roll, double pitch, double yaw) {
    double cr = std::cos(roll * 0.5),  sr = std::sin(roll * 0.5);
    double cp = std::cos(pitch * 0.5), sp = std::sin(pitch * 0.5);
    double cy = std::cos(yaw * 0.5),   sy = std::sin(yaw * 0.5);

    return Quat{
        cr * cp * cy + sr * sp * sy,
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy
    };
}

// Extract Euler angles (ZYX) from quaternion
// Returns {roll, pitch, yaw} in radians
inline Vec3 quat_to_euler(const Quat& q) {
    // Roll (x-axis)
    double sinr_cosp = 2.0 * (q.w * q.x + q.y * q.z);
    double cosr_cosp = 1.0 - 2.0 * (q.x * q.x + q.y * q.y);
    double roll = std::atan2(sinr_cosp, cosr_cosp);

    // Pitch (y-axis)
    double sinp = 2.0 * (q.w * q.y - q.z * q.x);
    double pitch;
    if (std::abs(sinp) >= 1.0)
        pitch = std::copysign(3.14159265358979323846 / 2.0, sinp);
    else
        pitch = std::asin(sinp);

    // Yaw (z-axis)
    double siny_cosp = 2.0 * (q.w * q.z + q.x * q.y);
    double cosy_cosp = 1.0 - 2.0 * (q.y * q.y + q.z * q.z);
    double yaw = std::atan2(siny_cosp, cosy_cosp);

    return Vec3{roll, pitch, yaw};
}

}  // namespace sim

#endif  // SIM_VEC3_OPS_HPP
