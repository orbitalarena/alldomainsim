/**
 * US Standard Atmosphere 1976
 * Provides density, pressure, temperature, and speed of sound
 * as functions of geometric altitude.
 */
const Atmosphere = (function() {
    'use strict';

    // Constants
    const R_AIR = 287.058;    // J/(kg·K) specific gas constant for dry air
    const GAMMA = 1.4;        // ratio of specific heats
    const G0 = 9.80665;       // m/s² standard gravity
    const R_EARTH = 6356766;  // m effective Earth radius for geopotential

    // Sea level reference values
    const T0 = 288.15;        // K
    const P0 = 101325.0;      // Pa
    const RHO0 = 1.225;       // kg/m³

    // Atmospheric layers (geopotential altitude, lapse rate)
    // [base altitude (m), base temperature (K), lapse rate (K/m)]
    const LAYERS = [
        [0,     288.15,  -0.0065  ],  // Troposphere
        [11000,  216.65,   0.0     ],  // Tropopause
        [20000,  216.65,   0.001   ],  // Stratosphere 1
        [32000,  228.65,   0.0028  ],  // Stratosphere 2
        [47000,  270.65,   0.0     ],  // Stratopause
        [51000,  270.65,  -0.0028  ],  // Mesosphere 1
        [71000,  214.65,  -0.002   ],  // Mesosphere 2
        [84852,  186.946,  0.0     ],  // Above this, model not valid
    ];

    // Precompute base pressures for each layer
    const BASE_PRESSURES = [P0];
    for (let i = 1; i < LAYERS.length; i++) {
        const [h0, T0_layer, lapse] = LAYERS[i - 1];
        const [h1] = LAYERS[i];
        const dh = h1 - h0;

        if (Math.abs(lapse) < 1e-10) {
            // Isothermal layer
            BASE_PRESSURES[i] = BASE_PRESSURES[i - 1] *
                Math.exp(-G0 * dh / (R_AIR * T0_layer));
        } else {
            // Gradient layer
            BASE_PRESSURES[i] = BASE_PRESSURES[i - 1] *
                Math.pow(1 + lapse * dh / T0_layer, -G0 / (R_AIR * lapse));
        }
    }

    /**
     * Convert geometric altitude to geopotential altitude
     */
    function geometricToGeopotential(h_geometric) {
        return R_EARTH * h_geometric / (R_EARTH + h_geometric);
    }

    /**
     * Find the atmospheric layer index for a given geopotential altitude
     */
    function findLayer(h) {
        for (let i = LAYERS.length - 1; i >= 0; i--) {
            if (h >= LAYERS[i][0]) return i;
        }
        return 0;
    }

    // Upper atmosphere extension constants
    const THERMO_SCALE_HEIGHT = 8500;  // m (scale height for exponential decay above 84.852km)
    // Precompute density at top of standard atmosphere (84,852m)
    // This is computed once at load time for the thermospheric extension
    let RHO_84KM, T_84KM, A_84KM;
    (function() {
        const h84 = geometricToGeopotential(84852);
        const i = findLayer(h84);
        const [h_base, T_base, lapse] = LAYERS[i];
        const P_base = BASE_PRESSURES[i];
        const dh = h84 - h_base;
        let T, P;
        if (Math.abs(lapse) < 1e-10) {
            T = T_base;
            P = P_base * Math.exp(-G0 * dh / (R_AIR * T_base));
        } else {
            T = T_base + lapse * dh;
            P = P_base * Math.pow(T / T_base, -G0 / (R_AIR * lapse));
        }
        RHO_84KM = P / (R_AIR * T);
        T_84KM = T;
        A_84KM = Math.sqrt(GAMMA * R_AIR * T);
    })();

    /**
     * Get atmospheric properties at a given geometric altitude
     * @param {number} altitude_m - Geometric altitude in meters
     * @returns {object} {temperature, pressure, density, speedOfSound, dynamicPressure(V)}
     */
    function getAtmosphere(altitude_m) {
        const alt = Math.max(0, altitude_m);

        // Above 84,852m: exponential decay into thermosphere/exosphere
        if (alt > 84852) {
            const rho = RHO_84KM * Math.exp(-(alt - 84852) / THERMO_SCALE_HEIGHT);
            // Temperature rises in thermosphere but we keep it fixed for simplicity
            const T = T_84KM;
            const a = A_84KM;
            const P = rho * R_AIR * T;
            return {
                temperature: T,
                pressure: P,
                density: rho,
                speedOfSound: a,
                dynamicPressure: function(V) {
                    return 0.5 * rho * V * V;
                }
            };
        }

        const h = geometricToGeopotential(alt);

        const i = findLayer(h);
        const [h_base, T_base, lapse] = LAYERS[i];
        const P_base = BASE_PRESSURES[i];
        const dh = h - h_base;

        let T, P;

        if (Math.abs(lapse) < 1e-10) {
            // Isothermal layer
            T = T_base;
            P = P_base * Math.exp(-G0 * dh / (R_AIR * T_base));
        } else {
            // Gradient layer
            T = T_base + lapse * dh;
            P = P_base * Math.pow(T / T_base, -G0 / (R_AIR * lapse));
        }

        const rho = P / (R_AIR * T);
        const a = Math.sqrt(GAMMA * R_AIR * T);

        return {
            temperature: T,           // K
            pressure: P,              // Pa
            density: rho,             // kg/m³
            speedOfSound: a,          // m/s
            /** Dynamic pressure at given TAS */
            dynamicPressure: function(V) {
                return 0.5 * rho * V * V;
            }
        };
    }

    /**
     * Get air density at altitude (convenience)
     */
    function getDensity(altitude_m) {
        return getAtmosphere(altitude_m).density;
    }

    /**
     * Get speed of sound at altitude (convenience)
     */
    function getSpeedOfSound(altitude_m) {
        return getAtmosphere(altitude_m).speedOfSound;
    }

    /**
     * Compute Mach number from TAS and altitude
     */
    function getMach(tas, altitude_m) {
        return tas / getSpeedOfSound(altitude_m);
    }

    /**
     * Convert TAS to calibrated airspeed (CAS / KIAS)
     * Simplified compressible flow correction
     */
    function tasToCas(tas, altitude_m) {
        const atm = getAtmosphere(altitude_m);
        // Incompressible approximation: CAS = TAS * sqrt(rho/rho0)
        return tas * Math.sqrt(atm.density / RHO0);
    }

    /**
     * Convert CAS to TAS
     */
    function casToTas(cas, altitude_m) {
        const atm = getAtmosphere(altitude_m);
        return cas / Math.sqrt(atm.density / RHO0);
    }

    // Public API
    return {
        getAtmosphere,
        getDensity,
        getSpeedOfSound,
        getMach,
        tasToCas,
        casToTas,
        SEA_LEVEL_DENSITY: RHO0,
        SEA_LEVEL_PRESSURE: P0,
        SEA_LEVEL_TEMPERATURE: T0,
        G0,
        R_EARTH: 6371000  // mean radius for position calcs
    };
})();
