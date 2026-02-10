/**
 * KineticKill weapon component — proximity-triggered mutual destruction.
 *
 * Works with orbital_combat AI which sets state._kkTargetId when a target
 * is within engagement range. This weapon checks ECI distance and performs
 * a probabilistic kill roll. On KILL, both attacker and target are destroyed.
 * On MISS, enters cooldown before allowing re-engagement.
 *
 * MC-compatible: uses world.rng for deterministic Pk rolls.
 *
 * Config:
 *   Pk        — kill probability (0-1), default 0.7
 *   killRange — mutual destruction distance in meters, default 2000
 *   cooldown  — seconds after miss before re-engaging, default 5.0
 *
 * State outputs:
 *   _kkState       — 'READY' | 'CLOSING' | 'KILL' | 'MISS' | 'COOLDOWN'
 *   _kkEngagements — array of { targetId, targetName, result, time }
 *
 * Registers as: weapons/kinetic_kill
 */
(function() {
    'use strict';

    class KineticKill extends ECS.Component {
        constructor(config) {
            super(config);
            this._Pk = config.Pk !== undefined ? config.Pk : 0.7;
            this._killRange = config.killRange || 50000;
            this._cooldown = config.cooldown || 5.0;
            this._cooldownTimer = 0;
            this._engagements = [];
            this._lastLaunchTarget = null;  // track LAUNCH dedup
        }

        init(world) {
            var state = this.entity.state;
            state._kkState = 'READY';
            state._kkEngagements = this._engagements;
            state._kkTargetId = null;
        }

        update(dt, world) {
            var state = this.entity.state;
            var entity = this.entity;

            // Weapons disabled by cyber attack
            if (state._weaponsDisabled) return;

            // Cyber weapons degradation
            var wpnDeg = state._cyberDegradation ? (state._cyberDegradation.weapons || 0) : 0;

            // Already destroyed
            if (!entity.active || state._destroyed) return;

            // Handle cooldown after miss
            if (state._kkState === 'COOLDOWN') {
                this._cooldownTimer -= dt;
                if (this._cooldownTimer <= 0) {
                    state._kkState = 'READY';
                    this._cooldownTimer = 0;
                }
                return;
            }

            // Check if AI has designated a target
            var targetId = state._kkTargetId;
            if (!targetId) {
                if (state._kkState !== 'KILL' && state._kkState !== 'MISS') {
                    state._kkState = 'READY';
                }
                return;
            }

            var target = world.getEntity(targetId);
            if (!target || !target.active || target.state._destroyed) {
                state._kkTargetId = null;
                state._kkState = 'READY';
                return;
            }

            // Compute ECI distance
            var myPos = state._eci_pos;
            var tgtPos = target.state._eci_pos;
            if (!myPos || !tgtPos) return;

            var dx = tgtPos[0] - myPos[0];
            var dy = tgtPos[1] - myPos[1];
            var dz = tgtPos[2] - myPos[2];
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            // Update state
            state._kkState = 'CLOSING';

            // Log LAUNCH event when first engaging a new target
            if (targetId !== this._lastLaunchTarget) {
                this._lastLaunchTarget = targetId;
                this._engagements.push({
                    targetId: targetId,
                    targetName: target.name,
                    result: 'LAUNCH',
                    time: world.simTime
                });
            }

            // Check if within kill range
            if (dist <= this._killRange) {
                // Pk roll — degraded by cyber attack
                var effectivePk = this._Pk;
                if (wpnDeg > 0 && wpnDeg < 1) {
                    effectivePk *= (1 - wpnDeg * 0.7); // up to 70% Pk reduction for KKV (high precision required)
                }
                var rng = world.rng;
                var hit = rng ? rng.bernoulli(effectivePk) : (Math.random() < effectivePk);

                if (hit) {
                    // KILL — mutual destruction
                    state._kkState = 'KILL';

                    // Destroy target
                    target.active = false;
                    target.state._destroyed = true;

                    // Destroy self (kinetic kill is sacrificial)
                    entity.active = false;
                    state._destroyed = true;

                    // Log engagement
                    this._engagements.push({
                        targetId: targetId,
                        targetName: target.name,
                        result: 'KILL',
                        time: world.simTime
                    });

                    // Also log on target side if it has _kkEngagements
                    if (target.state._kkEngagements) {
                        target.state._kkEngagements.push({
                            targetId: entity.id,
                            targetName: entity.name,
                            result: 'KILLED_BY',
                            time: world.simTime
                        });
                    }
                } else {
                    // MISS — enter cooldown
                    state._kkState = 'COOLDOWN';
                    this._cooldownTimer = this._cooldown;
                    state._kkTargetId = null;

                    // Log miss
                    this._engagements.push({
                        targetId: targetId,
                        targetName: target.name,
                        result: 'MISS',
                        time: world.simTime
                    });
                }
            }
        }

        cleanup(world) {
            var state = this.entity.state;
            state._kkState = 'READY';
            state._kkTargetId = null;
        }

        static editorSchema() {
            return [
                { name: 'Pk', type: 'number', label: 'Kill Probability', default: 0.7 },
                { name: 'killRange', type: 'number', label: 'Kill Range (m)', default: 50000 },
                { name: 'cooldown', type: 'number', label: 'Miss Cooldown (s)', default: 5.0 }
            ];
        }
    }

    ComponentRegistry.register('weapons', 'kinetic_kill', KineticKill);
})();
