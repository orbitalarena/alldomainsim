/**
 * SpaceDomainAwareness (SDA) — monitors orbital entities for:
 *   - Conjunction warnings (close approach between satellites)
 *   - Maneuver detection (delta-V changes)
 *   - Proximity alerts (keep-out zone violations)
 *   - RSO (Resident Space Object) tracking
 *
 * Usage:
 *   SpaceDomainAwareness.init(world, viewer);
 *   SpaceDomainAwareness.update(dt, world);  // call each frame
 *
 * Exposes:
 *   SpaceDomainAwareness.getAlerts() → array of alert objects
 *   SpaceDomainAwareness.getConjunctions() → array of conjunction pairs
 *   SpaceDomainAwareness.getManeuvers() → array of detected maneuvers
 */
var SpaceDomainAwareness = (function() {
    'use strict';

    var R_EARTH = 6371000;
    var MU_EARTH = 3.986004418e14;

    // State
    var _initialized = false;
    var _world = null;
    var _viewer = null;
    var _alerts = [];
    var _conjunctions = [];
    var _maneuvers = [];
    var _lastUpdate = 0;
    var _updateInterval = 2.0; // seconds between full scans

    // Previous orbital states for maneuver detection
    var _prevStates = {}; // entityId → { sma, ecc, inc, speed, time }

    // Configuration
    var _conjunctionThreshold = 50000;  // meters — warn if closer
    var _criticalThreshold = 10000;     // meters — critical conjunction
    var _keepOutZones = [];             // { centerId, radius_m, name }
    var _maneuverDvThreshold = 5;       // m/s change to count as maneuver
    var _maxAlerts = 50;

    // Cesium visual entities for conjunction lines
    var _conjunctionLines = [];
    var MAX_CONJUNCTION_LINES = 20;

    function init(world, viewer) {
        _world = world;
        _viewer = viewer;
        _initialized = true;
        _alerts = [];
        _conjunctions = [];
        _maneuvers = [];
        _prevStates = {};

        // Create conjunction visualization lines
        if (viewer) {
            for (var i = 0; i < MAX_CONJUNCTION_LINES; i++) {
                var lineEntity = viewer.entities.add({
                    name: 'sda_conjunction_' + i,
                    polyline: {
                        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
                        width: 2,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.YELLOW.withAlpha(0.8),
                            dashLength: 8.0
                        })
                    },
                    show: false
                });
                _conjunctionLines.push(lineEntity);
            }
        }
    }

    function update(dt, world) {
        if (!_initialized || !world) return;
        _world = world;

        var now = world.simTime || 0;
        if (now - _lastUpdate < _updateInterval) return;
        _lastUpdate = now;

        _conjunctions = [];
        var newAlerts = [];

        // Collect all orbital entities
        var satellites = [];
        world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.type !== 'satellite') return;
            var s = ent.state;
            if (s.lat == null || s.lon == null) return;
            satellites.push(ent);
        });

        // Pairwise conjunction check (N^2, but N is typically <200 for custom sats)
        for (var i = 0; i < satellites.length; i++) {
            for (var j = i + 1; j < satellites.length; j++) {
                var a = satellites[i];
                var b = satellites[j];
                // Skip same-team checks if both are friendly
                // (still check — friendly collisions matter)
                var dist = _computeDistance(a.state, b.state);
                if (dist < _conjunctionThreshold) {
                    var severity = dist < _criticalThreshold ? 'critical' : 'warning';
                    _conjunctions.push({
                        entityA: a.id,
                        entityB: b.id,
                        nameA: a.name,
                        nameB: b.name,
                        distance_m: dist,
                        severity: severity,
                        time: now
                    });

                    newAlerts.push({
                        type: 'conjunction',
                        severity: severity,
                        message: severity === 'critical'
                            ? 'CRITICAL: ' + a.name + ' / ' + b.name + ' — ' + _fmtDist(dist)
                            : 'CONJUNCTION: ' + a.name + ' / ' + b.name + ' — ' + _fmtDist(dist),
                        entityIds: [a.id, b.id],
                        distance_m: dist,
                        time: now
                    });
                }
            }
        }

        // Maneuver detection: compare current orbital speed to previous
        for (var k = 0; k < satellites.length; k++) {
            var sat = satellites[k];
            var s = sat.state;
            var prev = _prevStates[sat.id];
            var curSpeed = s.speed || 0;
            var curAlt = s.alt || 0;

            if (prev) {
                var timeDelta = now - prev.time;
                if (timeDelta > 0.5) {
                    var dv = Math.abs(curSpeed - prev.speed);
                    // Also check SMA change as a more robust indicator
                    var curSMA = _estimateSMA(curSpeed, curAlt);
                    var prevSMA = prev.sma || curSMA;
                    var smaDelta = Math.abs(curSMA - prevSMA);

                    if (dv > _maneuverDvThreshold || smaDelta > 10000) {
                        // Maneuver detected
                        var maneuver = {
                            entityId: sat.id,
                            name: sat.name,
                            team: sat.team,
                            deltaV: dv,
                            smaDelta: smaDelta,
                            time: now,
                            newSMA: curSMA,
                            oldSMA: prevSMA
                        };
                        _maneuvers.push(maneuver);

                        // Keep maneuver list manageable
                        if (_maneuvers.length > 100) _maneuvers.splice(0, _maneuvers.length - 100);

                        var alertSev = sat.team === 'red' ? 'warning' : 'info';
                        newAlerts.push({
                            type: 'maneuver',
                            severity: alertSev,
                            message: 'MANEUVER: ' + sat.name + ' dV=' + dv.toFixed(1) + 'm/s, SMA ' +
                                     _fmtAlt(prevSMA - R_EARTH) + '→' + _fmtAlt(curSMA - R_EARTH),
                            entityIds: [sat.id],
                            time: now
                        });
                    }
                }
            }

            // Store current state for next comparison
            _prevStates[sat.id] = {
                speed: curSpeed,
                sma: _estimateSMA(curSpeed, curAlt),
                alt: curAlt,
                time: now
            };
        }

        // Keep-out zone checks
        for (var z = 0; z < _keepOutZones.length; z++) {
            var zone = _keepOutZones[z];
            var center = world.getEntity(zone.centerId);
            if (!center || !center.active) continue;

            for (var m = 0; m < satellites.length; m++) {
                var sat2 = satellites[m];
                if (sat2.id === zone.centerId) continue;
                if (sat2.team === center.team) continue; // Skip friendly

                var dist2 = _computeDistance(center.state, sat2.state);
                if (dist2 < zone.radius_m) {
                    newAlerts.push({
                        type: 'keepout',
                        severity: 'warning',
                        message: 'KEEP-OUT: ' + sat2.name + ' inside ' + zone.name +
                                 ' (' + _fmtDist(dist2) + ')',
                        entityIds: [zone.centerId, sat2.id],
                        distance_m: dist2,
                        time: now
                    });
                }
            }
        }

        // Merge new alerts into persistent list
        for (var n = 0; n < newAlerts.length; n++) {
            _alerts.push(newAlerts[n]);
        }
        // Trim old alerts
        if (_alerts.length > _maxAlerts) {
            _alerts.splice(0, _alerts.length - _maxAlerts);
        }

        // Update conjunction visuals
        _updateConjunctionVisuals();
    }

    /** Compute 3D distance between two entity states. */
    function _computeDistance(stateA, stateB) {
        // Use Cesium Cartesian3 for accurate 3D distance
        if (typeof Cesium !== 'undefined') {
            var posA = Cesium.Cartesian3.fromRadians(
                stateA.lon || 0, stateA.lat || 0, stateA.alt || 0);
            var posB = Cesium.Cartesian3.fromRadians(
                stateB.lon || 0, stateB.lat || 0, stateB.alt || 0);
            return Cesium.Cartesian3.distance(posA, posB);
        }
        // Fallback: Haversine + altitude difference
        var dLat = (stateB.lat || 0) - (stateA.lat || 0);
        var dLon = (stateB.lon || 0) - (stateA.lon || 0);
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(stateA.lat || 0) * Math.cos(stateB.lat || 0) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var surfDist = R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var dAlt = (stateB.alt || 0) - (stateA.alt || 0);
        return Math.sqrt(surfDist * surfDist + dAlt * dAlt);
    }

    /** Estimate SMA from speed and altitude using vis-viva. */
    function _estimateSMA(speed, alt) {
        var r = R_EARTH + alt;
        if (speed <= 0 || r <= 0) return r;
        var v2 = speed * speed;
        var sma = 1 / (2 / r - v2 / MU_EARTH);
        return sma > 0 ? sma : r;
    }

    /** Format distance for display. */
    function _fmtDist(meters) {
        if (meters < 1000) return meters.toFixed(0) + 'm';
        return (meters / 1000).toFixed(1) + 'km';
    }

    /** Format altitude for display. */
    function _fmtAlt(meters) {
        return (meters / 1000).toFixed(0) + 'km';
    }

    /** Update Cesium polylines for active conjunctions. */
    function _updateConjunctionVisuals() {
        if (!_viewer) return;

        var lineIdx = 0;
        for (var i = 0; i < _conjunctions.length && lineIdx < MAX_CONJUNCTION_LINES; i++) {
            var conj = _conjunctions[i];
            var entA = _world.getEntity(conj.entityA);
            var entB = _world.getEntity(conj.entityB);
            if (!entA || !entB) continue;

            var posA = Cesium.Cartesian3.fromRadians(
                entA.state.lon || 0, entA.state.lat || 0, entA.state.alt || 0);
            var posB = Cesium.Cartesian3.fromRadians(
                entB.state.lon || 0, entB.state.lat || 0, entB.state.alt || 0);

            var line = _conjunctionLines[lineIdx];
            line.polyline.positions = [posA, posB];
            line.polyline.material = new Cesium.PolylineDashMaterialProperty({
                color: conj.severity === 'critical'
                    ? Cesium.Color.RED.withAlpha(0.9)
                    : Cesium.Color.YELLOW.withAlpha(0.7),
                dashLength: conj.severity === 'critical' ? 4.0 : 8.0
            });
            line.show = true;
            lineIdx++;
        }

        // Hide remaining
        for (var j = lineIdx; j < _conjunctionLines.length; j++) {
            _conjunctionLines[j].show = false;
        }
    }

    /** Set conjunction warning threshold. */
    function setConjunctionThreshold(meters) {
        _conjunctionThreshold = meters;
    }

    /** Add a keep-out zone around an entity. */
    function addKeepOutZone(centerId, radius_m, name) {
        _keepOutZones.push({
            centerId: centerId,
            radius_m: radius_m,
            name: name || centerId
        });
    }

    /** Clear all keep-out zones. */
    function clearKeepOutZones() {
        _keepOutZones = [];
    }

    /** Clear all alerts. */
    function clearAlerts() {
        _alerts = [];
    }

    /** Clean up Cesium entities. */
    function destroy() {
        if (_viewer) {
            for (var i = 0; i < _conjunctionLines.length; i++) {
                _viewer.entities.remove(_conjunctionLines[i]);
            }
        }
        _conjunctionLines = [];
        _initialized = false;
    }

    return {
        init: init,
        update: update,
        destroy: destroy,
        getAlerts: function() { return _alerts; },
        getConjunctions: function() { return _conjunctions; },
        getManeuvers: function() { return _maneuvers; },
        setConjunctionThreshold: setConjunctionThreshold,
        addKeepOutZone: addKeepOutZone,
        clearKeepOutZones: clearKeepOutZones,
        clearAlerts: clearAlerts,
        setUpdateInterval: function(sec) { _updateInterval = sec; }
    };
})();
