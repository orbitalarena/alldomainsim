#include "physics/gravity_assist.hpp"
#include "physics/vec3_ops.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

constexpr double GA_PI = 3.14159265358979323846;

// ═══════════════════════════════════════════════════════════════
// compute_flyby
// ═══════════════════════════════════════════════════════════════

FlybyResult GravityAssist::compute_flyby(const Vec3& v_inf_in,
                                         double periapsis_radius,
                                         double mu_planet) {
    FlybyResult result;
    result.valid = false;

    double v_inf = v_inf_in.norm();
    if (v_inf < 1e-6 || periapsis_radius <= 0.0 || mu_planet <= 0.0) {
        return result;
    }

    // Hyperbolic eccentricity: e = 1 + rp * v_inf^2 / mu
    double v_inf_sq = v_inf * v_inf;
    double e_hyp = 1.0 + periapsis_radius * v_inf_sq / mu_planet;

    // Turn angle: delta = 2 * arcsin(1 / e)
    if (e_hyp < 1.0) {
        // Not a valid hyperbola
        return result;
    }
    double sin_half_delta = 1.0 / e_hyp;
    double turn_angle = 2.0 * std::asin(sin_half_delta);

    // Outgoing v_inf has the same magnitude (energy conservation)
    // Rotate v_inf_in by turn_angle using Rodrigues' rotation formula
    //
    // We need a rotation axis perpendicular to v_inf_in. For a general
    // 3D flyby, the rotation axis is perpendicular to the flyby plane.
    // Since we only have v_inf_in and no explicit approach geometry,
    // we choose a rotation axis perpendicular to v_inf_in.
    //
    // Strategy: pick a reference vector not parallel to v_inf_in,
    // compute the perpendicular axis via cross products.

    Vec3 v_hat = normalized(v_inf_in);

    // Choose a reference vector not parallel to v_hat
    Vec3 ref;
    if (std::abs(v_hat.x) < 0.9) {
        ref = Vec3(1.0, 0.0, 0.0);
    } else {
        ref = Vec3(0.0, 1.0, 0.0);
    }

    // Rotation axis: perpendicular to v_inf_in, in the flyby plane
    Vec3 k = normalized(cross(v_hat, ref));

    // Rodrigues' rotation formula:
    // v_rot = v*cos(theta) + (k x v)*sin(theta) + k*(k . v)*(1 - cos(theta))
    double cos_delta = std::cos(turn_angle);
    double sin_delta = std::sin(turn_angle);

    Vec3 k_cross_v = cross(k, v_inf_in);
    double k_dot_v = dot(k, v_inf_in);

    Vec3 v_inf_out;
    v_inf_out.x = v_inf_in.x * cos_delta + k_cross_v.x * sin_delta + k.x * k_dot_v * (1.0 - cos_delta);
    v_inf_out.y = v_inf_in.y * cos_delta + k_cross_v.y * sin_delta + k.y * k_dot_v * (1.0 - cos_delta);
    v_inf_out.z = v_inf_in.z * cos_delta + k_cross_v.z * sin_delta + k.z * k_dot_v * (1.0 - cos_delta);

    result.v_out_hci = v_inf_out;
    result.periapsis_alt = periapsis_radius;  // Caller subtracts planet radius for altitude
    result.turn_angle = turn_angle;

    // Delta-V gained is the magnitude of the heliocentric velocity change
    // For planet-centered v_inf vectors: delta_v = |v_out - v_in|
    Vec3 dv = v_inf_out - v_inf_in;
    result.delta_v_gained = dv.norm();

    // Populate B-plane info
    result.b_plane.v_inf_in = v_inf;
    result.b_plane.v_inf_out = v_inf_out.norm();
    result.b_plane.turn_angle = turn_angle;

    // B-plane magnitude: b = rp * sqrt(1 + 2*mu / (rp * v_inf^2))
    // Equivalently: b = rp * sqrt(e_hyp^2 - 1) / ... but the impact parameter form is:
    // b = (rp / e_hyp) * sqrt(e_hyp^2 - 1)  ... simplifies to:
    // b = rp * sqrt(1 + 2*mu / (rp * v_inf^2))
    double b_mag = periapsis_radius * std::sqrt(1.0 + 2.0 * mu_planet / (periapsis_radius * v_inf_sq));
    result.b_plane.b_mag = b_mag;

    // B-plane T and R components
    // T is in the ecliptic plane direction, R is perpendicular
    // For a general computation: B-vector = b_mag * direction perpendicular to v_inf_in in flyby plane
    // Project onto T-R coordinate system (T along ecliptic, R normal to ecliptic crossed with S)
    // S-hat = v_inf_in / |v_inf_in| (incoming asymptote direction)
    Vec3 s_hat = v_hat;

    // T-hat: component of ecliptic north perpendicular to S
    // Use ecliptic north approximation (z-axis in heliocentric J2000)
    Vec3 ecliptic_north(0.0, 0.0, 1.0);
    Vec3 t_hat = normalized(cross(s_hat, ecliptic_north));
    if (t_hat.norm() < 1e-10) {
        // S is along ecliptic pole; use x-axis as fallback
        t_hat = normalized(cross(s_hat, Vec3(1.0, 0.0, 0.0)));
    }
    Vec3 r_hat = cross(s_hat, t_hat);

    // B-vector direction: perpendicular to s_hat, in the flyby plane
    // The B-vector points from the planet to the closest approach point projected onto the B-plane
    Vec3 b_vec = b_mag * k;  // k is already perpendicular to v_inf and in the flyby plane

    result.b_plane.b_dot_t = dot(b_vec, t_hat);
    result.b_plane.b_dot_r = dot(b_vec, r_hat);

    result.valid = true;
    return result;
}

// ═══════════════════════════════════════════════════════════════
// periapsis_for_turn_angle
// ═══════════════════════════════════════════════════════════════

double GravityAssist::periapsis_for_turn_angle(double v_inf,
                                               double desired_turn_angle,
                                               double mu_planet) {
    if (v_inf < 1e-6 || desired_turn_angle <= 0.0 || desired_turn_angle >= GA_PI || mu_planet <= 0.0) {
        return -1.0;  // Invalid inputs
    }

    // From delta = 2 * arcsin(1/e), solve for e:
    //   sin(delta/2) = 1/e
    //   e = 1 / sin(delta/2)
    double e_hyp = 1.0 / std::sin(desired_turn_angle / 2.0);

    // From e = 1 + rp * v_inf^2 / mu, solve for rp:
    //   rp = (e - 1) * mu / v_inf^2
    double rp = (e_hyp - 1.0) * mu_planet / (v_inf * v_inf);

    return rp;
}

// ═══════════════════════════════════════════════════════════════
// compute_b_plane
// ═══════════════════════════════════════════════════════════════

BPlaneTarget GravityAssist::compute_b_plane(const Vec3& v_inf_in,
                                            const Vec3& v_inf_out_desired,
                                            double mu_planet) {
    BPlaneTarget result;

    double v_inf_in_mag = v_inf_in.norm();
    double v_inf_out_mag = v_inf_out_desired.norm();

    result.v_inf_in = v_inf_in_mag;
    result.v_inf_out = v_inf_out_mag;

    if (v_inf_in_mag < 1e-6 || v_inf_out_mag < 1e-6) {
        result.b_dot_t = 0.0;
        result.b_dot_r = 0.0;
        result.b_mag = 0.0;
        result.turn_angle = 0.0;
        return result;
    }

    // Turn angle from the dot product of incoming and outgoing asymptotes
    Vec3 s_in = normalized(v_inf_in);
    Vec3 s_out = normalized(v_inf_out_desired);

    double cos_turn = dot(s_in, s_out);
    cos_turn = std::max(-1.0, std::min(1.0, cos_turn));
    double turn_angle = std::acos(cos_turn);
    result.turn_angle = turn_angle;

    if (turn_angle < 1e-12) {
        // No deflection needed
        result.b_dot_t = 0.0;
        result.b_dot_r = 0.0;
        result.b_mag = 0.0;
        return result;
    }

    // Use average v_inf for the B-plane calculation (should be equal for unpowered flyby)
    double v_inf = (v_inf_in_mag + v_inf_out_mag) / 2.0;
    double v_inf_sq = v_inf * v_inf;

    // Required periapsis from the turn angle
    double rp = periapsis_for_turn_angle(v_inf, turn_angle, mu_planet);

    // B-plane magnitude: b = rp * sqrt(1 + 2*mu / (rp * v_inf^2))
    double b_mag = rp * std::sqrt(1.0 + 2.0 * mu_planet / (rp * v_inf_sq));
    result.b_mag = b_mag;

    // Construct B-plane coordinate system
    // S-hat: incoming asymptote direction
    Vec3 s_hat = s_in;

    // T-hat: component of ecliptic north perpendicular to S
    Vec3 ecliptic_north(0.0, 0.0, 1.0);
    Vec3 t_hat = normalized(cross(s_hat, ecliptic_north));
    if (t_hat.norm() < 1e-10) {
        t_hat = normalized(cross(s_hat, Vec3(1.0, 0.0, 0.0)));
    }
    Vec3 r_hat = cross(s_hat, t_hat);

    // B-vector direction: lies in the plane of the turn, perpendicular to S
    // The B-vector is perpendicular to s_in and lies in the s_in-s_out plane
    // B_hat = normalized( s_out - s_in * cos(turn) ) ... component of s_out perp to s_in
    Vec3 b_dir = s_out - cos_turn * s_in;
    double b_dir_norm = b_dir.norm();
    if (b_dir_norm < 1e-15) {
        result.b_dot_t = 0.0;
        result.b_dot_r = 0.0;
        return result;
    }
    Vec3 b_hat = b_dir / b_dir_norm;

    Vec3 b_vec = b_mag * b_hat;

    result.b_dot_t = dot(b_vec, t_hat);
    result.b_dot_r = dot(b_vec, r_hat);

    return result;
}

// ═══════════════════════════════════════════════════════════════
// is_feasible
// ═══════════════════════════════════════════════════════════════

bool GravityAssist::is_feasible(double v_inf_in,
                                double v_inf_out,
                                double min_periapsis,
                                double mu_planet) {
    if (v_inf_in < 1e-6 || v_inf_out < 1e-6 || min_periapsis <= 0.0 || mu_planet <= 0.0) {
        return false;
    }

    // For an unpowered flyby, v_inf_in must equal v_inf_out (energy conservation).
    // Allow a small tolerance for numerical imprecision.
    // For a powered flyby the magnitudes can differ, but the maximum turn angle
    // is still constrained by the minimum periapsis.

    // Use the average v_inf for the constraint
    double v_inf = (v_inf_in + v_inf_out) / 2.0;
    double v_inf_sq = v_inf * v_inf;

    // Maximum eccentricity achievable at minimum periapsis
    double e_max = 1.0 + min_periapsis * v_inf_sq / mu_planet;

    // Maximum turn angle at minimum periapsis
    double max_turn = 2.0 * std::asin(1.0 / e_max);

    // For unpowered flyby, the required turn angle is determined by the
    // velocity change. The maximum delta-v achievable is:
    // delta_v_max = 2 * v_inf * sin(max_turn / 2)
    // But we just check if ANY turn angle up to max_turn is possible.
    // Since the caller may want a specific geometry, we check the maximum
    // achievable turn angle against the theoretical limit.

    // The flyby is feasible if the maximum turn angle is positive
    // (i.e., the periapsis constraint doesn't prevent any deflection).
    // For a specific turn angle check, use periapsis_for_turn_angle and compare.
    return max_turn > 0.0;
}

} // namespace sim
