// =========================================================================
// TACTICAL MINIMAP — 2D situation awareness overlay for Live Sim Viewer
// =========================================================================
// Renders a heading-up (or north-up) 2D tactical map as a canvas overlay
// in the bottom-left corner. Shows player at center, friendlies as blue,
// hostiles as red, neutrals as gray. Range rings, north arrow, labels.
// =========================================================================
'use strict';

var Minimap = (function() {

    // ===================== CONSTANTS =====================
    var R_EARTH = 6371000;  // meters
    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;

    // ===================== STATE =====================
    var _canvas = null;
    var _ctx = null;
    var _visible = true;
    var _styleInjected = false;
    var _lastDrawTime = 0;
    var _rangeKm = 200;         // display range in km
    var _rangeM = 200000;       // display range in meters
    var _headingUp = true;      // true = heading-up, false = north-up
    var _size = 256;            // logical canvas size (CSS pixels)
    var _dpr = 1;               // device pixel ratio
    var _halfSize = 128;
    var _center = 128;

    // Pre-allocated color strings to avoid per-frame creation
    var COLOR_BG = 'rgba(10, 14, 23, 0.80)';
    var COLOR_RING = 'rgba(0, 180, 80, 0.25)';
    var COLOR_RING_TEXT = 'rgba(0, 180, 80, 0.50)';
    var COLOR_NORTH = 'rgba(255, 80, 80, 0.85)';
    var COLOR_PLAYER = '#ffffff';
    var COLOR_BLUE = '#4488ff';
    var COLOR_RED = '#ff4444';
    var COLOR_GRAY = '#888888';
    var COLOR_TITLE = 'rgba(0, 255, 100, 0.70)';
    var COLOR_RANGE_TEXT = 'rgba(0, 255, 100, 0.50)';
    var COLOR_BORDER = 'rgba(0, 180, 80, 0.40)';

    // Entity type classification
    var GROUND_TYPES = { ground_station: 1, sam: 1, ew_radar: 1, gps_receiver: 1, ground: 1, naval: 1 };
    var SAT_TYPES = { satellite: 1, leo_satellite: 1, gps_satellite: 1, geo_satellite: 1, spacecraft: 1 };

    // Throttle interval (ms) — 10 Hz max
    var THROTTLE_MS = 100;

    // Max entities to render
    var MAX_ENTITIES = 200;

    // ===================== CSS INJECTION =====================
    function _injectStyles() {
        if (_styleInjected) return;
        _styleInjected = true;

        var css = [
            '#minimapCanvas {',
            '  position: absolute;',
            '  bottom: 16px;',
            '  left: 16px;',
            '  width: 256px;',
            '  height: 256px;',
            '  border-radius: 8px;',
            '  border: 1px solid rgba(0, 180, 80, 0.40);',
            '  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);',
            '  z-index: 15;',
            '  pointer-events: none;',
            '  image-rendering: auto;',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.type = 'text/css';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ===================== INIT =====================
    function init(canvasEl) {
        if (!canvasEl) return;
        _canvas = canvasEl;
        _ctx = _canvas.getContext('2d');

        _injectStyles();

        // High-DPI setup
        _dpr = window.devicePixelRatio || 1;
        _canvas.width = _size * _dpr;
        _canvas.height = _size * _dpr;
        _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);

        _halfSize = _size / 2;
        _center = _halfSize;

        _rangeM = _rangeKm * 1000;

        // Handle window resize for DPI changes
        window.addEventListener('resize', function() {
            var newDpr = window.devicePixelRatio || 1;
            if (newDpr !== _dpr) {
                _dpr = newDpr;
                _canvas.width = _size * _dpr;
                _canvas.height = _size * _dpr;
                _ctx.setTransform(_dpr, 0, 0, _dpr, 0, 0);
            }
        });
    }

    // ===================== PUBLIC API =====================
    function toggle() {
        _visible = !_visible;
        if (_canvas) {
            _canvas.style.display = _visible ? 'block' : 'none';
        }
        return _visible;
    }

    function setRange(rangeKm) {
        if (rangeKm > 0 && rangeKm < 100000) {
            _rangeKm = rangeKm;
            _rangeM = rangeKm * 1000;
        }
    }

    function isVisible() {
        return _visible;
    }

    function setHeadingUp(flag) {
        _headingUp = !!flag;
    }

    // ===================== UPDATE / RENDER =====================
    function update(playerState, ecsWorld, simTime) {
        if (!_canvas || !_ctx) return;

        // Throttle to ~10 Hz
        var now = Date.now();
        if (now - _lastDrawTime < THROTTLE_MS) return;
        _lastDrawTime = now;

        var ctx = _ctx;
        var w = _size;
        var h = _size;
        var cx = _center;
        var cy = _center;

        // Player position (radians) — defaults to 0,0 if no player
        var pLat = 0;
        var pLon = 0;
        var pHeading = 0;
        var hasPlayer = false;

        if (playerState && playerState.lat != null && playerState.lon != null) {
            pLat = playerState.lat;
            pLon = playerState.lon;
            pHeading = playerState.heading || 0;
            if (playerState.yawOffset) pHeading += playerState.yawOffset;
            hasPlayer = true;
        }

        // Rotation angle for heading-up mode
        var rotAngle = _headingUp ? -pHeading : 0;

        // --- Clear canvas ---
        ctx.clearRect(0, 0, w, h);

        // --- Background ---
        ctx.fillStyle = COLOR_BG;
        ctx.beginPath();
        ctx.arc(cx, cy, _halfSize - 1, 0, Math.PI * 2);
        ctx.fill();

        // Clip to circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, _halfSize - 2, 0, Math.PI * 2);
        ctx.clip();

        // --- Range rings ---
        var ringFractions = [0.25, 0.50, 0.75, 1.0];
        ctx.strokeStyle = COLOR_RING;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([2, 4]);
        for (var ri = 0; ri < ringFractions.length; ri++) {
            var ringR = (_halfSize - 4) * ringFractions[ri];
            ctx.beginPath();
            ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // --- Range labels ---
        ctx.font = '9px "Courier New", monospace';
        ctx.fillStyle = COLOR_RING_TEXT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        for (var li = 0; li < ringFractions.length; li++) {
            var labelR = (_halfSize - 4) * ringFractions[li];
            var labelKm = _rangeKm * ringFractions[li];
            var labelText;
            if (labelKm >= 1000) {
                labelText = (labelKm / 1000).toFixed(0) + 'Mm';
            } else {
                labelText = Math.round(labelKm) + 'km';
            }
            // Place label to the right of ring at 3 o'clock
            ctx.fillText(labelText, cx + labelR - ctx.measureText(labelText).width - 2, cy - 2);
        }

        // --- North indicator arrow ---
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rotAngle);
        // North arrow at top
        var arrowTip = -(_halfSize - 10);
        ctx.fillStyle = COLOR_NORTH;
        ctx.beginPath();
        ctx.moveTo(0, arrowTip);
        ctx.lineTo(-4, arrowTip + 10);
        ctx.lineTo(4, arrowTip + 10);
        ctx.closePath();
        ctx.fill();
        // "N" label
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.fillStyle = COLOR_NORTH;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('N', 0, arrowTip - 1);
        ctx.restore();

        // --- Gather and sort entities by distance ---
        var entities = [];
        if (ecsWorld && ecsWorld.entities) {
            ecsWorld.entities.forEach(function(ent) {
                if (!ent || !ent.state) return;
                var s = ent.state;
                if (s.lat == null || s.lon == null) return;

                // Skip player entity
                if (hasPlayer && playerState._entityId && ent.id === playerState._entityId) return;

                // Compute flat-earth relative position (meters)
                var dLat = s.lat - pLat;
                var dLon = s.lon - pLon;
                var cosLat = Math.cos(pLat);
                var dx = dLon * cosLat * R_EARTH;   // east
                var dy = dLat * R_EARTH;             // north

                var dist = Math.sqrt(dx * dx + dy * dy);

                // Skip entities outside range
                if (dist > _rangeM * 1.05) return;

                // Skip satellites above 1000km altitude
                var entAlt = s.alt || 0;
                var isSat = SAT_TYPES[ent.type] || false;
                if (isSat && entAlt > 1000000) return;

                var isGround = GROUND_TYPES[ent.type] || false;

                entities.push({
                    dx: dx,
                    dy: dy,
                    dist: dist,
                    name: ent.name || ent.id || '?',
                    team: ent.team || 'neutral',
                    type: ent.type || 'unknown',
                    isGround: isGround,
                    active: ent.active !== false
                });
            });
        }

        // Sort by distance (closest last = drawn on top)
        entities.sort(function(a, b) { return b.dist - a.dist; });

        // Cap at MAX_ENTITIES (keep closest)
        if (entities.length > MAX_ENTITIES) {
            entities = entities.slice(entities.length - MAX_ENTITIES);
        }

        var visibleCount = entities.length;

        // --- Draw entities ---
        var pixelScale = (_halfSize - 4) / _rangeM;

        for (var ei = 0; ei < entities.length; ei++) {
            var e = entities[ei];

            // Transform to screen coordinates
            var ex = e.dx * pixelScale;
            var ey = -e.dy * pixelScale;  // negate: screen Y is down, north is up

            // Rotate for heading-up mode
            if (rotAngle !== 0) {
                var cosR = Math.cos(rotAngle);
                var sinR = Math.sin(rotAngle);
                var rx = ex * cosR - ey * sinR;
                var ry = ex * sinR + ey * cosR;
                ex = rx;
                ey = ry;
            }

            var sx = cx + ex;
            var sy = cy + ey;

            // Clip to range circle
            var screenDist = Math.sqrt(ex * ex + ey * ey);
            if (screenDist > _halfSize - 4) continue;

            // Select color by team
            var color;
            if (e.team === 'blue') color = COLOR_BLUE;
            else if (e.team === 'red') color = COLOR_RED;
            else color = COLOR_GRAY;

            // Dim dead entities
            if (!e.active) {
                ctx.globalAlpha = 0.3;
            }

            ctx.fillStyle = color;

            if (e.isGround) {
                // Ground entities: small square
                ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
            } else {
                // Air/space entities: circle
                ctx.beginPath();
                ctx.arc(sx, sy, 3, 0, Math.PI * 2);
                ctx.fill();
            }

            // Labels if <20 visible entities
            if (visibleCount <= 20) {
                ctx.font = '8px "Courier New", monospace';
                ctx.fillStyle = color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                var label = e.name.substring(0, 5);
                ctx.fillText(label, sx + 5, sy);
            }

            if (!e.active) {
                ctx.globalAlpha = 1.0;
            }
        }

        // --- Player marker at center ---
        if (hasPlayer) {
            ctx.save();
            ctx.translate(cx, cy);
            // In heading-up mode player always points up; in north-up, rotate by heading
            if (!_headingUp) {
                ctx.rotate(pHeading);
            }
            // White triangle pointing up (forward)
            ctx.fillStyle = COLOR_PLAYER;
            ctx.beginPath();
            ctx.moveTo(0, -7);
            ctx.lineTo(-5, 5);
            ctx.lineTo(0, 2);
            ctx.lineTo(5, 5);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        } else {
            // No player: draw crosshair at center
            ctx.strokeStyle = COLOR_PLAYER;
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(cx - 5, cy);
            ctx.lineTo(cx + 5, cy);
            ctx.moveTo(cx, cy - 5);
            ctx.lineTo(cx, cy + 5);
            ctx.stroke();
        }

        // Restore clip
        ctx.restore();

        // --- Title bar ---
        ctx.font = 'bold 10px "Courier New", monospace';
        ctx.fillStyle = COLOR_TITLE;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('TAC MAP', 8, 6);

        // Heading-up / north-up indicator
        ctx.font = '8px "Courier New", monospace';
        ctx.fillStyle = COLOR_RANGE_TEXT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(_headingUp ? 'HDG UP' : 'NTH UP', w - 8, 6);

        // --- Range text at bottom-right ---
        ctx.font = '9px "Courier New", monospace';
        ctx.fillStyle = COLOR_RANGE_TEXT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        var rangeLabel;
        if (_rangeKm >= 1000) {
            rangeLabel = (_rangeKm / 1000).toFixed(0) + ' Mm';
        } else {
            rangeLabel = _rangeKm + ' km';
        }
        ctx.fillText(rangeLabel, w - 8, h - 6);

        // Entity count at bottom-left
        ctx.textAlign = 'left';
        ctx.fillText(visibleCount + ' TGT', 8, h - 6);

        // --- Border circle ---
        ctx.strokeStyle = COLOR_BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, _halfSize - 1, 0, Math.PI * 2);
        ctx.stroke();
    }

    // ===================== RETURN PUBLIC API =====================
    return {
        init: init,
        update: update,
        toggle: toggle,
        setRange: setRange,
        isVisible: isVisible,
        setHeadingUp: setHeadingUp,
        get rangeKm() { return _rangeKm; },
        get headingUp() { return _headingUp; }
    };

})();
