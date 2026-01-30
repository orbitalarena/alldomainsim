/**
 * Spaceplane HUD Module
 * Provides space planner HUD overlays: orbital info panel, navball,
 * maneuver node display, and cockpit-mode space adaptations.
 */
const SpaceplaneHUD = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const TWO_PI = 2 * Math.PI;

    // HUD colors
    const COL_PRIMARY = '#44ccff';
    const COL_DIM = '#226688';
    const COL_GREEN = '#00ff00';
    const COL_WARN = '#ffff00';
    const COL_ALERT = '#ff3333';
    const COL_PROGRADE = '#00ff00';
    const COL_RETROGRADE = '#ff4444';
    const COL_NORMAL = '#cc44ff';
    const COL_RADIAL = '#44ffcc';
    const COL_ORBIT = '#44ccff';

    let width = 0, height = 0;
    let _lastSimTime = 0;

    function resize(canvas) {
        width = canvas.width;
        height = canvas.height;
    }

    /**
     * Render full planner mode HUD (replaces cockpit HUD)
     */
    function render(canvas, state, simTime) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        width = canvas.width;
        height = canvas.height;
        _lastSimTime = simTime || 0;

        ctx.clearRect(0, 0, width, height);
        const scale = Math.min(width, height) / 800;

        ctx.save();

        // Draw planner HUD elements
        drawOrbitalInfoPanel(ctx, state, scale);
        drawCurrentStatsPanel(ctx, state, scale);
        drawNavball(ctx, state, scale);
        drawManeuverNodeInfo(ctx, state, scale);
        drawFlightRegimeBanner(ctx, state, scale);

        ctx.restore();
    }

    /**
     * Render overlay elements on top of cockpit HUD (when above 80km)
     * Shows orbital info strip at top without replacing the existing HUD
     */
    function renderOverlay(canvas, state, simTime) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        width = canvas.width;
        height = canvas.height;
        _lastSimTime = simTime || 0;
        const scale = Math.min(width, height) / 800;

        ctx.save();

        // Orbital info strip at top
        drawOrbitalStrip(ctx, state, scale);

        // Propulsion mode indicator
        drawPropulsionMode(ctx, state, scale);

        // Re-entry dynamic pressure warning
        drawReentryWarning(ctx, state, scale);

        ctx.restore();
    }

    // ---- Planner Mode Elements ----

    function drawOrbitalInfoPanel(ctx, state, scale) {
        const x = 20 * scale;
        const y = 80 * scale;
        const lineH = 18 * scale;

        ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        // Title
        ctx.fillStyle = COL_PRIMARY;
        ctx.fillText('ORBITAL ELEMENTS', x, y);

        ctx.font = `${12 * scale}px 'Courier New', monospace`;

        const elems = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital.orbitalElements : null;
        if (!elems) {
            ctx.fillStyle = COL_DIM;
            ctx.fillText('No orbital data', x, y + lineH);
            return;
        }

        const lines = [
            ['AP', elems.apoapsisAlt != null ? (elems.apoapsisAlt / 1000).toFixed(1) + ' km' : '---'],
            ['PE', elems.periapsisAlt != null ? (elems.periapsisAlt / 1000).toFixed(1) + ' km' : '---'],
            ['INC', elems.inclination != null ? (elems.inclination * RAD).toFixed(2) + '\u00B0' : '---'],
            ['ECC', elems.eccentricity != null ? elems.eccentricity.toFixed(4) : '---'],
            ['SMA', elems.sma != null ? (elems.sma / 1000).toFixed(0) + ' km' : '---'],
            ['PRD', elems.period != null && isFinite(elems.period) ? (elems.period / 60).toFixed(1) + ' min' : '---'],
        ];

        for (let i = 0; i < lines.length; i++) {
            const ly = y + (i + 1) * lineH;
            ctx.fillStyle = COL_DIM;
            ctx.fillText(lines[i][0], x, ly);
            ctx.fillStyle = COL_PRIMARY;
            ctx.textAlign = 'left';
            ctx.fillText(lines[i][1], x + 45 * scale, ly);
            ctx.textAlign = 'left';
        }
    }

    function drawCurrentStatsPanel(ctx, state, scale) {
        const x = width - 20 * scale;
        const y = 80 * scale;
        const lineH = 18 * scale;

        ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = COL_PRIMARY;
        ctx.fillText('CURRENT STATE', x, y);

        ctx.font = `${12 * scale}px 'Courier New', monospace`;

        if (!state) return;

        const speed = state.speed;
        const alt = state.alt;
        const regime = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital.flightRegime : 'ATMOSPHERIC';
        const orbV = state.orbitalVfrac || 0;

        const elems = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital.orbitalElements : null;

        const lines = [
            ['V', speed > 1000 ? (speed / 1000).toFixed(2) + ' km/s' : speed.toFixed(0) + ' m/s'],
            ['ALT', (alt / 1000).toFixed(1) + ' km'],
            ['REGIME', regime],
            ['ORB V', (orbV * 100).toFixed(1) + '%'],
            ['T to AP', elems && elems.timeToApoapsis != null ? fmtTime(elems.timeToApoapsis) : '---'],
            ['T to PE', elems && elems.timeToPeriapsis != null ? fmtTime(elems.timeToPeriapsis) : '---'],
        ];

        for (let i = 0; i < lines.length; i++) {
            const ly = y + (i + 1) * lineH;
            ctx.fillStyle = COL_PRIMARY;
            ctx.textAlign = 'right';
            ctx.fillText(lines[i][1], x, ly);
            ctx.fillStyle = COL_DIM;
            ctx.fillText(lines[i][0] + '  ', x - ctx.measureText(lines[i][1]).width - 5 * scale, ly);
        }
    }

    function drawNavball(ctx, state, scale) {
        if (!state) return;

        const nbCx = width / 2;
        const nbCy = height - 100 * scale;
        const radius = 60 * scale;

        // Background circle
        ctx.beginPath();
        ctx.arc(nbCx, nbCy, radius, 0, TWO_PI);
        ctx.fillStyle = 'rgba(0, 20, 40, 0.7)';
        ctx.fill();
        ctx.strokeStyle = COL_DIM;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();

        // Horizon line
        const pitchOffset = state.pitch * radius / (Math.PI / 2);
        ctx.save();
        ctx.beginPath();
        ctx.arc(nbCx, nbCy, radius - 2 * scale, 0, TWO_PI);
        ctx.clip();

        // Sky (upper) / Ground (lower) split
        ctx.fillStyle = 'rgba(30, 60, 120, 0.4)';
        ctx.fillRect(nbCx - radius, nbCy - radius + pitchOffset, radius * 2, radius - pitchOffset);
        ctx.fillStyle = 'rgba(60, 40, 20, 0.4)';
        ctx.fillRect(nbCx - radius, nbCy + pitchOffset, radius * 2, radius - pitchOffset);

        // Horizon line
        ctx.strokeStyle = COL_PRIMARY;
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.moveTo(nbCx - radius, nbCy + pitchOffset);
        ctx.lineTo(nbCx + radius, nbCy + pitchOffset);
        ctx.stroke();

        // Dynamic markers from ECI state (if SpaceplaneOrbital available)
        const O = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital : null;
        if (O && O.orbitalElements && O.orbitalElements._r && O.orbitalElements._v) {
            const r = O.orbitalElements._r;
            const v = O.orbitalElements._v;
            const vMag = O.vecMag(v);
            const rMag = O.vecMag(r);

            if (vMag > 100 && rMag > 1000) {
                // Compute orbital frame
                const prograde  = O.vecScale(v, 1 / vMag);
                const retrograde = O.vecScale(prograde, -1);
                const h = O.vecCross(r, v);
                const hMag = O.vecMag(h);
                const normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];
                const radialOut = O.vecScale(r, 1 / rMag);

                // ECI → ENU conversion (reuse orbital elements simTime context)
                // Use a simplified heading-relative projection
                const OMEGA = O.OMEGA_EARTH;
                // We need simTime but don't have it directly; use angular momentum direction
                // as a proxy for the ECI→body frame. For the planner navball, we compute
                // bearing/elevation relative to vehicle heading/pitch.

                // Get simTime from the last update — read from shared state
                const simTime = _lastSimTime || 0;
                const gmst = OMEGA * simTime;
                const cosG = Math.cos(-gmst), sinG = Math.sin(-gmst);
                const cosLat = Math.cos(state.lat), sinLat = Math.sin(state.lat);
                const cosLon = Math.cos(state.lon), sinLon = Math.sin(state.lon);

                const eastECEF  = [-sinLon,             cosLon,              0];
                const northECEF = [-sinLat * cosLon,    -sinLat * sinLon,    cosLat];
                const upECEF    = [ cosLat * cosLon,     cosLat * sinLon,    sinLat];

                function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

                function eciDirToENU(d) {
                    const ecef = [
                        cosG * d[0] - sinG * d[1],
                        sinG * d[0] + cosG * d[1],
                        d[2]
                    ];
                    return [dot3(ecef, eastECEF), dot3(ecef, northECEF), dot3(ecef, upECEF)];
                }

                function navPos(dirECI) {
                    const enu = eciDirToENU(dirECI);
                    const brg  = Math.atan2(enu[0], enu[1]);
                    const horiz = Math.sqrt(enu[0]*enu[0] + enu[1]*enu[1]);
                    const elev  = Math.atan2(enu[2], horiz);

                    let relBrg = brg - (state.heading + (state.yawOffset || 0));
                    if (relBrg >  Math.PI) relBrg -= 2 * Math.PI;
                    if (relBrg < -Math.PI) relBrg += 2 * Math.PI;

                    const nx = relBrg / (Math.PI / 2);
                    const ny = -elev / (Math.PI / 2);
                    const dist = Math.sqrt(nx * nx + ny * ny);

                    return {
                        x: nbCx + nx * radius * 0.8,
                        y: nbCy + ny * radius * 0.8,
                        visible: dist < 1.0
                    };
                }

                const dynMarkers = [
                    { dir: prograde,    color: COL_PROGRADE,   type: 'prograde' },
                    { dir: retrograde,  color: COL_RETROGRADE, type: 'retrograde' },
                    { dir: normal,      color: COL_NORMAL,     type: 'normal' },
                    { dir: radialOut,   color: COL_RADIAL,     type: 'radial' },
                ];

                for (const m of dynMarkers) {
                    const pos = navPos(m.dir);
                    if (!pos.visible) continue;
                    drawNavballMarker(ctx, pos.x, pos.y, scale, m.color, m.type);
                }
            }
        } else {
            // Fallback: static markers when no orbital data
            drawNavballMarker(ctx, nbCx, nbCy - radius * 0.5, scale, COL_PROGRADE, 'prograde');
            drawNavballMarker(ctx, nbCx, nbCy + radius * 0.5, scale, COL_RETROGRADE, 'retrograde');
            drawNavballMarker(ctx, nbCx - radius * 0.5, nbCy, scale, COL_NORMAL, 'normal');
            drawNavballMarker(ctx, nbCx + radius * 0.5, nbCy, scale, COL_RADIAL, 'radial');
        }

        ctx.restore();

        // Center crosshair
        ctx.strokeStyle = COL_PRIMARY;
        ctx.lineWidth = 1.5 * scale;
        const ch = 8 * scale;
        ctx.beginPath();
        ctx.moveTo(nbCx - ch, nbCy); ctx.lineTo(nbCx + ch, nbCy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(nbCx, nbCy - ch); ctx.lineTo(nbCx, nbCy + ch);
        ctx.stroke();

        // Label
        ctx.fillStyle = COL_DIM;
        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('NAVBALL', nbCx, nbCy + radius + 14 * scale);
    }

    function drawNavballMarker(ctx, x, y, scale, color, type) {
        const r = 6 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5 * scale;

        if (type === 'prograde') {
            // Circle with dot
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TWO_PI);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2 * scale, 0, TWO_PI);
            ctx.fill();
            // Small lines extending from circle
            ctx.beginPath();
            ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 4 * scale);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - r, y); ctx.lineTo(x - r - 4 * scale, y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + r, y); ctx.lineTo(x + r + 4 * scale, y);
            ctx.stroke();
        } else if (type === 'retrograde') {
            // Circle with X
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TWO_PI);
            ctx.stroke();
            const d = r * 0.7;
            ctx.beginPath();
            ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
            ctx.stroke();
        } else if (type === 'normal') {
            // Triangle pointing up
            ctx.beginPath();
            ctx.moveTo(x, y - r);
            ctx.lineTo(x - r, y + r * 0.5);
            ctx.lineTo(x + r, y + r * 0.5);
            ctx.closePath();
            ctx.stroke();
        } else if (type === 'radial') {
            // Circle with dot
            ctx.beginPath();
            ctx.arc(x, y, r, 0, TWO_PI);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2 * scale, 0, TWO_PI);
            ctx.fill();
        }
    }

    function drawManeuverNodeInfo(ctx, state, scale) {
        if (typeof SpaceplanePlanner === 'undefined') return;
        const node = SpaceplanePlanner.selectedNode;
        if (!node) return;

        const cx = width / 2;
        const y = 80 * scale;

        ctx.font = `bold ${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ff8800';
        ctx.fillText('MANEUVER NODE', cx, y);

        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        const lineH = 18 * scale;

        const lines = [
            ['\u0394V', node.dv.toFixed(1) + ' m/s'],
            ['Burn', node.burnTime ? node.burnTime.toFixed(0) + 's' : '---'],
            ['T-', node.timeToNode != null ? fmtTime(node.timeToNode) : '---'],
            ['Post AP', node.postAP != null ? (node.postAP / 1000).toFixed(1) + ' km' : '---'],
            ['Post PE', node.postPE != null ? (node.postPE / 1000).toFixed(1) + ' km' : '---'],
        ];

        for (let i = 0; i < lines.length; i++) {
            const ly = y + (i + 1) * lineH;
            ctx.fillStyle = '#aa6600';
            ctx.textAlign = 'center';
            ctx.fillText(lines[i][0] + ': ' + lines[i][1], cx, ly);
        }
    }

    function drawFlightRegimeBanner(ctx, state, scale) {
        if (typeof SpaceplaneOrbital === 'undefined') return;

        const regime = SpaceplaneOrbital.flightRegime;
        const cx = width / 2;
        const y = 40 * scale;

        ctx.font = `bold ${16 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';

        const colors = {
            'ATMOSPHERIC': COL_GREEN,
            'SUBORBITAL': COL_WARN,
            'ORBIT': COL_ORBIT,
            'ESCAPE': COL_ALERT,
        };

        ctx.fillStyle = colors[regime] || COL_DIM;
        ctx.fillText(regime, cx, y);
    }

    // ---- Cockpit Overlay Elements (above 80km) ----

    function drawOrbitalStrip(ctx, state, scale) {
        const elems = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital.orbitalElements : null;
        const regime = typeof SpaceplaneOrbital !== 'undefined' ? SpaceplaneOrbital.flightRegime : null;

        if (!elems || !regime) return;

        const cx = width / 2;
        const y = 95 * scale;

        // Background bar
        ctx.fillStyle = 'rgba(0, 30, 60, 0.7)';
        ctx.fillRect(cx - 250 * scale, y - 10 * scale, 500 * scale, 22 * scale);

        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';

        // Regime
        const regimeColors = {
            'SUBORBITAL': COL_WARN,
            'ORBIT': COL_ORBIT,
            'ESCAPE': COL_ALERT,
        };
        ctx.fillStyle = regimeColors[regime] || COL_DIM;
        ctx.fillText(regime, cx - 200 * scale, y + 3 * scale);

        // AP/PE
        ctx.fillStyle = COL_ORBIT;
        const apText = elems.apoapsisAlt != null ? 'AP ' + (elems.apoapsisAlt / 1000).toFixed(0) + 'km' : 'AP ---';
        const peText = elems.periapsisAlt != null ? 'PE ' + (elems.periapsisAlt / 1000).toFixed(0) + 'km' : 'PE ---';
        ctx.fillText(apText, cx - 80 * scale, y + 3 * scale);
        ctx.fillText(peText, cx + 40 * scale, y + 3 * scale);

        // Orbital V %
        const orbV = state.orbitalVfrac ? (state.orbitalVfrac * 100).toFixed(0) : '0';
        ctx.fillText('V' + orbV + '%', cx + 160 * scale, y + 3 * scale);
    }

    function drawPropulsionMode(ctx, state, scale) {
        const mode = state.propulsionMode || 'AIR';
        const x = 20 * scale;
        const y = 65 * scale;

        ctx.font = `bold ${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        const modeColors = {
            'AIR': COL_GREEN,
            'HYPERSONIC': COL_WARN,
            'ROCKET': COL_ALERT,
        };

        ctx.fillStyle = modeColors[mode] || COL_DIM;
        ctx.fillText('PROP: ' + mode, x, y);
    }

    function drawReentryWarning(ctx, state, scale) {
        const q = state.dynamicPressure || 0;

        // Warn when re-entering with high dynamic pressure
        if (q > 10000 && state.alt > 50000 && state.speed > 2000) {
            const cx = width / 2;
            const y = height / 2 + 80 * scale;

            if (Date.now() % 1000 < 600) {
                ctx.font = `bold ${18 * scale}px 'Courier New', monospace`;
                ctx.textAlign = 'center';
                ctx.fillStyle = COL_ALERT;
                ctx.fillText('RE-ENTRY  Q=' + (q / 1000).toFixed(1) + ' kPa', cx, y);
            }
        }
    }

    // ---- Helpers ----
    function fmtTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '---';
        if (seconds > 86400) return (seconds / 86400).toFixed(1) + 'd';
        if (seconds > 3600) return (seconds / 3600).toFixed(1) + 'h';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + s.toString().padStart(2, '0');
    }

    // Public API
    return {
        resize,
        render,
        renderOverlay,
    };
})();
