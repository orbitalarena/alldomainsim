#include "entities/satellite.hpp"
#include <cmath>
#include <iostream>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double EARTH_MU = 398600.4418e9;  // Earth gravitational parameter [m^3/s^2]
constexpr double EARTH_RADIUS = 6378137.0;   // Earth radius [m]

Satellite::Satellite(const std::string& name, int id, const TLE& tle)
    : Entity(name, id), tle_(tle) {
    
    // Set physics domain to orbital
    domain_ = PhysicsDomain::ORBITAL;
    
    // Initialize state from TLE
    initialize_from_tle();
}

void Satellite::initialize_from_tle() {
    // Convert TLE mean motion (rev/day) to semi-major axis
    double n_rad_per_sec = tle_.mean_motion * TWO_PI / 86400.0;  // Convert to rad/s
    double a = std::pow(EARTH_MU / (n_rad_per_sec * n_rad_per_sec), 1.0/3.0);  // Semi-major axis [m]
    
    // Convert Keplerian elements to Cartesian (simplified for circular orbits initially)
    double i = tle_.inclination * DEG_TO_RAD;
    double raan = tle_.raan * DEG_TO_RAD;
    double w = tle_.arg_perigee * DEG_TO_RAD;
    double M = tle_.mean_anomaly * DEG_TO_RAD;
    double e = tle_.eccentricity;
    
    // Solve Kepler's equation for eccentric anomaly (Newton-Raphson)
    double E = M;  // Initial guess
    for (int iter = 0; iter < 10; iter++) {
        double E_new = E - (E - e * std::sin(E) - M) / (1.0 - e * std::cos(E));
        if (std::abs(E_new - E) < 1e-10) break;
        E = E_new;
    }
    
    // True anomaly
    double nu = 2.0 * std::atan2(std::sqrt(1.0 + e) * std::sin(E/2.0), 
                                  std::sqrt(1.0 - e) * std::cos(E/2.0));
    
    // Distance from center
    double r = a * (1.0 - e * std::cos(E));
    
    // Position in orbital plane
    double x_orb = r * std::cos(nu);
    double y_orb = r * std::sin(nu);
    
    // Velocity in orbital plane
    double v = std::sqrt(EARTH_MU / a);  // Circular orbit approximation
    double vx_orb = -v * std::sin(nu);
    double vy_orb = v * std::cos(nu);
    
    // Rotation matrices to ECI
    double cos_i = std::cos(i);
    double sin_i = std::sin(i);
    double cos_raan = std::cos(raan);
    double sin_raan = std::sin(raan);
    double cos_w = std::cos(w);
    double sin_w = std::sin(w);
    
    // Position in ECI
    state_.position.x = (cos_raan * cos_w - sin_raan * sin_w * cos_i) * x_orb +
                        (-cos_raan * sin_w - sin_raan * cos_w * cos_i) * y_orb;
    state_.position.y = (sin_raan * cos_w + cos_raan * sin_w * cos_i) * x_orb +
                        (-sin_raan * sin_w + cos_raan * cos_w * cos_i) * y_orb;
    state_.position.z = (sin_w * sin_i) * x_orb + (cos_w * sin_i) * y_orb;
    
    // Velocity in ECI
    state_.velocity.x = (cos_raan * cos_w - sin_raan * sin_w * cos_i) * vx_orb +
                        (-cos_raan * sin_w - sin_raan * cos_w * cos_i) * vy_orb;
    state_.velocity.y = (sin_raan * cos_w + cos_raan * sin_w * cos_i) * vx_orb +
                        (-sin_raan * sin_w + cos_raan * cos_w * cos_i) * vy_orb;
    state_.velocity.z = (sin_w * sin_i) * vx_orb + (cos_w * sin_i) * vy_orb;
    
    state_.frame = CoordinateFrame::J2000_ECI;
    state_.time = 0.0;  // Will be set by simulation engine
    
    std::cout << "Initialized " << name_ << " at altitude: " 
              << (state_.position.norm() - EARTH_RADIUS) / 1000.0 << " km" << std::endl;
}

void Satellite::update(double dt) {
    // Simple Keplerian propagation
    propagate_keplerian(dt);
}

void Satellite::propagate_keplerian(double dt) {
    // Two-body propagation (very simplified - just circular motion for now)
    // For a proper implementation, use full Keplerian elements and numerical integration
    
    double r = state_.position.norm();
    double v = state_.velocity.norm();
    
    // Gravitational acceleration
    Vec3 acc;
    acc.x = -EARTH_MU * state_.position.x / (r * r * r);
    acc.y = -EARTH_MU * state_.position.y / (r * r * r);
    acc.z = -EARTH_MU * state_.position.z / (r * r * r);
    
    // Simple Euler integration (TODO: Replace with RK4)
    state_.velocity.x += acc.x * dt;
    state_.velocity.y += acc.y * dt;
    state_.velocity.z += acc.z * dt;
    
    state_.position.x += state_.velocity.x * dt;
    state_.position.y += state_.velocity.y * dt;
    state_.position.z += state_.velocity.z * dt;
    
    state_.time += dt;
}

} // namespace sim
