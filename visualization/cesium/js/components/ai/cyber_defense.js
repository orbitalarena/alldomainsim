/**
 * CyberDefenseAI component -- autonomous blue team cyber defender that monitors
 * friendly entities for cyber attacks and responds with defensive actions.
 *
 * Scans same-team entities for cyber damage (degradation, exploits, scanning),
 * patches compromised subsystems, isolates critically degraded nodes, and
 * optionally traces attackers for counter-exploitation.
 *
 * State machine: MONITORING -> RESPONDING -> PATCHING -> ISOLATING -> MONITORING
 *
 * Integrates with:
 *   - CyberOpsAI attacker: reads _cyberExploited, _cyberDegradation,
 *     _cyberScanning, _cyberLateralSource state flags set by attackers
 *   - cyber/computer component: reads _hardening, _patchLevel
 *   - cyber/firewall component: reads _firewallActive, _firewallHealth
 *   - CommEngine: sets _commIsolated on isolated nodes
 *   - Entity state flags: clears _sensorDisabled, _weaponsDisabled,
 *     _navigationHijacked, _commsDisabled, _fullControl, _computerCompromised
 *
 * Config (from scenario JSON component config):
 *   monitorInterval:        seconds between scan sweeps               (default 5)
 *   patchRate:              degradation reduction per second           (default 0.03)
 *   isolateThreshold:       degradation level triggering isolation     (default 0.7)
 *   counterAttackEnabled:   attempt to trace and counter-exploit       (default false)
 *   maxSimultaneousPatches: max entities being patched at once         (default 2)
 *   alertRadius_m:          range to monitor friendly entities         (default 500000)
 *
 * State outputs on entity.state:
 *   _cyberDefenseState:     current state machine state string
 *   _cyberDefensePatching:  number of entities currently being patched
 *   _cyberDefenseIsolated:  number of entities currently isolated
 *   _cyberDefenseAlerts:    number of active alerts
 *   _cyberDefenseLog:       array of recent log entries
 *
 * MC-compatible: uses world.rng for all random decisions.
 * Headless-safe: no Cesium API calls, no document references.
 *
 * Registers as: ai / cyber_defense
 */
const CyberDefenseAI = (function() {
    'use strict';

    // --- State machine states ---
    var STATE_MONITORING = 'MONITORING';
    var STATE_RESPONDING = 'RESPONDING';
    var STATE_PATCHING   = 'PATCHING';
    var STATE_ISOLATING  = 'ISOLATING';

    // --- Alert levels ---
    var ALERT_SAFE        = 0;
    var ALERT_UNDER_ATTACK = 1;
    var ALERT_COMPROMISED  = 2;
    var ALERT_CRITICAL     = 3;

    // --- Constants ---
    var R_EARTH            = 6371000; // meters
    var ISOLATION_DURATION = 30;      // seconds before re-checking isolated node
    var MAX_LOG_ENTRIES    = 50;      // cap on _log array length
    var COUNTER_ATTACK_COOLDOWN = 20; // seconds between counter-attack attempts
    var SUBSYSTEMS = ['sensors', 'navigation', 'weapons', 'comms'];

    /**
     * Get a random number using world.rng if available, otherwise Math.random().
     * @param {object} world
     * @returns {number} Random value in [0, 1)
     */
    function getRandom(world) {
        if (world && world.rng && typeof world.rng.random === 'function') {
            return world.rng.random();
        }
        return Math.random();
    }

    /**
     * ECI distance between two entities (meters). Falls back to haversine if
     * ECI positions are not available.
     */
    function entityDistance(stateA, stateB) {
        // Prefer ECI distance if both have ECI positions
        if (stateA._eci_pos && stateB._eci_pos) {
            var dx = stateA._eci_pos[0] - stateB._eci_pos[0];
            var dy = stateA._eci_pos[1] - stateB._eci_pos[1];
            var dz = stateA._eci_pos[2] - stateB._eci_pos[2];
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }

        // Fallback to haversine if lat/lon are available
        if (stateA.lat !== undefined && stateB.lat !== undefined) {
            var dLat = stateB.lat - stateA.lat;
            var dLon = stateB.lon - stateA.lon;
            var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(stateA.lat) * Math.cos(stateB.lat) *
                    Math.sin(dLon / 2) * Math.sin(dLon / 2);
            return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        // Cannot compute distance
        return Infinity;
    }

    /**
     * Get the maximum degradation value across all 4 subsystems.
     * @param {object} deg  _cyberDegradation object {sensors, navigation, weapons, comms}
     * @returns {number} Maximum degradation value (0 to 1)
     */
    function maxDegradation(deg) {
        if (!deg) return 0;
        return Math.max(
            deg.sensors    || 0,
            deg.navigation || 0,
            deg.weapons    || 0,
            deg.comms      || 0
        );
    }

    /**
     * Check if all subsystems have zero degradation.
     * @param {object} deg  _cyberDegradation object
     * @returns {boolean}
     */
    function allClean(deg) {
        if (!deg) return true;
        return (deg.sensors || 0) <= 0 &&
               (deg.navigation || 0) <= 0 &&
               (deg.weapons || 0) <= 0 &&
               (deg.comms || 0) <= 0;
    }

    // -----------------------------------------------------------------------
    // CyberDefenseAI Component
    // -----------------------------------------------------------------------
    class CyberDefenseAIComponent extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._monitorInterval        = config.monitorInterval        !== undefined ? config.monitorInterval        : 5;
            this._patchRate              = config.patchRate              !== undefined ? config.patchRate              : 0.03;
            this._isolateThreshold       = config.isolateThreshold       !== undefined ? config.isolateThreshold       : 0.7;
            this._counterAttackEnabled   = config.counterAttackEnabled   !== undefined ? config.counterAttackEnabled   : false;
            this._maxSimultaneousPatches = config.maxSimultaneousPatches !== undefined ? config.maxSimultaneousPatches : 2;
            this._alertRadius_m          = config.alertRadius_m          !== undefined ? config.alertRadius_m          : 500000;

            // Clamp numeric values
            this._monitorInterval        = Math.max(1, this._monitorInterval);
            this._patchRate              = Math.max(0.001, Math.min(1, this._patchRate));
            this._isolateThreshold       = Math.max(0.1, Math.min(1, this._isolateThreshold));
            this._maxSimultaneousPatches = Math.max(1, Math.min(10, this._maxSimultaneousPatches));
            this._alertRadius_m          = Math.max(1000, this._alertRadius_m);

            // Runtime state
            this._state          = STATE_MONITORING;
            this._monitorTimer   = 0;
            this._patchTargets   = [];       // array of { entityId, startTime }
            this._isolatedNodes  = [];       // array of { entityId, isolatedAt }
            this._alerts         = [];       // array of { entityId, level, time }
            this._log            = [];       // array of log strings
            this._counterAttackTimer   = 0;
            this._counterAttackTargets = []; // entity IDs already counter-attacked (avoid repeats)
        }

        init(world) {
            var state = this.entity.state;
            state._cyberDefenseState    = STATE_MONITORING;
            state._cyberDefensePatching = 0;
            state._cyberDefenseIsolated = 0;
            state._cyberDefenseAlerts   = 0;
            state._cyberDefenseLog      = [];
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;
            if (entity.state._destroyed) return;

            var state = entity.state;

            // Monitor timer
            this._monitorTimer += dt;

            // Periodic scan: find all friendly entities with cyber damage
            if (this._monitorTimer >= this._monitorInterval) {
                this._monitorTimer = 0;
                this._scanFriendlyEntities(world);
            }

            // Determine current state based on active operations
            this._updateStateMachine();

            // Process active patches (reduce degradation on patching targets)
            this._tickPatching(dt, world);

            // Process active isolations (temporarily disconnect compromised nodes)
            this._tickIsolation(dt, world);

            // Counter-attack if enabled (trace attacker, attempt reverse exploit)
            if (this._counterAttackEnabled) {
                this._tickCounterAttack(dt, world);
            }

            // Update state for HUD/viz
            state._cyberDefenseState    = this._state;
            state._cyberDefensePatching = this._patchTargets.length;
            state._cyberDefenseIsolated = this._isolatedNodes.length;
            state._cyberDefenseAlerts   = this._alerts.length;
            state._cyberDefenseLog      = this._log;
        }

        // -------------------------------------------------------------------
        // State machine
        // -------------------------------------------------------------------

        /**
         * Update the state machine based on current active operations.
         * Priority: ISOLATING > PATCHING > RESPONDING > MONITORING
         */
        _updateStateMachine() {
            if (this._isolatedNodes.length > 0) {
                this._state = STATE_ISOLATING;
            } else if (this._patchTargets.length > 0) {
                this._state = STATE_PATCHING;
            } else if (this._alerts.length > 0) {
                this._state = STATE_RESPONDING;
            } else {
                this._state = STATE_MONITORING;
            }
        }

        // -------------------------------------------------------------------
        // Scanning
        // -------------------------------------------------------------------

        /**
         * Scan all friendly entities within alert radius for cyber damage.
         * Sets alert levels and queues entities for patching/isolation.
         */
        _scanFriendlyEntities(world) {
            var entity = this.entity;
            var myTeam = entity.team;
            var myState = entity.state;

            // Clear previous alerts (rebuild each scan)
            this._alerts = [];

            world.entities.forEach(function(other) {
                // Skip self
                if (other.id === entity.id) return;

                // Skip different team
                if (other.team !== myTeam) return;

                // Skip inactive or destroyed
                if (!other.active) return;
                if (other.state._destroyed) return;

                // Range check
                var dist = entityDistance(myState, other.state);
                if (dist > this._alertRadius_m) return;

                var ts = other.state;
                var alertLevel = ALERT_SAFE;

                // Check for active scanning (under attack)
                if (ts._cyberScanning) {
                    alertLevel = Math.max(alertLevel, ALERT_UNDER_ATTACK);
                }

                // Check for compromise
                if (ts._cyberExploited || ts._computerCompromised) {
                    alertLevel = Math.max(alertLevel, ALERT_COMPROMISED);
                }

                // Check degradation across all 4 subsystems
                var deg = ts._cyberDegradation;
                if (deg) {
                    var maxDeg = maxDegradation(deg);

                    if (maxDeg > 0 && maxDeg < this._isolateThreshold) {
                        alertLevel = Math.max(alertLevel, ALERT_UNDER_ATTACK);
                    }

                    if (maxDeg >= this._isolateThreshold) {
                        alertLevel = Math.max(alertLevel, ALERT_CRITICAL);
                    }

                    // Queue for patching if any degradation > 0 and not already patching
                    if (maxDeg > 0 && !this._isPatchTarget(other.id)) {
                        // Only add if we have patch capacity
                        if (this._patchTargets.length < this._maxSimultaneousPatches) {
                            this._patchTargets.push({
                                entityId: other.id,
                                startTime: world.simTime || 0
                            });
                            this._addLog('PATCH QUEUED: ' + (other.name || other.id));
                        }
                    }

                    // Trigger isolation if any subsystem exceeds threshold
                    if (maxDeg >= this._isolateThreshold && !this._isIsolated(other.id)) {
                        this._isolatedNodes.push({
                            entityId: other.id,
                            isolatedAt: world.simTime || 0
                        });
                        ts._commIsolated = true;
                        this._addLog('ISOLATED: ' + (other.name || other.id) +
                                     ' (degradation ' + (maxDeg * 100).toFixed(0) + '%)');
                    }
                }

                // Set alert level on the friendly entity
                ts._cyberAlertLevel = alertLevel;

                // Record alert if non-zero
                if (alertLevel > ALERT_SAFE) {
                    this._alerts.push({
                        entityId: other.id,
                        level: alertLevel,
                        time: world.simTime || 0
                    });
                }
            }.bind(this));
        }

        // -------------------------------------------------------------------
        // Patching
        // -------------------------------------------------------------------

        /**
         * Process active patches: reduce degradation on patching targets.
         * When all subsystems are clean, remove from patch queue and clear exploit flags.
         */
        _tickPatching(dt, world) {
            for (var i = this._patchTargets.length - 1; i >= 0; i--) {
                var patchInfo = this._patchTargets[i];
                var target = world.getEntity(patchInfo.entityId);

                // Target no longer valid
                if (!target || !target.active || target.state._destroyed) {
                    this._patchTargets.splice(i, 1);
                    continue;
                }

                var ts = target.state;
                var deg = ts._cyberDegradation;

                // Nothing to patch
                if (!deg || allClean(deg)) {
                    // Clear exploit flags when fully patched
                    ts._cyberExploited = false;
                    ts._computerCompromised = false;
                    ts._computerAccessLevel = 'NONE';
                    ts._cyberLateralSource = null;
                    ts._cyberLateralSpread = false;

                    // Clear subsystem disable flags
                    ts._sensorDisabled = false;
                    ts._weaponsDisabled = false;
                    ts._navigationHijacked = false;
                    ts._commsDisabled = false;
                    ts._fullControl = false;

                    this._addLog('PATCHED: ' + (target.name || target.id) + ' fully restored');
                    this._patchTargets.splice(i, 1);
                    continue;
                }

                // Reduce degradation on each subsystem
                var reduction = this._patchRate * dt;
                var patchedAny = false;

                for (var s = 0; s < SUBSYSTEMS.length; s++) {
                    var sub = SUBSYSTEMS[s];
                    if ((deg[sub] || 0) > 0) {
                        var oldVal = deg[sub];
                        deg[sub] = Math.max(0, deg[sub] - reduction);

                        // If subsystem just reached 0, clear its disable flag and log
                        if (oldVal > 0 && deg[sub] <= 0) {
                            deg[sub] = 0;
                            patchedAny = true;

                            switch (sub) {
                                case 'sensors':
                                    ts._sensorDisabled = false;
                                    break;
                                case 'navigation':
                                    ts._navigationHijacked = false;
                                    break;
                                case 'weapons':
                                    ts._weaponsDisabled = false;
                                    break;
                                case 'comms':
                                    ts._commsDisabled = false;
                                    break;
                            }

                            this._addLog('PATCHED: ' + (target.name || target.id) +
                                         ' ' + sub + ' restored');
                        }
                    }
                }

                // If all subsystems now clean, clear exploit flags
                if (allClean(deg)) {
                    ts._cyberExploited = false;
                    ts._computerCompromised = false;
                    ts._computerAccessLevel = 'NONE';
                    ts._cyberLateralSource = null;
                    ts._cyberLateralSpread = false;
                    ts._fullControl = false;

                    this._addLog('PATCHED: ' + (target.name || target.id) + ' fully restored');
                    this._patchTargets.splice(i, 1);
                }
            }
        }

        // -------------------------------------------------------------------
        // Isolation
        // -------------------------------------------------------------------

        /**
         * Process isolated nodes. After ISOLATION_DURATION seconds, check if the
         * entity is clean (no active exploits/degradation). If clean, restore
         * network connectivity. If still compromised, keep isolated.
         */
        _tickIsolation(dt, world) {
            var simTime = world.simTime || 0;

            for (var i = this._isolatedNodes.length - 1; i >= 0; i--) {
                var isoInfo = this._isolatedNodes[i];
                var target = world.getEntity(isoInfo.entityId);

                // Target no longer valid
                if (!target || !target.active || target.state._destroyed) {
                    this._isolatedNodes.splice(i, 1);
                    continue;
                }

                var ts = target.state;
                var elapsed = simTime - isoInfo.isolatedAt;

                // Ensure isolation flag stays set
                ts._commIsolated = true;

                // After isolation duration, check if entity is clean
                if (elapsed >= ISOLATION_DURATION) {
                    var deg = ts._cyberDegradation;
                    var isClean = allClean(deg) && !ts._cyberExploited && !ts._computerCompromised;

                    if (isClean) {
                        // Entity is clean -- restore network connectivity
                        ts._commIsolated = false;
                        this._addLog('RESTORED: ' + (target.name || target.id) +
                                     ' network restored after isolation');
                        this._isolatedNodes.splice(i, 1);
                    } else {
                        // Still compromised -- extend isolation (reset timer)
                        isoInfo.isolatedAt = simTime;
                        this._addLog('ISOLATION EXTENDED: ' + (target.name || target.id) +
                                     ' still compromised');
                    }
                }
            }
        }

        // -------------------------------------------------------------------
        // Counter-attack
        // -------------------------------------------------------------------

        /**
         * Trace attackers from compromised friendly entities and attempt
         * counter-exploitation. Checks _cyberLateralSource to find the
         * attacker entity, then attempts a reverse exploit against it.
         */
        _tickCounterAttack(dt, world) {
            this._counterAttackTimer += dt;

            if (this._counterAttackTimer < COUNTER_ATTACK_COOLDOWN) return;
            this._counterAttackTimer = 0;

            var entity = this.entity;
            var myTeam = entity.team;
            var myState = entity.state;

            // Find compromised friendly entities that have a traceable attacker
            world.entities.forEach(function(other) {
                // Only check friendly entities
                if (other.team !== myTeam) return;
                if (other.id === entity.id) return;
                if (!other.active || other.state._destroyed) return;

                var ts = other.state;

                // Need a traceable source
                var sourceId = ts._cyberLateralSource || ts._cyberAttackerId;
                if (!sourceId) return;

                // Skip if already counter-attacked this source
                if (this._counterAttackTargets.indexOf(sourceId) >= 0) return;

                var attacker = world.getEntity(sourceId);
                if (!attacker || !attacker.active || attacker.state._destroyed) return;

                // Must be on enemy team
                if (attacker.team === myTeam) return;

                // Range check to attacker (cyber range, not physical, but still bounded)
                var dist = entityDistance(myState, attacker.state);
                if (dist > this._alertRadius_m * 2) return;

                // Mark as attempted regardless of outcome
                this._counterAttackTargets.push(sourceId);

                // Read attacker's hardening/firewall
                var attackerHardening = 0;
                var attackerFirewall = 0;
                var as = attacker.state;

                if (as._computerHardening !== undefined) {
                    attackerHardening = as._computerHardening;
                } else if (as._hardening !== undefined) {
                    attackerHardening = as._hardening;
                } else {
                    // Default assumption for attacker entities
                    attackerHardening = 0.5;
                }

                if (as._firewallActive && !as._firewallBypassed) {
                    attackerFirewall = (as._firewallHealth || 1.0) * (as._firewallRating || 0.5);
                }

                // Probability of counter-success = (1 - attacker_hardening) * 0.3
                // Firewall further reduces chance
                var counterChance = (1 - attackerHardening) * 0.3 * (1 - attackerFirewall * 0.3);
                counterChance = Math.max(0.02, Math.min(0.5, counterChance));

                var roll = getRandom(world);

                if (roll < counterChance) {
                    // Counter-attack success: disrupt attacker's comms
                    if (!as._cyberDegradation) {
                        as._cyberDegradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };
                    }
                    as._cyberDegradation.comms = Math.max(as._cyberDegradation.comms || 0, 0.5);
                    as._cyberExploited = true;

                    this._addLog('COUNTER-ATTACK: traced to ' + (attacker.name || attacker.id) +
                                 ', result: SUCCESS (comms disrupted)');
                } else {
                    this._addLog('COUNTER-ATTACK: traced to ' + (attacker.name || attacker.id) +
                                 ', result: FAILED');
                }
            }.bind(this));
        }

        // -------------------------------------------------------------------
        // Utility
        // -------------------------------------------------------------------

        /**
         * Check if an entity is already in the patch queue.
         * @param {string} entityId
         * @returns {boolean}
         */
        _isPatchTarget(entityId) {
            for (var i = 0; i < this._patchTargets.length; i++) {
                if (this._patchTargets[i].entityId === entityId) return true;
            }
            return false;
        }

        /**
         * Check if an entity is currently isolated.
         * @param {string} entityId
         * @returns {boolean}
         */
        _isIsolated(entityId) {
            for (var i = 0; i < this._isolatedNodes.length; i++) {
                if (this._isolatedNodes[i].entityId === entityId) return true;
            }
            return false;
        }

        /**
         * Add a log entry with timestamp truncation.
         * @param {string} message
         */
        _addLog(message) {
            this._log.push(message);
            if (this._log.length > MAX_LOG_ENTRIES) {
                this._log.shift();
            }
        }

        /**
         * Clean up all state and effects on entity removal.
         */
        cleanup(world) {
            // Restore all isolated nodes
            for (var i = 0; i < this._isolatedNodes.length; i++) {
                var isoInfo = this._isolatedNodes[i];
                var target = world.getEntity(isoInfo.entityId);
                if (target && target.state) {
                    target.state._commIsolated = false;
                }
            }

            // Clear alert levels on all entities we were monitoring
            var entity = this.entity;
            var myTeam = entity.team;

            world.entities.forEach(function(other) {
                if (other.team === myTeam && other.state) {
                    if (other.state._cyberAlertLevel !== undefined) {
                        other.state._cyberAlertLevel = ALERT_SAFE;
                    }
                }
            });

            // Reset internal state
            this._patchTargets = [];
            this._isolatedNodes = [];
            this._alerts = [];
            this._log = [];
            this._counterAttackTargets = [];
            this._counterAttackTimer = 0;
            this._monitorTimer = 0;
            this._state = STATE_MONITORING;

            // Clear entity state
            var state = this.entity.state;
            state._cyberDefenseState    = null;
            state._cyberDefensePatching = 0;
            state._cyberDefenseIsolated = 0;
            state._cyberDefenseAlerts   = 0;
            state._cyberDefenseLog      = [];
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { name: 'monitorInterval',        type: 'number',  label: 'Monitor Interval (s)', default: 5,      min: 1,    max: 60 },
                { name: 'patchRate',              type: 'number',  label: 'Patch Rate (/s)',       default: 0.03,   min: 0.001, max: 1,   step: 0.005 },
                { name: 'isolateThreshold',       type: 'number',  label: 'Isolate Threshold',     default: 0.7,    min: 0.1,  max: 1,   step: 0.05 },
                { name: 'counterAttackEnabled',   type: 'checkbox', label: 'Counter-Attack',        default: false },
                { name: 'maxSimultaneousPatches', type: 'number',  label: 'Max Patches',           default: 2,      min: 1,    max: 10 },
                { name: 'alertRadius_m',          type: 'number',  label: 'Alert Radius (m)',      default: 500000, min: 1000, max: 50000000 }
            ];
        }
    }

    return CyberDefenseAIComponent;
})();

ComponentRegistry.register('ai', 'cyber_defense', CyberDefenseAI);
