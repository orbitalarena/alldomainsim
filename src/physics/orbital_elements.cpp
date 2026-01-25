#include "physics/orbital_elements.hpp"
#include <cmath>
#include <stdexcept>

namespace sim {

// Constants
constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;

// OrbitalElements methods
double OrbitalElements::periapsis() const {
    return semi_major_axis * (1.0 - eccentricity);
}

double OrbitalElements::apoapsis() const {
    return semi_major_axis * (1.0 + eccentricity);
}

double OrbitalElements::period() const {
    return TWO_PI * std::sqrt(std::pow(semi_major_axis, 3) / OrbitalMechanics::MU_EARTH);
}

double OrbitalElements::mean_motion() const {
    return std::sqrt(OrbitalMechanics::MU_EARTH / std::pow(semi_major_axis, 3));
}

// OrbitalMechanics methods
StateVector OrbitalMechanics::elements_to_state(const OrbitalElements& elem, double mu) {
    StateVector state;
    state.frame = CoordinateFrame::J2000_ECI;
    state.time = 0.0;

    double a = elem.semi_major_axis;
    double e = elem.eccentricity;
    double i = elem.inclination;
    double raan = elem.raan;
    double w = elem.arg_periapsis;
    double nu = elem.true_anomaly;

    // Semi-latus rectum
    double p = a * (1.0 - e * e);

    // Distance
    double r = p / (1.0 + e * std::cos(nu));

    // Position in orbital plane (perifocal frame)
    double x_pf = r * std::cos(nu);
    double y_pf = r * std::sin(nu);

    // Velocity in orbital plane
    double h = std::sqrt(mu * p);  // Specific angular momentum
    double vx_pf = -mu / h * std::sin(nu);
    double vy_pf = mu / h * (e + std::cos(nu));

    // Rotation matrix components
    double cos_raan = std::cos(raan);
    double sin_raan = std::sin(raan);
    double cos_i = std::cos(i);
    double sin_i = std::sin(i);
    double cos_w = std::cos(w);
    double sin_w = std::sin(w);

    // Transform to ECI
    // R = R3(-raan) * R1(-i) * R3(-w)
    double r11 = cos_raan * cos_w - sin_raan * sin_w * cos_i;
    double r12 = -cos_raan * sin_w - sin_raan * cos_w * cos_i;
    double r21 = sin_raan * cos_w + cos_raan * sin_w * cos_i;
    double r22 = -sin_raan * sin_w + cos_raan * cos_w * cos_i;
    double r31 = sin_w * sin_i;
    double r32 = cos_w * sin_i;

    state.position.x = r11 * x_pf + r12 * y_pf;
    state.position.y = r21 * x_pf + r22 * y_pf;
    state.position.z = r31 * x_pf + r32 * y_pf;

    state.velocity.x = r11 * vx_pf + r12 * vy_pf;
    state.velocity.y = r21 * vx_pf + r22 * vy_pf;
    state.velocity.z = r31 * vx_pf + r32 * vy_pf;

    return state;
}

OrbitalElements OrbitalMechanics::state_to_elements(const StateVector& state, double mu) {
    OrbitalElements elem;

    Vec3 r = state.position;
    Vec3 v = state.velocity;

    double r_mag = r.norm();
    double v_mag = v.norm();

    // Specific angular momentum h = r x v
    Vec3 h;
    h.x = r.y * v.z - r.z * v.y;
    h.y = r.z * v.x - r.x * v.z;
    h.z = r.x * v.y - r.y * v.x;
    double h_mag = h.norm();

    // Node vector n = k x h (k is z-axis unit vector)
    Vec3 n;
    n.x = -h.y;
    n.y = h.x;
    n.z = 0.0;
    double n_mag = n.norm();

    // Eccentricity vector
    double rv_dot = r.x * v.x + r.y * v.y + r.z * v.z;
    Vec3 e_vec;
    e_vec.x = (v_mag * v_mag - mu / r_mag) * r.x / mu - rv_dot * v.x / mu;
    e_vec.y = (v_mag * v_mag - mu / r_mag) * r.y / mu - rv_dot * v.y / mu;
    e_vec.z = (v_mag * v_mag - mu / r_mag) * r.z / mu - rv_dot * v.z / mu;
    double e = e_vec.norm();

    // Specific orbital energy
    double energy = v_mag * v_mag / 2.0 - mu / r_mag;

    // Semi-major axis
    double a;
    if (std::abs(e - 1.0) > 1e-10) {
        a = -mu / (2.0 * energy);
    } else {
        // Parabolic orbit
        a = std::numeric_limits<double>::infinity();
    }

    // Inclination
    double inc = std::acos(h.z / h_mag);

    // Right ascension of ascending node
    double raan;
    if (n_mag > 1e-10) {
        raan = std::acos(n.x / n_mag);
        if (n.y < 0) {
            raan = TWO_PI - raan;
        }
    } else {
        raan = 0.0;  // Equatorial orbit
    }

    // Argument of periapsis
    double arg_pe;
    if (n_mag > 1e-10 && e > 1e-10) {
        double n_dot_e = n.x * e_vec.x + n.y * e_vec.y + n.z * e_vec.z;
        arg_pe = std::acos(n_dot_e / (n_mag * e));
        if (e_vec.z < 0) {
            arg_pe = TWO_PI - arg_pe;
        }
    } else if (e > 1e-10) {
        // Equatorial orbit
        arg_pe = std::atan2(e_vec.y, e_vec.x);
        if (arg_pe < 0) arg_pe += TWO_PI;
    } else {
        arg_pe = 0.0;  // Circular orbit
    }

    // True anomaly
    double nu;
    if (e > 1e-10) {
        double e_dot_r = e_vec.x * r.x + e_vec.y * r.y + e_vec.z * r.z;
        nu = std::acos(e_dot_r / (e * r_mag));
        if (rv_dot < 0) {
            nu = TWO_PI - nu;
        }
    } else if (n_mag > 1e-10) {
        // Circular inclined orbit
        double n_dot_r = n.x * r.x + n.y * r.y + n.z * r.z;
        nu = std::acos(n_dot_r / (n_mag * r_mag));
        if (r.z < 0) {
            nu = TWO_PI - nu;
        }
    } else {
        // Circular equatorial orbit
        nu = std::atan2(r.y, r.x);
        if (nu < 0) nu += TWO_PI;
    }

    elem.semi_major_axis = a;
    elem.eccentricity = e;
    elem.inclination = inc;
    elem.raan = raan;
    elem.arg_periapsis = arg_pe;
    elem.true_anomaly = nu;
    elem.mean_anomaly = true_to_mean_anomaly(nu, e);

    return elem;
}

double OrbitalMechanics::circular_velocity(double radius, double mu) {
    return std::sqrt(mu / radius);
}

double OrbitalMechanics::escape_velocity(double radius, double mu) {
    return std::sqrt(2.0 * mu / radius);
}

double OrbitalMechanics::solve_kepler(double M, double e, double tolerance) {
    // Newton-Raphson iteration for Kepler's equation: M = E - e*sin(E)
    double E = M;  // Initial guess

    for (int iter = 0; iter < 50; iter++) {
        double f = E - e * std::sin(E) - M;
        double fp = 1.0 - e * std::cos(E);
        double delta = f / fp;
        E -= delta;

        if (std::abs(delta) < tolerance) {
            break;
        }
    }

    return E;
}

double OrbitalMechanics::true_to_eccentric_anomaly(double nu, double e) {
    return 2.0 * std::atan2(std::sqrt(1.0 - e) * std::sin(nu / 2.0),
                           std::sqrt(1.0 + e) * std::cos(nu / 2.0));
}

double OrbitalMechanics::eccentric_to_true_anomaly(double E, double e) {
    return 2.0 * std::atan2(std::sqrt(1.0 + e) * std::sin(E / 2.0),
                           std::sqrt(1.0 - e) * std::cos(E / 2.0));
}

double OrbitalMechanics::true_to_mean_anomaly(double nu, double e) {
    double E = true_to_eccentric_anomaly(nu, e);
    double M = E - e * std::sin(E);

    // Normalize to [0, 2*PI)
    while (M < 0) M += TWO_PI;
    while (M >= TWO_PI) M -= TWO_PI;

    return M;
}

double OrbitalMechanics::mean_to_true_anomaly(double M, double e) {
    double E = solve_kepler(M, e);
    return eccentric_to_true_anomaly(E, e);
}

double OrbitalMechanics::propagate_mean_anomaly(double M0, double n, double dt) {
    double M = M0 + n * dt;

    // Normalize to [0, 2*PI)
    while (M < 0) M += TWO_PI;
    while (M >= TWO_PI) M -= TWO_PI;

    return M;
}

} // namespace sim
