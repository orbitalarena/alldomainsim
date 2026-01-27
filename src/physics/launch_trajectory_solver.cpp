/**
 * Nonlinear Launch-to-Intercept/Rendezvous Trajectory Solver
 *
 * Implementation of Newton-Raphson differential correction with numerical
 * Jacobian for launch trajectory optimization.
 */

#include "launch_trajectory_solver.hpp"
#include "physics/gravity_utils.hpp"
#include "physics/atmosphere_model.hpp"
#include "physics/maneuver_planner.hpp"
#include "coordinate/frame_transformer.hpp"
#include "coordinate/time_utils.hpp"
#include <cmath>
#include <iostream>
#include <iomanip>
#include <algorithm>

namespace sim {

// ============================================================
// Constants
// ============================================================

static constexpr double PI = 3.14159265358979323846;
static constexpr double G0 = 9.80665;
static constexpr double EARTH_OMEGA = 7.2921159e-5;  // rad/s
static constexpr double EARTH_RADIUS = 6378137.0;    // m
static constexpr double MU = 3.986004418e14;         // m^3/s^2
static constexpr double GRAVITY_TURN_START_ALT = 1000.0; // m

// ============================================================
// LaunchSite
// ============================================================

StateVector LaunchSite::compute_eci_state(double epoch_jd) const {
    double lat_rad = latitude_deg * PI / 180.0;
    double lon_rad = longitude_deg * PI / 180.0;

    // Geodetic to ECEF (WGS84)
    double a = EARTH_RADIUS;
    double f = 1.0 / 298.257223563;
    double e2 = 2.0 * f - f * f;
    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N = a / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    double x_ecef = (N + altitude_m) * cos_lat * std::cos(lon_rad);
    double y_ecef = (N + altitude_m) * cos_lat * std::sin(lon_rad);
    double z_ecef = (N * (1.0 - e2) + altitude_m) * sin_lat;

    // ECEF to ECI via GMST rotation
    double gmst = TimeUtils::compute_gmst(epoch_jd);

    double cos_g = std::cos(gmst);
    double sin_g = std::sin(gmst);

    StateVector state;
    state.position.x = x_ecef * cos_g - y_ecef * sin_g;
    state.position.y = x_ecef * sin_g + y_ecef * cos_g;
    state.position.z = z_ecef;

    // Velocity from Earth rotation: v = omega x r (in ECI)
    state.velocity.x = -EARTH_OMEGA * state.position.y;
    state.velocity.y =  EARTH_OMEGA * state.position.x;
    state.velocity.z = 0.0;

    state.frame = CoordinateFrame::J2000_ECI;
    return state;
}

// ============================================================
// LaunchControls
// ============================================================

void LaunchControls::to_array(double x[N_CONTROLS]) const {
    x[0] = launch_azimuth;
    x[1] = pitch_s1[0]; x[2] = pitch_s1[1]; x[3] = pitch_s1[2];
    x[4] = pitch_s2[0]; x[5] = pitch_s2[1]; x[6] = pitch_s2[2];
    x[7] = yaw_s1[0]; x[8] = yaw_s1[1];
    x[9] = yaw_s2[0]; x[10] = yaw_s2[1];
    x[11] = coast_after_burnout;
    x[12] = epoch_offset;
}

void LaunchControls::from_array(const double x[N_CONTROLS]) {
    launch_azimuth = x[0];
    pitch_s1[0] = x[1]; pitch_s1[1] = x[2]; pitch_s1[2] = x[3];
    pitch_s2[0] = x[4]; pitch_s2[1] = x[5]; pitch_s2[2] = x[6];
    yaw_s1[0] = x[7]; yaw_s1[1] = x[8];
    yaw_s2[0] = x[9]; yaw_s2[1] = x[10];
    coast_after_burnout = x[11];
    epoch_offset = x[12];
}

LaunchControls LaunchControls::default_guess(double target_inc_rad,
                                              double launch_lat_rad) {
    LaunchControls c;

    // Launch azimuth from target inclination
    double cos_inc = std::cos(target_inc_rad);
    double cos_lat = std::cos(launch_lat_rad);
    double sin_az = (std::abs(cos_lat) > 1e-10) ? cos_inc / cos_lat : 0.0;
    if (sin_az > 1.0) sin_az = 1.0;
    if (sin_az < -1.0) sin_az = -1.0;
    c.launch_azimuth = std::asin(sin_az);
    // Prefer northeasterly launch for prograde
    if (c.launch_azimuth < 0.0) c.launch_azimuth += PI;

    // Stage 1: steep climb through atmosphere
    // theta(tau) = p0 + p1*tau + p2*tau^2, tau in [0,1]
    // Goal: reach ~30° from vertical (0.5 rad) at end of S1 → still climbing steeply
    c.pitch_s1[0] = 0.05;   // ~3 deg initial pitch kick
    c.pitch_s1[1] = 0.20;   // slow turn rate (keep climbing)
    c.pitch_s1[2] = 0.25;   // gentle acceleration → reaches ~0.5 rad (29°)

    // Stage 2: lofted trajectory — climb steeply then flatten at target altitude
    // Starts at ~30° from vertical, ends horizontal (90°)
    // Slow turn initially (still climbing), faster turn later (flattening)
    c.pitch_s2[0] = 0.50;   // continue from S1 end angle
    c.pitch_s2[1] = 0.20;   // slow initial turn (keep gaining altitude)
    c.pitch_s2[2] = 0.87;   // accelerating turn → reaches 1.57 rad (90°)

    // No yaw steering initially
    c.yaw_s1[0] = 0.0; c.yaw_s1[1] = 0.0;
    c.yaw_s2[0] = 0.0; c.yaw_s2[1] = 0.0;

    c.coast_after_burnout = 0.0;
    c.epoch_offset = 0.0;

    return c;
}

// ============================================================
// TerminalTarget
// ============================================================

TerminalTarget::TerminalTarget()
    : mode(TargetingMode::ORBIT_INSERTION)
    , constrain_sma(true), constrain_ecc(true), constrain_inc(true)
    , constrain_raan(false), constrain_argp(false)
    , time_of_flight(3600.0)
    , position_tol(1000.0), velocity_tol(1.0)
{
}

int TerminalTarget::num_constraints() const {
    switch (mode) {
        case TargetingMode::ORBIT_INSERTION: {
            int n = 0;
            if (constrain_sma) n++;
            if (constrain_ecc) n++;
            if (constrain_inc) n++;
            if (constrain_raan) n++;
            if (constrain_argp) n++;
            return n;
        }
        case TargetingMode::POSITION_INTERCEPT:
            return 3;
        case TargetingMode::FULL_RENDEZVOUS:
            return 6;
    }
    return 0;
}

// ============================================================
// LaunchSolverConfig
// ============================================================

LaunchSolverConfig::LaunchSolverConfig()
    : max_iterations(30)
    , fd_step_size(5e-4)
    , convergence_tol(100.0)
    , use_line_search(true)
    , line_search_alpha(0.5)
    , line_search_max(8)
    , atmo_step_size(0.5)
    , vacuum_step_size(5.0)
    , verbose(false)
{
    // Default: free all controls except epoch_offset
    for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
        free_controls[i] = true;
    }
    free_controls[12] = false; // epoch_offset fixed by default
}

int LaunchSolverConfig::num_free_controls() const {
    int n = 0;
    for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
        if (free_controls[i]) n++;
    }
    return n;
}

// ============================================================
// Solver Constructor
// ============================================================

LaunchTrajectorySolver::LaunchTrajectorySolver(
    const SolverVehicleConfig& vehicle,
    const LaunchSite& site,
    double epoch_jd,
    const LaunchSolverConfig& config)
    : vehicle_(vehicle), site_(site), epoch_jd_(epoch_jd), config_(config)
{
}

// ============================================================
// Utilities
// ============================================================

double LaunchTrajectorySolver::eci_altitude(const Vec3& position) const {
    return position.norm() - EARTH_RADIUS;
}

Vec3 LaunchTrajectorySolver::earth_relative_velocity(
    const Vec3& position, const Vec3& velocity) const {
    // v_rel = v_eci - omega x r
    Vec3 v_rel;
    v_rel.x = velocity.x + EARTH_OMEGA * position.y;
    v_rel.y = velocity.y - EARTH_OMEGA * position.x;
    v_rel.z = velocity.z;
    return v_rel;
}

std::vector<double> LaunchTrajectorySolver::pack_free_controls(
    const LaunchControls& controls) const {
    double all[LaunchControls::N_CONTROLS];
    controls.to_array(all);
    std::vector<double> x;
    for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
        if (config_.free_controls[i]) {
            x.push_back(all[i]);
        }
    }
    return x;
}

void LaunchTrajectorySolver::unpack_free_controls(
    LaunchControls& controls, const std::vector<double>& x) const {
    double all[LaunchControls::N_CONTROLS];
    controls.to_array(all);
    int idx = 0;
    for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
        if (config_.free_controls[i]) {
            all[i] = x[idx++];
        }
    }
    controls.from_array(all);
}

// ============================================================
// Steering Law
// ============================================================

void LaunchTrajectorySolver::evaluate_steering(
    const LaunchState& state,
    const LaunchControls& controls,
    double& pitch, double& yaw) const {

    double alt = state.altitude;
    double t = state.time;

    // Vertical ascent phase
    if (alt < GRAVITY_TURN_START_ALT) {
        pitch = 0.0;
        yaw = 0.0;
        return;
    }

    // Estimate stage burn durations for segment timing
    double t_s1_burn = vehicle_.stages[0].burn_duration(30000.0);
    double t_turn_start = 10.0; // approximate time to reach 1km

    if (state.stage_index == 0 && state.engines_on) {
        // Stage 1: normalize time within gravity turn portion
        double tau = (t - t_turn_start) / (t_s1_burn - t_turn_start);
        if (tau < 0.0) tau = 0.0;
        if (tau > 1.0) tau = 1.0;
        pitch = controls.pitch_s1[0] + controls.pitch_s1[1] * tau
                + controls.pitch_s1[2] * tau * tau;
        yaw = controls.yaw_s1[0] + controls.yaw_s1[1] * tau;
    }
    else if (state.stage_index >= 1 && state.engines_on) {
        // Stage 2+: normalize time within this stage's burn
        double t_s2_start = t_s1_burn;
        double t_s2_burn = vehicle_.stages[std::min(state.stage_index,
                           (int)vehicle_.stages.size() - 1)].burn_duration(150000.0);
        double tau = (t - t_s2_start) / t_s2_burn;
        if (tau < 0.0) tau = 0.0;
        if (tau > 1.0) tau = 1.0;
        pitch = controls.pitch_s2[0] + controls.pitch_s2[1] * tau
                + controls.pitch_s2[2] * tau * tau;
        yaw = controls.yaw_s2[0] + controls.yaw_s2[1] * tau;
    }
    else {
        // Coast: no thrust, but return last angles
        pitch = controls.pitch_s2[0] + controls.pitch_s2[1] + controls.pitch_s2[2];
        yaw = 0.0;
    }

    // Clamp pitch to [0, pi/2]
    if (pitch < 0.0) pitch = 0.0;
    if (pitch > PI / 2.0) pitch = PI / 2.0;
}

Vec3 LaunchTrajectorySolver::compute_thrust_direction(
    const LaunchState& state,
    const LaunchControls& controls) const {

    double pitch, yaw;
    evaluate_steering(state, controls, pitch, yaw);

    Vec3 pos = state.position;
    Vec3 vel = state.velocity;
    double r_mag = pos.norm();

    // Radial unit vector (up)
    Vec3 r_hat;
    r_hat.x = pos.x / r_mag;
    r_hat.y = pos.y / r_mag;
    r_hat.z = pos.z / r_mag;

    // Downrange direction
    Vec3 d_hat, c_hat;
    double v_mag = vel.norm();

    if (v_mag > 500.0 && state.altitude > GRAVITY_TURN_START_ALT) {
        // Use velocity-based frame once velocity is established
        // Horizontal component of velocity
        double v_radial = vel.x * r_hat.x + vel.y * r_hat.y + vel.z * r_hat.z;
        Vec3 v_horiz;
        v_horiz.x = vel.x - v_radial * r_hat.x;
        v_horiz.y = vel.y - v_radial * r_hat.y;
        v_horiz.z = vel.z - v_radial * r_hat.z;
        double vh_mag = v_horiz.norm();
        if (vh_mag > 1.0) {
            d_hat.x = v_horiz.x / vh_mag;
            d_hat.y = v_horiz.y / vh_mag;
            d_hat.z = v_horiz.z / vh_mag;
        } else {
            // Fallback to azimuth-based
            goto azimuth_frame;
        }
    } else {
        azimuth_frame:
        // Use launch azimuth to define downrange direction
        // East unit vector in equatorial plane
        double e_x = -pos.y;
        double e_y =  pos.x;
        double e_z = 0.0;
        double e_mag = std::sqrt(e_x * e_x + e_y * e_y);
        if (e_mag < 1.0) { e_x = 0.0; e_y = 1.0; e_mag = 1.0; }
        Vec3 east;
        east.x = e_x / e_mag;
        east.y = e_y / e_mag;
        east.z = e_z / e_mag;

        // North = r_hat x east
        Vec3 north;
        north.x = r_hat.y * east.z - r_hat.z * east.y;
        north.y = r_hat.z * east.x - r_hat.x * east.z;
        north.z = r_hat.x * east.y - r_hat.y * east.x;

        double sin_az = std::sin(controls.launch_azimuth);
        double cos_az = std::cos(controls.launch_azimuth);
        d_hat.x = sin_az * east.x + cos_az * north.x;
        d_hat.y = sin_az * east.y + cos_az * north.y;
        d_hat.z = sin_az * east.z + cos_az * north.z;
    }

    // Cross-range = r_hat x d_hat
    c_hat.x = r_hat.y * d_hat.z - r_hat.z * d_hat.y;
    c_hat.y = r_hat.z * d_hat.x - r_hat.x * d_hat.z;
    c_hat.z = r_hat.x * d_hat.y - r_hat.y * d_hat.x;

    // Thrust direction: cos(pitch)*r_hat + sin(pitch)*(cos(yaw)*d_hat + sin(yaw)*c_hat)
    double cp = std::cos(pitch);
    double sp = std::sin(pitch);
    double cy = std::cos(yaw);
    double sy = std::sin(yaw);

    Vec3 t_dir;
    t_dir.x = cp * r_hat.x + sp * (cy * d_hat.x + sy * c_hat.x);
    t_dir.y = cp * r_hat.y + sp * (cy * d_hat.y + sy * c_hat.y);
    t_dir.z = cp * r_hat.z + sp * (cy * d_hat.z + sy * c_hat.z);

    // Normalize for safety
    double t_mag = t_dir.norm();
    if (t_mag > 1e-10) {
        t_dir.x /= t_mag;
        t_dir.y /= t_mag;
        t_dir.z /= t_mag;
    }

    return t_dir;
}

// ============================================================
// Dynamics
// ============================================================

LaunchTrajectorySolver::LaunchDerivatives
LaunchTrajectorySolver::compute_derivatives(
    const LaunchState& state,
    const LaunchControls& controls) const {

    LaunchDerivatives d;
    d.mass_rate = 0.0;

    Vec3 pos = state.position;
    Vec3 vel = state.velocity;
    double mass = state.mass;

    // 1. Gravity (two-body + J2)
    Vec3 a_grav = gravity::body_acceleration(pos, gravity::BodyConstants::EARTH, true);

    // 2. Thrust
    Vec3 a_thrust = {0.0, 0.0, 0.0};
    if (state.engines_on && state.stage_index < (int)vehicle_.stages.size()) {
        const auto& stage = vehicle_.stages[state.stage_index];
        double alt = state.altitude;
        if (alt < 0.0) alt = 0.0;
        double isp = stage.effective_isp(alt);
        double mdot = stage.thrust / (isp * G0);

        Vec3 t_dir = compute_thrust_direction(state, controls);
        double a_mag = stage.thrust / mass;

        a_thrust.x = a_mag * t_dir.x;
        a_thrust.y = a_mag * t_dir.y;
        a_thrust.z = a_mag * t_dir.z;

        d.mass_rate = -mdot;
    }

    // 3. Atmospheric drag
    Vec3 a_drag = {0.0, 0.0, 0.0};
    double alt = state.altitude;
    if (alt >= 0.0 && alt < 200000.0) {
        Vec3 v_rel = earth_relative_velocity(pos, vel);
        double rho = AtmosphereModel::get_density_extended(alt);
        if (rho > 1e-15) {
            double v_rel_mag = v_rel.norm();
            if (v_rel_mag > 1.0) {
                double drag_factor = 0.5 * rho * v_rel_mag *
                    vehicle_.drag_coefficient * vehicle_.reference_area / mass;
                a_drag.x = -drag_factor * v_rel.x;
                a_drag.y = -drag_factor * v_rel.y;
                a_drag.z = -drag_factor * v_rel.z;
            }
        }
    }

    // Total acceleration
    d.acceleration.x = a_grav.x + a_thrust.x + a_drag.x;
    d.acceleration.y = a_grav.y + a_thrust.y + a_drag.y;
    d.acceleration.z = a_grav.z + a_thrust.z + a_drag.z;

    return d;
}

// ============================================================
// RK4 Integration
// ============================================================

LaunchState LaunchTrajectorySolver::rk4_step(
    const LaunchState& state,
    const LaunchControls& controls,
    double dt) const {

    // k1
    LaunchDerivatives k1 = compute_derivatives(state, controls);

    // s2 = state + k1 * dt/2
    LaunchState s2 = state;
    s2.position.x = state.position.x + state.velocity.x * dt * 0.5;
    s2.position.y = state.position.y + state.velocity.y * dt * 0.5;
    s2.position.z = state.position.z + state.velocity.z * dt * 0.5;
    s2.velocity.x = state.velocity.x + k1.acceleration.x * dt * 0.5;
    s2.velocity.y = state.velocity.y + k1.acceleration.y * dt * 0.5;
    s2.velocity.z = state.velocity.z + k1.acceleration.z * dt * 0.5;
    s2.mass = state.mass + k1.mass_rate * dt * 0.5;
    s2.time = state.time + dt * 0.5;
    s2.altitude = eci_altitude(s2.position);

    // k2
    LaunchDerivatives k2 = compute_derivatives(s2, controls);

    // s3 = state + k2 * dt/2  (position uses s2.velocity, the k2 position derivative)
    LaunchState s3 = state;
    s3.position.x = state.position.x + s2.velocity.x * dt * 0.5;
    s3.position.y = state.position.y + s2.velocity.y * dt * 0.5;
    s3.position.z = state.position.z + s2.velocity.z * dt * 0.5;
    s3.velocity.x = state.velocity.x + k2.acceleration.x * dt * 0.5;
    s3.velocity.y = state.velocity.y + k2.acceleration.y * dt * 0.5;
    s3.velocity.z = state.velocity.z + k2.acceleration.z * dt * 0.5;
    s3.mass = state.mass + k2.mass_rate * dt * 0.5;
    s3.time = state.time + dt * 0.5;
    s3.altitude = eci_altitude(s3.position);

    // k3
    LaunchDerivatives k3 = compute_derivatives(s3, controls);

    // s4 = state + k3 * dt  (position uses s3.velocity, the k3 position derivative)
    LaunchState s4 = state;
    s4.position.x = state.position.x + s3.velocity.x * dt;
    s4.position.y = state.position.y + s3.velocity.y * dt;
    s4.position.z = state.position.z + s3.velocity.z * dt;
    s4.velocity.x = state.velocity.x + k3.acceleration.x * dt;
    s4.velocity.y = state.velocity.y + k3.acceleration.y * dt;
    s4.velocity.z = state.velocity.z + k3.acceleration.z * dt;
    s4.mass = state.mass + k3.mass_rate * dt;
    s4.time = state.time + dt;
    s4.altitude = eci_altitude(s4.position);

    // k4
    LaunchDerivatives k4 = compute_derivatives(s4, controls);

    // Combine: state_new = state + dt/6 * (k1 + 2*k2 + 2*k3 + k4)
    LaunchState result = state;
    result.position.x += dt * (state.velocity.x +
        (dt / 6.0) * (k1.acceleration.x + 2.0 * k2.acceleration.x +
                       2.0 * k3.acceleration.x + k4.acceleration.x));
    result.position.y += dt * (state.velocity.y +
        (dt / 6.0) * (k1.acceleration.y + 2.0 * k2.acceleration.y +
                       2.0 * k3.acceleration.y + k4.acceleration.y));
    result.position.z += dt * (state.velocity.z +
        (dt / 6.0) * (k1.acceleration.z + 2.0 * k2.acceleration.z +
                       2.0 * k3.acceleration.z + k4.acceleration.z));

    // Wait, the correct RK4 for second-order ODE:
    // x_new = x + dt*v + dt^2/6*(a1 + a2 + a3) -- NO, standard approach:
    // We treat it as first-order system: y = [r, v, m]
    // dy/dt = [v, a, mdot]

    // Actually let me redo this properly. For the standard RK4 on first-order system:
    // y_{n+1} = y_n + (dt/6)(k1 + 2*k2 + 2*k3 + k4)
    // where k_i are the full derivative vectors

    // Position derivative = velocity at each stage
    // We need k1_pos = v(state), k2_pos = v(s2), k3_pos = v(s3), k4_pos = v(s4)

    result.position.x = state.position.x + (dt / 6.0) * (
        state.velocity.x + 2.0 * s2.velocity.x + 2.0 * s3.velocity.x + s4.velocity.x);
    result.position.y = state.position.y + (dt / 6.0) * (
        state.velocity.y + 2.0 * s2.velocity.y + 2.0 * s3.velocity.y + s4.velocity.y);
    result.position.z = state.position.z + (dt / 6.0) * (
        state.velocity.z + 2.0 * s2.velocity.z + 2.0 * s3.velocity.z + s4.velocity.z);

    result.velocity.x = state.velocity.x + (dt / 6.0) * (
        k1.acceleration.x + 2.0 * k2.acceleration.x +
        2.0 * k3.acceleration.x + k4.acceleration.x);
    result.velocity.y = state.velocity.y + (dt / 6.0) * (
        k1.acceleration.y + 2.0 * k2.acceleration.y +
        2.0 * k3.acceleration.y + k4.acceleration.y);
    result.velocity.z = state.velocity.z + (dt / 6.0) * (
        k1.acceleration.z + 2.0 * k2.acceleration.z +
        2.0 * k3.acceleration.z + k4.acceleration.z);

    result.mass = state.mass + (dt / 6.0) * (
        k1.mass_rate + 2.0 * k2.mass_rate + 2.0 * k3.mass_rate + k4.mass_rate);

    result.time = state.time + dt;
    result.altitude = eci_altitude(result.position);

    // Compute dynamic pressure
    Vec3 v_rel = earth_relative_velocity(result.position, result.velocity);
    double rho = (result.altitude >= 0.0 && result.altitude < 200000.0) ?
        AtmosphereModel::get_density_extended(result.altitude) : 0.0;
    result.dynamic_pressure = 0.5 * rho * (v_rel.x * v_rel.x +
        v_rel.y * v_rel.y + v_rel.z * v_rel.z);

    return result;
}

// ============================================================
// Trajectory Propagation with Staging
// ============================================================

LaunchState LaunchTrajectorySolver::propagate_trajectory(
    const LaunchControls& controls,
    std::vector<LaunchState>* trajectory) const {

    // Initialize from launch site
    double actual_epoch = epoch_jd_ + controls.epoch_offset / 86400.0;
    StateVector site_state = site_.compute_eci_state(actual_epoch);

    LaunchState state;
    state.position = site_state.position;
    state.velocity = site_state.velocity;
    state.mass = vehicle_.total_mass();
    state.time = 0.0;
    state.stage_index = 0;
    state.engines_on = true;
    state.altitude = eci_altitude(state.position);
    state.dynamic_pressure = 0.0;

    // Initialize fuel tracking
    for (int i = 0; i < 4; i++) state.fuel_remaining[i] = 0.0;
    for (int i = 0; i < (int)vehicle_.stages.size() && i < 4; i++) {
        state.fuel_remaining[i] = vehicle_.stages[i].propellant_mass;
    }

    // Estimate total propagation time
    double t_burn_total = 0.0;
    for (const auto& s : vehicle_.stages) {
        t_burn_total += s.burn_duration(80000.0); // rough avg altitude
    }
    double t_end = t_burn_total + controls.coast_after_burnout;

    if (trajectory) {
        trajectory->clear();
        trajectory->push_back(state);
    }

    double t = 0.0;
    while (t < t_end) {
        // Adaptive step size
        double dt = (state.altitude < 100000.0) ?
            config_.atmo_step_size : config_.vacuum_step_size;
        if (t + dt > t_end) dt = t_end - t;
        if (dt < 1e-6) break;

        // Check if staging will occur this step
        if (state.engines_on && state.stage_index < (int)vehicle_.stages.size()) {
            const auto& stage = vehicle_.stages[state.stage_index];
            double alt = (state.altitude < 0.0) ? 0.0 : state.altitude;
            double mdot = stage.mass_flow_rate(alt);
            double fuel = state.fuel_remaining[state.stage_index];

            if (mdot > 0.0 && fuel > 0.0) {
                double t_to_burnout = fuel / mdot;
                if (t_to_burnout < dt) {
                    // Stage will run out during this step - split at boundary
                    // First: propagate to burnout
                    if (t_to_burnout > 1e-6) {
                        state = rk4_step(state, controls, t_to_burnout);
                        t += t_to_burnout;
                    }

                    // Staging event
                    state.fuel_remaining[state.stage_index] = 0.0;
                    state.mass -= vehicle_.stages[state.stage_index].dry_mass;
                    state.stage_index++;

                    if (state.stage_index >= (int)vehicle_.stages.size()) {
                        state.engines_on = false;
                    }

                    if (trajectory) trajectory->push_back(state);

                    // Propagate remainder of original step
                    double dt_remain = dt - t_to_burnout;
                    if (dt_remain > 1e-6) {
                        state = rk4_step(state, controls, dt_remain);
                        t += dt_remain;
                    }

                    if (trajectory) trajectory->push_back(state);
                    continue;
                }
            }
        }

        // Normal step
        LaunchState new_state = rk4_step(state, controls, dt);

        // Update fuel tracking
        if (state.engines_on && state.stage_index < (int)vehicle_.stages.size()) {
            double fuel_used = state.mass - new_state.mass;
            new_state.fuel_remaining[state.stage_index] =
                state.fuel_remaining[state.stage_index] - fuel_used;
            if (new_state.fuel_remaining[state.stage_index] < 0.0) {
                new_state.fuel_remaining[state.stage_index] = 0.0;
            }
        }

        state = new_state;
        t += dt;

        if (trajectory) trajectory->push_back(state);

        // Safety: abort if altitude goes very negative (crash)
        if (state.altitude < -100000.0) break;
    }

    return state;
}

// ============================================================
// Constraint Residuals
// ============================================================

std::vector<double> LaunchTrajectorySolver::compute_residuals(
    const LaunchState& final_state,
    const TerminalTarget& target) const {

    std::vector<double> r;

    switch (target.mode) {
        case TargetingMode::ORBIT_INSERTION: {
            StateVector sv;
            sv.position = final_state.position;
            sv.velocity = final_state.velocity;
            OrbitalElements elem = OrbitalMechanics::state_to_elements(sv);

            if (target.constrain_sma) {
                // Scale: difference in km
                r.push_back((elem.semi_major_axis - target.target_elements.semi_major_axis) / 1000.0);
            }
            if (target.constrain_ecc) {
                // Scale: eccentricity * 1e4 for better conditioning
                r.push_back((elem.eccentricity - target.target_elements.eccentricity) * 1e4);
            }
            if (target.constrain_inc) {
                // Scale: angle difference * 1e4 for comparable magnitude to SMA (km) and ecc
                // 0.01 rad (0.57°) → residual 100, 0.001 rad (0.06°) → residual 10
                r.push_back((elem.inclination - target.target_elements.inclination) * 1e4);
            }
            if (target.constrain_raan) {
                r.push_back((elem.raan - target.target_elements.raan) * 1e4);
            }
            if (target.constrain_argp) {
                r.push_back((elem.arg_periapsis - target.target_elements.arg_periapsis) * 1e4);
            }
            break;
        }

        case TargetingMode::POSITION_INTERCEPT: {
            StateVector target_final = propagate_target(target.target_state_epoch,
                                                         target.time_of_flight);
            r.push_back(final_state.position.x - target_final.position.x);
            r.push_back(final_state.position.y - target_final.position.y);
            r.push_back(final_state.position.z - target_final.position.z);
            break;
        }

        case TargetingMode::FULL_RENDEZVOUS: {
            StateVector target_final = propagate_target(target.target_state_epoch,
                                                         target.time_of_flight);
            // Position residuals [m]
            r.push_back(final_state.position.x - target_final.position.x);
            r.push_back(final_state.position.y - target_final.position.y);
            r.push_back(final_state.position.z - target_final.position.z);

            // Velocity residuals scaled to position units
            double a_target = target.target_elements.semi_major_axis;
            if (a_target < 1e6) a_target = EARTH_RADIUS + 400000.0;
            double T_scale = std::sqrt(a_target * a_target * a_target / MU);
            r.push_back((final_state.velocity.x - target_final.velocity.x) * T_scale);
            r.push_back((final_state.velocity.y - target_final.velocity.y) * T_scale);
            r.push_back((final_state.velocity.z - target_final.velocity.z) * T_scale);
            break;
        }
    }

    return r;
}

// ============================================================
// Target Propagation
// ============================================================

StateVector LaunchTrajectorySolver::propagate_target(
    const StateVector& target, double dt) const {

    // Simple RK4 propagation under J2 gravity
    StateVector state = target;
    double step = 60.0; // 60s steps for target
    double t = 0.0;

    while (t < dt) {
        double h = step;
        if (t + h > dt) h = dt - t;
        if (h < 1e-6) break;

        // k1
        Vec3 a1 = gravity::body_acceleration(state.position,
                                              gravity::BodyConstants::EARTH, true);
        // k2
        Vec3 p2, v2;
        p2.x = state.position.x + state.velocity.x * h * 0.5;
        p2.y = state.position.y + state.velocity.y * h * 0.5;
        p2.z = state.position.z + state.velocity.z * h * 0.5;
        v2.x = state.velocity.x + a1.x * h * 0.5;
        v2.y = state.velocity.y + a1.y * h * 0.5;
        v2.z = state.velocity.z + a1.z * h * 0.5;
        Vec3 a2 = gravity::body_acceleration(p2, gravity::BodyConstants::EARTH, true);

        // k3
        Vec3 p3, v3;
        p3.x = state.position.x + state.velocity.x * h * 0.5;
        p3.y = state.position.y + state.velocity.y * h * 0.5;
        p3.z = state.position.z + state.velocity.z * h * 0.5;
        v3.x = state.velocity.x + a2.x * h * 0.5;
        v3.y = state.velocity.y + a2.y * h * 0.5;
        v3.z = state.velocity.z + a2.z * h * 0.5;
        Vec3 a3 = gravity::body_acceleration(p3, gravity::BodyConstants::EARTH, true);

        // k4
        Vec3 p4, v4;
        p4.x = state.position.x + state.velocity.x * h;
        p4.y = state.position.y + state.velocity.y * h;
        p4.z = state.position.z + state.velocity.z * h;
        v4.x = state.velocity.x + a3.x * h;
        v4.y = state.velocity.y + a3.y * h;
        v4.z = state.velocity.z + a3.z * h;
        Vec3 a4 = gravity::body_acceleration(p4, gravity::BodyConstants::EARTH, true);

        // Combine
        state.position.x += (h / 6.0) * (state.velocity.x + 2.0*v2.x + 2.0*v3.x + v4.x);
        state.position.y += (h / 6.0) * (state.velocity.y + 2.0*v2.y + 2.0*v3.y + v4.y);
        state.position.z += (h / 6.0) * (state.velocity.z + 2.0*v2.z + 2.0*v3.z + v4.z);
        state.velocity.x += (h / 6.0) * (a1.x + 2.0*a2.x + 2.0*a3.x + a4.x);
        state.velocity.y += (h / 6.0) * (a1.y + 2.0*a2.y + 2.0*a3.y + a4.y);
        state.velocity.z += (h / 6.0) * (a1.z + 2.0*a2.z + 2.0*a3.z + a4.z);

        t += h;
    }

    return state;
}

// ============================================================
// Numerical Jacobian
// ============================================================

void LaunchTrajectorySolver::compute_jacobian(
    const LaunchControls& controls,
    const TerminalTarget& target,
    const std::vector<double>& r_nominal,
    std::vector<std::vector<double>>& jacobian) const {

    int n_constraints = (int)r_nominal.size();
    int n_free = config_.num_free_controls();

    jacobian.resize(n_constraints);
    for (int i = 0; i < n_constraints; i++) {
        jacobian[i].resize(n_free);
    }

    std::vector<double> x0 = pack_free_controls(controls);

    // Map free control indices to full control indices
    std::vector<int> free_to_full;
    for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
        if (config_.free_controls[i]) free_to_full.push_back(i);
    }

    // Per-control FD floors: angular controls need small perturbation (rad),
    // time controls need larger perturbation (seconds)
    static constexpr double FD_FLOORS[LaunchControls::N_CONTROLS] = {
        0.01,  // [0]  azimuth [rad]
        0.01,  // [1]  pitch_s1[0]
        0.01,  // [2]  pitch_s1[1]
        0.01,  // [3]  pitch_s1[2]
        0.01,  // [4]  pitch_s2[0]
        0.01,  // [5]  pitch_s2[1]
        0.01,  // [6]  pitch_s2[2]
        0.01,  // [7]  yaw_s1[0]
        0.01,  // [8]  yaw_s1[1]
        0.01,  // [9]  yaw_s2[0]
        0.01,  // [10] yaw_s2[1]
        10.0,  // [11] coast_after_burnout [s]
        10.0,  // [12] epoch_offset [s]
    };

    for (int j = 0; j < n_free; j++) {
        // Perturbation size: relative with per-control floor
        int full_idx = free_to_full[j];
        double floor_val = FD_FLOORS[full_idx];
        double h = config_.fd_step_size * std::max(std::abs(x0[j]), floor_val);

        // Perturb
        std::vector<double> x_pert = x0;
        x_pert[j] += h;

        LaunchControls c_pert = controls;
        unpack_free_controls(c_pert, x_pert);

        // Propagate perturbed trajectory
        LaunchState final_pert = propagate_trajectory(c_pert);
        std::vector<double> r_pert = compute_residuals(final_pert, target);

        // Finite difference
        for (int i = 0; i < n_constraints; i++) {
            jacobian[i][j] = (r_pert[i] - r_nominal[i]) / h;
        }
    }
}

// ============================================================
// Linear System Solver
// ============================================================

std::vector<double> LaunchTrajectorySolver::solve_linear_system(
    const std::vector<std::vector<double>>& J,
    const std::vector<double>& r,
    int M, int N,
    double damping) const {

    std::vector<double> dx(N, 0.0);

    if (M == N) {
        // Square system: Gaussian elimination with partial pivoting
        std::vector<std::vector<double>> A(M, std::vector<double>(N + 1));
        for (int i = 0; i < M; i++) {
            for (int j = 0; j < N; j++) A[i][j] = J[i][j];
            A[i][N] = r[i];
        }

        for (int col = 0; col < N; col++) {
            // Partial pivoting
            int max_row = col;
            double max_val = std::abs(A[col][col]);
            for (int row = col + 1; row < M; row++) {
                if (std::abs(A[row][col]) > max_val) {
                    max_val = std::abs(A[row][col]);
                    max_row = row;
                }
            }
            if (max_row != col) std::swap(A[col], A[max_row]);

            if (std::abs(A[col][col]) < 1e-15) continue;

            for (int row = col + 1; row < M; row++) {
                double factor = A[row][col] / A[col][col];
                for (int k = col; k <= N; k++) {
                    A[row][k] -= factor * A[col][k];
                }
            }
        }

        // Back substitution
        for (int i = N - 1; i >= 0; i--) {
            if (std::abs(A[i][i]) < 1e-15) { dx[i] = 0.0; continue; }
            double sum = A[i][N];
            for (int j = i + 1; j < N; j++) sum -= A[i][j] * dx[j];
            dx[i] = sum / A[i][i];
        }
    }
    else if (M < N) {
        // Underdetermined: minimum-norm solution via J^T * (J*J^T)^{-1} * r
        // Compute JJT = J * J^T (M x M)
        std::vector<std::vector<double>> JJT(M, std::vector<double>(M, 0.0));
        for (int i = 0; i < M; i++) {
            for (int k = 0; k < M; k++) {
                double sum = 0.0;
                for (int j = 0; j < N; j++) {
                    sum += J[i][j] * J[k][j];
                }
                JJT[i][k] = sum;
            }
        }

        // Add Levenberg-Marquardt / Tikhonov regularization
        for (int i = 0; i < M; i++) JJT[i][i] += damping;

        // Solve JJT * y = r (M x M system)
        std::vector<double> y = solve_linear_system(JJT, r, M, M, 0.0);

        // dx = J^T * y
        for (int j = 0; j < N; j++) {
            double sum = 0.0;
            for (int i = 0; i < M; i++) {
                sum += J[i][j] * y[i];
            }
            dx[j] = sum;
        }
    }
    else {
        // Overdetermined: least-squares via (J^T*J)*dx = J^T*r
        std::vector<std::vector<double>> JTJ(N, std::vector<double>(N, 0.0));
        std::vector<double> JTr(N, 0.0);

        for (int i = 0; i < N; i++) {
            for (int j = 0; j < N; j++) {
                double sum = 0.0;
                for (int k = 0; k < M; k++) sum += J[k][i] * J[k][j];
                JTJ[i][j] = sum;
            }
            double sum = 0.0;
            for (int k = 0; k < M; k++) sum += J[k][i] * r[k];
            JTr[i] = sum;
        }

        // Add Levenberg-Marquardt / Tikhonov regularization
        for (int i = 0; i < N; i++) JTJ[i][i] += damping;

        dx = solve_linear_system(JTJ, JTr, N, N);
    }

    return dx;
}

// ============================================================
// Apply Correction
// ============================================================

void LaunchTrajectorySolver::apply_correction(
    LaunchControls& controls,
    const std::vector<double>& dx_in,
    double alpha) const {

    // Per-control maximum step sizes to prevent overshooting
    // Indexed by position in the 13-element control array
    static constexpr double MAX_STEP[LaunchControls::N_CONTROLS] = {
        0.15,    // [0]  azimuth: ~9 deg per iter
        0.05,    // [1]  pitch_s1[0]: ~3 deg (initial kick - sensitive)
        0.20,    // [2]  pitch_s1[1]: ~11 deg
        0.20,    // [3]  pitch_s1[2]
        0.15,    // [4]  pitch_s2[0]: ~9 deg
        0.50,    // [5]  pitch_s2[1]: wider range needed for turn rate
        0.50,    // [6]  pitch_s2[2]: wider range for turn shape
        0.05,    // [7]  yaw_s1[0]
        0.05,    // [8]  yaw_s1[1]
        0.05,    // [9]  yaw_s2[0]
        0.05,    // [10] yaw_s2[1]
        200.0,   // [11] coast: 200s per iter
        60.0,    // [12] epoch: 60s per iter
    };

    // Clamp the raw correction to per-control limits
    std::vector<double> dx = dx_in;
    {
        int idx = 0;
        for (int i = 0; i < LaunchControls::N_CONTROLS; i++) {
            if (config_.free_controls[i]) {
                double limit = MAX_STEP[i] / alpha;
                if (dx[idx] > limit) dx[idx] = limit;
                if (dx[idx] < -limit) dx[idx] = -limit;
                idx++;
            }
        }
    }

    std::vector<double> x = pack_free_controls(controls);
    for (int i = 0; i < (int)x.size(); i++) {
        x[i] -= alpha * dx[i];
    }
    unpack_free_controls(controls, x);

    // Clamp controls to physically reasonable bounds
    // Pitch S1: initial kick [0, 0.3], turn rate [0, 2.5], accel [-1, 2.0]
    controls.pitch_s1[0] = std::max(0.0, std::min(0.3, controls.pitch_s1[0]));
    controls.pitch_s1[1] = std::max(0.0, std::min(2.5, controls.pitch_s1[1]));
    controls.pitch_s1[2] = std::max(-1.0, std::min(2.0, controls.pitch_s1[2]));

    // Pitch S2: start angle [0.1, pi/2], rate [-2, 6], accel [-6, 4]
    // Wide bounds needed: fast-turn profiles use large p1 with negative p2
    controls.pitch_s2[0] = std::max(0.1, std::min(PI / 2.0, controls.pitch_s2[0]));
    controls.pitch_s2[1] = std::max(-2.0, std::min(6.0, controls.pitch_s2[1]));
    controls.pitch_s2[2] = std::max(-6.0, std::min(4.0, controls.pitch_s2[2]));

    // Yaw: small corrections only [-0.3, 0.3]
    controls.yaw_s1[0] = std::max(-0.3, std::min(0.3, controls.yaw_s1[0]));
    controls.yaw_s1[1] = std::max(-0.3, std::min(0.3, controls.yaw_s1[1]));
    controls.yaw_s2[0] = std::max(-0.3, std::min(0.3, controls.yaw_s2[0]));
    controls.yaw_s2[1] = std::max(-0.3, std::min(0.3, controls.yaw_s2[1]));

    // Azimuth: [0, 2*pi]
    while (controls.launch_azimuth < 0.0) controls.launch_azimuth += 2.0 * PI;
    while (controls.launch_azimuth > 2.0 * PI) controls.launch_azimuth -= 2.0 * PI;

    // Coast must be non-negative
    if (controls.coast_after_burnout < 0.0) controls.coast_after_burnout = 0.0;
}

// ============================================================
// Initial Guess Generation
// ============================================================

LaunchControls LaunchTrajectorySolver::generate_initial_guess(
    const TerminalTarget& target) const {

    double target_inc = 0.0;

    if (target.mode == TargetingMode::ORBIT_INSERTION) {
        target_inc = target.target_elements.inclination;
    } else {
        // Estimate inclination from target state
        Vec3 r = target.target_state_epoch.position;
        Vec3 v = target.target_state_epoch.velocity;
        Vec3 h;
        h.x = r.y * v.z - r.z * v.y;
        h.y = r.z * v.x - r.x * v.z;
        h.z = r.x * v.y - r.y * v.x;
        double h_mag = h.norm();
        target_inc = (h_mag > 0.0) ? std::acos(h.z / h_mag) : 0.0;
    }

    double launch_lat = site_.latitude_deg * PI / 180.0;
    LaunchControls guess = LaunchControls::default_guess(target_inc, launch_lat);

    // S1 end pitch angle
    double pitch_s1_end = guess.pitch_s1[0] + guess.pitch_s1[1] + guess.pitch_s1[2];

    // =================================================================
    // Grid search for S2 pitch rate that minimizes residual to target
    // =================================================================
    // Use a linear pitch profile for S2: theta(tau) = pitch_s1_end + rate*tau
    // The steering law clamps pitch to [0, pi/2], so rates that overshoot
    // just mean the vehicle reaches horizontal partway through S2.
    //
    // Target SMA for orbit insertion (or the target orbit for intercept)
    double target_sma = 0.0;
    double target_ecc = 0.0;
    if (target.mode == TargetingMode::ORBIT_INSERTION) {
        target_sma = target.target_elements.semi_major_axis;
        target_ecc = target.target_elements.eccentricity;
    } else {
        // Use target state to estimate orbital elements
        OrbitalElements te = OrbitalMechanics::state_to_elements(target.target_state_epoch);
        target_sma = te.semi_major_axis;
        target_ecc = te.eccentricity;
    }

    if (target_sma > 0.0) {
        // Coarse grid search: rate from 0.5 to 5.0
        double best_rate = 1.07;  // fallback
        double best_cost = 1e30;

        for (double rate = 0.3; rate <= 5.5; rate += 0.2) {
            LaunchControls test = guess;
            test.pitch_s2[0] = pitch_s1_end;
            test.pitch_s2[1] = rate;
            test.pitch_s2[2] = 0.0;

            LaunchState final_state = propagate_trajectory(test);

            // Skip crashed trajectories
            if (final_state.altitude < 0.0) continue;

            StateVector sv;
            sv.position = final_state.position;
            sv.velocity = final_state.velocity;
            OrbitalElements elem = OrbitalMechanics::state_to_elements(sv);

            // Skip invalid orbits
            if (elem.semi_major_axis < EARTH_RADIUS || elem.eccentricity > 0.95) continue;

            // Cost function matching residual scaling:
            // SMA in km, ecc * 1e4 — same as compute_residuals
            double sma_res = (elem.semi_major_axis - target_sma) / 1000.0;
            double ecc_res = (elem.eccentricity - target_ecc) * 1e4;
            double cost = sma_res * sma_res + ecc_res * ecc_res;

            if (cost < best_cost) {
                best_cost = cost;
                best_rate = rate;
            }
        }

        // Fine grid search around best rate
        double fine_best_rate = best_rate;
        double fine_best_cost = best_cost;

        for (double rate = best_rate - 0.4; rate <= best_rate + 0.4; rate += 0.02) {
            if (rate < 0.1) continue;

            LaunchControls test = guess;
            test.pitch_s2[0] = pitch_s1_end;
            test.pitch_s2[1] = rate;
            test.pitch_s2[2] = 0.0;

            LaunchState final_state = propagate_trajectory(test);
            if (final_state.altitude < 0.0) continue;

            StateVector sv;
            sv.position = final_state.position;
            sv.velocity = final_state.velocity;
            OrbitalElements elem = OrbitalMechanics::state_to_elements(sv);

            if (elem.semi_major_axis < EARTH_RADIUS || elem.eccentricity > 0.95) continue;

            double sma_res = (elem.semi_major_axis - target_sma) / 1000.0;
            double ecc_res = (elem.eccentricity - target_ecc) * 1e4;
            double cost = sma_res * sma_res + ecc_res * ecc_res;

            if (cost < fine_best_cost) {
                fine_best_cost = cost;
                fine_best_rate = rate;
            }
        }

        guess.pitch_s2[0] = pitch_s1_end;
        guess.pitch_s2[1] = fine_best_rate;
        guess.pitch_s2[2] = 0.0;

        if (config_.verbose) {
            // Show what the initial guess achieves
            LaunchState gs = propagate_trajectory(guess);
            StateVector sv;
            sv.position = gs.position;
            sv.velocity = gs.velocity;
            OrbitalElements ge = OrbitalMechanics::state_to_elements(sv);
            std::cout << "Initial guess search: S2 rate=" << std::fixed << std::setprecision(3)
                      << fine_best_rate
                      << "  SMA=" << std::setprecision(1) << ge.semi_major_axis / 1000.0
                      << " km  ecc=" << std::setprecision(4) << ge.eccentricity
                      << "  alt=" << std::setprecision(1) << gs.altitude / 1000.0
                      << " km  cost=" << std::scientific << std::setprecision(2)
                      << fine_best_cost << std::endl;
        }
    }

    // For intercept/rendezvous: refine with Lambert
    if (target.mode != TargetingMode::ORBIT_INSERTION) {
        // Propagate open-loop to get rough insertion state
        LaunchState insertion = propagate_trajectory(guess);

        // Use Lambert to find required velocity at insertion point
        StateVector target_final = propagate_target(target.target_state_epoch,
                                                     target.time_of_flight);

        double coast_tof = target.time_of_flight - insertion.time;
        if (coast_tof > 60.0) {
            LambertSolution lambert = ManeuverPlanner::solve_lambert(
                insertion.position, target_final.position, coast_tof);

            if (lambert.valid) {
                // Back-compute final pitch from Lambert velocity
                double r_mag = insertion.position.norm();
                Vec3 r_hat;
                r_hat.x = insertion.position.x / r_mag;
                r_hat.y = insertion.position.y / r_mag;
                r_hat.z = insertion.position.z / r_mag;

                double v_radial = lambert.v1.x * r_hat.x +
                                  lambert.v1.y * r_hat.y +
                                  lambert.v1.z * r_hat.z;
                double v_mag = lambert.v1.norm();
                double v_horiz = std::sqrt(std::max(0.0, v_mag * v_mag - v_radial * v_radial));

                double final_pitch = std::atan2(v_horiz, v_radial);
                if (final_pitch < 0.0) final_pitch = 0.0;
                if (final_pitch > PI / 2.0) final_pitch = PI / 2.0;

                // Adjust stage 2 to reach this final pitch
                guess.pitch_s2[1] = final_pitch - guess.pitch_s2[0];
                if (guess.pitch_s2[1] < 0.0) guess.pitch_s2[1] = 0.0;
                guess.pitch_s2[2] = 0.0;

                // Add coast if needed
                guess.coast_after_burnout = std::max(0.0, coast_tof - 300.0);
            }
        }
    }

    return guess;
}

// ============================================================
// Main Solver
// ============================================================

LaunchTrajectorySolution LaunchTrajectorySolver::solve(
    const TerminalTarget& target,
    const LaunchControls* initial_guess) {

    LaunchTrajectorySolution solution;
    solution.converged = false;
    solution.iterations = 0;

    // Get initial guess
    LaunchControls controls = initial_guess ?
        *initial_guess : generate_initial_guess(target);

    int n_constraints = target.num_constraints();
    int n_free = config_.num_free_controls();

    if (config_.verbose) {
        std::cout << "\n=== Launch Trajectory Solver ===" << std::endl;
        std::cout << "Targeting mode: ";
        switch (target.mode) {
            case TargetingMode::ORBIT_INSERTION: std::cout << "Orbit Insertion"; break;
            case TargetingMode::POSITION_INTERCEPT: std::cout << "Position Intercept"; break;
            case TargetingMode::FULL_RENDEZVOUS: std::cout << "Full Rendezvous"; break;
        }
        std::cout << std::endl;
        std::cout << "Constraints: " << n_constraints
                  << ", Free controls: " << n_free << std::endl;
        std::cout << "Initial azimuth: " << controls.launch_azimuth * 180.0 / PI
                  << " deg" << std::endl;
    }

    // Levenberg-Marquardt damping parameter
    double lm_lambda = 0.01;

    for (int iter = 0; iter < config_.max_iterations; iter++) {
        // Propagate nominal trajectory
        LaunchState final_state = propagate_trajectory(controls);

        // Compute residuals
        std::vector<double> residuals = compute_residuals(final_state, target);

        // Compute residual norm
        double r_norm = 0.0;
        for (double ri : residuals) r_norm += ri * ri;
        r_norm = std::sqrt(r_norm);

        if (config_.verbose) {
            // Print residual summary with individual components
            std::cout << "  Iter " << std::setw(2) << iter
                      << ": |r|=" << std::scientific << std::setprecision(3)
                      << r_norm << std::fixed;

            // Show individual residuals for orbit insertion
            if (target.mode == TargetingMode::ORBIT_INSERTION) {
                StateVector sv;
                sv.position = final_state.position;
                sv.velocity = final_state.velocity;
                OrbitalElements elem = OrbitalMechanics::state_to_elements(sv);

                std::cout << "  SMA=" << std::setprecision(1)
                          << elem.semi_major_axis / 1000.0 << "km"
                          << "  ecc=" << std::setprecision(4)
                          << elem.eccentricity
                          << "  inc=" << std::setprecision(2)
                          << elem.inclination * 180.0 / PI << "°"
                          << "  alt=" << std::setprecision(1)
                          << final_state.altitude / 1000.0 << "km"
                          << "  λ=" << std::scientific << std::setprecision(1)
                          << lm_lambda;
            } else {
                std::cout << "  alt=" << std::setprecision(1)
                          << final_state.altitude / 1000.0 << " km"
                          << "  v=" << std::setprecision(1)
                          << final_state.velocity.norm() << " m/s";
            }
            std::cout << std::endl;
        }

        // Check convergence
        if (r_norm < config_.convergence_tol) {
            solution.converged = true;
            solution.iterations = iter;
            solution.residual_norm = r_norm;
            solution.status = "Converged";
            solution.controls = controls;
            solution.final_state = final_state;

            // Re-propagate to get full trajectory
            propagate_trajectory(controls, &solution.trajectory);

            // Compute orbital elements
            StateVector sv;
            sv.position = final_state.position;
            sv.velocity = final_state.velocity;
            solution.final_elements = OrbitalMechanics::state_to_elements(sv);

            // Compute errors for intercept/rendezvous
            if (target.mode == TargetingMode::POSITION_INTERCEPT ||
                target.mode == TargetingMode::FULL_RENDEZVOUS) {
                StateVector tf = propagate_target(target.target_state_epoch,
                                                   target.time_of_flight);
                Vec3 dr;
                dr.x = final_state.position.x - tf.position.x;
                dr.y = final_state.position.y - tf.position.y;
                dr.z = final_state.position.z - tf.position.z;
                solution.final_position_error = dr.norm();

                Vec3 dv;
                dv.x = final_state.velocity.x - tf.velocity.x;
                dv.y = final_state.velocity.y - tf.velocity.y;
                dv.z = final_state.velocity.z - tf.velocity.z;
                solution.final_velocity_error = dv.norm();
            } else {
                solution.final_position_error = 0.0;
                solution.final_velocity_error = 0.0;
            }

            break;
        }

        // Compute Jacobian
        std::vector<std::vector<double>> J;
        compute_jacobian(controls, target, residuals, J);

        // Levenberg-Marquardt: try solving with current lambda,
        // increase damping if step doesn't improve, decrease if it does
        bool step_accepted = false;

        for (int lm_trial = 0; lm_trial < 10 && !step_accepted; lm_trial++) {
            // Solve damped linear system
            std::vector<double> dx = solve_linear_system(J, residuals,
                                                          n_constraints, n_free,
                                                          lm_lambda);

            // Test the correction
            LaunchControls c_test = controls;
            apply_correction(c_test, dx, 1.0);

            LaunchState fs_test = propagate_trajectory(c_test);

            // Skip crashed trajectories
            if (fs_test.altitude < -50000.0) {
                lm_lambda *= 5.0;
                continue;
            }

            std::vector<double> r_test = compute_residuals(fs_test, target);
            double r_test_norm = 0.0;
            for (double ri : r_test) r_test_norm += ri * ri;
            r_test_norm = std::sqrt(r_test_norm);

            if (r_test_norm < r_norm) {
                // Step accepted — apply and reduce damping
                controls = c_test;
                lm_lambda *= 0.3;
                if (lm_lambda < 1e-10) lm_lambda = 1e-10;
                step_accepted = true;
            } else {
                // Step rejected — increase damping toward steepest descent
                lm_lambda *= 5.0;
                if (lm_lambda > 1e6) lm_lambda = 1e6;
            }
        }

        if (!step_accepted) {
            // All LM trials failed — try a very small gradient descent step
            std::vector<double> gradient(n_free, 0.0);
            for (int j = 0; j < n_free; j++) {
                for (int i = 0; i < n_constraints; i++) {
                    gradient[j] += J[i][j] * residuals[i];
                }
            }
            double g_norm = 0.0;
            for (double g : gradient) g_norm += g * g;
            g_norm = std::sqrt(g_norm);
            if (g_norm > 1e-10) {
                double grad_step = 0.005;
                for (double& g : gradient) g *= grad_step / g_norm;
                apply_correction(controls, gradient, 1.0);
            }
            if (config_.verbose) {
                std::cout << "         (LM failed 10 trials, gradient fallback)" << std::endl;
            }
        }

        solution.iterations = iter + 1;
        solution.residual_norm = r_norm;
    }

    if (!solution.converged) {
        solution.status = "Did not converge after " +
            std::to_string(config_.max_iterations) + " iterations";
        solution.controls = controls;

        // Still fill in trajectory for analysis
        solution.final_state = propagate_trajectory(controls, &solution.trajectory);
        StateVector sv;
        sv.position = solution.final_state.position;
        sv.velocity = solution.final_state.velocity;
        solution.final_elements = OrbitalMechanics::state_to_elements(sv);
    }

    // Compute events and delta-V for all solutions (converged or not)
    solution.stage_separation_time = 0.0;
    solution.burnout_time = 0.0;
    solution.gravity_losses = 0.0;
    solution.drag_losses = 0.0;
    solution.total_delta_v = 0.0;

    for (size_t i = 1; i < solution.trajectory.size(); i++) {
        // Record FIRST stage separation event
        if (solution.trajectory[i].stage_index > solution.trajectory[i-1].stage_index &&
            solution.stage_separation_time == 0.0) {
            solution.stage_separation_time = solution.trajectory[i].time;
        }
        // Record LAST engine shutdown (final burnout)
        if (solution.trajectory[i-1].engines_on && !solution.trajectory[i].engines_on) {
            solution.burnout_time = solution.trajectory[i].time;
        }
    }

    // Approximate delta-V from rocket equation
    double m0 = vehicle_.total_mass();
    double mf = solution.final_state.mass;
    double isp_avg = 0.0;
    for (const auto& s : vehicle_.stages) {
        isp_avg += s.isp_vac;
    }
    isp_avg /= vehicle_.stages.size();
    if (mf > 0.0 && m0 > mf) {
        solution.total_delta_v = isp_avg * G0 * std::log(m0 / mf);
    }

    // Compute target errors for intercept/rendezvous
    if (!solution.converged) {
        if (target.mode == TargetingMode::POSITION_INTERCEPT ||
            target.mode == TargetingMode::FULL_RENDEZVOUS) {
            StateVector tf = propagate_target(target.target_state_epoch,
                                               target.time_of_flight);
            Vec3 dr;
            dr.x = solution.final_state.position.x - tf.position.x;
            dr.y = solution.final_state.position.y - tf.position.y;
            dr.z = solution.final_state.position.z - tf.position.z;
            solution.final_position_error = dr.norm();

            Vec3 dv;
            dv.x = solution.final_state.velocity.x - tf.velocity.x;
            dv.y = solution.final_state.velocity.y - tf.velocity.y;
            dv.z = solution.final_state.velocity.z - tf.velocity.z;
            solution.final_velocity_error = dv.norm();
        }
    }

    return solution;
}

// ============================================================
// Evaluate (propagate without solving)
// ============================================================

LaunchTrajectorySolution LaunchTrajectorySolver::propagate(
    const LaunchControls& controls,
    const TerminalTarget& target) const {

    LaunchTrajectorySolution solution;
    solution.converged = false;
    solution.iterations = 0;
    solution.controls = controls;

    solution.final_state = propagate_trajectory(controls, &solution.trajectory);

    std::vector<double> residuals = compute_residuals(solution.final_state, target);
    double r_norm = 0.0;
    for (double ri : residuals) r_norm += ri * ri;
    solution.residual_norm = std::sqrt(r_norm);

    StateVector sv;
    sv.position = solution.final_state.position;
    sv.velocity = solution.final_state.velocity;
    solution.final_elements = OrbitalMechanics::state_to_elements(sv);

    solution.status = "Propagation only (no optimization)";
    return solution;
}

} // namespace sim
