/**
 * Fighter HUD (Heads-Up Display)
 * Canvas overlay with pitch ladder, speed/alt tapes, heading,
 * G meter, flight path marker, warnings, and targeting.
 */
const FighterHUD = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const MPS_TO_KNOTS = 1.94384;
    const M_TO_FT = 3.28084;
    const MPS_TO_FPM = 196.85; // m/s to ft/min

    // HUD colors
    const HUD_GREEN = '#00ff00';
    const HUD_DIM = '#00aa00';
    const HUD_WARN = '#ffff00';
    const HUD_ALERT = '#ff3333';
    const HUD_CYAN = '#00ffff';

    // Per-element visibility toggles (all ON by default)
    var _toggles = {
        hud: true,          // Master switch
        speedTape: true,    // Airspeed tape + Mach indicator
        altTape: true,      // Altitude tape + vertical speed
        heading: true,      // Heading tape
        pitchLadder: true,  // Pitch ladder lines
        fpm: true,          // Flight path marker + waterline
        gMeter: true,       // G-load meter
        engineFuel: true,   // Throttle + fuel gauge + delta-V budget
        weapons: true,      // Weapons status + target reticle + steer cue
        warnings: true,     // Warnings + phase indicator + regime
        orbital: true,      // Orbital markers + navball
        minimap: true,      // Radar minimap scope
        coordinates: true,  // Lat/lon/alt readout
        warpIndicator: true,// Time warp indicator
        approachAids: true  // Landing approach aids
    };

    // Fuel burn tracking for time-remaining calculation
    var _lastFuel = -1;
    var _fuelBurnRate = 0;  // kg/s (smoothed)

    let canvas, ctx;
    let width, height, cx, cy;

    /**
     * Initialize the HUD canvas
     * @param {HTMLCanvasElement} canvasElement
     */
    function init(canvasElement) {
        canvas = canvasElement;
        ctx = canvas.getContext('2d');
        resize();
    }

    /**
     * Handle window resize
     */
    function resize() {
        if (!canvas) return;
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        width = canvas.width;
        height = canvas.height;
        cx = width / 2;
        cy = height / 2;
    }

    /**
     * Render complete HUD frame
     * @param {object} state - aircraft state
     * @param {object} autopilot - autopilot state (optional)
     * @param {object} weapons - weapons state (optional)
     * @param {object} target - locked target info (optional)
     */
    function render(state, autopilot, weapons, target, simTime) {
        if (!ctx) return;

        ctx.clearRect(0, 0, width, height);

        // Scale factor for different screen sizes
        const scale = Math.min(width, height) / 800;

        ctx.save();

        // Default HUD style
        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        ctx.font = `${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Master HUD toggle
        if (!_toggles.hud) { ctx.restore(); return; }

        // Draw HUD elements (gated by per-element toggles)
        if (_toggles.pitchLadder) drawPitchLadder(state, scale, target);
        if (_toggles.orbital)     drawOrbitalMarkers(state, scale, simTime);
        if (_toggles.speedTape)   drawAirspeedTape(state, scale);
        if (_toggles.altTape)     drawAltitudeTape(state, scale);
        if (_toggles.heading)     drawHeadingTape(state, scale, target);
        if (_toggles.fpm)         drawFlightPathMarker(state, scale);
        if (_toggles.fpm)         drawWaterline(scale);
        if (_toggles.gMeter)      drawGMeter(state, scale);
        if (_toggles.engineFuel)  drawThrottleFuel(state, scale);
        if (_toggles.engineFuel)  drawFuelGauge(state, scale);
        if (_toggles.engineFuel)  drawDeltaVBudget(state, scale);
        if (_toggles.weapons)     drawWeaponsStatus(state, weapons, scale);
        if (_toggles.weapons)     drawTargetReticle(state, target, scale);
        if (_toggles.weapons)     drawTargetSteerCue(state, target, scale);
        if (_toggles.warnings)    drawAutopilotStatus(autopilot, scale);
        if (_toggles.warnings)    drawWarnings(state, scale);
        if (_toggles.warnings)    drawPhaseIndicator(state, scale);
        if (_toggles.speedTape)   drawMachIndicator(state, scale);
        if (_toggles.altTape)     drawVerticalSpeed(state, scale);
        if (_toggles.warnings)    drawRegimeIndicator(state, scale);
        if (_toggles.warnings)    drawPointingIndicator(state, scale);
        if (_toggles.orbital)     drawCompactNavball(state, scale, simTime);
        if (_toggles.minimap)     drawMinimap(state, scale);
        if (_toggles.coordinates) drawCoordinates(state, scale);
        if (_toggles.warpIndicator) drawTimeWarp(state, scale);
        if (_toggles.approachAids) drawApproachAids(state, scale);
        drawSensorReticle(state, scale);

        ctx.restore();
    }

    /**
     * Draw pitch ladder (horizontal lines at 5° intervals)
     */
    function drawPitchLadder(state, scale, target) {
        const pitchDeg = state.pitch * RAD;
        const rollRad = state.roll;
        const pxPerDeg = 8 * scale; // pixels per degree of pitch

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-rollRad);

        // Clip to central area
        ctx.beginPath();
        ctx.rect(-150 * scale, -180 * scale, 300 * scale, 360 * scale);
        ctx.clip();

        const halfWidth = 80 * scale;
        const gapHalf = 20 * scale;

        for (let deg = -90; deg <= 90; deg += 5) {
            if (deg === 0) continue; // horizon line handled separately

            const y = -(deg - pitchDeg) * pxPerDeg;
            if (Math.abs(y) > 200 * scale) continue;

            const isNeg = deg < 0;
            const lineHalf = (deg % 10 === 0) ? halfWidth : halfWidth * 0.6;

            ctx.strokeStyle = HUD_GREEN;
            ctx.lineWidth = 1.5 * scale;
            ctx.setLineDash(isNeg ? [6 * scale, 4 * scale] : []);

            // Left segment
            ctx.beginPath();
            ctx.moveTo(-lineHalf, y);
            ctx.lineTo(-gapHalf, y);
            if (!isNeg) {
                ctx.lineTo(-gapHalf, y + 8 * scale); // down tick
            }
            ctx.stroke();

            // Right segment
            ctx.beginPath();
            ctx.moveTo(gapHalf, y);
            ctx.lineTo(lineHalf, y);
            if (!isNeg) {
                ctx.lineTo(lineHalf, y + 8 * scale);
            }
            ctx.stroke();

            // Degree labels (every 10°)
            if (deg % 10 === 0) {
                ctx.setLineDash([]);
                ctx.fillStyle = HUD_GREEN;
                ctx.font = `${12 * scale}px 'Courier New', monospace`;
                ctx.textAlign = 'right';
                ctx.fillText(Math.abs(deg).toString(), -lineHalf - 5 * scale, y);
                ctx.textAlign = 'left';
                ctx.fillText(Math.abs(deg).toString(), lineHalf + 5 * scale, y);
            }
        }

        // Horizon line
        const horizY = pitchDeg * pxPerDeg;
        ctx.setLineDash([]);
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(-200 * scale, horizY);
        ctx.lineTo(-gapHalf, horizY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(gapHalf, horizY);
        ctx.lineTo(200 * scale, horizY);
        ctx.stroke();

        // Target elevation line on pitch ladder (shows pitch-to-target)
        if (target && target.locked) {
            const range = FighterSimEngine.distance(state.lat, state.lon,
                                                     target.lat, target.lon);
            const dAlt = target.alt - state.alt;
            const elevDeg = Math.atan2(dAlt, Math.max(range, 1)) * RAD;

            const tgtY = -(elevDeg - pitchDeg) * pxPerDeg;

            if (Math.abs(tgtY) < 180 * scale) {
                ctx.setLineDash([4 * scale, 4 * scale]);
                ctx.strokeStyle = HUD_CYAN;
                ctx.lineWidth = 1.5 * scale;
                // Dashed horizontal line at target elevation
                ctx.beginPath();
                ctx.moveTo(-halfWidth - 20 * scale, tgtY);
                ctx.lineTo(halfWidth + 20 * scale, tgtY);
                ctx.stroke();
                ctx.setLineDash([]);

                // Small label
                ctx.fillStyle = HUD_CYAN;
                ctx.font = `${10 * scale}px 'Courier New', monospace`;
                ctx.textAlign = 'left';
                ctx.fillText('TGT', halfWidth + 25 * scale, tgtY);
            }
        }

        ctx.restore();
    }

    /**
     * Draw waterline (aircraft reference symbol - W shape)
     */
    function drawWaterline(scale) {
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 2 * scale;

        const w = 25 * scale;
        const h = 6 * scale;

        ctx.beginPath();
        // Left wing
        ctx.moveTo(cx - w * 2, cy);
        ctx.lineTo(cx - w, cy);
        ctx.lineTo(cx - w * 0.5, cy + h);
        // Center dip
        ctx.lineTo(cx, cy);
        // Right side
        ctx.lineTo(cx + w * 0.5, cy + h);
        ctx.lineTo(cx + w, cy);
        ctx.lineTo(cx + w * 2, cy);
        ctx.stroke();

        // Center dot
        ctx.beginPath();
        ctx.arc(cx, cy, 2 * scale, 0, Math.PI * 2);
        ctx.fill();
    }

    /**
     * Draw flight path marker (velocity vector indicator)
     */
    function drawFlightPathMarker(state, scale) {
        const gammaDeg = state.gamma * RAD;
        const pxPerDeg = 8 * scale;

        // FPM position offset from center based on gamma and any sideslip
        const fpx = cx + (state.yaw || 0) * RAD * pxPerDeg;
        const fpy = cy - gammaDeg * pxPerDeg;

        const r = 8 * scale;

        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 2 * scale;

        // Circle
        ctx.beginPath();
        ctx.arc(fpx, fpy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Wings
        ctx.beginPath();
        ctx.moveTo(fpx - r, fpy);
        ctx.lineTo(fpx - r * 2.5, fpy);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(fpx + r, fpy);
        ctx.lineTo(fpx + r * 2.5, fpy);
        ctx.stroke();

        // Tail
        ctx.beginPath();
        ctx.moveTo(fpx, fpy - r);
        ctx.lineTo(fpx, fpy - r * 1.8);
        ctx.stroke();
    }

    /**
     * Draw airspeed tape (left side)
     */
    function drawAirspeedTape(state, scale) {
        const kias = Atmosphere.tasToCas(state.speed, state.alt) * MPS_TO_KNOTS;
        const x = 80 * scale;
        const tapeH = 250 * scale;
        const pxPerKt = 2 * scale;

        ctx.save();

        // Background strip
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(x - 45 * scale, cy - tapeH / 2, 50 * scale, tapeH);

        // Clip to tape area
        ctx.beginPath();
        ctx.rect(x - 45 * scale, cy - tapeH / 2, 50 * scale, tapeH);
        ctx.clip();

        // Caution bands (stall speed red, overspeed amber)
        var stallKts = 120; // default stall speed KIAS
        var overspeedKts = 800; // default overspeed limit
        var vneKts = 900; // never exceed
        if (typeof FighterSimEngine !== 'undefined' && FighterSimEngine.getConfig) {
            var cfg = FighterSimEngine.getConfig();
            if (cfg && cfg.stall_speed) stallKts = cfg.stall_speed * MPS_TO_KNOTS;
            if (cfg && cfg.vne) overspeedKts = cfg.vne * MPS_TO_KNOTS;
            if (cfg && cfg.vne) vneKts = cfg.vne * MPS_TO_KNOTS * 1.1;
        }
        // Stall band (red stripe at left edge of tape)
        var stallY = cy - (stallKts - kias) * pxPerKt;
        var bottomY = cy + tapeH / 2;
        if (stallY < bottomY) {
            ctx.fillStyle = 'rgba(255, 50, 50, 0.25)';
            ctx.fillRect(x - 45 * scale, Math.max(stallY, cy - tapeH / 2), 4 * scale, Math.min(bottomY - stallY, tapeH));
            // Stall line
            ctx.strokeStyle = HUD_ALERT;
            ctx.lineWidth = 2 * scale;
            ctx.setLineDash([4 * scale, 3 * scale]);
            ctx.beginPath();
            ctx.moveTo(x - 45 * scale, stallY);
            ctx.lineTo(x + 5 * scale, stallY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        // Overspeed band (amber stripe at left edge)
        var overspeedY = cy - (overspeedKts - kias) * pxPerKt;
        var topY = cy - tapeH / 2;
        if (overspeedY > topY) {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.15)';
            ctx.fillRect(x - 45 * scale, topY, 4 * scale, Math.min(overspeedY - topY, tapeH));
            // Overspeed line
            ctx.strokeStyle = HUD_WARN;
            ctx.lineWidth = 2 * scale;
            ctx.setLineDash([4 * scale, 3 * scale]);
            ctx.beginPath();
            ctx.moveTo(x - 45 * scale, overspeedY);
            ctx.lineTo(x + 5 * scale, overspeedY);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Speed ticks and labels
        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';

        const baseSpeed = Math.round(kias / 10) * 10;
        for (let spd = baseSpeed - 80; spd <= baseSpeed + 80; spd += 10) {
            if (spd < 0) continue;
            const y = cy - (spd - kias) * pxPerKt;

            // Tick mark
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + 5 * scale, y);
            ctx.stroke();

            // Label every 20 knots
            if (spd % 20 === 0) {
                ctx.fillText(spd.toString(), x - 3 * scale, y);
            }
        }

        ctx.restore();

        // Current speed box
        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 2 * scale;
        const boxW = 55 * scale;
        const boxH = 22 * scale;
        ctx.fillRect(x - boxW + 5 * scale, cy - boxH / 2, boxW, boxH);
        ctx.strokeRect(x - boxW + 5 * scale, cy - boxH / 2, boxW, boxH);

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `bold ${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(kias).toString(), x - boxW / 2 + 5 * scale, cy + 1);
    }

    /**
     * Draw altitude tape (right side)
     */
    function drawAltitudeTape(state, scale) {
        const altFt = state.alt * M_TO_FT;
        const x = width - 80 * scale;
        const tapeH = 250 * scale;
        const pxPerFt = 0.15 * scale;

        ctx.save();

        // Background strip
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(x - 5 * scale, cy - tapeH / 2, 55 * scale, tapeH);

        // Clip
        ctx.beginPath();
        ctx.rect(x - 5 * scale, cy - tapeH / 2, 55 * scale, tapeH);
        ctx.clip();

        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        const baseAlt = Math.round(altFt / 100) * 100;
        for (let alt = baseAlt - 1000; alt <= baseAlt + 1000; alt += 100) {
            const y = cy - (alt - altFt) * pxPerFt;

            // Tick
            ctx.beginPath();
            ctx.moveTo(x - 5 * scale, y);
            ctx.lineTo(x, y);
            ctx.stroke();

            // Label every 200 ft
            if (alt % 200 === 0 && alt >= 0) {
                ctx.fillText(alt.toString(), x + 3 * scale, y);
            }
        }

        ctx.restore();

        // Current altitude box
        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 2 * scale;
        const boxW = 60 * scale;
        const boxH = 22 * scale;
        ctx.fillRect(x - 5 * scale, cy - boxH / 2, boxW, boxH);
        ctx.strokeRect(x - 5 * scale, cy - boxH / 2, boxW, boxH);

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `bold ${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(altFt).toString(), x + boxW / 2 - 5 * scale, cy + 1);
    }

    /**
     * Draw heading tape (top) with optional target bearing marker
     */
    function drawHeadingTape(state, scale, target) {
        const noseHdg = state.heading + (state.yawOffset || 0);
        const hdgDeg = noseHdg * RAD;
        const y = 50 * scale;
        const tapeW = 350 * scale;
        const pxPerDeg = 3 * scale;

        ctx.save();

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(cx - tapeW / 2, y - 15 * scale, tapeW, 30 * scale);

        // Clip
        ctx.beginPath();
        ctx.rect(cx - tapeW / 2, y - 15 * scale, tapeW, 30 * scale);
        ctx.clip();

        ctx.strokeStyle = HUD_GREEN;
        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';

        const cardinals = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
                           180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

        for (let d = -60; d <= 60; d += 5) {
            let deg = hdgDeg + d;
            if (deg < 0) deg += 360;
            if (deg >= 360) deg -= 360;

            const x = cx + d * pxPerDeg;

            // Tick
            const isMajor = Math.round(deg) % 10 === 0;
            ctx.beginPath();
            ctx.moveTo(x, y + 10 * scale);
            ctx.lineTo(x, y + (isMajor ? 4 : 7) * scale);
            ctx.stroke();

            // Label every 10°
            if (isMajor) {
                const roundDeg = Math.round(deg);
                const label = cardinals[roundDeg] || roundDeg.toString().padStart(3, '0');
                ctx.fillText(label, x, y - 3 * scale);
            }
        }

        // Target bearing marker on heading tape
        if (target && target.locked) {
            const tgtBrg = FighterSimEngine.bearing(state.lat, state.lon,
                                                     target.lat, target.lon) * RAD;
            let relDeg = tgtBrg - hdgDeg;
            if (relDeg > 180) relDeg -= 360;
            if (relDeg < -180) relDeg += 360;

            // Draw if within tape range
            if (Math.abs(relDeg) <= 60) {
                const tx = cx + relDeg * pxPerDeg;
                // Target caret (inverted triangle, cyan)
                ctx.fillStyle = HUD_CYAN;
                ctx.strokeStyle = HUD_CYAN;
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                ctx.moveTo(tx - 6 * scale, y - 14 * scale);
                ctx.lineTo(tx, y - 6 * scale);
                ctx.lineTo(tx + 6 * scale, y - 14 * scale);
                ctx.closePath();
                ctx.fill();
            } else {
                // Off-tape: draw arrow at edge pointing toward target
                const edgeX = relDeg > 0 ? cx + 58 * pxPerDeg : cx - 58 * pxPerDeg;
                const arrowDir = relDeg > 0 ? 1 : -1;
                ctx.fillStyle = HUD_CYAN;
                ctx.strokeStyle = HUD_CYAN;
                ctx.lineWidth = 2 * scale;
                ctx.beginPath();
                ctx.moveTo(edgeX, y - 2 * scale);
                ctx.lineTo(edgeX + arrowDir * 8 * scale, y - 2 * scale);
                ctx.lineTo(edgeX + arrowDir * 4 * scale, y - 8 * scale);
                ctx.closePath();
                ctx.fill();
                // Show degrees to target
                ctx.font = `${9 * scale}px 'Courier New', monospace`;
                ctx.textAlign = relDeg > 0 ? 'right' : 'left';
                ctx.fillText(Math.abs(Math.round(relDeg)) + '°',
                             edgeX - arrowDir * 2 * scale, y - 3 * scale);
            }
        }

        ctx.restore();

        // Center caret
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(cx - 8 * scale, y + 12 * scale);
        ctx.lineTo(cx, y + 6 * scale);
        ctx.lineTo(cx + 8 * scale, y + 12 * scale);
        ctx.stroke();

        // Digital heading readout
        ctx.fillStyle = HUD_GREEN;
        ctx.font = `bold ${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(hdgDeg < 0 ? hdgDeg + 360 : hdgDeg).toString().padStart(3, '0') + '°',
                     cx, y + 25 * scale);

        // Target bearing readout (below heading, if locked)
        if (target && target.locked) {
            const tgtBrg = FighterSimEngine.bearing(state.lat, state.lon,
                                                     target.lat, target.lon) * RAD;
            const brgText = Math.round(tgtBrg < 0 ? tgtBrg + 360 : tgtBrg).toString().padStart(3, '0');
            ctx.fillStyle = HUD_CYAN;
            ctx.font = `${11 * scale}px 'Courier New', monospace`;
            ctx.fillText('TGT ' + brgText + '°', cx, y + 38 * scale);
        }
    }

    /**
     * Draw G meter (bottom-left)
     */
    function drawGMeter(state, scale) {
        const x = 100 * scale;
        const y = height - 80 * scale;

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${14 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        const gColor = Math.abs(state.g_load) > 7 ? HUD_ALERT :
                       Math.abs(state.g_load) > 5 ? HUD_WARN : HUD_GREEN;

        ctx.fillStyle = gColor;
        ctx.fillText(`G ${state.g_load.toFixed(1)}`, x, y);
        ctx.fillStyle = HUD_DIM;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.fillText(`MAX ${state.maxG_experienced.toFixed(1)}`, x, y + 16 * scale);
    }

    /**
     * Draw throttle, fuel, and propulsion info (bottom-right area)
     */
    function drawThrottleFuel(state, scale) {
        const x = width - 130 * scale;
        const y = height - 100 * scale;

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        // --- Propulsion mode indicator (engine name + thrust) ---
        var propName = state._propName || state.forcedPropMode || state.propulsionMode || 'AIR';
        var thrustN = state._currentThrust || 0;
        var thrustLabel = '';
        if (thrustN > 0) {
            if (thrustN >= 1e6) thrustLabel = ' ' + (thrustN / 1e6).toFixed(1) + 'MN';
            else if (thrustN >= 1000) thrustLabel = ' ' + (thrustN / 1000).toFixed(0) + 'kN';
            else thrustLabel = ' ' + thrustN.toFixed(0) + 'N';
        }
        var modeColor = propName === 'AIR' || propName === 'TAXI' ? HUD_GREEN :
                        propName === 'HYPERSONIC' ? HUD_WARN : HUD_ALERT;
        ctx.fillStyle = state.engineOn ? modeColor : HUD_DIM;
        ctx.font = `bold ${11 * scale}px 'Courier New', monospace`;
        ctx.fillText(propName + thrustLabel, x, y - 14 * scale);
        ctx.font = `${12 * scale}px 'Courier New', monospace`;

        // --- Throttle ---
        const thr = Math.round(state.throttle * 100);
        const abOn = state.throttle > 0.85;
        ctx.fillStyle = abOn ? HUD_WARN : HUD_GREEN;
        ctx.fillText('THR', x, y);

        // Throttle bar with tick marks
        const barW = 80 * scale;
        const barH = 8 * scale;
        const barX = x + 30 * scale;
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 1 * scale;
        ctx.strokeRect(barX, y + 5 * scale, barW, barH);
        ctx.fillStyle = abOn ? HUD_WARN : HUD_GREEN;
        ctx.fillRect(barX, y + 5 * scale, barW * state.throttle, barH);

        // Tick marks at 25%, 50%, 75%, 100%
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 0.8 * scale;
        for (var ti = 1; ti <= 4; ti++) {
            var tickX = barX + barW * (ti * 0.25);
            ctx.beginPath();
            ctx.moveTo(tickX, y + 5 * scale);
            ctx.lineTo(tickX, y + 5 * scale + barH);
            ctx.stroke();
        }

        // Numeric percentage next to bar
        ctx.fillStyle = abOn ? HUD_WARN : HUD_GREEN;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(thr + '%' + (abOn ? ' AB' : ''), x + 30 * scale + barW + 35 * scale, y + 5 * scale + barH / 2 + 1);
        ctx.textAlign = 'left';

        // --- Fuel (use _fuelCapacity if available, fallback to F16_CONFIG) ---
        var fuelCap = state._fuelCapacity;
        if (fuelCap === undefined || fuelCap === null) {
            fuelCap = FighterSimEngine.F16_CONFIG.fuel_capacity;
        }
        var hasFuel = isFinite(state.fuel) && isFinite(fuelCap) && fuelCap > 0;

        if (hasFuel) {
            var fuelPct = (state.fuel / fuelCap) * 100;
            var fuelLbs = state.fuel * 2.205;
            ctx.font = `${12 * scale}px 'Courier New', monospace`;
            ctx.fillStyle = fuelPct < 15 ? HUD_ALERT : fuelPct < 30 ? HUD_WARN : HUD_GREEN;
            ctx.fillText('FUEL ' + Math.round(fuelLbs) + ' LB (' + Math.round(fuelPct) + '%)', x, y + 25 * scale);

            // Fuel bar
            ctx.strokeStyle = HUD_GREEN;
            ctx.lineWidth = 1 * scale;
            ctx.strokeRect(barX, y + 30 * scale, barW, barH);
            ctx.fillStyle = fuelPct < 15 ? HUD_ALERT : fuelPct < 30 ? HUD_WARN : HUD_GREEN;
            ctx.fillRect(barX, y + 30 * scale, barW * Math.min(fuelPct / 100, 1), barH);

            // Fuel burn rate + time remaining
            if (_lastFuel >= 0 && state.fuel < _lastFuel) {
                var rawRate = (_lastFuel - state.fuel) * 60; // per-frame delta scaled to ~per-second (assumes 60fps)
                _fuelBurnRate = _fuelBurnRate * 0.95 + rawRate * 0.05; // EMA smooth
            }
            _lastFuel = state.fuel;

            if (_fuelBurnRate > 0.01 && state.fuel > 0) {
                var timeRemSec = state.fuel / _fuelBurnRate;
                var trMin = Math.floor(timeRemSec / 60);
                var trSec = Math.floor(timeRemSec % 60);
                var timeStr = trMin > 99 ? (trMin + 'm') : (trMin + ':' + (trSec < 10 ? '0' : '') + trSec);
                ctx.fillStyle = timeRemSec < 120 ? HUD_ALERT : timeRemSec < 300 ? HUD_WARN : HUD_DIM;
                ctx.font = `${11 * scale}px 'Courier New', monospace`;
                ctx.fillText('BURN ' + _fuelBurnRate.toFixed(1) + ' kg/s  T-' + timeStr, x, y + 45 * scale);
            }
        } else {
            // Infinite fuel indicator
            ctx.fillStyle = HUD_DIM;
            ctx.font = `${11 * scale}px 'Courier New', monospace`;
            ctx.fillText('FUEL INF', x, y + 25 * scale);
            _lastFuel = -1;
            _fuelBurnRate = 0;
        }
    }

    /**
     * Draw vertical fuel gauge (left side, below speed tape)
     * Only shown when fuel is finite (custom platforms may have finite fuel;
     * default spaceplane has infinite fuel).
     */
    function drawFuelGauge(state, scale) {
        var fuelCap = state._fuelCapacity;
        if (fuelCap === undefined || fuelCap === null) {
            fuelCap = FighterSimEngine.F16_CONFIG.fuel_capacity;
        }
        if (!isFinite(state.fuel) || !isFinite(fuelCap) || fuelCap <= 0) return;

        var fuelPct = Math.max(0, Math.min(1, state.fuel / fuelCap));
        var fuelKg = state.fuel;

        // Position: left side, below speed tape area
        var gx = 30 * scale;           // left margin
        var gy = cy + 150 * scale;     // below speed tape center
        var gw = 14 * scale;           // bar width
        var gh = 120 * scale;          // bar height

        // Background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.fillRect(gx - 2 * scale, gy - 2 * scale, gw + 4 * scale, gh + 4 * scale);

        // Outline
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeRect(gx, gy, gw, gh);

        // Color based on fuel level
        var barColor;
        if (fuelPct > 0.50) barColor = HUD_GREEN;
        else if (fuelPct > 0.20) barColor = HUD_WARN;
        else barColor = HUD_ALERT;

        // Fill from bottom up
        var fillH = gh * fuelPct;
        ctx.fillStyle = barColor;
        ctx.fillRect(gx, gy + gh - fillH, gw, fillH);

        // Tick marks at 25%, 50%, 75%
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 0.8 * scale;
        for (var ti = 1; ti <= 3; ti++) {
            var tickY = gy + gh * (1 - ti * 0.25);
            ctx.beginPath();
            ctx.moveTo(gx, tickY);
            ctx.lineTo(gx + gw, tickY);
            ctx.stroke();
        }

        // Fuel mass label below gauge
        var fuelStr;
        if (fuelKg >= 10000) fuelStr = (fuelKg / 1000).toFixed(1) + 't';
        else if (fuelKg >= 1000) fuelStr = (fuelKg / 1000).toFixed(2) + 't';
        else fuelStr = Math.round(fuelKg) + 'kg';

        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = barColor;
        ctx.fillText(fuelStr, gx + gw / 2, gy + gh + 14 * scale);

        // "FUEL" label above gauge
        ctx.fillStyle = HUD_DIM;
        ctx.font = `${9 * scale}px 'Courier New', monospace`;
        ctx.fillText('FUEL', gx + gw / 2, gy - 8 * scale);

        // Percentage on the bar
        ctx.font = `bold ${10 * scale}px 'Courier New', monospace`;
        ctx.fillStyle = barColor;
        ctx.fillText(Math.round(fuelPct * 100) + '%', gx + gw / 2, gy + gh / 2);
    }

    /**
     * Draw delta-V budget display (right side, near orbital info)
     * Uses Tsiolkovsky rocket equation: dv = Ve * ln(m0/mf)
     * Only shown above 30km altitude (orbital context).
     */
    function drawDeltaVBudget(state, scale) {
        if (!state || state.alt < 30000) return;

        // Isp values by propulsion mode (seconds)
        var ISP_TABLE = {
            'ROCKET': 350,
            'HYPERSONIC': 1200,
            'AIR': 3000,
        };
        // Named engine Isp overrides
        var NAMED_ISP = {
            'ION 0.5N': 3000,
            'HALL 5N': 1800,
            'Cold Gas 50N': 70,
            'RCS 500N': 220,
            'OMS 25kN': 316,
            'AJ10 100kN': 319,
            '1G ACCEL 147kN': 450,
            'NERVA 350kN': 900,
            'RL10 500kN': 462,
            'Raptor 2.2MN': 363,
            'RS25 5MN': 452,
            'TORCH 50MN': 100000,
        };

        var G0 = 9.80665;
        var propMode = state.forcedPropMode || state.propulsionMode || 'AIR';
        var propName = state._propName || propMode;

        // Get Isp
        var isp = NAMED_ISP[propName];
        if (!isp) isp = ISP_TABLE[propMode] || ISP_TABLE['ROCKET'];
        var Ve = isp * G0;   // exhaust velocity m/s

        // Get masses
        var dryMass = state._dryMass || 8570;
        var weaponMass = state.weaponMass || 0;
        var fuelMass = isFinite(state.fuel) ? state.fuel : 0;
        var m0 = dryMass + weaponMass + fuelMass;   // current wet mass
        var mf = dryMass + weaponMass;               // empty (dry) mass

        // Delta-V remaining
        var dv = 0;
        if (m0 > mf && mf > 0 && fuelMass > 0) {
            dv = Ve * Math.log(m0 / mf);
        }

        // Position: right side, below regime indicator
        var dvX = width - 20 * scale;
        var dvY = 68 * scale;

        // Only show if fuel is finite (infinite fuel = infinite dV, not useful)
        if (!isFinite(state.fuel)) {
            ctx.font = `${11 * scale}px 'Courier New', monospace`;
            ctx.textAlign = 'right';
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('\u0394V: INF', dvX, dvY);
            return;
        }

        // Delta-V value
        var dvStr;
        if (dv >= 10000) dvStr = (dv / 1000).toFixed(1) + ' km/s';
        else if (dv >= 100) dvStr = Math.round(dv) + ' m/s';
        else dvStr = dv.toFixed(1) + ' m/s';

        ctx.font = `bold ${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = HUD_CYAN;
        ctx.fillText('\u0394V: ' + dvStr, dvX, dvY);

        // Isp line
        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('Isp ' + isp + 's  Ve ' + (Ve >= 10000 ? (Ve / 1000).toFixed(1) + 'km/s' : Math.round(Ve) + 'm/s'), dvX, dvY + 14 * scale);

        // Mass breakdown
        ctx.fillText('m0 ' + (m0 / 1000).toFixed(1) + 't  mf ' + (mf / 1000).toFixed(1) + 't', dvX, dvY + 26 * scale);
    }

    /**
     * Draw weapons & sensor status (bottom-center)
     * Shows active weapon, inventory, and sensor state
     */
    function drawWeaponsStatus(state, weapons, scale) {
        const x = cx;
        const baseY = height - 40 * scale;
        const lineH = 14 * scale;
        ctx.textAlign = 'center';
        ctx.font = `${12 * scale}px 'Courier New', monospace`;

        // --- Active weapon (large, center bottom) ---
        if (weapons && weapons.selectedWeapon) {
            var name = weapons.selectedWeapon;
            var count = weapons.count !== undefined ? weapons.count : 0;
            var isJammer = weapons.selectedType === 'jammer';
            var isNuke = weapons.selectedType === 'nuclear' || weapons.selectedType === 'cruise';

            // Active weapon highlight
            ctx.fillStyle = isNuke ? HUD_ALERT : isJammer ? HUD_CYAN : HUD_GREEN;
            ctx.font = `bold ${14 * scale}px 'Courier New', monospace`;
            if (isJammer) {
                ctx.fillText(name + (weapons.active ? ' [ON]' : ' [OFF]'), x, baseY);
            } else {
                ctx.fillText(name + '  \u00d7' + count, x, baseY);
            }

            // Weapon list (smaller, above active weapon)
            if (weapons.allWeapons && weapons.allWeapons.length > 1) {
                ctx.font = `${10 * scale}px 'Courier New', monospace`;
                var listY = baseY - lineH * 1.2;
                for (var i = weapons.allWeapons.length - 1; i >= 0; i--) {
                    var w = weapons.allWeapons[i];
                    var isSel = (i === weapons.weaponIndex);
                    ctx.fillStyle = isSel ? HUD_GREEN : HUD_DIM;
                    var prefix = isSel ? '\u25b6 ' : '  ';
                    var wText = prefix + w.name + ' \u00d7' + w.count;
                    if (w.type === 'jammer') wText = prefix + w.name + (w.active ? ' ON' : ' OFF');
                    ctx.fillText(wText, x, listY);
                    listY -= lineH * 0.9;
                }
            }

            // Fire hint
            ctx.font = `${9 * scale}px 'Courier New', monospace`;
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('[SPACE] FIRE  [R] CYCLE', x, baseY + lineH);
        } else {
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('NO WEAPON', x, baseY);
        }

        // --- Sensor (bottom-right) ---
        var sensor = state._sensor;
        if (sensor) {
            ctx.textAlign = 'right';
            var sx = width - 20 * scale;
            var sy = baseY;
            var isVisual = sensor.type === 'optical' || sensor.type === 'ir';

            // Sensor name — yellow for visual sensors (active view), cyan for others
            ctx.font = `${11 * scale}px 'Courier New', monospace`;
            ctx.fillStyle = isVisual ? HUD_WARN : HUD_CYAN;
            ctx.fillText('SNR: ' + sensor.name, sx, sy);

            // Mode line — show sensor-specific info
            ctx.font = `${9 * scale}px 'Courier New', monospace`;
            ctx.fillStyle = isVisual ? '#cccc00' : '#008888';
            var modeText = sensor.filterInfo ? sensor.filterInfo.label :
                           sensor.type === 'radar' ? 'SEARCH | ACTIVE' :
                           sensor.type === 'sar' ? 'SAR | MAPPING' :
                           sensor.type === 'sigint' ? 'ESM | PASSIVE' :
                           sensor.type === 'lidar' ? 'LIDAR | SCAN' : '';
            if (modeText) ctx.fillText(modeText, sx, sy + lineH * 0.8);

            // Cycle hint
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('[V] CYCLE', sx, sy + lineH * 1.6);
        }

        // --- Trim indicator (bottom-left) ---
        if (state._trim !== undefined) {
            ctx.textAlign = 'left';
            ctx.font = `${11 * scale}px 'Courier New', monospace`;
            var trimDeg = (state._trim * 180 / Math.PI).toFixed(1);
            ctx.fillStyle = Math.abs(state._trim) > 0.01 ? HUD_WARN : HUD_DIM;
            ctx.fillText('TRIM ' + trimDeg + '\u00b0', 20 * scale, baseY);
        }
    }

    /**
     * Draw target reticle
     */
    function drawTargetReticle(state, target, scale) {
        if (!target || !target.locked) return;

        // Compute bearing and elevation to target
        const bearing = FighterSimEngine.bearing(state.lat, state.lon,
                                                  target.lat, target.lon);
        const range = FighterSimEngine.distance(state.lat, state.lon,
                                                 target.lat, target.lon);
        const dAlt = target.alt - state.alt;

        // Relative bearing (from nose)
        let relBearing = bearing - state.heading;
        if (relBearing > Math.PI) relBearing -= 2 * Math.PI;
        if (relBearing < -Math.PI) relBearing += 2 * Math.PI;

        const relElev = Math.atan2(dAlt, range);

        const pxPerDeg = 8 * scale;
        const tx = cx + relBearing * RAD * pxPerDeg;
        const ty = cy - relElev * RAD * pxPerDeg;

        // Only draw if within HUD FoV
        if (Math.abs(relBearing) > 30 * DEG) return;

        const sz = 15 * scale;

        // Diamond reticle
        ctx.strokeStyle = HUD_CYAN;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(tx, ty - sz);
        ctx.lineTo(tx + sz, ty);
        ctx.lineTo(tx, ty + sz);
        ctx.lineTo(tx - sz, ty);
        ctx.closePath();
        ctx.stroke();

        // Target data
        ctx.fillStyle = HUD_CYAN;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        const rangeNm = range / 1852;
        const closureRate = target.closureRate || 0;

        ctx.fillText(`TGT ${target.name || 'BANDIT'}`, tx + sz + 5 * scale, ty - 10 * scale);
        ctx.fillText(`${rangeNm.toFixed(1)} NM`, tx + sz + 5 * scale, ty + 5 * scale);
        ctx.fillText(`${Math.round(closureRate * MPS_TO_KNOTS)} KT CLS`, tx + sz + 5 * scale, ty + 20 * scale);
    }

    /**
     * Draw target steering cue - a TD box (target designator) showing
     * where to steer to point nose at target
     */
    function drawTargetSteerCue(state, target, scale) {
        if (!target || !target.locked) return;

        // Compute bearing and elevation from nose to target
        const bearing = FighterSimEngine.bearing(state.lat, state.lon,
                                                  target.lat, target.lon);
        const range = FighterSimEngine.distance(state.lat, state.lon,
                                                 target.lat, target.lon);
        const dAlt = target.alt - state.alt;
        const slantRange = Math.sqrt(range * range + dAlt * dAlt);

        // Relative bearing from nose (heading)
        let relBrg = bearing - state.heading;
        if (relBrg > Math.PI) relBrg -= 2 * Math.PI;
        if (relBrg < -Math.PI) relBrg += 2 * Math.PI;

        // Elevation angle to target relative to flight path
        const elevAngle = Math.atan2(dAlt, Math.max(range, 1));
        const relElev = elevAngle - state.gamma;

        const pxPerDeg = 8 * scale;
        const rangeNm = slantRange / 1852;

        // Target designator box position (in screen coords, roll-compensated)
        const relBrgDeg = relBrg * RAD;
        const relElevDeg = relElev * RAD;

        // Clamp to visible area but show direction
        const maxOff = 25; // degrees from center before clamping
        const clampedBrg = Math.max(-maxOff, Math.min(maxOff, relBrgDeg));
        const clampedElev = Math.max(-maxOff, Math.min(maxOff, relElevDeg));
        const isClamped = Math.abs(relBrgDeg) > maxOff || Math.abs(relElevDeg) > maxOff;

        const tdX = cx + clampedBrg * pxPerDeg;
        const tdY = cy - clampedElev * pxPerDeg;

        const sz = 12 * scale;

        if (!isClamped) {
            // Target Designator box (on-screen)
            ctx.strokeStyle = HUD_CYAN;
            ctx.lineWidth = 2 * scale;
            ctx.strokeRect(tdX - sz, tdY - sz, sz * 2, sz * 2);

            // Dot in center
            ctx.fillStyle = HUD_CYAN;
            ctx.beginPath();
            ctx.arc(tdX, tdY, 2 * scale, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Off-screen: draw arrow at edge pointing to target
            ctx.strokeStyle = HUD_CYAN;
            ctx.fillStyle = HUD_CYAN;
            ctx.lineWidth = 2 * scale;

            // Direction arrow
            const angle = Math.atan2(-relElevDeg, relBrgDeg); // screen coords (y inverted)
            ctx.save();
            ctx.translate(tdX, tdY);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(10 * scale, 0);
            ctx.lineTo(-4 * scale, -6 * scale);
            ctx.lineTo(-4 * scale, 6 * scale);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        // Steering line: dashed line from center to TD box
        ctx.strokeStyle = HUD_CYAN;
        ctx.lineWidth = 1 * scale;
        ctx.setLineDash([4 * scale, 4 * scale]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(tdX, tdY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Range + closure info near the TD box
        ctx.fillStyle = HUD_CYAN;
        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(`${rangeNm.toFixed(1)}NM`, tdX + sz + 4 * scale, tdY - 4 * scale);

        const closureKt = (target.closureRate || 0) * MPS_TO_KNOTS;
        if (Math.abs(closureKt) > 1) {
            ctx.fillText(`${closureKt > 0 ? '+' : ''}${Math.round(closureKt)}KT`,
                         tdX + sz + 4 * scale, tdY + 10 * scale);
        }
    }

    /**
     * Draw autopilot status
     */
    function drawAutopilotStatus(autopilot, scale) {
        if (!autopilot || !autopilot.enabled) return;

        const x = cx;
        const y = 85 * scale;

        ctx.fillStyle = HUD_CYAN;
        ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';

        let modes = ['AP'];
        if (autopilot.altHold) modes.push('ALT');
        if (autopilot.hdgHold) modes.push('HDG');
        if (autopilot.spdHold) modes.push('SPD');
        if (autopilot.wpNav) modes.push('NAV');

        ctx.fillText(modes.join(' | '), x, y);
    }

    /**
     * Draw warning messages
     */
    function drawWarnings(state, scale) {
        const warnings = [];

        if (state.isStalling) warnings.push({ text: 'STALL', color: HUD_ALERT });
        if (state.isOverspeed) warnings.push({ text: 'OVERSPEED', color: HUD_WARN });
        if (state.alt < 300 && state.gamma < -5 * DEG && state.phase === 'FLIGHT') {
            warnings.push({ text: 'PULL UP', color: HUD_ALERT });
        }
        if (isFinite(state.fuel) && state.fuel <= 0) warnings.push({ text: 'FUEL OUT', color: HUD_ALERT });
        var _wFuelCap = state._fuelCapacity || FighterSimEngine.F16_CONFIG.fuel_capacity;
        if (isFinite(state.fuel) && isFinite(_wFuelCap) && _wFuelCap > 0 &&
            state.fuel / _wFuelCap < 0.1 && state.fuel > 0) {
            warnings.push({ text: 'LOW FUEL', color: HUD_WARN });
        }
        if (!state.gearDown && state.alt < 500 && state.speed < 100 && state.phase === 'FLIGHT') {
            warnings.push({ text: 'GEAR', color: HUD_WARN });
        }
        if (state.phase === 'CRASHED') warnings.push({ text: 'CRASHED', color: HUD_ALERT });

        ctx.font = `bold ${20 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';

        for (let i = 0; i < warnings.length; i++) {
            const w = warnings[i];
            const y = cy + 120 * scale + i * 28 * scale;

            // Blinking effect
            if (Date.now() % 1000 < 600) {
                ctx.fillStyle = w.color;
                ctx.fillText(w.text, cx, y);
            }
        }
    }

    /**
     * Draw phase indicator (top-left)
     */
    function drawPhaseIndicator(state, scale) {
        const x = 20 * scale;
        const y = 30 * scale;

        ctx.fillStyle = HUD_DIM;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(state.phase, x, y);

        // Gear/Flaps status
        const gearText = state.gearDown ? 'GEAR DN' : 'GEAR UP';
        const flapText = state.flapsDown ? 'FLAPS DN' : 'FLAPS UP';
        ctx.fillText(`${gearText}  ${flapText}`, x, y + 16 * scale);

        // Engine status
        ctx.fillStyle = state.engineOn ? HUD_GREEN : HUD_ALERT;
        ctx.fillText(state.engineOn ? 'ENG ON' : 'ENG OFF', x, y + 32 * scale);
    }

    /**
     * Draw Mach number (below airspeed)
     */
    function drawMachIndicator(state, scale) {
        const x = 80 * scale;
        const y = cy + 140 * scale;

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillText(`M ${state.mach.toFixed(2)}`, x - 30 * scale, y);
    }

    /**
     * Draw vertical speed indicator
     */
    function drawVerticalSpeed(state, scale) {
        const x = width - 70 * scale;
        const y = cy + 140 * scale;
        const vsFpm = state.speed * Math.sin(state.gamma) * MPS_TO_FPM;

        ctx.fillStyle = HUD_GREEN;
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';

        const vsText = (vsFpm >= 0 ? '+' : '') + Math.round(vsFpm);
        ctx.fillText(`VS ${vsText}`, x, y);
    }

    /**
     * Draw flight regime indicator at top center of HUD
     */
    function drawRegimeIndicator(state, scale) {
        if (typeof SpaceplaneOrbital === 'undefined') return;
        const regime = SpaceplaneOrbital.flightRegime;
        if (!regime) return;

        const regimeColors = {
            'ATMOSPHERIC': '#00ff00',
            'SUBORBITAL': '#ffff00',
            'ORBIT': '#44ccff',
            'ESCAPE': '#ff3333',
        };

        ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = regimeColors[regime] || HUD_GREEN;
        ctx.fillText(regime, width - 20 * scale, 30 * scale);
    }

    /**
     * Draw pointing mode indicator (below regime indicator, top-right)
     */
    function drawPointingIndicator(state, scale) {
        if (!state || !state._pointingMode || state._pointingMode === 'manual') return;

        var mode = state._pointingMode.toUpperCase().replace('_', ' ');
        var locked = state._pointingLocked;

        ctx.font = `bold ${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = locked ? '#44ccff' : '#ffff00';
        ctx.fillText('PTG: ' + mode, width - 20 * scale, 48 * scale);

        // Lock indicator dot
        var dotX = width - 20 * scale + 8 * scale;
        var dotY = 48 * scale;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 3 * scale, 0, Math.PI * 2);
        ctx.fillStyle = locked ? '#00ff88' : '#ffaa00';
        ctx.fill();
    }

    /**
     * Draw sensor reticle crosshair when sensor view is active
     */
    function drawSensorReticle(state, scale) {
        if (!state || !state._sensor) return;
        var filterInfo = state._sensor.filterInfo;
        if (!filterInfo) return;

        var rcx = cx;
        var rcy = cy;
        var sz = 30 * scale;

        ctx.strokeStyle = '#00ff44';
        ctx.lineWidth = 1 * scale;
        ctx.globalAlpha = 0.7;

        // Crosshair lines
        ctx.beginPath();
        ctx.moveTo(rcx - sz, rcy); ctx.lineTo(rcx - sz * 0.4, rcy);
        ctx.moveTo(rcx + sz * 0.4, rcy); ctx.lineTo(rcx + sz, rcy);
        ctx.moveTo(rcx, rcy - sz); ctx.lineTo(rcx, rcy - sz * 0.4);
        ctx.moveTo(rcx, rcy + sz * 0.4); ctx.lineTo(rcx, rcy + sz);
        ctx.stroke();

        // Corner brackets
        var bsz = sz * 0.8;
        ctx.beginPath();
        ctx.moveTo(rcx - bsz, rcy - bsz); ctx.lineTo(rcx - bsz, rcy - bsz + 8 * scale);
        ctx.moveTo(rcx - bsz, rcy - bsz); ctx.lineTo(rcx - bsz + 8 * scale, rcy - bsz);
        ctx.moveTo(rcx + bsz, rcy - bsz); ctx.lineTo(rcx + bsz, rcy - bsz + 8 * scale);
        ctx.moveTo(rcx + bsz, rcy - bsz); ctx.lineTo(rcx + bsz - 8 * scale, rcy - bsz);
        ctx.moveTo(rcx - bsz, rcy + bsz); ctx.lineTo(rcx - bsz, rcy + bsz - 8 * scale);
        ctx.moveTo(rcx - bsz, rcy + bsz); ctx.lineTo(rcx - bsz + 8 * scale, rcy + bsz);
        ctx.moveTo(rcx + bsz, rcy + bsz); ctx.lineTo(rcx + bsz, rcy + bsz - 8 * scale);
        ctx.moveTo(rcx + bsz, rcy + bsz); ctx.lineTo(rcx + bsz - 8 * scale, rcy + bsz);
        ctx.stroke();

        ctx.globalAlpha = 1.0;

        // Sensor mode label at bottom of reticle
        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff44';
        ctx.fillText(filterInfo.label, rcx, rcy + sz + 14 * scale);

        // Pointing mode label above reticle
        if (state._pointingMode && state._pointingMode !== 'manual') {
            ctx.fillText('PTG: ' + state._pointingMode.toUpperCase(), rcx, rcy - sz - 8 * scale);
        }
    }

    /**
     * Draw compact navball at bottom-center of cockpit HUD
     * Shows dynamic prograde/retrograde/normal/radial markers computed from ECI state
     */
    function drawCompactNavball(state, scale, simTime) {
        if (typeof SpaceplaneOrbital === 'undefined') return;
        if (!state || state.alt < 30000 || simTime == null) return;

        const O = SpaceplaneOrbital;
        const nbCx = cx;
        const nbCy = height - 80 * scale;
        const radius = 50 * scale;

        // Get ECI state for marker computation
        const eci = O.geodeticToECI(state, simTime);
        const vMag = O.vecMag(eci.vel);
        const rMag = O.vecMag(eci.pos);
        if (vMag < 100 || rMag < 1000) return;

        // Background circle
        ctx.beginPath();
        ctx.arc(nbCx, nbCy, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 20, 40, 0.6)';
        ctx.fill();
        ctx.strokeStyle = '#226688';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();

        // Horizon line (pitch-based)
        ctx.save();
        ctx.beginPath();
        ctx.arc(nbCx, nbCy, radius - 2 * scale, 0, Math.PI * 2);
        ctx.clip();

        const pitchOffset = state.pitch * radius / (Math.PI / 2);
        // Sky / Ground
        ctx.fillStyle = 'rgba(30, 60, 120, 0.3)';
        ctx.fillRect(nbCx - radius, nbCy - radius + pitchOffset, radius * 2, radius - pitchOffset);
        ctx.fillStyle = 'rgba(60, 40, 20, 0.3)';
        ctx.fillRect(nbCx - radius, nbCy + pitchOffset, radius * 2, radius - pitchOffset);

        // Horizon line
        ctx.strokeStyle = '#44ccff';
        ctx.lineWidth = 1 * scale;
        ctx.beginPath();
        ctx.moveTo(nbCx - radius, nbCy + pitchOffset);
        ctx.lineTo(nbCx + radius, nbCy + pitchOffset);
        ctx.stroke();

        // Compute orbital frame in ECI
        const prograde  = O.vecScale(eci.vel, 1 / vMag);
        const retrograde = O.vecScale(prograde, -1);
        const h = O.vecCross(eci.pos, eci.vel);
        const hMag = O.vecMag(h);
        const normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];
        const radialOut = O.vecScale(eci.pos, 1 / rMag);

        // ECI → local ENU
        const OMEGA = O.OMEGA_EARTH;
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

        function navballPos(dirECI) {
            const enu = eciDirToENU(dirECI);
            const brg  = Math.atan2(enu[0], enu[1]);
            const horiz = Math.sqrt(enu[0]*enu[0] + enu[1]*enu[1]);
            const elev  = Math.atan2(enu[2], horiz);

            // Relative to vehicle nose heading
            const noseHdg = state.heading + (state.yawOffset || 0);
            let relBrg = brg - noseHdg;
            if (relBrg >  Math.PI) relBrg -= 2 * Math.PI;
            if (relBrg < -Math.PI) relBrg += 2 * Math.PI;

            // Map to navball surface: bearing → x, elevation → y
            // Normalize to [-1, 1] over ±90° range
            const nx = (relBrg / (Math.PI / 2));
            const ny = -(elev / (Math.PI / 2));
            const dist = Math.sqrt(nx * nx + ny * ny);

            return {
                x: nbCx + nx * radius * 0.85,
                y: nbCy + ny * radius * 0.85,
                visible: dist < 1.0
            };
        }

        // Draw markers
        const markers = [
            { dir: prograde,    color: '#00ff00', type: 'prograde' },
            { dir: retrograde,  color: '#ff4444', type: 'retrograde' },
            { dir: normal,      color: '#cc44ff', type: 'normal' },
            { dir: radialOut,   color: '#44ffcc', type: 'radial' },
        ];

        for (const m of markers) {
            const pos = navballPos(m.dir);
            if (!pos.visible) continue;
            drawNavballMarkerSymbol(pos.x, pos.y, scale, m.color, m.type);
        }

        ctx.restore();

        // Center crosshair (vehicle nose direction)
        ctx.strokeStyle = '#44ccff';
        ctx.lineWidth = 1.5 * scale;
        const ch = 6 * scale;
        ctx.beginPath();
        ctx.moveTo(nbCx - ch, nbCy); ctx.lineTo(nbCx + ch, nbCy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(nbCx, nbCy - ch); ctx.lineTo(nbCx, nbCy + ch);
        ctx.stroke();

        // Outer ring label
        ctx.fillStyle = '#226688';
        ctx.font = `${9 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('NAVBALL', nbCx, nbCy + radius + 4 * scale);
        ctx.textBaseline = 'middle';
    }

    /**
     * Draw a single navball marker symbol (smaller than pitch ladder markers)
     */
    function drawNavballMarkerSymbol(x, y, scale, color, type) {
        const r = 6 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5 * scale;
        ctx.setLineDash([]);

        if (type === 'prograde') {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 3 * scale); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x - r - 3 * scale, y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + r + 3 * scale, y); ctx.stroke();
        } else if (type === 'retrograde') {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            const d = r * 0.65;
            ctx.beginPath(); ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d); ctx.stroke();
        } else if (type === 'normal') {
            ctx.beginPath();
            ctx.moveTo(x, y - r);
            ctx.lineTo(x - r * 0.85, y + r * 0.5);
            ctx.lineTo(x + r * 0.85, y + r * 0.5);
            ctx.closePath();
            ctx.stroke();
        } else if (type === 'radial') {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2 * scale, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 3 * scale); ctx.stroke();
        }
    }

    // ---- Orbital Velocity Markers (KSP-style) ----

    /**
     * Draw prograde/retrograde/normal/radial markers on the pitch ladder
     * These show the orbital velocity direction relative to the vehicle's nose
     */
    // Smoothed radial direction to prevent edge-indicator flashing
    var _smoothedRadialOut = null;
    var _smoothedRadialIn = null;
    var _radialSmoothAlpha = 0.08; // lower = smoother (EMA factor per frame)

    function drawOrbitalMarkers(state, scale, simTime) {
        if (typeof SpaceplaneOrbital === 'undefined') return;
        if (!state || state.alt < 30000 || simTime == null) return;

        const O = SpaceplaneOrbital;
        const pxPerDeg = 8 * scale;
        const pitchDeg = state.pitch * RAD;

        // Get ECI state
        const eci = O.geodeticToECI(state, simTime);
        const vMag = O.vecMag(eci.vel);
        const rMag = O.vecMag(eci.pos);
        if (vMag < 100 || rMag < 1000) return;

        // Compute orbital frame in ECI
        const prograde  = O.vecScale(eci.vel, 1 / vMag);
        const retrograde = O.vecScale(prograde, -1);

        const h = O.vecCross(eci.pos, eci.vel);
        const hMag = O.vecMag(h);
        const normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];
        const antinormal = O.vecScale(normal, -1);

        // Smooth radial direction with EMA to prevent flashing on edge indicators
        var rawRadialOut = O.vecScale(eci.pos, 1 / rMag);
        if (!_smoothedRadialOut) {
            _smoothedRadialOut = rawRadialOut.slice();
        } else {
            var a = _radialSmoothAlpha;
            for (var si = 0; si < 3; si++) {
                _smoothedRadialOut[si] += a * (rawRadialOut[si] - _smoothedRadialOut[si]);
            }
            // Re-normalize
            var sm = O.vecMag(_smoothedRadialOut);
            if (sm > 0.001) _smoothedRadialOut = O.vecScale(_smoothedRadialOut, 1 / sm);
        }
        const radialOut = _smoothedRadialOut;
        const radialIn  = O.vecScale(radialOut, -1);

        // ECI → local ENU conversion setup
        const OMEGA = O.OMEGA_EARTH;
        const gmst = OMEGA * simTime;
        const cosG = Math.cos(-gmst), sinG = Math.sin(-gmst);

        const cosLat = Math.cos(state.lat), sinLat = Math.sin(state.lat);
        const cosLon = Math.cos(state.lon), sinLon = Math.sin(state.lon);

        // ENU basis vectors in ECEF
        const eastECEF  = [-sinLon,             cosLon,              0];
        const northECEF = [-sinLat * cosLon,    -sinLat * sinLon,    cosLat];
        const upECEF    = [ cosLat * cosLon,     cosLat * sinLon,    sinLat];

        function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

        function eciDirToENU(d) {
            // ECI → ECEF (rotate by -gmst around Z)
            const ecef = [
                cosG * d[0] - sinG * d[1],
                sinG * d[0] + cosG * d[1],
                d[2]
            ];
            // ECEF → ENU
            return [dot3(ecef, eastECEF), dot3(ecef, northECEF), dot3(ecef, upECEF)];
        }

        function markerPos(dirECI) {
            const enu = eciDirToENU(dirECI);
            const brg  = Math.atan2(enu[0], enu[1]);  // bearing from north
            const horiz = Math.sqrt(enu[0]*enu[0] + enu[1]*enu[1]);
            const elev  = Math.atan2(enu[2], horiz);  // elevation angle

            // Relative to vehicle nose heading
            const noseHdg = state.heading + (state.yawOffset || 0);
            let relBrg = brg - noseHdg;
            if (relBrg >  Math.PI) relBrg -= 2 * Math.PI;
            if (relBrg < -Math.PI) relBrg += 2 * Math.PI;

            const relBrgDeg = relBrg * RAD;
            const elevDeg   = elev * RAD;

            // Check if behind the camera (>90° off-axis)
            const behind = Math.abs(relBrgDeg) > 90 || Math.abs(elevDeg - pitchDeg) > 90;

            // Pitch ladder coordinates
            return {
                x: relBrgDeg * pxPerDeg,
                y: -(elevDeg - pitchDeg) * pxPerDeg,
                visible: Math.abs(relBrgDeg) < 18 && Math.abs(elevDeg - pitchDeg) < 22,
                relBrgDeg: relBrgDeg,
                relElevDeg: elevDeg - pitchDeg,
                behind: behind
            };
        }

        // Set up same coordinate system as pitch ladder
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-state.roll);
        ctx.beginPath();
        ctx.rect(-150 * scale, -180 * scale, 300 * scale, 360 * scale);
        ctx.clip();

        const markers = [
            { dir: prograde,    color: '#00ff00', type: 'prograde',    label: 'PRO' },
            { dir: retrograde,  color: '#ff4444', type: 'retrograde',  label: 'RET' },
            { dir: normal,      color: '#cc44ff', type: 'normal',      label: 'NML' },
            { dir: antinormal,  color: '#cc44ff', type: 'antinormal',  label: 'A-N' },
            { dir: radialOut,   color: '#44ffcc', type: 'radial_out',  label: 'R+' },
            { dir: radialIn,    color: '#44ffcc', type: 'radial_in',   label: 'R-' },
        ];

        // Add maneuver node burn direction if available
        if (typeof SpaceplanePlanner !== 'undefined') {
            var selNode = SpaceplanePlanner.selectedNode;
            if (selNode) {
                var burnDir = SpaceplanePlanner.getBurnDirectionECI(selNode);
                if (burnDir) {
                    markers.push({ dir: burnDir, color: '#ff8800', type: 'maneuver', label: 'MNV' });
                }
            }
        }

        var edgeMarkers = [];
        for (const m of markers) {
            const pos = markerPos(m.dir);
            if (pos.visible) {
                drawMarkerSymbol(pos.x, pos.y, scale, m.color, m.type, m.label);
            } else {
                edgeMarkers.push({ pos: pos, color: m.color, type: m.type, label: m.label });
            }
        }

        ctx.restore();

        // Draw edge-of-screen indicators for off-screen markers (unclipped)
        if (edgeMarkers.length > 0) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(-state.roll);

            var edgeW = 140 * scale; // half-width margin from center
            var edgeH = 160 * scale; // half-height margin from center
            var margin = 30 * scale;

            for (var ei = 0; ei < edgeMarkers.length; ei++) {
                var em = edgeMarkers[ei];
                var brgD = em.pos.relBrgDeg;
                var elvD = em.pos.relElevDeg;

                // Direction vector from center (in pitch-ladder space)
                var dx = brgD;
                var dy = -elvD; // y flipped (up is negative on canvas)

                // Skip degenerate
                if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) continue;

                // Compute edge-clamped position by ray-rect intersection
                var ex, ey;
                var aDx = Math.abs(dx), aDy = Math.abs(dy);

                if (aDx < 0.01) {
                    // Straight up or down
                    ex = 0;
                    ey = dy > 0 ? edgeH : -edgeH;
                } else if (aDy < 0.01) {
                    // Straight left or right
                    ex = dx > 0 ? edgeW : -edgeW;
                    ey = 0;
                } else {
                    // Ray intersection with rectangle
                    var tX = edgeW / aDx;
                    var tY = edgeH / aDy;
                    var t = Math.min(tX, tY);
                    ex = dx * t;
                    ey = dy * t;
                }

                // Clamp within bounds
                ex = Math.max(-edgeW, Math.min(edgeW, ex));
                ey = Math.max(-edgeH, Math.min(edgeH, ey));

                // Draw semi-transparent marker at edge
                ctx.globalAlpha = 0.35;
                drawMarkerSymbol(ex, ey, scale * 0.5, em.color, em.type, em.label);
                ctx.globalAlpha = 1.0;

                // Draw chevron pointing toward actual direction
                var chevLen = 8 * scale;
                var angle = Math.atan2(dy, dx);
                var cx2 = ex + Math.cos(angle) * (12 * scale);
                var cy2 = ey + Math.sin(angle) * (12 * scale);

                ctx.strokeStyle = em.color;
                ctx.lineWidth = 1.5 * scale;
                ctx.globalAlpha = 0.5;
                ctx.beginPath();
                ctx.moveTo(cx2 - Math.cos(angle - 0.5) * chevLen,
                           cy2 - Math.sin(angle - 0.5) * chevLen);
                ctx.lineTo(cx2, cy2);
                ctx.lineTo(cx2 - Math.cos(angle + 0.5) * chevLen,
                           cy2 - Math.sin(angle + 0.5) * chevLen);
                ctx.stroke();
                ctx.globalAlpha = 1.0;
            }

            ctx.restore();
        }
    }

    /**
     * Draw a single orbital marker symbol
     */
    function drawMarkerSymbol(x, y, scale, color, type, label) {
        const r = 10 * scale;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2 * scale;
        ctx.setLineDash([]);

        switch (type) {
            case 'prograde':
                // Circle with center dot + 3 prongs (up, left, right)
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
                ctx.fill();
                // Top prong
                ctx.beginPath();
                ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 5 * scale);
                ctx.stroke();
                // Left prong
                ctx.beginPath();
                ctx.moveTo(x - r, y); ctx.lineTo(x - r - 5 * scale, y);
                ctx.stroke();
                // Right prong
                ctx.beginPath();
                ctx.moveTo(x + r, y); ctx.lineTo(x + r + 5 * scale, y);
                ctx.stroke();
                break;

            case 'retrograde':
                // Circle with X inside + 3 prongs (down, left, right)
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.stroke();
                const d = r * 0.65;
                ctx.beginPath();
                ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
                ctx.stroke();
                // Bottom prong
                ctx.beginPath();
                ctx.moveTo(x, y + r); ctx.lineTo(x, y + r + 5 * scale);
                ctx.stroke();
                // Left prong
                ctx.beginPath();
                ctx.moveTo(x - r, y); ctx.lineTo(x - r - 5 * scale, y);
                ctx.stroke();
                // Right prong
                ctx.beginPath();
                ctx.moveTo(x + r, y); ctx.lineTo(x + r + 5 * scale, y);
                ctx.stroke();
                break;

            case 'normal':
                // Triangle pointing up
                ctx.beginPath();
                ctx.moveTo(x, y - r);
                ctx.lineTo(x - r * 0.85, y + r * 0.5);
                ctx.lineTo(x + r * 0.85, y + r * 0.5);
                ctx.closePath();
                ctx.stroke();
                break;

            case 'antinormal':
                // Triangle pointing down
                ctx.beginPath();
                ctx.moveTo(x, y + r);
                ctx.lineTo(x - r * 0.85, y - r * 0.5);
                ctx.lineTo(x + r * 0.85, y - r * 0.5);
                ctx.closePath();
                ctx.stroke();
                break;

            case 'radial_out':
                // Circle with dot + top line
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(x, y - r); ctx.lineTo(x, y - r - 5 * scale);
                ctx.stroke();
                break;

            case 'radial_in':
                // Circle with X inside
                ctx.beginPath();
                ctx.arc(x, y, r, 0, Math.PI * 2);
                ctx.stroke();
                const di = r * 0.5;
                ctx.beginPath();
                ctx.moveTo(x - di, y - di); ctx.lineTo(x + di, y + di);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x + di, y - di); ctx.lineTo(x - di, y + di);
                ctx.stroke();
                break;

            case 'maneuver':
                // Filled diamond for burn direction
                ctx.beginPath();
                ctx.moveTo(x, y - r);
                ctx.lineTo(x + r * 0.7, y);
                ctx.lineTo(x, y + r);
                ctx.lineTo(x - r * 0.7, y);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                break;
        }

        // Label
        ctx.font = `${9 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = color;
        ctx.fillText(label, x, y + r + 4 * scale);
        ctx.textBaseline = 'middle'; // reset
    }

    // -----------------------------------------------------------------
    // Minimap radar scope (PPI display showing nearby entities)
    // -----------------------------------------------------------------
    function drawMinimap(state, scale) {
        if (!state._nearby || state._nearby.length === 0) return;

        var r = 60 * scale;        // scope radius
        var cx0 = width - 80 * scale;
        var cy0 = 180 * scale;
        var rangeM = 200000;        // 200 km display range

        // Background circle
        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = '#001100';
        ctx.beginPath();
        ctx.arc(cx0, cy0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Range rings
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 0.5 * scale;
        for (var i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.arc(cx0, cy0, r * i / 3, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Cross hairs
        ctx.beginPath();
        ctx.moveTo(cx0 - r, cy0); ctx.lineTo(cx0 + r, cy0);
        ctx.moveTo(cx0, cy0 - r); ctx.lineTo(cx0, cy0 + r);
        ctx.stroke();

        // Border
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.arc(cx0, cy0, r, 0, Math.PI * 2);
        ctx.stroke();

        // Heading line (nose direction)
        var hdg = state.heading + (state.yawOffset || 0);

        // Clip to scope
        ctx.beginPath();
        ctx.arc(cx0, cy0, r - 1, 0, Math.PI * 2);
        ctx.clip();

        // Plot entities
        var pLat = state.lat;
        var pLon = state.lon;
        var cosLat = Math.cos(pLat);
        var entities = state._nearby;
        for (var j = 0; j < entities.length; j++) {
            var e = entities[j];
            // Approximate relative position in meters (flat Earth near player)
            var dN = (e.lat - pLat) * 6371000;
            var dE = (e.lon - pLon) * 6371000 * cosLat;
            // Rotate to heading-up
            var sinH = Math.sin(-hdg), cosH = Math.cos(-hdg);
            var rx = dE * cosH - dN * sinH;
            var ry = -(dN * cosH + dE * sinH); // Y-up on screen = north, negate for canvas Y-down
            var dist = Math.sqrt(rx * rx + ry * ry);
            if (dist > rangeM) continue;

            var px = cx0 + (rx / rangeM) * r;
            var py = cy0 + (ry / rangeM) * r;

            // Color by team
            ctx.fillStyle = e.team === 'blue' ? '#4488ff' :
                            e.team === 'red' ? '#ff4444' : HUD_DIM;
            ctx.beginPath();
            ctx.arc(px, py, 2.5 * scale, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();

        // Labels
        ctx.font = `${9 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('200km', cx0, cy0 + r + 10 * scale);
    }

    // -----------------------------------------------------------------
    // Lat/Lon/Alt coordinates readout
    // -----------------------------------------------------------------
    function drawCoordinates(state, scale) {
        var latDeg = state.lat * RAD;
        var lonDeg = state.lon * RAD;
        var altKm = state.alt / 1000;

        var latStr = Math.abs(latDeg).toFixed(3) + '\u00b0' + (latDeg >= 0 ? 'N' : 'S');
        var lonStr = Math.abs(lonDeg).toFixed(3) + '\u00b0' + (lonDeg >= 0 ? 'E' : 'W');
        var altStr = altKm >= 100 ? altKm.toFixed(0) + ' km' :
                     altKm >= 1 ? altKm.toFixed(1) + ' km' :
                     (state.alt).toFixed(0) + ' m';

        var x = 20 * scale;
        var y = height - 30 * scale;

        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText(latStr + '  ' + lonStr + '  ' + altStr, x, y);
    }

    // -----------------------------------------------------------------
    // Time warp indicator (shown when warp != 1x)
    // -----------------------------------------------------------------
    function drawTimeWarp(state, scale) {
        var warp = state._timeWarp;
        if (!warp || warp === 1) return;

        var x = cx;
        var y = 25 * scale;

        // Pulsing alpha at high warp
        var alpha = 1.0;
        if (warp >= 64) {
            alpha = 0.6 + 0.4 * Math.abs(Math.sin(Date.now() / 300));
        }

        ctx.save();
        ctx.globalAlpha = alpha;

        // Background pill
        var text = '\u25b6\u25b6 ' + warp + 'x';
        ctx.font = `bold ${16 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        var tw = ctx.measureText(text).width + 16 * scale;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        var pillH = 22 * scale;
        var px0 = x - tw / 2, py0 = y - pillH / 2, pr = 4 * scale;
        ctx.beginPath();
        ctx.moveTo(px0 + pr, py0);
        ctx.lineTo(px0 + tw - pr, py0);
        ctx.arcTo(px0 + tw, py0, px0 + tw, py0 + pr, pr);
        ctx.lineTo(px0 + tw, py0 + pillH - pr);
        ctx.arcTo(px0 + tw, py0 + pillH, px0 + tw - pr, py0 + pillH, pr);
        ctx.lineTo(px0 + pr, py0 + pillH);
        ctx.arcTo(px0, py0 + pillH, px0, py0 + pillH - pr, pr);
        ctx.lineTo(px0, py0 + pr);
        ctx.arcTo(px0, py0, px0 + pr, py0, pr);
        ctx.closePath();
        ctx.fill();

        // Text
        ctx.fillStyle = warp >= 64 ? HUD_WARN : warp >= 8 ? HUD_CYAN : HUD_GREEN;
        ctx.fillText(text, x, y);

        ctx.restore();
    }

    // -----------------------------------------------------------------
    // Approach / landing aids (glideslope + runway heading cue)
    // -----------------------------------------------------------------
    function drawApproachAids(state, scale) {
        // Only show below 3000m AGL and gear-appropriate speed
        if (!state || state.alt > 3000 || state.alt < 5) return;
        var spdKts = state.speed * MPS_TO_KNOTS;
        if (spdKts > 350) return; // too fast for approach

        // Glideslope reference: -3° flight path angle
        var targetGamma = -3.0;
        var gammaErr = (state.gamma * RAD) - targetGamma; // + means above glideslope

        // Draw glideslope diamond (right side, near altitude tape)
        var gsX = width - 55 * scale;
        var gsY = cy;
        var gsScale = 4 * scale; // pixels per degree error
        var diamondY = gsY - gammaErr * gsScale * 8;
        // Clamp diamond to visible range
        diamondY = Math.max(gsY - 80 * scale, Math.min(gsY + 80 * scale, diamondY));

        // Glideslope scale markings
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 1 * scale;
        for (var i = -2; i <= 2; i++) {
            var dotY = gsY - i * 20 * scale;
            if (i === 0) {
                // Center reference line
                ctx.beginPath();
                ctx.moveTo(gsX - 6 * scale, dotY);
                ctx.lineTo(gsX + 6 * scale, dotY);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(gsX, dotY, 2 * scale, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        // Glideslope diamond
        var onGS = Math.abs(gammaErr) < 0.5;
        ctx.strokeStyle = onGS ? HUD_GREEN : Math.abs(gammaErr) > 2 ? HUD_ALERT : HUD_WARN;
        ctx.lineWidth = 2 * scale;
        var ds = 6 * scale;
        ctx.beginPath();
        ctx.moveTo(gsX, diamondY - ds);
        ctx.lineTo(gsX + ds, diamondY);
        ctx.lineTo(gsX, diamondY + ds);
        ctx.lineTo(gsX - ds, diamondY);
        ctx.closePath();
        ctx.stroke();

        // Altitude / distance readout
        var altFt = state.alt * M_TO_FT;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'right';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('AGL ' + Math.round(altFt) + ' ft', gsX + 30 * scale, gsY + 95 * scale);

        // Speed advisory
        var tgtSpd = spdKts > 200 ? 'FAST' : spdKts < 130 ? 'SLOW' : 'ON SPD';
        var spdColor = spdKts > 200 ? HUD_WARN : spdKts < 130 ? HUD_ALERT : HUD_GREEN;
        ctx.fillStyle = spdColor;
        ctx.textAlign = 'center';
        ctx.fillText(tgtSpd, gsX, gsY + 110 * scale);
    }

    /**
     * Set a HUD element toggle.
     * @param {string} key - toggle name (hud, speedTape, altTape, heading, pitchLadder, fpm, gMeter, engineFuel, weapons, warnings, orbital)
     * @param {boolean} value - true to show, false to hide
     */
    function setToggle(key, value) {
        if (key in _toggles) _toggles[key] = !!value;
    }

    /** Get current toggle states (copy). */
    function getToggles() {
        return Object.assign({}, _toggles);
    }

    // Public API
    return {
        init,
        resize,
        render,
        toggles: _toggles,
        setToggle,
        getToggles,
    };
})();
