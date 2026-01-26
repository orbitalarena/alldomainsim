/**
 * Command Module Implementation
 */

#include "command_module.hpp"
#include "physics/gravity_model.hpp"
#include "physics/atmosphere_model.hpp"
#include "physics/multi_body_gravity.hpp"
#include "propagators/rk4_integrator.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

CommandModule::CommandModule(const std::string& name, int id)
    : Entity(name, id) {
    domain_ = PhysicsDomain::ORBITAL;
}

double CommandModule::get_total_mass() const {
    return dry_mass + heat_shield_mass * heat_shield_remaining_ + propellant_mass;
}

double CommandModule::get_altitude() const {
    double radius;
    if (primary_body_ == PrimaryBody::MOON) {
        Vec3 pos_mci = MultiBodyGravity::eci_to_mci(state_.position, moon_state_.position);
        radius = pos_mci.norm();
        return radius - MOON_RADIUS;
    } else {
        radius = state_.position.norm();
        return radius - EARTH_RADIUS;
    }
}

void CommandModule::get_orbit_params(double& apogee, double& perigee, double& eccentricity) const {
    double mu = (primary_body_ == PrimaryBody::MOON) ? MOON_MU : EARTH_MU;
    double body_radius = (primary_body_ == PrimaryBody::MOON) ? MOON_RADIUS : EARTH_RADIUS;

    Vec3 pos = state_.position;
    Vec3 vel = state_.velocity;

    // Convert to primary-centered if needed
    if (primary_body_ == PrimaryBody::MOON) {
        pos = MultiBodyGravity::eci_to_mci(pos, moon_state_.position);
        vel = MultiBodyGravity::vel_eci_to_mci(vel, moon_state_.velocity);
    }

    double r = pos.norm();
    double v = vel.norm();

    // Specific orbital energy
    double energy = 0.5 * v * v - mu / r;

    // Semi-major axis
    double a = -mu / (2.0 * energy);

    // Angular momentum magnitude
    Vec3 h;
    h.x = pos.y * vel.z - pos.z * vel.y;
    h.y = pos.z * vel.x - pos.x * vel.z;
    h.z = pos.x * vel.y - pos.y * vel.x;
    double h_mag = h.norm();

    // Eccentricity
    double e_sq = 1.0 + 2.0 * energy * h_mag * h_mag / (mu * mu);
    eccentricity = (e_sq > 0) ? std::sqrt(e_sq) : 0.0;

    // Apogee and perigee altitudes
    double r_a = a * (1.0 + eccentricity);
    double r_p = a * (1.0 - eccentricity);

    apogee = r_a - body_radius;
    perigee = r_p - body_radius;
}

CMAtmosphericState CommandModule::get_atmospheric_state() const {
    CMAtmosphericState atm;

    atm.altitude = get_altitude();
    atm.velocity = state_.velocity.norm();
    atm.mach = AtmosphereModel::compute_mach(atm.velocity, atm.altitude);
    atm.dynamic_pressure = AtmosphereModel::dynamic_pressure(atm.velocity, atm.altitude);
    atm.heat_flux = AtmosphereModel::compute_heat_flux(atm.velocity, atm.altitude, nose_radius);

    // Drag force
    double rho = AtmosphereModel::get_density_extended(atm.altitude);
    double drag_mag = 0.5 * rho * atm.velocity * atm.velocity * Cd * cross_section;
    atm.g_load = AtmosphereModel::compute_g_load(drag_mag, get_total_mass());

    // Flight path angle
    double r_dot_v = state_.position.x * state_.velocity.x +
                     state_.position.y * state_.velocity.y +
                     state_.position.z * state_.velocity.z;
    double r_mag = state_.position.norm();
    atm.flight_path_angle = std::asin(r_dot_v / (r_mag * atm.velocity));

    return atm;
}

void CommandModule::apply_delta_v(const Vec3& dv) {
    state_.velocity.x += dv.x;
    state_.velocity.y += dv.y;
    state_.velocity.z += dv.z;
}

void CommandModule::add_maneuver(const CMManeuver& maneuver) {
    maneuvers_.push_back(maneuver);
}

void CommandModule::deploy_drogue() {
    if (!drogue_deployed_) {
        drogue_deployed_ = true;
        Cd = drogue_Cd;
        cross_section = drogue_area;
        flight_phase_ = CMFlightPhase::DROGUE_DESCENT;
    }
}

void CommandModule::deploy_main() {
    if (!main_deployed_) {
        main_deployed_ = true;
        Cd = main_Cd;
        cross_section = main_area;
        flight_phase_ = CMFlightPhase::MAIN_DESCENT;
    }
}

void CommandModule::update(double dt) {
    mission_time_ += dt;

    // Check for scheduled maneuvers
    check_maneuvers();

    // Update based on current phase
    switch (flight_phase_) {
        case CMFlightPhase::ORBITAL:
        case CMFlightPhase::POWERED:
            update_orbital(dt);
            // Check if entering atmosphere
            if (check_atmosphere_entry()) {
                flight_phase_ = CMFlightPhase::AEROBRAKING;
            }
            break;

        case CMFlightPhase::AEROBRAKING:
        case CMFlightPhase::REENTRY:
            update_atmospheric(dt);
            check_parachute_deployment();
            break;

        case CMFlightPhase::DROGUE_DESCENT:
        case CMFlightPhase::MAIN_DESCENT:
            update_parachute(dt);
            break;

        case CMFlightPhase::SPLASHDOWN:
            // No updates - mission complete
            break;
    }
}

void CommandModule::update_orbital(double dt) {
    // Multi-body gravity derivative function
    auto derivatives = [this](const StateVector& s) {
        StateVector deriv;

        // Get gravity acceleration based on primary body
        Vec3 accel = MultiBodyGravity::compute_acceleration(
            s.position, primary_body_, moon_state_.position,
            true,   // include J2
            true);  // include third-body

        deriv.position = accel;    // Acceleration stored as position derivative
        deriv.velocity = s.velocity;

        return deriv;
    };

    // RK4 integration
    state_ = RK4Integrator::step(state_, dt, derivatives);

    // Check for SOI transition
    PrimaryBody new_primary = MultiBodyGravity::determine_primary(
        state_.position, moon_state_.position);

    if (new_primary != primary_body_) {
        primary_body_ = new_primary;
        // Note: Velocity is already in ECI, so no conversion needed
    }
}

void CommandModule::update_atmospheric(double dt) {
    double mass = get_total_mass();
    double current_Cd = Cd;
    double current_area = cross_section;

    // Derivative function with gravity + drag
    auto derivatives = [this, mass, current_Cd, current_area](const StateVector& s) {
        StateVector deriv;

        // Gravity (Earth only during atmospheric flight)
        Vec3 grav = GravityModel::compute_with_j2(s.position);

        // Altitude and drag
        double alt = s.position.norm() - EARTH_RADIUS;
        Vec3 drag_force = AtmosphereModel::compute_drag(
            s.velocity, alt, current_Cd, current_area);
        Vec3 drag_accel;
        drag_accel.x = drag_force.x / mass;
        drag_accel.y = drag_force.y / mass;
        drag_accel.z = drag_force.z / mass;

        // Total acceleration
        deriv.position.x = grav.x + drag_accel.x;
        deriv.position.y = grav.y + drag_accel.y;
        deriv.position.z = grav.z + drag_accel.z;

        deriv.velocity = s.velocity;

        return deriv;
    };

    // RK4 integration
    state_ = RK4Integrator::step(state_, dt, derivatives);

    // Update statistics
    CMAtmosphericState atm = get_atmospheric_state();

    max_g_experienced = std::max(max_g_experienced, atm.g_load);
    total_heat_absorbed += atm.heat_flux * dt;

    // Heat shield ablation (simplified model)
    if (atm.heat_flux > 1e6) {  // Significant heating
        // Assume 1% ablation per 10 MJ/m² of heat load
        double ablation = atm.heat_flux * dt / 1e9;  // Fraction
        heat_shield_remaining_ = std::max(0.0, heat_shield_remaining_ - ablation);
    }

    // Track atmospheric entry/exit for aerobraking pass counting
    if (atm.altitude < 120000.0) {
        in_atmosphere_ = true;
    }

    // Check if exited atmosphere (for aerobraking)
    if (flight_phase_ == CMFlightPhase::AEROBRAKING && atm.altitude > 120000.0 && in_atmosphere_) {
        // We've completed an aerobraking pass
        aerobrake_pass_count++;
        in_atmosphere_ = false;

        // Check orbital parameters to see if we should continue aerobraking
        double apogee, perigee, ecc;
        get_orbit_params(apogee, perigee, ecc);

        if (perigee > 120000.0) {
            // Orbit fully raised above atmosphere - aerobraking complete
            flight_phase_ = CMFlightPhase::ORBITAL;
        } else {
            // Still need more passes - return to orbital for coast to next perigee
            flight_phase_ = CMFlightPhase::ORBITAL;
        }
    }

    // Check for splashdown
    if (atm.altitude < 0.0) {
        flight_phase_ = CMFlightPhase::SPLASHDOWN;
        state_.velocity = Vec3{0.0, 0.0, 0.0};
    }
}

void CommandModule::update_parachute(double dt) {
    // Same as atmospheric but check for splashdown
    update_atmospheric(dt);

    // Check for main parachute deployment
    check_parachute_deployment();

    // Check descent rate for smooth landing
    double altitude = get_altitude();
    if (altitude < 0.0) {
        flight_phase_ = CMFlightPhase::SPLASHDOWN;
        state_.position.x = state_.position.x * EARTH_RADIUS / state_.position.norm();
        state_.position.y = state_.position.y * EARTH_RADIUS / state_.position.norm();
        state_.position.z = state_.position.z * EARTH_RADIUS / state_.position.norm();
        state_.velocity = Vec3{0.0, 0.0, 0.0};
    }
}

void CommandModule::check_maneuvers() {
    for (auto& m : maneuvers_) {
        if (!m.executed && mission_time_ >= m.start_time) {
            // Execute maneuver (impulsive for now)
            apply_delta_v(m.delta_v);
            m.executed = true;

            // Use propellant (simplified)
            double dv_mag = m.delta_v.norm();
            double Isp = 300.0;  // Typical RCS Isp
            double mass_ratio = std::exp(dv_mag / (Isp * G0));
            double fuel_used = get_total_mass() * (1.0 - 1.0 / mass_ratio);
            propellant_mass = std::max(0.0, propellant_mass - fuel_used);
        }
    }
}

void CommandModule::check_parachute_deployment() {
    CMAtmosphericState atm = get_atmospheric_state();

    // Auto deploy drogue
    if (!drogue_deployed_ &&
        atm.altitude < drogue_deploy_alt &&
        atm.mach < drogue_deploy_mach) {
        deploy_drogue();
    }

    // Auto deploy main
    if (drogue_deployed_ && !main_deployed_ &&
        atm.altitude < main_deploy_alt) {
        deploy_main();
    }
}

bool CommandModule::check_atmosphere_entry() {
    // Only check when around Earth
    if (primary_body_ != PrimaryBody::EARTH) {
        return false;
    }

    double altitude = get_altitude();
    return altitude < 120000.0;  // Entry interface
}

}  // namespace sim
