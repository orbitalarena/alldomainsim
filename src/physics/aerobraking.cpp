/**
 * Aerobraking Calculator Implementation
 */

#include "aerobraking.hpp"
#include "atmosphere_model.hpp"
#include "gravity_model.hpp"
#include "propagators/rk4_integrator.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

void AerobrakingCalculator::compute_orbit_params(
    const StateVector& state,
    double mu,
    double& a, double& e, double& apogee_alt, double& perigee_alt) {

    double r = state.position.norm();
    double v = state.velocity.norm();

    // Specific orbital energy
    double energy = 0.5 * v * v - mu / r;

    // Semi-major axis from vis-viva
    if (std::abs(energy) > 1e-10) {
        a = -mu / (2.0 * energy);
    } else {
        a = 1e12;  // Nearly parabolic
    }

    // Angular momentum
    Vec3 h;
    h.x = state.position.y * state.velocity.z - state.position.z * state.velocity.y;
    h.y = state.position.z * state.velocity.x - state.position.x * state.velocity.z;
    h.z = state.position.x * state.velocity.y - state.position.y * state.velocity.x;
    double h_mag = h.norm();

    // Eccentricity
    double e_sq = 1.0 + 2.0 * energy * h_mag * h_mag / (mu * mu);
    e = (e_sq > 0) ? std::sqrt(e_sq) : 0.0;

    // Apogee and perigee (altitudes above Earth surface)
    double r_a = a * (1.0 + e);  // Apogee radius
    double r_p = a * (1.0 - e);  // Perigee radius

    apogee_alt = r_a - EARTH_RADIUS;
    perigee_alt = r_p - EARTH_RADIUS;
}

bool AerobrakingCalculator::will_enter_atmosphere(
    const StateVector& state,
    double mu,
    double atm_altitude) {

    double a, e, apogee_alt, perigee_alt;
    compute_orbit_params(state, mu, a, e, apogee_alt, perigee_alt);

    return perigee_alt < atm_altitude;
}

AerobrakePassResult AerobrakingCalculator::simulate_pass(
    const StateVector& entry_state,
    const AerobrakeVehicle& vehicle,
    double dt) {

    AerobrakePassResult result;

    // Initialize entry conditions
    result.entry_altitude = entry_state.position.norm() - EARTH_RADIUS;
    result.entry_velocity = entry_state.velocity.norm();

    // Flight path angle (angle between velocity and local horizontal)
    double r_dot_v = entry_state.position.x * entry_state.velocity.x +
                     entry_state.position.y * entry_state.velocity.y +
                     entry_state.position.z * entry_state.velocity.z;
    result.entry_flight_path = std::asin(r_dot_v /
        (entry_state.position.norm() * entry_state.velocity.norm()));

    // Initialize tracking variables
    result.min_altitude = result.entry_altitude;
    result.max_g_load = 0.0;
    result.max_heat_flux = 0.0;
    result.max_dynamic_pressure = 0.0;
    result.total_heat_load = 0.0;
    result.pass_duration = 0.0;

    // Current state for integration
    StateVector state = entry_state;
    double mass = vehicle.mass;

    // Derivative function for RK4 (gravity + drag)
    auto derivatives = [&vehicle, mass](const StateVector& s) {
        StateVector deriv;

        // Gravity (J2 for accuracy during pass)
        Vec3 grav = GravityModel::compute_with_j2(s.position);

        // Altitude
        double alt = s.position.norm() - 6378137.0;  // EARTH_RADIUS

        // Drag
        Vec3 drag_force = AtmosphereModel::compute_drag(
            s.velocity, alt, vehicle.drag_coefficient, vehicle.cross_section);
        Vec3 drag_accel;
        drag_accel.x = drag_force.x / mass;
        drag_accel.y = drag_force.y / mass;
        drag_accel.z = drag_force.z / mass;

        // Total acceleration
        deriv.position.x = grav.x + drag_accel.x;
        deriv.position.y = grav.y + drag_accel.y;
        deriv.position.z = grav.z + drag_accel.z;

        // Velocity derivative is position
        deriv.velocity = s.velocity;

        return deriv;
    };

    // Integrate through atmosphere
    bool descending = true;
    double prev_altitude = result.entry_altitude;
    double time = 0.0;

    while (true) {
        double altitude = state.position.norm() - EARTH_RADIUS;
        double velocity = state.velocity.norm();

        // Track minimum altitude
        if (altitude < result.min_altitude) {
            result.min_altitude = altitude;
        }

        // Check if we've passed through and are exiting
        if (altitude > prev_altitude && !descending) {
            // Already ascending, check if we've exited atmosphere
            if (altitude > ENTRY_INTERFACE) {
                break;  // Exited atmosphere
            }
        }
        else if (altitude < prev_altitude) {
            descending = true;
        }
        else if (altitude > prev_altitude) {
            descending = false;
        }

        // Compute current conditions
        double rho = AtmosphereModel::get_density_extended(altitude);
        double q = AtmosphereModel::dynamic_pressure(velocity, altitude);
        double heat_flux = AtmosphereModel::compute_heat_flux(
            velocity, altitude, vehicle.nose_radius);

        // Drag force for g-load calculation
        double drag_mag = 0.5 * rho * velocity * velocity *
                          vehicle.drag_coefficient * vehicle.cross_section;
        double g_load = AtmosphereModel::compute_g_load(drag_mag, mass);

        // Update peak values
        result.max_g_load = std::max(result.max_g_load, g_load);
        result.max_heat_flux = std::max(result.max_heat_flux, heat_flux);
        result.max_dynamic_pressure = std::max(result.max_dynamic_pressure, q);

        // Integrate heat load
        result.total_heat_load += heat_flux * dt;

        // Propagate state
        state = RK4Integrator::step(state, dt, derivatives);
        time += dt;
        prev_altitude = altitude;

        // Safety limit on integration time (10 minutes max for a pass)
        if (time > 600.0) {
            break;
        }

        // Check for impact
        if (altitude < 0.0) {
            result.min_altitude = 0.0;
            break;
        }
    }

    // Record exit conditions
    result.exit_velocity = state.velocity.norm();
    result.delta_v_loss = result.entry_velocity - result.exit_velocity;
    result.pass_duration = time;

    // Compute new orbital parameters
    compute_orbit_params(state, EARTH_MU,
        result.new_eccentricity,  // Using as temp for 'a'
        result.new_eccentricity,
        result.new_apogee,
        result.new_perigee);

    // Actually compute properly
    double a, e;
    compute_orbit_params(state, EARTH_MU, a, e, result.new_apogee, result.new_perigee);
    result.new_eccentricity = e;

    return result;
}

int AerobrakingCalculator::estimate_passes_needed(
    double initial_apogee,
    double initial_perigee,
    double target_apogee,
    const AerobrakeVehicle& vehicle) {

    // Rough estimate based on energy reduction per pass
    // Each pass loses roughly 1-5% of orbital energy depending on perigee depth

    if (initial_perigee > ENTRY_INTERFACE) {
        return -1;  // Orbit doesn't enter atmosphere
    }

    // Approximate delta-v per pass (empirical, varies with perigee depth)
    double perigee_depth = ENTRY_INTERFACE - initial_perigee;
    double dv_per_pass = 50.0 + 2.0 * perigee_depth / 1000.0;  // m/s, rough estimate

    // Delta-v needed to reduce apogee (Hohmann-like approximation)
    double r_a_initial = EARTH_RADIUS + initial_apogee;
    double r_a_target = EARTH_RADIUS + target_apogee;
    double r_p = EARTH_RADIUS + initial_perigee;

    double v_p_initial = std::sqrt(EARTH_MU * (2.0 / r_p - 1.0 / ((r_a_initial + r_p) / 2.0)));
    double v_p_target = std::sqrt(EARTH_MU * (2.0 / r_p - 1.0 / ((r_a_target + r_p) / 2.0)));

    double total_dv_needed = v_p_initial - v_p_target;

    int passes = static_cast<int>(std::ceil(total_dv_needed / dv_per_pass));

    return std::max(1, passes);
}

}  // namespace sim
