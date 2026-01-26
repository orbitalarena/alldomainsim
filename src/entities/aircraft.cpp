#include "aircraft.hpp"
#include "physics/atmosphere_model.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace sim {

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_RADIUS = 6371000.0;  // meters
constexpr double GRAVITY = 9.80665;          // m/s²

// WGS84 ellipsoid parameters
constexpr double WGS84_A = 6378137.0;        // Semi-major axis (m)
constexpr double WGS84_F = 1.0 / 298.257223563;  // Flattening
constexpr double WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;  // Eccentricity squared

Aircraft::Aircraft(int id, const std::string& callsign, const AircraftConfig& config)
    : Entity(callsign, id), callsign_(callsign), config_(config) {
    fuel_mass_ = config_.max_fuel * 0.8;  // Start with 80% fuel
    domain_ = PhysicsDomain::GROUND;
}

void Aircraft::set_initial_position(double lat, double lon, double alt_msl) {
    double x, y, z;
    geodetic_to_ecef(lat, lon, alt_msl, x, y, z);
    state_.position = Vec3(x, y, z);
    state_.velocity = Vec3(0, 0, 0);
    heading_ = 0.0;
    target_altitude_ = alt_msl;
}

void Aircraft::set_fuel(double fuel_kg) {
    fuel_mass_ = std::clamp(fuel_kg, 0.0, config_.max_fuel);
}

void Aircraft::set_throttle(double throttle) {
    throttle_ = std::clamp(throttle, 0.0, 1.0);
}

void Aircraft::set_target_altitude(double alt_m) {
    target_altitude_ = std::clamp(alt_m, 0.0, config_.service_ceiling);
}

void Aircraft::set_target_speed(double speed_ms) {
    target_speed_ = speed_ms;
}

void Aircraft::set_target_heading(double heading_deg) {
    target_heading_ = std::fmod(heading_deg + 360.0, 360.0);
    heading_hold_ = true;
}

double Aircraft::get_total_mass() const {
    return config_.empty_mass + fuel_mass_ + config_.payload_mass;
}

void Aircraft::set_flight_plan(const std::vector<Waypoint>& waypoints) {
    flight_plan_ = waypoints;
    current_waypoint_ = 0;
}

void Aircraft::add_waypoint(const Waypoint& wp) {
    flight_plan_.push_back(wp);
}

void Aircraft::set_wind(const WindVector& wind) {
    wind_field_.clear();
    wind_field_.push_back(wind);
}

void Aircraft::set_wind_field(const std::vector<WindVector>& winds) {
    wind_field_ = winds;
    // Sort by altitude
    std::sort(wind_field_.begin(), wind_field_.end(),
              [](const WindVector& a, const WindVector& b) {
                  return a.altitude < b.altitude;
              });
}

WindVector Aircraft::get_wind_at_altitude(double alt) const {
    if (wind_field_.empty()) {
        return WindVector{0, 0, alt};
    }

    if (wind_field_.size() == 1) {
        return wind_field_[0];
    }

    // Linear interpolation between altitude layers
    for (size_t i = 0; i < wind_field_.size() - 1; i++) {
        if (alt >= wind_field_[i].altitude && alt <= wind_field_[i + 1].altitude) {
            double t = (alt - wind_field_[i].altitude) /
                       (wind_field_[i + 1].altitude - wind_field_[i].altitude);
            WindVector result;
            result.altitude = alt;
            result.speed = wind_field_[i].speed * (1 - t) + wind_field_[i + 1].speed * t;
            result.direction = wind_field_[i].direction * (1 - t) + wind_field_[i + 1].direction * t;
            return result;
        }
    }

    // Return nearest if outside range
    if (alt < wind_field_.front().altitude) return wind_field_.front();
    return wind_field_.back();
}

void Aircraft::update(double dt) {
    update_phase();
    update_autopilot(dt);
    update_aerodynamics(dt);
    update_propulsion(dt);
    update_kinematics(dt);
    update_fuel(dt);

    state_.time += dt;
}

void Aircraft::update_phase() {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    if (fuel_mass_ <= 0 && phase_ != FlightPhase::LANDED && phase_ != FlightPhase::LANDING) {
        // Emergency - out of fuel, descend immediately
        if (alt > 100.0) {
            phase_ = FlightPhase::DESCENT;
        } else {
            phase_ = FlightPhase::LANDING;
        }
        return;
    }

    switch (phase_) {
        case FlightPhase::PARKED:
            if (throttle_ > 0.1) {
                phase_ = FlightPhase::TAXI;
            }
            break;

        case FlightPhase::TAXI:
            // Transition to takeoff after brief taxi (simulated)
            if (state_.time > 30.0) {  // 30 seconds of taxi
                phase_ = FlightPhase::TAKEOFF;
                domain_ = PhysicsDomain::AERO;
            }
            break;

        case FlightPhase::TAKEOFF:
            if (alt > 300.0) {  // Positive climb established (~1000 ft AGL)
                phase_ = FlightPhase::CLIMB;
            }
            break;

        case FlightPhase::CLIMB:
            if (alt >= target_altitude_ - 200.0) {
                phase_ = FlightPhase::CRUISE;
            }
            break;

        case FlightPhase::CRUISE:
            // Safety: if we've somehow descended below cruise, go back to climb
            if (alt < target_altitude_ * 0.5 && target_altitude_ > 3000.0) {
                phase_ = FlightPhase::CLIMB;
                break;
            }

            if (!flight_plan_.empty()) {
                double dist_to_dest = distance_to_waypoint(flight_plan_.back());
                // Begin descent ~150 km out (gives time to descend from cruise alt)
                if (dist_to_dest < 150000.0) {
                    phase_ = FlightPhase::DESCENT;
                }
            }
            break;

        case FlightPhase::DESCENT:
            if (alt < 1500.0) {  // ~5000 ft - begin approach
                phase_ = FlightPhase::APPROACH;
            }
            break;

        case FlightPhase::APPROACH:
            if (alt < 50.0 && groundspeed_ < 85.0) {
                phase_ = FlightPhase::LANDING;
            }
            break;

        case FlightPhase::LANDING:
            if (groundspeed_ < 5.0) {
                phase_ = FlightPhase::LANDED;
                domain_ = PhysicsDomain::GROUND;
            }
            break;

        case FlightPhase::LANDED:
            // Stay landed
            break;
    }
}

void Aircraft::update_autopilot(double dt) {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    // Navigate to current waypoint
    if (!flight_plan_.empty() && current_waypoint_ < (int)flight_plan_.size()) {
        navigate_to_waypoint(dt);
    }

    // Phase-specific throttle and speed targets
    switch (phase_) {
        case FlightPhase::PARKED:
            throttle_ = 0.0;
            target_speed_ = 0.0;
            break;

        case FlightPhase::TAXI:
            throttle_ = 0.3;
            target_speed_ = 15.0;  // ~30 kts taxi
            break;

        case FlightPhase::TAKEOFF:
            throttle_ = 1.0;
            target_speed_ = 85.0;  // V2 ~165 kts
            target_altitude_ = 1000.0;  // Initial climb target
            break;

        case FlightPhase::CLIMB:
            throttle_ = 0.9;
            // Target speed and altitude come from waypoints
            break;

        case FlightPhase::CRUISE:
            // Throttle set to maintain speed and altitude
            {
                double speed_error = target_speed_ - true_airspeed_;
                double alt_error = target_altitude_ - alt;

                // Need more throttle if climbing or accelerating
                double throttle_adjust = speed_error * 0.001 + alt_error * 0.00001;
                throttle_ += throttle_adjust * dt;
                throttle_ = std::clamp(throttle_, 0.4, 0.85);
            }
            break;

        case FlightPhase::DESCENT:
            throttle_ = 0.25;
            // Descend toward approach altitude
            if (target_altitude_ > 3000.0) {
                target_altitude_ -= 5.0 * dt;  // Descend at ~1000 fpm
            }
            target_speed_ = 180.0;  // 350 kts descent speed
            break;

        case FlightPhase::APPROACH:
            throttle_ = 0.35;
            target_speed_ = 75.0;  // ~145 kts approach
            target_altitude_ = 300.0;
            break;

        case FlightPhase::LANDING:
            throttle_ = 0.0;
            target_speed_ = 70.0;
            break;

        case FlightPhase::LANDED:
            throttle_ = 0.0;
            target_speed_ = 0.0;
            break;
    }
}

void Aircraft::navigate_to_waypoint(double dt) {
    if (current_waypoint_ >= (int)flight_plan_.size()) return;

    const Waypoint& wp = flight_plan_[current_waypoint_];

    // Check if we've reached the waypoint
    double dist = distance_to_waypoint(wp);
    if (dist < 5000.0) {  // 5 km capture radius
        current_waypoint_++;
        if (current_waypoint_ < (int)flight_plan_.size()) {
            target_altitude_ = flight_plan_[current_waypoint_].altitude;
            target_speed_ = flight_plan_[current_waypoint_].target_speed;
        }
        return;
    }

    // Compute bearing to waypoint
    double bearing = bearing_to_waypoint(wp);
    target_heading_ = bearing;

    // Bank to turn toward waypoint
    double heading_error = target_heading_ - heading_;
    // Normalize to -180 to 180
    while (heading_error > 180.0) heading_error -= 360.0;
    while (heading_error < -180.0) heading_error += 360.0;

    // Bank angle proportional to heading error
    double target_bank = std::clamp(heading_error * 1.5,
                                    -config_.max_bank_angle,
                                    config_.max_bank_angle);

    // Smooth bank angle change
    double bank_rate = 5.0;  // degrees per second
    double bank_change = std::clamp(target_bank - bank_angle_,
                                    -bank_rate * dt,
                                    bank_rate * dt);
    bank_angle_ += bank_change;

    // Update altitude target from waypoint
    if (phase_ == FlightPhase::CRUISE || phase_ == FlightPhase::CLIMB) {
        target_altitude_ = wp.altitude;
    }
    target_speed_ = wp.target_speed;
}

double Aircraft::distance_to_waypoint(const Waypoint& wp) const {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    // Haversine formula
    double lat1 = lat * DEG_TO_RAD;
    double lat2 = wp.latitude * DEG_TO_RAD;
    double dlat = (wp.latitude - lat) * DEG_TO_RAD;
    double dlon = (wp.longitude - lon) * DEG_TO_RAD;

    double a = std::sin(dlat / 2) * std::sin(dlat / 2) +
               std::cos(lat1) * std::cos(lat2) *
               std::sin(dlon / 2) * std::sin(dlon / 2);
    double c = 2 * std::atan2(std::sqrt(a), std::sqrt(1 - a));

    return EARTH_RADIUS * c;
}

double Aircraft::bearing_to_waypoint(const Waypoint& wp) const {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    double lat1 = lat * DEG_TO_RAD;
    double lat2 = wp.latitude * DEG_TO_RAD;
    double dlon = (wp.longitude - lon) * DEG_TO_RAD;

    double y = std::sin(dlon) * std::cos(lat2);
    double x = std::cos(lat1) * std::sin(lat2) -
               std::sin(lat1) * std::cos(lat2) * std::cos(dlon);

    double bearing = std::atan2(y, x) * RAD_TO_DEG;
    return std::fmod(bearing + 360.0, 360.0);
}

double Aircraft::get_air_density() const {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);
    return AtmosphereModel::get_density(alt);
}

double Aircraft::get_speed_of_sound() const {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);
    AtmosphereState atm = AtmosphereModel::get_atmosphere(alt);
    return atm.speed_of_sound;
}

double Aircraft::compute_lift_coefficient() const {
    // For level flight: L = W, so Cl = 2*W / (rho * V^2 * S)
    // Add corrections for climb/descent
    double mass = get_total_mass();
    double weight = mass * GRAVITY;
    double rho = get_air_density();
    double v = std::max(true_airspeed_, 1.0);

    double cl_required = (2.0 * weight * std::cos(bank_angle_ * DEG_TO_RAD)) /
                         (rho * v * v * config_.wing_area);

    // Limit to realistic values
    return std::clamp(cl_required, 0.0, config_.cl_max);
}

double Aircraft::compute_drag_coefficient(double cl) const {
    // Drag polar: Cd = Cd0 + Cl^2 / (pi * AR * e)
    double cd_induced = cl * cl / (PI * config_.aspect_ratio * config_.oswald_efficiency);
    return config_.cd0 + cd_induced;
}

double Aircraft::compute_thrust() const {
    // No thrust without fuel
    if (fuel_mass_ <= 0) return 0.0;

    // Thrust varies with altitude (air density)
    double rho = get_air_density();
    double rho_sl = 1.225;  // Sea level density
    double density_ratio = rho / rho_sl;

    // Simple thrust lapse model
    double thrust = config_.max_thrust_per_engine * config_.num_engines *
                   throttle_ * std::pow(density_ratio, 0.7);

    return thrust;
}

void Aircraft::update_aerodynamics(double dt) {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    // Get wind
    WindVector wind = get_wind_at_altitude(alt);

    // Convert wind to velocity components (wind direction is where it's FROM)
    double wind_rad = (wind.direction + 180.0) * DEG_TO_RAD;  // Convert to where it's going
    double wind_east = wind.speed * std::sin(wind_rad);
    double wind_north = wind.speed * std::cos(wind_rad);

    // Ground speed vector (in local tangent plane)
    double vel_mag = state_.velocity.norm();
    double track_rad = track_ * DEG_TO_RAD;
    double gs_east = groundspeed_ * std::sin(track_rad);
    double gs_north = groundspeed_ * std::cos(track_rad);

    // True airspeed = groundspeed - wind
    double tas_east = gs_east - wind_east;
    double tas_north = gs_north - wind_north;
    true_airspeed_ = std::sqrt(tas_east * tas_east + tas_north * tas_north +
                               state_.velocity.z * state_.velocity.z);

    // Compute Mach number
    double speed_of_sound = get_speed_of_sound();
    mach_ = true_airspeed_ / speed_of_sound;

    // Limit to max Mach
    if (mach_ > config_.max_mach) {
        true_airspeed_ = config_.max_mach * speed_of_sound;
    }

    // Aerodynamic coefficients
    double cl = compute_lift_coefficient();
    double cd = compute_drag_coefficient(cl);

    // Dynamic pressure
    double rho = get_air_density();
    double q = 0.5 * rho * true_airspeed_ * true_airspeed_;

    // Forces
    double lift = q * config_.wing_area * cl;
    double drag = q * config_.wing_area * cd;

    // Store for telemetry
    // (lift and drag will be used in kinematics)
}

void Aircraft::update_propulsion(double dt) {
    // Thrust is computed in compute_thrust()
    // Fuel consumption handled in update_fuel()
}

void Aircraft::update_kinematics(double dt) {
    double lat, lon, alt;
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z, lat, lon, alt);

    double mass = get_total_mass();
    double weight = mass * GRAVITY;

    // Simplified kinematic flight model with direct altitude/speed control
    // More stable than energy-based model

    double vertical_speed = 0.0;

    // Ground operations
    if (phase_ == FlightPhase::PARKED || phase_ == FlightPhase::TAXI ||
        phase_ == FlightPhase::TAKEOFF || phase_ == FlightPhase::LANDING ||
        phase_ == FlightPhase::LANDED) {

        if (phase_ == FlightPhase::TAKEOFF) {
            // Accelerate on runway
            double accel = 3.0;  // m/s² typical takeoff acceleration
            groundspeed_ += accel * dt;

            // Rotation at V1 speed (~77 m/s / 150 kts)
            if (groundspeed_ > 77.0) {
                phase_ = FlightPhase::CLIMB;
                alt = 10.0;  // Just lifted off
            }
        } else if (phase_ == FlightPhase::LANDING) {
            // Decelerate on runway
            double decel = -3.0;  // Braking
            groundspeed_ += decel * dt;
            groundspeed_ = std::max(groundspeed_, 0.0);
            alt = 0.0;
        } else if (phase_ == FlightPhase::TAXI) {
            // Taxi speed control
            double accel = (15.0 - groundspeed_) * 0.5;
            groundspeed_ += accel * dt;
            alt = 0.0;
        } else {
            // Parked or landed - no movement
            groundspeed_ = std::max(groundspeed_ - 1.0 * dt, 0.0);
            alt = 0.0;
        }

        true_airspeed_ = groundspeed_;
        track_ = heading_;

    } else {
        // Airborne flight (CLIMB, CRUISE, DESCENT, APPROACH)

        // Altitude control
        double alt_error = target_altitude_ - alt;

        if (phase_ == FlightPhase::CLIMB) {
            // Climb at constant rate until reaching target
            vertical_speed = config_.max_climb_rate * 0.8;  // 80% of max
            if (alt_error < 200.0) {
                vertical_speed = alt_error * 0.05;  // Slow as approaching target
            }
        } else if (phase_ == FlightPhase::DESCENT || phase_ == FlightPhase::APPROACH) {
            // Descend at controlled rate
            vertical_speed = -config_.max_descent_rate * 0.7;
            if (alt_error > -200.0) {
                vertical_speed = alt_error * 0.05;
            }
            // Approach: shallower descent
            if (phase_ == FlightPhase::APPROACH) {
                vertical_speed = std::max(vertical_speed, -5.0);  // ~1000 fpm max
            }
        } else {
            // Cruise: maintain altitude
            vertical_speed = std::clamp(alt_error * 0.02, -3.0, 3.0);
        }

        vertical_speed = std::clamp(vertical_speed,
                                    -config_.max_descent_rate,
                                    config_.max_climb_rate);

        // Update altitude
        alt += vertical_speed * dt;
        alt = std::clamp(alt, 0.0, config_.service_ceiling);

        // Speed control
        double speed_error = target_speed_ - true_airspeed_;
        double accel = std::clamp(speed_error * 0.1, -2.0, 2.0);
        true_airspeed_ += accel * dt;
        true_airspeed_ = std::clamp(true_airspeed_, 60.0, 280.0);  // 60-280 m/s

        // Apply wind
        WindVector wind = get_wind_at_altitude(alt);
        double wind_rad = (wind.direction + 180.0) * DEG_TO_RAD;
        double wind_east = wind.speed * std::sin(wind_rad);
        double wind_north = wind.speed * std::cos(wind_rad);

        double heading_rad = heading_ * DEG_TO_RAD;
        double tas_east = true_airspeed_ * std::sin(heading_rad);
        double tas_north = true_airspeed_ * std::cos(heading_rad);

        double gs_east = tas_east + wind_east;
        double gs_north = tas_north + wind_north;

        groundspeed_ = std::sqrt(gs_east * gs_east + gs_north * gs_north);
        track_ = std::atan2(gs_east, gs_north) * RAD_TO_DEG;
        track_ = std::fmod(track_ + 360.0, 360.0);
    }

    // Turn dynamics
    double turn_rate = 0.0;
    if (groundspeed_ > 30.0 && std::abs(bank_angle_) > 0.5) {
        turn_rate = (GRAVITY * std::tan(bank_angle_ * DEG_TO_RAD)) / groundspeed_;
        turn_rate *= RAD_TO_DEG;
        turn_rate = std::clamp(turn_rate, -3.0, 3.0);
    }

    heading_ += turn_rate * dt;
    heading_ = std::fmod(heading_ + 360.0, 360.0);

    // Update position using great circle navigation
    double dist = groundspeed_ * dt;
    double bearing = track_ * DEG_TO_RAD;

    double lat_rad = lat * DEG_TO_RAD;
    double lon_rad = lon * DEG_TO_RAD;
    double angular_dist = dist / EARTH_RADIUS;

    double new_lat_rad = std::asin(std::sin(lat_rad) * std::cos(angular_dist) +
                                   std::cos(lat_rad) * std::sin(angular_dist) * std::cos(bearing));
    double new_lon_rad = lon_rad + std::atan2(
        std::sin(bearing) * std::sin(angular_dist) * std::cos(lat_rad),
        std::cos(angular_dist) - std::sin(lat_rad) * std::sin(new_lat_rad));

    double new_lat = new_lat_rad * RAD_TO_DEG;
    double new_lon = new_lon_rad * RAD_TO_DEG;

    // Convert to ECEF
    double x, y, z;
    geodetic_to_ecef(new_lat, new_lon, alt, x, y, z);

    state_.velocity.x = (x - state_.position.x) / dt;
    state_.velocity.y = (y - state_.position.y) / dt;
    state_.velocity.z = vertical_speed;

    state_.position.x = x;
    state_.position.y = y;
    state_.position.z = z;

    // Update Mach
    mach_ = true_airspeed_ / get_speed_of_sound();
}

void Aircraft::update_fuel(double dt) {
    if (throttle_ <= 0.01 || fuel_mass_ <= 0) return;

    // Simplified fuel flow model based on throttle setting
    // At cruise (~40% throttle), burn rate should be ~2500 kg/hr for 737
    // At full throttle, burn rate ~5000 kg/hr

    double base_flow_rate = 2500.0;  // kg/hr at cruise throttle
    double throttle_factor = 0.5 + throttle_ * 1.5;  // 0.5 at idle, 2.0 at full

    double fuel_flow_per_hour = base_flow_rate * throttle_factor;
    double fuel_flow_per_sec = fuel_flow_per_hour / 3600.0;

    fuel_mass_ -= fuel_flow_per_sec * dt;
    fuel_mass_ = std::max(fuel_mass_, 0.0);
}

FlightState Aircraft::get_flight_state() const {
    FlightState fs;
    fs.time = state_.time;
    fs.phase = phase_;

    // Position
    ecef_to_geodetic(state_.position.x, state_.position.y, state_.position.z,
                     fs.latitude, fs.longitude, fs.altitude_msl);
    fs.altitude_agl = fs.altitude_msl;  // Simplified - assume flat terrain at sea level

    // Velocities
    fs.groundspeed = groundspeed_;
    fs.true_airspeed = true_airspeed_;

    // Indicated airspeed (corrected for density)
    double rho = AtmosphereModel::get_density(fs.altitude_msl);
    double rho_sl = 1.225;
    fs.indicated_airspeed = true_airspeed_ * std::sqrt(rho / rho_sl);

    fs.vertical_speed = state_.velocity.z;
    fs.mach_number = mach_;

    // Attitude
    fs.heading = heading_;
    fs.track = track_;
    fs.pitch = pitch_angle_;
    fs.bank = bank_angle_;

    // Performance
    fs.throttle = throttle_;
    fs.thrust = compute_thrust();

    double cl = compute_lift_coefficient();
    double cd = compute_drag_coefficient(cl);
    double q = 0.5 * rho * true_airspeed_ * true_airspeed_;
    fs.lift = q * config_.wing_area * cl;
    fs.drag = q * config_.wing_area * cd;

    fs.fuel_remaining = fuel_mass_;
    fs.fuel_flow = fs.thrust * config_.tsfc;  // kg/hr

    // Estimate range remaining (simplified)
    if (fs.fuel_flow > 0) {
        double hours_remaining = fuel_mass_ / fs.fuel_flow;
        fs.range_remaining = groundspeed_ * 3.6 * hours_remaining;  // km
    } else {
        fs.range_remaining = 0;
    }

    // Environment
    WindVector wind = get_wind_at_altitude(fs.altitude_msl);
    fs.wind_speed = wind.speed;
    fs.wind_direction = wind.direction;

    AtmosphereState atm = AtmosphereModel::get_atmosphere(fs.altitude_msl);
    fs.air_temperature = atm.temperature;
    fs.air_density = atm.density;

    return fs;
}

bool Aircraft::has_reached_destination() const {
    if (flight_plan_.empty()) return false;
    return phase_ == FlightPhase::LANDED ||
           (current_waypoint_ >= (int)flight_plan_.size() &&
            distance_to_waypoint(flight_plan_.back()) < 1000.0);
}

void Aircraft::geodetic_to_ecef(double lat, double lon, double alt,
                                double& x, double& y, double& z) const {
    double lat_rad = lat * DEG_TO_RAD;
    double lon_rad = lon * DEG_TO_RAD;

    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double sin_lon = std::sin(lon_rad);
    double cos_lon = std::cos(lon_rad);

    double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

    x = (N + alt) * cos_lat * cos_lon;
    y = (N + alt) * cos_lat * sin_lon;
    z = (N * (1.0 - WGS84_E2) + alt) * sin_lat;
}

void Aircraft::ecef_to_geodetic(double x, double y, double z,
                                double& lat, double& lon, double& alt) const {
    lon = std::atan2(y, x) * RAD_TO_DEG;

    double p = std::sqrt(x * x + y * y);
    double lat_rad = std::atan2(z, p * (1.0 - WGS84_E2));

    // Iterative solution (Bowring's method)
    for (int i = 0; i < 5; i++) {
        double sin_lat = std::sin(lat_rad);
        double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);
        lat_rad = std::atan2(z + WGS84_E2 * N * sin_lat, p);
    }

    lat = lat_rad * RAD_TO_DEG;

    double sin_lat = std::sin(lat_rad);
    double cos_lat = std::cos(lat_rad);
    double N = WGS84_A / std::sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat);

    if (std::abs(cos_lat) > 1e-10) {
        alt = p / cos_lat - N;
    } else {
        alt = std::abs(z) - WGS84_A * std::sqrt(1.0 - WGS84_E2);
    }
}

// Utility function to create a great circle route
std::vector<Waypoint> create_flight_route(
    const std::string& departure_name, double dep_lat, double dep_lon,
    const std::string& arrival_name, double arr_lat, double arr_lon,
    double cruise_altitude_m, double cruise_speed_ms,
    int num_intermediate_waypoints) {

    std::vector<Waypoint> route;

    // Departure
    Waypoint dep;
    dep.name = departure_name;
    dep.latitude = dep_lat;
    dep.longitude = dep_lon;
    dep.altitude = 0.0;  // Ground level
    dep.target_speed = 0.0;
    route.push_back(dep);

    // Intermediate waypoints along great circle
    double lat1 = dep_lat * DEG_TO_RAD;
    double lon1 = dep_lon * DEG_TO_RAD;
    double lat2 = arr_lat * DEG_TO_RAD;
    double lon2 = arr_lon * DEG_TO_RAD;

    for (int i = 1; i <= num_intermediate_waypoints; i++) {
        double f = (double)i / (double)(num_intermediate_waypoints + 1);

        // Great circle interpolation
        double d = std::acos(std::sin(lat1) * std::sin(lat2) +
                            std::cos(lat1) * std::cos(lat2) * std::cos(lon2 - lon1));

        double A = std::sin((1 - f) * d) / std::sin(d);
        double B = std::sin(f * d) / std::sin(d);

        double x = A * std::cos(lat1) * std::cos(lon1) + B * std::cos(lat2) * std::cos(lon2);
        double y = A * std::cos(lat1) * std::sin(lon1) + B * std::cos(lat2) * std::sin(lon2);
        double z = A * std::sin(lat1) + B * std::sin(lat2);

        double lat = std::atan2(z, std::sqrt(x * x + y * y)) * RAD_TO_DEG;
        double lon = std::atan2(y, x) * RAD_TO_DEG;

        Waypoint wp;
        wp.name = "WP" + std::to_string(i);
        wp.latitude = lat;
        wp.longitude = lon;

        // Altitude profile: climb, cruise, then descend
        if (f < 0.15) {
            // Climb phase
            wp.altitude = cruise_altitude_m * (f / 0.15);
            wp.target_speed = cruise_speed_ms * 0.8;
        } else if (f > 0.85) {
            // Descent phase
            wp.altitude = cruise_altitude_m * ((1.0 - f) / 0.15);
            wp.target_speed = cruise_speed_ms * 0.7;
        } else {
            // Cruise phase
            wp.altitude = cruise_altitude_m;
            wp.target_speed = cruise_speed_ms;
        }

        route.push_back(wp);
    }

    // Arrival
    Waypoint arr;
    arr.name = arrival_name;
    arr.latitude = arr_lat;
    arr.longitude = arr_lon;
    arr.altitude = 0.0;  // Ground level
    arr.target_speed = 70.0;  // Approach speed
    route.push_back(arr);

    return route;
}

} // namespace sim
