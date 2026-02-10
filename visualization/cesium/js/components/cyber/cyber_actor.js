/**
 * CyberActor component — cyber warfare capability for network attacks.
 *
 * Provides configurable cyber attack capabilities including brick (disable node),
 * MITM (man-in-the-middle), inject (false track data), DDoS (bandwidth flood),
 * and exploit (gain control). Each attack progresses through a state machine:
 * IDLE -> SCANNING -> ACCESSING -> EXPLOITING -> ACTIVE -> (DETECTED -> EVADING).
 *
 * Integrates with CommEngine (if loaded) to apply attack effects on the network.
 * Gracefully degrades when CommEngine is not available by tracking attack state
 * locally and setting entity state flags.
 *
 * Config (from scenario JSON):
 *   type: "cyber_actor"
 *   capabilities: ["brick", "mitm", "inject", "ddos", "exploit"]
 *   attackRange_m: 0            — 0 = unlimited (cyber via network)
 *   accessTime_s: 30            — time to gain initial access
 *   exploitTime_s: 60           — time to deploy exploit after access
 *   persistence: true           — maintain access after exploit
 *   stealthLevel: 0.8           — 0-1, chance of avoiding detection per tick
 *   autoTarget: true            — auto-select targets from enemy network
 *   maxSimultaneous: 2          — max concurrent attacks
 *
 * State outputs on entity.state:
 *   _cyberAttacks       — array of active attacks [{targetId, type, state, progress}]
 *   _cyberCapabilities  — array of available attack types
 *   _cyberActive        — boolean, is currently attacking
 *   _cyberTargets       — array of current target entity IDs
 *
 * Attack Types:
 *   brick   — Disable a network node. All links through it die.
 *   mitm    — Man-in-the-Middle: intercept and potentially modify traffic.
 *   inject  — Inject false track data or commands into the network.
 *   ddos    — Flood target node, reducing effective bandwidth to near-zero.
 *   exploit — Gain control of node. Can reroute traffic, disable encryption.
 *
 * Registers as: cyber/cyber_actor
 */
(function() {
    'use strict';

    // --- Attack state machine states ---
    var STATE_IDLE       = 'IDLE';
    var STATE_SCANNING   = 'SCANNING';
    var STATE_ACCESSING  = 'ACCESSING';
    var STATE_EXPLOITING = 'EXPLOITING';
    var STATE_ACTIVE     = 'ACTIVE';
    var STATE_DETECTED   = 'DETECTED';
    var STATE_EVADING    = 'EVADING';

    // --- Fixed timing ---
    var SCAN_DURATION     = 5.0;    // Seconds to scan for vulnerabilities
    var DETECT_COOLDOWN   = 10.0;   // Seconds in DETECTED before evading
    var EVADE_DURATION    = 8.0;    // Seconds to evade after detection
    var REBOOT_TIME       = 60.0;   // Seconds for bricked node to reboot
    var INJECT_INTERVAL   = 2.0;    // Seconds between fake packet injections
    var NODE_DETECT_DELAY = 5.0;    // Seconds for adjacent nodes to detect link loss
    var HEAL_REROUTE_TIME = 3.0;    // Seconds for mesh networks to reroute

    // --- Update throttle ---
    var UPDATE_INTERVAL   = 1.0;    // Process cyber attacks at 1Hz

    // --- Target value priorities (higher = more valuable) ---
    var TARGET_VALUE = {
        'command':   100,
        'control':   90,
        'awacs':     85,
        'ground_station': 80,
        'sensor':    70,
        'radar':     65,
        'sam':       60,
        'fighter':   50,
        'aircraft':  40,
        'satellite': 35,
        'ground':    20,
        'generic':   10
    };

    /**
     * Get a random number using world.rng if available, otherwise Math.random().
     */
    function getRandom(world) {
        if (world && world.rng && typeof world.rng.random === 'function') {
            return world.rng.random();
        }
        return Math.random();
    }

    /**
     * Get a deterministic boolean (Bernoulli trial) from rng.
     */
    function bernoulli(world, probability) {
        return getRandom(world) < probability;
    }

    /**
     * Compute target value score for prioritization.
     * Higher value = more attractive target.
     */
    function getTargetValue(entity) {
        if (!entity) return 0;
        var type = (entity.type || 'generic').toLowerCase();

        // Check for command-related entities
        var name = (entity.name || '').toLowerCase();
        if (name.indexOf('command') >= 0 || name.indexOf('c2') >= 0) return TARGET_VALUE.command;
        if (name.indexOf('awacs') >= 0 || name.indexOf('e-3') >= 0) return TARGET_VALUE.awacs;

        // Check components for more specific categorization
        if (entity.getComponent && entity.getComponent('sensors')) {
            var weapComp = entity.getComponent('weapons');
            if (weapComp) return TARGET_VALUE.sam;
            return TARGET_VALUE.sensor;
        }

        return TARGET_VALUE[type] || TARGET_VALUE.generic;
    }

    /**
     * Generate a fake track injection packet.
     */
    function generateFakeTrack(targetEntity, commandNodeId, simTime) {
        if (!targetEntity || !targetEntity.state) return null;

        var ts = targetEntity.state;
        var lat = ts.lat || 0;
        var lon = ts.lon || 0;

        return {
            type: 'track',
            sourceId: targetEntity.id,          // spoofed source
            destId: commandNodeId,
            data: {
                tracks: [{
                    targetId: 'fake_' + Math.floor(Math.random() * 100000),
                    lat: lat + (Math.random() - 0.5) * 0.01,
                    lon: lon + (Math.random() - 0.5) * 0.01,
                    alt: ts.alt || 0,
                    speed: ts.speed || 0,
                    heading: Math.random() * 360,
                    rcs: 10,
                    time: simTime,
                    _spoofed: true
                }]
            },
            priority: 8,
            _injected: true
        };
    }

    // -----------------------------------------------------------------------
    // CyberActor Component
    // -----------------------------------------------------------------------
    class CyberActor extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._capabilities    = config.capabilities || ['brick', 'mitm', 'inject', 'ddos', 'exploit'];
            this._attackRange     = config.attackRange_m !== undefined ? config.attackRange_m : 0;
            this._accessTime      = config.accessTime_s !== undefined ? config.accessTime_s : 30;
            this._exploitTime     = config.exploitTime_s !== undefined ? config.exploitTime_s : 60;
            this._persistence     = config.persistence !== false;
            this._stealthLevel    = config.stealthLevel !== undefined ? config.stealthLevel : 0.8;
            this._autoTarget      = config.autoTarget !== false;
            this._maxSimultaneous = config.maxSimultaneous !== undefined ? config.maxSimultaneous : 2;

            // Runtime state
            this._attacks         = [];     // Active attack objects
            this._attackHistory   = [];     // Completed/detected attacks log
            this._updateAccum     = 0;
            this._registeredWithCE = false;

            // Reboot tracking for bricked nodes
            this._rebootTimers    = {};     // targetId -> remaining reboot time
        }

        init(world) {
            var state = this.entity.state;

            // Initialize state outputs
            state._cyberAttacks      = [];
            state._cyberCapabilities = this._capabilities.slice();
            state._cyberActive       = false;
            state._cyberTargets      = [];
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;

            var state = entity.state;

            // Throttle to 1Hz
            this._updateAccum += dt;
            if (this._updateAccum < UPDATE_INTERVAL) {
                // Still update reboot timers every tick
                this._updateRebootTimers(dt, world);
                return;
            }

            var tickDt = this._updateAccum;
            this._updateAccum = 0;

            // --- Auto-target selection ---
            if (this._autoTarget && this._attacks.length < this._maxSimultaneous) {
                this._selectTargets(world);
            }

            // --- Process manual attack requests ---
            if (state._cyberAttackRequest) {
                this._handleAttackRequest(state._cyberAttackRequest, world);
                state._cyberAttackRequest = null;
            }

            // --- Advance attack state machines ---
            this._processAttacks(tickDt, world);

            // --- Update reboot timers ---
            this._updateRebootTimers(tickDt, world);

            // --- Sync state outputs ---
            state._cyberActive = this._attacks.length > 0;
            state._cyberTargets = [];
            state._cyberAttacks = [];

            for (var i = 0; i < this._attacks.length; i++) {
                var atk = this._attacks[i];
                state._cyberTargets.push(atk.targetId);
                state._cyberAttacks.push({
                    targetId: atk.targetId,
                    type: atk.type,
                    state: atk.state,
                    progress: this._computeProgress(atk)
                });
            }
        }

        // -------------------------------------------------------------------
        // Auto-target selection
        // -------------------------------------------------------------------
        _selectTargets(world) {
            var entity = this.entity;
            var myTeam = entity.team;
            var slotsAvailable = this._maxSimultaneous - this._attacks.length;
            if (slotsAvailable <= 0) return;

            // Build candidate list from enemy entities
            var candidates = [];
            var self = this;

            world.entities.forEach(function(target) {
                if (target.id === entity.id) return;
                if (!target.active) return;
                if (target.team === myTeam) return;

                // Skip if already being attacked
                if (self._isTargetAttacked(target.id)) return;

                // Range check (0 = unlimited range, cyber via network)
                if (self._attackRange > 0) {
                    var myState = entity.state;
                    var tState = target.state;
                    if (myState.lat === undefined || tState.lat === undefined) return;

                    var dLat = tState.lat - myState.lat;
                    var dLon = tState.lon - myState.lon;
                    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(myState.lat) * Math.cos(tState.lat) *
                            Math.sin(dLon / 2) * Math.sin(dLon / 2);
                    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                    var dist = FrameworkConstants.R_EARTH * c;
                    if (dist > self._attackRange) return;
                }

                // Check if target is a network node (has comm-related state)
                var isNetworkNode = target.state._commLinks ||
                                    target.state._commNetworks ||
                                    target.getComponent && (
                                        target.getComponent('sensors') ||
                                        target.getComponent('weapons')
                                    );

                if (!isNetworkNode) return;

                candidates.push({
                    entity: target,
                    value: getTargetValue(target)
                });
            });

            // Sort by value (highest first)
            candidates.sort(function(a, b) { return b.value - a.value; });

            // Select top candidates up to available slots
            for (var i = 0; i < Math.min(slotsAvailable, candidates.length); i++) {
                var candidate = candidates[i];
                var attackType = this._selectAttackType(candidate.entity);
                if (attackType) {
                    this._beginAttack(candidate.entity.id, attackType, world);
                }
            }
        }

        /**
         * Select the best attack type for a given target based on capabilities.
         * Prioritizes exploit > mitm > inject > ddos > brick.
         */
        _selectAttackType(targetEntity) {
            var prefs = ['exploit', 'mitm', 'inject', 'ddos', 'brick'];
            for (var i = 0; i < prefs.length; i++) {
                if (this._capabilities.indexOf(prefs[i]) >= 0) {
                    return prefs[i];
                }
            }
            return null;
        }

        /**
         * Handle a manual attack request from state._cyberAttackRequest.
         * Expected format: {targetId, type}
         */
        _handleAttackRequest(request, world) {
            if (!request.targetId || !request.type) return;
            if (this._capabilities.indexOf(request.type) < 0) return;
            if (this._attacks.length >= this._maxSimultaneous) return;
            if (this._isTargetAttacked(request.targetId)) return;

            this._beginAttack(request.targetId, request.type, world);
        }

        // -------------------------------------------------------------------
        // Attack lifecycle
        // -------------------------------------------------------------------

        /**
         * Begin a new attack against a target.
         */
        _beginAttack(targetId, attackType, world) {
            var attack = {
                targetId: targetId,
                type: attackType,
                state: STATE_SCANNING,
                timeInState: 0,
                totalTime: 0,
                detectedCount: 0,
                reaccessing: false,     // true when re-accessing after reboot (persistence)
                _injectTimer: 0,        // timer for inject packet generation
                _commandNodeId: null    // cached command node for inject attacks
            };

            this._attacks.push(attack);
        }

        /**
         * Process all active attacks through their state machines.
         */
        _processAttacks(dt, world) {
            var i = this._attacks.length;
            while (i--) {
                var atk = this._attacks[i];
                atk.timeInState += dt;
                atk.totalTime += dt;

                // Verify target still exists
                var target = world.getEntity(atk.targetId);
                if (!target || !target.active) {
                    this._removeAttack(i, world);
                    continue;
                }

                switch (atk.state) {
                    case STATE_SCANNING:
                        this._processScan(atk, dt, world);
                        break;
                    case STATE_ACCESSING:
                        this._processAccess(atk, dt, world);
                        break;
                    case STATE_EXPLOITING:
                        this._processExploit(atk, dt, world);
                        break;
                    case STATE_ACTIVE:
                        this._processActive(atk, dt, target, world);
                        break;
                    case STATE_DETECTED:
                        this._processDetected(atk, dt, target, world);
                        break;
                    case STATE_EVADING:
                        this._processEvading(atk, dt, world);
                        break;
                    default:
                        break;
                }
            }
        }

        /**
         * SCANNING: Identify target vulnerabilities.
         */
        _processScan(atk, dt, world) {
            if (atk.timeInState >= SCAN_DURATION) {
                atk.state = STATE_ACCESSING;
                atk.timeInState = 0;
            }
        }

        /**
         * ACCESSING: Gain network access to the target.
         */
        _processAccess(atk, dt, world) {
            var accessDuration = atk.reaccessing
                ? this._accessTime * 0.5   // persistence: faster re-access
                : this._accessTime;

            if (atk.timeInState >= accessDuration) {
                atk.state = STATE_EXPLOITING;
                atk.timeInState = 0;
                atk.reaccessing = false;
            }
        }

        /**
         * EXPLOITING: Deploy the exploit payload.
         */
        _processExploit(atk, dt, world) {
            if (atk.timeInState >= this._exploitTime) {
                atk.state = STATE_ACTIVE;
                atk.timeInState = 0;
                this._applyAttackEffect(atk, world);
            }
        }

        /**
         * ACTIVE: Attack effect is applied. Check for detection.
         */
        _processActive(atk, dt, target, world) {
            // Apply ongoing effects
            this._maintainAttackEffect(atk, dt, target, world);

            // Detection check: each tick, roll against stealth level
            if (!bernoulli(world, this._stealthLevel)) {
                atk.state = STATE_DETECTED;
                atk.timeInState = 0;
                atk.detectedCount++;

                // Target entity becomes aware of the attack
                if (target.state) {
                    target.state._cyberAttackDetected = true;
                    target.state._cyberAttackType = atk.type;
                    target.state._cyberAttackerId = this.entity.id;
                }

                this._logAttackEvent(atk, 'DETECTED', world);
            }
        }

        /**
         * DETECTED: Target is countering. Attacker can try to evade.
         */
        _processDetected(atk, dt, target, world) {
            if (atk.timeInState >= DETECT_COOLDOWN) {
                // Target initiates countermeasures
                this._removeAttackEffect(atk, world);

                if (this._persistence && atk.detectedCount <= 3) {
                    // Persistent attacker goes to EVADING then re-accesses
                    atk.state = STATE_EVADING;
                    atk.timeInState = 0;
                } else {
                    // Non-persistent or detected too many times: attack terminated
                    this._logAttackEvent(atk, 'TERMINATED', world);
                    this._removeAttack(this._attacks.indexOf(atk), world);
                }
            }
        }

        /**
         * EVADING: Waiting for countermeasures to subside before re-access.
         */
        _processEvading(atk, dt, world) {
            if (atk.timeInState >= EVADE_DURATION) {
                // Re-start access phase (faster due to persistence)
                atk.state = STATE_ACCESSING;
                atk.timeInState = 0;
                atk.reaccessing = true;
            }
        }

        // -------------------------------------------------------------------
        // Attack effects
        // -------------------------------------------------------------------

        /**
         * Apply the initial attack effect when transitioning to ACTIVE.
         */
        _applyAttackEffect(atk, world) {
            var target = world.getEntity(atk.targetId);
            if (!target) return;

            switch (atk.type) {
                case 'brick':
                    target.state._commBricked = true;
                    target.state._commLinks = [];
                    this._notifyCommEngine('brick', atk.targetId, true);
                    this._logAttackEvent(atk, 'BRICK_APPLIED', world);
                    // Trigger network self-healing detection
                    this._scheduleNetworkHealing(atk.targetId, world);
                    break;

                case 'mitm':
                    target.state._commCyber = {
                        type: 'mitm',
                        attackerId: this.entity.id,
                        intercepting: true
                    };
                    this._notifyCommEngine('mitm', atk.targetId, true);
                    this._logAttackEvent(atk, 'MITM_ACTIVE', world);
                    break;

                case 'inject':
                    target.state._commCyber = {
                        type: 'inject',
                        attackerId: this.entity.id
                    };
                    atk._injectTimer = 0;
                    // Find a command node to send fake data to
                    atk._commandNodeId = this._findCommandNode(target.team, world);
                    this._logAttackEvent(atk, 'INJECT_ACTIVE', world);
                    break;

                case 'ddos':
                    target.state._commCyber = {
                        type: 'ddos',
                        attackerId: this.entity.id,
                        bandwidthReduction: 0.95   // 95% bandwidth reduction
                    };
                    this._notifyCommEngine('ddos', atk.targetId, true);
                    this._logAttackEvent(atk, 'DDOS_ACTIVE', world);
                    break;

                case 'exploit':
                    target.state._commCyber = {
                        type: 'exploit',
                        attackerId: this.entity.id,
                        compromised: true
                    };
                    this._notifyCommEngine('exploit', atk.targetId, true);
                    this._logAttackEvent(atk, 'EXPLOIT_ACTIVE', world);
                    break;
            }
        }

        /**
         * Maintain ongoing attack effects (called each ACTIVE tick).
         */
        _maintainAttackEffect(atk, dt, target, world) {
            switch (atk.type) {
                case 'brick':
                    // Keep node bricked
                    target.state._commBricked = true;
                    target.state._commLinks = [];
                    break;

                case 'inject':
                    // Generate fake track data periodically
                    atk._injectTimer += dt;
                    if (atk._injectTimer >= INJECT_INTERVAL) {
                        atk._injectTimer = 0;
                        var fakePacket = generateFakeTrack(
                            target, atk._commandNodeId, world.simTime
                        );
                        if (fakePacket) {
                            // Store injected packets on the target for other systems to process
                            if (!target.state._cyberInjectedPackets) {
                                target.state._cyberInjectedPackets = [];
                            }
                            target.state._cyberInjectedPackets.push(fakePacket);

                            // Cap stored packets to prevent unbounded growth
                            if (target.state._cyberInjectedPackets.length > 50) {
                                target.state._cyberInjectedPackets.shift();
                            }

                            // Notify CommEngine
                            this._notifyCommEngine('inject', atk.targetId, fakePacket);
                        }
                    }
                    break;

                case 'ddos':
                    // Maintain bandwidth flood
                    if (target.state._commCyber) {
                        target.state._commCyber.bandwidthReduction = 0.95;
                    }
                    break;

                case 'mitm':
                case 'exploit':
                    // Ongoing passive effects — no per-tick action needed
                    break;
            }
        }

        /**
         * Remove attack effects from the target.
         */
        _removeAttackEffect(atk, world) {
            var target = world.getEntity(atk.targetId);
            if (!target) return;

            switch (atk.type) {
                case 'brick':
                    // Start reboot timer instead of immediately un-bricking
                    this._rebootTimers[atk.targetId] = REBOOT_TIME;
                    break;

                case 'mitm':
                case 'inject':
                case 'ddos':
                case 'exploit':
                    target.state._commCyber = null;
                    target.state._cyberAttackDetected = false;
                    this._notifyCommEngine(atk.type, atk.targetId, false);
                    break;
            }
        }

        // -------------------------------------------------------------------
        // Network self-healing
        // -------------------------------------------------------------------

        /**
         * Schedule network healing when a node is bricked.
         * Adjacent nodes detect link loss after NODE_DETECT_DELAY seconds.
         */
        _scheduleNetworkHealing(targetId, world) {
            var target = world.getEntity(targetId);
            if (!target) return;

            // Check network topology for affected nodes
            var networks = target.state._commNetworks || [];

            // Set a flag that network healing systems can read
            target.state._commHealingNeeded = true;
            target.state._commHealingTimestamp = world.simTime;
        }

        /**
         * Update reboot timers for bricked nodes.
         */
        _updateRebootTimers(dt, world) {
            var completedReboots = [];

            for (var targetId in this._rebootTimers) {
                this._rebootTimers[targetId] -= dt;
                if (this._rebootTimers[targetId] <= 0) {
                    completedReboots.push(targetId);
                }
            }

            // Process completed reboots
            for (var i = 0; i < completedReboots.length; i++) {
                var id = completedReboots[i];
                delete this._rebootTimers[id];

                var target = world.getEntity(id);
                if (target && target.state) {
                    target.state._commBricked = false;
                    target.state._commHealingNeeded = false;
                    this._notifyCommEngine('brick', id, false);
                }

                // If persistent, check if we should re-attack
                if (this._persistence) {
                    var existingAttack = this._findAttackByTarget(id);
                    if (existingAttack && existingAttack.state === STATE_ACTIVE) {
                        // Re-apply brick through persistence
                        existingAttack.state = STATE_ACCESSING;
                        existingAttack.timeInState = 0;
                        existingAttack.reaccessing = true;
                    }
                }
            }
        }

        // -------------------------------------------------------------------
        // Utility methods
        // -------------------------------------------------------------------

        /**
         * Check if a target is already under attack.
         */
        _isTargetAttacked(targetId) {
            for (var i = 0; i < this._attacks.length; i++) {
                if (this._attacks[i].targetId === targetId) return true;
            }
            return false;
        }

        /**
         * Find an active attack by target ID.
         */
        _findAttackByTarget(targetId) {
            for (var i = 0; i < this._attacks.length; i++) {
                if (this._attacks[i].targetId === targetId) return this._attacks[i];
            }
            return null;
        }

        /**
         * Find a command/C2 node on the specified team for inject attacks.
         */
        _findCommandNode(team, world) {
            var bestId = null;
            var bestValue = 0;

            world.entities.forEach(function(ent) {
                if (ent.team !== team) return;
                if (!ent.active) return;

                var value = getTargetValue(ent);
                if (value > bestValue) {
                    bestValue = value;
                    bestId = ent.id;
                }
            });

            return bestId;
        }

        /**
         * Compute progress fraction (0-1) for an attack's current state.
         */
        _computeProgress(atk) {
            switch (atk.state) {
                case STATE_SCANNING:
                    return Math.min(1.0, atk.timeInState / SCAN_DURATION);
                case STATE_ACCESSING:
                    var accessDur = atk.reaccessing ? this._accessTime * 0.5 : this._accessTime;
                    return Math.min(1.0, atk.timeInState / accessDur);
                case STATE_EXPLOITING:
                    return Math.min(1.0, atk.timeInState / this._exploitTime);
                case STATE_ACTIVE:
                    return 1.0;
                case STATE_DETECTED:
                    return Math.min(1.0, atk.timeInState / DETECT_COOLDOWN);
                case STATE_EVADING:
                    return Math.min(1.0, atk.timeInState / EVADE_DURATION);
                default:
                    return 0;
            }
        }

        /**
         * Notify CommEngine about attack state changes.
         */
        _notifyCommEngine(attackType, targetId, data) {
            if (typeof CommEngine === 'undefined') return;

            try {
                if (typeof CommEngine.addCyberAttack === 'function') {
                    CommEngine.addCyberAttack({
                        attackerId: this.entity.id,
                        targetId: targetId,
                        type: attackType,
                        active: !!data,
                        data: data
                    });
                }
            } catch (e) {
                // CommEngine error — silent degradation
            }
        }

        /**
         * Log an attack event to history.
         */
        _logAttackEvent(atk, eventType, world) {
            this._attackHistory.push({
                targetId: atk.targetId,
                type: atk.type,
                event: eventType,
                time: world.simTime,
                totalAttackTime: atk.totalTime
            });

            // Cap history length
            if (this._attackHistory.length > 100) {
                this._attackHistory.shift();
            }
        }

        /**
         * Remove an attack from the active list and clean up effects.
         */
        _removeAttack(index, world) {
            if (index < 0 || index >= this._attacks.length) return;

            var atk = this._attacks[index];

            // Remove effects from target if attack was active
            if (atk.state === STATE_ACTIVE) {
                this._removeAttackEffect(atk, world);
            }

            this._attacks.splice(index, 1);
        }

        /**
         * Clean up all attacks and state on entity removal.
         */
        cleanup(world) {
            // Remove all active attack effects
            for (var i = 0; i < this._attacks.length; i++) {
                var atk = this._attacks[i];
                if (atk.state === STATE_ACTIVE) {
                    this._removeAttackEffect(atk, world);
                }
            }

            // Clear reboot timers and un-brick any nodes we bricked
            for (var targetId in this._rebootTimers) {
                var target = world.getEntity(targetId);
                if (target && target.state) {
                    target.state._commBricked = false;
                    target.state._commHealingNeeded = false;
                }
            }

            this._attacks = [];
            this._attackHistory = [];
            this._rebootTimers = {};

            // Clear entity state
            var state = this.entity.state;
            state._cyberAttacks = [];
            state._cyberActive = false;
            state._cyberTargets = [];
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { key: 'capabilities',    label: 'Capabilities',       type: 'text',    default: 'brick,mitm,inject,ddos,exploit' },
                { key: 'attackRange_m',   label: 'Attack Range (m)',   type: 'number',  default: 0,    min: 0,   max: 1000000 },
                { key: 'accessTime_s',    label: 'Access Time (s)',    type: 'number',  default: 30,   min: 1,   max: 300 },
                { key: 'exploitTime_s',   label: 'Exploit Time (s)',   type: 'number',  default: 60,   min: 1,   max: 600 },
                { key: 'persistence',     label: 'Persistence',        type: 'boolean', default: true },
                { key: 'stealthLevel',    label: 'Stealth Level',      type: 'number',  default: 0.8,  min: 0,   max: 1,  step: 0.05 },
                { key: 'autoTarget',      label: 'Auto-Target',        type: 'boolean', default: true },
                { key: 'maxSimultaneous', label: 'Max Simultaneous',   type: 'number',  default: 2,    min: 1,   max: 10 }
            ];
        }
    }

    // Register with framework — 'cyber' is a new category, framework supports arbitrary strings
    ComponentRegistry.register('cyber', 'cyber_actor', CyberActor);
})();
