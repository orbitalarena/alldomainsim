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

    // Cyber layer colors
    var COLOR_CYBER_CONTROLLED = '#ff2222';       // pulsing red ring — full control
    var COLOR_CYBER_EXPLOITED = '#dd44dd';         // magenta inner ring — compromised
    var COLOR_CYBER_SCANNING = '#ffdd00';          // yellow expanding pulse — scanning
    var COLOR_CYBER_SUBSYS_DISABLED = '#ff8800';   // orange outline — subsystem disabled
    var COLOR_CYBER_ATTACK_LINE = '#ff2222';       // dashed red attack line
    var COLOR_COMM_HEALTHY = '#44ff44';            // green comm link
    var COLOR_COMM_DEGRADED = '#ffcc00';           // yellow degraded link
    var COLOR_COMM_COMPROMISED = '#ff4444';        // red compromised link
    var COLOR_COMM_BRICKED = '#666666';            // gray bricked link
    var COLOR_CYBER_TOGGLE_BG = 'rgba(0, 180, 80, 0.30)';
    var COLOR_CYBER_TOGGLE_ACTIVE = 'rgba(0, 255, 100, 0.80)';
    var COLOR_CYBER_TOGGLE_INACTIVE = 'rgba(0, 255, 100, 0.35)';
    var COLOR_CYBER_SUMMARY = 'rgba(255, 100, 100, 0.85)';

    // Entity type classification
    var GROUND_TYPES = { ground_station: 1, sam: 1, ew_radar: 1, gps_receiver: 1, ground: 1, naval: 1 };
    var SAT_TYPES = { satellite: 1, leo_satellite: 1, gps_satellite: 1, geo_satellite: 1, spacecraft: 1 };

    // Throttle interval (ms) — 10 Hz max
    var THROTTLE_MS = 100;

    // Max entities to render
    var MAX_ENTITIES = 200;

    // Cyber layer state
    var _showCyberLayer = true;

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

                // Cyber state flags for overlay
                var cyberFlags = null;
                if (_showCyberLayer) {
                    var hasAnyCyber = s._cyberControlled || s._fullControl ||
                        s._cyberExploited || s._computerCompromised ||
                        s._cyberScanning ||
                        s._sensorDisabled || s._weaponsDisabled || s._navigationHijacked ||
                        s._cyberOpsTarget || (s._cyberOpsCompromisedTargets && s._cyberOpsCompromisedTargets.length > 0) ||
                        s._commsDisabled || s._commBricked ||
                        (s._cyberDegradation && (s._cyberDegradation.sensors > 0 || s._cyberDegradation.navigation > 0 ||
                            s._cyberDegradation.weapons > 0 || s._cyberDegradation.comms > 0));
                    if (hasAnyCyber) {
                        cyberFlags = {
                            controlled: !!(s._cyberControlled || s._fullControl),
                            exploited: !!(s._cyberExploited || s._computerCompromised),
                            scanning: !!s._cyberScanning,
                            subsysDisabled: !!(s._sensorDisabled || s._weaponsDisabled || s._navigationHijacked),
                            attackTarget: s._cyberOpsTarget || null,
                            compromisedTargets: s._cyberOpsCompromisedTargets ? s._cyberOpsCompromisedTargets.slice() : null,
                            commsDisabled: !!s._commsDisabled,
                            commBricked: !!s._commBricked,
                            degradation: s._cyberDegradation || null
                        };
                    }
                }

                // Collect weapon/sensor range data for threat rings
                var weaponRange = 0;
                var sensorRange = 0;
                var isWeaponsFree = false;

                if (ent.getComponent) {
                    // Check for SAM weapon component
                    var samComp = ent.getComponent('weapons');
                    if (samComp && samComp._maxRange) {
                        weaponRange = samComp._maxRange;
                        isWeaponsFree = samComp._rules === 'weapons_free' ||
                            (samComp._engagements && samComp._engagements.length > 0);
                    }
                    // Check for radar sensor component
                    var radarComp = ent.getComponent('sensors');
                    if (radarComp && radarComp._maxRange) {
                        sensorRange = radarComp._maxRange;
                    }
                }
                // Fallback: check entity state for ranges
                if (!weaponRange && ent.state._maxRange) weaponRange = ent.state._maxRange;
                if (!sensorRange && ent.state._sensorRange) sensorRange = ent.state._sensorRange;

                entities.push({
                    id: ent.id,
                    dx: dx,
                    dy: dy,
                    dist: dist,
                    name: ent.name || ent.id || '?',
                    team: ent.team || 'neutral',
                    type: ent.type || 'unknown',
                    isGround: isGround,
                    active: ent.active !== false,
                    cyber: cyberFlags,
                    weaponRange: weaponRange,
                    sensorRange: sensorRange,
                    isWeaponsFree: isWeaponsFree
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

        // --- Threat rings (SAM weapon range, radar detection range) ---
        _drawThreatRings(ctx, entities, pixelScale, cx, cy, rotAngle, simTime);

        // Build screen-position lookup for cyber attack lines (by entity ID)
        var screenPos = {};  // entityId -> { sx, sy, visible }

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
            var isClipped = screenDist > _halfSize - 4;

            // Store screen position for cyber line drawing
            if (e.id) {
                screenPos[e.id] = { sx: sx, sy: sy, visible: !isClipped };
            }

            if (isClipped) continue;

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

            // Draw entity shape by type
            var eType = (e.type || '').toLowerCase();
            if (eType === 'naval') {
                // Naval: diamond
                ctx.beginPath();
                ctx.moveTo(sx, sy - 4);
                ctx.lineTo(sx + 3.5, sy);
                ctx.lineTo(sx, sy + 4);
                ctx.lineTo(sx - 3.5, sy);
                ctx.closePath();
                ctx.fill();
            } else if (eType === 'satellite') {
                // Satellite: small circle with ring
                ctx.beginPath();
                ctx.arc(sx, sy, 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = color;
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.arc(sx, sy, 4, 0, Math.PI * 2);
                ctx.stroke();
            } else if (e.isGround) {
                // Ground entities: small square
                ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
            } else {
                // Aircraft: triangle pointing in heading direction
                ctx.beginPath();
                ctx.moveTo(sx, sy - 4);
                ctx.lineTo(sx + 3, sy + 3);
                ctx.lineTo(sx - 3, sy + 3);
                ctx.closePath();
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

        // ===================== CYBER TERRAIN LAYER =====================
        if (_showCyberLayer) {
            _drawCyberLayer(ctx, entities, screenPos, ecsWorld, simTime, cx, cy, pixelScale, rotAngle);
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

        // --- Cyber layer toggle button ("C" in corner) ---
        _drawCyberToggle(ctx, w, h);

        // --- Cyber status summary (when cyber layer active) ---
        if (_showCyberLayer) {
            _drawCyberSummary(ctx, entities, w);
        }

        // --- Border circle ---
        ctx.strokeStyle = COLOR_BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, _halfSize - 1, 0, Math.PI * 2);
        ctx.stroke();
    }

    // ===================== THREAT RANGE RING DRAWING =====================

    /**
     * Draw SAM weapon range rings and radar detection range rings for ground entities.
     * Weapon ranges are solid-ish circles, sensor ranges are dotted circles.
     * Drawn BEFORE entity dots so dots appear on top.
     */
    function _drawThreatRings(ctx, entities, pixelScale, cx, cy, rotAngle, simTime) {
        var t = simTime || 0;

        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            if (!e.isGround) continue;
            if (!e.active) continue;
            if (e.weaponRange <= 0 && e.sensorRange <= 0) continue;

            // Transform entity position to screen
            var ex = e.dx * pixelScale;
            var ey = -e.dy * pixelScale;
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

            // Skip if entity center is way outside the display
            var screenDist = Math.sqrt(ex * ex + ey * ey);
            if (screenDist > _halfSize * 2) continue;

            // Sensor range ring (dotted, faint)
            if (e.sensorRange > 0) {
                var sensorPixels = e.sensorRange * pixelScale;
                if (sensorPixels > 3) {
                    ctx.beginPath();
                    ctx.arc(sx, sy, sensorPixels, 0, Math.PI * 2);
                    ctx.strokeStyle = e.team === 'red' ? 'rgba(255,100,100,0.15)' : 'rgba(100,200,255,0.15)';
                    ctx.lineWidth = 0.7;
                    ctx.setLineDash([2, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    // Fill with very faint color
                    ctx.fillStyle = e.team === 'red' ? 'rgba(255,50,50,0.03)' : 'rgba(50,150,255,0.03)';
                    ctx.fill();
                }
            }

            // Weapon range ring (solid, slightly brighter)
            if (e.weaponRange > 0) {
                var weapPixels = e.weaponRange * pixelScale;
                if (weapPixels > 3) {
                    ctx.beginPath();
                    ctx.arc(sx, sy, weapPixels, 0, Math.PI * 2);

                    // Pulsing effect when weapons free or actively engaging
                    var alpha = 0.2;
                    if (e.isWeaponsFree) {
                        alpha = 0.15 + 0.15 * Math.sin(t * 3);
                    }

                    if (e.team === 'red') {
                        ctx.strokeStyle = 'rgba(255,80,80,' + (alpha + 0.1) + ')';
                        ctx.fillStyle = 'rgba(255,40,40,' + (alpha * 0.3) + ')';
                    } else {
                        ctx.strokeStyle = 'rgba(80,140,255,' + (alpha + 0.1) + ')';
                        ctx.fillStyle = 'rgba(40,100,255,' + (alpha * 0.3) + ')';
                    }
                    ctx.lineWidth = 1.0;
                    ctx.setLineDash([]);
                    ctx.stroke();
                    ctx.fill();

                    // "WEP" label if weapons free and ring is large enough
                    if (e.isWeaponsFree && weapPixels > 20) {
                        ctx.font = '7px "Courier New", monospace';
                        ctx.fillStyle = e.team === 'red' ? 'rgba(255,100,100,0.6)' : 'rgba(100,180,255,0.6)';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('WEP', sx, sy - weapPixels - 5);
                    }
                }
            }
        }
    }

    // ===================== CYBER TERRAIN DRAWING =====================

    /**
     * Draw all cyber layer elements: entity indicators, attack lines, comm links.
     */
    function _drawCyberLayer(ctx, entities, screenPos, ecsWorld, simTime, cx, cy, pixelScale, rotAngle) {
        var t = simTime || 0;

        // --- 1. Comm network links (drawn first, underneath everything) ---
        _drawCommNetworkLinks(ctx, entities, screenPos, ecsWorld, cx, cy, pixelScale, rotAngle);

        // --- 2. Cyber attack lines (attacker -> target dashed red) ---
        _drawCyberAttackLines(ctx, entities, screenPos);

        // --- 3. Hacked entity indicators (drawn over entity dots) ---
        for (var ci = 0; ci < entities.length; ci++) {
            var ent = entities[ci];
            if (!ent.cyber || !ent.id) continue;
            var pos = screenPos[ent.id];
            if (!pos || !pos.visible) continue;

            _drawCyberEntityIndicators(ctx, ent, pos.sx, pos.sy, t);
        }
    }

    /**
     * Draw cyber indicators around a single entity dot.
     */
    function _drawCyberEntityIndicators(ctx, ent, sx, sy, simTime) {
        var cyber = ent.cyber;
        if (!cyber) return;

        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);

        // (a) Full control / cyberControlled: pulsing red ring
        if (cyber.controlled) {
            var pulseRadius = 6 + 2 * Math.sin(simTime * 4);
            ctx.strokeStyle = COLOR_CYBER_CONTROLLED;
            ctx.globalAlpha = 0.6 + 0.3 * Math.sin(simTime * 4);
            ctx.beginPath();
            ctx.arc(sx, sy, pulseRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }

        // (b) Exploited / computerCompromised: magenta inner ring
        if (cyber.exploited && !cyber.controlled) {
            ctx.strokeStyle = COLOR_CYBER_EXPLOITED;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.arc(sx, sy, 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
        }

        // (c) Scanning: yellow expanding sonar-style pulse
        if (cyber.scanning) {
            var scanPhase = (simTime * 1.2) % 1.0;  // 0..1 cycle every ~0.83s
            var scanRadius = 4 + scanPhase * 12;
            var scanAlpha = 0.7 * (1.0 - scanPhase);
            ctx.strokeStyle = COLOR_CYBER_SCANNING;
            ctx.globalAlpha = scanAlpha;
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(sx, sy, scanRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1.0;
            ctx.lineWidth = 1.5;
        }

        // (d) Subsystem disabled (sensor/weapon/navigation): orange outline
        if (cyber.subsysDisabled && !cyber.controlled) {
            ctx.strokeStyle = COLOR_CYBER_SUBSYS_DISABLED;
            ctx.globalAlpha = 0.8;
            ctx.lineWidth = 1.0;
            if (ent.isGround) {
                ctx.strokeRect(sx - 4, sy - 4, 8, 8);
            } else {
                ctx.beginPath();
                ctx.arc(sx, sy, 5, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = 1.0;
        }
    }

    /**
     * Draw dashed red lines from cyber attackers to their targets.
     */
    function _drawCyberAttackLines(ctx, entities, screenPos) {
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.0;

        for (var ai = 0; ai < entities.length; ai++) {
            var attacker = entities[ai];
            if (!attacker.cyber || !attacker.id) continue;
            var aPos = screenPos[attacker.id];
            if (!aPos || !aPos.visible) continue;

            // Active attack target (currently being exploited)
            if (attacker.cyber.attackTarget) {
                var tgtPos = screenPos[attacker.cyber.attackTarget];
                if (tgtPos && tgtPos.visible) {
                    ctx.strokeStyle = COLOR_CYBER_ATTACK_LINE;
                    ctx.globalAlpha = 0.7;
                    ctx.beginPath();
                    ctx.moveTo(aPos.sx, aPos.sy);
                    ctx.lineTo(tgtPos.sx, tgtPos.sy);
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                }
            }

            // Already compromised targets (thin red lines)
            var compromised = attacker.cyber.compromisedTargets;
            if (compromised && compromised.length > 0) {
                ctx.lineWidth = 0.7;
                ctx.globalAlpha = 0.4;
                ctx.strokeStyle = COLOR_CYBER_ATTACK_LINE;
                for (var ci = 0; ci < compromised.length; ci++) {
                    var cPos = screenPos[compromised[ci]];
                    if (cPos && cPos.visible) {
                        ctx.beginPath();
                        ctx.moveTo(aPos.sx, aPos.sy);
                        ctx.lineTo(cPos.sx, cPos.sy);
                        ctx.stroke();
                    }
                }
                ctx.globalAlpha = 1.0;
                ctx.lineWidth = 1.0;
            }
        }

        ctx.setLineDash([]);
    }

    /**
     * Draw comm network links between member entities, colored by security status.
     */
    function _drawCommNetworkLinks(ctx, entities, screenPos, ecsWorld, cx, cy, pixelScale, rotAngle) {
        var networks = null;

        // Strategy 1: CommEngine global
        if (typeof CommEngine !== 'undefined' && typeof CommEngine.getNetworks === 'function') {
            try {
                networks = CommEngine.getNetworks();
            } catch (e) {
                networks = null;
            }
        }

        // Strategy 2: world._networks
        if (!networks && ecsWorld && ecsWorld._networks && Array.isArray(ecsWorld._networks)) {
            networks = ecsWorld._networks;
        }

        if (!networks || networks.length === 0) return;

        // Build entity cyber-state lookup from entities array
        var entityCyber = {};
        for (var ei = 0; ei < entities.length; ei++) {
            if (entities[ei].id) {
                entityCyber[entities[ei].id] = entities[ei].cyber;
            }
        }

        ctx.lineWidth = 0.6;
        ctx.setLineDash([1, 2]);
        ctx.globalAlpha = 0.5;

        for (var ni = 0; ni < networks.length; ni++) {
            var net = networks[ni];
            var members = net.members || net.nodes || net.entities || [];

            // Resolve member IDs
            var memberIds = [];
            for (var mi = 0; mi < members.length; mi++) {
                var mid = (typeof members[mi] === 'string') ? members[mi] : (members[mi].id || members[mi].entityId || '');
                if (mid) memberIds.push(mid);
            }

            // Draw links between all pairs (or based on topology if star/mesh)
            for (var a = 0; a < memberIds.length; a++) {
                for (var b = a + 1; b < memberIds.length; b++) {
                    var posA = screenPos[memberIds[a]];
                    var posB = screenPos[memberIds[b]];
                    if (!posA || !posB || !posA.visible || !posB.visible) continue;

                    // Determine link color by worst-case security status of endpoints
                    var cyA = entityCyber[memberIds[a]];
                    var cyB = entityCyber[memberIds[b]];

                    var linkColor = COLOR_COMM_HEALTHY;

                    // Check for bricked/comms-disabled (worst case)
                    if ((cyA && (cyA.commBricked || cyA.commsDisabled)) ||
                        (cyB && (cyB.commBricked || cyB.commsDisabled))) {
                        linkColor = COLOR_COMM_BRICKED;
                    }
                    // Check for compromised
                    else if ((cyA && cyA.exploited) || (cyB && cyB.exploited)) {
                        linkColor = COLOR_COMM_COMPROMISED;
                    }
                    // Check for degradation
                    else if ((cyA && cyA.degradation &&
                             (cyA.degradation.sensors > 0 || cyA.degradation.navigation > 0 ||
                              cyA.degradation.weapons > 0 || cyA.degradation.comms > 0)) ||
                             (cyB && cyB.degradation &&
                             (cyB.degradation.sensors > 0 || cyB.degradation.navigation > 0 ||
                              cyB.degradation.weapons > 0 || cyB.degradation.comms > 0))) {
                        linkColor = COLOR_COMM_DEGRADED;
                    }

                    ctx.strokeStyle = linkColor;
                    ctx.beginPath();
                    ctx.moveTo(posA.sx, posA.sy);
                    ctx.lineTo(posB.sx, posB.sy);
                    ctx.stroke();
                }
            }
        }

        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
    }

    /**
     * Draw the "C" toggle button for the cyber layer.
     * Positioned in the bottom-right area of the minimap, above the range label.
     */
    function _drawCyberToggle(ctx, w, h) {
        var btnX = w - 20;
        var btnY = h - 26;
        var btnR = 8;

        // Background circle
        ctx.fillStyle = _showCyberLayer ? COLOR_CYBER_TOGGLE_BG : 'rgba(40, 40, 40, 0.50)';
        ctx.beginPath();
        ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = _showCyberLayer ? COLOR_CYBER_TOGGLE_ACTIVE : COLOR_CYBER_TOGGLE_INACTIVE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(btnX, btnY, btnR, 0, Math.PI * 2);
        ctx.stroke();

        // "C" label
        ctx.font = 'bold 9px "Courier New", monospace';
        ctx.fillStyle = _showCyberLayer ? COLOR_CYBER_TOGGLE_ACTIVE : COLOR_CYBER_TOGGLE_INACTIVE;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('C', btnX, btnY);
    }

    /**
     * Draw cyber status summary text at top of minimap.
     * "CYBER: N compromised / N scanning / N clean"
     */
    function _drawCyberSummary(ctx, entities, w) {
        var compromised = 0;
        var scanning = 0;
        var clean = 0;

        for (var si = 0; si < entities.length; si++) {
            var ent = entities[si];
            if (!ent.active) continue;
            if (ent.cyber) {
                if (ent.cyber.controlled || ent.cyber.exploited) {
                    compromised++;
                } else if (ent.cyber.scanning) {
                    scanning++;
                } else {
                    clean++;
                }
            } else {
                clean++;
            }
        }

        // Only show if there is any cyber activity
        if (compromised === 0 && scanning === 0) return;

        var summary = 'CYBER: ' + compromised + ' comp / ' + scanning + ' scan / ' + clean + ' ok';
        ctx.font = '7px "Courier New", monospace';
        ctx.fillStyle = COLOR_CYBER_SUMMARY;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(summary, w / 2, 17);
    }

    // ===================== CYBER LAYER TOGGLE =====================
    function toggleCyberLayer() {
        _showCyberLayer = !_showCyberLayer;
        return _showCyberLayer;
    }

    function setCyberLayer(flag) {
        _showCyberLayer = !!flag;
    }

    function isCyberLayerVisible() {
        return _showCyberLayer;
    }

    // ===================== RETURN PUBLIC API =====================
    return {
        init: init,
        update: update,
        toggle: toggle,
        setRange: setRange,
        isVisible: isVisible,
        setHeadingUp: setHeadingUp,
        toggleCyberLayer: toggleCyberLayer,
        setCyberLayer: setCyberLayer,
        isCyberLayerVisible: isCyberLayerVisible,
        get rangeKm() { return _rangeKm; },
        get headingUp() { return _headingUp; },
        get cyberLayerActive() { return _showCyberLayer; }
    };

})();
