// =========================================================================
// CONJUNCTION DETECTION SYSTEM — Collision/proximity warning for Live Sim
// =========================================================================
// Detects dangerously close approaches between entities (primarily orbital)
// using spatial hashing to avoid O(n^2) pair checks. Displays alerts in a
// panel with severity color-coding and click-to-zoom.
//
// Thresholds:
//   CRITICAL  < 1 km   (red)
//   WARNING   < 10 km  (yellow)
//   WATCH     < 50 km  (white)
//
// Usage:
//   ConjunctionSystem.init(world, viewer);
//   ConjunctionSystem.update(world, simTime);  // call each tick, internally throttled
//   ConjunctionSystem.toggle();                // J key
//   ConjunctionSystem.getAlerts();             // [{id1, id2, dist, tca, level}]
// =========================================================================
'use strict';

var ConjunctionSystem = (function() {

    // ===================== CONSTANTS =====================
    var R_EARTH = 6371000;  // meters
    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;

    // Conjunction distance thresholds (meters)
    var THRESHOLD_CRITICAL = 1000;       // 1 km
    var THRESHOLD_WARNING  = 10000;      // 10 km
    var THRESHOLD_WATCH    = 50000;      // 50 km

    // Spatial hash cell size (meters) — should be >= THRESHOLD_WATCH
    var CELL_SIZE = 50000;
    var INV_CELL_SIZE = 1.0 / CELL_SIZE;

    // Update throttle — run full detection at 1 Hz (1000 ms)
    var UPDATE_INTERVAL_MS = 1000;

    // Max alerts to display in panel
    var MAX_DISPLAY_ALERTS = 50;

    // TCA extrapolation: max lookahead (seconds)
    var TCA_MAX_LOOKAHEAD = 600;  // 10 minutes

    // Alert severity levels
    var LEVEL_CRITICAL = 'CRITICAL';
    var LEVEL_WARNING  = 'WARNING';
    var LEVEL_WATCH    = 'WATCH';

    // Colors per level
    var LEVEL_COLORS = {};
    LEVEL_COLORS[LEVEL_CRITICAL] = '#ff3333';
    LEVEL_COLORS[LEVEL_WARNING]  = '#ffcc00';
    LEVEL_COLORS[LEVEL_WATCH]    = '#cccccc';

    // Level sort priority (lower = more severe)
    var LEVEL_PRIORITY = {};
    LEVEL_PRIORITY[LEVEL_CRITICAL] = 0;
    LEVEL_PRIORITY[LEVEL_WARNING]  = 1;
    LEVEL_PRIORITY[LEVEL_WATCH]    = 2;

    // ===================== STATE =====================
    var _world = null;
    var _viewer = null;
    var _visible = false;
    var _styleInjected = false;
    var _panelEl = null;
    var _alertListEl = null;
    var _alertCountEl = null;

    // Current alerts
    var _alerts = [];       // [{id1, id2, name1, name2, dist, tca, level, midpoint}]

    // Previous distances for TCA extrapolation (keyed by sorted pair id)
    var _prevDistances = {};  // { "id1|id2": { dist: number, time: number } }

    // Throttle
    var _lastUpdateTime = 0;

    // Spatial hash buckets
    var _hashBuckets = {};  // { "cx,cy,cz": [entityIndex, ...] }

    // Reusable arrays to avoid per-frame allocation
    var _entityCache = [];  // [{id, name, team, eciX, eciY, eciZ, velX, velY, velZ, hasVel}]

    // Audio alert cooldown
    var _lastAudioAlert = 0;

    // ===================== CSS INJECTION =====================
    function _injectStyles() {
        if (_styleInjected) return;
        _styleInjected = true;

        var css = [
            '#conjunctionPanel {',
            '  position: absolute;',
            '  bottom: 290px;',
            '  left: 16px;',
            '  width: 320px;',
            '  max-height: 350px;',
            '  background: rgba(10, 12, 20, 0.90);',
            '  border: 1px solid #ff3333;',
            '  border-radius: 6px;',
            '  padding: 0;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  color: #cccccc;',
            '  z-index: 25;',
            '  pointer-events: auto;',
            '  display: none;',
            '  overflow: hidden;',
            '}',
            '#conjunctionPanel.visible { display: block; }',
            '',
            '#conjunctionPanel .cj-header {',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  padding: 6px 10px;',
            '  background: rgba(255, 50, 50, 0.15);',
            '  border-bottom: 1px solid #442222;',
            '}',
            '#conjunctionPanel .cj-header .cj-title {',
            '  color: #ff6666;',
            '  font-size: 11px;',
            '  font-weight: bold;',
            '  letter-spacing: 1px;',
            '  text-transform: uppercase;',
            '}',
            '#conjunctionPanel .cj-header .cj-count {',
            '  color: #ff3333;',
            '  font-size: 12px;',
            '  font-weight: bold;',
            '}',
            '',
            '#conjunctionAlertList {',
            '  max-height: 300px;',
            '  overflow-y: auto;',
            '  padding: 4px 0;',
            '}',
            '',
            '.cj-alert-row {',
            '  display: flex;',
            '  align-items: center;',
            '  padding: 4px 10px;',
            '  cursor: pointer;',
            '  transition: background 0.1s;',
            '  border-bottom: 1px solid rgba(255, 255, 255, 0.05);',
            '}',
            '.cj-alert-row:hover { background: rgba(255, 255, 255, 0.08); }',
            '',
            '.cj-level-dot {',
            '  width: 8px;',
            '  height: 8px;',
            '  border-radius: 50%;',
            '  flex-shrink: 0;',
            '  margin-right: 8px;',
            '}',
            '.cj-level-dot.critical { background: #ff3333; box-shadow: 0 0 6px #ff3333; }',
            '.cj-level-dot.warning  { background: #ffcc00; box-shadow: 0 0 4px #ffcc00; }',
            '.cj-level-dot.watch    { background: #888888; }',
            '',
            '.cj-alert-info { flex: 1; min-width: 0; }',
            '.cj-alert-names {',
            '  color: #cccccc;',
            '  font-size: 10px;',
            '  white-space: nowrap;',
            '  overflow: hidden;',
            '  text-overflow: ellipsis;',
            '}',
            '.cj-alert-dist {',
            '  font-size: 12px;',
            '  font-weight: bold;',
            '  margin-right: 6px;',
            '  flex-shrink: 0;',
            '  text-align: right;',
            '  min-width: 70px;',
            '}',
            '.cj-alert-tca {',
            '  color: #666666;',
            '  font-size: 9px;',
            '  margin-top: 1px;',
            '}',
            '',
            '.cj-empty {',
            '  color: #444;',
            '  font-size: 11px;',
            '  text-align: center;',
            '  padding: 16px 10px;',
            '  font-style: italic;',
            '}',
            '',
            '/* Scrollbar styling */',
            '#conjunctionAlertList::-webkit-scrollbar { width: 4px; }',
            '#conjunctionAlertList::-webkit-scrollbar-track { background: transparent; }',
            '#conjunctionAlertList::-webkit-scrollbar-thumb { background: #442222; border-radius: 2px; }',
        ].join('\n');

        var style = document.createElement('style');
        style.type = 'text/css';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ===================== INIT =====================
    function init(world, viewer) {
        _world = world;
        _viewer = viewer;

        _injectStyles();

        // Get or create panel element
        _panelEl = document.getElementById('conjunctionPanel');
        if (!_panelEl) {
            _panelEl = document.createElement('div');
            _panelEl.id = 'conjunctionPanel';
            document.body.appendChild(_panelEl);
        }

        // Populate inner content if not already set
        if (!document.getElementById('conjunctionAlertList')) {
            _panelEl.innerHTML = [
                '<div class="cj-header">',
                '  <span class="cj-title">CONJUNCTION ALERTS</span>',
                '  <span class="cj-count" id="conjunctionCount">0</span>',
                '</div>',
                '<div id="conjunctionAlertList"></div>'
            ].join('');
        }

        _alertListEl = document.getElementById('conjunctionAlertList');
        _alertCountEl = document.getElementById('conjunctionCount');
    }

    // ===================== SPATIAL HASH =====================

    /**
     * Compute spatial hash cell coordinates for an ECI position.
     * Returns string key "cx,cy,cz" for bucket lookup.
     */
    function _cellKey(x, y, z) {
        var cx = Math.floor(x * INV_CELL_SIZE);
        var cy = Math.floor(y * INV_CELL_SIZE);
        var cz = Math.floor(z * INV_CELL_SIZE);
        return cx + ',' + cy + ',' + cz;
    }

    /**
     * Get all cell keys for an entity position (own cell + 26 adjacent cells).
     * To avoid checking every adjacent cell, we only need to insert into own cell
     * and query own + adjacent. But since we do pairwise in same cell, we insert
     * each entity into its cell AND all 26 neighbors to ensure pairs in adjacent
     * cells both appear in at least one shared bucket.
     *
     * Optimization: Instead of inserting into 27 cells, we insert into 1 cell
     * and check pairs across adjacent cells during the sweep phase.
     */
    function _getNeighborKeys(x, y, z) {
        var cx = Math.floor(x * INV_CELL_SIZE);
        var cy = Math.floor(y * INV_CELL_SIZE);
        var cz = Math.floor(z * INV_CELL_SIZE);
        var keys = [];
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                for (var dz = -1; dz <= 1; dz++) {
                    keys.push((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
                }
            }
        }
        return keys;
    }

    // ===================== ENTITY CACHE =====================

    /**
     * Build a flat array of entity positions from the ECS world.
     * For orbital entities: use state._eci_pos / _eci_vel directly.
     * For atmospheric/ground: convert geodetic to ECEF (approximate ECI for
     * short-duration conjunction detection — Earth rotation is slow enough
     * that ECEF ~ ECI for proximity checks within a few seconds).
     */
    function _buildEntityCache(world) {
        _entityCache.length = 0;

        if (!world || !world.entities) return;

        world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var s = entity.state;
            if (!s) return;

            var entry = {
                id: entity.id,
                name: entity.name || entity.id,
                team: entity.team || 'unknown',
                eciX: 0, eciY: 0, eciZ: 0,
                velX: 0, velY: 0, velZ: 0,
                hasVel: false
            };

            // Prefer ECI position from orbital component
            if (s._eci_pos) {
                entry.eciX = s._eci_pos[0];
                entry.eciY = s._eci_pos[1];
                entry.eciZ = s._eci_pos[2];
                if (s._eci_vel) {
                    entry.velX = s._eci_vel[0];
                    entry.velY = s._eci_vel[1];
                    entry.velZ = s._eci_vel[2];
                    entry.hasVel = true;
                }
            } else if (s.lat != null && s.lon != null && s.alt != null) {
                // Convert geodetic (radians) to ECEF as ECI approximation
                var lat = s.lat;
                var lon = s.lon;
                var alt = s.alt || 0;

                // Skip ground-level entities (below 100m) — not relevant for conjunction
                if (alt < 100) return;

                var cosLat = Math.cos(lat);
                var sinLat = Math.sin(lat);
                var cosLon = Math.cos(lon);
                var sinLon = Math.sin(lon);
                var r = R_EARTH + alt;

                entry.eciX = r * cosLat * cosLon;
                entry.eciY = r * cosLat * sinLon;
                entry.eciZ = r * sinLat;

                // Approximate velocity from speed + heading + gamma if available
                if (s.speed > 0 && s.heading != null) {
                    var spd = s.speed;
                    var gamma = s.gamma || 0;
                    var hdg = s.heading;
                    var cosG = Math.cos(gamma);
                    var hVel = spd * cosG;
                    var vVel = spd * Math.sin(gamma);

                    // ENU velocity
                    var vE = hVel * Math.sin(hdg);
                    var vN = hVel * Math.cos(hdg);
                    var vU = vVel;

                    // ENU to ECEF rotation
                    entry.velX = -sinLon * vE - sinLat * cosLon * vN + cosLat * cosLon * vU;
                    entry.velY =  cosLon * vE - sinLat * sinLon * vN + cosLat * sinLon * vU;
                    entry.velZ =  cosLat * vN + sinLat * vU;
                    entry.hasVel = true;
                }
            } else {
                // No usable position data
                return;
            }

            // Sanity: skip NaN positions
            if (isNaN(entry.eciX) || isNaN(entry.eciY) || isNaN(entry.eciZ)) return;

            _entityCache.push(entry);
        });
    }

    // ===================== DETECTION =====================

    /**
     * Run conjunction detection using spatial hashing.
     * 1. Insert all entities into spatial hash by their cell
     * 2. For each entity, check all entities in same + adjacent cells
     * 3. Track distance and extrapolate TCA
     */
    function _detectConjunctions(simTime) {
        var newAlerts = [];

        // Clear hash buckets
        _hashBuckets = {};

        var n = _entityCache.length;
        if (n < 2) {
            _alerts = newAlerts;
            return;
        }

        // 1. Insert entities into spatial hash (own cell only)
        for (var i = 0; i < n; i++) {
            var e = _entityCache[i];
            var key = _cellKey(e.eciX, e.eciY, e.eciZ);
            if (!_hashBuckets[key]) _hashBuckets[key] = [];
            _hashBuckets[key].push(i);
        }

        // 2. For each entity, check entities in same + neighbor cells
        // Use a Set to avoid duplicate pair checks
        var checkedPairs = {};

        for (var i = 0; i < n; i++) {
            var a = _entityCache[i];
            var neighborKeys = _getNeighborKeys(a.eciX, a.eciY, a.eciZ);

            for (var nk = 0; nk < neighborKeys.length; nk++) {
                var bucket = _hashBuckets[neighborKeys[nk]];
                if (!bucket) continue;

                for (var bi = 0; bi < bucket.length; bi++) {
                    var j = bucket[bi];
                    if (j <= i) continue; // skip self and already-checked pairs

                    // Unique pair key (always smaller index first)
                    var pairKey = i + '|' + j;
                    if (checkedPairs[pairKey]) continue;
                    checkedPairs[pairKey] = true;

                    var b = _entityCache[j];

                    // Distance calculation
                    var dx = a.eciX - b.eciX;
                    var dy = a.eciY - b.eciY;
                    var dz = a.eciZ - b.eciZ;
                    var distSq = dx * dx + dy * dy + dz * dz;

                    // Quick reject: if distance > threshold, skip
                    if (distSq > THRESHOLD_WATCH * THRESHOLD_WATCH) continue;

                    var dist = Math.sqrt(distSq);

                    // Classify severity
                    var level;
                    if (dist < THRESHOLD_CRITICAL) {
                        level = LEVEL_CRITICAL;
                    } else if (dist < THRESHOLD_WARNING) {
                        level = LEVEL_WARNING;
                    } else {
                        level = LEVEL_WATCH;
                    }

                    // Sort IDs for consistent pair tracking
                    var sortedId1 = a.id < b.id ? a.id : b.id;
                    var sortedId2 = a.id < b.id ? b.id : a.id;
                    var trackKey = sortedId1 + '|' + sortedId2;

                    // TCA estimation using relative velocity
                    var tca = null;
                    if (a.hasVel && b.hasVel) {
                        // Relative position and velocity
                        var relVx = a.velX - b.velX;
                        var relVy = a.velY - b.velY;
                        var relVz = a.velZ - b.velZ;

                        // Time to closest approach: t_min = -(r . v) / (v . v)
                        var rDotV = dx * relVx + dy * relVy + dz * relVz;
                        var vDotV = relVx * relVx + relVy * relVy + relVz * relVz;

                        if (vDotV > 0.01) { // Avoid division by near-zero
                            var tMin = -rDotV / vDotV;
                            if (tMin > 0 && tMin < TCA_MAX_LOOKAHEAD) {
                                tca = simTime + tMin;

                                // Compute distance at TCA for better classification
                                var tcaDx = dx + relVx * tMin;
                                var tcaDy = dy + relVy * tMin;
                                var tcaDz = dz + relVz * tMin;
                                var tcaDist = Math.sqrt(tcaDx * tcaDx + tcaDy * tcaDy + tcaDz * tcaDz);

                                // Upgrade severity if TCA distance is worse
                                if (tcaDist < THRESHOLD_CRITICAL && level !== LEVEL_CRITICAL) {
                                    level = LEVEL_CRITICAL;
                                } else if (tcaDist < THRESHOLD_WARNING && level === LEVEL_WATCH) {
                                    level = LEVEL_WARNING;
                                }
                            }
                        }
                    }

                    // Fallback TCA from distance trend (previous tick comparison)
                    if (tca === null) {
                        var prev = _prevDistances[trackKey];
                        if (prev && prev.time < simTime) {
                            var dDist = dist - prev.dist;
                            var dTime = simTime - prev.time;
                            if (dDist < 0 && dTime > 0) {
                                // Closing — extrapolate linearly
                                var rate = dDist / dTime; // negative = closing
                                var tToZero = -dist / rate;
                                if (tToZero > 0 && tToZero < TCA_MAX_LOOKAHEAD) {
                                    tca = simTime + tToZero;
                                }
                            }
                        }
                    }

                    // Store current distance for next tick comparison
                    _prevDistances[trackKey] = { dist: dist, time: simTime };

                    // Compute midpoint for camera targeting
                    var midX = (a.eciX + b.eciX) * 0.5;
                    var midY = (a.eciY + b.eciY) * 0.5;
                    var midZ = (a.eciZ + b.eciZ) * 0.5;

                    newAlerts.push({
                        id1: sortedId1,
                        id2: sortedId2,
                        name1: a.id === sortedId1 ? a.name : b.name,
                        name2: a.id === sortedId2 ? a.name : b.name,
                        dist: dist,
                        tca: tca,
                        level: level,
                        midpoint: [midX, midY, midZ]
                    });
                }
            }
        }

        // Sort by severity then distance
        newAlerts.sort(function(a, b) {
            var pDiff = LEVEL_PRIORITY[a.level] - LEVEL_PRIORITY[b.level];
            if (pDiff !== 0) return pDiff;
            return a.dist - b.dist;
        });

        // Trim to max display count
        if (newAlerts.length > MAX_DISPLAY_ALERTS) {
            newAlerts.length = MAX_DISPLAY_ALERTS;
        }

        _alerts = newAlerts;

        // Clean up stale entries in _prevDistances (older than 10 seconds)
        var staleThreshold = simTime - 10;
        var keys = Object.keys(_prevDistances);
        for (var ki = 0; ki < keys.length; ki++) {
            if (_prevDistances[keys[ki]].time < staleThreshold) {
                delete _prevDistances[keys[ki]];
            }
        }
    }

    // ===================== UPDATE =====================

    /**
     * Called each tick (~60Hz). Internally throttled to 1 Hz for performance.
     */
    function update(world, simTime) {
        if (!world) return;
        _world = world;

        var now = performance.now();
        if (now - _lastUpdateTime < UPDATE_INTERVAL_MS) return;
        _lastUpdateTime = now;

        // Build entity position cache
        _buildEntityCache(world);

        // Run detection
        _detectConjunctions(simTime);

        // Update panel if visible
        if (_visible) {
            _renderPanel();
        }
    }

    // ===================== PANEL RENDERING =====================

    function _renderPanel() {
        if (!_alertListEl || !_alertCountEl) return;

        var critCount = 0;
        var warnCount = 0;
        var watchCount = 0;

        for (var i = 0; i < _alerts.length; i++) {
            if (_alerts[i].level === LEVEL_CRITICAL) critCount++;
            else if (_alerts[i].level === LEVEL_WARNING) warnCount++;
            else watchCount++;
        }

        // Update header count with severity breakdown
        var countParts = [];
        if (critCount > 0) countParts.push('<span style="color:#ff3333">' + critCount + ' CRIT</span>');
        if (warnCount > 0) countParts.push('<span style="color:#ffcc00">' + warnCount + ' WARN</span>');
        if (watchCount > 0) countParts.push('<span style="color:#888">' + watchCount + ' WATCH</span>');
        _alertCountEl.innerHTML = countParts.length > 0 ? countParts.join(' ') : '0';

        // Update border color based on worst severity
        if (critCount > 0) {
            _panelEl.style.borderColor = '#ff3333';
        } else if (warnCount > 0) {
            _panelEl.style.borderColor = '#ffcc00';
        } else if (watchCount > 0) {
            _panelEl.style.borderColor = '#666666';
        } else {
            _panelEl.style.borderColor = '#333333';
        }

        // Build alert list HTML
        if (_alerts.length === 0) {
            _alertListEl.innerHTML = '<div class="cj-empty">No active conjunctions</div>';
            return;
        }

        var html = [];
        for (var i = 0; i < _alerts.length; i++) {
            var alert = _alerts[i];
            var levelClass = alert.level === LEVEL_CRITICAL ? 'critical' :
                             alert.level === LEVEL_WARNING ? 'warning' : 'watch';
            var color = LEVEL_COLORS[alert.level];

            // Format distance
            var distStr;
            if (alert.dist < 1000) {
                distStr = Math.round(alert.dist) + ' m';
            } else {
                distStr = (alert.dist / 1000).toFixed(1) + ' km';
            }

            // Format TCA
            var tcaStr = '';
            if (alert.tca != null) {
                var tcaSec = alert.tca - (_world ? _world.simTime : 0);
                if (tcaSec > 0) {
                    if (tcaSec < 60) {
                        tcaStr = 'TCA T-' + Math.round(tcaSec) + 's';
                    } else {
                        tcaStr = 'TCA T-' + (tcaSec / 60).toFixed(1) + 'm';
                    }
                } else {
                    tcaStr = 'TCA passed';
                }
            }

            html.push(
                '<div class="cj-alert-row" data-alert-idx="' + i + '">',
                '  <span class="cj-level-dot ' + levelClass + '"></span>',
                '  <span class="cj-alert-dist" style="color:' + color + '">' + distStr + '</span>',
                '  <div class="cj-alert-info">',
                '    <div class="cj-alert-names">' + _escHtml(alert.name1) + ' / ' + _escHtml(alert.name2) + '</div>',
                tcaStr ? '    <div class="cj-alert-tca">' + tcaStr + '</div>' : '',
                '  </div>',
                '</div>'
            );
        }
        _alertListEl.innerHTML = html.join('');

        // Attach click handlers for camera zoom
        var rows = _alertListEl.querySelectorAll('.cj-alert-row');
        for (var ri = 0; ri < rows.length; ri++) {
            rows[ri].addEventListener('click', _onAlertClick);
        }
    }

    function _onAlertClick(e) {
        var row = e.currentTarget;
        var idx = parseInt(row.getAttribute('data-alert-idx'), 10);
        if (isNaN(idx) || idx < 0 || idx >= _alerts.length) return;

        var alert = _alerts[idx];
        if (!alert.midpoint || !_viewer) return;

        // Fly camera to look at the conjunction midpoint
        var midCart = new Cesium.Cartesian3(
            alert.midpoint[0], alert.midpoint[1], alert.midpoint[2]);

        // Compute a reasonable viewing distance based on conjunction distance
        var viewDist = Math.max(alert.dist * 5, 5000);  // At least 5 km
        viewDist = Math.min(viewDist, 500000);  // Cap at 500 km

        _viewer.camera.flyToBoundingSphere(
            new Cesium.BoundingSphere(midCart, alert.dist * 0.5),
            {
                offset: new Cesium.HeadingPitchRange(0, -0.4, viewDist),
                duration: 1.5
            }
        );
    }

    // ===================== HTML HELPERS =====================

    function _escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===================== PUBLIC API =====================

    /**
     * Toggle panel visibility. Returns new visibility state.
     */
    function toggle() {
        _visible = !_visible;
        if (_panelEl) {
            if (_visible) {
                _panelEl.classList.add('visible');
                _renderPanel();
            } else {
                _panelEl.classList.remove('visible');
            }
        }
        return _visible;
    }

    /**
     * Get current alert list.
     */
    function getAlerts() {
        return _alerts;
    }

    /**
     * Check if panel is visible.
     */
    function isVisible() {
        return _visible;
    }

    /**
     * Get count of alerts by severity.
     */
    function getCounts() {
        var crit = 0, warn = 0, watch = 0;
        for (var i = 0; i < _alerts.length; i++) {
            if (_alerts[i].level === LEVEL_CRITICAL) crit++;
            else if (_alerts[i].level === LEVEL_WARNING) warn++;
            else watch++;
        }
        return { critical: crit, warning: warn, watch: watch, total: _alerts.length };
    }

    /**
     * Set custom thresholds (meters).
     */
    function setThresholds(critical, warning, watch) {
        if (critical != null) THRESHOLD_CRITICAL = critical;
        if (warning != null) THRESHOLD_WARNING = warning;
        if (watch != null) {
            THRESHOLD_WATCH = watch;
            CELL_SIZE = watch;
            INV_CELL_SIZE = 1.0 / CELL_SIZE;
        }
    }

    return {
        init: init,
        update: update,
        toggle: toggle,
        getAlerts: getAlerts,
        isVisible: isVisible,
        getCounts: getCounts,
        setThresholds: setThresholds
    };

})();
