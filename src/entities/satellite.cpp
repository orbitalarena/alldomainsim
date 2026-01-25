#include "entities/satellite.hpp"
#include "propagators/rk4_integrator.hpp"
#include "physics/gravity_model.hpp"
#include "coordinate/time_utils.hpp"
#include <cmath>
#include <iostream>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;
constexpr double DEG_TO_RAD = PI / 180.0;

Satellite::Satellite(const std::string& name, int id, const TLE& tle, bool use_j2)
    : Entity(name, id), tle_(tle), use_j2_(use_j2) {
    
    // Set physics domain to orbital
    domain_ = PhysicsDomain::ORBITAL;
    
    // Initialize state from TLE
    initialize_from_tle();
}

void Satellite::initialize_from_tle() {
    // Convert TLE mean motion (rev/day) to semi-major axis
    double n_rad_per_sec = tle_.mean_motion * TWO_PI / 86400.0;  // Convert to rad/s
    double a = std::pow(GravityModel::EARTH_MU / (n_rad_per_sec * n_rad_per_sec), 1.0/3.0);
    
    // Convert Keplerian elements to Cartesian
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
    double h = std::sqrt(GravityModel::EARTH_MU * a * (1.0 - e * e));  // Specific angular momentum
    double vx_orb = -GravityModel::EARTH_MU / h * std::sin(nu);
    double vy_orb = GravityModel::EARTH_MU / h * (e + std::cos(nu));
    
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
    state_.time = 0.0;
    
    double alt_km = (state_.position.norm() - GravityModel::EARTH_RADIUS) / 1000.0;
    std::cout << "Initialized " << name_ << " at altitude: " << alt_km << " km";
    if (use_j2_) std::cout << " (J2 enabled)";
    std::cout << std::endl;
}

void Satellite::update(double dt) {
    propagate_rk4(dt);
}

void Satellite::propagate_rk4(double dt) {
    // Use RK4 integrator with gravity model
    auto derivatives_func = [this](const StateVector& s) {
        return GravityModel::compute_derivatives(s, use_j2_);
    };

    state_ = RK4Integrator::step(state_, dt, derivatives_func);
}

double Satellite::get_epoch_jd() const {
    return TimeUtils::tle_epoch_to_jd(tle_.epoch_year, tle_.epoch_day);
}

} // namespace sim
