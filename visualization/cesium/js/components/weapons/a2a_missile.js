/**
 * A2AMissile weapon component — Air-to-Air missile system for fighter aircraft.
 *
 * Manages a mixed loadout of IR and radar-guided missiles (e.g. AIM-9X, AIM-120C).
 * Reads detections from the entity's radar sensor component
 * (entity.state._detections) and progresses engagements through a
 * SEARCH → LOCK → FIRE → GUIDE → ASSESS state machine.
 *
 * Config:
 *   loadout              — array of weapon specs:
 *     { type, count, minRange, maxRange, seekerFOV, Pk, speed, flightTime }
 *   engagementRules      — 'weapons_free' | 'weapons_tight' | 'weapons_hold'
 *
 * State outputs on entity.state:
 *   _a2aState            — overall state: 'SEARCHING' | 'LOCKED' | 'ENGAGING'
 *   _a2aEngagements      — array of engagement objects
 *   _a2aInventory        — { weaponType: remainingCount, ... }
 *   _a2aTotalFired       — cumulative launches
 *   _a2aKills            — cumulative kills
 *
 * Registers as: weapons/a2a_missile
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Engagement states
    var STATE_SEARCH = 'SEARCH';
    var STATE_LOCK   = 'LOCK';
    var STATE_FIRE   = 'FIRE';
    var STATE_GUIDE  = 'GUIDE';
    var STATE_ASSESS = 'ASSESS';

    // Lock acquisition times (seconds)
    var BVR_LOCK_TIME = 1.0;    // radar-guided (seekerFOV >= 360)
    var IR_LOCK_TIME  = 2.0;    // IR-guided (seekerFOV < 360)

    // Assessment dwell time before removing engagement
    var ASSESS_DELAY = 2.0;

    // Missile arrival threshold (meters)
    var ARRIVAL_RANGE = 100;

    // Max simultaneous engagements for a fighter
    var MAX_SIMULTANEOUS = 1;

    // Default loadout if none provided
    var DEFAULT_LOADOUT = [
        { type: 'AIM-9X',   count: 2, minRange: 500,  maxRange: 18000, seekerFOV: 90,  Pk: 0.85, speed: 900,  flightTime: 20 },
        { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
    ];

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Great-circle distance in meters. Arguments in radians. */
    function gcDistance(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R_EARTH * c;
    }

    /** Slant range between two airborne entities. */
    function slantRange(lat1, lon1, alt1, lat2, lon2, alt2) {
        var horizDist = gcDistance(lat1, lon1, lat2, lon2);
        var dAlt = alt2 - alt1;
        return Math.sqrt(horizDist * horizDist + dAlt * dAlt);
    }

    // -----------------------------------------------------------------------
    // A2AMissile component
    // -----------------------------------------------------------------------
    class A2AMissile extends ECS.Component {
        constructor(config) {
            super(config);

            // Deep-copy loadout to build inventory (don't mutate config)
            var loadout = config.loadout || DEFAULT_LOADOUT;
            this._loadout = [];
            this._inventory = {};
            for (var i = 0; i < loadout.length; i++) {
                var wpn = {};
                wpn.type       = loadout[i].type;
                wpn.count      = loadout[i].count;
                wpn.minRange   = loadout[i].minRange;
                wpn.maxRange   = loadout[i].maxRange;
                wpn.seekerFOV  = loadout[i].seekerFOV;
                wpn.Pk         = loadout[i].Pk;
                wpn.speed      = loadout[i].speed;
                wpn.flightTime = loadout[i].flightTime;
                this._loadout.push(wpn);
                this._inventory[wpn.type] = wpn.count;
            }

            this._rules = config.engagementRules || 'weapons_free';

            // Runtime state
            this._engagements    = [];     // active engagement entries
            this._totalFired     = 0;
            this._kills          = 0;
            this._missileVisuals = [];     // Cesium entities for active missiles
        }

        init(world) {
            var state = this.entity.state;
            state._a2aState       = 'SEARCHING';
            state._a2aEngagements = this._engagements;
            state._a2aInventory   = Object.assign({}, this._inventory);
            state._a2aTotalFired  = 0;
            state._a2aKills       = 0;
        }

        update(dt, world) {
            var state = this.entity.state;
            var detections = state._detections || [];

            // Process existing engagements
            this._updateEngagements(dt, world);

            // Check for dynamic ROE changes from EventSystem
            var activeRules = state.engagementRules || this._rules;

            // Look for new targets from detections (if allowed by ROE)
            if (activeRules !== 'weapons_hold') {
                this._rules = activeRules;
                this._evaluateNewTargets(detections, world);
            }

            // Update overall A2A state
            this._updateOverallState(state);

            // Sync state outputs
            state._a2aEngagements = this._engagements;
            state._a2aInventory   = Object.assign({}, this._inventory);
            state._a2aTotalFired  = this._totalFired;
            state._a2aKills       = this._kills;
        }

        // -------------------------------------------------------------------
        // Engagement state machine
        // -------------------------------------------------------------------
        _updateEngagements(dt, world) {
            var i = this._engagements.length;
            while (i--) {
                var eng = this._engagements[i];
                eng.timeInState += dt;

                // Check if target entity still exists and is active
                var target = world.getEntity(eng.targetId);
                if (!target || !target.active) {
                    this._removeEngagement(i, world);
                    continue;
                }

                switch (eng.state) {
                    case STATE_LOCK:
                        this._processLock(eng, dt, target, world);
                        break;
                    case STATE_FIRE:
                        this._processFire(eng, dt, target, world);
                        break;
                    case STATE_GUIDE:
                        this._processGuide(eng, dt, target, world);
                        break;
                    case STATE_ASSESS:
                        this._processAssess(eng, dt, i, world);
                        break;
                    default:
                        break;
                }
            }
        }

        _processLock(eng, dt, target, world) {
            // Determine lock time based on weapon seeker type
            var weapon = this._getWeaponSpec(eng.weaponType);
            var lockTime = (weapon && weapon.seekerFOV >= 360) ? BVR_LOCK_TIME : IR_LOCK_TIME;

            if (eng.timeInState >= lockTime) {
                // Check weapon inventory before committing to fire
                if (this._inventory[eng.weaponType] > 0) {
                    eng.state = STATE_FIRE;
                    eng.timeInState = 0;
                } else {
                    // No rounds left for this weapon — abort engagement
                    this._removeEngagement(this._engagements.indexOf(eng), world);
                }
            }
        }

        _processFire(eng, dt, target, world) {
            // Consume one round from inventory
            this._inventory[eng.weaponType]--;
            this._totalFired++;

            // Launch missile visual
            this._launchMissileVisuals(eng, target, world);

            // Compute estimated time of flight for this engagement
            var myState = this.entity.state;
            var tgtState = target.state;
            var range = slantRange(
                myState.lat, myState.lon, myState.alt || 0,
                tgtState.lat, tgtState.lon, tgtState.alt || 0
            );
            var weapon = this._getWeaponSpec(eng.weaponType);
            eng._estimatedTof = (weapon && weapon.speed > 0) ? (range / weapon.speed) : 10;

            // Immediately transition to GUIDE
            eng.state = STATE_GUIDE;
            eng.timeInState = 0;
        }

        _processGuide(eng, dt, target, world) {
            var weapon = this._getWeaponSpec(eng.weaponType);
            var maxFlightTime = weapon ? weapon.flightTime : 30;

            // Update missile visual positions (proportional navigation toward target)
            this._updateMissileVisuals(eng, target, world);

            // Check arrival: Cesium distance between missile and target < threshold
            var arrived = false;
            if (eng._missileEntities && eng._missileEntities.length > 0) {
                var tgtState = target.state;
                var tgtPos = Cesium.Cartesian3.fromRadians(
                    tgtState.lon, tgtState.lat, tgtState.alt || 0
                );
                var md = eng._missileEntities[0];
                if (md.currentPos) {
                    var dist = Cesium.Cartesian3.distance(md.currentPos, tgtPos);
                    if (dist < ARRIVAL_RANGE) {
                        arrived = true;
                    }
                }
            }

            // Also check if flight time exceeded
            if (arrived || eng.timeInState >= maxFlightTime) {
                // Kill assessment — Pk roll
                var Pk = weapon ? weapon.Pk : 0.5;
                var rng = world.rng;
                if (rng ? rng.bernoulli(Pk) : (Math.random() < Pk)) {
                    eng.result = 'KILL';
                    target.active = false;
                    target.state._destroyed = true;
                    this._kills++;
                } else {
                    eng.result = 'MISS';
                }

                // Remove missile visuals
                this._removeMissileVisuals(eng, world);

                eng.state = STATE_ASSESS;
                eng.timeInState = 0;
            }
        }

        _processAssess(eng, dt, index, world) {
            // Wait for assessment delay, then remove engagement
            if (eng.timeInState >= ASSESS_DELAY) {
                this._removeEngagement(index, world);
            }
        }

        // -------------------------------------------------------------------
        // New target evaluation
        // -------------------------------------------------------------------
        _evaluateNewTargets(detections, world) {
            // Count active engagements (non-ASSESS)
            var activeCount = 0;
            for (var j = 0; j < this._engagements.length; j++) {
                if (this._engagements[j].state !== STATE_ASSESS) {
                    activeCount++;
                }
            }

            for (var i = 0; i < detections.length; i++) {
                if (activeCount >= MAX_SIMULTANEOUS) break;

                var det = detections[i];
                if (!det.detected) continue;
                var targetId = det.targetId || det.entityId || det.id;
                if (!targetId) continue;

                // Skip if already engaged
                if (this._isTargetEngaged(targetId)) continue;

                // Check if target exists and is active
                var target = world.getEntity(targetId);
                if (!target || !target.active) continue;

                // Weapons tight: engage only hostile (opposite team)
                if (this._rules === 'weapons_tight') {
                    var myTeam = this.entity.team;
                    if (myTeam === target.team) continue;
                    if (target.team === 'neutral') continue;
                }

                // Compute range to target
                var myState = this.entity.state;
                var tgtState = target.state;
                var range = slantRange(
                    myState.lat, myState.lon, myState.alt || 0,
                    tgtState.lat, tgtState.lon, tgtState.alt || 0
                );

                // Select best weapon for this range
                var weaponType = this._selectWeapon(range);
                if (!weaponType) continue;

                // Create new engagement entry
                this._engagements.push({
                    targetId: targetId,
                    weaponType: weaponType,
                    state: STATE_LOCK,
                    timeInState: 0,
                    result: null,
                    _missileEntity: null,
                    _estimatedTof: 0
                });
                activeCount++;
            }
        }

        _isTargetEngaged(targetId) {
            for (var i = 0; i < this._engagements.length; i++) {
                if (this._engagements[i].targetId === targetId) return true;
            }
            return false;
        }

        // -------------------------------------------------------------------
        // Weapon selection
        // -------------------------------------------------------------------

        /**
         * Select the best weapon for the given range.
         * Picks the weapon with the smallest maxRange that still covers the
         * target range. Requires inventory > 0 and range >= minRange.
         *
         * @param {number} range  slant range in meters
         * @returns {string|null}  weapon type name, or null if nothing can reach
         */
        _selectWeapon(range) {
            var bestType = null;
            var bestMaxRange = Infinity;

            for (var i = 0; i < this._loadout.length; i++) {
                var wpn = this._loadout[i];

                // Must have inventory
                if (this._inventory[wpn.type] <= 0) continue;

                // Target must be within weapon envelope
                if (range < wpn.minRange || range > wpn.maxRange) continue;

                // Prefer shortest maxRange that can still reach
                if (wpn.maxRange < bestMaxRange) {
                    bestMaxRange = wpn.maxRange;
                    bestType = wpn.type;
                }
            }

            return bestType;
        }

        /**
         * Look up a weapon spec from the loadout by type name.
         * @param {string} typeName
         * @returns {object|null}
         */
        _getWeaponSpec(typeName) {
            for (var i = 0; i < this._loadout.length; i++) {
                if (this._loadout[i].type === typeName) return this._loadout[i];
            }
            return null;
        }

        // -------------------------------------------------------------------
        // Missile visuals (Cesium entities)
        // -------------------------------------------------------------------
        _launchMissileVisuals(eng, target, world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var myState = this.entity.state;
            var launchPos = Cesium.Cartesian3.fromRadians(
                myState.lon, myState.lat, myState.alt || 0
            );

            eng._missileEntities = [];

            // Single missile per engagement (fighter fires one at a time)
            var missileData = {
                launchTime: world.simTime,
                launchPos: launchPos.clone(),
                currentPos: launchPos.clone()
            };

            var cesiumEntity = viewer.entities.add({
                name: 'A2A Missile ' + eng.weaponType + ' #' + this._totalFired,
                position: new Cesium.CallbackProperty(
                    (function(md) {
                        return function() { return md.currentPos; };
                    })(missileData),
                    false
                ),
                point: {
                    pixelSize: 4,
                    color: Cesium.Color.CYAN,
                    outlineColor: Cesium.Color.YELLOW,
                    outlineWidth: 1,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });

            missileData.entity = cesiumEntity;
            eng._missileEntities.push(missileData);
            this._missileVisuals.push(missileData);
        }

        _updateMissileVisuals(eng, target, world) {
            if (!eng._missileEntities) return;

            var tgtState = target.state;
            var tgtPos = Cesium.Cartesian3.fromRadians(
                tgtState.lon, tgtState.lat, tgtState.alt || 0
            );

            // Fraction of flight completed based on estimated TOF
            var tof = eng._estimatedTof || 10;
            var frac = Math.min(1.0, eng.timeInState / Math.max(tof, 0.1));

            for (var m = 0; m < eng._missileEntities.length; m++) {
                var md = eng._missileEntities[m];
                // Interpolate between launch position and current target position
                var interpPos = new Cesium.Cartesian3();
                Cesium.Cartesian3.lerp(md.launchPos, tgtPos, frac, interpPos);
                md.currentPos = interpPos;
            }
        }

        _removeMissileVisuals(eng, world) {
            if (!eng._missileEntities) return;
            var viewer = world.viewer;

            for (var m = 0; m < eng._missileEntities.length; m++) {
                var md = eng._missileEntities[m];
                if (viewer && md.entity) {
                    viewer.entities.remove(md.entity);
                }

                // Remove from tracked visuals array
                var idx = this._missileVisuals.indexOf(md);
                if (idx >= 0) this._missileVisuals.splice(idx, 1);
            }

            eng._missileEntities = null;
        }

        // -------------------------------------------------------------------
        // Engagement removal
        // -------------------------------------------------------------------
        _removeEngagement(index, world) {
            var eng = this._engagements[index];
            if (eng._missileEntities) {
                this._removeMissileVisuals(eng, world);
            }
            this._engagements.splice(index, 1);
        }

        // -------------------------------------------------------------------
        // Overall state computation
        // -------------------------------------------------------------------
        _updateOverallState(state) {
            var hasEngaging = false;
            var hasLocked = false;

            for (var i = 0; i < this._engagements.length; i++) {
                var s = this._engagements[i].state;
                if (s === STATE_FIRE || s === STATE_GUIDE) hasEngaging = true;
                if (s === STATE_LOCK) hasLocked = true;
            }

            if (hasEngaging) {
                state._a2aState = 'ENGAGING';
            } else if (hasLocked) {
                state._a2aState = 'LOCKED';
            } else {
                state._a2aState = 'SEARCHING';
            }
        }

        // -------------------------------------------------------------------
        // Cleanup
        // -------------------------------------------------------------------
        cleanup(world) {
            // Remove all active missile visuals
            var viewer = world.viewer;
            if (viewer) {
                for (var i = 0; i < this._missileVisuals.length; i++) {
                    var md = this._missileVisuals[i];
                    if (md.entity) {
                        viewer.entities.remove(md.entity);
                    }
                }
            }
            this._missileVisuals = [];
            this._engagements = [];
        }
    }

    // Register with framework
    ComponentRegistry.register('weapons', 'a2a_missile', A2AMissile);
})();
