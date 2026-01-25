#ifndef ATMOSPHERE_MODEL_HPP
#define ATMOSPHERE_MODEL_HPP

#include "core/state_vector.hpp"

namespace sim {

/**
 * @brief Atmospheric properties at a given altitude
 */
struct AtmosphereState {
    double density;      // kg/m^3
    double pressure;     // Pa
    double temperature;  // K
    double speed_of_sound; // m/s
};

/**
 * @brief US Standard Atmosphere 1976 model (simplified)
 *
 * Provides density, pressure, temperature as function of altitude.
 * Valid from sea level to ~85 km.
 */
class AtmosphereModel {
public:
    // Sea level standard values
    static constexpr double SEA_LEVEL_DENSITY = 1.225;      // kg/m^3
    static constexpr double SEA_LEVEL_PRESSURE = 101325.0;  // Pa
    static constexpr double SEA_LEVEL_TEMPERATURE = 288.15; // K

    // Constants
    static constexpr double GAS_CONSTANT = 287.053;  // J/(kg*K) for air
    static constexpr double GAMMA = 1.4;             // Ratio of specific heats
    static constexpr double G0 = 9.80665;            // Standard gravity m/s^2

    /**
     * @brief Get atmospheric state at given altitude
     * @param altitude Geometric altitude above sea level [m]
     * @return Atmospheric properties
     */
    static AtmosphereState get_atmosphere(double altitude);

    /**
     * @brief Get air density at altitude (convenience function)
     * @param altitude Geometric altitude [m]
     * @return Air density [kg/m^3]
     */
    static double get_density(double altitude);

    /**
     * @brief Compute aerodynamic drag force
     * @param velocity Velocity vector [m/s]
     * @param altitude Altitude [m]
     * @param drag_coefficient Cd
     * @param reference_area Reference area [m^2]
     * @return Drag force vector [N] (opposite to velocity)
     */
    static Vec3 compute_drag(const Vec3& velocity, double altitude,
                             double drag_coefficient, double reference_area);

    /**
     * @brief Compute dynamic pressure
     * @param velocity Speed [m/s]
     * @param altitude Altitude [m]
     * @return Dynamic pressure q [Pa]
     */
    static double dynamic_pressure(double velocity, double altitude);

    /**
     * @brief Check if altitude is within atmospheric region
     * @param altitude Altitude [m]
     * @return true if atmosphere is significant (< 100 km)
     */
    static bool is_in_atmosphere(double altitude);

    // Karman line - edge of space
    static constexpr double KARMAN_LINE = 100000.0;  // 100 km

private:
    // Layer boundaries for US Standard Atmosphere
    static constexpr double H_TROPOPAUSE = 11000.0;   // 11 km
    static constexpr double H_STRATOPAUSE = 47000.0;  // 47 km
    static constexpr double H_MESOPAUSE = 84852.0;    // ~85 km
};

} // namespace sim

#endif // ATMOSPHERE_MODEL_HPP
