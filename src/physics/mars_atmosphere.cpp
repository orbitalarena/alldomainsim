/**
 * Mars Atmosphere Model Implementation
 *
 * Two-layer exponential model based on Mars-GRAM simplified data:
 *   - Lower atmosphere (0-80 km): single exponential with scale height 11.1 km
 *   - Upper atmosphere (80-200 km): secondary exponential with larger scale height
 *   - Above 200 km: negligible (returns 0)
 *
 * Temperature profile: linear lapse in lower atmosphere, isothermal above.
 * CO2-dominated (95.3%) with mean molecular weight ~43.34 g/mol.
 */

#include "mars_atmosphere.hpp"
#include <cmath>

namespace sim {

MarsAtmosphereState MarsAtmosphereModel::get_atmosphere(double altitude) {
    MarsAtmosphereState state;

    if (altitude < 0.0) altitude = 0.0;

    if (altitude > 200000.0) {
        // Above modeled range
        state.density = 0.0;
        state.pressure = 0.0;
        state.temperature = 130.0;  // Approximate exospheric temperature
        state.speed_of_sound = 0.0;
        return state;
    }

    if (altitude <= 7000.0) {
        // Lower troposphere: temperature decreases with lapse rate
        // T = T0 - λ*h, λ ≈ 2.5 K/km
        double T = SURFACE_TEMPERATURE - 0.0025 * altitude;
        double P = SURFACE_PRESSURE * std::pow(T / SURFACE_TEMPERATURE,
                                                MARS_G0 / (GAS_CONSTANT_CO2 * 0.0025));
        double rho = P / (GAS_CONSTANT_CO2 * T);

        state.temperature = T;
        state.pressure = P;
        state.density = rho;
        state.speed_of_sound = std::sqrt(GAMMA_CO2 * GAS_CONSTANT_CO2 * T);
    }
    else if (altitude <= 80000.0) {
        // Mid atmosphere: exponential decay
        // Reference: 7 km altitude
        double T_ref = SURFACE_TEMPERATURE - 0.0025 * 7000.0;  // ~192.5 K
        double P_ref = SURFACE_PRESSURE * std::pow(T_ref / SURFACE_TEMPERATURE,
                                                    MARS_G0 / (GAS_CONSTANT_CO2 * 0.0025));
        double rho_ref = P_ref / (GAS_CONSTANT_CO2 * T_ref);

        // Temperature settles to ~150 K in mesosphere
        double T = 150.0 + (T_ref - 150.0) * std::exp(-(altitude - 7000.0) / 45000.0);
        double rho = rho_ref * std::exp(-(altitude - 7000.0) / SCALE_HEIGHT);
        double P = rho * GAS_CONSTANT_CO2 * T;

        state.temperature = T;
        state.pressure = P;
        state.density = rho;
        state.speed_of_sound = std::sqrt(GAMMA_CO2 * GAS_CONSTANT_CO2 * T);
    }
    else {
        // Upper atmosphere (80-200 km): extended exponential
        // Reference from 80 km boundary
        double rho_80 = SURFACE_DENSITY * std::exp(-80000.0 / SCALE_HEIGHT);
        double T = 130.0;  // Near-isothermal thermosphere
        double scale_upper = 20000.0;  // Larger scale height in upper atmosphere

        double rho = rho_80 * std::exp(-(altitude - 80000.0) / scale_upper);
        double P = rho * GAS_CONSTANT_CO2 * T;

        state.temperature = T;
        state.pressure = P;
        state.density = rho;
        state.speed_of_sound = std::sqrt(GAMMA_CO2 * GAS_CONSTANT_CO2 * T);
    }

    return state;
}

double MarsAtmosphereModel::get_density(double altitude) {
    if (altitude < 0.0) altitude = 0.0;
    if (altitude > 200000.0) return 0.0;

    if (altitude <= 80000.0) {
        return SURFACE_DENSITY * std::exp(-altitude / SCALE_HEIGHT);
    } else {
        // Extended upper atmosphere
        double rho_80 = SURFACE_DENSITY * std::exp(-80000.0 / SCALE_HEIGHT);
        return rho_80 * std::exp(-(altitude - 80000.0) / 20000.0);
    }
}

bool MarsAtmosphereModel::is_in_atmosphere(double altitude) {
    return altitude >= 0.0 && altitude < MARS_KARMAN;
}

}  // namespace sim
