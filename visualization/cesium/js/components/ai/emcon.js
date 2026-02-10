/**
 * EMCON (Emissions Control) component — manages electromagnetic emissions for stealth.
 *
 * EMCON levels:
 *   0 = TIGHT  — all radars off, no radio transmit, passive sensors only
 *   1 = LOW    — limited radar (reduced power/range), encrypted comms only
 *   2 = NORMAL — standard radar operation, normal comms
 *   3 = FREE   — all sensors max power, active jamming allowed
 *
 * Effects:
 *   - Modifies sensor effective range via entity.state._emconRadarMul
 *   - Modifies comm link budget via entity.state._emconCommMul
 *   - Reduces own RCS signature when radar is off (not emitting)
 *   - Affects detection probability of this entity by enemy sensors
 *
 * Config:
 *   initialLevel:   0-3 (default 2 = NORMAL)
 *   autoEMCON:      false (auto-adjust based on threat proximity)
 *   threatRange:    150000 (range in m to trigger EMCON TIGHT)
 *
 * Registers as: ai/emcon
 */
(function() {
    'use strict';

    var EMCON_LEVELS = ['TIGHT', 'LOW', 'NORMAL', 'FREE'];
    var RADAR_MULTIPLIERS = [0, 0.3, 1.0, 1.2];
    var COMM_MULTIPLIERS = [0, 0.5, 1.0, 1.0];
    var EMISSION_SIGNATURES = [0.1, 0.4, 1.0, 1.5]; // multiplier on own detectability

    class EmconComponent extends ECS.Component {
        constructor(config) {
            super(config);
            this._level = config.initialLevel != null ? config.initialLevel : 2;
            this._autoEMCON = config.autoEMCON === true;
            this._threatRange = config.threatRange || 150000;
            this._lastAutoCheck = 0;
        }

        init(world) {
            this._applyLevel();
        }

        update(dt, world) {
            // Auto-EMCON: adjust based on threat picture
            if (this._autoEMCON && world) {
                var now = world.simTime || 0;
                if (now - this._lastAutoCheck >= 2.0) {
                    this._lastAutoCheck = now;
                    this._autoAdjust(world);
                }
            }

            this._applyLevel();
        }

        /** Set EMCON level (0-3). */
        setLevel(level) {
            this._level = Math.max(0, Math.min(3, level));
            this._applyLevel();
        }

        /** Cycle to next EMCON level. */
        cycleLevel() {
            this._level = (this._level + 1) % 4;
            this._applyLevel();
        }

        _applyLevel() {
            if (!this.entity || !this.entity.state) return;
            var s = this.entity.state;
            s._emconLevel = this._level;
            s._emconName = EMCON_LEVELS[this._level];
            s._emconRadarMul = RADAR_MULTIPLIERS[this._level];
            s._emconCommMul = COMM_MULTIPLIERS[this._level];
            s._emconEmissionSig = EMISSION_SIGNATURES[this._level];

            // When TIGHT, disable radar scanning
            if (this._level === 0) {
                s._sensorDisabled = true;
            } else if (!s._cyberDegradation || !s._cyberDegradation.sensors) {
                // Only re-enable if not cyber-disabled
                s._sensorDisabled = false;
            }
        }

        /** Auto-adjust EMCON based on nearest threat. */
        _autoAdjust(world) {
            var s = this.entity.state;
            var detections = s._detections || [];
            var nearestThreat = Infinity;

            for (var i = 0; i < detections.length; i++) {
                var det = detections[i];
                if (!det.detected) continue;
                var target = world.getEntity(det.targetId);
                if (!target || target.team === this.entity.team) continue;
                if (det.range_m < nearestThreat) nearestThreat = det.range_m;
            }

            if (nearestThreat < this._threatRange * 0.3) {
                // Very close threat — go EMCON TIGHT (passive only)
                this._level = 0;
            } else if (nearestThreat < this._threatRange * 0.7) {
                // Medium threat — EMCON LOW
                this._level = 1;
            } else if (nearestThreat < this._threatRange) {
                // Distant threat — NORMAL
                this._level = 2;
            } else {
                // No threats nearby — FREE
                this._level = 3;
            }
        }

        cleanup(world) {
            if (this.entity && this.entity.state) {
                this.entity.state._emconLevel = null;
                this.entity.state._emconName = null;
                this.entity.state._emconRadarMul = null;
                this.entity.state._sensorDisabled = false;
            }
        }
    }

    ComponentRegistry.register('ai', 'emcon', EmconComponent);
    window.EmconComponent = EmconComponent;
})();
