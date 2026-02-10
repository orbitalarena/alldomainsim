/**
 * CarrierOps - ECS AI component for carrier operations.
 * Handles aircraft launch/recovery for naval carriers and sub-satellite deployment for motherships.
 *
 * Config:
 *   carrierType: 'naval' | 'orbital'
 *   airWing: [{ template: 'F/A-18E Super Hornet', count: 4, role: 'fighter' }]  (naval)
 *   subSats: [{ template: 'Satellite Inspector', count: 6 }]  (orbital)
 *   launchInterval: 10  (seconds between launches)
 *   maxAirborne: 24
 *   recoveryRadius: 5000  (meters)
 *   catapults: 2  (simultaneous launches)
 *   launchSpeedKts: 160
 *   launchAltOffset: 60  (meters above carrier)
 *   deployDeltaV: 5  (m/s for sub-sat separation)
 *   autoLaunch: false  (auto-launch CAP when threats detected)
 *   autoLaunchRange: 300000  (range in m to trigger auto-launch)
 *   capCount: 2  (number of CAP fighters to maintain airborne)
 *   capAltitude: 6000  (CAP patrol altitude in m)
 *   capRadius: 50000  (CAP patrol radius from carrier in m)
 *   strikeOnOrder: false  (queue strike packages when ordered)
 */
(function() {
    'use strict';

    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;
    var R_EARTH = 6371000;

    /** Haversine distance (meters) between two lat/lon pairs (radians). */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Great-circle bearing (radians) from p1 to p2. */
    function gcBearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brg = Math.atan2(y, x);
        if (brg < 0) brg += 2 * Math.PI;
        return brg;
    }

    /** Destination point from start, bearing (rad), distance (m). Returns {lat, lon} in rad. */
    function destinationPoint(lat1, lon1, bearing, distance) {
        var angDist = distance / R_EARTH;
        var lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(angDist) +
            Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
        );
        var lon2 = lon1 + Math.atan2(
            Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
            Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
        );
        return { lat: lat2, lon: lon2 };
    }

    // Mission types for launched aircraft
    var MISSION = {
        CAP: 'cap',           // Combat Air Patrol — loiter near carrier
        INTERCEPT: 'intercept', // Intercept specific threat
        STRIKE: 'strike',     // Attack surface target
        RECON: 'recon',       // Reconnaissance sweep
        DEPLOY: 'deploy'      // Sub-satellite deployment (orbital)
    };

    class CarrierOps extends ECS.Component {
        constructor(config) {
            super(config);

            this._carrierType = config.carrierType || 'naval';
            this._airWing = JSON.parse(JSON.stringify(config.airWing || []));  // deep copy
            this._subSats = JSON.parse(JSON.stringify(config.subSats || []));
            this._launchInterval = config.launchInterval || 10;
            this._maxAirborne = config.maxAirborne || 24;
            this._recoveryRadius = config.recoveryRadius || 5000;
            this._catapults = config.catapults || 2;
            this._launchSpeedKts = config.launchSpeedKts || 160;
            this._launchAltOffset = config.launchAltOffset || 60;
            this._deployDeltaV = config.deployDeltaV || 5;
            this._launchHeadingOffset = config.launchHeadingOffset || 0;

            // Auto-launch configuration
            this._autoLaunch = config.autoLaunch !== false; // default ON
            this._autoLaunchRange = config.autoLaunchRange || 300000;
            this._capCount = config.capCount || 2;
            this._capAltitude = config.capAltitude || 6000;
            this._capRadius = config.capRadius || 50000;

            // Runtime state
            this._launched = [];       // array of { id, mission, targetId }
            this._launchQueue = [];
            this._lastLaunchTime = -Infinity;
            this._airborne = 0;
            this._threats = [];        // detected hostile entities
            this._lastThreatCheck = 0;
            this._capLaunched = 0;     // number of CAP missions launched
            this._interceptsAssigned = new Set(); // threat IDs already assigned intercepts
        }

        init(world) {
            var wing = this._carrierType === 'orbital' ? this._subSats : this._airWing;
            var total = 0;
            for (var i = 0; i < wing.length; i++) total += (wing[i].count || 0);

            // Expose state for UI
            var s = this.entity.state;
            s._carrierReady = total;
            s._carrierAirborne = 0;
            s._carrierType = this._carrierType;
            s._carrierMaxAirborne = this._maxAirborne;
            s._carrierWing = wing;
            s._isCarrier = true;
            s._carrierThreats = 0;
            s._carrierCapCount = 0;
            s._carrierAutoLaunch = this._autoLaunch;
        }

        update(dt, world) {
            if (!this.entity || !this.entity.state) return;
            var now = world ? world.simTime : 0;

            // Threat assessment (2Hz)
            if (now - this._lastThreatCheck >= 0.5) {
                this._lastThreatCheck = now;
                this._assessThreats(world);

                // Auto-launch logic
                if (this._autoLaunch && this._carrierType === 'naval') {
                    this._autoLaunchLogic(world, now);
                }
            }

            // Process launch queue
            if (this._launchQueue.length > 0 &&
                this._airborne < this._maxAirborne &&
                (now - this._lastLaunchTime) >= this._launchInterval) {

                var simultaneous = Math.min(this._catapults, this._launchQueue.length);
                for (var i = 0; i < simultaneous; i++) {
                    var queueItem = this._launchQueue.shift();
                    if (queueItem) {
                        this._executeLaunch(queueItem, world);
                        this._lastLaunchTime = now;
                    }
                }
            }

            // Check for aircraft recovery
            this._checkRecovery(world);

            // Track launched aircraft status
            this._trackLaunched(world);

            // Update entity state for UI
            var s = this.entity.state;
            s._carrierAirborne = this._airborne;
            var wing = this._carrierType === 'orbital' ? this._subSats : this._airWing;
            var ready = 0;
            for (var j = 0; j < wing.length; j++) ready += (wing[j].count || 0);
            s._carrierReady = ready;
            s._carrierThreats = this._threats.length;
            s._carrierCapCount = this._countMission(MISSION.CAP);
            s._carrierAutoLaunch = this._autoLaunch;
        }

        /** Count airborne aircraft on a given mission type. */
        _countMission(missionType) {
            var count = 0;
            for (var i = 0; i < this._launched.length; i++) {
                if (this._launched[i].mission === missionType) count++;
            }
            return count;
        }

        /** Assess threats from carrier's sensor detections. */
        _assessThreats(world) {
            this._threats = [];
            var s = this.entity.state;
            var detections = s._detections;
            if (!detections || detections.length === 0) return;

            for (var i = 0; i < detections.length; i++) {
                var det = detections[i];
                if (!det.detected) continue;
                if (det.range_m > this._autoLaunchRange) continue;

                // Look up target to check if hostile
                var target = world.getEntity(det.targetId);
                if (!target || !target.active) continue;
                if (target.team === this.entity.team) continue;
                if (target.team === 'neutral') continue;

                this._threats.push({
                    id: det.targetId,
                    name: det.targetName,
                    range: det.range_m,
                    bearing: det.bearing_deg,
                    type: target.type,
                    isAirborne: target.type === 'aircraft' || target.type === 'satellite'
                });
            }

            // Sort by range (closest first)
            this._threats.sort(function(a, b) { return a.range - b.range; });
        }

        /** Auto-launch CAP and intercepts based on threat picture. */
        _autoLaunchLogic(world, now) {
            var s = this.entity.state;
            var wing = this._airWing;

            // 1. Maintain CAP: ensure capCount fighters are airborne on CAP
            var currentCap = this._countMission(MISSION.CAP);
            if (currentCap < this._capCount && this._airborne < this._maxAirborne) {
                // Find a fighter template to launch as CAP
                var capTemplate = this._findTemplateByRole('fighter') ||
                                  this._findTemplateByRole(null);  // any available
                if (capTemplate && capTemplate.count > 0) {
                    this._queueMissionLaunch(capTemplate.template, MISSION.CAP, null, now);
                }
            }

            // 2. Assign intercepts to unassigned airborne threats
            for (var i = 0; i < this._threats.length; i++) {
                var threat = this._threats[i];
                if (!threat.isAirborne) continue;
                if (this._interceptsAssigned.has(threat.id)) continue;
                if (this._airborne >= this._maxAirborne) break;

                // Find a fighter to launch as intercept
                var intTemplate = this._findTemplateByRole('fighter') ||
                                  this._findTemplateByRole(null);
                if (intTemplate && intTemplate.count > 0) {
                    this._queueMissionLaunch(intTemplate.template, MISSION.INTERCEPT, threat.id, now);
                    this._interceptsAssigned.add(threat.id);
                }
            }

            // Clean up intercept assignments for threats that no longer exist
            var self = this;
            this._interceptsAssigned.forEach(function(threatId) {
                var stillExists = false;
                for (var j = 0; j < self._threats.length; j++) {
                    if (self._threats[j].id === threatId) { stillExists = true; break; }
                }
                if (!stillExists) self._interceptsAssigned.delete(threatId);
            });
        }

        /** Find a wing template with available count, optionally filtered by role. */
        _findTemplateByRole(role) {
            for (var i = 0; i < this._airWing.length; i++) {
                var entry = this._airWing[i];
                if (entry.count <= 0) continue;
                if (role && entry.role && entry.role !== role) continue;
                return entry;
            }
            return null;
        }

        /** Queue a mission-specific launch. */
        _queueMissionLaunch(templateName, mission, targetId, now) {
            this._launchQueue.push({
                template: templateName,
                overrides: {},
                queueTime: Date.now(),
                mission: mission,
                targetId: targetId
            });
        }

        /** Queue a launch of given template. */
        queueLaunch(templateName, overrides) {
            this._launchQueue.push({
                template: templateName,
                overrides: overrides || {},
                queueTime: Date.now(),
                mission: MISSION.CAP
            });
        }

        /** Launch all ready assets of given type (or all types if null). */
        launchAll(templateName) {
            var wing = this._carrierType === 'orbital' ? this._subSats : this._airWing;
            for (var i = 0; i < wing.length; i++) {
                if (!templateName || wing[i].template === templateName) {
                    for (var j = 0; j < (wing[i].count || 0); j++) {
                        this.queueLaunch(wing[i].template, {});
                    }
                }
            }
        }

        /** Toggle auto-launch on/off. */
        setAutoLaunch(enabled) {
            this._autoLaunch = enabled;
            if (this.entity && this.entity.state) {
                this.entity.state._carrierAutoLaunch = enabled;
            }
        }

        _executeLaunch(queueItem, world) {
            if (!world || !world.viewer) return;

            var isOrbital = this._carrierType === 'orbital';
            var def = isOrbital
                ? this._buildOrbitalDef(queueItem)
                : this._buildNavalDef(queueItem, world);

            if (!def) return;

            // Use ScenarioLoader.addEntity if available
            if (typeof ScenarioLoader !== 'undefined' && ScenarioLoader.addEntity) {
                var newEntity = ScenarioLoader.addEntity(world, def, world.viewer);
                if (newEntity) {
                    this._launched.push({
                        id: newEntity.id,
                        mission: queueItem.mission || MISSION.CAP,
                        targetId: queueItem.targetId || null,
                        launchTime: world.simTime || 0
                    });
                    this._airborne++;

                    // Decrement from wing
                    var wing = isOrbital ? this._subSats : this._airWing;
                    for (var i = 0; i < wing.length; i++) {
                        if (wing[i].template === queueItem.template && wing[i].count > 0) {
                            wing[i].count--;
                            break;
                        }
                    }
                }
            }
        }

        _buildNavalDef(queueItem, world) {
            var ent = this.entity;
            var s = ent.state;
            var overrides = queueItem.overrides || {};
            var num = this._launched.length + 1;
            var mission = queueItem.mission || MISSION.CAP;

            var heading = ((s.heading || 0) * RAD) + this._launchHeadingOffset;
            var speedMs = this._launchSpeedKts * 0.514444;
            var alt = (s.alt || 0) + this._launchAltOffset;
            var latDeg = s.lat != null ? s.lat * RAD : 0;
            var lonDeg = s.lon != null ? s.lon * RAD : 0;

            // Offset slightly forward of carrier (500m in heading direction)
            var offsetM = 500;
            latDeg += (offsetM * Math.cos(heading * DEG) / R_EARTH) * RAD;
            lonDeg += (offsetM * Math.sin(heading * DEG) / (R_EARTH * Math.cos(s.lat || 0.01))) * RAD;

            // Look up template for components
            var template = _resolveTemplate(queueItem.template);
            var components = template ? JSON.parse(JSON.stringify(template.components)) : {
                physics: { type: 'flight3dof', config: 'f18' },
                control: { type: 'player_input', config: 'fighter' },
                sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 60 },
                weapons: { type: 'a2a_missile', loadout: [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, Pk: 0.75, speed: 1200, flightTime: 40 }
                ], engagementRules: 'weapons_free' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 10, trail: true }
            };

            // Assign AI based on mission type
            this._assignMissionAI(components, mission, queueItem.targetId, s, world);

            // Mission-specific name prefix
            var missionNames = {
                cap: 'CAP', intercept: 'INT', strike: 'STK', recon: 'RCN', deploy: 'DEP'
            };
            var prefix = missionNames[mission] || 'AIR';

            return {
                id: ent.id + '_' + prefix.toLowerCase() + '_' + num + '_' + Date.now(),
                name: overrides.name || (ent.name + ' ' + prefix + ' ' + num),
                type: 'aircraft',
                team: overrides.team || ent.team || 'blue',
                initialState: {
                    lat: latDeg,
                    lon: lonDeg,
                    alt: alt,
                    speed: speedMs,
                    heading: overrides.heading || heading,
                    gamma: 5,  // slight climb after catapult
                    throttle: 0.9,
                    engineOn: true,
                    gearDown: false,
                    infiniteFuel: true
                },
                components: components,
                _custom: {
                    launchedFrom: ent.id,
                    carrierRecoverable: true,
                    mission: mission,
                    templateName: queueItem.template
                }
            };
        }

        /** Assign AI component based on mission type. */
        _assignMissionAI(components, mission, targetId, carrierState, world) {
            // Remove existing control/ai to replace with mission AI
            delete components.control;

            if (mission === MISSION.INTERCEPT && targetId) {
                // Direct intercept of a specific target
                components.ai = {
                    type: 'intercept',
                    targetId: targetId,
                    mode: 'lead',
                    engageRange_m: 80000,
                    disengageRange_m: 200000,
                    maxSpeed: 350
                };
            } else if (mission === MISSION.CAP) {
                // CAP: patrol racetrack around carrier
                var cLat = carrierState.lat != null ? carrierState.lat * RAD : 0;
                var cLon = carrierState.lon != null ? carrierState.lon * RAD : 0;
                var cHeading = (carrierState.heading || 0) * RAD;
                var capAlt = this._capAltitude;
                var capR = this._capRadius;

                // Build 4-point racetrack ahead of carrier
                var fwd = destinationPoint(carrierState.lat || 0, carrierState.lon || 0,
                    carrierState.heading || 0, capR);
                var left = destinationPoint(fwd.lat, fwd.lon,
                    (carrierState.heading || 0) + Math.PI / 2, capR / 2);
                var right = destinationPoint(fwd.lat, fwd.lon,
                    (carrierState.heading || 0) - Math.PI / 2, capR / 2);
                var rear = destinationPoint(carrierState.lat || 0, carrierState.lon || 0,
                    (carrierState.heading || 0) + Math.PI, capR * 0.3);

                components.ai = {
                    type: 'waypoint_patrol',
                    waypoints: [
                        { lat: fwd.lat * RAD, lon: fwd.lon * RAD, alt: capAlt, speed: 250 },
                        { lat: left.lat * RAD, lon: left.lon * RAD, alt: capAlt, speed: 250 },
                        { lat: rear.lat * RAD, lon: rear.lon * RAD, alt: capAlt, speed: 250 },
                        { lat: right.lat * RAD, lon: right.lon * RAD, alt: capAlt, speed: 250 }
                    ],
                    loopMode: 'cycle'
                };
            } else if (mission === MISSION.STRIKE) {
                // Strike: fly to target area then patrol
                if (targetId && world) {
                    var target = world.getEntity(targetId);
                    if (target && target.state) {
                        var tLat = target.state.lat || 0;
                        var tLon = target.state.lon || 0;
                        components.ai = {
                            type: 'intercept',
                            targetId: targetId,
                            mode: 'pursuit',
                            engageRange_m: 100000,
                            disengageRange_m: 300000,
                            maxSpeed: 300
                        };
                    }
                }
                if (!components.ai) {
                    // Fallback: waypoint patrol forward of carrier
                    components.ai = { type: 'waypoint_patrol', waypoints: [], loopMode: 'once' };
                }
            } else {
                // Default: basic patrol
                components.ai = {
                    type: 'waypoint_patrol',
                    waypoints: [],
                    loopMode: 'cycle'
                };
            }
        }

        _buildOrbitalDef(queueItem) {
            var ent = this.entity;
            var s = ent.state;
            var overrides = queueItem.overrides || {};
            var num = this._launched.length + 1;

            var template = _resolveTemplate(queueItem.template);
            var components = template ? JSON.parse(JSON.stringify(template.components)) : {
                physics: { type: 'orbital_2body' },
                visual: { type: 'satellite', color: overrides.color || '#88aaff', pixelSize: 8 }
            };

            return {
                id: ent.id + '_sat_' + num + '_' + Date.now(),
                name: overrides.name || (ent.name + ' SubSat ' + num),
                type: 'satellite',
                team: overrides.team || ent.team || 'blue',
                initialState: {
                    lat: s.lat != null ? s.lat * RAD : 0,
                    lon: s.lon != null ? s.lon * RAD : 0,
                    alt: s.alt || 400000,
                    speed: s.speed || 7660,
                    heading: s.heading != null ? s.heading * RAD : 0,
                    gamma: s.gamma != null ? s.gamma * RAD : 0
                },
                components: components,
                _custom: {
                    launchedFrom: ent.id,
                    deployDeltaV: this._deployDeltaV,
                    mothershipRecoverable: false,
                    templateName: queueItem.template
                }
            };
        }

        /** Track status of launched aircraft — detect destroyed/disengaged. */
        _trackLaunched(world) {
            if (!world || !world.entities) return;

            for (var i = this._launched.length - 1; i >= 0; i--) {
                var entry = this._launched[i];
                var ent = world.entities.get(entry.id);

                if (!ent || !ent.state || !ent.active) {
                    // Entity destroyed or removed
                    this._launched.splice(i, 1);
                    this._airborne = Math.max(0, this._airborne - 1);
                    this._interceptsAssigned.delete(entry.targetId);
                    continue;
                }

                // For intercept missions: check if target is gone → convert to CAP
                if (entry.mission === MISSION.INTERCEPT && entry.targetId) {
                    var target = world.entities.get(entry.targetId);
                    if (!target || !target.active) {
                        // Target destroyed — reassign to CAP (the AI will handle it)
                        entry.mission = MISSION.CAP;
                        entry.targetId = null;
                        this._interceptsAssigned.delete(entry.targetId);
                    }
                }
            }
        }

        _checkRecovery(world) {
            if (!world || !world.entities) return;
            var s = this.entity.state;
            var cLat = s.lat || 0;
            var cLon = s.lon || 0;

            for (var i = this._launched.length - 1; i >= 0; i--) {
                var entry = this._launched[i];
                var launched = world.entities.get(entry.id);
                if (!launched || !launched.state) {
                    this._launched.splice(i, 1);
                    this._airborne = Math.max(0, this._airborne - 1);
                    continue;
                }

                // Check if marked for recovery and within radius
                if (launched.state._requestRecovery) {
                    var dist = haversineDistance(cLat, cLon,
                        launched.state.lat || 0, launched.state.lon || 0);

                    if (dist < this._recoveryRadius) {
                        this._launched.splice(i, 1);
                        this._airborne = Math.max(0, this._airborne - 1);
                        launched.state._recovered = true;
                        launched.state.alive = false;

                        // Add back to wing
                        var wing = this._carrierType === 'orbital' ? this._subSats : this._airWing;
                        var templateName = launched._custom && launched._custom.templateName;
                        var found = false;
                        for (var j = 0; j < wing.length; j++) {
                            if (wing[j].template === templateName) {
                                wing[j].count++;
                                found = true;
                                break;
                            }
                        }
                        if (!found && wing.length > 0) wing[0].count++;
                    }
                }
            }
        }
    }

    // Resolve template name from ObjectPalette or known aircraft presets
    function _resolveTemplate(name) {
        if (typeof ObjectPalette !== 'undefined' && ObjectPalette.getTemplates) {
            var templates = ObjectPalette.getTemplates();
            for (var i = 0; i < templates.length; i++) {
                if (templates[i].name === name) return templates[i];
            }
        }
        // Fallback aircraft configs by common names
        var FALLBACK_CONFIGS = {
            'f18': 'f18', 'f16': 'f16', 'f22': 'f22', 'f35': 'f35',
            'su27': 'su27', 'su35': 'su35', 'mig29': 'mig29'
        };
        var configKey = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (var key in FALLBACK_CONFIGS) {
            if (configKey.indexOf(key) !== -1) {
                return {
                    components: {
                        physics: { type: 'flight3dof', config: FALLBACK_CONFIGS[key] },
                        control: { type: 'player_input', config: 'fighter' },
                        sensors: { type: 'radar', maxRange_m: 120000, fov_deg: 120, scanRate_dps: 60 },
                        visual: { type: 'point', color: '#4488ff', pixelSize: 10, trail: true }
                    }
                };
            }
        }
        return null;
    }

    // Register with ECS
    ComponentRegistry.register('ai', 'carrier_ops', CarrierOps);

    // Export for direct access
    window.CarrierOps = CarrierOps;
})();
