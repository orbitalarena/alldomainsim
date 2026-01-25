#include "entities/launch_vehicle.hpp"
#include "physics/gravity_model.hpp"
#include "physics/atmosphere_model.hpp"
#include "physics/orbital_elements.hpp"
#include "coordinate/time_utils.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_ROTATION_RATE = 7.2921159e-5;  // rad/s

// RocketStage methods
double RocketStage::mass_flow_rate() const {
    // mdot = T / (Isp * g0)
    double isp_avg = (isp_sl + isp_vac) / 2.0;  // Rough average
    return thrust / (isp_avg * AtmosphereModel::G0);
}

double RocketStage::current_isp(double altitude) const {
    // Linear interpolation between sea level and vacuum Isp
    // Full vacuum above ~40 km
    double vacuum_alt = 40000.0;
    double factor = std::min(1.0, altitude / vacuum_alt);
    return isp_sl + factor * (isp_vac - isp_sl);
}

// LaunchVehicle implementation
LaunchVehicle::LaunchVehicle(const std::string& name, int id,
                             double latitude, double longitude, double altitude)
    : Entity(name, id),
      current_stage_(0),
      payload_mass_(0.0),
      phase_(FlightPhase::PRE_LAUNCH),
      launch_time_(0.0),
      engines_on_(false),
      target_altitude_(400000.0),  // Default 400 km orbit
      target_inclination_(28.5 * DEG_TO_RAD),  // Cape Canaveral latitude
      gravity_turn_start_alt_(1000.0),  // Start turn at 1 km
      gravity_turn_rate_(0.005),  // ~0.3 deg/s
      drag_coefficient_(0.3),
      reference_area_(10.0)  // m^2
{
    domain_ = PhysicsDomain::ORBITAL;  // Will handle ground to orbital

    launch_site_.latitude = latitude;
    launch_site_.longitude = longitude;
    launch_site_.altitude = altitude;

    // Compute launch azimuth for desired inclination
    // sin(azimuth) = cos(inclination) / cos(latitude)
    double cos_inc = std::cos(target_inclination_);
    double cos_lat = std::cos(latitude * DEG_TO_RAD);
    if (std::abs(cos_lat) > 1e-6 && std::abs(cos_inc / cos_lat) <= 1.0) {
        initial_heading_ = std::asin(cos_inc / cos_lat);
    } else {
        initial_heading_ = PI / 2.0;  // Due east
    }

    initialize_from_geodetic(latitude, longitude, altitude);
}

void LaunchVehicle::initialize_from_geodetic(double lat, double lon, double alt) {
    // Convert geodetic to ECEF
    double lat_rad = lat * DEG_TO_RAD;
    double lon_rad = lon * DEG_TO_RAD;

    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double sin_lon = std::sin(lon_rad);
    double cos_lon = std::cos(lon_rad);

    // WGS84 parameters
    double a = FrameTransformer::WGS84_A;
    double e2 = FrameTransformer::WGS84_E2;

    // Radius of curvature in prime vertical
    double N = a / std::sqrt(1.0 - e2 * sin_lat * sin_lat);

    // ECEF position
    launch_position_ecef_.x = (N + alt) * cos_lat * cos_lon;
    launch_position_ecef_.y = (N + alt) * cos_lat * sin_lon;
    launch_position_ecef_.z = (N * (1.0 - e2) + alt) * sin_lat;

    // For simplicity, assume launch at time=0, GMST=0
    // ECI position = ECEF position rotated by GMST
    // At t=0, we'll assume GMST=0 so ECI ≈ ECEF
    state_.position = launch_position_ecef_;

    // Initial velocity from Earth rotation
    double v_rot = EARTH_ROTATION_RATE * (N + alt) * cos_lat;
    state_.velocity.x = -v_rot * sin_lon;
    state_.velocity.y = v_rot * cos_lon;
    state_.velocity.z = 0.0;

    state_.frame = CoordinateFrame::J2000_ECI;
    state_.time = 0.0;

    std::cout << "LaunchVehicle " << name_ << " initialized at ("
              << lat << "°, " << lon << "°, " << alt << " m)" << std::endl;
    std::cout << "  Position: (" << state_.position.x << ", "
              << state_.position.y << ", " << state_.position.z << ") m" << std::endl;
}

void LaunchVehicle::add_stage(const RocketStage& stage) {
    stages_.push_back(stage);
    propellant_remaining_.push_back(stage.propellant_mass);
}

void LaunchVehicle::ignite() {
    if (phase_ == FlightPhase::PRE_LAUNCH && !stages_.empty()) {
        engines_on_ = true;
        phase_ = FlightPhase::VERTICAL_ASCENT;
        launch_time_ = state_.time;
        std::cout << "T+" << state_.time << "s: " << name_ << " IGNITION!" << std::endl;
    }
}

void LaunchVehicle::abort() {
    engines_on_ = false;
    phase_ = FlightPhase::COAST;
    std::cout << "T+" << state_.time << "s: " << name_ << " ABORT!" << std::endl;
}

void LaunchVehicle::set_target_orbit(double altitude, double inclination) {
    target_altitude_ = altitude;
    target_inclination_ = inclination * DEG_TO_RAD;
}

void LaunchVehicle::set_gravity_turn_start(double altitude, double pitch_rate) {
    gravity_turn_start_alt_ = altitude;
    gravity_turn_rate_ = pitch_rate;
}

void LaunchVehicle::add_maneuver(const Maneuver& maneuver) {
    maneuvers_.push_back(maneuver);
}

void LaunchVehicle::clear_maneuvers() {
    maneuvers_.clear();
}

double LaunchVehicle::get_total_mass() const {
    double mass = payload_mass_;
    for (size_t i = current_stage_; i < stages_.size(); i++) {
        mass += stages_[i].dry_mass;
        mass += propellant_remaining_[i];
    }
    return mass;
}

double LaunchVehicle::get_propellant_remaining() const {
    if (current_stage_ < stages_.size()) {
        return propellant_remaining_[current_stage_];
    }
    return 0.0;
}

double LaunchVehicle::get_altitude() const {
    double r = state_.position.norm();
    return r - GravityModel::EARTH_RADIUS;
}

double LaunchVehicle::get_downrange() const {
    // Approximate downrange as great-circle distance from launch site
    // Using current ECI position converted to geodetic
    // For simplicity, just use horizontal distance
    double dx = state_.position.x - launch_position_ecef_.x;
    double dy = state_.position.y - launch_position_ecef_.y;
    return std::sqrt(dx * dx + dy * dy);
}

double LaunchVehicle::get_velocity_magnitude() const {
    return state_.velocity.norm();
}

double LaunchVehicle::get_dynamic_pressure() const {
    double alt = get_altitude();
    double v = state_.velocity.norm();
    return AtmosphereModel::dynamic_pressure(v, alt);
}

bool LaunchVehicle::is_in_orbit() const {
    return phase_ == FlightPhase::ORBITAL || phase_ == FlightPhase::MANEUVER;
}

void LaunchVehicle::update(double dt) {
    switch (phase_) {
        case FlightPhase::PRE_LAUNCH:
            update_pre_launch(dt);
            break;

        case FlightPhase::VERTICAL_ASCENT:
        case FlightPhase::GRAVITY_TURN:
        case FlightPhase::CIRCULARIZATION:
            update_powered_flight(dt);
            break;

        case FlightPhase::COAST:
            update_coast(dt);
            break;

        case FlightPhase::ORBITAL:
        case FlightPhase::MANEUVER:
            update_orbital(dt);
            break;
    }

    state_.time += dt;
}

void LaunchVehicle::update_pre_launch(double dt) {
    // Vehicle is on the pad - no movement
    // Could add countdown logic here
}

void LaunchVehicle::update_powered_flight(double dt) {
    double alt = get_altitude();

    // Check for gravity turn transition
    if (phase_ == FlightPhase::VERTICAL_ASCENT && alt > gravity_turn_start_alt_) {
        phase_ = FlightPhase::GRAVITY_TURN;
        std::cout << "T+" << state_.time << "s: Beginning gravity turn at "
                  << alt/1000.0 << " km" << std::endl;
    }

    // Compute forces
    Vec3 gravity = compute_gravity(state_.position);
    Vec3 thrust_dir = compute_thrust_direction();
    double thrust_mag = compute_current_thrust();
    double mass = get_total_mass();

    // Thrust force
    Vec3 thrust;
    thrust.x = thrust_mag * thrust_dir.x;
    thrust.y = thrust_mag * thrust_dir.y;
    thrust.z = thrust_mag * thrust_dir.z;

    // Drag force
    Vec3 drag = AtmosphereModel::compute_drag(state_.velocity, alt,
                                              drag_coefficient_, reference_area_);

    // Total acceleration
    Vec3 accel;
    accel.x = gravity.x + (thrust.x + drag.x) / mass;
    accel.y = gravity.y + (thrust.y + drag.y) / mass;
    accel.z = gravity.z + (thrust.z + drag.z) / mass;

    // Integrate (simple Euler for now, could use RK4)
    state_.velocity.x += accel.x * dt;
    state_.velocity.y += accel.y * dt;
    state_.velocity.z += accel.z * dt;

    state_.position.x += state_.velocity.x * dt;
    state_.position.y += state_.velocity.y * dt;
    state_.position.z += state_.velocity.z * dt;

    // Consume propellant
    if (engines_on_ && current_stage_ < stages_.size()) {
        double isp = compute_current_isp();
        double mdot = thrust_mag / (isp * AtmosphereModel::G0);
        propellant_remaining_[current_stage_] -= mdot * dt;

        // Check for stage separation
        if (propellant_remaining_[current_stage_] <= 0) {
            propellant_remaining_[current_stage_] = 0;
            stage_separation();
        }
    }

    // Check for orbit insertion
    check_orbit_insertion();
}

void LaunchVehicle::update_coast(double dt) {
    // Gravity only (Keplerian motion)
    Vec3 gravity = compute_gravity(state_.position);

    state_.velocity.x += gravity.x * dt;
    state_.velocity.y += gravity.y * dt;
    state_.velocity.z += gravity.z * dt;

    state_.position.x += state_.velocity.x * dt;
    state_.position.y += state_.velocity.y * dt;
    state_.position.z += state_.velocity.z * dt;

    check_orbit_insertion();
}

void LaunchVehicle::update_orbital(double dt) {
    // Execute any scheduled maneuvers
    execute_maneuvers(dt);

    // Gravity only propagation (use GravityModel for J2)
    auto derivatives = GravityModel::compute_derivatives(state_, true);

    state_.velocity.x += derivatives.velocity.x * dt;
    state_.velocity.y += derivatives.velocity.y * dt;
    state_.velocity.z += derivatives.velocity.z * dt;

    state_.position.x += state_.velocity.x * dt;
    state_.position.y += state_.velocity.y * dt;
    state_.position.z += state_.velocity.z * dt;
}

void LaunchVehicle::stage_separation() {
    std::cout << "T+" << state_.time << "s: Stage " << (current_stage_ + 1)
              << " separation at " << get_altitude()/1000.0 << " km, "
              << get_velocity_magnitude() << " m/s" << std::endl;

    current_stage_++;

    if (current_stage_ >= stages_.size()) {
        // No more stages
        engines_on_ = false;
        phase_ = FlightPhase::COAST;
        std::cout << "T+" << state_.time << "s: All stages expended, coasting" << std::endl;
    } else {
        std::cout << "T+" << state_.time << "s: Stage " << (current_stage_ + 1)
                  << " ignition" << std::endl;
    }
}

Vec3 LaunchVehicle::compute_thrust_direction() const {
    Vec3 dir;
    double r_mag = state_.position.norm();

    // Radial unit vector (up)
    Vec3 r_hat;
    r_hat.x = state_.position.x / r_mag;
    r_hat.y = state_.position.y / r_mag;
    r_hat.z = state_.position.z / r_mag;

    if (phase_ == FlightPhase::VERTICAL_ASCENT) {
        // Thrust straight up (radial direction)
        return r_hat;
    }
    else if (phase_ == FlightPhase::GRAVITY_TURN) {
        // Gradual gravity turn: blend between radial and prograde based on altitude
        // Start at gravity_turn_start_alt_, reach horizontal around 80 km
        double alt = get_altitude();
        double turn_progress = (alt - gravity_turn_start_alt_) / (80000.0 - gravity_turn_start_alt_);
        turn_progress = std::max(0.0, std::min(1.0, turn_progress));

        // Pitch angle: 0 = vertical, pi/2 = horizontal
        double pitch_angle = turn_progress * PI / 2.0;

        // Compute horizontal direction (cross r_hat with z, then cross with r_hat)
        // Simplified: use velocity direction projected horizontal
        double v_mag = state_.velocity.norm();
        Vec3 v_hat;
        if (v_mag > 1.0) {
            v_hat.x = state_.velocity.x / v_mag;
            v_hat.y = state_.velocity.y / v_mag;
            v_hat.z = state_.velocity.z / v_mag;
        } else {
            v_hat = r_hat;
        }

        // Remove radial component from velocity to get horizontal direction
        double v_radial = v_hat.x * r_hat.x + v_hat.y * r_hat.y + v_hat.z * r_hat.z;
        Vec3 h_hat;
        h_hat.x = v_hat.x - v_radial * r_hat.x;
        h_hat.y = v_hat.y - v_radial * r_hat.y;
        h_hat.z = v_hat.z - v_radial * r_hat.z;
        double h_mag = std::sqrt(h_hat.x*h_hat.x + h_hat.y*h_hat.y + h_hat.z*h_hat.z);

        if (h_mag > 0.1) {
            h_hat.x /= h_mag;
            h_hat.y /= h_mag;
            h_hat.z /= h_mag;
        } else {
            // No horizontal velocity yet, use initial heading
            // Point roughly east for inclination matching
            h_hat.x = -r_hat.y;
            h_hat.y = r_hat.x;
            h_hat.z = 0.0;
            h_mag = std::sqrt(h_hat.x*h_hat.x + h_hat.y*h_hat.y);
            if (h_mag > 0.1) {
                h_hat.x /= h_mag;
                h_hat.y /= h_mag;
            }
        }

        // Blend radial and horizontal based on pitch angle
        double cos_pitch = std::cos(pitch_angle);
        double sin_pitch = std::sin(pitch_angle);

        dir.x = cos_pitch * r_hat.x + sin_pitch * h_hat.x;
        dir.y = cos_pitch * r_hat.y + sin_pitch * h_hat.y;
        dir.z = cos_pitch * r_hat.z + sin_pitch * h_hat.z;

        return dir;
    }
    else if (phase_ == FlightPhase::CIRCULARIZATION) {
        // Thrust prograde for circularization
        double v_mag = state_.velocity.norm();
        if (v_mag > 1.0) {
            dir.x = state_.velocity.x / v_mag;
            dir.y = state_.velocity.y / v_mag;
            dir.z = state_.velocity.z / v_mag;
        } else {
            dir = r_hat;
        }
        return dir;
    }

    return r_hat;  // Default: radial
}

Vec3 LaunchVehicle::compute_gravity(const Vec3& position) const {
    double r = position.norm();
    double r3 = r * r * r;
    double mu = GravityModel::EARTH_MU;

    Vec3 g;
    g.x = -mu * position.x / r3;
    g.y = -mu * position.y / r3;
    g.z = -mu * position.z / r3;

    return g;
}

double LaunchVehicle::compute_current_thrust() const {
    if (!engines_on_ || current_stage_ >= stages_.size()) {
        return 0.0;
    }
    return stages_[current_stage_].thrust;
}

double LaunchVehicle::compute_current_isp() const {
    if (current_stage_ >= stages_.size()) {
        return 0.0;
    }
    return stages_[current_stage_].current_isp(get_altitude());
}

void LaunchVehicle::check_orbit_insertion() {
    // Check if we've achieved orbit
    // Criteria: altitude > target, eccentricity < 0.1, periapsis > atmosphere

    if (phase_ == FlightPhase::ORBITAL) return;

    double alt = get_altitude();
    if (alt < 100000.0) return;  // Still in atmosphere

    // Compute orbital elements
    OrbitalElements elem = OrbitalMechanics::state_to_elements(state_);

    double periapsis_alt = elem.periapsis() - GravityModel::EARTH_RADIUS;
    double apoapsis_alt = elem.apoapsis() - GravityModel::EARTH_RADIUS;

    // Check if orbit is stable (periapsis above atmosphere)
    if (periapsis_alt > 100000.0 && elem.eccentricity < 0.5) {
        if (phase_ != FlightPhase::ORBITAL) {
            engines_on_ = false;
            phase_ = FlightPhase::ORBITAL;
            std::cout << "\n=== ORBIT ACHIEVED ===" << std::endl;
            std::cout << "T+" << state_.time << "s" << std::endl;
            std::cout << "  Periapsis: " << periapsis_alt/1000.0 << " km" << std::endl;
            std::cout << "  Apoapsis: " << apoapsis_alt/1000.0 << " km" << std::endl;
            std::cout << "  Eccentricity: " << elem.eccentricity << std::endl;
            std::cout << "  Inclination: " << elem.inclination * RAD_TO_DEG << " deg" << std::endl;
            std::cout << "  Period: " << elem.period()/60.0 << " min" << std::endl;
        }
    }
}

void LaunchVehicle::execute_maneuvers(double dt) {
    for (auto& maneuver : maneuvers_) {
        if (maneuver.completed) continue;

        if (state_.time >= maneuver.start_time &&
            state_.time < maneuver.start_time + maneuver.duration) {

            // Execute maneuver (apply delta-V over duration)
            double dv_fraction = dt / maneuver.duration;
            state_.velocity.x += maneuver.delta_v.x * dv_fraction;
            state_.velocity.y += maneuver.delta_v.y * dv_fraction;
            state_.velocity.z += maneuver.delta_v.z * dv_fraction;

            if (phase_ != FlightPhase::MANEUVER) {
                phase_ = FlightPhase::MANEUVER;
                std::cout << "T+" << state_.time << "s: Executing maneuver, dV = "
                          << maneuver.delta_v.norm() << " m/s" << std::endl;
            }
        }

        if (state_.time >= maneuver.start_time + maneuver.duration) {
            maneuver.completed = true;
            phase_ = FlightPhase::ORBITAL;
            std::cout << "T+" << state_.time << "s: Maneuver complete" << std::endl;
        }
    }
}

} // namespace sim
