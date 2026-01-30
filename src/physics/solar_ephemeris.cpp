/**
 * Solar Ephemeris Implementation
 *
 * Low-precision solar position using Meeus, "Astronomical Algorithms".
 * Computes ecliptic longitude via mean anomaly + equation of center,
 * then rotates to equatorial (ECI) coordinates via obliquity.
 */

#include "solar_ephemeris.hpp"
#include <cmath>

namespace sim {

double SolarEphemeris::get_earth_mean_anomaly(double jd) {
    // Julian centuries since J2000
    double T = (jd - J2000_EPOCH) / 36525.0;

    // Mean anomaly of Earth's orbit (degrees)
    double M_deg = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;

    // Normalize to [0, 360)
    M_deg = std::fmod(M_deg, 360.0);
    if (M_deg < 0.0) M_deg += 360.0;

    return M_deg * DEG_TO_RAD;
}

Vec3 SolarEphemeris::get_sun_position_eci(double jd) {
    // Julian centuries since J2000
    double T = (jd - J2000_EPOCH) / 36525.0;

    // Mean anomaly (radians)
    double M = get_earth_mean_anomaly(jd);

    // Mean longitude of Sun (degrees)
    double L0_deg = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;

    // Equation of center (degrees) — corrects mean anomaly to true anomaly
    double C_deg = (1.914602 - 0.004817 * T - 0.000014 * T * T) * std::sin(M)
                 + (0.019993 - 0.000101 * T) * std::sin(2.0 * M)
                 + 0.000289 * std::sin(3.0 * M);

    // Sun's true longitude in ecliptic (radians)
    double lambda_deg = L0_deg + C_deg;
    double lambda = std::fmod(lambda_deg, 360.0) * DEG_TO_RAD;

    // Earth's orbital eccentricity
    double e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;

    // True anomaly
    double v = M + C_deg * DEG_TO_RAD;

    // Distance Earth-Sun (meters)
    double R_au = 1.000001018 * (1.0 - e * e) / (1.0 + e * std::cos(v));
    double R = R_au * AU;

    // Sun position in ecliptic coordinates (latitude = 0 for Sun)
    double x_ecl = R * std::cos(lambda);
    double y_ecl = R * std::sin(lambda);

    // Rotate from ecliptic to equatorial (ECI) via obliquity
    double eps = OBLIQUITY_J2000;
    double cos_eps = std::cos(eps);
    double sin_eps = std::sin(eps);

    return Vec3{
        x_ecl,
        y_ecl * cos_eps,
        y_ecl * sin_eps
    };
}

Vec3 SolarEphemeris::get_sun_velocity_eci(double jd) {
    // Numerical derivative with 1-second step
    constexpr double h = 1.0;  // seconds
    double h_jd = h / 86400.0; // convert to Julian days

    Vec3 pos_plus = get_sun_position_eci(jd + h_jd);
    Vec3 pos_minus = get_sun_position_eci(jd - h_jd);

    return Vec3{
        (pos_plus.x - pos_minus.x) / (2.0 * h),
        (pos_plus.y - pos_minus.y) / (2.0 * h),
        (pos_plus.z - pos_minus.z) / (2.0 * h)
    };
}

StateVector SolarEphemeris::get_sun_state_eci(double jd) {
    StateVector state;
    state.position = get_sun_position_eci(jd);
    state.velocity = get_sun_velocity_eci(jd);
    state.frame = CoordinateFrame::J2000_ECI;
    state.time = (jd - J2000_EPOCH) * 86400.0;
    return state;
}

}  // namespace sim
