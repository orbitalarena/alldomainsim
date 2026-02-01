/**
 * AnalysisOverlay — Post-run analysis overlays rendered on the Cesium globe.
 *
 * Provides:
 * 1. Coverage Heat Map — grid of detection probability based on radar positions
 * 2. Engagement Timeline — summary table of all engagements that occurred
 * 3. Track History — polyline paths showing where entities traveled
 * 4. Kill/Miss Markers — point markers at engagement result locations
 *
 * Activates when mode switches to ANALYZE. Reads from the recorded
 * simulation history stored during RUN mode.
 */
var AnalysisOverlay = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    var RAD = 180 / Math.PI;
    var DEG = Math.PI / 180;
    var SAMPLE_INTERVAL = 1.0;   // seconds between position samples
    var GRID_SPACING_DEG = 0.1;  // ~10 km grid cells
    var MAX_GRID_CELLS = 50;     // max cells per axis
    var EXPAND_KM = 50;          // bounding box expansion in km
    var EXPAND_DEG = EXPAND_KM / 111.0; // rough km-to-deg conversion

    // Team colors for track history
    var TRACK_COLORS = {
        blue:    '#4488ff',
        red:     '#ff4444',
        neutral: '#88ff88',
        green:   '#88ff88'
    };

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _viewer = null;
    var _overlayEntities = [];       // Cesium entities to remove on deactivate
    var _trackHistory = new Map();   // entityId -> [{ lat, lon, alt, t }]  (radians)
    var _engagementLog = [];         // [{ time, samId, samName, targetId, targetName, result, lat, lon, alt, range }]
    var _isActive = false;
    var _isRecording = false;
    var _lastWallTime = 0;
    var _lastSampleTime = {};        // entityId -> last simTime sampled
    var _prevSamStates = {};         // entityId -> previous _samState value
    var _prevA2AStates = {};         // entityId -> previous _a2aState value
    var _pendingEngagements = {};    // entityId -> { time, samId, samName, targetId, targetName, lat, lon, alt }
    var _pendingA2AEngagements = {}; // entityId -> { time, sourceId, sourceName, targetId, targetName }
    var _summaryPanel = null;        // DOM element for engagement summary
    var _combatStatsPanel = null;    // DOM element for combat statistics

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Store the Cesium viewer reference.
     * @param {Cesium.Viewer} viewer
     */
    function init(viewer) {
        _viewer = viewer;
    }

    /**
     * Begin recording entity positions and engagement states.
     * Call when entering RUN mode.
     * @param {ECS.World} world
     */
    function startRecording(world) {
        _trackHistory = new Map();
        _engagementLog = [];
        _lastSampleTime = {};
        _prevSamStates = {};
        _prevA2AStates = {};
        _pendingEngagements = {};
        _pendingA2AEngagements = {};
        _isRecording = true;

        // Take an initial sample of all entity positions
        _samplePositions(world, 0);
    }

    /**
     * Record one simulation tick. Call each frame during RUN mode.
     * Samples positions at ~1 Hz and watches for engagement state changes.
     * @param {ECS.World} world
     */
    var _recordAccum = 0;
    var _RECORD_INTERVAL = 0.5;  // 2 Hz entity iteration instead of every frame

    function recordTick(world) {
        if (!_isRecording) return;

        _recordAccum += world.wallTime !== undefined ?
            (world.wallTime - (_lastWallTime || 0)) : 0.016;
        _lastWallTime = world.wallTime;

        if (_recordAccum < _RECORD_INTERVAL) return;
        _recordAccum = 0;

        var simTime = world.simTime;

        // Sample positions at ~1 Hz per entity
        _samplePositions(world, simTime);

        // Watch for engagement state changes
        _watchEngagements(world, simTime);
    }

    /**
     * Stop recording. Call when leaving RUN mode.
     */
    function stopRecording() {
        _isRecording = false;
    }

    /**
     * Show all analysis overlays on the globe.
     * Builds coverage heat map, track history, engagement markers, and summary panel.
     */
    function activate() {
        if (!_viewer) return;
        if (_isActive) deactivate();

        _isActive = true;

        _buildTrackHistory();
        _buildCoverageHeatMap();
        _buildEngagementMarkers();
        _buildEngagementSummary();
        _buildCombatStats();
    }

    /**
     * Remove all overlay entities and hide the summary panel.
     */
    function deactivate() {
        if (!_viewer) return;

        // Remove all Cesium entities we added
        for (var i = 0; i < _overlayEntities.length; i++) {
            _viewer.entities.remove(_overlayEntities[i]);
        }
        _overlayEntities = [];

        // Hide summary panel
        if (_summaryPanel) {
            _summaryPanel.style.display = 'none';
        }
        if (_combatStatsPanel) {
            _combatStatsPanel.style.display = 'none';
        }

        _isActive = false;
    }

    /**
     * Return the engagement event log array.
     * @returns {Array}
     */
    function getEngagementLog() {
        return _engagementLog.slice();
    }

    // -------------------------------------------------------------------
    // Recording Internals
    // -------------------------------------------------------------------

    /**
     * Sample positions of all active entities, throttled to ~1 Hz per entity.
     */
    function _samplePositions(world, simTime) {
        world.entities.forEach(function(entity) {
            if (!entity.active) return;

            var id = entity.id;
            var lastTime = _lastSampleTime[id];

            // Only record if >= SAMPLE_INTERVAL since last sample for this entity
            if (lastTime !== undefined && (simTime - lastTime) < SAMPLE_INTERVAL) return;

            var s = entity.state;
            if (s.lat === undefined || s.lon === undefined) return;

            // Initialize track array if needed
            if (!_trackHistory.has(id)) {
                _trackHistory.set(id, {
                    team: entity.team,
                    name: entity.name,
                    type: entity.type,
                    destroyed: false,
                    points: []
                });
            }

            var record = _trackHistory.get(id);
            record.points.push({
                lat: s.lat,   // stored in radians (framework convention during RUN)
                lon: s.lon,
                alt: s.alt || 0,
                t: simTime
            });

            _lastSampleTime[id] = simTime;
        });
    }

    /**
     * Watch for SAM engagement state transitions on weapon-bearing entities.
     */
    function _watchEngagements(world, simTime) {
        world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var s = entity.state;
            if (!s._samState) return;

            var id = entity.id;
            var prevState = _prevSamStates[id] || 'IDLE';
            var currentState = s._samState;

            // Detect transition to ENGAGING
            if (currentState === 'ENGAGING' && prevState !== 'ENGAGING') {
                var targetId = s._samTargetId || 'unknown';
                var targetEntity = world.getEntity(targetId);
                var targetName = targetEntity ? targetEntity.name : targetId;
                var targetState = targetEntity ? targetEntity.state : null;

                _pendingEngagements[id] = {
                    time: simTime,
                    samId: id,
                    samName: entity.name,
                    targetId: targetId,
                    targetName: targetName,
                    samLat: s.lat,
                    samLon: s.lon,
                    samAlt: s.alt || 0
                };

                // Log the launch event
                _engagementLog.push({
                    time: simTime,
                    samId: id,
                    samName: entity.name,
                    targetId: targetId,
                    targetName: targetName,
                    result: 'LAUNCH',
                    lat: s.lat,
                    lon: s.lon,
                    alt: s.alt || 0,
                    range: _computeRange(s, targetState)
                });
            }

            // Detect engagement result (KILL or MISS)
            if (s._samEngagementResult && s._samEngagementResult !== 'PENDING') {
                var resultStr = s._samEngagementResult;
                var pending = _pendingEngagements[id];

                if (pending) {
                    var tgtEntity = world.getEntity(pending.targetId);
                    var tgtState = tgtEntity ? tgtEntity.state : null;

                    // Use target's last known position for result location
                    var resultLat = tgtState ? tgtState.lat : pending.samLat;
                    var resultLon = tgtState ? tgtState.lon : pending.samLon;
                    var resultAlt = tgtState ? (tgtState.alt || 0) : pending.samAlt;

                    _engagementLog.push({
                        time: simTime,
                        samId: id,
                        samName: pending.samName,
                        targetId: pending.targetId,
                        targetName: pending.targetName,
                        result: resultStr,
                        lat: resultLat,
                        lon: resultLon,
                        alt: resultAlt,
                        range: _computeRange(s, tgtState)
                    });

                    // Mark target track as destroyed if KILL
                    if (resultStr === 'KILL' && _trackHistory.has(pending.targetId)) {
                        _trackHistory.get(pending.targetId).destroyed = true;
                    }

                    delete _pendingEngagements[id];
                }

                // Clear the result so we can detect the next engagement
                s._samEngagementResult = null;
            }

            _prevSamStates[id] = currentState;
        });

        // Watch for A2A missile engagement state transitions
        world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var s = entity.state;
            if (!s._a2aState) return;

            var id = entity.id;
            var prevState = _prevA2AStates[id] || 'SEARCHING';
            var currentState = s._a2aState;

            // Detect transition to ENGAGING (missile launched)
            if (currentState === 'ENGAGING' && prevState !== 'ENGAGING') {
                // Find the active engagement to get target info
                var engagements = s._a2aEngagements || [];
                for (var ei = 0; ei < engagements.length; ei++) {
                    var eng = engagements[ei];
                    if (eng.state === 'GUIDE' || eng.state === 'FIRE') {
                        var targetEntity = world.getEntity(eng.targetId);
                        var targetName = targetEntity ? targetEntity.name : eng.targetId;
                        var targetState = targetEntity ? targetEntity.state : null;

                        _pendingA2AEngagements[id + '_' + eng.targetId] = {
                            time: simTime,
                            sourceId: id,
                            sourceName: entity.name,
                            sourceTeam: entity.team,
                            targetId: eng.targetId,
                            targetName: targetName,
                            weaponType: eng.weaponType
                        };

                        _engagementLog.push({
                            time: simTime,
                            sourceId: id,
                            sourceName: entity.name,
                            sourceType: 'aircraft',
                            targetId: eng.targetId,
                            targetName: targetName,
                            result: 'LAUNCH',
                            weaponType: eng.weaponType || 'A2A',
                            lat: s.lat,
                            lon: s.lon,
                            alt: s.alt || 0,
                            range: _computeRange(s, targetState)
                        });
                    }
                }
            }

            // Check for completed engagements (KILL or MISS results)
            var engagements = s._a2aEngagements || [];
            for (var ei = 0; ei < engagements.length; ei++) {
                var eng = engagements[ei];
                if (eng.result && (eng.result === 'KILL' || eng.result === 'MISS')) {
                    var pendingKey = id + '_' + eng.targetId;
                    if (_pendingA2AEngagements[pendingKey]) {
                        var pending = _pendingA2AEngagements[pendingKey];
                        var tgtEntity = world.getEntity(eng.targetId);
                        var tgtState = tgtEntity ? tgtEntity.state : null;

                        var resultLat = tgtState ? tgtState.lat : s.lat;
                        var resultLon = tgtState ? tgtState.lon : s.lon;
                        var resultAlt = tgtState ? (tgtState.alt || 0) : (s.alt || 0);

                        _engagementLog.push({
                            time: simTime,
                            sourceId: id,
                            sourceName: pending.sourceName,
                            sourceType: 'aircraft',
                            targetId: eng.targetId,
                            targetName: pending.targetName,
                            result: eng.result,
                            weaponType: pending.weaponType || 'A2A',
                            lat: resultLat,
                            lon: resultLon,
                            alt: resultAlt,
                            range: _computeRange(s, tgtState)
                        });

                        if (eng.result === 'KILL' && _trackHistory.has(eng.targetId)) {
                            _trackHistory.get(eng.targetId).destroyed = true;
                        }

                        delete _pendingA2AEngagements[pendingKey];
                    }
                }
            }

            _prevA2AStates[id] = currentState;
        });
    }

    /**
     * Compute slant range between two entity states (both in radians).
     * Returns range in meters, or 0 if states are unavailable.
     */
    function _computeRange(stateA, stateB) {
        if (!stateA || !stateB) return 0;
        if (stateA.lat === undefined || stateB.lat === undefined) return 0;

        var R = 6371000; // Earth mean radius
        var latA = stateA.lat;
        var lonA = stateA.lon;
        var altA = stateA.alt || 0;
        var latB = stateB.lat;
        var lonB = stateB.lon;
        var altB = stateB.alt || 0;

        // Great circle distance on surface
        var dLat = latB - latA;
        var dLon = lonB - lonA;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(latA) * Math.cos(latB) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var surfaceDist = R * c;

        // Include altitude difference for slant range
        var dAlt = altB - altA;
        return Math.sqrt(surfaceDist * surfaceDist + dAlt * dAlt);
    }

    // -------------------------------------------------------------------
    // Overlay Builders
    // -------------------------------------------------------------------

    /**
     * Build polyline track history for each recorded entity.
     */
    function _buildTrackHistory() {
        _trackHistory.forEach(function(record, entityId) {
            var points = record.points;
            if (points.length < 2) return;

            var positions = [];
            for (var i = 0; i < points.length; i++) {
                var p = points[i];
                var cart = Cesium.Cartesian3.fromRadians(p.lon, p.lat, p.alt);
                // Guard against NaN positions reaching Cesium
                if (isNaN(cart.x) || isNaN(cart.y) || isNaN(cart.z)) continue;
                positions.push(cart);
            }

            if (positions.length < 2) return;

            var colorStr = TRACK_COLORS[record.team] || TRACK_COLORS.neutral;
            var cesiumColor = Cesium.Color.fromCssColorString(colorStr);

            // Use dashed line for destroyed entities
            var material;
            if (record.destroyed) {
                material = new Cesium.PolylineDashMaterialProperty({
                    color: cesiumColor.withAlpha(0.6),
                    dashLength: 12.0
                });
            } else {
                material = cesiumColor.withAlpha(0.8);
            }

            // Clamp ground/aircraft to ground, absolute for satellites
            var clampToGround = (record.type !== 'satellite');

            var entity = _viewer.entities.add({
                polyline: {
                    positions: positions,
                    width: 2,
                    material: material,
                    clampToGround: clampToGround
                },
                label: {
                    text: record.name,
                    font: '10px monospace',
                    fillColor: cesiumColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -10),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    scale: 0.8,
                    show: false  // only show on hover (future enhancement)
                }
            });

            _overlayEntities.push(entity);
        });
    }

    /**
     * Build a grid of rectangles showing radar sensor coverage.
     * Colors cells by how many radar sensors can reach each cell center.
     */
    function _buildCoverageHeatMap() {
        // Collect all ground/sensor entities that have radar coverage
        var sensorRecords = [];
        _trackHistory.forEach(function(record, entityId) {
            // Only ground-type entities with recorded positions
            if (record.type !== 'ground') return;
            if (record.points.length === 0) return;

            // Use the first recorded position (ground stations don't move)
            var p = record.points[0];
            sensorRecords.push({
                lat: p.lat * RAD,  // convert to degrees for grid math
                lon: p.lon * RAD,
                entityId: entityId
            });
        });

        if (sensorRecords.length === 0) return;

        // Look up sensor ranges from the engagement log or use defaults.
        // We scan the original scenario data if available, otherwise use a default.
        var sensorRanges = {};  // entityId -> range_m
        _trackHistory.forEach(function(record, entityId) {
            if (record.type !== 'ground') return;
            // Default radar range: 150 km
            sensorRanges[entityId] = 150000;
        });

        // Try to read sensor component ranges from scenario data
        if (typeof BuilderApp !== 'undefined') {
            var scenarioData = BuilderApp.getScenarioData();
            if (scenarioData && scenarioData.entities) {
                for (var ei = 0; ei < scenarioData.entities.length; ei++) {
                    var eDef = scenarioData.entities[ei];
                    if (eDef.components && eDef.components.sensors && eDef.components.sensors.maxRange_m) {
                        sensorRanges[eDef.id] = eDef.components.sensors.maxRange_m;
                    }
                }
            }
        }

        // Compute bounding box of all sensor positions, expanded by EXPAND_DEG
        var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        for (var si = 0; si < sensorRecords.length; si++) {
            var sr = sensorRecords[si];
            if (sr.lat < minLat) minLat = sr.lat;
            if (sr.lat > maxLat) maxLat = sr.lat;
            if (sr.lon < minLon) minLon = sr.lon;
            if (sr.lon > maxLon) maxLon = sr.lon;
        }

        minLat -= EXPAND_DEG;
        maxLat += EXPAND_DEG;
        minLon -= EXPAND_DEG;
        maxLon += EXPAND_DEG;

        // Clamp to valid bounds
        minLat = Math.max(minLat, -89.9);
        maxLat = Math.min(maxLat, 89.9);
        minLon = Math.max(minLon, -180);
        maxLon = Math.min(maxLon, 180);

        // Compute grid dimensions, capped at MAX_GRID_CELLS per axis
        var latSpan = maxLat - minLat;
        var lonSpan = maxLon - minLon;
        var nLat = Math.min(Math.ceil(latSpan / GRID_SPACING_DEG), MAX_GRID_CELLS);
        var nLon = Math.min(Math.ceil(lonSpan / GRID_SPACING_DEG), MAX_GRID_CELLS);

        if (nLat < 1) nLat = 1;
        if (nLon < 1) nLon = 1;

        var cellLatSize = latSpan / nLat;
        var cellLonSize = lonSpan / nLon;

        // Coverage colors by sensor count
        // 0 sensors: transparent (skip), 1: blue, 2: green, 3+: yellow
        var coverageColors = [
            null,                                       // 0 — no entity
            new Cesium.Color(40 / 255, 40 / 255, 200 / 255, 0.2),  // 1 sensor
            new Cesium.Color(40 / 255, 200 / 255, 40 / 255, 0.3),  // 2 sensors
            new Cesium.Color(200 / 255, 200 / 255, 40 / 255, 0.4)  // 3+ sensors
        ];

        // Build grid cells
        for (var row = 0; row < nLat; row++) {
            for (var col = 0; col < nLon; col++) {
                var cellSouth = minLat + row * cellLatSize;
                var cellNorth = cellSouth + cellLatSize;
                var cellWest = minLon + col * cellLonSize;
                var cellEast = cellWest + cellLonSize;

                // Cell center
                var centerLat = (cellSouth + cellNorth) / 2;
                var centerLon = (cellWest + cellEast) / 2;

                // Count how many sensors can detect a target at cell center
                var count = 0;
                for (var s = 0; s < sensorRecords.length; s++) {
                    var sensor = sensorRecords[s];
                    var range = sensorRanges[sensor.entityId] || 150000;

                    // Great circle distance from sensor to cell center (approx)
                    var dLat = (centerLat - sensor.lat) * DEG;
                    var dLon = (centerLon - sensor.lon) * DEG;
                    var avgLat = (centerLat + sensor.lat) / 2 * DEG;
                    var dx = dLon * Math.cos(avgLat) * 6371000;
                    var dy = dLat * 6371000;
                    var dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist <= range) {
                        count++;
                    }
                }

                if (count === 0) continue;

                // Pick color (cap at 3+)
                var colorIdx = Math.min(count, 3);
                var cellColor = coverageColors[colorIdx];

                var cellEntity = _viewer.entities.add({
                    rectangle: {
                        coordinates: Cesium.Rectangle.fromDegrees(cellWest, cellSouth, cellEast, cellNorth),
                        material: cellColor,
                        outline: false,
                        height: 0,
                        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND
                    }
                });

                _overlayEntities.push(cellEntity);
            }
        }
    }

    /**
     * Build point markers at engagement locations (launches, kills, misses).
     */
    function _buildEngagementMarkers() {
        for (var i = 0; i < _engagementLog.length; i++) {
            var eng = _engagementLog[i];
            var lat = eng.lat;
            var lon = eng.lon;
            var alt = eng.alt || 0;

            // lat/lon are in radians (recorded from entity.state during RUN)
            var position = Cesium.Cartesian3.fromRadians(lon, lat, alt);
            if (isNaN(position.x) || isNaN(position.y) || isNaN(position.z)) continue;

            var entity = null;

            if (eng.result === 'KILL') {
                // Red X marker at target's last known position
                entity = _viewer.entities.add({
                    position: position,
                    point: {
                        pixelSize: 14,
                        color: Cesium.Color.RED,
                        outlineColor: Cesium.Color.DARKRED,
                        outlineWidth: 2,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    },
                    label: {
                        text: 'X ' + eng.targetName,
                        font: '12px monospace',
                        fillColor: Cesium.Color.RED,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(12, 0),
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 0.9
                    }
                });
            } else if (eng.result === 'MISS') {
                // Yellow point at engagement position
                entity = _viewer.entities.add({
                    position: position,
                    point: {
                        pixelSize: 10,
                        color: Cesium.Color.YELLOW,
                        outlineColor: Cesium.Color.DARKORANGE,
                        outlineWidth: 1,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    },
                    label: {
                        text: 'MISS',
                        font: '10px monospace',
                        fillColor: Cesium.Color.YELLOW,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(10, 0),
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 0.8
                    }
                });
            } else if (eng.result === 'LAUNCH') {
                // Small blue triangle at SAM position
                entity = _viewer.entities.add({
                    position: position,
                    point: {
                        pixelSize: 8,
                        color: Cesium.Color.CORNFLOWERBLUE,
                        outlineColor: Cesium.Color.BLUE,
                        outlineWidth: 1,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY
                    },
                    label: {
                        text: 'LCH',
                        font: '9px monospace',
                        fillColor: Cesium.Color.CORNFLOWERBLUE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(8, 0),
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        disableDepthTestDistance: Number.POSITIVE_INFINITY,
                        scale: 0.7
                    }
                });
            }

            if (entity) {
                _overlayEntities.push(entity);
            }
        }
    }

    /**
     * Build or show the engagement summary DOM panel (bottom-left overlay).
     */
    function _buildEngagementSummary() {
        // Create the panel if it doesn't exist yet
        if (!_summaryPanel) {
            _summaryPanel = document.createElement('div');
            _summaryPanel.id = 'analysisEngagementSummary';
            _summaryPanel.style.cssText = [
                'position: fixed',
                'bottom: 60px',
                'left: 20px',
                'z-index: 150',
                'background: rgba(10, 10, 30, 0.92)',
                'border: 1px solid #334',
                'border-radius: 4px',
                'padding: 10px 14px',
                'font-family: monospace',
                'font-size: 12px',
                'color: #ccc',
                'max-height: 300px',
                'max-width: 520px',
                'overflow-y: auto',
                'pointer-events: auto',
                'box-shadow: 0 2px 12px rgba(0,0,0,0.5)'
            ].join('; ');

            document.body.appendChild(_summaryPanel);
        }

        // Build content
        var html = '<div style="color:#0af; font-weight:bold; margin-bottom:8px; font-size:13px;">' +
                   'ENGAGEMENT SUMMARY</div>';

        // Filter to only KILL, MISS, and LAUNCH events for the table
        var events = _engagementLog;

        if (events.length === 0) {
            html += '<div style="color:#666;">No engagements recorded.</div>';
        } else {
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += '<tr style="color:#888; border-bottom:1px solid #333;">' +
                    '<th style="text-align:left; padding:3px 6px;">Time</th>' +
                    '<th style="text-align:left; padding:3px 6px;">SAM</th>' +
                    '<th style="text-align:left; padding:3px 6px;">Target</th>' +
                    '<th style="text-align:left; padding:3px 6px;">Result</th>' +
                    '<th style="text-align:right; padding:3px 6px;">Range</th>' +
                    '</tr>';

            for (var i = 0; i < events.length; i++) {
                var e = events[i];

                // Format time as MM:SS
                var mins = Math.floor(e.time / 60);
                var secs = Math.floor(e.time % 60);
                var timeStr = (mins < 10 ? '0' : '') + mins + ':' +
                              (secs < 10 ? '0' : '') + secs;

                // Format range
                var rangeStr = '---';
                if (e.range > 0) {
                    if (e.range >= 1000) {
                        rangeStr = (e.range / 1000).toFixed(1) + ' km';
                    } else {
                        rangeStr = Math.round(e.range) + ' m';
                    }
                }

                // Result color
                var resultColor = '#ccc';
                if (e.result === 'KILL') resultColor = '#ff4444';
                else if (e.result === 'MISS') resultColor = '#ffcc00';
                else if (e.result === 'LAUNCH') resultColor = '#4488ff';

                var rowBg = (i % 2 === 0) ? 'rgba(255,255,255,0.02)' : 'transparent';

                html += '<tr style="background:' + rowBg + ';">' +
                        '<td style="padding:3px 6px; color:#aaa;">' + timeStr + '</td>' +
                        '<td style="padding:3px 6px;">' + _escapeHtml(e.samName) + '</td>' +
                        '<td style="padding:3px 6px;">' + _escapeHtml(e.targetName) + '</td>' +
                        '<td style="padding:3px 6px; color:' + resultColor + '; font-weight:bold;">' + e.result + '</td>' +
                        '<td style="padding:3px 6px; text-align:right; color:#aaa;">' + rangeStr + '</td>' +
                        '</tr>';
            }

            html += '</table>';
        }

        // Track count summary
        var trackCount = 0;
        _trackHistory.forEach(function() { trackCount++; });
        html += '<div style="margin-top:8px; color:#666; font-size:10px;">' +
                trackCount + ' entity track' + (trackCount !== 1 ? 's' : '') + ' recorded</div>';

        _summaryPanel.innerHTML = html;
        _summaryPanel.style.display = 'block';
    }

    // -------------------------------------------------------------------
    // Combat Statistics Panel
    // -------------------------------------------------------------------

    /**
     * Build the combat statistics panel (top-right overlay in ANALYZE mode).
     * Computes blue vs red force statistics, air defense metrics, and timeline.
     */
    function _buildCombatStats() {
        if (!_combatStatsPanel) {
            _combatStatsPanel = document.createElement('div');
            _combatStatsPanel.id = 'analysisCombatStats';
            _combatStatsPanel.style.cssText = [
                'position: fixed',
                'top: 60px',
                'right: 20px',
                'z-index: 150',
                'background: rgba(10, 10, 30, 0.92)',
                'border: 1px solid #334',
                'border-radius: 4px',
                'padding: 10px 14px',
                'font-family: monospace',
                'font-size: 12px',
                'color: #ccc',
                'max-height: calc(100vh - 120px)',
                'max-width: 420px',
                'overflow-y: auto',
                'pointer-events: auto',
                'box-shadow: 0 2px 12px rgba(0,0,0,0.5)'
            ].join('; ');
            document.body.appendChild(_combatStatsPanel);
        }

        // Compute stats from track history and engagement log
        var teams = {};  // team -> { aircraft, survived, destroyed, fired, kills }

        _trackHistory.forEach(function(record, entityId) {
            if (record.type !== 'aircraft') return;
            var team = record.team || 'neutral';
            if (!teams[team]) {
                teams[team] = { aircraft: 0, survived: 0, destroyed: 0, fired: 0, kills: 0, misses: 0 };
            }
            teams[team].aircraft++;
            if (record.destroyed) {
                teams[team].destroyed++;
            } else {
                teams[team].survived++;
            }
        });

        // Count launches, kills, misses from engagement log
        var samFired = 0, samKills = 0, samMisses = 0;
        var firstDetTime = Infinity, firstEngTime = Infinity, firstKillTime = Infinity, lastEngTime = 0;
        var simDuration = 0;

        for (var i = 0; i < _engagementLog.length; i++) {
            var e = _engagementLog[i];
            if (e.time > simDuration) simDuration = e.time;

            var isA2A = (e.sourceType === 'aircraft');
            var sourceTeam = null;

            if (isA2A) {
                // Find the source entity team from track history
                if (_trackHistory.has(e.sourceId)) {
                    sourceTeam = _trackHistory.get(e.sourceId).team;
                }
            }

            if (e.result === 'LAUNCH') {
                if (isA2A && sourceTeam && teams[sourceTeam]) {
                    teams[sourceTeam].fired++;
                } else if (!isA2A) {
                    samFired++;
                }
                if (e.time < firstEngTime) firstEngTime = e.time;
                if (e.time > lastEngTime) lastEngTime = e.time;
            } else if (e.result === 'KILL') {
                if (isA2A && sourceTeam && teams[sourceTeam]) {
                    teams[sourceTeam].kills++;
                } else if (!isA2A) {
                    samKills++;
                }
                if (e.time < firstKillTime) firstKillTime = e.time;
                if (e.time > lastEngTime) lastEngTime = e.time;
            } else if (e.result === 'MISS') {
                if (isA2A && sourceTeam && teams[sourceTeam]) {
                    teams[sourceTeam].misses++;
                } else if (!isA2A) {
                    samMisses++;
                }
            }
        }

        // First detection time: scan track history for earliest detection-related event
        // Use first engagement time as proxy
        if (firstEngTime < Infinity) firstDetTime = Math.max(0, firstEngTime - 5);

        // Build HTML
        var html = '<div style="color:#0af; font-weight:bold; margin-bottom:8px; font-size:13px;">' +
                   'COMBAT STATISTICS</div>';

        // Force comparison table
        var teamNames = Object.keys(teams);
        if (teamNames.length > 0) {
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:8px;">';
            html += '<tr style="color:#888; border-bottom:1px solid #333;">' +
                    '<th style="text-align:left; padding:3px 6px;">Force</th>' +
                    '<th style="text-align:center; padding:3px 6px;">A/C</th>' +
                    '<th style="text-align:center; padding:3px 6px;">Survived</th>' +
                    '<th style="text-align:center; padding:3px 6px;">Fired</th>' +
                    '<th style="text-align:center; padding:3px 6px;">Kills</th>' +
                    '<th style="text-align:center; padding:3px 6px;">Hit %</th>' +
                    '</tr>';

            for (var ti = 0; ti < teamNames.length; ti++) {
                var t = teamNames[ti];
                var ts = teams[t];
                var teamColor = t === 'blue' ? '#4488ff' : t === 'red' ? '#ff4444' : '#88ff88';
                var hitRate = ts.fired > 0 ? Math.round((ts.kills / ts.fired) * 100) + '%' : '---';
                var survRate = ts.aircraft > 0 ? Math.round((ts.survived / ts.aircraft) * 100) : 0;

                html += '<tr>' +
                        '<td style="padding:3px 6px; color:' + teamColor + '; font-weight:bold;">' +
                        t.toUpperCase() + '</td>' +
                        '<td style="text-align:center; padding:3px 6px;">' + ts.aircraft + '</td>' +
                        '<td style="text-align:center; padding:3px 6px;">' +
                        ts.survived + ' (' + survRate + '%)</td>' +
                        '<td style="text-align:center; padding:3px 6px;">' + ts.fired + '</td>' +
                        '<td style="text-align:center; padding:3px 6px;">' + ts.kills + '</td>' +
                        '<td style="text-align:center; padding:3px 6px;">' + hitRate + '</td>' +
                        '</tr>';
            }
            html += '</table>';
        }

        // Air Defense section (SAMs)
        if (samFired > 0 || samKills > 0) {
            var samPk = samFired > 0 ? Math.round((samKills / samFired) * 100) + '%' : '---';
            html += '<div style="border-top:1px solid #333; padding-top:6px; margin-top:4px;">';
            html += '<div style="color:#ff8800; font-weight:bold; margin-bottom:4px;">AIR DEFENSE</div>';
            html += '<div style="display:flex; gap:16px; font-size:11px;">';
            html += '<span>Fired: ' + samFired + '</span>';
            html += '<span>Kills: ' + samKills + '</span>';
            html += '<span>Miss: ' + samMisses + '</span>';
            html += '<span>P(k): ' + samPk + '</span>';
            html += '</div></div>';
        }

        // Timeline
        html += '<div style="border-top:1px solid #333; padding-top:6px; margin-top:6px;">';
        html += '<div style="color:#888; font-weight:bold; margin-bottom:4px;">TIMELINE</div>';
        html += '<div style="font-size:11px; color:#aaa;">';
        if (firstEngTime < Infinity) {
            html += 'First Engagement: ' + _fmtTime(firstEngTime) + '<br>';
        }
        if (firstKillTime < Infinity) {
            html += 'First Kill: ' + _fmtTime(firstKillTime) + '<br>';
        }
        if (lastEngTime > 0) {
            html += 'Last Engagement: ' + _fmtTime(lastEngTime) + '<br>';
        }
        html += 'Sim Duration: ' + _fmtTime(simDuration);
        html += '</div></div>';

        // Export CSV button
        html += '<div style="margin-top:8px; text-align:right;">';
        html += '<button id="exportCsvBtn" style="background:#1a2a44; color:#4488ff; border:1px solid #2a4a66; ' +
                'border-radius:3px; padding:4px 12px; font-family:monospace; font-size:11px; cursor:pointer;">' +
                'Export CSV</button>';
        html += '</div>';

        _combatStatsPanel.innerHTML = html;
        _combatStatsPanel.style.display = 'block';

        // Wire CSV export button
        var csvBtn = document.getElementById('exportCsvBtn');
        if (csvBtn) {
            csvBtn.addEventListener('click', function() {
                _exportCSV();
            });
        }
    }

    /**
     * Format time in seconds as MM:SS.
     */
    function _fmtTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    /**
     * Export engagement log as CSV, triggering a browser download.
     */
    function _exportCSV() {
        var header = 'Time,Source,SourceType,Target,Result,WeaponType,Lat,Lon,Alt,Range_m\n';
        var rows = '';

        for (var i = 0; i < _engagementLog.length; i++) {
            var e = _engagementLog[i];
            var latDeg = e.lat !== undefined ? (e.lat * RAD).toFixed(4) : '';
            var lonDeg = e.lon !== undefined ? (e.lon * RAD).toFixed(4) : '';
            rows += e.time.toFixed(1) + ',' +
                    _csvEscape(e.sourceName || e.samName || '') + ',' +
                    _csvEscape(e.sourceType || 'ground') + ',' +
                    _csvEscape(e.targetName || '') + ',' +
                    (e.result || '') + ',' +
                    _csvEscape(e.weaponType || 'SAM') + ',' +
                    latDeg + ',' + lonDeg + ',' +
                    (e.alt || 0).toFixed(0) + ',' +
                    (e.range || 0).toFixed(0) + '\n';
        }

        var csv = header + rows;
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'engagement_log.csv';
        a.click();
        URL.revokeObjectURL(url);

        if (typeof BuilderApp !== 'undefined') {
            BuilderApp.showMessage('Engagement log exported as CSV');
        }
    }

    /**
     * Escape a CSV field value.
     */
    function _csvEscape(str) {
        if (!str) return '';
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    // -------------------------------------------------------------------
    // Utility Helpers
    // -------------------------------------------------------------------

    /**
     * Escape HTML special characters to prevent XSS in dynamic content.
     */
    function _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------
    // Return Public API
    // -------------------------------------------------------------------
    return {
        init: init,
        startRecording: startRecording,
        recordTick: recordTick,
        stopRecording: stopRecording,
        activate: activate,
        deactivate: deactivate,
        getEngagementLog: getEngagementLog
    };
})();
