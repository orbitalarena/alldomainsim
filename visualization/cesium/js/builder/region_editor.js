/**
 * Region Editor — Draw and manage geographic regions (zones, areas) in the scenario builder.
 * Supports circle and polygon regions with type-based styling.
 */
const RegionEditor = (function() {
    'use strict';

    var _viewer = null;
    var _regions = [];       // Array of region objects
    var _nextId = 1;
    var _drawMode = null;    // null, 'circle', 'polygon'
    var _drawPoints = [];    // Points being drawn
    var _drawEntity = null;  // Temporary Cesium entity for drawing preview
    var _selectedRegion = null;
    var _handler = null;

    // Region types with default colors
    var REGION_TYPES = {
        'no_fly':     { label: 'No-Fly Zone',    color: 'rgba(255,50,50,0.15)',   outline: '#ff4444', icon: '!' },
        'threat':     { label: 'Threat Area',     color: 'rgba(255,160,0,0.12)',   outline: '#ff8800', icon: '/!\\' },
        'engagement': { label: 'Engagement Zone', color: 'rgba(255,0,100,0.12)',   outline: '#ff0066', icon: '(x)' },
        'friendly':   { label: 'Friendly Area',   color: 'rgba(50,150,255,0.12)',  outline: '#4488ff', icon: '[+]' },
        'objective':  { label: 'Objective Area',   color: 'rgba(255,220,0,0.12)',  outline: '#ffcc00', icon: '*' },
        'corridor':   { label: 'Transit Corridor', color: 'rgba(0,255,150,0.10)', outline: '#00ff88', icon: '->' },
        'custom':     { label: 'Custom Region',    color: 'rgba(180,180,180,0.1)', outline: '#aaaaaa', icon: '[]' }
    };

    function init(viewer) {
        _viewer = viewer;
        _setupDrawHandler();
    }

    function _setupDrawHandler() {
        _handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);

        // Left click to place points
        _handler.setInputAction(function(click) {
            if (!_drawMode) return;

            var ray = _viewer.camera.getPickRay(click.position);
            if (!ray) return;
            var cartesian = _viewer.scene.globe.pick(ray, _viewer.scene);
            if (!cartesian) return;
            var carto = Cesium.Cartographic.fromCartesian(cartesian);
            var latDeg = Cesium.Math.toDegrees(carto.latitude);
            var lonDeg = Cesium.Math.toDegrees(carto.longitude);

            if (_drawMode === 'circle') {
                if (_drawPoints.length === 0) {
                    // First click: center
                    _drawPoints.push({ lat: latDeg, lon: lonDeg });
                    _updateDrawPreview();
                } else {
                    // Second click: edge (defines radius)
                    var center = _drawPoints[0];
                    var radius = _haversineDistance(center.lat, center.lon, latDeg, lonDeg);
                    _finishCircle(center.lat, center.lon, radius);
                }
            } else if (_drawMode === 'polygon') {
                _drawPoints.push({ lat: latDeg, lon: lonDeg });
                _updateDrawPreview();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Right click to finish polygon or cancel
        _handler.setInputAction(function() {
            if (_drawMode === 'polygon' && _drawPoints.length >= 3) {
                _finishPolygon(_drawPoints.slice());
            } else {
                cancelDraw();
            }
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // Mouse move for preview
        _handler.setInputAction(function(move) {
            if (!_drawMode || _drawPoints.length === 0) return;

            var ray = _viewer.camera.getPickRay(move.endPosition);
            if (!ray) return;
            var cartesian = _viewer.scene.globe.pick(ray, _viewer.scene);
            if (!cartesian) return;
            var carto = Cesium.Cartographic.fromCartesian(cartesian);
            var latDeg = Cesium.Math.toDegrees(carto.latitude);
            var lonDeg = Cesium.Math.toDegrees(carto.longitude);

            _updateDrawPreview(latDeg, lonDeg);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    }

    function _updateDrawPreview(mouseLat, mouseLon) {
        if (_drawEntity) {
            _viewer.entities.remove(_drawEntity);
            _drawEntity = null;
        }

        if (_drawMode === 'circle' && _drawPoints.length === 1 && mouseLat != null) {
            var center = _drawPoints[0];
            var radius = _haversineDistance(center.lat, center.lon, mouseLat, mouseLon);
            _drawEntity = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(center.lon, center.lat),
                ellipse: {
                    semiMajorAxis: radius,
                    semiMinorAxis: radius,
                    material: Cesium.Color.WHITE.withAlpha(0.1),
                    outline: true,
                    outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                    outlineWidth: 2,
                    height: 0
                }
            });
        } else if (_drawMode === 'polygon' && _drawPoints.length >= 1) {
            var positions = _drawPoints.map(function(p) {
                return Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
            });
            if (mouseLat != null) {
                positions.push(Cesium.Cartesian3.fromDegrees(mouseLon, mouseLat));
            }
            if (positions.length >= 2) {
                _drawEntity = _viewer.entities.add({
                    polyline: {
                        positions: positions.concat([positions[0]]),
                        width: 2,
                        material: Cesium.Color.WHITE.withAlpha(0.5)
                    }
                });
            }
        }
    }

    function _finishCircle(centerLat, centerLon, radius) {
        var region = {
            id: 'region_' + (_nextId++),
            shape: 'circle',
            center: { lat: centerLat, lon: centerLon },
            radius: radius,
            type: 'custom',
            name: 'Region ' + _regions.length,
            team: 'neutral',
            notes: ''
        };
        _addRegion(region);
        cancelDraw();
    }

    function _finishPolygon(points) {
        var region = {
            id: 'region_' + (_nextId++),
            shape: 'polygon',
            points: points,
            type: 'custom',
            name: 'Region ' + _regions.length,
            team: 'neutral',
            notes: ''
        };
        _addRegion(region);
        cancelDraw();
    }

    function _addRegion(region) {
        _regions.push(region);
        _createCesiumEntity(region);
        _selectedRegion = region;
        _fireEvent('regionAdded', region);
        _updateRegionList();
        _updateRegionProperties();
    }

    function _createCesiumEntity(region) {
        var typeInfo = REGION_TYPES[region.type] || REGION_TYPES.custom;
        var fillColor = Cesium.Color.fromCssColorString(typeInfo.color);
        var outlineColor = Cesium.Color.fromCssColorString(typeInfo.outline);

        if (region.shape === 'circle') {
            region._cesiumEntity = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(region.center.lon, region.center.lat),
                ellipse: {
                    semiMajorAxis: region.radius,
                    semiMinorAxis: region.radius,
                    material: fillColor,
                    outline: true,
                    outlineColor: outlineColor,
                    outlineWidth: 2,
                    height: 0
                },
                label: {
                    text: region.name,
                    font: '12px monospace',
                    fillColor: outlineColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -10)
                }
            });
        } else if (region.shape === 'polygon') {
            var positions = region.points.map(function(p) {
                return Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
            });
            region._cesiumEntity = _viewer.entities.add({
                polygon: {
                    hierarchy: new Cesium.PolygonHierarchy(positions),
                    material: fillColor,
                    outline: true,
                    outlineColor: outlineColor,
                    outlineWidth: 2,
                    height: 0
                }
            });
            // Add label at centroid
            var cLat = 0, cLon = 0;
            region.points.forEach(function(p) { cLat += p.lat; cLon += p.lon; });
            cLat /= region.points.length;
            cLon /= region.points.length;
            region._labelEntity = _viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(cLon, cLat),
                label: {
                    text: region.name,
                    font: '12px monospace',
                    fillColor: outlineColor,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -5)
                }
            });
        }
    }

    function _removeCesiumEntity(region) {
        if (region._cesiumEntity) {
            _viewer.entities.remove(region._cesiumEntity);
            region._cesiumEntity = null;
        }
        if (region._labelEntity) {
            _viewer.entities.remove(region._labelEntity);
            region._labelEntity = null;
        }
    }

    function startCircleDraw() {
        cancelDraw();
        _drawMode = 'circle';
        _drawPoints = [];
        _viewer.scene.canvas.style.cursor = 'crosshair';
    }

    function startPolygonDraw() {
        cancelDraw();
        _drawMode = 'polygon';
        _drawPoints = [];
        _viewer.scene.canvas.style.cursor = 'crosshair';
    }

    function cancelDraw() {
        _drawMode = null;
        _drawPoints = [];
        if (_drawEntity) {
            _viewer.entities.remove(_drawEntity);
            _drawEntity = null;
        }
        if (_viewer) _viewer.scene.canvas.style.cursor = '';
    }

    function updateRegion(regionId, updates) {
        var region = _regions.find(function(r) { return r.id === regionId; });
        if (!region) return;

        // Apply updates
        Object.keys(updates).forEach(function(key) {
            if (key !== 'id' && key !== '_cesiumEntity' && key !== '_labelEntity') {
                region[key] = updates[key];
            }
        });

        // Recreate visual
        _removeCesiumEntity(region);
        _createCesiumEntity(region);
        _updateRegionList();
    }

    function removeRegion(regionId) {
        var idx = _regions.findIndex(function(r) { return r.id === regionId; });
        if (idx === -1) return;
        var region = _regions[idx];
        _removeCesiumEntity(region);
        _regions.splice(idx, 1);
        if (_selectedRegion === region) _selectedRegion = null;
        _updateRegionList();
        _updateRegionProperties();
        _fireEvent('regionRemoved', region);
    }

    function getRegions() {
        return _regions.map(function(r) {
            var obj = {
                id: r.id,
                shape: r.shape,
                type: r.type,
                name: r.name,
                team: r.team,
                notes: r.notes
            };
            if (r.shape === 'circle') {
                obj.center = { lat: r.center.lat, lon: r.center.lon };
                obj.radius = r.radius;
            } else if (r.shape === 'polygon') {
                obj.points = r.points.map(function(p) { return { lat: p.lat, lon: p.lon }; });
            }
            return obj;
        });
    }

    function loadRegions(regionDefs) {
        // Clear existing
        _regions.forEach(function(r) { _removeCesiumEntity(r); });
        _regions = [];
        _selectedRegion = null;

        if (!regionDefs || !Array.isArray(regionDefs)) return;

        regionDefs.forEach(function(def) {
            var region = Object.assign({}, def);
            region.id = region.id || 'region_' + (_nextId++);
            // Ensure _nextId stays above any loaded region IDs
            var match = region.id.match(/_(\d+)$/);
            if (match) {
                var num = parseInt(match[1], 10);
                if (num >= _nextId) _nextId = num + 1;
            }
            _regions.push(region);
            _createCesiumEntity(region);
        });
        _updateRegionList();
    }

    function clearAll() {
        _regions.forEach(function(r) { _removeCesiumEntity(r); });
        _regions = [];
        _selectedRegion = null;
        _updateRegionList();
        _updateRegionProperties();
    }

    // Check if a point (lat/lon in degrees) is inside a region
    function isInsideRegion(regionId, latDeg, lonDeg) {
        var region = _regions.find(function(r) { return r.id === regionId; });
        if (!region) return false;

        if (region.shape === 'circle') {
            var dist = _haversineDistance(region.center.lat, region.center.lon, latDeg, lonDeg);
            return dist <= region.radius;
        } else if (region.shape === 'polygon') {
            return _pointInPolygon(latDeg, lonDeg, region.points);
        }
        return false;
    }

    // Check if a point is inside any region of a given type
    function isInsideAnyRegion(latDeg, lonDeg, regionType) {
        for (var i = 0; i < _regions.length; i++) {
            var r = _regions[i];
            if (regionType && r.type !== regionType) continue;
            if (r.shape === 'circle') {
                var dist = _haversineDistance(r.center.lat, r.center.lon, latDeg, lonDeg);
                if (dist <= r.radius) return r;
            } else if (r.shape === 'polygon') {
                if (_pointInPolygon(latDeg, lonDeg, r.points)) return r;
            }
        }
        return null;
    }

    // Haversine distance in meters
    function _haversineDistance(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var dLat = (lat2 - lat1) * Math.PI / 180;
        var dLon = (lon2 - lon1) * Math.PI / 180;
        var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // Ray casting point-in-polygon
    function _pointInPolygon(lat, lon, points) {
        var inside = false;
        for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
            if ((points[i].lat > lat) !== (points[j].lat > lat) &&
                lon < (points[j].lon - points[i].lon) * (lat - points[i].lat) / (points[j].lat - points[i].lat) + points[i].lon) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Event system
    var _listeners = {};
    function on(event, callback) {
        if (!_listeners[event]) _listeners[event] = [];
        _listeners[event].push(callback);
    }
    function _fireEvent(event, data) {
        if (_listeners[event]) {
            _listeners[event].forEach(function(cb) { cb(data); });
        }
    }

    // UI: Region list panel
    function _updateRegionList() {
        var list = document.getElementById('regionList');
        if (!list) return;

        if (_regions.length === 0) {
            list.innerHTML = '<div style="color:#666; font-size:11px; padding:8px;">No regions defined. Click "Circle" or "Polygon" to draw.</div>';
            return;
        }

        var html = '';
        _regions.forEach(function(r) {
            var typeInfo = REGION_TYPES[r.type] || REGION_TYPES.custom;
            var selected = _selectedRegion === r;
            html += '<div class="region-item' + (selected ? ' selected' : '') + '" data-id="' + r.id + '" style="' +
                'display:flex; justify-content:space-between; align-items:center; padding:4px 8px; margin:2px 0; ' +
                'border-radius:3px; cursor:pointer; border-left:3px solid ' + typeInfo.outline + ';' +
                (selected ? ' background:rgba(0,255,100,0.1);' : ' background:rgba(0,0,0,0.2);') + '">' +
                '<span style="font-size:11px; color:' + (selected ? '#00ff88' : '#aaa') + ';">' +
                typeInfo.icon + ' ' + _escapeHtml(r.name) + '</span>' +
                '<span style="font-size:9px; color:#666;">' + typeInfo.label + '</span>' +
                '</div>';
        });
        list.innerHTML = html;

        // Click handler
        list.querySelectorAll('.region-item').forEach(function(el) {
            el.onclick = function() {
                var id = el.getAttribute('data-id');
                _selectedRegion = _regions.find(function(r) { return r.id === id; }) || null;
                _updateRegionList();
                _updateRegionProperties();
                _fireEvent('regionSelected', _selectedRegion);
                // Fly to region
                if (_selectedRegion) _flyToRegion(_selectedRegion);
            };
        });
    }

    function _escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _flyToRegion(region) {
        if (!_viewer) return;
        if (region.shape === 'circle') {
            _viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(region.center.lon, region.center.lat, region.radius * 3),
                duration: 1.0
            });
        } else if (region.shape === 'polygon' && region.points.length > 0) {
            var cLat = 0, cLon = 0;
            region.points.forEach(function(p) { cLat += p.lat; cLon += p.lon; });
            cLat /= region.points.length;
            cLon /= region.points.length;
            // Estimate extent for camera altitude
            var maxDist = 0;
            region.points.forEach(function(p) {
                var d = _haversineDistance(cLat, cLon, p.lat, p.lon);
                if (d > maxDist) maxDist = d;
            });
            _viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(cLon, cLat, Math.max(maxDist * 3, 50000)),
                duration: 1.0
            });
        }
    }

    // UI: Region properties panel
    function _updateRegionProperties() {
        var panel = document.getElementById('regionProperties');
        if (!panel) return;

        if (!_selectedRegion) {
            panel.innerHTML = '<div style="color:#666; font-size:11px; padding:8px;">Select a region to edit its properties.</div>';
            return;
        }

        var r = _selectedRegion;
        var html = '<div style="padding:4px 0;">';

        // Name input
        html += '<div style="margin-bottom:6px;">';
        html += '<label style="color:#00aa66; font-size:10px; display:block;">NAME</label>';
        html += '<input id="regionNameInput" type="text" value="' + _escapeHtml(r.name || '') + '" style="width:100%; background:rgba(0,0,0,0.5); border:1px solid #333; color:#00ff88; padding:3px 6px; border-radius:3px; font-family:monospace; font-size:11px; box-sizing:border-box;">';
        html += '</div>';

        // Type select
        html += '<div style="margin-bottom:6px;">';
        html += '<label style="color:#00aa66; font-size:10px; display:block;">TYPE</label>';
        html += '<select id="regionTypeSelect" style="width:100%; background:rgba(0,0,0,0.5); border:1px solid #333; color:#00ff88; padding:3px 6px; border-radius:3px; font-family:monospace; font-size:11px;">';
        Object.keys(REGION_TYPES).forEach(function(key) {
            html += '<option value="' + key + '"' + (r.type === key ? ' selected' : '') + '>' + REGION_TYPES[key].label + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Team select
        html += '<div style="margin-bottom:6px;">';
        html += '<label style="color:#00aa66; font-size:10px; display:block;">TEAM</label>';
        html += '<select id="regionTeamSelect" style="width:100%; background:rgba(0,0,0,0.5); border:1px solid #333; color:#00ff88; padding:3px 6px; border-radius:3px; font-family:monospace; font-size:11px;">';
        ['neutral','blue','red'].forEach(function(t) {
            html += '<option value="' + t + '"' + (r.team === t ? ' selected' : '') + '>' + t.toUpperCase() + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Shape info
        if (r.shape === 'circle') {
            html += '<div style="color:#666; font-size:10px; margin-bottom:4px;">CIRCLE -- Radius: ' + (r.radius/1000).toFixed(1) + ' km</div>';
            html += '<div style="color:#666; font-size:10px;">Center: ' + r.center.lat.toFixed(3) + ', ' + r.center.lon.toFixed(3) + '</div>';
        } else {
            html += '<div style="color:#666; font-size:10px; margin-bottom:4px;">POLYGON -- ' + r.points.length + ' vertices</div>';
        }

        // Notes
        html += '<div style="margin-top:6px;">';
        html += '<label style="color:#00aa66; font-size:10px; display:block;">NOTES</label>';
        html += '<textarea id="regionNotesInput" rows="2" style="width:100%; background:rgba(0,0,0,0.5); border:1px solid #333; color:#00ff88; padding:3px 6px; border-radius:3px; font-family:monospace; font-size:10px; resize:vertical; box-sizing:border-box;">' + _escapeHtml(r.notes || '') + '</textarea>';
        html += '</div>';

        // Delete button
        html += '<div style="margin-top:8px; text-align:right;">';
        html += '<button id="regionDeleteBtn" style="background:rgba(255,50,50,0.15); border:1px solid #ff4444; color:#ff4444; padding:3px 12px; border-radius:3px; cursor:pointer; font-family:monospace; font-size:11px;">Delete Region</button>';
        html += '</div>';

        html += '</div>';
        panel.innerHTML = html;

        // Wire events — stopPropagation on keydown to prevent builder shortcuts
        var nameInput = document.getElementById('regionNameInput');
        if (nameInput) {
            nameInput.addEventListener('keydown', function(e) { e.stopPropagation(); });
            nameInput.onchange = function() { updateRegion(r.id, { name: nameInput.value }); };
        }

        var typeSelect = document.getElementById('regionTypeSelect');
        if (typeSelect) typeSelect.onchange = function() { updateRegion(r.id, { type: typeSelect.value }); };

        var teamSelect = document.getElementById('regionTeamSelect');
        if (teamSelect) teamSelect.onchange = function() { updateRegion(r.id, { team: teamSelect.value }); };

        var notesInput = document.getElementById('regionNotesInput');
        if (notesInput) {
            notesInput.addEventListener('keydown', function(e) { e.stopPropagation(); });
            notesInput.onchange = function() { updateRegion(r.id, { notes: notesInput.value }); };
        }

        var deleteBtn = document.getElementById('regionDeleteBtn');
        if (deleteBtn) deleteBtn.onclick = function() { removeRegion(r.id); _updateRegionProperties(); };
    }

    return {
        init: init,
        REGION_TYPES: REGION_TYPES,
        startCircleDraw: startCircleDraw,
        startPolygonDraw: startPolygonDraw,
        cancelDraw: cancelDraw,
        updateRegion: updateRegion,
        removeRegion: removeRegion,
        getRegions: getRegions,
        loadRegions: loadRegions,
        clearAll: clearAll,
        isInsideRegion: isInsideRegion,
        isInsideAnyRegion: isInsideAnyRegion,
        on: on,
        get regions() { return _regions; },
        get selectedRegion() { return _selectedRegion; },
        get isDrawing() { return _drawMode !== null; }
    };
})();
