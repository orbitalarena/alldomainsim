/**
 * Solar Radiation Pressure (SRP)
 *
 * Cannonball model with cylindrical Earth shadow.
 * Standard first-order SRP model used in astrodynamics.
 */

#ifndef SIM_SOLAR_RADIATION_PRESSURE_HPP
#define SIM_SOLAR_RADIATION_PRESSURE_HPP

#include "core/state_vector.hpp"
#include "celestial_body.hpp"

namespace sim {

/**
 * Spacecraft parameters for SRP calculation
 */
struct SRPParameters {
    double area;   // Cross-sectional area [m^2]
    double mass;   // Spacecraft mass [kg]
    double cr;     // Reflectivity coefficient (1.0 = absorb, 2.0 = perfect mirror, ~1.5 typical)

    double area_to_mass() const { return area / mass; }

    static SRPParameters default_satellite() {
        return SRPParameters{10.0, 500.0, 1.5};
    }

    static SRPParameters high_area() {
        return SRPParameters{100.0, 10.0, 2.0};
    }
};

class SolarRadiationPressure {
public:
    // Solar radiation pressure at 1 AU [N/m^2]
    // P = L_sun / (4 * pi * c * AU^2)
    static constexpr double P_SUN_1AU = 4.56e-6;

    /**
     * Compute SRP acceleration on spacecraft (cannonball model)
     *
     * a_srp = -P * Cr * (A/m) * (AU / |r_to_sun|)^2 * r_hat_to_sun
     *
     * Returns zero if spacecraft is in Earth's shadow.
     *
     * @param pos_eci Spacecraft position in ECI [m]
     * @param sun_pos_eci Sun position in ECI [m]
     * @param params SRP parameters (area, mass, Cr)
     * @return SRP acceleration vector [m/s^2]
     */
    static Vec3 compute_acceleration(
        const Vec3& pos_eci,
        const Vec3& sun_pos_eci,
        const SRPParameters& params);

    /**
     * Check if spacecraft is in Earth's cylindrical shadow
     *
     * @param pos_eci Spacecraft position in ECI [m]
     * @param sun_pos_eci Sun position in ECI [m]
     * @return true if in shadow (SRP = 0)
     */
    static bool is_in_shadow(
        const Vec3& pos_eci,
        const Vec3& sun_pos_eci);
};

}  // namespace sim

#endif  // SIM_SOLAR_RADIATION_PRESSURE_HPP
