/**
 * EntityTooltip — Hover tooltip for entities in the Live Sim Viewer.
 *
 * Shows detailed info when hovering over Cesium entities or entity list rows:
 *   - Name, team, type, status
 *   - Position (lat/lon/alt)
 *   - Aircraft: speed, Mach, heading, flight path angle, G-load, fuel
 *   - Satellites: orbital elements (SMA, ecc, inc, RAAN), regime, period
 *   - Ground: lat/lon, sensor type/range if applicable
 *   - Weapons/sensors summary
 *
 * Usage:
 *   EntityTooltip.init(viewer, world);
 *   EntityTooltip.update();   // call each frame to refresh live data
 */
(function() {
    'use strict';

    var _viewer = null;
    var _world = null;
    var _tooltipEl = null;
    var _handler = null;
    var _currentEntity = null;
    var _visible = false;
    var _mouseX = 0;
    var _mouseY = 0;
    var _fadeTimer = null;
    var _hoverSource = null; // 'cesium' or 'list'

    // Throttle: only rebuild HTML at ~10 Hz, reposition every frame
    var _lastContentUpdate = 0;
    var CONTENT_INTERVAL = 100; // ms

    var DEG = 180 / Math.PI;
    var R_EARTH = 6371000;
    var MU = 3.986004418e14;

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    function init(viewer, world) {
        _viewer = viewer;
        _world = world;

        // Create tooltip element if not already present
        _tooltipEl = document.getElementById('entityTooltip');
        if (!_tooltipEl) {
            _tooltipEl = document.createElement('div');
            _tooltipEl.id = 'entityTooltip';
            _tooltipEl.style.cssText =
                'display:none;position:fixed;z-index:100;' +
                'background:rgba(0,0,0,0.88);' +
                'border:1px solid rgba(68,170,255,0.5);border-radius:5px;' +
                'padding:8px 10px;color:#ccc;' +
                'font-family:"Courier New",monospace;font-size:11px;' +
                'max-width:300px;min-width:180px;' +
                'pointer-events:none;' +
                'opacity:0;transition:opacity 0.15s ease-in-out;' +
                'line-height:1.5;' +
                'box-shadow:0 2px 12px rgba(0,0,0,0.6);';
            document.body.appendChild(_tooltipEl);
        }

        _setupCesiumHover();
        _setupEntityListHover();
    }

    // -----------------------------------------------------------------------
    // Cesium hover via ScreenSpaceEventHandler
    // -----------------------------------------------------------------------
    function _setupCesiumHover() {
        if (!_viewer) return;

        _handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);

        _handler.setInputAction(function(movement) {
            _mouseX = movement.endPosition.x;
            _mouseY = movement.endPosition.y;

            var picked = _viewer.scene.pick(movement.endPosition);
            if (Cesium.defined(picked) && picked.id && picked.id._ecsEntityId) {
                var ecsId = picked.id._ecsEntityId;
                var entity = _world ? _world.getEntity(ecsId) : null;
                if (entity) {
                    _show(entity, _mouseX, _mouseY, 'cesium');
                    return;
                }
            }
            // Only hide if source was cesium (don't hide list-triggered tooltips)
            if (_hoverSource === 'cesium') {
                _hide();
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    }

    // -----------------------------------------------------------------------
    // Entity list hover
    // -----------------------------------------------------------------------
    function _setupEntityListHover() {
        // Use event delegation on the entity list inner container.
        // Needs to be re-wired if the DOM element is recreated, but entityListInner
        // is persistent — only its innerHTML is rebuilt.
        var listEl = document.getElementById('entityListInner');
        if (!listEl) {
            // Retry after a short delay (list may not exist at init time)
            setTimeout(_setupEntityListHover, 500);
            return;
        }

        listEl.addEventListener('mouseover', function(e) {
            var row = e.target.closest('.entity-row');
            if (!row) return;
            var eid = row.getAttribute('data-eid');
            if (!eid || !_world) return;
            var entity = _world.getEntity(eid);
            if (!entity) return;

            var rect = row.getBoundingClientRect();
            // Position tooltip to the left of the entity list panel
            _show(entity, rect.left - 10, rect.top + rect.height / 2, 'list');
        });

        listEl.addEventListener('mouseout', function(e) {
            var row = e.target.closest('.entity-row');
            if (!row) return;
            // Check if we're leaving the row entirely (not entering a child)
            var related = e.relatedTarget;
            if (related && row.contains(related)) return;
            if (_hoverSource === 'list') {
                _hide();
            }
        });
    }

    // -----------------------------------------------------------------------
    // Show / Hide / Update
    // -----------------------------------------------------------------------
    function _show(entity, x, y, source) {
        _currentEntity = entity;
        _hoverSource = source || 'cesium';
        _mouseX = x;
        _mouseY = y;

        // Build content immediately on first show
        _buildContent(entity);
        _positionTooltip(x, y, source);

        _tooltipEl.style.display = 'block';
        // Force reflow for transition
        void _tooltipEl.offsetWidth;
        _tooltipEl.style.opacity = '1';
        _visible = true;

        if (_fadeTimer) {
            clearTimeout(_fadeTimer);
            _fadeTimer = null;
        }
    }

    function _hide() {
        if (!_visible) return;
        _tooltipEl.style.opacity = '0';
        _fadeTimer = setTimeout(function() {
            _tooltipEl.style.display = 'none';
            _visible = false;
            _currentEntity = null;
            _hoverSource = null;
        }, 150);
    }

    /**
     * Call every frame to keep tooltip data fresh.
     */
    function update() {
        if (!_visible || !_currentEntity) return;

        var now = performance.now();
        if (now - _lastContentUpdate > CONTENT_INTERVAL) {
            _lastContentUpdate = now;
            _buildContent(_currentEntity);
        }

        // Reposition for cesium (follows mouse); list stays put
        if (_hoverSource === 'cesium') {
            _positionTooltip(_mouseX, _mouseY, 'cesium');
        }
    }

    // -----------------------------------------------------------------------
    // Tooltip positioning
    // -----------------------------------------------------------------------
    function _positionTooltip(x, y, source) {
        if (!_tooltipEl) return;

        var w = _tooltipEl.offsetWidth || 200;
        var h = _tooltipEl.offsetHeight || 100;
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var px, py;

        if (source === 'list') {
            // Position to the left of the cursor/row
            px = x - w - 12;
            py = y - h / 2;
            // If it goes off-screen left, flip to right
            if (px < 5) px = x + 15;
        } else {
            // Cesium: offset to the right and slightly above cursor
            px = x + 18;
            py = y - 12;
        }

        // Clamp to viewport
        if (px + w > vw - 5) px = vw - w - 5;
        if (px < 5) px = 5;
        if (py + h > vh - 5) py = vh - h - 5;
        if (py < 5) py = 5;

        _tooltipEl.style.left = px + 'px';
        _tooltipEl.style.top = py + 'px';
    }

    // -----------------------------------------------------------------------
    // Build tooltip HTML content
    // -----------------------------------------------------------------------
    function _buildContent(entity) {
        if (!entity || !_tooltipEl) return;

        var s = entity.state || {};
        var html = '';

        // --- Header: name + team badge ---
        var teamColor = _teamColor(entity.team);
        var statusText = entity.active ? 'ACTIVE' : 'DESTROYED';
        var statusColor = entity.active ? '#00cc44' : '#ff3333';

        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">';
        html += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + teamColor + ';flex-shrink:0"></span>';
        html += '<span style="font-size:13px;font-weight:bold;color:' + teamColor + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(entity.name || entity.id) + '</span>';
        html += '</div>';

        // --- Type + Status row ---
        html += '<div style="display:flex;justify-content:space-between;margin-bottom:3px">';
        html += '<span style="color:#888">' + _esc(entity.type || 'unknown').toUpperCase() + '</span>';
        html += '<span style="color:' + statusColor + ';font-size:10px">' + statusText + '</span>';
        html += '</div>';

        // --- Team row ---
        html += _row('Team', _esc(entity.team || 'neutral').toUpperCase(), teamColor);

        // --- Separator ---
        html += _sep();

        // --- Position ---
        if (s.lat != null && s.lon != null) {
            var latDeg = (s.lat * DEG).toFixed(4);
            var lonDeg = (s.lon * DEG).toFixed(4);
            html += _row('Lat', latDeg + '\u00B0');
            html += _row('Lon', lonDeg + '\u00B0');
        }
        if (s.alt != null) {
            html += _row('Alt', _formatAlt(s.alt));
        }

        // --- Determine entity physics type ---
        var physComp = entity.getComponent ? entity.getComponent('physics') : null;
        var physType = physComp ? (physComp.config && physComp.config.type) : null;
        var isOrbital = physType === 'orbital_2body';
        var isFlight = physType === 'flight3dof';
        var isStatic = !physComp || physType === 'static';

        // --- Aircraft / flight data ---
        if (isFlight || (s.speed != null && s.alt != null && !isOrbital && !isStatic)) {
            html += _sep();
            html += _sectionTitle('FLIGHT DATA');

            if (s.speed != null) {
                var speedStr = Math.round(s.speed) + ' m/s';
                // Compute Mach if we have altitude
                if (s.alt != null && typeof FighterAtmosphere !== 'undefined') {
                    var atm = FighterAtmosphere.getAtmosphere(s.alt);
                    if (atm && atm.speedOfSound > 0) {
                        var mach = s.speed / atm.speedOfSound;
                        speedStr += ' (M' + mach.toFixed(2) + ')';
                    }
                }
                html += _row('Speed', speedStr);
            }

            if (s.heading != null) {
                html += _row('Hdg', (s.heading * DEG).toFixed(1) + '\u00B0');
            }
            if (s.gamma != null) {
                html += _row('FPA', (s.gamma * DEG).toFixed(1) + '\u00B0');
            }
            if (s.gLoad != null) {
                var gColor = Math.abs(s.gLoad) > 7 ? '#ff3333' : Math.abs(s.gLoad) > 5 ? '#ffff00' : '#ccc';
                html += _row('G-Load', s.gLoad.toFixed(1) + ' G', gColor);
            }
            if (s.fuel != null && isFinite(s.fuel)) {
                var fuelPct = s.fuelMax ? ((s.fuel / s.fuelMax) * 100).toFixed(0) + '%' : Math.round(s.fuel) + ' kg';
                var fuelColor = (s.fuelMax && s.fuel / s.fuelMax < 0.2) ? '#ff3333' :
                                (s.fuelMax && s.fuel / s.fuelMax < 0.5) ? '#ffff00' : '#ccc';
                html += _row('Fuel', fuelPct, fuelColor);
            }
            if (s.throttle != null) {
                html += _row('Throttle', Math.round(s.throttle * 100) + '%');
            }
        }

        // --- Orbital data ---
        if (isOrbital) {
            var orb = (physComp && physComp._orbitalElements) || s._orbital || null;
            if (orb) {
                html += _sep();
                html += _sectionTitle('ORBITAL');

                // Regime classification
                var regime = _classifyOrbit(orb);
                var regimeColor = regime === 'LEO' ? '#44ff44' : regime === 'MEO' ? '#44ccff' :
                                  regime === 'GEO' ? '#ffcc44' : regime === 'HEO' ? '#ff8844' :
                                  regime === 'ESCAPE' ? '#ff4444' : '#aaa';
                html += _row('Regime', regime, regimeColor);

                if (orb.sma != null && orb.sma > 0) {
                    html += _row('SMA', ((orb.sma / 1000).toFixed(1)) + ' km');
                }
                if (orb.eccentricity != null) {
                    html += _row('Ecc', orb.eccentricity.toFixed(5));
                }
                if (orb.inclination != null) {
                    html += _row('Inc', (orb.inclination * DEG).toFixed(2) + '\u00B0');
                }
                if (orb.raan != null) {
                    html += _row('RAAN', (orb.raan * DEG).toFixed(2) + '\u00B0');
                }
                if (orb.periapsisAlt != null) {
                    html += _row('Pe Alt', _formatAlt(orb.periapsisAlt));
                }
                if (orb.apoapsisAlt != null) {
                    html += _row('Ap Alt', _formatAlt(orb.apoapsisAlt));
                }
                if (orb.period != null && orb.period > 0) {
                    html += _row('Period', _formatTime(orb.period));
                }
            }

            // Speed for orbital entities
            if (s.speed != null) {
                html += _row('Speed', (s.speed / 1000).toFixed(2) + ' km/s');
            }
        }

        // --- Sensor info ---
        var sensorComp = entity.getComponent ? entity.getComponent('sensors') || entity.getComponent('sensor') : null;
        var customSensors = entity.def && entity.def._custom && entity.def._custom.sensors;
        if (sensorComp || customSensors) {
            html += _sep();
            html += _sectionTitle('SENSORS');

            if (sensorComp && sensorComp.config) {
                var sc = sensorComp.config;
                html += _row('Type', (sc.type || 'radar').toUpperCase());
                if (sc.maxRange_m) {
                    html += _row('Range', _formatDist(sc.maxRange_m));
                }
            }
            if (customSensors) {
                var sNames = [];
                if (customSensors.radar && customSensors.radar.enabled) sNames.push('RADAR');
                if (customSensors.optical && customSensors.optical.enabled) sNames.push('EO');
                if (customSensors.ir && customSensors.ir.enabled) sNames.push('IR');
                if (customSensors.sar && customSensors.sar.enabled) sNames.push('SAR');
                if (customSensors.sigint && customSensors.sigint.enabled) sNames.push('SIGINT');
                if (customSensors.lidar && customSensors.lidar.enabled) sNames.push('LIDAR');
                if (sNames.length > 0) {
                    html += _row('Suite', sNames.join(', '));
                }
            }
        }

        // --- Weapon info ---
        var weaponComp = entity.getComponent ? entity.getComponent('weapons') || entity.getComponent('weapon') : null;
        var customPayloads = entity.def && entity.def._custom && entity.def._custom.payloads;
        if (weaponComp || customPayloads) {
            html += _sep();
            html += _sectionTitle('WEAPONS');

            if (weaponComp && weaponComp.config) {
                var wc = weaponComp.config;
                var wType = (wc.type || 'unknown').toUpperCase().replace(/_/g, ' ');
                html += _row('Type', wType);
                if (wc.maxRange_m) {
                    html += _row('Range', _formatDist(wc.maxRange_m));
                }
            }
            if (customPayloads) {
                var pNames = [];
                if (customPayloads.a2a) pNames.push('A2A');
                if (customPayloads.a2g) pNames.push('A2G');
                if (customPayloads.kkv) pNames.push('KKV');
                if (customPayloads.jammer) pNames.push('JAMMER');
                if (customPayloads.decoys) pNames.push('DECOYS');
                if (customPayloads.nuclear_warhead) pNames.push('NUKE');
                if (customPayloads.nuclear_cruise) pNames.push('CRUISE');
                if (customPayloads.space_debris) pNames.push('DEBRIS');
                if (pNames.length > 0) {
                    html += _row('Loadout', pNames.join(', '));
                }
            }
        }

        // --- VizCategory ---
        if (entity.vizCategory) {
            html += _sep();
            html += _row('Group', entity.vizCategory, '#666');
        }

        _tooltipEl.innerHTML = html;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function _row(label, value, valueColor) {
        var vc = valueColor || '#ddd';
        return '<div style="display:flex;justify-content:space-between;gap:8px">' +
            '<span style="color:#777;white-space:nowrap">' + label + '</span>' +
            '<span style="color:' + vc + ';text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + value + '</span>' +
            '</div>';
    }

    function _sep() {
        return '<div style="height:1px;background:rgba(100,100,100,0.3);margin:4px 0"></div>';
    }

    function _sectionTitle(text) {
        return '<div style="color:#557;font-size:9px;letter-spacing:1px;margin-bottom:1px">' + text + '</div>';
    }

    function _teamColor(team) {
        if (team === 'blue') return '#4488ff';
        if (team === 'red') return '#ff4444';
        if (team === 'green') return '#44cc44';
        return '#888888';
    }

    function _formatAlt(alt) {
        if (alt == null || !isFinite(alt)) return '---';
        if (Math.abs(alt) >= 10000) return (alt / 1000).toFixed(1) + ' km';
        return Math.round(alt) + ' m';
    }

    function _formatDist(d) {
        if (d == null || !isFinite(d)) return '---';
        if (d >= 1000) return (d / 1000).toFixed(1) + ' km';
        return Math.round(d) + ' m';
    }

    function _formatTime(seconds) {
        if (!seconds || !isFinite(seconds) || seconds <= 0) return '---';
        if (seconds < 60) return seconds.toFixed(1) + 's';
        if (seconds < 3600) return (seconds / 60).toFixed(1) + ' min';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    function _classifyOrbit(orb) {
        if (!orb || orb.eccentricity == null) return '---';
        if (orb.eccentricity >= 1.0 || (orb.sma != null && orb.sma <= 0)) return 'ESCAPE';

        var sma = orb.sma;
        if (!sma || !isFinite(sma)) return '---';

        var altKm = (sma - R_EARTH) / 1000;

        if (orb.eccentricity > 0.25) return 'HEO';
        if (altKm < 2000) return 'LEO';
        if (altKm < 35000) return 'MEO';
        if (altKm < 37000) return 'GEO';
        return 'HEO';
    }

    function _esc(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    function show(entity, screenPos) {
        var x = screenPos ? screenPos.x : _mouseX;
        var y = screenPos ? screenPos.y : _mouseY;
        _show(entity, x, y, 'cesium');
    }

    // Allow external code to update the world reference (e.g., after assume-control rebuilds)
    function setWorld(world) {
        _world = world;
    }

    window.EntityTooltip = {
        init: init,
        show: show,
        hide: _hide,
        update: update,
        setWorld: setWorld
    };

})();
