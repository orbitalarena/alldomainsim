/**
 * CyberOpsAI component -- autonomous cyber warfare AI for NPC entities.
 *
 * Scans for opposing-team entities, prioritizes targets by value (command,
 * sensors, weapons, proximity), then runs an exploit operation against the
 * target's onboard computer. On success, sets subsystem-disable flags on the
 * target entity that other components (sensors, weapons, AI, comms) respect.
 *
 * State machine: IDLE -> SCANNING -> TARGETING -> EXPLOITING -> ACTIVE -> COOLDOWN -> SCANNING
 *
 * Integrates with:
 *   - cyber/computer component: reads _hardening, _patchLevel, getVulnerability(),
 *     getHackableSubsystems(), writes _computerCompromised, _computerAccessLevel,
 *     _computerHackedSubsystems
 *   - cyber/firewall component: reads _firewallActive, _firewallBypassed, _firewallHealth
 *   - CommEngine (global IIFE): addCyberAttack() for network-level effects
 *   - Entity state flags: _sensorDisabled, _weaponsDisabled, _navigationHijacked,
 *     _commsDisabled, _fullControl, _computerCompromised
 *
 * Config (from scenario JSON component config):
 *   preferredAttack:   'sensors'|'navigation'|'weapons'|'comms'|'all'  (default 'sensors')
 *   scanInterval:      seconds between scans                           (default 10)
 *   baseExploitTime:   seconds for exploit attempt                     (default 15)
 *   baseProbability:   base success chance 0-1                         (default 0.7)
 *   cooldownTime:      seconds between attacks                         (default 20)
 *   maxSimultaneous:   max concurrent compromised targets              (default 3)
 *   aggressiveness:    0-1, affects scan freq and exploit speed        (default 0.5)
 *   stealthLevel:      0-1, higher = less likely to trigger alerts     (default 0.5)
 *   lateralMovement:   true/false, attempt lateral spread via comms    (default true)
 *
 * State outputs on entity.state:
 *   _cyberOpsState:     current state machine state string
 *   _cyberOpsTarget:    current target entity ID (or null)
 *   _cyberOpsProgress:  0-1 progress during exploit phase
 *   _cyberOpsCompromisedTargets: array of compromised entity IDs
 *
 * Target state flags set by lateral movement:
 *   _cyberExploited:        true when entity has been compromised by any exploit
 *   _cyberLateralSource:    entity ID of the compromised node that pivoted to this target
 *   _cyberLateralSpread:    true when compromised via lateral movement (vs direct exploit)
 *
 * MC-compatible: uses world.rng for all random decisions.
 * Headless-safe: no Cesium API calls, no document references.
 *
 * Registers as: ai / cyber_ops
 */
const CyberOpsAI = (function() {
    'use strict';

    // --- State machine states ---
    var STATE_IDLE       = 'IDLE';
    var STATE_SCANNING   = 'SCANNING';
    var STATE_TARGETING  = 'TARGETING';
    var STATE_EXPLOITING = 'EXPLOITING';
    var STATE_ACTIVE     = 'ACTIVE';
    var STATE_COOLDOWN   = 'COOLDOWN';

    // --- Target priority weights ---
    var PRIORITY_COMMAND   = 100;
    var PRIORITY_SENSOR    = 70;
    var PRIORITY_WEAPON    = 70;
    var PRIORITY_AIRCRAFT  = 30;
    var PRIORITY_SATELLITE = 20;
    var PRIORITY_GROUND    = 10;
    var PRIORITY_DEFAULT   = 5;

    // --- Distance scoring ---
    var DISTANCE_WEIGHT    = 0.001;   // per-km reduction in priority (slight preference for closer)
    var R_EARTH            = 6371000; // meters

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
     * Haversine distance (meters) between two lat/lon pairs (radians).
     */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
            return haversineDistance(stateA.lat, stateA.lon, stateB.lat, stateB.lon);
        }

        // Cannot compute distance
        return Infinity;
    }

    /**
     * Score a target entity for cyber attack prioritization.
     * Higher score = more valuable target.
     */
    function scoreTarget(targetEntity, myState) {
        var score = PRIORITY_DEFAULT;
        var name = (targetEntity.name || '').toLowerCase();
        var type = (targetEntity.type || '').toLowerCase();

        // Command/AWACS entities are very high priority
        if (name.indexOf('command') >= 0 || name.indexOf('c2') >= 0 ||
            name.indexOf('awacs') >= 0 || name.indexOf('e-3') >= 0 ||
            name.indexOf('e-2') >= 0 || type === 'command') {
            score = PRIORITY_COMMAND;
        }

        // Check for sensor and weapon components
        var hasSensors = false;
        var hasWeapons = false;

        if (targetEntity.getComponent) {
            if (targetEntity.getComponent('sensors')) hasSensors = true;
            if (targetEntity.getComponent('weapons')) hasWeapons = true;
        }

        // Also check state flags from component systems
        var ts = targetEntity.state;
        if (ts._radarRange || ts._sensorRange || ts._radarActive) hasSensors = true;
        if (ts._samActive || ts._weaponReady || ts._a2aReady) hasWeapons = true;

        if (hasSensors && score < PRIORITY_SENSOR) score = PRIORITY_SENSOR;
        if (hasWeapons && score < PRIORITY_WEAPON) score = PRIORITY_WEAPON;

        // Type-based fallback
        if (score <= PRIORITY_DEFAULT) {
            if (type === 'aircraft' || type === 'fighter') score = PRIORITY_AIRCRAFT;
            else if (type === 'satellite') score = PRIORITY_SATELLITE;
            else if (type === 'ground' || type === 'ground_station') score = PRIORITY_GROUND;
        }

        // Distance bonus (closer targets slightly preferred)
        var dist = entityDistance(myState, ts);
        if (isFinite(dist)) {
            var distKm = dist / 1000;
            score -= distKm * DISTANCE_WEIGHT;
        }

        return score;
    }

    // -----------------------------------------------------------------------
    // CyberOpsAI Component
    // -----------------------------------------------------------------------
    class CyberOpsAIComponent extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._preferredAttack  = config.preferredAttack  || 'sensors';
            this._scanInterval     = config.scanInterval     !== undefined ? config.scanInterval     : 10;
            this._baseExploitTime  = config.baseExploitTime  !== undefined ? config.baseExploitTime  : 15;
            this._baseProbability  = config.baseProbability   !== undefined ? config.baseProbability  : 0.7;
            this._cooldownTime     = config.cooldownTime     !== undefined ? config.cooldownTime     : 20;
            this._maxSimultaneous  = config.maxSimultaneous  !== undefined ? config.maxSimultaneous  : 3;
            this._aggressiveness   = config.aggressiveness   !== undefined ? config.aggressiveness   : 0.5;
            this._stealthLevel     = config.stealthLevel     !== undefined ? config.stealthLevel     : 0.5;
            this._lateralMovement  = config.lateralMovement  !== undefined ? config.lateralMovement  : true;

            // Clamp numeric values
            this._aggressiveness  = Math.max(0, Math.min(1, this._aggressiveness));
            this._stealthLevel    = Math.max(0, Math.min(1, this._stealthLevel));
            this._baseProbability = Math.max(0, Math.min(1, this._baseProbability));

            // Validate preferredAttack
            var validAttacks = ['sensors', 'navigation', 'weapons', 'comms', 'all'];
            if (validAttacks.indexOf(this._preferredAttack) < 0) {
                this._preferredAttack = 'sensors';
            }

            // Runtime state
            this._state            = STATE_IDLE;
            this._scanTimer        = 0;
            this._exploitTimer     = 0;
            this._cooldownTimer    = 0;
            this._exploitDuration  = 0;       // computed per-target exploit time
            this._exploitSuccess   = false;   // determined at exploit start
            this._currentTargetId  = null;
            this._compromisedTargets = [];    // array of entity IDs we have compromised
            this._candidates       = [];      // scored candidate list from last scan
            this._lateralTimer     = 0;       // timer for lateral movement scan interval
            this._lateralTargets   = [];      // array of entity IDs attempted via lateral movement

            // Data exfiltration state
            this._exfilTargets     = new Set();     // entity IDs already fully exfiltrated
            this._exfilTimers      = {};            // entityId → elapsed seconds since compromise
            this._exfilDuration    = 30;            // seconds to complete exfiltration per target
            this._exfilDelay       = 10;            // seconds after compromise before exfil starts
        }

        init(world) {
            var state = this.entity.state;
            state._cyberOpsState     = STATE_IDLE;
            state._cyberOpsTarget    = null;
            state._cyberOpsProgress  = 0;
            state._cyberOpsCompromisedTargets = [];
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;
            if (entity.state._destroyed) return;

            var state = entity.state;

            // Prune compromised targets that are no longer valid
            this._pruneCompromisedTargets(world);

            // Run state machine
            switch (this._state) {
                case STATE_IDLE:
                    this._tickIdle(dt, world);
                    break;
                case STATE_SCANNING:
                    this._tickScanning(dt, world);
                    break;
                case STATE_TARGETING:
                    this._tickTargeting(dt, world);
                    break;
                case STATE_EXPLOITING:
                    this._tickExploiting(dt, world);
                    break;
                case STATE_ACTIVE:
                    this._tickActive(dt, world);
                    break;
                case STATE_COOLDOWN:
                    this._tickCooldown(dt, world);
                    break;
                default:
                    this._state = STATE_IDLE;
                    break;
            }

            // Sync state outputs
            state._cyberOpsState    = this._state;
            state._cyberOpsTarget   = this._currentTargetId;
            state._cyberOpsCompromisedTargets = this._compromisedTargets.slice();
        }

        // -------------------------------------------------------------------
        // State machine ticks
        // -------------------------------------------------------------------

        /**
         * IDLE: Wait briefly then begin scanning. Aggressiveness shortens the wait.
         */
        _tickIdle(dt, world) {
            this._scanTimer += dt;
            // Idle wait is half the scan interval, reduced by aggressiveness
            var idleWait = (this._scanInterval * 0.5) * (1 - this._aggressiveness * 0.5);
            if (this._scanTimer >= idleWait) {
                this._scanTimer = 0;
                this._state = STATE_SCANNING;
                this._currentTargetId = null;
                this.entity.state._cyberOpsProgress = 0;
            }
        }

        /**
         * SCANNING: Scan for opposing-team entities and score them.
         * Duration is shortened by aggressiveness.
         */
        _tickScanning(dt, world) {
            this._scanTimer += dt;
            var effectiveScanInterval = this._scanInterval * (1 - this._aggressiveness * 0.3);

            if (this._scanTimer >= effectiveScanInterval) {
                this._scanTimer = 0;

                // Build candidate list
                this._scanForTargets(world);

                if (this._candidates.length > 0) {
                    this._state = STATE_TARGETING;
                } else {
                    // Nothing found -- go back to idle
                    this._state = STATE_IDLE;
                }
            }
        }

        /**
         * TARGETING: Select best target from candidates and prepare exploit.
         * This is an instantaneous transition state.
         */
        _tickTargeting(dt, world) {
            // Already at max simultaneous compromised targets?
            if (this._compromisedTargets.length >= this._maxSimultaneous) {
                this._state = STATE_ACTIVE;
                this._currentTargetId = null;
                return;
            }

            // Pick the best candidate
            var bestCandidate = null;
            for (var i = 0; i < this._candidates.length; i++) {
                var cand = this._candidates[i];

                // Skip already compromised
                if (this._compromisedTargets.indexOf(cand.entityId) >= 0) continue;

                // Skip already being exploited
                if (this._currentTargetId === cand.entityId) continue;

                bestCandidate = cand;
                break; // candidates are sorted by score descending
            }

            if (!bestCandidate) {
                // No valid target -- if we have compromised targets, stay active
                if (this._compromisedTargets.length > 0) {
                    this._state = STATE_ACTIVE;
                } else {
                    this._state = STATE_IDLE;
                }
                this._currentTargetId = null;
                return;
            }

            // Set current target and compute exploit parameters
            this._currentTargetId = bestCandidate.entityId;

            // Compute exploit duration based on target hardening
            var targetEntity = world.getEntity(this._currentTargetId);
            var targetHardening = 0;
            var targetVulnerability = 0.5;

            if (targetEntity) {
                var computerComp = targetEntity.getComponent
                    ? targetEntity.getComponent('cyber') || targetEntity.getComponent('cyber/computer')
                    : null;

                // Try to get computer component by checking components map directly
                if (!computerComp && targetEntity.components) {
                    var compMap = targetEntity.components;
                    if (compMap.has && compMap.has('cyber/computer')) {
                        computerComp = compMap.get('cyber/computer');
                    } else if (compMap['cyber/computer']) {
                        computerComp = compMap['cyber/computer'];
                    } else if (compMap['cyber']) {
                        computerComp = compMap['cyber'];
                    }
                }

                if (computerComp) {
                    if (typeof computerComp.getVulnerability === 'function') {
                        targetVulnerability = computerComp.getVulnerability();
                    }
                    if (computerComp._hardening !== undefined) {
                        targetHardening = computerComp._hardening;
                    }
                } else {
                    // No computer component -- use state values if present
                    var ts = targetEntity.state;
                    if (ts._computerHardening !== undefined) {
                        targetHardening = ts._computerHardening;
                    }
                    // Estimate vulnerability from hardening and patch level
                    if (ts._computerPatchLevel !== undefined) {
                        targetVulnerability = 0.3 * (1 - ts._computerPatchLevel) * (1 - targetHardening * 0.5);
                        targetVulnerability = Math.max(0.05, Math.min(0.95, targetVulnerability));
                    }
                }

                // Check firewall -- adds difficulty
                var firewallDifficulty = 0;
                var fs = targetEntity.state;
                if (fs._firewallActive && !fs._firewallBypassed) {
                    firewallDifficulty = (fs._firewallHealth || 1.0) * (fs._firewallRating || 0.5);
                }

                // Compute exploit duration: base * (1 + hardening/10) * (1 + firewall difficulty)
                // Aggressiveness reduces duration
                this._exploitDuration = this._baseExploitTime *
                    (1 + targetHardening / 10) *
                    (1 + firewallDifficulty * 0.5) *
                    (1 - this._aggressiveness * 0.3);
                this._exploitDuration = Math.max(3, this._exploitDuration);

                // Pre-determine success: baseProbability * vulnerability * (1 - firewallDifficulty * 0.3)
                var successChance = this._baseProbability * targetVulnerability *
                    (1 - firewallDifficulty * 0.3);
                successChance = Math.max(0.05, Math.min(0.95, successChance));

                // Stealth affects detection chance, not success -- but low stealth
                // with active IDS reduces success slightly
                if (fs._firewallIDS && this._stealthLevel < 0.5) {
                    successChance *= (0.5 + this._stealthLevel);
                }

                this._exploitSuccess = getRandom(world) < successChance;
            } else {
                // Target not found -- go idle
                this._state = STATE_IDLE;
                this._currentTargetId = null;
                return;
            }

            // Begin exploit phase
            this._exploitTimer = 0;
            this._state = STATE_EXPLOITING;
        }

        /**
         * EXPLOITING: Running the exploit against the target. Progress 0-1.
         */
        _tickExploiting(dt, world) {
            this._exploitTimer += dt;

            // Update progress
            var progress = Math.min(1, this._exploitTimer / this._exploitDuration);
            this.entity.state._cyberOpsProgress = progress;

            // Check if target is still valid
            var target = this._currentTargetId ? world.getEntity(this._currentTargetId) : null;
            if (!target || !target.active || target.state._destroyed) {
                // Target lost -- go to cooldown
                this._currentTargetId = null;
                this.entity.state._cyberOpsProgress = 0;
                this._state = STATE_COOLDOWN;
                this._cooldownTimer = 0;
                return;
            }

            // Detection chance each tick while exploiting (based on stealth)
            // Only checked once per second to avoid excessive rolling
            if (this._exploitTimer > 1 && Math.floor(this._exploitTimer) !== Math.floor(this._exploitTimer - dt)) {
                var detectChance = (1 - this._stealthLevel) * 0.1; // up to 10% per second at stealth=0
                if (target.state._firewallIDS) {
                    detectChance *= 1.5; // IDS increases detection rate
                }
                if (getRandom(world) < detectChance) {
                    // Detected! Set alert on target and abort
                    target.state._cyberAttackDetected = true;
                    target.state._cyberAttackType = 'exploit';
                    target.state._cyberAttackerId = this.entity.id;

                    this._currentTargetId = null;
                    this.entity.state._cyberOpsProgress = 0;
                    this._state = STATE_COOLDOWN;
                    this._cooldownTimer = 0;
                    return;
                }
            }

            // Exploit complete?
            if (this._exploitTimer >= this._exploitDuration) {
                this.entity.state._cyberOpsProgress = 1;

                if (this._exploitSuccess) {
                    // Success -- apply effects to target
                    this._applyExploit(target, world);
                    this._compromisedTargets.push(this._currentTargetId);

                    // Notify CommEngine
                    this._notifyCommEngine('exploit', this._currentTargetId, true);
                }

                // Transition: if we can attack more targets, go to cooldown then scan
                // Otherwise go to active (maintaining compromised targets)
                if (this._compromisedTargets.length < this._maxSimultaneous) {
                    this._state = STATE_COOLDOWN;
                    this._cooldownTimer = 0;
                } else {
                    this._state = STATE_ACTIVE;
                }

                this._currentTargetId = null;
            }
        }

        /**
         * ACTIVE: Maintaining compromised targets. Periodically re-scan for new
         * targets if we have capacity.
         */
        _tickActive(dt, world) {
            this._scanTimer += dt;

            // Maintain effects on compromised targets
            this._maintainEffects(dt, world);

            // Attempt lateral movement from compromised nodes
            if (this._lateralMovement) {
                this._tickLateralMovement(dt, world);
            }

            // Data exfiltration from compromised targets
            this._tickDataExfiltration(dt, world);

            // If we have capacity, periodically scan for new targets
            if (this._compromisedTargets.length < this._maxSimultaneous) {
                var rescanInterval = this._scanInterval * (1 - this._aggressiveness * 0.3);
                if (this._scanTimer >= rescanInterval) {
                    this._scanTimer = 0;
                    this._state = STATE_SCANNING;
                }
            }

            // If all compromised targets were lost, go back to scanning
            if (this._compromisedTargets.length === 0) {
                this._scanTimer = 0;
                this._state = STATE_SCANNING;
            }
        }

        /**
         * COOLDOWN: Waiting between attacks. Duration shortened by aggressiveness.
         */
        _tickCooldown(dt, world) {
            this._cooldownTimer += dt;

            // Maintain effects on any already-compromised targets
            this._maintainEffects(dt, world);

            var effectiveCooldown = this._cooldownTime * (1 - this._aggressiveness * 0.4);
            effectiveCooldown = Math.max(2, effectiveCooldown);

            if (this._cooldownTimer >= effectiveCooldown) {
                this._cooldownTimer = 0;
                this._scanTimer = 0;
                this._state = STATE_SCANNING;
            }
        }

        // -------------------------------------------------------------------
        // Scanning
        // -------------------------------------------------------------------

        /**
         * Scan all entities in the world for valid cyber targets on opposing team.
         * Builds a sorted (by score descending) candidate list.
         */
        _scanForTargets(world) {
            var self = this;
            var entity = this.entity;
            var myTeam = entity.team;
            var myState = entity.state;
            var candidates = [];

            world.entities.forEach(function(other) {
                // Skip self
                if (other.id === entity.id) return;

                // Skip same team
                if (other.team === myTeam) return;

                // Skip inactive or destroyed
                if (!other.active) return;
                if (other.state._destroyed) return;

                // Skip already compromised
                if (self._compromisedTargets.indexOf(other.id) >= 0) return;

                // Skip entities already under full control
                if (other.state._fullControl) return;

                // Skip entities that have already been compromised by someone
                if (other.state._computerCompromised) return;

                // Score the target
                var score = scoreTarget(other, myState);

                candidates.push({
                    entityId: other.id,
                    score: score
                });
            });

            // Sort by score descending (highest value first)
            candidates.sort(function(a, b) { return b.score - a.score; });

            this._candidates = candidates;
        }

        // -------------------------------------------------------------------
        // Exploit application
        // -------------------------------------------------------------------

        /**
         * Apply the exploit effects to a target entity based on preferredAttack.
         * Uses graduated degradation: initial exploit sets degradation to 0.5
         * (partial compromise). _maintainEffects() increments degradation by
         * 0.02*dt each tick until it reaches 1.0, then full-disable flags are set.
         */
        _applyExploit(targetEntity, world) {
            if (!targetEntity || !targetEntity.state) return;

            var ts = targetEntity.state;

            // Mark the computer as compromised
            ts._computerCompromised = true;
            ts._computerAccessLevel = 'ROOT';
            ts._cyberExploited = true;

            // Initialize degradation object on target if not present
            if (!ts._cyberDegradation) {
                ts._cyberDegradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };
            }

            // Mark hacked subsystems and set initial 0.5 degradation (partial compromise)
            switch (this._preferredAttack) {
                case 'sensors':
                    if (ts._computerHackedSubsystems) {
                        ts._computerHackedSubsystems.sensors = true;
                    }
                    ts._cyberDegradation.sensors = Math.max(ts._cyberDegradation.sensors, 0.5);
                    break;

                case 'navigation':
                    if (ts._computerHackedSubsystems) {
                        ts._computerHackedSubsystems.navigation = true;
                    }
                    ts._cyberDegradation.navigation = Math.max(ts._cyberDegradation.navigation, 0.5);
                    break;

                case 'weapons':
                    if (ts._computerHackedSubsystems) {
                        ts._computerHackedSubsystems.weapons = true;
                    }
                    ts._cyberDegradation.weapons = Math.max(ts._cyberDegradation.weapons, 0.5);
                    break;

                case 'comms':
                    if (ts._computerHackedSubsystems) {
                        ts._computerHackedSubsystems.comms = true;
                    }
                    ts._cyberDegradation.comms = Math.max(ts._cyberDegradation.comms, 0.5);
                    break;

                case 'all':
                    if (ts._computerHackedSubsystems) {
                        ts._computerHackedSubsystems.sensors    = true;
                        ts._computerHackedSubsystems.navigation = true;
                        ts._computerHackedSubsystems.weapons    = true;
                        ts._computerHackedSubsystems.comms      = true;
                    }
                    ts._cyberDegradation.sensors    = Math.max(ts._cyberDegradation.sensors, 0.5);
                    ts._cyberDegradation.navigation = Math.max(ts._cyberDegradation.navigation, 0.5);
                    ts._cyberDegradation.weapons    = Math.max(ts._cyberDegradation.weapons, 0.5);
                    ts._cyberDegradation.comms      = Math.max(ts._cyberDegradation.comms, 0.5);
                    break;
            }
        }

        /**
         * Maintain ongoing effects on compromised targets.
         * Increments degradation by 0.02*dt (reaches 1.0 in ~25s from 0.5).
         * When degradation reaches 1.0, sets the full-disable flag.
         * @param {number} dt  Sim-time delta in seconds
         * @param {object} world
         */
        _maintainEffects(dt, world) {
            var degradationRate = 0.02; // per second -- reaches 1.0 from 0.5 in 25s

            for (var i = this._compromisedTargets.length - 1; i >= 0; i--) {
                var targetId = this._compromisedTargets[i];
                var target = world.getEntity(targetId);

                if (!target || !target.active || target.state._destroyed) {
                    // Target gone -- remove from list
                    this._compromisedTargets.splice(i, 1);
                    continue;
                }

                // Re-apply compromise flags to keep the exploit active
                var ts = target.state;
                ts._computerCompromised = true;

                // Initialize degradation if missing
                if (!ts._cyberDegradation) {
                    ts._cyberDegradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };
                }

                // Increment degradation and set full-disable when reaching 1.0
                var deg = ts._cyberDegradation;
                var increment = degradationRate * dt;

                switch (this._preferredAttack) {
                    case 'sensors':
                        deg.sensors = Math.min(1, deg.sensors + increment);
                        // Force radar look-away when degradation crosses 0.7
                        if (deg.sensors > 0.7 && !ts._sensorRedirected) {
                            ts._sensorRedirected = true;
                            // Point radar 180° away from attacker's position
                            // (bearing from target to attacker + 180°)
                            var attackerState = this.entity.state;
                            if (ts.lat !== undefined && attackerState.lat !== undefined) {
                                var dLon = attackerState.lon - ts.lon;
                                var y = Math.sin(dLon) * Math.cos(attackerState.lat);
                                var x = Math.cos(ts.lat) * Math.sin(attackerState.lat) -
                                        Math.sin(ts.lat) * Math.cos(attackerState.lat) * Math.cos(dLon);
                                var bearingToAttacker = (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
                                // Force radar to look AWAY from attacker (opposite direction)
                                ts._sensorForcedBearing = (bearingToAttacker + 180) % 360;
                            } else {
                                // No position data — default to 180° offset
                                ts._sensorForcedBearing = 180;
                            }
                        }
                        if (deg.sensors >= 1.0) ts._sensorDisabled = true;
                        break;
                    case 'navigation':
                        deg.navigation = Math.min(1, deg.navigation + increment);
                        if (deg.navigation >= 1.0) {
                            ts._navigationHijacked = true;
                            // Set hijack waypoint — steer target toward attacker's position
                            // or toward a dangerous location (e.g., into SAM coverage)
                            if (!ts._hijackWaypoint) {
                                // Default: steer toward the cyber attacker's position
                                var myNavState = this.entity.state;
                                ts._hijackWaypoint = {
                                    lat: myNavState.lat,  // radians
                                    lon: myNavState.lon,  // radians
                                    alt: 500,             // low altitude — dangerous
                                    speed: 100            // slow — vulnerable
                                };
                            }
                        }
                        break;
                    case 'weapons':
                        deg.weapons = Math.min(1, deg.weapons + increment);
                        if (deg.weapons >= 1.0) ts._weaponsDisabled = true;
                        break;
                    case 'comms':
                        deg.comms = Math.min(1, deg.comms + increment);
                        if (deg.comms >= 1.0) ts._commsDisabled = true;
                        break;
                    case 'all':
                        deg.sensors    = Math.min(1, deg.sensors + increment);
                        deg.navigation = Math.min(1, deg.navigation + increment);
                        deg.weapons    = Math.min(1, deg.weapons + increment);
                        deg.comms      = Math.min(1, deg.comms + increment);
                        // Force radar look-away when sensor degradation crosses 0.7
                        if (deg.sensors > 0.7 && !ts._sensorRedirected) {
                            ts._sensorRedirected = true;
                            var attackerStateAll = this.entity.state;
                            if (ts.lat !== undefined && attackerStateAll.lat !== undefined) {
                                var dLonAll = attackerStateAll.lon - ts.lon;
                                var yAll = Math.sin(dLonAll) * Math.cos(attackerStateAll.lat);
                                var xAll = Math.cos(ts.lat) * Math.sin(attackerStateAll.lat) -
                                           Math.sin(ts.lat) * Math.cos(attackerStateAll.lat) * Math.cos(dLonAll);
                                var bearingAll = (Math.atan2(yAll, xAll) * (180 / Math.PI) + 360) % 360;
                                ts._sensorForcedBearing = (bearingAll + 180) % 360;
                            } else {
                                ts._sensorForcedBearing = 180;
                            }
                        }
                        if (deg.sensors >= 1.0) ts._sensorDisabled = true;
                        if (deg.navigation >= 1.0) {
                            ts._navigationHijacked = true;
                            if (!ts._hijackWaypoint) {
                                var myAllState = this.entity.state;
                                ts._hijackWaypoint = {
                                    lat: myAllState.lat,
                                    lon: myAllState.lon,
                                    alt: 500,
                                    speed: 100
                                };
                            }
                        }
                        if (deg.weapons >= 1.0) ts._weaponsDisabled = true;
                        if (deg.comms >= 1.0) ts._commsDisabled = true;
                        // Full control only when ALL subsystems at 1.0
                        if (deg.sensors >= 1.0 && deg.navigation >= 1.0 &&
                            deg.weapons >= 1.0 && deg.comms >= 1.0) {
                            ts._fullControl = true;
                        }
                        break;
                }
            }
        }

        // -------------------------------------------------------------------
        // Lateral movement
        // -------------------------------------------------------------------

        /**
         * Attempt to pivot from compromised nodes to other entities connected
         * via comm networks.  Checked every 15 seconds (reduced by aggressiveness).
         * Lateral exploits are easier: vulnerability * 1.5, firewall difficulty * 0.5.
         * Total compromised targets are capped at _maxSimultaneous + 2.
         */
        _tickLateralMovement(dt, world) {
            this._lateralTimer += dt;

            // Check interval: 15s base, shortened by aggressiveness
            var lateralInterval = 15 * (1 - this._aggressiveness * 0.4);
            lateralInterval = Math.max(3, lateralInterval);

            if (this._lateralTimer < lateralInterval) return;
            this._lateralTimer = 0;

            // Cap: max compromised via all paths
            var maxTotal = this._maxSimultaneous + 2;
            if (this._compromisedTargets.length >= maxTotal) return;

            // For each compromised target, find network peers
            // Iterate over a copy because we may push to _compromisedTargets
            var compromisedSnapshot = this._compromisedTargets.slice();
            var myTeam = this.entity.team;

            for (var ci = 0; ci < compromisedSnapshot.length; ci++) {
                if (this._compromisedTargets.length >= maxTotal) break;

                var compromisedId = compromisedSnapshot[ci];
                var compromisedEntity = world.getEntity(compromisedId);
                if (!compromisedEntity || !compromisedEntity.active) continue;

                var peers = this._findNetworkPeers(compromisedId, world);

                for (var pi = 0; pi < peers.length; pi++) {
                    if (this._compromisedTargets.length >= maxTotal) break;

                    var peerId = peers[pi];

                    // Skip if already compromised by us
                    if (this._compromisedTargets.indexOf(peerId) >= 0) continue;

                    // Skip if already attempted via lateral
                    if (this._lateralTargets.indexOf(peerId) >= 0) continue;

                    var peerEntity = world.getEntity(peerId);
                    if (!peerEntity || !peerEntity.active || peerEntity.state._destroyed) continue;

                    // Skip same team as attacker
                    if (peerEntity.team === myTeam) continue;

                    // Skip already fully controlled
                    if (peerEntity.state._fullControl) continue;

                    // Mark as attempted regardless of outcome
                    this._lateralTargets.push(peerId);

                    // --- Compute lateral exploit success ---

                    // Read target vulnerability
                    var targetVulnerability = 0.5;
                    var targetHardening = 0;
                    var computerComp = peerEntity.getComponent
                        ? peerEntity.getComponent('cyber') || peerEntity.getComponent('cyber/computer')
                        : null;

                    if (!computerComp && peerEntity.components) {
                        var compMap = peerEntity.components;
                        if (compMap.has && compMap.has('cyber/computer')) {
                            computerComp = compMap.get('cyber/computer');
                        } else if (compMap['cyber/computer']) {
                            computerComp = compMap['cyber/computer'];
                        } else if (compMap['cyber']) {
                            computerComp = compMap['cyber'];
                        }
                    }

                    if (computerComp) {
                        if (typeof computerComp.getVulnerability === 'function') {
                            targetVulnerability = computerComp.getVulnerability();
                        }
                        if (computerComp._hardening !== undefined) {
                            targetHardening = computerComp._hardening;
                        }
                    } else {
                        var ps = peerEntity.state;
                        if (ps._computerHardening !== undefined) {
                            targetHardening = ps._computerHardening;
                        }
                        if (ps._computerPatchLevel !== undefined) {
                            targetVulnerability = 0.3 * (1 - ps._computerPatchLevel) * (1 - targetHardening * 0.5);
                            targetVulnerability = Math.max(0.05, Math.min(0.95, targetVulnerability));
                        }
                    }

                    // Lateral exploit is EASIER: multiply vulnerability by 1.5
                    targetVulnerability = Math.min(0.95, targetVulnerability * 1.5);

                    // Firewall difficulty reduced by 50% (pivoting from trusted node)
                    var firewallDifficulty = 0;
                    var peerState = peerEntity.state;
                    if (peerState._firewallActive && !peerState._firewallBypassed) {
                        firewallDifficulty = (peerState._firewallHealth || 1.0) *
                            (peerState._firewallRating || 0.5) * 0.5;
                    }

                    // Success chance
                    var successChance = this._baseProbability * targetVulnerability *
                        (1 - firewallDifficulty * 0.3);
                    successChance = Math.max(0.05, Math.min(0.95, successChance));

                    // IDS penalty
                    if (peerState._firewallIDS && this._stealthLevel < 0.5) {
                        successChance *= (0.5 + this._stealthLevel);
                    }

                    // Roll
                    if (getRandom(world) < successChance) {
                        // Lateral exploit succeeded
                        this._applyExploit(peerEntity, world);
                        this._compromisedTargets.push(peerId);

                        // Set lateral spread tracking flags
                        peerState._cyberLateralSource = compromisedId;
                        peerState._cyberLateralSpread = true;

                        // Notify CommEngine
                        this._notifyCommEngine('exploit', peerId, true);
                    }
                }
            }
        }

        // -------------------------------------------------------------------
        // Data exfiltration
        // -------------------------------------------------------------------

        /**
         * Attempt data exfiltration from compromised targets.
         * After _exfilDelay seconds of compromise, begins extracting data.
         * Progress increments over _exfilDuration seconds (0 to 1).
         * On completion, sets exfil state flags on both attacker and target.
         */
        _tickDataExfiltration(dt, world) {
            for (var i = 0; i < this._compromisedTargets.length; i++) {
                var targetId = this._compromisedTargets[i];

                // Skip targets already fully exfiltrated
                if (this._exfilTargets.has(targetId)) continue;

                var target = world.getEntity(targetId);
                if (!target || !target.active || target.state._destroyed) continue;

                // Initialize timer for this target if not yet tracked
                if (this._exfilTimers[targetId] === undefined) {
                    this._exfilTimers[targetId] = 0;
                }

                this._exfilTimers[targetId] += dt;

                // Wait for delay before starting exfil
                if (this._exfilTimers[targetId] < this._exfilDelay) continue;

                // Compute exfil progress (0 to 1) over _exfilDuration after the delay
                var elapsed = this._exfilTimers[targetId] - this._exfilDelay;
                var progress = Math.min(1, elapsed / this._exfilDuration);

                // Set progress flag on target
                target.state._dataExfiltrated = (progress > 0);
                target.state._exfilProgress = progress;

                // Exfiltration complete
                if (progress >= 1) {
                    this._exfilTargets.add(targetId);

                    // Mark target as fully exfiltrated
                    target.state._dataExfiltrated = true;
                    target.state._exfilProgress = 1.0;
                    target.state._cyberIntelExfiltrated = true;

                    // Set attacker-side exfiltration data
                    var myState = this.entity.state;
                    if (!myState._exfilData) {
                        myState._exfilData = { radar: [], nav: [], comms: [] };
                    }
                    if (myState._exfilData.radar.indexOf(targetId) < 0) {
                        myState._exfilData.radar.push(targetId);
                    }
                    if (myState._exfilData.nav.indexOf(targetId) < 0) {
                        myState._exfilData.nav.push(targetId);
                    }
                    if (myState._exfilData.comms.indexOf(targetId) < 0) {
                        myState._exfilData.comms.push(targetId);
                    }
                }
            }
        }

        /**
         * Find entity IDs connected to the given entity via comm networks.
         * Checks CommEngine.getNodeLinks() first, then world._networks.
         * @param {string} entityId
         * @param {object} world
         * @returns {string[]} array of peer entity IDs (not including entityId)
         */
        _findNetworkPeers(entityId, world) {
            var peers = [];
            var seen = {};

            // Strategy 1: CommEngine global IIFE
            if (typeof CommEngine !== 'undefined' && typeof CommEngine.getNodeLinks === 'function') {
                try {
                    var links = CommEngine.getNodeLinks(entityId);
                    if (links && Array.isArray(links)) {
                        for (var li = 0; li < links.length; li++) {
                            var link = links[li];
                            // A link typically references another node/entity
                            var peerId = (link.targetId || link.nodeId || link.id || link);
                            if (typeof peerId === 'string' && peerId !== entityId && !seen[peerId]) {
                                seen[peerId] = true;
                                peers.push(peerId);
                            }
                        }
                    }
                } catch (e) {
                    // CommEngine error -- fall through to world._networks
                }
            }

            // Strategy 2: world._networks array from scenario config
            if (world._networks && Array.isArray(world._networks)) {
                for (var ni = 0; ni < world._networks.length; ni++) {
                    var network = world._networks[ni];
                    var members = network.members || network.nodes || network.entities || [];

                    // Check if the compromised entity is a member of this network
                    var isMember = false;
                    for (var mi = 0; mi < members.length; mi++) {
                        var memberId = (typeof members[mi] === 'string') ? members[mi] : (members[mi].id || members[mi].entityId || '');
                        if (memberId === entityId) {
                            isMember = true;
                            break;
                        }
                    }

                    if (isMember) {
                        // All other members are potential lateral targets
                        for (var mj = 0; mj < members.length; mj++) {
                            var pId = (typeof members[mj] === 'string') ? members[mj] : (members[mj].id || members[mj].entityId || '');
                            if (pId && pId !== entityId && !seen[pId]) {
                                seen[pId] = true;
                                peers.push(pId);
                            }
                        }
                    }
                }
            }

            return peers;
        }

        // -------------------------------------------------------------------
        // Utility
        // -------------------------------------------------------------------

        /**
         * Remove compromised targets that are no longer valid (inactive/destroyed).
         */
        _pruneCompromisedTargets(world) {
            for (var i = this._compromisedTargets.length - 1; i >= 0; i--) {
                var targetId = this._compromisedTargets[i];
                var target = world.getEntity(targetId);
                if (!target || !target.active || target.state._destroyed) {
                    // Clean up CommEngine notification
                    this._notifyCommEngine('exploit', targetId, false);
                    this._compromisedTargets.splice(i, 1);
                }
            }
        }

        /**
         * Notify CommEngine about cyber attack state changes.
         */
        _notifyCommEngine(type, targetId, active) {
            if (typeof CommEngine === 'undefined') return;

            try {
                if (typeof CommEngine.addCyberAttack === 'function') {
                    CommEngine.addCyberAttack({
                        attackerId: this.entity.id,
                        targetId: targetId,
                        type: type,
                        active: !!active
                    });
                }
            } catch (e) {
                // CommEngine error -- silent degradation
            }
        }

        /**
         * Clean up all state and effects on entity removal.
         */
        cleanup(world) {
            // Release all compromised targets
            for (var i = 0; i < this._compromisedTargets.length; i++) {
                var targetId = this._compromisedTargets[i];
                var target = world.getEntity(targetId);
                if (target && target.state) {
                    // Clear the compromise state
                    target.state._computerCompromised = false;
                    target.state._computerAccessLevel = 'NONE';
                    target.state._cyberExploited = false;

                    // Clear lateral spread tracking flags
                    target.state._cyberLateralSource = null;
                    target.state._cyberLateralSpread = false;

                    // Clear subsystem flags we set
                    switch (this._preferredAttack) {
                        case 'sensors':
                            target.state._sensorDisabled = false;
                            target.state._sensorRedirected = false;
                            target.state._sensorForcedBearing = null;
                            target.state._radarForcedLookAway = false;
                            break;
                        case 'navigation':
                            target.state._navigationHijacked = false;
                            break;
                        case 'weapons':
                            target.state._weaponsDisabled = false;
                            break;
                        case 'comms':
                            target.state._commsDisabled = false;
                            break;
                        case 'all':
                            target.state._sensorDisabled     = false;
                            target.state._sensorRedirected   = false;
                            target.state._sensorForcedBearing = null;
                            target.state._radarForcedLookAway = false;
                            target.state._navigationHijacked = false;
                            target.state._weaponsDisabled    = false;
                            target.state._commsDisabled      = false;
                            target.state._fullControl        = false;
                            break;
                    }
                }
                this._notifyCommEngine('exploit', targetId, false);
            }

            this._compromisedTargets = [];
            this._candidates = [];
            this._lateralTargets = [];
            this._lateralTimer = 0;
            this._currentTargetId = null;
            this._state = STATE_IDLE;

            // Clear exfiltration state
            this._exfilTargets = new Set();
            this._exfilTimers = {};

            // Clear entity state
            var state = this.entity.state;
            state._cyberOpsState    = null;
            state._cyberOpsTarget   = null;
            state._cyberOpsProgress = 0;
            state._cyberOpsCompromisedTargets = [];
            state._exfilData = null;
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { name: 'preferredAttack',  type: 'select', label: 'Preferred Attack',
                    options: ['sensors', 'navigation', 'weapons', 'comms', 'all'], default: 'sensors' },
                { name: 'scanInterval',     type: 'number', label: 'Scan Interval (s)',       default: 10,  min: 1,    max: 120 },
                { name: 'baseExploitTime',  type: 'number', label: 'Base Exploit Time (s)',   default: 15,  min: 1,    max: 300 },
                { name: 'baseProbability',  type: 'number', label: 'Base Probability (0-1)',  default: 0.7, min: 0,    max: 1,   step: 0.05 },
                { name: 'cooldownTime',     type: 'number', label: 'Cooldown Time (s)',       default: 20,  min: 1,    max: 120 },
                { name: 'maxSimultaneous',  type: 'number', label: 'Max Simultaneous',        default: 3,   min: 1,    max: 10 },
                { name: 'aggressiveness',   type: 'number', label: 'Aggressiveness (0-1)',    default: 0.5, min: 0,    max: 1,   step: 0.05 },
                { name: 'stealthLevel',     type: 'number', label: 'Stealth Level (0-1)',     default: 0.5, min: 0,    max: 1,   step: 0.05 },
                { name: 'lateralMovement', type: 'checkbox', label: 'Lateral Movement',       default: true }
            ];
        }
    }

    return CyberOpsAIComponent;
})();

ComponentRegistry.register('ai', 'cyber_ops', CyberOpsAI);
