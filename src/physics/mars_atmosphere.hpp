/**
 * Mars Atmosphere Model
 *
 * Exponential atmosphere for Mars based on Mars-GRAM simplified data.
 * CO2-dominated atmosphere, ~1% of Earth's surface pressure.
 * Valid from surface to ~200 km altitude.
 */

#ifndef SIM_MARS_ATMOSPHERE_HPP
#define SIM_MARS_ATMOSPHERE_HPP

namespace sim {

struct MarsAtmosphereState {
    double density;         // kg/m³
    double pressure;        // Pa
    double temperature;     // K
    double speed_of_sound;  // m/s
};

class MarsAtmosphereModel {
public:
    // Surface conditions (average)
    static constexpr double SURFACE_PRESSURE    = 636.0;     // Pa
    static constexpr double SURFACE_TEMPERATURE = 210.0;     // K
    static constexpr double SURFACE_DENSITY     = 0.020;     // kg/m³

    // Atmospheric properties
    static constexpr double SCALE_HEIGHT        = 11100.0;   // m
    static constexpr double GAS_CONSTANT_CO2    = 188.92;    // J/(kg·K), CO2 R/M
    static constexpr double GAMMA_CO2           = 1.29;      // Specific heat ratio for CO2

    // Mars physical constants
    static constexpr double MARS_G0             = 3.72076;   // m/s² (surface gravity)
    static constexpr double MARS_KARMAN         = 80000.0;   // m (approximate edge of atmosphere)

    /**
     * Get full atmospheric state at altitude
     * @param altitude Height above Mars surface [m]
     * @return Atmospheric state (density, pressure, temperature, speed of sound)
     */
    static MarsAtmosphereState get_atmosphere(double altitude);

    /**
     * Get atmospheric density at altitude [kg/m³]
     * Uses two-layer exponential model for better accuracy
     */
    static double get_density(double altitude);

    /**
     * Check if altitude is within modeled atmosphere
     */
    static bool is_in_atmosphere(double altitude);
};

}  // namespace sim

#endif  // SIM_MARS_ATMOSPHERE_HPP
