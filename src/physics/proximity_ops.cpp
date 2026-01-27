#include "physics/proximity_ops.hpp"
#include "physics/orbital_elements.hpp"
#include <cmath>
#include <iostream>

namespace sim {

constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;

RelativeState ProximityOps::inertial_to_lvlh(const StateVector& chaser_state,
                                              const StateVector& target_state) {
    RelativeState rel;

    // Target position and velocity
    Vec3 r_t = target_state.position;
    Vec3 v_t = target_state.velocity;

    // Chaser position and velocity
    Vec3 r_c = chaser_state.position;
    Vec3 v_c = chaser_state.velocity;

    // Relative position in ECI
    Vec3 dr;
    dr.x = r_c.x - r_t.x;
    dr.y = r_c.y - r_t.y;
    dr.z = r_c.z - r_t.z;

    // Relative velocity in ECI
    Vec3 dv;
    dv.x = v_c.x - v_t.x;
    dv.y = v_c.y - v_t.y;
    dv.z = v_c.z - v_t.z;

    // RIC (Radial-Intrack-Crosstrack) unit vectors
    double r_mag = r_t.norm();
    double v_mag = v_t.norm();

    // R: Radial (outward from central body)
    Vec3 x_hat;
    x_hat.x = r_t.x / r_mag;
    x_hat.y = r_t.y / r_mag;
    x_hat.z = r_t.z / r_mag;

    // C: Cross-track (r x v, angular momentum / orbit normal direction)
    Vec3 h;
    h.x = r_t.y * v_t.z - r_t.z * v_t.y;
    h.y = r_t.z * v_t.x - r_t.x * v_t.z;
    h.z = r_t.x * v_t.y - r_t.y * v_t.x;
    double h_mag = h.norm();

    Vec3 z_hat;
    z_hat.x = h.x / h_mag;
    z_hat.y = h.y / h_mag;
    z_hat.z = h.z / h_mag;

    // I: In-track (C x R, approximately along velocity)
    Vec3 y_hat;
    y_hat.x = z_hat.y * x_hat.z - z_hat.z * x_hat.y;
    y_hat.y = z_hat.z * x_hat.x - z_hat.x * x_hat.z;
    y_hat.z = z_hat.x * x_hat.y - z_hat.y * x_hat.x;

    // Transform position to RIC (x=R, y=I, z=C)
    rel.position.x = dr.x * x_hat.x + dr.y * x_hat.y + dr.z * x_hat.z;
    rel.position.y = dr.x * y_hat.x + dr.y * y_hat.y + dr.z * y_hat.z;
    rel.position.z = dr.x * z_hat.x + dr.y * z_hat.y + dr.z * z_hat.z;

    // Transform velocity to RIC (inertial, not accounting for frame rotation)
    rel.velocity.x = dv.x * x_hat.x + dv.y * x_hat.y + dv.z * x_hat.z;
    rel.velocity.y = dv.x * y_hat.x + dv.y * y_hat.y + dv.z * y_hat.z;
    rel.velocity.z = dv.x * z_hat.x + dv.y * z_hat.y + dv.z * z_hat.z;

    return rel;
}

Vec3 ProximityOps::lvlh_to_inertial_dv(const Vec3& dv_lvlh,
                                        const StateVector& target_state) {
    Vec3 r_t = target_state.position;
    Vec3 v_t = target_state.velocity;

    double r_mag = r_t.norm();

    // RIC unit vectors (R=radial, I=in-track, C=cross-track)
    Vec3 x_hat;  // R
    x_hat.x = r_t.x / r_mag;
    x_hat.y = r_t.y / r_mag;
    x_hat.z = r_t.z / r_mag;

    Vec3 h;
    h.x = r_t.y * v_t.z - r_t.z * v_t.y;
    h.y = r_t.z * v_t.x - r_t.x * v_t.z;
    h.z = r_t.x * v_t.y - r_t.y * v_t.x;
    double h_mag = h.norm();

    Vec3 z_hat;  // C
    z_hat.x = h.x / h_mag;
    z_hat.y = h.y / h_mag;
    z_hat.z = h.z / h_mag;

    Vec3 y_hat;  // I = C x R
    y_hat.x = z_hat.y * x_hat.z - z_hat.z * x_hat.y;
    y_hat.y = z_hat.z * x_hat.x - z_hat.x * x_hat.z;
    y_hat.z = z_hat.x * x_hat.y - z_hat.y * x_hat.x;

    // Transform RIC to ECI
    Vec3 dv_eci;
    dv_eci.x = dv_lvlh.x * x_hat.x + dv_lvlh.y * y_hat.x + dv_lvlh.z * z_hat.x;
    dv_eci.y = dv_lvlh.x * x_hat.y + dv_lvlh.y * y_hat.y + dv_lvlh.z * z_hat.y;
    dv_eci.z = dv_lvlh.x * x_hat.z + dv_lvlh.y * y_hat.z + dv_lvlh.z * z_hat.z;

    return dv_eci;
}

RelativeState ProximityOps::propagate_cw(const RelativeState& initial,
                                          double n, double dt) {
    RelativeState result;
    // Delegate to CWTargeting's STM-based propagation
    CWTargeting::propagate_relative_state(
        initial.position, initial.velocity, n, dt,
        result.position, result.velocity);
    return result;
}

std::pair<Vec3, Vec3> ProximityOps::cw_transfer(const Vec3& r0, const Vec3& rf,
                                                 double tof, double n) {
    // Use CWTargeting's STM for the underlying CW math
    CWStateMatrix m = CWTargeting::compute_state_matrix(n, tof);

    // Solve: rf = Phi_rr * r0 + Phi_rv * v0
    // =>     Phi_rv * v0 = rf - Phi_rr * r0
    Vec3 rhs;
    rhs.x = rf.x - (m.Phi_rr[0][0] * r0.x + m.Phi_rr[0][1] * r0.y + m.Phi_rr[0][2] * r0.z);
    rhs.y = rf.y - (m.Phi_rr[1][0] * r0.x + m.Phi_rr[1][1] * r0.y + m.Phi_rr[1][2] * r0.z);
    rhs.z = rf.z - (m.Phi_rr[2][0] * r0.x + m.Phi_rr[2][1] * r0.y + m.Phi_rr[2][2] * r0.z);

    // Solve 2x2 in-plane system (R, I) + decoupled cross-track (C)
    double det = m.Phi_rv[0][0] * m.Phi_rv[1][1] - m.Phi_rv[0][1] * m.Phi_rv[1][0];

    Vec3 v0;
    v0.x = (m.Phi_rv[1][1] * rhs.x - m.Phi_rv[0][1] * rhs.y) / det;
    v0.y = (-m.Phi_rv[1][0] * rhs.x + m.Phi_rv[0][0] * rhs.y) / det;
    v0.z = rhs.z / m.Phi_rv[2][2];

    // Final velocity from CW propagation
    RelativeState initial;
    initial.position = r0;
    initial.velocity = v0;
    RelativeState final_state = propagate_cw(initial, n, tof);

    // dv1 = required initial velocity (assumes starting from rest)
    // dv2 = stop burn at arrival
    Vec3 dv1 = v0;
    Vec3 dv2;
    dv2.x = -final_state.velocity.x;
    dv2.y = -final_state.velocity.y;
    dv2.z = -final_state.velocity.z;

    return std::make_pair(dv1, dv2);
}

ProxOpsTrajectory ProximityOps::plan_circumnavigation(const Vec3& start_pos,
                                                       double radius,
                                                       int num_waypoints,
                                                       double n) {
    ProxOpsTrajectory traj;
    traj.total_delta_v = 0.0;
    traj.total_time = 0.0;

    // Generate waypoints in a circle in the R-I plane (radial-intrack)
    double angle_step = TWO_PI / num_waypoints;

    // Time between waypoints (fraction of orbital period)
    double orbital_period = TWO_PI / n;
    double leg_time = orbital_period / num_waypoints;

    Vec3 current_pos = start_pos;

    for (int i = 0; i < num_waypoints; i++) {
        double angle = i * angle_step;

        ProxOpsWaypoint wp;
        wp.position.x = radius * std::cos(angle);  // Radial
        wp.position.y = radius * std::sin(angle);  // Along-track
        wp.position.z = 0.0;                        // Cross-track
        wp.hold_time = 60.0;  // 1 minute hold at each waypoint
        wp.approach_v = 1.0;  // 1 m/s approach

        traj.waypoints.push_back(wp);

        // Compute transfer to this waypoint
        auto [dv1, dv2] = cw_transfer(current_pos, wp.position, leg_time, n);

        // Combined delta-V for this leg
        Vec3 leg_dv;
        leg_dv.x = dv1.x + dv2.x;
        leg_dv.y = dv1.y + dv2.y;
        leg_dv.z = dv1.z + dv2.z;

        traj.delta_vs.push_back(leg_dv);
        traj.transfer_times.push_back(leg_time);

        double leg_dv_mag = std::sqrt(dv1.x*dv1.x + dv1.y*dv1.y + dv1.z*dv1.z) +
                           std::sqrt(dv2.x*dv2.x + dv2.y*dv2.y + dv2.z*dv2.z);
        traj.total_delta_v += leg_dv_mag;
        traj.total_time += leg_time + wp.hold_time;

        current_pos = wp.position;
    }

    std::cout << "Circumnavigation trajectory planned:" << std::endl;
    std::cout << "  Radius: " << radius << " m" << std::endl;
    std::cout << "  Waypoints: " << num_waypoints << std::endl;
    std::cout << "  Total time: " << traj.total_time << " s (" << traj.total_time/3600.0 << " hr)" << std::endl;
    std::cout << "  Total delta-V: " << traj.total_delta_v << " m/s" << std::endl;

    return traj;
}

ProxOpsTrajectory ProximityOps::plan_vbar_approach(const Vec3& current_pos,
                                                    double final_range,
                                                    double approach_rate,
                                                    double n) {
    ProxOpsTrajectory traj;

    // V-bar approach: along the velocity vector (Y-axis in LVLH)
    // Move to behind/ahead of target, then approach along V-bar

    ProxOpsWaypoint wp;
    wp.position.x = 0.0;          // No radial offset
    wp.position.y = final_range;  // Along-track
    wp.position.z = 0.0;
    wp.hold_time = 0.0;
    wp.approach_v = approach_rate;

    double dist = std::sqrt(
        std::pow(wp.position.x - current_pos.x, 2) +
        std::pow(wp.position.y - current_pos.y, 2) +
        std::pow(wp.position.z - current_pos.z, 2)
    );

    double transfer_time = dist / approach_rate;

    traj.waypoints.push_back(wp);
    traj.transfer_times.push_back(transfer_time);

    auto [dv1, dv2] = cw_transfer(current_pos, wp.position, transfer_time, n);

    Vec3 leg_dv;
    leg_dv.x = dv1.x + dv2.x;
    leg_dv.y = dv1.y + dv2.y;
    leg_dv.z = dv1.z + dv2.z;

    traj.delta_vs.push_back(leg_dv);
    traj.total_delta_v = leg_dv.norm();
    traj.total_time = transfer_time;

    return traj;
}

ProxOpsTrajectory ProximityOps::plan_rbar_approach(const Vec3& current_pos,
                                                    double final_range,
                                                    double approach_rate,
                                                    double n) {
    ProxOpsTrajectory traj;

    // R-bar approach: along radial vector (X-axis in LVLH)
    // Approach from above or below

    ProxOpsWaypoint wp;
    wp.position.x = final_range;  // Radial offset (above target)
    wp.position.y = 0.0;
    wp.position.z = 0.0;
    wp.hold_time = 0.0;
    wp.approach_v = approach_rate;

    double dist = std::sqrt(
        std::pow(wp.position.x - current_pos.x, 2) +
        std::pow(wp.position.y - current_pos.y, 2) +
        std::pow(wp.position.z - current_pos.z, 2)
    );

    double transfer_time = dist / approach_rate;

    traj.waypoints.push_back(wp);
    traj.transfer_times.push_back(transfer_time);

    auto [dv1, dv2] = cw_transfer(current_pos, wp.position, transfer_time, n);

    Vec3 leg_dv;
    leg_dv.x = dv1.x + dv2.x;
    leg_dv.y = dv1.y + dv2.y;
    leg_dv.z = dv1.z + dv2.z;

    traj.delta_vs.push_back(leg_dv);
    traj.total_delta_v = leg_dv.norm();
    traj.total_time = transfer_time;

    return traj;
}

Vec3 ProximityOps::station_keeping_dv(const RelativeState& rel_state,
                                       const Vec3& target_pos, double n) {
    // Compute delta-V to null drift and move to target position
    // For now, simple proportional control

    Vec3 dv;
    double k_p = 0.01;  // Position gain
    double k_v = 0.1;   // Velocity gain

    dv.x = k_p * (target_pos.x - rel_state.position.x) - k_v * rel_state.velocity.x;
    dv.y = k_p * (target_pos.y - rel_state.position.y) - k_v * rel_state.velocity.y;
    dv.z = k_p * (target_pos.z - rel_state.position.z) - k_v * rel_state.velocity.z;

    return dv;
}

double ProximityOps::compute_mean_motion(const StateVector& target_state, double mu) {
    OrbitalElements elem = OrbitalMechanics::state_to_elements(target_state, mu);
    return std::sqrt(mu / std::pow(elem.semi_major_axis, 3));
}

std::tuple<double, double, double> ProximityOps::football_orbit(double x0, double n) {
    // Natural motion from pure radial offset creates a 2:1 ellipse (football orbit)
    double along_track_amplitude = 2.0 * x0;  // Y amplitude is 2x radial
    double radial_amplitude = x0;
    double period = TWO_PI / n;

    return std::make_tuple(along_track_amplitude, radial_amplitude, period);
}

} // namespace sim
