#include "physics/atmosphere_model.hpp"
#include <cmath>
#include <algorithm>

namespace sim {

AtmosphereState AtmosphereModel::get_atmosphere(double altitude) {
    AtmosphereState state;

    // Clamp altitude to valid range
    altitude = std::max(0.0, altitude);

    if (altitude > H_MESOPAUSE) {
        // Above mesopause - exponential decay
        double h = altitude - H_MESOPAUSE;
        double scale_height = 6500.0;  // Approximate scale height at high altitude

        state.temperature = 186.87;  // Approximate mesopause temperature
        state.pressure = 0.37 * std::exp(-h / scale_height);
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }
    else if (altitude > H_STRATOPAUSE) {
        // Mesosphere (47-85 km) - temperature decreases
        double h = altitude - H_STRATOPAUSE;
        double lapse_rate = -0.0028;  // K/m

        state.temperature = 270.65 + lapse_rate * h;
        state.temperature = std::max(state.temperature, 186.87);

        // Pressure from barometric formula
        double T0 = 270.65;
        double P0 = 110.91;
        if (std::abs(lapse_rate) > 1e-10) {
            state.pressure = P0 * std::pow(state.temperature / T0,
                                           -G0 / (lapse_rate * GAS_CONSTANT));
        } else {
            state.pressure = P0 * std::exp(-G0 * h / (GAS_CONSTANT * T0));
        }
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }
    else if (altitude > 32000.0) {
        // Upper stratosphere (32-47 km)
        double h = altitude - 32000.0;
        double lapse_rate = 0.0028;  // K/m (warming)

        state.temperature = 228.65 + lapse_rate * h;

        double T0 = 228.65;
        double P0 = 868.02;
        state.pressure = P0 * std::pow(state.temperature / T0,
                                       -G0 / (lapse_rate * GAS_CONSTANT));
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }
    else if (altitude > 20000.0) {
        // Middle stratosphere (20-32 km)
        double h = altitude - 20000.0;
        double lapse_rate = 0.001;  // K/m

        state.temperature = 216.65 + lapse_rate * h;

        double T0 = 216.65;
        double P0 = 5474.89;
        state.pressure = P0 * std::pow(state.temperature / T0,
                                       -G0 / (lapse_rate * GAS_CONSTANT));
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }
    else if (altitude > H_TROPOPAUSE) {
        // Lower stratosphere (11-20 km) - isothermal
        double h = altitude - H_TROPOPAUSE;

        state.temperature = 216.65;  // Constant temperature

        double P0 = 22632.1;
        state.pressure = P0 * std::exp(-G0 * h / (GAS_CONSTANT * state.temperature));
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }
    else {
        // Troposphere (0-11 km)
        double lapse_rate = -0.0065;  // K/m

        state.temperature = SEA_LEVEL_TEMPERATURE + lapse_rate * altitude;

        state.pressure = SEA_LEVEL_PRESSURE *
                        std::pow(state.temperature / SEA_LEVEL_TEMPERATURE,
                                 -G0 / (lapse_rate * GAS_CONSTANT));
        state.density = state.pressure / (GAS_CONSTANT * state.temperature);
    }

    // Speed of sound
    state.speed_of_sound = std::sqrt(GAMMA * GAS_CONSTANT * state.temperature);

    return state;
}

double AtmosphereModel::get_density(double altitude) {
    // Fast exponential approximation for high altitudes
    if (altitude > KARMAN_LINE) {
        return 0.0;
    }

    if (altitude > 50000.0) {
        // Simple exponential model for very high altitudes
        double scale_height = 7400.0;
        return SEA_LEVEL_DENSITY * std::exp(-altitude / scale_height);
    }

    return get_atmosphere(altitude).density;
}

Vec3 AtmosphereModel::compute_drag(const Vec3& velocity, double altitude,
                                   double Cd, double area) {
    double rho = get_density(altitude);

    if (rho < 1e-15) {
        return Vec3(0, 0, 0);  // No atmosphere
    }

    double v_mag = velocity.norm();
    if (v_mag < 1e-6) {
        return Vec3(0, 0, 0);  // No velocity
    }

    // Drag magnitude: D = 0.5 * rho * v^2 * Cd * A
    double drag_mag = 0.5 * rho * v_mag * v_mag * Cd * area;

    // Drag direction: opposite to velocity
    Vec3 drag;
    drag.x = -drag_mag * velocity.x / v_mag;
    drag.y = -drag_mag * velocity.y / v_mag;
    drag.z = -drag_mag * velocity.z / v_mag;

    return drag;
}

double AtmosphereModel::dynamic_pressure(double velocity, double altitude) {
    double rho = get_density(altitude);
    return 0.5 * rho * velocity * velocity;
}

bool AtmosphereModel::is_in_atmosphere(double altitude) {
    return altitude < KARMAN_LINE;
}

} // namespace sim
