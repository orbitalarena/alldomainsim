/**
 * RunInspector -- Live entity inspector panel for RUN mode.
 *
 * Click on any entity during simulation to inspect its live state:
 * position, velocity, physics, sensors, weapons, and AI status.
 * Updates at 4 Hz via setInterval.
 *
 * Usage:
 *   RunInspector.init(viewer);
 *   RunInspector.show(entityId, world);   // open panel for entity
 *   RunInspector.hide();                  // close panel
 *   RunInspector.update();                // called automatically at 4 Hz
 */
var RunInspector = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    var RAD_TO_DEG = 180 / Math.PI;
    var M_TO_FT = 3.28084;
    var MS_TO_KTS = 1.94384;
    var UPDATE_INTERVAL_MS = 250;  // 4 Hz

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _viewer = null;
    var _world = null;
    var _entityId = null;
    var _updateTimer = null;
    var _panel = null;
    var _stylesInjected = false;

    // -------------------------------------------------------------------
    // HTML Escaping
    // -------------------------------------------------------------------

    /**
     * Escape HTML special characters to prevent XSS in dynamic content.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------
    // Formatting Helpers
    // -------------------------------------------------------------------

    /**
     * Format a value in radians to degrees with fixed decimals.
     * @param {number} rad
     * @param {number} decimals
     * @returns {string}
     */
    function _radToDegStr(rad, decimals) {
        if (rad === undefined || rad === null || isNaN(rad)) return '---';
        return (rad * RAD_TO_DEG).toFixed(decimals !== undefined ? decimals : 4);
    }

    /**
     * Format altitude with both meters and feet.
     * @param {number} alt  meters
     * @returns {string}
     */
    function _formatAlt(alt) {
        if (alt === undefined || alt === null || isNaN(alt)) return '---';
        var ft = alt * M_TO_FT;
        if (alt >= 1000) {
            return (alt / 1000).toFixed(2) + ' km / ' + Math.round(ft).toLocaleString() + ' ft';
        }
        return alt.toFixed(1) + ' m / ' + Math.round(ft).toLocaleString() + ' ft';
    }

    /**
     * Format speed with both m/s and knots.
     * @param {number} speed  m/s
     * @returns {string}
     */
    function _formatSpeed(speed) {
        if (speed === undefined || speed === null || isNaN(speed)) return '---';
        var kts = speed * MS_TO_KTS;
        if (speed >= 1000) {
            return (speed / 1000).toFixed(2) + ' km/s / ' + Math.round(kts).toLocaleString() + ' kts';
        }
        return speed.toFixed(1) + ' m/s / ' + Math.round(kts) + ' kts';
    }

    /**
     * Format a time in seconds to MM:SS.
     * @param {number} seconds
     * @returns {string}
     */
    function _formatTime(seconds) {
        if (seconds === undefined || seconds === null || isNaN(seconds) || !isFinite(seconds)) return '---';
        var mins = Math.floor(seconds / 60);
        var secs = Math.floor(seconds % 60);
        return (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
    }

    /**
     * Format a distance in meters.
     * @param {number} dist  meters
     * @returns {string}
     */
    function _formatDist(dist) {
        if (dist === undefined || dist === null || isNaN(dist)) return '---';
        if (dist >= 1000) {
            return (dist / 1000).toFixed(1) + ' km';
        }
        return Math.round(dist) + ' m';
    }

    // -------------------------------------------------------------------
    // Team Badge
    // -------------------------------------------------------------------

    /**
     * Return a small colored badge span for the team.
     * @param {string} team
     * @returns {string}  HTML string
     */
    function _teamBadge(team) {
        var color = '#888';
        var label = 'NEU';
        if (team === 'blue') { color = '#4488ff'; label = 'BLU'; }
        else if (team === 'red') { color = '#ff4444'; label = 'RED'; }
        else if (team === 'green') { color = '#44cc44'; label = 'GRN'; }
        return '<span style="background:' + color +
               '; color:#000; font-size:10px; font-weight:bold; padding:1px 5px;' +
               ' border-radius:2px; margin-left:6px;">' + label + '</span>';
    }

    // -------------------------------------------------------------------
    // Panel Creation
    // -------------------------------------------------------------------

    /**
     * Inject scoped CSS for the run inspector panel.
     */
    function _injectStyles() {
        if (_stylesInjected) return;
        _stylesInjected = true;

        var style = document.createElement('style');
        style.id = 'run-inspector-styles';
        style.textContent = [
            '#runInspector {',
            '  position: fixed;',
            '  top: 60px;',
            '  right: 20px;',
            '  width: 320px;',
            '  max-height: calc(100vh - 100px);',
            '  overflow-y: auto;',
            '  z-index: 160;',
            '  background: rgba(8, 12, 20, 0.94);',
            '  border: 1px solid #1a3a1a;',
            '  border-radius: 4px;',
            '  font-family: "Consolas", "Courier New", monospace;',
            '  font-size: 12px;',
            '  color: #33cc33;',
            '  box-shadow: 0 4px 20px rgba(0,0,0,0.6);',
            '  pointer-events: auto;',
            '  display: none;',
            '}',
            '#runInspector::-webkit-scrollbar { width: 6px; }',
            '#runInspector::-webkit-scrollbar-track { background: rgba(0,0,0,0.3); }',
            '#runInspector::-webkit-scrollbar-thumb { background: #1a3a1a; border-radius: 3px; }',
            '',
            '.ri-header {',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  padding: 8px 10px;',
            '  background: rgba(10, 30, 10, 0.6);',
            '  border-bottom: 1px solid #1a3a1a;',
            '}',
            '.ri-header-name {',
            '  font-size: 14px;',
            '  font-weight: bold;',
            '  color: #44ff44;',
            '  overflow: hidden;',
            '  text-overflow: ellipsis;',
            '  white-space: nowrap;',
            '  flex: 1;',
            '}',
            '.ri-close {',
            '  cursor: pointer;',
            '  color: #666;',
            '  font-size: 16px;',
            '  padding: 0 4px;',
            '  margin-left: 8px;',
            '  flex-shrink: 0;',
            '}',
            '.ri-close:hover { color: #ff4444; }',
            '',
            '.ri-section {',
            '  border-bottom: 1px solid rgba(30, 60, 30, 0.4);',
            '  padding: 6px 10px;',
            '}',
            '.ri-section-title {',
            '  font-size: 10px;',
            '  font-weight: bold;',
            '  color: #228822;',
            '  text-transform: uppercase;',
            '  letter-spacing: 1px;',
            '  margin-bottom: 4px;',
            '}',
            '.ri-row {',
            '  display: flex;',
            '  justify-content: space-between;',
            '  padding: 1px 0;',
            '  line-height: 1.5;',
            '}',
            '.ri-label {',
            '  color: #559955;',
            '  flex-shrink: 0;',
            '  width: 90px;',
            '}',
            '.ri-value {',
            '  color: #33cc33;',
            '  text-align: right;',
            '  flex: 1;',
            '  overflow: hidden;',
            '  text-overflow: ellipsis;',
            '  white-space: nowrap;',
            '}',
            '.ri-value-warn { color: #cccc33; }',
            '.ri-value-alert { color: #ff4444; }',
            '',
            '.ri-detection-list {',
            '  margin-top: 3px;',
            '  padding-left: 8px;',
            '  font-size: 11px;',
            '  color: #2a9a2a;',
            '  max-height: 80px;',
            '  overflow-y: auto;',
            '}',
            '.ri-detection-item {',
            '  padding: 1px 0;',
            '  border-bottom: 1px solid rgba(30, 60, 30, 0.2);',
            '}',
            '',
            '.ri-buttons {',
            '  display: flex;',
            '  gap: 6px;',
            '  padding: 8px 10px;',
            '}',
            '.ri-btn {',
            '  flex: 1;',
            '  padding: 5px 8px;',
            '  background: rgba(20, 60, 20, 0.6);',
            '  border: 1px solid #2a5a2a;',
            '  border-radius: 3px;',
            '  color: #33cc33;',
            '  font-family: monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '  text-align: center;',
            '}',
            '.ri-btn:hover {',
            '  background: rgba(30, 80, 30, 0.7);',
            '  border-color: #44aa44;',
            '  color: #44ff44;',
            '}'
        ].join('\n');

        document.head.appendChild(style);
    }

    /**
     * Create or retrieve the inspector panel DOM element.
     * @returns {HTMLElement}
     */
    function _getPanel() {
        if (_panel) return _panel;

        _injectStyles();

        _panel = document.createElement('div');
        _panel.id = 'runInspector';
        document.body.appendChild(_panel);

        return _panel;
    }

    // -------------------------------------------------------------------
    // Click Handler
    // -------------------------------------------------------------------

    /**
     * Set up a click handler on the Cesium viewer to detect entity picks.
     * Only activates during RUN mode (checks BuilderApp.getMode if available).
     */
    function _setupClickHandler() {
        if (!_viewer || !_viewer.scene || !_viewer.scene.canvas) return;

        var handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);

        handler.setInputAction(function(click) {
            // Only respond during RUN mode
            if (typeof BuilderApp !== 'undefined' && BuilderApp.getMode) {
                var mode = BuilderApp.getMode();
                if (mode !== 'RUN') return;
            }

            var pickedObject = _viewer.scene.pick(click.position);
            if (!Cesium.defined(pickedObject) || !Cesium.defined(pickedObject.id)) {
                return;
            }

            // The picked Cesium entity has a name; find the ECS entity that matches
            var pickedCesiumEntity = pickedObject.id;
            if (!_world) return;

            var foundEntityId = null;
            _world.entities.forEach(function(entity) {
                if (foundEntityId) return;  // already found
                var visual = entity.getComponent('visual');
                if (!visual) return;
                if (visual._cesiumEntity === pickedCesiumEntity ||
                    visual._pointEntity === pickedCesiumEntity) {
                    foundEntityId = entity.id;
                }
            });

            if (foundEntityId) {
                show(foundEntityId, _world);
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // -------------------------------------------------------------------
    // Panel Content Builder
    // -------------------------------------------------------------------

    /**
     * Build the full inner HTML of the inspector panel from live entity state.
     * @param {Entity} entity
     * @returns {string}  HTML content
     */
    function _buildContent(entity) {
        var s = entity.state;
        var html = '';

        // ---- Header ----
        html += '<div class="ri-header">';
        html += '<span class="ri-header-name">' + _escapeHtml(entity.name) + _teamBadge(entity.team) + '</span>';
        html += '<span class="ri-close" id="riClose" title="Close">[X]</span>';
        html += '</div>';

        // ---- Position Section ----
        html += '<div class="ri-section">';
        html += '<div class="ri-section-title">Position</div>';
        html += '<div class="ri-row"><span class="ri-label">Lat</span><span class="ri-value">' +
                _radToDegStr(s.lat, 4) + '\u00B0</span></div>';
        html += '<div class="ri-row"><span class="ri-label">Lon</span><span class="ri-value">' +
                _radToDegStr(s.lon, 4) + '\u00B0</span></div>';
        html += '<div class="ri-row"><span class="ri-label">Alt</span><span class="ri-value">' +
                _formatAlt(s.alt) + '</span></div>';
        html += '</div>';

        // ---- Velocity Section ----
        html += '<div class="ri-section">';
        html += '<div class="ri-section-title">Velocity</div>';
        html += '<div class="ri-row"><span class="ri-label">Speed</span><span class="ri-value">' +
                _formatSpeed(s.speed) + '</span></div>';
        html += '<div class="ri-row"><span class="ri-label">Heading</span><span class="ri-value">' +
                _radToDegStr(s.heading, 1) + '\u00B0</span></div>';
        html += '<div class="ri-row"><span class="ri-label">FPA (\u03B3)</span><span class="ri-value">' +
                _radToDegStr(s.gamma, 2) + '\u00B0</span></div>';
        html += '</div>';

        // ---- Physics Section ----
        html += '<div class="ri-section">';
        html += '<div class="ri-section-title">Physics</div>';

        // Throttle
        var throttlePct = (s.throttle !== undefined && !isNaN(s.throttle))
            ? (s.throttle * 100).toFixed(0) + '%'
            : '---';
        html += '<div class="ri-row"><span class="ri-label">Throttle</span><span class="ri-value">' +
                throttlePct + '</span></div>';

        // AoA
        var aoaStr = '---';
        if (s.alpha !== undefined && !isNaN(s.alpha)) {
            // alpha may be in degrees or radians depending on entity type;
            // if the value is small (< 2*pi range), treat as radians
            var alphaDeg = Math.abs(s.alpha) < 6.3 ? (s.alpha * RAD_TO_DEG).toFixed(1) : s.alpha.toFixed(1);
            aoaStr = alphaDeg + '\u00B0';
        }
        html += '<div class="ri-row"><span class="ri-label">AoA</span><span class="ri-value">' +
                aoaStr + '</span></div>';

        // G-load
        var gStr = '---';
        if (s.gLoad !== undefined && !isNaN(s.gLoad)) {
            var gClass = 'ri-value';
            if (s.gLoad > 7) gClass += ' ri-value-alert';
            else if (s.gLoad > 4) gClass += ' ri-value-warn';
            gStr = s.gLoad.toFixed(1) + ' G';
            html += '<div class="ri-row"><span class="ri-label">G-Load</span><span class="' + gClass + '">' +
                    gStr + '</span></div>';
        } else {
            html += '<div class="ri-row"><span class="ri-label">G-Load</span><span class="ri-value">---</span></div>';
        }

        // Fuel
        var fuelStr = '---';
        if (s.infiniteFuel) {
            fuelStr = 'INF';
        } else if (s.fuel !== undefined && !isNaN(s.fuel)) {
            var fuelClass = 'ri-value';
            if (s.fuel < 100) fuelClass += ' ri-value-alert';
            else if (s.fuel < 500) fuelClass += ' ri-value-warn';
            fuelStr = s.fuel.toFixed(0) + ' kg';
            html += '<div class="ri-row"><span class="ri-label">Fuel</span><span class="' + fuelClass + '">' +
                    fuelStr + '</span></div>';
        } else {
            html += '<div class="ri-row"><span class="ri-label">Fuel</span><span class="ri-value">' +
                    fuelStr + '</span></div>';
        }

        html += '</div>';

        // ---- Sensors Section ----
        var sensors = entity.getComponent('sensors');
        if (sensors) {
            html += '<div class="ri-section">';
            html += '<div class="ri-section-title">Sensors</div>';

            var detections = s._detections;
            var detCount = (detections && Array.isArray(detections)) ? detections.length : 0;

            html += '<div class="ri-row"><span class="ri-label">Detections</span><span class="ri-value">' +
                    detCount + '</span></div>';

            // Sensor config info
            var sensorCfg = sensors.config || {};
            if (sensorCfg.maxRange_m) {
                html += '<div class="ri-row"><span class="ri-label">Range</span><span class="ri-value">' +
                        _formatDist(sensorCfg.maxRange_m) + '</span></div>';
            }
            if (sensorCfg.fov_deg !== undefined) {
                html += '<div class="ri-row"><span class="ri-label">FOV</span><span class="ri-value">' +
                        sensorCfg.fov_deg + '\u00B0</span></div>';
            }

            // Detection list
            if (detCount > 0) {
                html += '<div class="ri-detection-list">';
                for (var di = 0; di < detections.length; di++) {
                    var det = detections[di];
                    var detName = det.name || det.entityId || ('tgt-' + di);
                    var detRange = det.range !== undefined ? _formatDist(det.range) : '';
                    html += '<div class="ri-detection-item">' +
                            _escapeHtml(detName) +
                            (detRange ? ' <span style="color:#559955;">' + detRange + '</span>' : '') +
                            '</div>';
                }
                html += '</div>';
            }

            html += '</div>';
        }

        // ---- Weapons Section ----
        var weapons = entity.getComponent('weapons');
        if (weapons) {
            html += '<div class="ri-section">';
            html += '<div class="ri-section-title">Weapons</div>';

            // SAM weapon state
            if (s._samState !== undefined) {
                var samStateClass = 'ri-value';
                if (s._samState === 'ENGAGING') samStateClass += ' ri-value-alert';
                else if (s._samState === 'TRACKING') samStateClass += ' ri-value-warn';
                html += '<div class="ri-row"><span class="ri-label">SAM State</span><span class="' +
                        samStateClass + '">' + _escapeHtml(String(s._samState)) + '</span></div>';

                if (s._missilesReady !== undefined) {
                    html += '<div class="ri-row"><span class="ri-label">Ready</span><span class="ri-value">' +
                            s._missilesReady + '</span></div>';
                }
                if (s._totalFired !== undefined) {
                    html += '<div class="ri-row"><span class="ri-label">Fired</span><span class="ri-value">' +
                            s._totalFired + '</span></div>';
                }

                // Engagements list
                if (s._engagements && Array.isArray(s._engagements) && s._engagements.length > 0) {
                    html += '<div class="ri-detection-list">';
                    for (var ei = 0; ei < s._engagements.length; ei++) {
                        var eng = s._engagements[ei];
                        var engTarget = eng.targetName || eng.targetId || ('tgt-' + ei);
                        var engResult = eng.result || eng.state || '?';
                        var engResultColor = engResult === 'KILL' ? '#ff4444' :
                                             engResult === 'MISS' ? '#cccc33' : '#33cc33';
                        html += '<div class="ri-detection-item">' +
                                _escapeHtml(engTarget) +
                                ' <span style="color:' + engResultColor + ';">' +
                                _escapeHtml(String(engResult)) + '</span></div>';
                    }
                    html += '</div>';
                }
            }

            // A2A weapon state
            if (s._a2aState !== undefined) {
                var a2aStateClass = 'ri-value';
                if (s._a2aState === 'ENGAGING') a2aStateClass += ' ri-value-alert';
                else if (s._a2aState === 'TRACKING') a2aStateClass += ' ri-value-warn';
                html += '<div class="ri-row"><span class="ri-label">A2A State</span><span class="' +
                        a2aStateClass + '">' + _escapeHtml(String(s._a2aState)) + '</span></div>';

                if (s._a2aInventory !== undefined) {
                    html += '<div class="ri-row"><span class="ri-label">Inventory</span><span class="ri-value">' +
                            s._a2aInventory + '</span></div>';
                }
                if (s._a2aTotalFired !== undefined) {
                    html += '<div class="ri-row"><span class="ri-label">Fired</span><span class="ri-value">' +
                            s._a2aTotalFired + '</span></div>';
                }
                if (s._a2aKills !== undefined) {
                    html += '<div class="ri-row"><span class="ri-label">Kills</span><span class="ri-value' +
                            (s._a2aKills > 0 ? ' ri-value-alert' : '') + '">' +
                            s._a2aKills + '</span></div>';
                }

                // A2A engagements list
                if (s._a2aEngagements && Array.isArray(s._a2aEngagements) && s._a2aEngagements.length > 0) {
                    html += '<div class="ri-detection-list">';
                    for (var ai = 0; ai < s._a2aEngagements.length; ai++) {
                        var a2aEng = s._a2aEngagements[ai];
                        var a2aTarget = a2aEng.targetName || a2aEng.targetId || ('tgt-' + ai);
                        var a2aResult = a2aEng.result || a2aEng.state || '?';
                        var a2aColor = a2aResult === 'KILL' ? '#ff4444' :
                                       a2aResult === 'MISS' ? '#cccc33' : '#33cc33';
                        html += '<div class="ri-detection-item">' +
                                _escapeHtml(a2aTarget) +
                                ' <span style="color:' + a2aColor + ';">' +
                                _escapeHtml(String(a2aResult)) + '</span></div>';
                    }
                    html += '</div>';
                }
            }

            html += '</div>';
        }

        // ---- AI Section ----
        var ai = entity.getComponent('ai');
        if (ai) {
            html += '<div class="ri-section">';
            html += '<div class="ri-section-title">AI</div>';

            // Waypoint patrol state
            if (s._waypointIndex !== undefined) {
                var wpIdx = s._waypointIndex;
                var wpCount = s._waypointCount !== undefined ? s._waypointCount : '?';
                html += '<div class="ri-row"><span class="ri-label">Waypoint</span><span class="ri-value">' +
                        wpIdx + ' / ' + wpCount + '</span></div>';

                if (s._distToWaypoint !== undefined && !isNaN(s._distToWaypoint)) {
                    html += '<div class="ri-row"><span class="ri-label">Dist to WP</span><span class="ri-value">' +
                            _formatDist(s._distToWaypoint) + '</span></div>';

                    // ETA calculation
                    if (s.speed > 0 && s._distToWaypoint > 0) {
                        var eta = s._distToWaypoint / s.speed;
                        html += '<div class="ri-row"><span class="ri-label">ETA</span><span class="ri-value">' +
                                _formatTime(eta) + '</span></div>';
                    }
                }
            }

            // Intercept state
            if (s._interceptState !== undefined) {
                var intStateClass = 'ri-value';
                if (s._interceptState === 'ENGAGING' || s._interceptState === 'INTERCEPT') {
                    intStateClass += ' ri-value-alert';
                } else if (s._interceptState === 'PURSUING' || s._interceptState === 'TRACKING') {
                    intStateClass += ' ri-value-warn';
                }
                html += '<div class="ri-row"><span class="ri-label">Intercept</span><span class="' +
                        intStateClass + '">' + _escapeHtml(String(s._interceptState)) + '</span></div>';

                if (s._interceptTarget) {
                    html += '<div class="ri-row"><span class="ri-label">Target</span><span class="ri-value">' +
                            _escapeHtml(String(s._interceptTarget)) + '</span></div>';
                }
            }

            html += '</div>';
        }

        // ---- Camera Buttons ----
        html += '<div class="ri-buttons">';
        html += '<button class="ri-btn" id="riTrack">Track</button>';
        html += '<button class="ri-btn" id="riUntrack">Untrack</button>';
        html += '</div>';

        return html;
    }

    // -------------------------------------------------------------------
    // Event Wiring
    // -------------------------------------------------------------------

    /**
     * Attach click handlers for close/track/untrack buttons.
     * Called after innerHTML update since buttons are recreated each time.
     */
    function _wireButtons() {
        var closeBtn = document.getElementById('riClose');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                hide();
            });
        }

        var trackBtn = document.getElementById('riTrack');
        if (trackBtn) {
            trackBtn.addEventListener('click', function() {
                _trackEntity();
            });
        }

        var untrackBtn = document.getElementById('riUntrack');
        if (untrackBtn) {
            untrackBtn.addEventListener('click', function() {
                _untrackEntity();
            });
        }
    }

    /**
     * Set the Cesium viewer to track the inspected entity's visual.
     */
    function _trackEntity() {
        if (!_viewer || !_world || !_entityId) return;
        var entity = _world.getEntity(_entityId);
        if (!entity) return;

        var visual = entity.getComponent('visual');
        if (!visual) return;

        var cesiumEntity = visual._cesiumEntity || visual._pointEntity;
        if (cesiumEntity) {
            _viewer.trackedEntity = cesiumEntity;
        }
    }

    /**
     * Clear the Cesium viewer's tracked entity.
     */
    function _untrackEntity() {
        if (!_viewer) return;
        _viewer.trackedEntity = undefined;
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Store the Cesium viewer reference and set up click handling.
     * @param {Cesium.Viewer} viewer
     */
    function init(viewer) {
        _viewer = viewer;
        _setupClickHandler();
    }

    /**
     * Show the inspector panel for a specific entity.
     * Starts the 4 Hz update interval.
     * @param {string} entityId
     * @param {ECS.World} world
     */
    function show(entityId, world) {
        _entityId = entityId;
        _world = world;

        var panel = _getPanel();
        panel.style.display = 'block';

        // Run an immediate update
        update();

        // Start periodic updates
        if (_updateTimer) clearInterval(_updateTimer);
        _updateTimer = setInterval(update, UPDATE_INTERVAL_MS);
    }

    /**
     * Hide the inspector panel and stop the update interval.
     */
    function hide() {
        if (_updateTimer) {
            clearInterval(_updateTimer);
            _updateTimer = null;
        }

        var panel = _getPanel();
        panel.style.display = 'none';

        _entityId = null;
        _world = null;
    }

    /**
     * Called at 4 Hz by setInterval. Reads the entity's live state
     * and updates the panel HTML.
     */
    function update() {
        if (!_entityId || !_world) return;

        var entity = _world.getEntity(_entityId);
        if (!entity) {
            // Entity was removed during simulation
            hide();
            return;
        }

        var panel = _getPanel();
        panel.innerHTML = _buildContent(entity);
        _wireButtons();
    }

    // -------------------------------------------------------------------
    // Return Public API
    // -------------------------------------------------------------------
    return {
        init: init,
        show: show,
        hide: hide,
        update: update
    };
})();
