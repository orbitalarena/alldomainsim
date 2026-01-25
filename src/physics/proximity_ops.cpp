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

    // LVLH unit vectors
    double r_mag = r_t.norm();
    double v_mag = v_t.norm();

    // X: Radial (outward)
    Vec3 x_hat;
    x_hat.x = r_t.x / r_mag;
    x_hat.y = r_t.y / r_mag;
    x_hat.z = r_t.z / r_mag;

    // Z: Cross-track (r x v, angular momentum direction)
    Vec3 h;
    h.x = r_t.y * v_t.z - r_t.z * v_t.y;
    h.y = r_t.z * v_t.x - r_t.x * v_t.z;
    h.z = r_t.x * v_t.y - r_t.y * v_t.x;
    double h_mag = h.norm();

    Vec3 z_hat;
    z_hat.x = h.x / h_mag;
    z_hat.y = h.y / h_mag;
    z_hat.z = h.z / h_mag;

    // Y: Along-track (z x x)
    Vec3 y_hat;
    y_hat.x = z_hat.y * x_hat.z - z_hat.z * x_hat.y;
    y_hat.y = z_hat.z * x_hat.x - z_hat.x * x_hat.z;
    y_hat.z = z_hat.x * x_hat.y - z_hat.y * x_hat.x;

    // Transform position to LVLH
    rel.position.x = dr.x * x_hat.x + dr.y * x_hat.y + dr.z * x_hat.z;
    rel.position.y = dr.x * y_hat.x + dr.y * y_hat.y + dr.z * y_hat.z;
    rel.position.z = dr.x * z_hat.x + dr.y * z_hat.y + dr.z * z_hat.z;

    // Transform velocity to LVLH (need to account for rotating frame)
    // For simplicity, just transform the velocity difference
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

    // LVLH unit vectors
    Vec3 x_hat;
    x_hat.x = r_t.x / r_mag;
    x_hat.y = r_t.y / r_mag;
    x_hat.z = r_t.z / r_mag;

    Vec3 h;
    h.x = r_t.y * v_t.z - r_t.z * v_t.y;
    h.y = r_t.z * v_t.x - r_t.x * v_t.z;
    h.z = r_t.x * v_t.y - r_t.y * v_t.x;
    double h_mag = h.norm();

    Vec3 z_hat;
    z_hat.x = h.x / h_mag;
    z_hat.y = h.y / h_mag;
    z_hat.z = h.z / h_mag;

    Vec3 y_hat;
    y_hat.x = z_hat.y * x_hat.z - z_hat.z * x_hat.y;
    y_hat.y = z_hat.z * x_hat.x - z_hat.x * x_hat.z;
    y_hat.z = z_hat.x * x_hat.y - z_hat.y * x_hat.x;

    // Transform back to ECI
    Vec3 dv_eci;
    dv_eci.x = dv_lvlh.x * x_hat.x + dv_lvlh.y * y_hat.x + dv_lvlh.z * z_hat.x;
    dv_eci.y = dv_lvlh.x * x_hat.y + dv_lvlh.y * y_hat.y + dv_lvlh.z * z_hat.y;
    dv_eci.z = dv_lvlh.x * x_hat.z + dv_lvlh.y * y_hat.z + dv_lvlh.z * z_hat.z;

    return dv_eci;
}

RelativeState ProximityOps::propagate_cw(const RelativeState& initial,
                                          double n, double dt) {
    RelativeState result;

    double x0 = initial.position.x;
    double y0 = initial.position.y;
    double z0 = initial.position.z;
    double vx0 = initial.velocity.x;
    double vy0 = initial.velocity.y;
    double vz0 = initial.velocity.z;

    double nt = n * dt;
    double cos_nt = std::cos(nt);
    double sin_nt = std::sin(nt);

    // CW equations for position
    result.position.x = (4.0 - 3.0*cos_nt)*x0 + sin_nt/n*vx0 + 2.0/n*(1.0 - cos_nt)*vy0;
    result.position.y = 6.0*(sin_nt - nt)*x0 + y0 - 2.0/n*(1.0 - cos_nt)*vx0 + (4.0*sin_nt/n - 3.0*dt)*vy0;
    result.position.z = z0*cos_nt + vz0/n*sin_nt;

    // CW equations for velocity
    result.velocity.x = 3.0*n*sin_nt*x0 + cos_nt*vx0 + 2.0*sin_nt*vy0;
    result.velocity.y = 6.0*n*(cos_nt - 1.0)*x0 - 2.0*sin_nt*vx0 + (4.0*cos_nt - 3.0)*vy0;
    result.velocity.z = -z0*n*sin_nt + vz0*cos_nt;

    return result;
}

std::pair<Vec3, Vec3> ProximityOps::cw_transfer(const Vec3& r0, const Vec3& rf,
                                                 double tof, double n) {
    double nt = n * tof;
    double cos_nt = std::cos(nt);
    double sin_nt = std::sin(nt);

    // CW state transition matrix components for position-to-velocity
    // We need to solve for v0 given r0 and rf

    // Phi_rv (position part of STM that depends on velocity)
    double phi_11 = sin_nt / n;
    double phi_12 = 2.0 * (1.0 - cos_nt) / n;
    double phi_21 = -2.0 * (1.0 - cos_nt) / n;
    double phi_22 = (4.0 * sin_nt - 3.0 * n * tof) / n;
    double phi_33 = sin_nt / n;

    // Phi_rr (position part of STM that depends on position)
    double psi_11 = 4.0 - 3.0 * cos_nt;
    double psi_12 = 0.0;
    double psi_21 = 6.0 * (sin_nt - n * tof);
    double psi_22 = 1.0;
    double psi_33 = cos_nt;

    // Target position after subtracting position propagation from r0
    Vec3 rf_adj;
    rf_adj.x = rf.x - (psi_11 * r0.x + psi_12 * r0.y);
    rf_adj.y = rf.y - (psi_21 * r0.x + psi_22 * r0.y);
    rf_adj.z = rf.z - psi_33 * r0.z;

    // Solve 2x2 system for in-plane velocities
    double det = phi_11 * phi_22 - phi_12 * phi_21;

    Vec3 v0;
    v0.x = (phi_22 * rf_adj.x - phi_12 * rf_adj.y) / det;
    v0.y = (-phi_21 * rf_adj.x + phi_11 * rf_adj.y) / det;
    v0.z = rf_adj.z / phi_33;

    // Final velocity from CW propagation
    RelativeState initial;
    initial.position = r0;
    initial.velocity = v0;
    RelativeState final_state = propagate_cw(initial, n, tof);

    Vec3 vf = final_state.velocity;

    // Delta-V at start: v0 (we assumed starting from rest relative to natural motion)
    // For general case, would subtract initial velocity
    Vec3 dv1 = v0;

    // Delta-V at end: to stop at the waypoint
    Vec3 dv2;
    dv2.x = -vf.x;
    dv2.y = -vf.y;
    dv2.z = -vf.z;

    return std::make_pair(dv1, dv2);
}

ProxOpsTrajectory ProximityOps::plan_circumnavigation(const Vec3& start_pos,
                                                       double radius,
                                                       int num_waypoints,
                                                       double n) {
    ProxOpsTrajectory traj;
    traj.total_delta_v = 0.0;
    traj.total_time = 0.0;

    // Generate waypoints in a circle in the LVLH X-Y plane (radial-alongtrack)
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
