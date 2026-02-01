#ifndef SIM_MC_ATMOSPHERE_HPP
#define SIM_MC_ATMOSPHERE_HPP

#include <cmath>
#include "core/state_vector.hpp"

namespace sim {
namespace mc {

// ---------------------------------------------------------------------------
// US Standard Atmosphere 1976 — header-only implementation
// ---------------------------------------------------------------------------

// Physical constants
inline constexpr double R_AIR                = 287.058;       // J/(kg·K)
inline constexpr double GAMMA_AIR            = 1.4;
inline constexpr double G0                   = 9.80665;       // m/s²
inline constexpr double R_EARTH_GEOPOTENTIAL = 6356766.0;     // m
inline constexpr double T0                   = 288.15;        // K (sea-level)
inline constexpr double P0                   = 101325.0;      // Pa
inline constexpr double RHO0                 = 1.225;         // kg/m³

// Number of standard layers
inline constexpr int NUM_LAYERS = 7;

// Top of the standard atmosphere (geopotential altitude, m)
inline constexpr double H_TOP = 84852.0;
inline constexpr double T_TOP = 186.946;  // K at 84852 m

// Layer base geopotential altitudes (m)
inline constexpr double LAYER_H[NUM_LAYERS] = {
    0.0, 11000.0, 20000.0, 32000.0, 47000.0, 51000.0, 71000.0
};

// Layer base temperatures (K)
inline constexpr double LAYER_T[NUM_LAYERS] = {
    288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65
};

// Layer temperature lapse rates (K/m)
inline constexpr double LAYER_LAPSE[NUM_LAYERS] = {
    -0.0065, 0.0, 0.001, 0.0028, 0.0, -0.0028, -0.002
};

// ---------------------------------------------------------------------------
// Result struct
// ---------------------------------------------------------------------------
struct AtmosphereResult {
    double temperature;    // K
    double pressure;       // Pa
    double density;        // kg/m³
    double speed_of_sound; // m/s
};

// ---------------------------------------------------------------------------
// Precomputed base pressures at each layer boundary.
// Computed once at static-init time via a helper struct.
// ---------------------------------------------------------------------------
struct LayerBasePressures {
    double P[NUM_LAYERS];

    LayerBasePressures() {
        P[0] = P0;
        for (int i = 1; i < NUM_LAYERS; ++i) {
            double dh = LAYER_H[i] - LAYER_H[i - 1];
            double lapse = LAYER_LAPSE[i - 1];
            double Tb = LAYER_T[i - 1];

            if (std::abs(lapse) < 1e-12) {
                // Isothermal layer
                P[i] = P[i - 1] * std::exp(-G0 * dh / (R_AIR * Tb));
            } else {
                // Gradient layer
                P[i] = P[i - 1] * std::pow(LAYER_T[i] / Tb, -G0 / (lapse * R_AIR));
            }
        }
    }
};

inline const LayerBasePressures& base_pressures() {
    static const LayerBasePressures bp;
    return bp;
}

// ---------------------------------------------------------------------------
// Convert geometric altitude (m above MSL) to geopotential altitude (m)
// ---------------------------------------------------------------------------
inline double geometric_to_geopotential(double h) {
    return R_EARTH_GEOPOTENTIAL * h / (R_EARTH_GEOPOTENTIAL + h);
}

// ---------------------------------------------------------------------------
// Main atmosphere query
// ---------------------------------------------------------------------------
inline AtmosphereResult get_atmosphere(double altitude_m) {
    // Below sea level: clamp to sea-level values
    if (altitude_m <= 0.0) {
        return AtmosphereResult{
            T0,
            P0,
            RHO0,
            std::sqrt(GAMMA_AIR * R_AIR * T0)
        };
    }

    double h_gp = geometric_to_geopotential(altitude_m);

    // Above standard atmosphere: exponential decay
    if (h_gp >= H_TOP) {
        // Pressure at top of standard atmosphere (layer 6 -> top)
        const auto& bp = base_pressures();
        double dh_top = H_TOP - LAYER_H[6];
        double lapse6 = LAYER_LAPSE[6];
        double P_top;
        if (std::abs(lapse6) < 1e-12) {
            P_top = bp.P[6] * std::exp(-G0 * dh_top / (R_AIR * LAYER_T[6]));
        } else {
            double T_at_top = LAYER_T[6] + lapse6 * dh_top;
            P_top = bp.P[6] * std::pow(T_at_top / LAYER_T[6], -G0 / (lapse6 * R_AIR));
        }
        double rho_top = P_top / (R_AIR * T_TOP);

        // Exponential decay with scale height 8500 m
        constexpr double SCALE_HEIGHT = 8500.0;
        double dh_above = h_gp - H_TOP;
        double rho = rho_top * std::exp(-dh_above / SCALE_HEIGHT);
        double pressure = rho * R_AIR * T_TOP;

        return AtmosphereResult{
            T_TOP,
            pressure,
            rho,
            std::sqrt(GAMMA_AIR * R_AIR * T_TOP)
        };
    }

    // Find the layer (linear search from top)
    int layer = 0;
    for (int i = NUM_LAYERS - 1; i >= 0; --i) {
        if (h_gp >= LAYER_H[i]) {
            layer = i;
            break;
        }
    }

    const auto& bp = base_pressures();
    double dh = h_gp - LAYER_H[layer];
    double lapse = LAYER_LAPSE[layer];
    double Tb = LAYER_T[layer];
    double Pb = bp.P[layer];

    // Temperature at altitude
    double T = Tb + lapse * dh;

    // Pressure at altitude
    double P;
    if (std::abs(lapse) < 1e-12) {
        // Isothermal layer
        P = Pb * std::exp(-G0 * dh / (R_AIR * Tb));
    } else {
        // Gradient layer
        P = Pb * std::pow(T / Tb, -G0 / (lapse * R_AIR));
    }

    // Density from ideal gas law
    double rho = P / (R_AIR * T);

    // Speed of sound
    double a = std::sqrt(GAMMA_AIR * R_AIR * T);

    return AtmosphereResult{T, P, rho, a};
}

} // namespace mc
} // namespace sim

#endif // SIM_MC_ATMOSPHERE_HPP
