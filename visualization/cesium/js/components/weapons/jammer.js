/**
 * Jammer weapon component — electronic warfare jammer for disrupting comm links.
 *
 * Implements configurable jamming modes (noise, spot, sweep, barrage) that
 * target enemy communication links within range. Reads radar detections to
 * auto-activate when enemies are detected, or can be manually forced on.
 *
 * Integrates with CommEngine (if loaded) to report jamming effects. The
 * CommEngine handles the actual signal degradation math; this component
 * manages activation logic, target selection, and state reporting.
 *
 * Config (from scenario JSON):
 *   type: "jammer"
 *   jamType: "barrage"          — noise | spot | sweep | barrage
 *   targetFreq_ghz: 12.5       — center frequency for spot jamming
 *   bandwidth_ghz: 2.0         — jamming bandwidth
 *   power_dbw: 40              — effective radiated power in dBW
 *   range_m: 200000            — effective jamming range in meters
 *   direction: "both"          — uplink | downlink | both
 *   activateOnDetection: true  — auto-activate when radar detects enemy
 *   dutyCycle: 1.0             — 0-1, fraction of time active
 *   burnThrough_m: 50000       — range at which target can burn through jam
 *
 * State outputs on entity.state:
 *   _jammerActive       — boolean, is jammer currently transmitting
 *   _jammerType         — string, current jam type
 *   _jammerTargets      — array of entity IDs being jammed
 *   _jammerPower        — number, power in dBW
 *   _jammerRange        — number, effective range in meters
 *   _jammerDirection    — string, uplink/downlink/both
 *   _jammerSweepPhase   — number, current sweep position (0-1) for sweep mode
 *
 * Registers as: weapons/jammer
 */
(function() {
    'use strict';

    var R_EARTH = FrameworkConstants.R_EARTH;

    // --- Jammer types ---
    var JAM_NOISE   = 'noise';     // Broadband noise, degrades all links
    var JAM_SPOT    = 'spot';      // Narrow-band, targets specific frequency
    var JAM_SWEEP   = 'sweep';     // Sweeps across frequency band over time
    var JAM_BARRAGE = 'barrage';   // High-power broadband, covers all frequencies

    // --- Duty cycle timing ---
    var DUTY_PERIOD = 1.0;         // Seconds per duty cycle period

    // --- Sweep parameters ---
    var SWEEP_PERIOD = 4.0;        // Seconds for one full frequency sweep

    // --- Update throttle ---
    var UPDATE_INTERVAL = 0.25;    // Target scan every 250ms

    /**
     * Compute straight-line range between two geodetic positions.
     * Uses haversine + altitude difference for slant range.
     */
    function slantRange(lat1, lon1, alt1, lat2, lon2, alt2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var horizDist = R_EARTH * c;
        var dAlt = alt2 - alt1;
        return Math.sqrt(horizDist * horizDist + dAlt * dAlt);
    }

    /**
     * Compute bearing from position 1 to position 2 (radians input, degrees output).
     */
    function computeBearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brng = Math.atan2(y, x) * (180 / Math.PI);
        return (brng + 360) % 360;
    }

    // -----------------------------------------------------------------------
    // Jammer Component
    // -----------------------------------------------------------------------
    class Jammer extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._jamType           = config.jamType || JAM_BARRAGE;
            this._targetFreq        = config.targetFreq_ghz !== undefined ? config.targetFreq_ghz : 12.5;
            this._bandwidth         = config.bandwidth_ghz !== undefined ? config.bandwidth_ghz : 2.0;
            this._power             = config.power_dbw !== undefined ? config.power_dbw : 40;
            this._range             = config.range_m !== undefined ? config.range_m : 200000;
            this._direction         = config.direction || 'both';
            this._activateOnDetect  = config.activateOnDetection !== false;
            this._dutyCycle         = config.dutyCycle !== undefined ? config.dutyCycle : 1.0;
            this._burnThrough       = config.burnThrough_m !== undefined ? config.burnThrough_m : 50000;

            // Runtime state
            this._active            = false;
            this._targets           = [];
            this._sweepPhase        = 0;
            this._dutyTimer         = 0;
            this._dutyOn            = true;
            this._updateAccum       = 0;
            this._registeredWithCE  = false;
        }

        init(world) {
            var state = this.entity.state;

            // Initialize state outputs
            state._jammerActive     = false;
            state._jammerType       = this._jamType;
            state._jammerTargets    = [];
            state._jammerPower      = this._power;
            state._jammerRange      = this._range;
            state._jammerDirection  = this._direction;
            state._jammerSweepPhase = 0;

            // Register with CommEngine if available
            this._registerWithCommEngine();
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;

            var state = entity.state;

            // --- Duty cycle ---
            this._dutyTimer += dt;
            if (this._dutyTimer >= DUTY_PERIOD) {
                this._dutyTimer -= DUTY_PERIOD;
            }
            this._dutyOn = (this._dutyCycle >= 1.0) ||
                           (this._dutyTimer / DUTY_PERIOD < this._dutyCycle);

            // --- Activation logic ---
            var shouldActivate = false;

            // Manual force activation
            if (state._jammerForceActive) {
                shouldActivate = true;
            }

            // Auto-activate on detection
            if (this._activateOnDetect && !shouldActivate) {
                var detections = state._detections || [];
                for (var d = 0; d < detections.length; d++) {
                    if (detections[d].detected) {
                        // Check if detected entity is on opposing team
                        var detTargetId = detections[d].targetId || detections[d].entityId;
                        if (detTargetId) {
                            var detTarget = world.getEntity(detTargetId);
                            if (detTarget && detTarget.team !== entity.team) {
                                shouldActivate = true;
                                break;
                            }
                        }
                    }
                }
            }

            this._active = shouldActivate && this._dutyOn;
            state._jammerActive = this._active;

            // --- Sweep mode frequency progression ---
            if (this._jamType === JAM_SWEEP) {
                this._sweepPhase = (this._sweepPhase + dt / SWEEP_PERIOD) % 1.0;
                state._jammerSweepPhase = this._sweepPhase;
            }

            // --- Throttle target scanning ---
            this._updateAccum += dt;
            if (this._updateAccum < UPDATE_INTERVAL) return;
            this._updateAccum = 0;

            // --- Target acquisition ---
            if (!this._active) {
                this._targets = [];
                state._jammerTargets = [];
                this._updateCommEngine(state);
                return;
            }

            var myLat = state.lat;
            var myLon = state.lon;
            var myAlt = state.alt || 0;
            var myTeam = entity.team;

            if (myLat === undefined || myLon === undefined) return;

            var newTargets = [];

            world.entities.forEach(function(target) {
                // Skip self, inactive, same-team
                if (target.id === entity.id) return;
                if (!target.active) return;
                if (target.team === myTeam) return;

                var ts = target.state;
                if (ts.lat === undefined || ts.lon === undefined) return;

                var tLat = ts.lat;
                var tLon = ts.lon;
                var tAlt = ts.alt || 0;

                // Range check
                var range = slantRange(myLat, myLon, myAlt, tLat, tLon, tAlt);
                if (range > this._range) return;

                // Compute bearing to target (for directional jamming modes)
                var bearing = computeBearing(myLat, myLon, tLat, tLon);

                // Check burn-through: if target is close enough, jamming is ineffective
                var burnedThrough = (range < this._burnThrough);

                newTargets.push({
                    entityId: target.id,
                    range: range,
                    bearing: bearing,
                    burnedThrough: burnedThrough
                });
            }.bind(this));

            // Update target list (just IDs for state output)
            this._targets = newTargets;
            state._jammerTargets = [];
            for (var t = 0; t < newTargets.length; t++) {
                if (!newTargets[t].burnedThrough) {
                    state._jammerTargets.push(newTargets[t].entityId);
                }
            }

            // Set _commJammed flag on jammed entities
            for (var j = 0; j < newTargets.length; j++) {
                if (newTargets[j].burnedThrough) continue;
                var jammedEntity = world.getEntity(newTargets[j].entityId);
                if (jammedEntity && jammedEntity.state) {
                    jammedEntity.state._commJammed = true;
                }
            }

            // Report to CommEngine
            this._updateCommEngine(state);
        }

        /**
         * Register this jammer with CommEngine for link-level effects.
         */
        _registerWithCommEngine() {
            if (typeof CommEngine === 'undefined') return;
            if (this._registeredWithCE) return;

            try {
                CommEngine.addJammer(this.entity.id, {
                    jamType: this._jamType,
                    targetFreq_ghz: this._targetFreq,
                    bandwidth_ghz: this._bandwidth,
                    power_dbw: this._power,
                    range_m: this._range,
                    direction: this._direction,
                    burnThrough_m: this._burnThrough
                });
                this._registeredWithCE = true;
            } catch (e) {
                // CommEngine not ready or error
            }
        }

        /**
         * Push current jammer state to CommEngine for link-level computation.
         */
        _updateCommEngine(state) {
            if (typeof CommEngine === 'undefined') return;
            if (!this._registeredWithCE) {
                this._registerWithCommEngine();
            }

            try {
                var jamConfig = {
                    active: this._active,
                    jamType: this._jamType,
                    power_dbw: this._power,
                    range_m: this._range,
                    direction: this._direction,
                    targets: state._jammerTargets || [],
                    sweepPhase: this._sweepPhase,
                    position: {
                        lat: state.lat,
                        lon: state.lon,
                        alt: state.alt || 0
                    }
                };

                // Compute current frequency for sweep mode
                if (this._jamType === JAM_SWEEP) {
                    var halfBw = this._bandwidth / 2;
                    jamConfig.currentFreq_ghz = this._targetFreq - halfBw +
                                                this._bandwidth * this._sweepPhase;
                } else if (this._jamType === JAM_SPOT) {
                    jamConfig.currentFreq_ghz = this._targetFreq;
                }

                // Update CommEngine
                if (typeof CommEngine.updateJammer === 'function') {
                    CommEngine.updateJammer(this.entity.id, jamConfig);
                }
            } catch (e) {
                // CommEngine error — silent degradation
            }
        }

        /**
         * Remove jammer from CommEngine and clean up state.
         */
        cleanup(world) {
            // Unregister from CommEngine
            if (typeof CommEngine !== 'undefined' && this._registeredWithCE) {
                try {
                    CommEngine.removeJammer(this.entity.id);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
            this._registeredWithCE = false;

            // Clear entity state
            var state = this.entity.state;
            state._jammerActive = false;
            state._jammerTargets = [];

            // Clear jammed flags on targets we were jamming
            if (world) {
                for (var i = 0; i < this._targets.length; i++) {
                    var target = world.getEntity(this._targets[i].entityId);
                    if (target && target.state) {
                        target.state._commJammed = false;
                    }
                }
            }

            this._targets = [];
            this._active = false;
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { key: 'jamType',             label: 'Jam Type',           type: 'select', options: ['noise', 'spot', 'sweep', 'barrage'], default: 'barrage' },
                { key: 'targetFreq_ghz',      label: 'Target Freq (GHz)', type: 'number', default: 12.5,   min: 0.1,    max: 100,   step: 0.1 },
                { key: 'bandwidth_ghz',       label: 'Bandwidth (GHz)',   type: 'number', default: 2.0,    min: 0.01,   max: 50,    step: 0.01 },
                { key: 'power_dbw',           label: 'Power (dBW)',       type: 'number', default: 40,     min: 0,      max: 80 },
                { key: 'range_m',             label: 'Range (m)',         type: 'number', default: 200000, min: 1000,   max: 1000000 },
                { key: 'direction',           label: 'Direction',         type: 'select', options: ['uplink', 'downlink', 'both'], default: 'both' },
                { key: 'activateOnDetection', label: 'Auto-Activate',     type: 'boolean', default: true },
                { key: 'dutyCycle',           label: 'Duty Cycle',        type: 'number', default: 1.0,    min: 0,      max: 1,     step: 0.05 },
                { key: 'burnThrough_m',       label: 'Burn-Through (m)',  type: 'number', default: 50000,  min: 0,      max: 500000 }
            ];
        }
    }

    // Register with framework
    ComponentRegistry.register('weapons', 'jammer', Jammer);
})();
