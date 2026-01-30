/**
 * Flight3DOF component — wraps FighterSimEngine.step() for aircraft/spaceplane physics.
 *
 * Config presets:
 *   "f16"        — F-16 Fighting Falcon (FighterSimEngine.F16_CONFIG)
 *   "spaceplane" — X-37S Spaceplane (FighterSimEngine.SPACEPLANE_CONFIG)
 *
 * The component reads entity.state._commands (set by control component)
 * and feeds them to FighterSimEngine.step() which mutates entity.state in place.
 */
(function() {
    'use strict';

    class Flight3DOF extends ECS.Component {
        constructor(config) {
            super(config);
            this._engineConfig = null;  // resolved in init()
        }

        init(world) {
            // Resolve engine config from preset name or use raw object
            const presetName = this.config.config;
            if (presetName === 'f16') {
                this._engineConfig = FighterSimEngine.F16_CONFIG;
            } else if (presetName === 'spaceplane') {
                this._engineConfig = FighterSimEngine.SPACEPLANE_CONFIG;
            } else if (presetName === 'mig29') {
                // MiG-29: similar to F-16 with tweaked params
                this._engineConfig = Object.assign({}, FighterSimEngine.F16_CONFIG, {
                    name: 'MiG-29 Fulcrum',
                    mass_loaded: 15000,
                    thrust_ab: 110000,
                    max_g: 9.0,
                    max_aoa: 28 * FighterSimEngine.DEG
                });
            } else {
                // Default to F-16
                this._engineConfig = FighterSimEngine.F16_CONFIG;
            }

            // Ensure weapon mass is set for getMass()
            if (this.entity.state.weaponMass === undefined) {
                this.entity.state.weaponMass = 0;
            }
        }

        /**
         * Step physics. dt is already sub-stepped by PhysicsSystem.
         */
        update(dt, world) {
            const state = this.entity.state;
            const commands = state._commands || {};
            FighterSimEngine.step(state, commands, dt, this._engineConfig);
        }
    }

    // Register with framework
    ComponentRegistry.register('physics', 'flight3dof', Flight3DOF);

    // Register config presets
    ComponentRegistry.registerConfig('f16', FighterSimEngine.F16_CONFIG);
    ComponentRegistry.registerConfig('spaceplane', FighterSimEngine.SPACEPLANE_CONFIG);
})();
