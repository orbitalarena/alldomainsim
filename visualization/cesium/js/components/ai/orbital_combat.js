/**
 * OrbitalCombatAI — role-based AI for GEO space arena orbital combat.
 *
 * Roles:
 *   "hva"       — High-Value Asset, passive (no maneuvering)
 *   "defender"  — guards assigned HVA, engages enemies within defense radius
 *   "attacker"  — seeks and closes on enemy HVAs for kinetic kill
 *   "escort"    — screens for friendly attackers, engages enemy defenders/sweeps
 *   "sweep"     — hunts enemy attackers and escorts
 *
 * Operates entirely in ECI coordinates. Modifies state._eci_vel IN-PLACE
 * (+=) to preserve the shared array reference with orbital_2body.
 *
 * AI runs BEFORE Physics in system execution order, so velocity changes
 * are picked up by orbital_2body in the same tick.
 *
 * State outputs:
 *   _orbCombatRole   — current role string
 *   _orbCombatState  — 'idle' | 'seeking' | 'closing'
 *   _orbCombatTarget — entity ID of current target (or null)
 *   _kkTargetId      — entity ID for kinetic_kill weapon to read (or null)
 *
 * Headless-safe: no Cesium API calls, no document references.
 *
 * Registered as: ai / orbital_combat
 */
(function() {
    'use strict';

    // -------------------------------------------------------------------
    // OrbitalCombatAI Component
    // -------------------------------------------------------------------
    class OrbitalCombatAI extends ECS.Component {
        constructor(config) {
            super(config);

            this._role          = config.role          || 'attacker';
            this._assignedHvaId = config.assignedHvaId || null;
            this._sensorRange   = config.sensorRange   || 1000000;
            this._defenseRadius = config.defenseRadius || 500000;
            this._maxAccel      = config.maxAccel      || 50.0;
            this._killRange     = config.killRange     || 50000;
            this._scanInterval  = config.scanInterval  || 1.0;

            // Runtime state
            this._scanTimer     = 0;
            this._targets       = [];
            this._currentTarget = null;
            this._friendlyDriftTarget = null;  // cached friendly attacker for escort drift
        }

        init(world) {
            var state = this.entity.state;
            state._orbCombatRole   = this._role;
            state._orbCombatState  = this._role === 'hva' ? 'idle' : 'seeking';
            state._orbCombatTarget = null;
            state._kkTargetId      = null;
        }

        update(dt, world) {
            var state = this.entity.state;

            // Bail if destroyed or inactive
            if (!this.entity.active || state._destroyed) return;

            // HVAs are passive — no AI logic
            if (this._role === 'hva') {
                state._orbCombatState = 'idle';
                return;
            }

            // Periodic sensor sweep
            this._scanTimer += dt;
            if (this._scanTimer >= this._scanInterval) {
                this._scanTimer = 0;
                this._scanForTargets(world);
            }

            // Target selection based on role
            this._selectTarget(dt, world);

            // Act on current target
            if (this._currentTarget !== null) {
                var targetEntity = world.getEntity(this._currentTarget);
                if (targetEntity && targetEntity.active && !targetEntity.state._destroyed) {
                    var targetEci = targetEntity.state._eci_pos;
                    if (targetEci) {
                        var myEci = state._eci_pos;
                        var dx = targetEci[0] - myEci[0];
                        var dy = targetEci[1] - myEci[1];
                        var dz = targetEci[2] - myEci[2];
                        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                        if (dist < this._killRange) {
                            // Within kill range — signal weapon system
                            state._kkTargetId = this._currentTarget;
                        } else {
                            // Close the distance
                            state._kkTargetId = null;
                            this._applyThrust(dt, state, targetEci);
                        }

                        state._orbCombatState = 'closing';
                        state._orbCombatTarget = this._currentTarget;
                        return;
                    }
                }

                // Target became invalid — clear it
                this._currentTarget = null;
            }

            // No target
            state._orbCombatState = 'seeking';
            state._orbCombatTarget = null;
            state._kkTargetId = null;
        }

        /**
         * Scan all entities for potential targets within sensor range.
         * Builds a sorted (by distance) list of detected enemies.
         * @param {object} world
         */
        _scanForTargets(world) {
            var self = this;
            var myTeam = this.entity.team;
            var myEci = this.entity.state._eci_pos;
            var results = [];

            if (!myEci) {
                this._targets = results;
                return;
            }

            world.entities.forEach(function(entity) {
                // Skip self
                if (entity.id === self.entity.id) return;

                // Skip same team
                if (entity.team === myTeam) return;

                // Skip inactive or destroyed
                if (!entity.active) return;
                if (entity.state._destroyed) return;

                // Must have ECI position
                var theirEci = entity.state._eci_pos;
                if (!theirEci) return;

                // Compute ECI distance
                var dx = theirEci[0] - myEci[0];
                var dy = theirEci[1] - myEci[1];
                var dz = theirEci[2] - myEci[2];
                var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                // Within sensor range?
                if (dist <= self._sensorRange) {
                    results.push({
                        entityId: entity.id,
                        distance: dist,
                        role: entity.state._orbCombatRole || 'unknown',
                        team: entity.team
                    });
                }
            });

            // Sort by distance ascending
            results.sort(function(a, b) {
                return a.distance - b.distance;
            });

            this._targets = results;
        }

        /**
         * Select the best target from the cached target list based on role.
         * @param {number} dt — time step for fallback thrust
         * @param {object} world
         */
        _selectTarget(dt, world) {
            var targets = this._targets;

            if (this._role === 'defender') {
                this._selectTargetDefender(world, targets);
            } else if (this._role === 'attacker') {
                this._selectTargetAttacker(world, targets);
            } else if (this._role === 'escort') {
                this._selectTargetEscort(dt, world, targets);
            } else if (this._role === 'sweep') {
                this._selectTargetSweep(world, targets);
            }
        }

        /**
         * Defender: engage enemies near the assigned HVA.
         * Only targets attackers, sweeps, and escorts within defenseRadius of the HVA.
         * @param {object} world
         * @param {Array} targets
         */
        _selectTargetDefender(world, targets) {
            // Get assigned HVA position
            var hvaEntity = this._assignedHvaId ? world.getEntity(this._assignedHvaId) : null;
            if (!hvaEntity || !hvaEntity.active || !hvaEntity.state._eci_pos) {
                this._currentTarget = null;
                return;
            }

            var hvaEci = hvaEntity.state._eci_pos;
            var defRadius = this._defenseRadius;
            var best = null;
            var bestDist = Infinity;

            for (var i = 0; i < targets.length; i++) {
                var t = targets[i];
                var role = t.role;

                // Only engage offensive roles
                if (role !== 'attacker' && role !== 'sweep' && role !== 'escort') continue;

                // Check if enemy is within defense radius of HVA
                var enemy = world.getEntity(t.entityId);
                if (!enemy || !enemy.state._eci_pos) continue;

                var eEci = enemy.state._eci_pos;
                var dx = eEci[0] - hvaEci[0];
                var dy = eEci[1] - hvaEci[1];
                var dz = eEci[2] - hvaEci[2];
                var distToHva = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (distToHva <= defRadius && t.distance < bestDist) {
                    best = t.entityId;
                    bestDist = t.distance;
                }
            }

            this._currentTarget = best;
        }

        /**
         * Attacker: seek and close on enemy HVAs.
         * @param {object} world
         * @param {Array} targets
         */
        _selectTargetAttacker(world, targets) {
            var best = null;
            var bestDist = Infinity;

            for (var i = 0; i < targets.length; i++) {
                var t = targets[i];
                if (t.role === 'hva' && t.distance < bestDist) {
                    best = t.entityId;
                    bestDist = t.distance;
                }
            }

            this._currentTarget = best;
        }

        /**
         * Escort: engage enemy defenders/sweeps, or drift toward friendly attackers.
         * @param {number} dt — time step for drift thrust
         * @param {object} world
         * @param {Array} targets
         */
        _selectTargetEscort(dt, world, targets) {
            // Priority 1: engage enemy defenders or sweeps
            var best = null;
            var bestDist = Infinity;

            for (var i = 0; i < targets.length; i++) {
                var t = targets[i];
                if ((t.role === 'defender' || t.role === 'sweep') && t.distance < bestDist) {
                    best = t.entityId;
                    bestDist = t.distance;
                }
            }

            if (best !== null) {
                this._currentTarget = best;
                return;
            }

            // Priority 2: drift toward nearest friendly attacker
            this._currentTarget = null;
            this._driftTowardFriendlyAttacker(dt, world);
        }

        /**
         * Sweep: hunt enemy attackers and escorts.
         * @param {object} world
         * @param {Array} targets
         */
        _selectTargetSweep(world, targets) {
            var best = null;
            var bestDist = Infinity;

            for (var i = 0; i < targets.length; i++) {
                var t = targets[i];
                if ((t.role === 'attacker' || t.role === 'escort') && t.distance < bestDist) {
                    best = t.entityId;
                    bestDist = t.distance;
                }
            }

            this._currentTarget = best;
        }

        /**
         * Escort fallback: drift toward nearest friendly attacker.
         * Uses cached target ID (refreshed at scan interval) to avoid
         * O(N) iteration every tick.
         * @param {number} dt — time step in seconds
         * @param {object} world
         */
        _driftTowardFriendlyAttacker(dt, world) {
            // Use cached drift target if still valid
            if (this._friendlyDriftTarget) {
                var cached = world.getEntity(this._friendlyDriftTarget);
                if (cached && cached.active && !cached.state._destroyed && cached.state._eci_pos) {
                    this._applyThrustScaled(dt, this.entity.state, cached.state._eci_pos, 0.3);
                    return;
                }
                this._friendlyDriftTarget = null;
            }

            // Only do the expensive scan at scan boundaries (scanTimer was just reset)
            if (this._scanTimer > 0.01) return;

            var self = this;
            var myTeam = this.entity.team;
            var myEci = this.entity.state._eci_pos;
            if (!myEci) return;

            var nearestId = null;
            var nearestDist = Infinity;

            world.entities.forEach(function(entity) {
                if (entity.id === self.entity.id) return;
                if (entity.team !== myTeam) return;
                if (!entity.active || entity.state._destroyed) return;
                if (entity.state._orbCombatRole !== 'attacker') return;

                var theirEci = entity.state._eci_pos;
                if (!theirEci) return;

                var dx = theirEci[0] - myEci[0];
                var dy = theirEci[1] - myEci[1];
                var dz = theirEci[2] - myEci[2];
                var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestId = entity.id;
                }
            });

            this._friendlyDriftTarget = nearestId;
            if (nearestId !== null) {
                var friendlyAttacker = world.getEntity(nearestId);
                if (friendlyAttacker && friendlyAttacker.state._eci_pos) {
                    this._applyThrustScaled(dt, this.entity.state, friendlyAttacker.state._eci_pos, 0.3);
                }
            }
        }

        /**
         * Apply full thrust toward a target ECI position.
         * Modifies state._eci_vel IN-PLACE to preserve shared array reference
         * with orbital_2body.
         * @param {number} dt — time step in seconds
         * @param {object} state — entity state
         * @param {number[]} targetEci — target ECI position [x, y, z]
         */
        _applyThrust(dt, state, targetEci) {
            var myEci = state._eci_pos;
            var dx = targetEci[0] - myEci[0];
            var dy = targetEci[1] - myEci[1];
            var dz = targetEci[2] - myEci[2];
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 1) return; // Guard against NaN from near-zero division

            var nx = dx / dist;
            var ny = dy / dist;
            var nz = dz / dist;
            var dv = this._maxAccel * dt;

            // CRITICAL: modify velocity in-place to preserve orbital_2body reference
            state._eci_vel[0] += nx * dv;
            state._eci_vel[1] += ny * dv;
            state._eci_vel[2] += nz * dv;
        }

        /**
         * Apply scaled thrust toward a target ECI position.
         * Used for gentle drift maneuvers (e.g., escort drifting toward friendly).
         * @param {number} dt — time step in seconds (pass 0 to use stored scanInterval)
         * @param {object} state — entity state
         * @param {number[]} targetEci — target ECI position [x, y, z]
         * @param {number} scale — fraction of maxAccel to apply (0.0 - 1.0)
         */
        _applyThrustScaled(dt, state, targetEci, scale) {
            var myEci = state._eci_pos;
            var dx = targetEci[0] - myEci[0];
            var dy = targetEci[1] - myEci[1];
            var dz = targetEci[2] - myEci[2];
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist < 1) return;

            var nx = dx / dist;
            var ny = dy / dist;
            var nz = dz / dist;

            // Use scanInterval as the effective dt for the drift impulse
            var effectiveDt = dt > 0 ? dt : this._scanInterval;
            var dv = this._maxAccel * scale * effectiveDt;

            // CRITICAL: modify velocity in-place to preserve orbital_2body reference
            state._eci_vel[0] += nx * dv;
            state._eci_vel[1] += ny * dv;
            state._eci_vel[2] += nz * dv;
        }

        cleanup(world) {
            var state = this.entity.state;
            state._orbCombatRole   = null;
            state._orbCombatState  = null;
            state._orbCombatTarget = null;
            state._kkTargetId      = null;
        }

        static editorSchema() {
            return [
                { name: 'role',          type: 'select', label: 'Combat Role',
                    options: ['hva', 'defender', 'attacker', 'escort', 'sweep'], default: 'attacker' },
                { name: 'assignedHvaId', type: 'entity', label: 'Assigned HVA' },
                { name: 'sensorRange',   type: 'number', label: 'Sensor Range (m)',   default: 1000000 },
                { name: 'defenseRadius', type: 'number', label: 'Defense Radius (m)', default: 500000 },
                { name: 'maxAccel',      type: 'number', label: 'Max Accel (m/s\u00B2)',  default: 50.0 },
                { name: 'killRange',     type: 'number', label: 'Kill Range (m)',      default: 50000 },
                { name: 'scanInterval',  type: 'number', label: 'Scan Interval (s)',   default: 1.0 }
            ];
        }
    }

    ComponentRegistry.register('ai', 'orbital_combat', OrbitalCombatAI);
})();
