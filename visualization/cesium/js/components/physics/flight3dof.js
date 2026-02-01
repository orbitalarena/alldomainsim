/**
 * Flight3DOF component — wraps FighterSimEngine.step() for aircraft/spaceplane physics.
 *
 * Config presets (fighters, bombers, transports, drones):
 *   "f16"        — F-16C Fighting Falcon
 *   "f15"        — F-15E Strike Eagle (heavy twin-engine)
 *   "f22"        — F-22A Raptor (stealth air superiority)
 *   "f35"        — F-35A Lightning II (stealth multirole)
 *   "f18"        — F/A-18E Super Hornet (carrier-capable)
 *   "a10"        — A-10C Thunderbolt II (ground attack)
 *   "mig29"      — MiG-29 Fulcrum
 *   "su27"       — Su-27S Flanker
 *   "su35"       — Su-35S Flanker-E (thrust vectoring)
 *   "su57"       — Su-57 Felon (stealth)
 *   "bomber"     — Subsonic heavy bomber (B-2/Tu-22M class)
 *   "bomber_fast"— Supersonic bomber (B-1B/Tu-160 class)
 *   "transport"  — Heavy transport (C-130 class)
 *   "awacs"      — Airborne radar platform (E-3/E-2 class)
 *   "drone_male" — MALE UAV (MQ-9/TB2 class)
 *   "drone_hale" — HALE UAV (RQ-4 class)
 *   "spaceplane" — X-37S runway-to-orbit
 *
 * The component reads entity.state._commands (set by control component)
 * and feeds them to FighterSimEngine.step() which mutates entity.state in place.
 */
(function() {
    'use strict';

    var DEG = FighterSimEngine.DEG;
    var F16 = FighterSimEngine.F16_CONFIG;

    // -------------------------------------------------------------------
    // Aircraft config presets — derived from F16_CONFIG base
    // -------------------------------------------------------------------
    var CONFIGS = {
        f16: F16,
        spaceplane: FighterSimEngine.SPACEPLANE_CONFIG,

        mig29: Object.assign({}, F16, {
            name: 'MiG-29 Fulcrum',
            mass_empty: 11000, mass_loaded: 15000, fuel_capacity: 3500,
            thrust_mil: 81000, thrust_ab: 110000,
            wing_area: 38.0, wing_span: 11.36, aspect_ratio: 3.4,
            max_g: 9.0, max_aoa: 28 * DEG
        }),

        // --- Western Fighters ---
        f15: Object.assign({}, F16, {
            name: 'F-15E Strike Eagle',
            mass_empty: 14300, mass_loaded: 24500, fuel_capacity: 6100,
            thrust_mil: 130000, thrust_ab: 210000,
            wing_area: 56.5, wing_span: 13.05, aspect_ratio: 3.01,
            cd0: 0.019, oswald: 0.82,
            max_g: 9.0, max_aoa: 30 * DEG
        }),

        f22: Object.assign({}, F16, {
            name: 'F-22A Raptor',
            mass_empty: 19700, mass_loaded: 29300, fuel_capacity: 8200,
            thrust_mil: 230000, thrust_ab: 312000,
            wing_area: 78.04, wing_span: 13.56, aspect_ratio: 2.36,
            cd0: 0.014, oswald: 0.80,
            cl_max: 1.4, cl_alpha: 0.075,
            max_g: 9.0, max_aoa: 60 * DEG
        }),

        f35: Object.assign({}, F16, {
            name: 'F-35A Lightning II',
            mass_empty: 13290, mass_loaded: 22470, fuel_capacity: 8278,
            thrust_mil: 125000, thrust_ab: 191000,
            wing_area: 42.7, wing_span: 10.7, aspect_ratio: 2.68,
            cd0: 0.015, oswald: 0.78,
            cl_max: 1.3, cl_alpha: 0.07,
            max_g: 9.0, max_aoa: 50 * DEG
        }),

        f18: Object.assign({}, F16, {
            name: 'F/A-18E Super Hornet',
            mass_empty: 14552, mass_loaded: 21320, fuel_capacity: 6530,
            thrust_mil: 124000, thrust_ab: 190000,
            wing_area: 46.45, wing_span: 13.62, aspect_ratio: 4.0,
            cd0: 0.020, oswald: 0.82,
            cl_max: 1.5, cl_alpha: 0.08,
            max_g: 7.5, max_aoa: 35 * DEG
        }),

        a10: Object.assign({}, F16, {
            name: 'A-10C Thunderbolt II',
            mass_empty: 11300, mass_loaded: 14865, fuel_capacity: 4853,
            thrust_mil: 40000, thrust_ab: 40000,  // no afterburner
            tsfc_mil: 0.020, tsfc_ab: 0.020,
            wing_area: 47.01, wing_span: 17.53, aspect_ratio: 6.54,
            cd0: 0.032, oswald: 0.85,
            cl_max: 1.8, cl_alpha: 0.09,
            max_g: 7.33, min_g: -3.0, max_aoa: 20 * DEG
        }),

        // --- Russian Fighters ---
        su27: Object.assign({}, F16, {
            name: 'Su-27 Flanker',
            mass_empty: 16380, mass_loaded: 23430, fuel_capacity: 9400,
            thrust_mil: 152000, thrust_ab: 245000,
            wing_area: 62.0, wing_span: 14.7, aspect_ratio: 3.49,
            cd0: 0.021, oswald: 0.82,
            cl_max: 1.5, cl_alpha: 0.08,
            max_g: 9.0, max_aoa: 30 * DEG
        }),

        su35: Object.assign({}, F16, {
            name: 'Su-35S Flanker-E',
            mass_empty: 18400, mass_loaded: 25300, fuel_capacity: 11500,
            thrust_mil: 172000, thrust_ab: 286000,
            wing_area: 62.0, wing_span: 15.3, aspect_ratio: 3.78,
            cd0: 0.020, oswald: 0.83,
            cl_max: 1.5, cl_alpha: 0.08,
            max_g: 9.0, max_aoa: 30 * DEG
        }),

        su57: Object.assign({}, F16, {
            name: 'Su-57 Felon',
            mass_empty: 18000, mass_loaded: 25000, fuel_capacity: 10300,
            thrust_mil: 176000, thrust_ab: 300000,
            wing_area: 78.8, wing_span: 14.1, aspect_ratio: 2.52,
            cd0: 0.015, oswald: 0.80,
            cl_max: 1.4, cl_alpha: 0.075,
            max_g: 9.0, max_aoa: 60 * DEG
        }),

        // --- Bombers ---
        bomber: Object.assign({}, F16, {
            name: 'Heavy Bomber (subsonic)',
            mass_empty: 71700, mass_loaded: 152600, fuel_capacity: 75750,
            thrust_mil: 310000, thrust_ab: 310000,  // no afterburner
            tsfc_mil: 0.018, tsfc_ab: 0.018,
            wing_area: 478.0, wing_span: 52.4, aspect_ratio: 5.74,
            cd0: 0.012, cd0_gear: 0.030, oswald: 0.90,
            cl_max: 1.2, cl_alpha: 0.06,
            max_g: 2.5, min_g: -1.0, max_aoa: 15 * DEG
        }),

        bomber_fast: Object.assign({}, F16, {
            name: 'Supersonic Bomber',
            mass_empty: 87100, mass_loaded: 148000, fuel_capacity: 88400,
            thrust_mil: 360000, thrust_ab: 600000,
            tsfc_mil: 0.020, tsfc_ab: 0.055,
            wing_area: 181.0, wing_span: 41.7, aspect_ratio: 9.6,
            cd0: 0.020, cd0_gear: 0.035, oswald: 0.82,
            cl_max: 1.3, cl_alpha: 0.07,
            max_g: 3.0, min_g: -1.0, max_aoa: 18 * DEG
        }),

        // --- Support ---
        transport: Object.assign({}, F16, {
            name: 'Tactical Transport',
            mass_empty: 34300, mass_loaded: 70300, fuel_capacity: 20500,
            thrust_mil: 64000, thrust_ab: 64000,  // 4x turboprop, no AB
            tsfc_mil: 0.015, tsfc_ab: 0.015,
            wing_area: 162.1, wing_span: 40.4, aspect_ratio: 10.08,
            cd0: 0.025, cd0_gear: 0.040, oswald: 0.85,
            cl_max: 2.0, cl_max_flaps: 2.8, cl_alpha: 0.09,
            max_g: 2.5, min_g: -1.0, max_aoa: 15 * DEG
        }),

        awacs: Object.assign({}, F16, {
            name: 'Airborne Early Warning',
            mass_empty: 77000, mass_loaded: 147000, fuel_capacity: 65000,
            thrust_mil: 372000, thrust_ab: 372000,  // 4x turbofan, no AB
            tsfc_mil: 0.017, tsfc_ab: 0.017,
            wing_area: 283.0, wing_span: 44.4, aspect_ratio: 6.97,
            cd0: 0.030, cd0_gear: 0.045, oswald: 0.82,
            cl_max: 1.4, cl_alpha: 0.07,
            max_g: 2.5, min_g: -1.0, max_aoa: 14 * DEG
        }),

        // --- Drones ---
        drone_male: Object.assign({}, F16, {
            name: 'MALE UAV',
            mass_empty: 2200, mass_loaded: 4760, fuel_capacity: 1800,
            thrust_mil: 6700, thrust_ab: 6700,  // turboprop, no AB
            tsfc_mil: 0.012, tsfc_ab: 0.012,
            wing_area: 38.5, wing_span: 20.0, aspect_ratio: 10.4,
            cd0: 0.020, cd0_gear: 0.035, oswald: 0.88,
            cl_max: 1.6, cl_alpha: 0.09,
            max_g: 3.0, min_g: -1.5, max_aoa: 15 * DEG
        }),

        drone_hale: Object.assign({}, F16, {
            name: 'HALE UAV',
            mass_empty: 6800, mass_loaded: 14628, fuel_capacity: 7800,
            thrust_mil: 35000, thrust_ab: 35000,  // turbofan, no AB
            tsfc_mil: 0.016, tsfc_ab: 0.016,
            wing_area: 50.0, wing_span: 39.9, aspect_ratio: 31.84,
            cd0: 0.015, cd0_gear: 0.030, oswald: 0.92,
            cl_max: 1.5, cl_alpha: 0.10,
            max_g: 2.0, min_g: -0.5, max_aoa: 12 * DEG
        })
    };

    class Flight3DOF extends ECS.Component {
        constructor(config) {
            super(config);
            this._engineConfig = null;  // resolved in init()
        }

        init(world) {
            // Resolve engine config from preset name or config table
            var presetName = this.config.config;
            this._engineConfig = CONFIGS[presetName] || CONFIGS.f16;

            // Ensure weapon mass is set for getMass()
            if (this.entity.state.weaponMass === undefined) {
                this.entity.state.weaponMass = 0;
            }
        }

        /**
         * Step physics. dt is already sub-stepped by PhysicsSystem.
         */
        update(dt, world) {
            var state = this.entity.state;
            var commands = state._commands || {};
            FighterSimEngine.step(state, commands, dt, this._engineConfig);
        }
    }

    // Register with framework
    ComponentRegistry.register('physics', 'flight3dof', Flight3DOF);

    // Register all config presets
    var configNames = Object.keys(CONFIGS);
    for (var i = 0; i < configNames.length; i++) {
        ComponentRegistry.registerConfig(configNames[i], CONFIGS[configNames[i]]);
    }
})();
