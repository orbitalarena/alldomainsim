/**
 * Naval physics component — wraps NavalPhysics module for ECS integration.
 *
 * Config:
 *   config: 'cvn_nimitz' | 'ddg_arleigh_burke' | etc. (ship config name)
 *   submarine: false      — true for submarine physics (depth control)
 *
 * Registers as: physics/naval
 */
(function() {
    'use strict';
    var NavalModule = window.NavalPhysics;

    class NavalComponent extends ECS.Component {
        constructor(config) {
            super(config);
            this._navalState = null;
        }

        init(world) {
            if (!NavalModule) {
                NavalModule = window.NavalPhysics;
                if (!NavalModule) return;
            }
            var entity = this.entity;
            var cfg = this.config;
            var shipConfig = cfg.config || 'ddg_arleigh_burke';
            var isSub = cfg.submarine === true;
            this._navalState = NavalModule.init(shipConfig, isSub);
            if (!this._navalState) return;
            this._navalState.heading = entity.state.heading || 0;
            this._navalState.speed = entity.state.speed || 0;
            this._navalState.lat = entity.state.lat;
            this._navalState.lon = entity.state.lon;
        }

        update(dt, world) {
            if (!this._navalState) return;
            var entity = this.entity;
            var s = this._navalState;

            // Sync target controls from entity state (set by AI or waypoint system)
            s.targetHeading = entity.state.targetHeading != null ? entity.state.targetHeading : s.heading;
            s.targetSpeed = entity.state.targetSpeed != null ? entity.state.targetSpeed : s.speed;

            // Submarine depth control
            if (this.config.submarine) {
                s.targetDepth = entity.state.targetDepth != null ? entity.state.targetDepth : (s.depth || 0);
                NavalModule.stepSubmarine(s, dt);
            } else {
                NavalModule.step(s, dt);
            }

            // Write back to entity state
            entity.state.lat = s.lat;
            entity.state.lon = s.lon;
            entity.state.heading = s.heading;
            entity.state.speed = s.speed;
            entity.state.alt = this.config.submarine ? -(s.depth || 0) : 0;
        }

        cleanup(world) {
            this._navalState = null;
        }
    }

    ComponentRegistry.register('physics', 'naval', NavalComponent);
})();
