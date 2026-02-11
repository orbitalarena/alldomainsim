/**
 * SAMBattery weapon component — Surface-to-Air Missile battery with F2T2EA kill chain.
 *
 * Implements the full Find-Fix-Track-Target-Engage-Assess cycle for each
 * tracked hostile target. Reads detections from the entity's radar sensor
 * component (entity.state._detections) and progresses engagements through
 * the kill chain state machine.
 *
 * Config:
 *   maxRange_m          — max engagement range (default 150000)
 *   minRange_m          — min engagement range (default 3000)
 *   maxAlt_m            — max altitude to engage (default 25000)
 *   missileSpeed_mps    — missile fly-out speed (default 1200)
 *   missileAccel_g      — missile acceleration in g's (default 30)
 *   reloadTime_s        — time to reload after salvo (default 10)
 *   salvoSize           — missiles per engagement (default 2)
 *   killProbability     — P(kill) per missile (default 0.7)
 *   engagementRules     — 'weapons_free' | 'weapons_hold' | 'weapons_tight' (default 'weapons_hold')
 *   maxSimultaneous     — max concurrent engagements (default 2)
 *
 * State outputs on entity.state:
 *   _engagements        — array of engagement objects
 *   _samState           — overall state string
 *   _missilesReady      — missiles available to fire
 *   _totalFired         — cumulative missiles launched
 *
 * Registers as: weapons/sam_battery
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Kill chain states
    var STATE_SEARCH = 'SEARCH';
    var STATE_DETECT = 'DETECT';
    var STATE_TRACK  = 'TRACK';
    var STATE_ENGAGE = 'ENGAGE';
    var STATE_ASSESS = 'ASSESS';

    // Timing delays (seconds)
    var DETECT_TO_TRACK_DELAY = 1.0;
    var TRACK_TO_ENGAGE_DELAY = 2.0;
    var ASSESS_DELAY          = 3.0;

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

    /** Slant range from ground site to airborne target. */
    function slantRange(groundLat, groundLon, groundAlt, tgtLat, tgtLon, tgtAlt) {
        var horizDist = gcDistance(groundLat, groundLon, tgtLat, tgtLon);
        var dAlt = tgtAlt - groundAlt;
        return Math.sqrt(horizDist * horizDist + dAlt * dAlt);
    }

    // -----------------------------------------------------------------------
    // SAMBattery component
    // -----------------------------------------------------------------------
    class SAMBattery extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._maxRange     = config.maxRange_m       || 150000;
            this._minRange     = config.minRange_m       || 3000;
            this._maxAlt       = config.maxAlt_m         || 25000;
            this._missileSpeed = config.missileSpeed_mps || 1200;
            this._missileAccelG = config.missileAccel_g  || 30;
            this._reloadTime   = config.reloadTime_s     || 10;
            this._salvoSize    = config.salvoSize        || 2;
            this._killProb     = config.killProbability  || 0.7;
            this._rules        = config.engagementRules  || 'weapons_hold';
            this._maxSimult    = config.maxSimultaneous  || 2;

            // Runtime state
            this._engagements    = [];     // active engagement entries
            this._totalFired     = 0;
            this._missilesReady  = this._salvoSize * this._maxSimult;
            this._reloadTimer    = 0;
            this._missileVisuals = [];     // Cesium entities for active missiles
        }

        init(world) {
            var state = this.entity.state;
            state._engagements  = this._engagements;
            state._samState     = 'SEARCHING';
            state._missilesReady = this._missilesReady;
            state._totalFired   = 0;
        }

        update(dt, world) {
            var state = this.entity.state;

            // Weapons disabled by cyber attack — can't fire, can't track
            if (state._weaponsDisabled) {
                state._samState = 'DISABLED';
                return;
            }

            // Cyber weapons degradation — graduated kill chain effects
            // 0 = no degradation, 1 = fully disabled (caught above by _weaponsDisabled)
            this._wpnDeg = state._cyberDegradation ? (state._cyberDegradation.weapons || 0) : 0;

            var detections = state._detections || [];

            // Handle reload timer
            if (this._reloadTimer > 0) {
                this._reloadTimer -= dt;
                if (this._reloadTimer <= 0) {
                    this._reloadTimer = 0;
                    this._missilesReady = this._salvoSize * this._maxSimult;
                }
            }

            // Process existing engagements
            this._updateEngagements(dt, world);

            // Check for dynamic ROE changes from EventSystem
            var activeRules = state.engagementRules || this._rules;

            // Look for new targets from detections (if allowed by ROE)
            if (activeRules !== 'weapons_hold') {
                this._rules = activeRules;

                // Merge organic radar detections with comm-fed targeting data
                var mergedDetections = this._mergeCommTargets(detections, state, world);
                this._evaluateNewTargets(mergedDetections, world);
            }

            // Update overall SAM state
            this._updateOverallState(state);

            // Update comm targeting status
            this._updateCommStatus(state);

            // Sync state outputs
            state._engagements   = this._engagements;
            state._missilesReady = this._missilesReady;
            state._totalFired    = this._totalFired;
        }

        /**
         * Merge organic radar detections with comm-delivered targeting data.
         * Organic tracks take priority (fresher). Comm tracks fill in targets
         * that the local radar can't see. Track quality from comm is degraded
         * by latency, reducing effective kill probability.
         */
        _mergeCommTargets(organicDetections, state, world) {
            var merged = organicDetections.slice(); // copy organic
            var seenTargets = new Set();

            // Mark all organically-detected targets
            for (var i = 0; i < organicDetections.length; i++) {
                var tid = organicDetections[i].targetId || organicDetections[i].entityId;
                if (tid) seenTargets.add(tid);
            }

            // Add comm-delivered targets not already detected organically
            var commTargets = state._commTargets;
            if (!commTargets) return merged;

            var simTime = world ? world.simTime : 0;
            var myState = state;
            var keys = Object.keys(commTargets);

            for (var c = 0; c < keys.length; c++) {
                var tgt = commTargets[keys[c]];
                if (seenTargets.has(tgt.targetId)) continue;

                // Check track freshness — stale tracks (>10s old) are unreliable
                var trackAge = simTime - (tgt.time || 0);
                if (trackAge > 10) continue;

                // Check if target entity still exists
                var targetEntity = world ? world.getEntity(tgt.targetId) : null;
                if (!targetEntity || !targetEntity.active) continue;

                // Compute slant range from us to the comm-predicted position
                var range = slantRange(
                    myState.lat, myState.lon, myState.alt || 0,
                    tgt.lat, tgt.lon, tgt.alt || 0
                );

                // Range and altitude checks
                if (range > this._maxRange || range < this._minRange) continue;
                if ((tgt.alt || 0) > this._maxAlt) continue;

                // Create synthetic detection entry from comm data
                merged.push({
                    targetId: tgt.targetId,
                    targetName: tgt.targetName || tgt.targetId,
                    range_m: range,
                    bearing_deg: tgt.bearing_deg || 0,
                    elevation_deg: 0,
                    detected: true,
                    _isCommTrack: true,
                    _commLatency_s: tgt._totalLatency_s || 0,
                    _posUncertainty_m: tgt._posUncertainty_m || 0,
                    _trackAge_s: trackAge
                });
                seenTargets.add(tgt.targetId);
            }

            return merged;
        }

        /**
         * Update comm targeting status on entity state for HUD display.
         */
        _updateCommStatus(state) {
            var commTargets = state._commTargets;
            var commCount = commTargets ? Object.keys(commTargets).length : 0;
            var organicCount = (state._detections || []).filter(function(d) { return d.detected; }).length;

            state._samCommFed = commCount > 0;
            state._samCommTracks = commCount;
            state._samOrganicTracks = organicCount;
            state._samTrackSource = commCount > 0 && organicCount === 0 ? 'COMM'
                : commCount > 0 && organicCount > 0 ? 'HYBRID'
                : organicCount > 0 ? 'ORGANIC'
                : 'NONE';
        }

        // -------------------------------------------------------------------
        // Kill chain state machine for each engagement
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
                    case STATE_DETECT:
                        this._processDetect(eng, dt, world);
                        break;
                    case STATE_TRACK:
                        this._processTrack(eng, dt, target, world);
                        break;
                    case STATE_ENGAGE:
                        this._processEngage(eng, dt, target, world);
                        break;
                    case STATE_ASSESS:
                        this._processAssess(eng, dt, i, world);
                        break;
                    default:
                        break;
                }
            }
        }

        _processDetect(eng, dt, world) {
            // Hold in DETECT until delay passes, then advance to TRACK
            if (eng.timeInState >= DETECT_TO_TRACK_DELAY) {
                eng.state = STATE_TRACK;
                eng.timeInState = 0;
            }
        }

        _processTrack(eng, dt, target, world) {
            // Comm-fed tracks need longer tracking time (degraded solution)
            var trackDelay = TRACK_TO_ENGAGE_DELAY;
            if (eng._isCommTrack) {
                trackDelay += Math.min(eng._commLatency_s || 0, 3.0);
            }
            // Cyber degradation adds tracking delay (fire control computer impaired)
            if (this._wpnDeg > 0) {
                trackDelay += this._wpnDeg * 5.0; // up to 5 extra seconds to compute solution
            }

            // Computing firing solution — advance to ENGAGE after delay
            if (eng.timeInState >= trackDelay) {
                // Check engagement rules and missile availability
                if (this._missilesReady >= this._salvoSize) {
                    if (this._rules === 'weapons_free' ||
                        (this._rules === 'weapons_tight' && target.team === 'red')) {
                        eng.state = STATE_ENGAGE;
                        eng.timeInState = 0;
                        eng.missilesRemaining = this._salvoSize;
                        this._missilesReady -= this._salvoSize;
                        this._totalFired += this._salvoSize;
                        this._launchMissileVisuals(eng, target, world);
                    }
                }
            }
        }

        _processEngage(eng, dt, target, world) {
            var myState = this.entity.state;
            var tgtState = target.state;

            // Compute slant range to target
            var range = slantRange(
                myState.lat, myState.lon, myState.alt || 0,
                tgtState.lat, tgtState.lon, tgtState.alt || 0
            );

            // Time of flight estimate: range / missile speed
            var tof = range / this._missileSpeed;

            // Missile has arrived if we've been in ENGAGE state long enough
            if (eng.timeInState >= tof) {
                // Kill probability degraded for comm-fed tracks due to position uncertainty
                var effectiveKillProb = this._killProb;
                // Cyber weapons degradation reduces kill probability
                if (this._wpnDeg > 0 && this._wpnDeg < 1) {
                    effectiveKillProb *= (1 - this._wpnDeg * 0.6); // up to 60% Pk reduction
                }
                if (eng._isCommTrack) {
                    var uncertainty = eng._posUncertainty_m || 0;
                    var latencyPenalty = Math.min((eng._commLatency_s || 0) * 0.05, 0.3);
                    var uncertaintyPenalty = Math.min(uncertainty / 5000, 0.2);
                    effectiveKillProb = Math.max(0.1, effectiveKillProb - latencyPenalty - uncertaintyPenalty);
                }

                // Apply kill probability for each missile in the salvo
                var survived = true;
                var rng = world.rng;
                for (var m = 0; m < this._salvoSize; m++) {
                    if (rng ? rng.bernoulli(effectiveKillProb) : (Math.random() < effectiveKillProb)) {
                        survived = false;
                        break;
                    }
                }

                if (!survived) {
                    eng.result = 'KILL';
                    target.active = false;
                    // Explosion at target position
                    if (world.viewer && target.state && target.state.lat != null) {
                        var killPos = Cesium.Cartesian3.fromRadians(
                            target.state.lon, target.state.lat, target.state.alt || 0);
                        if (typeof SimEffects !== 'undefined' && SimEffects.spawnExplosion) {
                            SimEffects.spawnExplosion(killPos, 'medium', 'conventional');
                        }
                    }
                } else {
                    eng.result = 'MISS';
                }

                // Remove missile visuals
                this._removeMissileVisuals(eng, world);

                eng.state = STATE_ASSESS;
                eng.timeInState = 0;
                eng.missilesRemaining = 0;
            } else {
                // Update missile visual positions (interpolate toward target)
                this._updateMissileVisuals(eng, target, world);
            }
        }

        _processAssess(eng, dt, index, world) {
            // Wait for assessment delay, then remove engagement
            if (eng.timeInState >= ASSESS_DELAY) {
                this._removeEngagement(index, world);

                // Start reload if we're low on missiles
                if (this._missilesReady < this._salvoSize && this._reloadTimer <= 0) {
                    this._reloadTimer = this._reloadTime;
                }
            }
        }

        // -------------------------------------------------------------------
        // New target evaluation
        // -------------------------------------------------------------------
        _evaluateNewTargets(detections, world) {
            // Count active engagements
            var activeCount = 0;
            for (var j = 0; j < this._engagements.length; j++) {
                if (this._engagements[j].state !== STATE_ASSESS) {
                    activeCount++;
                }
            }

            for (var i = 0; i < detections.length; i++) {
                if (activeCount >= this._maxSimult) break;

                var det = detections[i];
                if (!det.detected) continue;
                var targetId = det.targetId || det.entityId || det.id;
                if (!targetId) continue;

                // Skip if already engaged
                if (this._isTargetEngaged(targetId)) continue;

                // Check if target is hostile (weapons_tight requires confirmed hostile)
                var target = world.getEntity(targetId);
                if (!target || !target.active) continue;

                if (this._rules === 'weapons_tight' && target.team !== 'red') continue;

                // Range and altitude checks
                var myState = this.entity.state;
                var tgtState = target.state;
                var range = slantRange(
                    myState.lat, myState.lon, myState.alt || 0,
                    tgtState.lat, tgtState.lon, tgtState.alt || 0
                );

                if (range > this._maxRange || range < this._minRange) continue;
                if ((tgtState.alt || 0) > this._maxAlt) continue;

                // Create new engagement entry
                var engEntry = {
                    targetId: targetId,
                    state: STATE_DETECT,
                    timeInState: 0,
                    missilesRemaining: 0,
                    result: null,
                    _isCommTrack: !!det._isCommTrack,
                    _commLatency_s: det._commLatency_s || 0,
                    _posUncertainty_m: det._posUncertainty_m || 0
                };
                this._engagements.push(engEntry);
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

            for (var m = 0; m < this._salvoSize; m++) {
                // Store launch time and position for interpolation
                var missileData = {
                    launchTime: world.simTime,
                    launchPos: launchPos.clone(),
                    currentPos: launchPos.clone(),
                    trailPositions: [launchPos.clone()]
                };

                var cesiumEntity = viewer.entities.add({
                    name: 'SAM Missile ' + this._totalFired + '-' + m,
                    position: new Cesium.CallbackProperty(
                        (function(md) {
                            return function() { return md.currentPos; };
                        })(missileData),
                        false
                    ),
                    point: {
                        pixelSize: 5,
                        color: Cesium.Color.RED,
                        outlineColor: Cesium.Color.YELLOW,
                        outlineWidth: 1,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    }
                });

                // Smoke trail polyline
                var trailEntity = viewer.entities.add({
                    name: 'SAM Trail ' + this._totalFired + '-' + m,
                    polyline: {
                        positions: new Cesium.CallbackProperty(
                            (function(md) {
                                return function() { return md.trailPositions; };
                            })(missileData),
                            false
                        ),
                        width: 2,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.25,
                            color: Cesium.Color.ORANGERED.withAlpha(0.4)
                        })
                    }
                });

                missileData.entity = cesiumEntity;
                missileData.trailEntity = trailEntity;
                eng._missileEntities.push(missileData);
                this._missileVisuals.push(missileData);
            }
        }

        _updateMissileVisuals(eng, target, world) {
            if (!eng._missileEntities) return;

            var tgtState = target.state;
            var tgtPos = Cesium.Cartesian3.fromRadians(
                tgtState.lon, tgtState.lat, tgtState.alt || 0
            );

            var myState = this.entity.state;
            var range = slantRange(
                myState.lat, myState.lon, myState.alt || 0,
                tgtState.lat, tgtState.lon, tgtState.alt || 0
            );
            var tof = range / this._missileSpeed;

            // Fraction of flight completed (use original engagement time)
            // Clamp to [0,1] to avoid overshoot
            var frac = Math.min(1.0, eng.timeInState / Math.max(tof, 0.1));

            for (var m = 0; m < eng._missileEntities.length; m++) {
                var md = eng._missileEntities[m];
                // Interpolate between launch position and current target position
                var interpPos = new Cesium.Cartesian3();
                Cesium.Cartesian3.lerp(md.launchPos, tgtPos, frac, interpPos);

                // Add slight spread between missiles in salvo
                if (m > 0) {
                    interpPos.x += (m * 50) * Math.sin(world.simTime);
                    interpPos.y += (m * 50) * Math.cos(world.simTime);
                }

                md.currentPos = interpPos;

                // Grow trail (keep last 40 positions)
                if (md.trailPositions) {
                    md.trailPositions.push(interpPos.clone());
                    if (md.trailPositions.length > 40) md.trailPositions.shift();
                }
            }
        }

        _removeMissileVisuals(eng, world) {
            if (!eng._missileEntities) return;
            var viewer = world.viewer;

            for (var m = 0; m < eng._missileEntities.length; m++) {
                var md = eng._missileEntities[m];
                if (viewer && md.trailEntity) {
                    viewer.entities.remove(md.trailEntity);
                }
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
            if (this._reloadTimer > 0) {
                state._samState = 'RELOADING';
                return;
            }

            var hasEngaging = false;
            var hasTracking = false;

            for (var i = 0; i < this._engagements.length; i++) {
                var s = this._engagements[i].state;
                if (s === STATE_ENGAGE) hasEngaging = true;
                if (s === STATE_TRACK || s === STATE_DETECT) hasTracking = true;
            }

            if (hasEngaging) {
                state._samState = 'ENGAGING';
            } else if (hasTracking) {
                state._samState = 'TRACKING';
            } else {
                state._samState = 'SEARCHING';
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
    ComponentRegistry.register('weapons', 'sam_battery', SAMBattery);
})();
