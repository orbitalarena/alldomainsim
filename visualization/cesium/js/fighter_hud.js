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
        rwr: true,          // Radar Warning Receiver diamond display
        radar: true,        // B-scope radar display + target designation bracket
        coordinates: true,  // Lat/lon/alt readout
        warpIndicator: true,// Time warp indicator
        approachAids: true, // Landing approach aids
        weather: true       // Weather info (wind, visibility, turbulence)
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
        if (_toggles.warnings)    drawWindIndicator(state, scale);
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
        if (_toggles.warnings)    drawCyberWarnings(state, scale);
        if (_toggles.warnings)    drawPhaseIndicator(state, scale);
        if (_toggles.speedTape)   drawMachIndicator(state, scale);
        if (_toggles.altTape)     drawVerticalSpeed(state, scale);
        if (_toggles.warnings)    drawRegimeIndicator(state, scale);
        if (_toggles.warnings)    drawPointingIndicator(state, scale);
        if (_toggles.warnings)    drawDisplayModeIndicator(state, scale);
        if (_toggles.orbital)     drawCompactNavball(state, scale, simTime);
        if (_toggles.minimap)     drawMinimap(state, scale);
        if (_toggles.rwr)        drawRWR(state, scale);
        if (_toggles.radar)      drawRadarScope(state, scale, simTime);
        if (_toggles.radar)      drawTargetBracket(state, scale, simTime);
        if (_toggles.coordinates) drawCoordinates(state, scale);
        if (_toggles.warpIndicator) drawTimeWarp(state, scale);
        if (_toggles.approachAids) drawApproachAids(state, scale);
        if (_toggles.approachAids) drawILSGuidance(state, scale);
        if (_toggles.weather)     drawWeatherInfo(state, scale, simTime);
        drawWaypointCue(state, scale);
        drawSensorReticle(state, scale);
        drawMissileWarning(state, scale);
        drawFormationStatus(state, scale);
        if (_toggles.warnings)    drawTCAS(state, scale);
        if (_toggles.warnings)    drawGPWS(state, scale);
        if (_toggles.warnings)    drawTerrainProfile(state, scale);

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
     * Draw wind direction/speed indicator below the heading tape.
     * Shows wind barb arrow, WIND readout, headwind/tailwind and crosswind
     * components, and turbulence warning for strong winds.
     * Data source: state._wind = { direction_deg, speed_mps }
     */
    function drawWindIndicator(state, scale) {
        var wind = state._wind;
        if (!wind || wind.speed_mps == null || wind.speed_mps < 0.1) return;

        var windDirDeg = ((wind.direction_deg || 0) + 360) % 360;
        var windSpdMps = wind.speed_mps;
        var windSpdKts = windSpdMps * MPS_TO_KNOTS;

        // Heading tape center Y (must match drawHeadingTape)
        var headingTapeY = 50 * scale;
        // Position below heading readout and target bearing line
        var baseY = headingTapeY + 55 * scale;

        var isStrong = windSpdKts > 30;
        var normalColor = HUD_GREEN;
        var warnColor = HUD_WARN;

        ctx.save();

        // --- Wind arrow/barb ---
        // Arrow shows direction wind is coming FROM, relative to screen up=north
        // Position it to the left of center text block
        var arrowCx = cx - 80 * scale;
        var arrowCy = baseY + 8 * scale;
        var arrowLen = 14 * scale;
        // Meteorological: direction_deg is where wind comes FROM (0=N, 90=E)
        // Arrow points FROM that direction toward center (i.e., into the wind)
        // We draw the arrow shaft pointing in the wind-from direction (screen coords)
        var windFromRad = windDirDeg * DEG;  // radians, 0=up on screen
        // Tip of the arrow (the "from" end) is at the outer end
        var tipX = arrowCx + arrowLen * Math.sin(windFromRad);
        var tipY = arrowCy - arrowLen * Math.cos(windFromRad);
        // Tail toward center
        var tailX = arrowCx - arrowLen * Math.sin(windFromRad);
        var tailY = arrowCy + arrowLen * Math.cos(windFromRad);

        ctx.strokeStyle = isStrong ? warnColor : normalColor;
        ctx.lineWidth = 2 * scale;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        // Arrowhead at tip (wind-from end)
        var headLen = 5 * scale;
        var headAngle = 0.45; // ~25 degrees
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
            tipX - headLen * Math.sin(windFromRad - headAngle),
            tipY + headLen * Math.cos(windFromRad - headAngle)
        );
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
            tipX - headLen * Math.sin(windFromRad + headAngle),
            tipY + headLen * Math.cos(windFromRad + headAngle)
        );
        ctx.stroke();

        // --- Wind readout text: "WIND 270/25" ---
        ctx.font = `${12 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = isStrong ? warnColor : normalColor;
        var dirStr = Math.round(windDirDeg).toString().padStart(3, '0');
        var spdStr = Math.round(windSpdKts).toString();
        ctx.fillText('WIND ' + dirStr + '/' + spdStr, cx, baseY);

        // --- Headwind/tailwind and crosswind components ---
        // Aircraft nose heading (use nose heading = heading + yawOffset)
        var noseHdg = (state.heading || 0) + (state.yawOffset || 0);
        // Relative wind angle: wind FROM direction minus aircraft heading
        // Positive = wind from right of nose
        var relWindRad = (windDirDeg * DEG) - noseHdg;
        // Headwind component: positive = headwind (wind opposing motion)
        var headwindMps = windSpdMps * Math.cos(relWindRad);
        var crosswindMps = windSpdMps * Math.sin(relWindRad);

        var headwindKts = Math.abs(headwindMps * MPS_TO_KNOTS);
        var crosswindKts = Math.abs(crosswindMps * MPS_TO_KNOTS);

        var compY = baseY + 15 * scale;
        ctx.font = `${11 * scale}px 'Courier New', monospace`;

        // Headwind/tailwind readout
        var hwLabel;
        if (headwindMps > 0.5) {
            hwLabel = 'HW ' + Math.round(headwindKts) + 'KT';
        } else if (headwindMps < -0.5) {
            hwLabel = 'TW ' + Math.round(headwindKts) + 'KT';
        } else {
            hwLabel = 'HW 0KT';
        }

        // Crosswind readout
        var xwLabel;
        if (crosswindMps > 0.5) {
            xwLabel = 'XW R' + Math.round(crosswindKts) + 'KT';
        } else if (crosswindMps < -0.5) {
            xwLabel = 'XW L' + Math.round(crosswindKts) + 'KT';
        } else {
            xwLabel = 'XW 0KT';
        }

        ctx.fillStyle = isStrong ? warnColor : normalColor;
        ctx.textAlign = 'center';
        ctx.fillText(hwLabel + '  ' + xwLabel, cx, compY);

        // --- Turbulence warning for strong winds ---
        if (isStrong) {
            ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
            ctx.fillStyle = warnColor;
            ctx.fillText('TURB', cx, compY + 15 * scale);
        }

        ctx.restore();
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

                // Range estimation (distance at current speed before fuel exhaustion)
                if (state.speed > 10) {
                    var rangeM = timeRemSec * state.speed;
                    var rangeNm = rangeM / 1852;
                    var rangeStr = rangeNm >= 1000 ? Math.round(rangeNm) + ' NM' :
                                   rangeNm >= 100 ? Math.round(rangeNm) + ' NM' :
                                   rangeNm.toFixed(0) + ' NM';
                    ctx.fillStyle = rangeNm < 50 ? HUD_ALERT : rangeNm < 150 ? HUD_WARN : HUD_DIM;
                    ctx.fillText('RNG ' + rangeStr, x, y + 57 * scale);
                }
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
     * Draw cyber attack warning indicators
     * Shows system compromise status, screen noise, and border flash
     */
    function drawCyberWarnings(state, scale) {
        if (!state) return;

        // Check if any cyber flag is set
        var hasCyber = state._sensorDisabled || state._weaponsDisabled ||
            state._navigationHijacked || state._commsDisabled ||
            state._fullControl || state._computerCompromised ||
            state._cyberScanning || state._cyberExploited ||
            state._cyberControlled;

        if (!hasCyber) return;

        var now = Date.now();

        // --- 1. Red border flash (pulsing) ---
        var borderAlpha = 0.3 + 0.3 * Math.sin(now * 0.006);
        ctx.save();
        ctx.strokeStyle = HUD_ALERT;
        ctx.lineWidth = 3 * scale;
        ctx.globalAlpha = borderAlpha;
        // Top
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(width, 0);
        ctx.stroke();
        // Bottom
        ctx.beginPath();
        ctx.moveTo(0, height);
        ctx.lineTo(width, height);
        ctx.stroke();
        // Left
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, height);
        ctx.stroke();
        // Right
        ctx.beginPath();
        ctx.moveTo(width, 0);
        ctx.lineTo(width, height);
        ctx.stroke();
        ctx.globalAlpha = 1.0;
        ctx.restore();

        // --- 2. Screen noise/static when full control is lost ---
        if (state._fullControl || state._cyberControlled) {
            ctx.save();
            ctx.globalAlpha = 0.15;
            var noiseCount = Math.floor(width * height * 0.10 / 16); // ~10% coverage in 4x4 blocks
            for (var ni = 0; ni < noiseCount; ni++) {
                var nx = Math.random() * width;
                var ny = Math.random() * height;
                var brightness = Math.floor(Math.random() * 256);
                ctx.fillStyle = 'rgb(' + brightness + ',' + brightness + ',' + brightness + ')';
                ctx.fillRect(nx, ny, 4 * scale, 4 * scale);
            }
            ctx.globalAlpha = 1.0;
            ctx.restore();
        }

        // --- 3. Main cyber status box (below heading tape) ---
        var boxY = 85 * scale;
        var boxW = 260 * scale;
        var boxH = 28 * scale;
        var boxX = cx - boxW / 2;

        // Determine severity for box color
        var isCritical = state._fullControl || state._cyberControlled;
        var isExploited = state._cyberExploited || state._computerCompromised;

        // Background box
        ctx.save();
        if (isCritical) {
            ctx.fillStyle = 'rgba(255, 0, 0, ' + (0.4 + 0.2 * Math.sin(now * 0.01)) + ')';
        } else if (isExploited || state._sensorDisabled || state._weaponsDisabled || state._navigationHijacked) {
            ctx.fillStyle = 'rgba(255, 0, 0, 0.25)';
        } else {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.15)';
        }
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = isCritical ? HUD_ALERT : HUD_WARN;
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeRect(boxX, boxY, boxW, boxH);

        // Header text
        ctx.font = 'bold ' + (14 * scale) + 'px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (isCritical) {
            ctx.fillStyle = HUD_ALERT;
            ctx.fillText('CYBER ATTACK - COMPROMISED', cx, boxY + boxH / 2);
        } else if (isExploited) {
            ctx.fillStyle = HUD_ALERT;
            ctx.fillText('CYBER ATTACK - INTRUSION', cx, boxY + boxH / 2);
        } else {
            ctx.fillStyle = HUD_WARN;
            ctx.fillText('CYBER WARNING', cx, boxY + boxH / 2);
        }
        ctx.restore();

        // --- 4. Individual system warnings (stacked below the box) ---
        var warnings = [];

        if (state._fullControl || state._cyberControlled) {
            warnings.push({ text: 'FULL COMPROMISE', color: HUD_ALERT, blink: 'fast' });
        }
        if (state._sensorDisabled) {
            warnings.push({ text: 'SENSORS DISABLED', color: HUD_ALERT, blink: 'normal' });
        }
        if (state._navigationHijacked) {
            warnings.push({ text: 'NAV HIJACKED', color: HUD_ALERT, blink: 'normal' });
        }
        if (state._weaponsDisabled) {
            warnings.push({ text: 'WEAPONS OFFLINE', color: HUD_ALERT, blink: 'normal' });
        }
        if (state._commsDisabled) {
            warnings.push({ text: 'COMMS DOWN', color: HUD_WARN, blink: 'none' });
        }
        if (state._cyberExploited && !state._fullControl && !state._cyberControlled) {
            warnings.push({ text: 'CYBER INTRUSION', color: HUD_WARN, blink: 'normal' });
        }
        if (state._computerCompromised && !state._fullControl && !state._cyberControlled) {
            warnings.push({ text: 'COMPUTER COMPROMISED', color: HUD_WARN, blink: 'normal' });
        }
        if (state._cyberScanning) {
            warnings.push({ text: 'SCANNING DETECTED', color: '#aaaa00', blink: 'none' });
        }

        ctx.save();
        ctx.font = 'bold ' + (13 * scale) + 'px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        var warnStartY = boxY + boxH + 8 * scale;

        for (var wi = 0; wi < warnings.length; wi++) {
            var w = warnings[wi];
            var wy = warnStartY + wi * 20 * scale;

            // Determine visibility based on blink mode
            var visible = true;
            if (w.blink === 'fast') {
                // Fast blink: 200ms on, 200ms off
                visible = (now % 400) < 200;
            } else if (w.blink === 'normal') {
                // Normal blink: 500ms on, 500ms off
                visible = (now % 1000) < 500;
            }
            // 'none' is always visible

            if (visible) {
                // Dark background stripe for readability
                var tw = ctx.measureText(w.text).width + 12 * scale;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
                ctx.fillRect(cx - tw / 2, wy - 8 * scale, tw, 16 * scale);

                ctx.fillStyle = w.color;
                ctx.fillText(w.text, cx, wy);
            }
        }
        ctx.restore();
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
     * Draw display mode indicator (NVG / FLIR) at top-left
     */
    function drawDisplayModeIndicator(state, scale) {
        if (!state || !state._displayMode) return;

        var label = state._displayMode;  // 'NVG' or 'FLIR'
        var x = 20 * scale;
        var y = 80 * scale;  // Below phase indicator area

        ctx.font = `bold ${13 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';

        if (label === 'NVG') {
            ctx.fillStyle = '#00ff44';  // Bright green for NVG
        } else if (label === 'FLIR') {
            ctx.fillStyle = '#ffffff';  // White for FLIR
        } else {
            ctx.fillStyle = HUD_GREEN;
        }

        // Background box for readability
        var tw = ctx.measureText(label).width + 10 * scale;
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(x - 4 * scale, y - 10 * scale, tw, 16 * scale);
        ctx.restore();

        // Draw the label
        if (label === 'NVG') {
            ctx.fillStyle = '#00ff44';
        } else if (label === 'FLIR') {
            ctx.fillStyle = '#ffffff';
        } else {
            ctx.fillStyle = HUD_GREEN;
        }
        ctx.fillText(label, x, y);
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
    // Radar Warning Receiver (RWR) diamond display
    // Shows bearing/range of detected radar emitters relative to ownship
    // Data: state._rwr or state._detectedBy — array of {bearing, type, range_norm, label}
    //   bearing: degrees clockwise from nose (0 = ahead, 90 = right, 180 = behind)
    //   type: 'search' | 'track' | 'lock'
    //   range_norm: 0-1 normalized (0 = closest, 1 = at max detection range)
    //   label: emitter name (e.g. 'SA-20', 'MIG-29')
    // -----------------------------------------------------------------
    var _rwrFlashPhase = 0; // for lock warning border flash

    function drawRWR(state, scale) {
        // Get RWR threat data from state
        var threats = state._rwr || state._detectedBy;
        if (!threats && !state._radarContacts) {
            // Even with no threats, draw the empty scope
        }

        var size = 60 * scale;           // half-width of diamond (120px effective at scale=1)
        var rwrCx = 110 * scale;         // center X (bottom-left area)
        var rwrCy = height - 200 * scale; // center Y (above G-meter)

        // Check for any lock threats (for border flash)
        var hasLock = false;
        if (threats) {
            for (var ti = 0; ti < threats.length; ti++) {
                if (threats[ti].type === 'lock') { hasLock = true; break; }
            }
        }

        // Update flash phase
        _rwrFlashPhase += 0.15;

        ctx.save();

        // --- Background diamond (rotated 45-degree square) ---
        ctx.fillStyle = 'rgba(0, 10, 0, 0.45)';
        ctx.beginPath();
        ctx.moveTo(rwrCx, rwrCy - size);          // top
        ctx.lineTo(rwrCx + size, rwrCy);           // right
        ctx.lineTo(rwrCx, rwrCy + size);           // bottom
        ctx.lineTo(rwrCx - size, rwrCy);           // left
        ctx.closePath();
        ctx.fill();

        // Border — red flash when lock, green otherwise
        if (hasLock && Math.sin(_rwrFlashPhase * 4) > 0) {
            ctx.strokeStyle = HUD_ALERT;
            ctx.lineWidth = 3 * scale;
        } else {
            ctx.strokeStyle = HUD_GREEN;
            ctx.lineWidth = 1.5 * scale;
        }
        ctx.beginPath();
        ctx.moveTo(rwrCx, rwrCy - size);
        ctx.lineTo(rwrCx + size, rwrCy);
        ctx.lineTo(rwrCx, rwrCy + size);
        ctx.lineTo(rwrCx - size, rwrCy);
        ctx.closePath();
        ctx.stroke();

        // --- Range rings at 50% and 100% inside the diamond ---
        // Clip to diamond shape for clean rings
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(rwrCx, rwrCy - size);
        ctx.lineTo(rwrCx + size, rwrCy);
        ctx.lineTo(rwrCx, rwrCy + size);
        ctx.lineTo(rwrCx - size, rwrCy);
        ctx.closePath();
        ctx.clip();

        ctx.strokeStyle = 'rgba(0, 170, 0, 0.3)';
        ctx.lineWidth = 0.8 * scale;

        // 50% range ring
        ctx.beginPath();
        ctx.arc(rwrCx, rwrCy, size * 0.5, 0, Math.PI * 2);
        ctx.stroke();

        // 100% range ring (inscribed circle of diamond)
        // The inscribed circle of a square rotated 45deg with half-diagonal=size
        // has radius = size * cos(45) = size * 0.707
        ctx.beginPath();
        ctx.arc(rwrCx, rwrCy, size * 0.707, 0, Math.PI * 2);
        ctx.stroke();

        // Cross hairs (N/S/E/W lines)
        ctx.strokeStyle = 'rgba(0, 170, 0, 0.2)';
        ctx.lineWidth = 0.5 * scale;
        ctx.beginPath();
        ctx.moveTo(rwrCx - size, rwrCy);
        ctx.lineTo(rwrCx + size, rwrCy);
        ctx.moveTo(rwrCx, rwrCy - size);
        ctx.lineTo(rwrCx, rwrCy + size);
        ctx.stroke();

        // --- Cardinal direction labels ---
        ctx.font = `${8 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0, 170, 0, 0.5)';
        ctx.fillText('12', rwrCx, rwrCy - size * 0.82);
        ctx.fillText('6', rwrCx, rwrCy + size * 0.82);
        ctx.fillText('3', rwrCx + size * 0.82, rwrCy);
        ctx.fillText('9', rwrCx - size * 0.82, rwrCy);

        // --- Center ownship marker (small triangle pointing up) ---
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        var ownR = 5 * scale;
        ctx.beginPath();
        ctx.moveTo(rwrCx, rwrCy - ownR);
        ctx.lineTo(rwrCx + ownR * 0.7, rwrCy + ownR * 0.5);
        ctx.lineTo(rwrCx - ownR * 0.7, rwrCy + ownR * 0.5);
        ctx.closePath();
        ctx.stroke();

        // --- Plot threats ---
        if (threats && threats.length > 0) {
            for (var i = 0; i < threats.length; i++) {
                var t = threats[i];
                var brgDeg = t.bearing || 0;    // degrees from nose, clockwise
                var rangeN = t.range_norm != null ? t.range_norm : 0.7; // default 70% out
                var tType = t.type || 'search';
                var label = t.label || '';

                // Convert bearing to canvas angle (0=up, CW positive)
                // Canvas: 0 rad = right, so bearing 0 (ahead/up) = -PI/2
                var brgRad = brgDeg * DEG;

                // Position within diamond: use range_norm to scale distance from center
                // Max usable radius inside diamond varies with angle.
                // For a diamond, the max radius at angle theta from top is:
                //   r_max = size / max(|cos(theta)| + |sin(theta)|)  — L1 norm
                // But simpler: just scale by size and clamp to diamond boundary
                var dx = Math.sin(brgRad);  // right is positive
                var dy = -Math.cos(brgRad); // up is negative in canvas

                // Diamond boundary distance at this angle: size / (|dx| + |dy|) per unit
                // L1 distance of unit vector (dx,dy) from origin to diamond edge
                var l1 = Math.abs(dx) + Math.abs(dy);
                if (l1 < 0.001) l1 = 1;
                var maxDist = size / l1;

                var dist = rangeN * maxDist * 0.9; // 0.9 to keep symbols inside
                var tx = rwrCx + dx * dist;
                var ty = rwrCy + dy * dist;

                // --- Draw threat symbol ---
                var symbolSize = 5 * scale;

                if (tType === 'lock') {
                    // Filled diamond — red, flashing
                    var lockAlpha = 0.6 + 0.4 * Math.abs(Math.sin(_rwrFlashPhase * 3));
                    ctx.globalAlpha = lockAlpha;
                    ctx.fillStyle = HUD_ALERT;
                    ctx.strokeStyle = HUD_ALERT;
                    ctx.lineWidth = 1.5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(tx, ty - symbolSize);
                    ctx.lineTo(tx + symbolSize, ty);
                    ctx.lineTo(tx, ty + symbolSize);
                    ctx.lineTo(tx - symbolSize, ty);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    ctx.globalAlpha = 1.0;
                } else if (tType === 'track') {
                    // Filled diamond — red, solid
                    ctx.fillStyle = HUD_ALERT;
                    ctx.strokeStyle = HUD_ALERT;
                    ctx.lineWidth = 1.5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(tx, ty - symbolSize);
                    ctx.lineTo(tx + symbolSize, ty);
                    ctx.lineTo(tx, ty + symbolSize);
                    ctx.lineTo(tx - symbolSize, ty);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                } else {
                    // Search — open circle, yellow
                    ctx.strokeStyle = HUD_WARN;
                    ctx.lineWidth = 1.5 * scale;
                    ctx.beginPath();
                    ctx.arc(tx, ty, symbolSize, 0, Math.PI * 2);
                    ctx.stroke();
                }

                // --- Bearing line from center toward threat (faint) ---
                ctx.strokeStyle = tType === 'search' ? 'rgba(255,255,0,0.2)' : 'rgba(255,50,50,0.3)';
                ctx.lineWidth = 0.8 * scale;
                ctx.beginPath();
                ctx.moveTo(rwrCx, rwrCy);
                ctx.lineTo(tx, ty);
                ctx.stroke();

                // --- Threat label (short, near symbol) ---
                if (label) {
                    ctx.font = `${7 * scale}px 'Courier New', monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillStyle = tType === 'search' ? HUD_WARN : HUD_ALERT;
                    ctx.fillText(label, tx, ty - symbolSize - 2 * scale);
                }
            }
        }

        ctx.restore(); // undo diamond clip

        // --- RWR label ---
        ctx.font = `${9 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('RWR', rwrCx, rwrCy + size + 4 * scale);
        ctx.textBaseline = 'middle'; // reset

        // --- Lock warning text (flashing, below diamond) ---
        if (hasLock) {
            if (Math.sin(_rwrFlashPhase * 4) > 0) {
                ctx.font = `bold ${11 * scale}px 'Courier New', monospace`;
                ctx.textAlign = 'center';
                ctx.fillStyle = HUD_ALERT;
                ctx.fillText('LOCK', rwrCx, rwrCy + size + 16 * scale);
            }
        }

        // --- Threat count summary ---
        if (threats && threats.length > 0) {
            var nSearch = 0, nTrack = 0, nLock = 0;
            for (var ci = 0; ci < threats.length; ci++) {
                var ct = threats[ci].type || 'search';
                if (ct === 'lock') nLock++;
                else if (ct === 'track') nTrack++;
                else nSearch++;
            }
            ctx.font = `${8 * scale}px 'Courier New', monospace`;
            ctx.textAlign = 'center';
            ctx.fillStyle = HUD_DIM;
            var countStr = '';
            if (nSearch > 0) countStr += 'S:' + nSearch + ' ';
            if (nTrack > 0)  countStr += 'T:' + nTrack + ' ';
            if (nLock > 0)   countStr += 'L:' + nLock;
            if (countStr) {
                ctx.fillText(countStr.trim(), rwrCx, rwrCy - size - 6 * scale);
            }
        }
    }

    // -----------------------------------------------------------------
    // Missile Warning System (MWS) — flashing warning when missiles inbound
    // Data: state._mws — array of {type, bearing, range, label, tof}
    // -----------------------------------------------------------------
    var _mwsFlashPhase = 0;

    function drawMissileWarning(state, scale) {
        var missiles = state._mws;
        if (!missiles || missiles.length === 0) return;

        _mwsFlashPhase += 0.2;
        var flashOn = Math.sin(_mwsFlashPhase * 5) > 0;

        // Large flashing MISSILE warning at top center
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        var warnY = 60 * scale;
        var warnX = cx;

        // Flash red background bar
        if (flashOn) {
            ctx.fillStyle = 'rgba(255, 0, 0, 0.35)';
            var barW = 200 * scale;
            ctx.fillRect(warnX - barW / 2, warnY - 12 * scale, barW, 24 * scale);
        }

        // MISSILE text
        ctx.font = `bold ${16 * scale}px 'Courier New', monospace`;
        ctx.fillStyle = flashOn ? '#ff2222' : '#ff6644';
        ctx.fillText('MISSILE', warnX, warnY);

        // Count and closest
        ctx.font = `${10 * scale}px 'Courier New', monospace`;
        ctx.fillStyle = '#ffaa44';
        var closest = missiles[0];
        for (var i = 1; i < missiles.length; i++) {
            if (missiles[i].range < closest.range) closest = missiles[i];
        }
        var distNm = (closest.range / 1852).toFixed(0);
        var infoStr = missiles.length + ' INBOUND | ' + closest.type + ' ' + distNm + 'NM';
        ctx.fillText(infoStr, warnX, warnY + 14 * scale);

        // Bearing arrows around center for each missile
        var arrowR = 35 * scale;
        var playerHdg = (state.heading || 0) * (180 / Math.PI);
        for (var mi = 0; mi < missiles.length; mi++) {
            var m = missiles[mi];
            // bearing is absolute, convert to relative
            var relBearing = m.bearing - playerHdg;
            var relRad = relBearing * Math.PI / 180;
            // Arrow tip position
            var ax = warnX + Math.sin(relRad) * arrowR;
            var ay = (warnY + 35 * scale) - Math.cos(relRad) * arrowR;

            ctx.beginPath();
            ctx.fillStyle = flashOn ? '#ff0000' : '#ff4400';
            // Draw small triangle pointing inward
            var tipAngle = relRad + Math.PI; // point toward center
            var triSize = 5 * scale;
            ctx.moveTo(ax + Math.sin(tipAngle) * triSize, ay - Math.cos(tipAngle) * triSize);
            ctx.lineTo(ax + Math.sin(tipAngle + 2.3) * triSize * 0.7, ay - Math.cos(tipAngle + 2.3) * triSize * 0.7);
            ctx.lineTo(ax + Math.sin(tipAngle - 2.3) * triSize * 0.7, ay - Math.cos(tipAngle - 2.3) * triSize * 0.7);
            ctx.fill();
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------
    // Formation Status — wingman callsigns, positions, status
    // Data: state._formation — array of {name, bearing, range, altDiff, status, formation}
    // -----------------------------------------------------------------
    function drawFormationStatus(state, scale) {
        var wingmen = state._formation;
        if (!wingmen || wingmen.length === 0) return;

        ctx.save();
        var fmX = width - 145 * scale;
        var fmY = 165 * scale;

        // Header
        ctx.font = `bold ${9 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = HUD_GREEN;
        ctx.fillText('FORMATION', fmX, fmY);
        fmY += 12 * scale;

        ctx.font = `${8 * scale}px 'Courier New', monospace`;

        for (var i = 0; i < wingmen.length && i < 4; i++) {
            var w = wingmen[i];
            // Color by status
            var sColor = HUD_GREEN;
            if (w.status === 'REJOINING') sColor = '#ffaa00';
            if (w.status === 'LOST') sColor = '#ff4444';

            // Callsign and status
            ctx.fillStyle = sColor;
            var nm = (w.range / 1852).toFixed(1);
            var brg = w.bearing.toFixed(0);
            var altFt = (w.altDiff * 3.28084).toFixed(0);
            var altStr = w.altDiff >= 0 ? ('+' + altFt) : altFt;
            ctx.fillText(w.name, fmX, fmY);
            ctx.fillStyle = HUD_DIM;
            ctx.fillText(brg + '\u00B0 ' + nm + 'nm ' + altStr + 'ft', fmX, fmY + 9 * scale);

            // Status badge
            ctx.fillStyle = sColor;
            ctx.textAlign = 'right';
            ctx.fillText(w.status, fmX + 135 * scale, fmY);
            ctx.textAlign = 'left';

            fmY += 22 * scale;
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------
    // B-Scope Radar Display (azimuth vs range)
    // Shows detected entities from state._radarContacts or state._detectedEntities
    // Each contact: { bearing, range, team, id, name }
    //   bearing: degrees relative to player heading (negative=left, positive=right)
    //   range: distance in meters
    // -----------------------------------------------------------------
    var _radarSweepPhase = 0; // sweep line oscillation phase

    function drawRadarScope(state, scale, simTime) {
        var scopeW = 180 * scale;
        var scopeH = 140 * scale;
        var scopeX = width - scopeW - 10 * scale;  // top-right with 10px margin
        var scopeY = 270 * scale;                   // below the minimap

        // Radar FOV half-angle (degrees)
        var azHalf = 60;
        // Max display range (meters) — use radar maxRange or default 200km
        var maxRange = 200000;
        if (state._radarMaxRange) maxRange = state._radarMaxRange;

        // Get contacts
        var contacts = state._radarContacts || state._detectedEntities || [];

        // --- Background ---
        ctx.save();
        ctx.fillStyle = 'rgba(0, 8, 0, 0.55)';
        ctx.fillRect(scopeX, scopeY, scopeW, scopeH);

        // --- Border ---
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        ctx.strokeRect(scopeX, scopeY, scopeW, scopeH);

        // --- Clip to scope area ---
        ctx.save();
        ctx.beginPath();
        ctx.rect(scopeX, scopeY, scopeW, scopeH);
        ctx.clip();

        // --- Range rings at 25%, 50%, 75% ---
        ctx.strokeStyle = 'rgba(0, 170, 0, 0.25)';
        ctx.lineWidth = 0.7 * scale;
        ctx.setLineDash([3 * scale, 3 * scale]);
        for (var ri = 1; ri <= 3; ri++) {
            var ringY = scopeY + scopeH * (1 - ri * 0.25);
            ctx.beginPath();
            ctx.moveTo(scopeX, ringY);
            ctx.lineTo(scopeX + scopeW, ringY);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // --- Center line (0 azimuth) ---
        ctx.strokeStyle = 'rgba(0, 170, 0, 0.3)';
        ctx.lineWidth = 0.5 * scale;
        ctx.beginPath();
        ctx.moveTo(scopeX + scopeW / 2, scopeY);
        ctx.lineTo(scopeX + scopeW / 2, scopeY + scopeH);
        ctx.stroke();

        // --- Scan sweep line (oscillates left-right) ---
        var sweepTime = simTime || (Date.now() / 1000);
        // 3-second full sweep cycle (left → right → left)
        var sweepNorm = Math.sin(sweepTime * 1.047);  // ~3s period (2*PI/6 ≈ 1.047)
        var sweepX = scopeX + scopeW / 2 + sweepNorm * (scopeW / 2 - 4 * scale);

        // Sweep line glow
        var sweepGrad = ctx.createLinearGradient(sweepX - 8 * scale, 0, sweepX + 8 * scale, 0);
        sweepGrad.addColorStop(0, 'rgba(0, 255, 0, 0)');
        sweepGrad.addColorStop(0.5, 'rgba(0, 255, 0, 0.35)');
        sweepGrad.addColorStop(1, 'rgba(0, 255, 0, 0)');
        ctx.fillStyle = sweepGrad;
        ctx.fillRect(sweepX - 8 * scale, scopeY, 16 * scale, scopeH);

        // Sweep line
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)';
        ctx.lineWidth = 1 * scale;
        ctx.beginPath();
        ctx.moveTo(sweepX, scopeY);
        ctx.lineTo(sweepX, scopeY + scopeH);
        ctx.stroke();

        // --- Plot contacts ---
        if (contacts && contacts.length > 0) {
            for (var ci = 0; ci < contacts.length; ci++) {
                var c = contacts[ci];
                var bearing = c.bearing || 0;   // degrees from nose, signed (- = left, + = right)
                var range = c.range || 0;       // meters

                // Skip contacts outside FOV
                if (Math.abs(bearing) > azHalf) continue;
                // Skip contacts beyond max range
                if (range > maxRange || range <= 0) continue;

                // Map bearing to X position: -azHalf → left edge, +azHalf → right edge
                var bx = scopeX + ((bearing + azHalf) / (2 * azHalf)) * scopeW;
                // Map range to Y position: 0 → bottom, maxRange → top
                var by = scopeY + scopeH * (1 - range / maxRange);

                // --- Persistence brightness based on proximity to sweep line ---
                // How far is this blip from the sweep line (in X)?
                var sweepDist = Math.abs(bx - sweepX);
                var maxFade = scopeW * 0.4;  // fade over 40% of scope width
                var brightness = 1.0 - Math.min(sweepDist / maxFade, 1.0);
                brightness = 0.25 + brightness * 0.75;  // min 25% brightness, max 100%

                // Color by team
                var blipR, blipG, blipB;
                if (c.team === 'blue') {
                    blipR = 68; blipG = 136; blipB = 255;   // friendly blue
                } else if (c.team === 'red') {
                    blipR = 255; blipG = 60; blipB = 60;    // hostile red
                } else {
                    blipR = 255; blipG = 255; blipB = 0;    // unknown yellow
                }

                ctx.fillStyle = 'rgba(' + blipR + ',' + blipG + ',' + blipB + ',' + brightness.toFixed(2) + ')';
                ctx.beginPath();
                ctx.arc(bx, by, 3 * scale, 0, Math.PI * 2);
                ctx.fill();

                // Brighter blips near sweep get a glow
                if (brightness > 0.7) {
                    ctx.fillStyle = 'rgba(' + blipR + ',' + blipG + ',' + blipB + ',' + (brightness * 0.3).toFixed(2) + ')';
                    ctx.beginPath();
                    ctx.arc(bx, by, 6 * scale, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        ctx.restore(); // undo clip

        // --- Azimuth labels along bottom edge ---
        ctx.font = (8 * scale) + 'px \'Courier New\', monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('-60', scopeX + 2 * scale, scopeY + scopeH + 2 * scale);
        ctx.fillText('-30', scopeX + scopeW * 0.25, scopeY + scopeH + 2 * scale);
        ctx.fillText('0', scopeX + scopeW * 0.5, scopeY + scopeH + 2 * scale);
        ctx.fillText('30', scopeX + scopeW * 0.75, scopeY + scopeH + 2 * scale);
        ctx.fillText('60', scopeX + scopeW - 2 * scale, scopeY + scopeH + 2 * scale);

        // --- Range labels along left edge ---
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = HUD_DIM;
        var rangeKm = maxRange / 1000;
        ctx.fillText((rangeKm * 0.25).toFixed(0), scopeX - 3 * scale, scopeY + scopeH * 0.75);
        ctx.fillText((rangeKm * 0.50).toFixed(0), scopeX - 3 * scale, scopeY + scopeH * 0.50);
        ctx.fillText((rangeKm * 0.75).toFixed(0), scopeX - 3 * scale, scopeY + scopeH * 0.25);
        ctx.fillText(rangeKm.toFixed(0) + 'km', scopeX - 3 * scale, scopeY + 2 * scale);

        // --- Title ---
        ctx.font = 'bold ' + (10 * scale) + 'px \'Courier New\', monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = HUD_GREEN;
        ctx.fillText('RADAR', scopeX + scopeW / 2, scopeY - 3 * scale);

        // --- Contact count ---
        var nContacts = contacts ? contacts.length : 0;
        if (nContacts > 0) {
            ctx.font = (8 * scale) + 'px \'Courier New\', monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('TGT: ' + nContacts, scopeX + scopeW, scopeY - 3 * scale);
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------
    // Target Designation (TD) Bracket
    // Draws a targeting bracket around the selected target with info readout
    // Data: state._selectedTarget — { screenX, screenY, range, name, aspect,
    //        closureRate, team }
    // -----------------------------------------------------------------
    function drawTargetBracket(state, scale, simTime) {
        var tgt = state._selectedTarget;
        if (!tgt) return;

        var tx = tgt.screenX;
        var ty = tgt.screenY;

        // If no screen coordinates, skip drawing the bracket
        if (tx == null || ty == null) return;

        // Clamp to screen bounds with margin
        var margin = 30 * scale;
        tx = Math.max(margin, Math.min(width - margin, tx));
        ty = Math.max(margin, Math.min(height - margin, ty));

        // --- Bracket size with pulse ---
        var pulseTime = simTime || (Date.now() / 1000);
        var pulse = 1.0 + 0.08 * Math.sin(pulseTime * 4.0); // subtle scale oscillation
        var bracketSize = 20 * scale * pulse;  // half-size of bracket (40px total at scale=1)
        var cornerLen = 10 * scale * pulse;    // length of each corner line

        // --- Bracket color: green=friendly, red=hostile ---
        var isHostile = tgt.team === 'red';
        var bracketColor = isHostile ? HUD_ALERT : HUD_GREEN;
        var bracketGlow = isHostile ? 'rgba(255, 50, 50, 0.25)' : 'rgba(0, 255, 0, 0.25)';

        ctx.save();

        // --- Subtle glow behind bracket ---
        ctx.fillStyle = bracketGlow;
        ctx.beginPath();
        ctx.arc(tx, ty, bracketSize * 1.2, 0, Math.PI * 2);
        ctx.fill();

        // --- Draw 4 corner brackets ---
        ctx.strokeStyle = bracketColor;
        ctx.lineWidth = 2 * scale;
        ctx.lineCap = 'square';

        // Top-left corner
        ctx.beginPath();
        ctx.moveTo(tx - bracketSize, ty - bracketSize + cornerLen);
        ctx.lineTo(tx - bracketSize, ty - bracketSize);
        ctx.lineTo(tx - bracketSize + cornerLen, ty - bracketSize);
        ctx.stroke();

        // Top-right corner
        ctx.beginPath();
        ctx.moveTo(tx + bracketSize - cornerLen, ty - bracketSize);
        ctx.lineTo(tx + bracketSize, ty - bracketSize);
        ctx.lineTo(tx + bracketSize, ty - bracketSize + cornerLen);
        ctx.stroke();

        // Bottom-left corner
        ctx.beginPath();
        ctx.moveTo(tx - bracketSize, ty + bracketSize - cornerLen);
        ctx.lineTo(tx - bracketSize, ty + bracketSize);
        ctx.lineTo(tx - bracketSize + cornerLen, ty + bracketSize);
        ctx.stroke();

        // Bottom-right corner
        ctx.beginPath();
        ctx.moveTo(tx + bracketSize - cornerLen, ty + bracketSize);
        ctx.lineTo(tx + bracketSize, ty + bracketSize);
        ctx.lineTo(tx + bracketSize, ty + bracketSize - cornerLen);
        ctx.stroke();

        // --- Small center diamond (aim point) ---
        ctx.strokeStyle = bracketColor;
        ctx.lineWidth = 1 * scale;
        var dSize = 3 * scale;
        ctx.beginPath();
        ctx.moveTo(tx, ty - dSize);
        ctx.lineTo(tx + dSize, ty);
        ctx.lineTo(tx, ty + dSize);
        ctx.lineTo(tx - dSize, ty);
        ctx.closePath();
        ctx.stroke();

        // --- Target info text block (below bracket) ---
        var infoX = tx;
        var infoY = ty + bracketSize + 8 * scale;

        ctx.font = 'bold ' + (10 * scale) + 'px \'Courier New\', monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = bracketColor;

        // Line 1: Target name
        var tgtName = tgt.name || 'UNKNOWN';
        if (tgtName.length > 12) tgtName = tgtName.substring(0, 12);
        ctx.fillText(tgtName, infoX, infoY);

        // Line 2: Range in nautical miles
        ctx.font = (9 * scale) + 'px \'Courier New\', monospace';
        var rangeNm = 0;
        if (tgt.range) {
            rangeNm = tgt.range / 1852;  // meters to nautical miles
        }
        var rangeTxt = 'R: ' + rangeNm.toFixed(1) + ' nm';
        ctx.fillText(rangeTxt, infoX, infoY + 12 * scale);

        // Line 3: Aspect angle + closure rate
        var line3 = '';
        if (tgt.aspect != null) {
            var aspDeg = tgt.aspect;
            // Classify aspect: HOT (0-30), FLANK (30-70), BEAM (70-110), DRAG (110-180)
            var aspLabel;
            var absAsp = Math.abs(aspDeg);
            if (absAsp <= 30) aspLabel = 'HOT';
            else if (absAsp <= 70) aspLabel = 'FLANK';
            else if (absAsp <= 110) aspLabel = 'BEAM';
            else aspLabel = 'DRAG';
            line3 = aspLabel + ' ' + Math.round(absAsp) + '\u00b0';
        }
        if (tgt.closureRate != null) {
            var closureKts = tgt.closureRate * MPS_TO_KNOTS;
            var closSign = closureKts >= 0 ? '+' : '';
            line3 += (line3 ? '  ' : '') + 'Vc' + closSign + Math.round(closureKts);
        }
        if (line3) {
            ctx.fillText(line3, infoX, infoY + 23 * scale);
        }

        ctx.restore();
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

        // Local time from sim epoch + elapsed + longitude offset
        var timeStr = '';
        if (state._simEpochJD && state._simElapsed != null) {
            var jd = state._simEpochJD + state._simElapsed / 86400;
            // JD to Unix ms: (jd - 2440587.5) * 86400000
            var utcMs = (jd - 2440587.5) * 86400000;
            // Local offset: 1 hour per 15 degrees longitude
            var localMs = utcMs + lonDeg * 240000; // 240000 ms per degree = 4 min/deg
            var d = new Date(localMs);
            var hh = d.getUTCHours().toString().padStart(2, '0');
            var mm = d.getUTCMinutes().toString().padStart(2, '0');
            timeStr = '  LT ' + hh + ':' + mm;
        }

        var x = 20 * scale;
        var y = height - 30 * scale;

        ctx.font = `${11 * scale}px 'Courier New', monospace`;
        ctx.textAlign = 'left';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText(latStr + '  ' + lonStr + '  ' + altStr + timeStr, x, y);
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

    // -----------------------------------------------------------------------
    // Weather Info Display — lower-left, shows wind/vis/turb/precip from WeatherSystem
    // -----------------------------------------------------------------------
    function drawWeatherInfo(state, scale, simTime) {
        if (typeof WeatherSystem === 'undefined') return;
        var alt = state.alt || 0;

        var wind = WeatherSystem.getWind(alt);
        var vis = WeatherSystem.getVisibility(alt);
        var turb = WeatherSystem.getTurbulence(alt, state.speed || 0);
        var cloud = WeatherSystem.getCloudLayer(alt);

        // Skip if calm + clear + no turbulence
        if (wind.speed_ms < 0.5 && vis > 49 && turb.intensity < 0.1 && !cloud.inCloud) return;

        var w = canvas.width;
        var h = canvas.height;
        var x0 = 15 * scale;
        var y0 = h - 180 * scale;
        var lineH = 14 * scale;

        ctx.save();
        ctx.font = (11 * scale) + 'px monospace';

        // Background box
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.strokeStyle = 'rgba(0,255,0,0.3)';
        ctx.lineWidth = 1;
        var boxW = 150 * scale;
        var boxH = 100 * scale;
        ctx.fillRect(x0, y0, boxW, boxH);
        ctx.strokeRect(x0, y0, boxW, boxH);

        // Title
        ctx.fillStyle = '#0a0';
        ctx.textAlign = 'left';
        ctx.fillText('WX', x0 + 5 * scale, y0 + lineH);

        // Wind arrow + speed
        var windSpd = wind.speed_ms + wind.gust_ms;
        var windKts = (windSpd * 1.94384).toFixed(0);
        var windDirDeg = ((wind.heading_rad * 180 / Math.PI) + 360) % 360;

        ctx.fillStyle = windSpd > 15 ? '#ff8800' : (windSpd > 5 ? '#ffff00' : '#00ff00');
        ctx.fillText('WIND ' + windDirDeg.toFixed(0).padStart(3, '0') + '\u00B0/' + windKts + 'KT', x0 + 25 * scale, y0 + lineH);

        // Draw small wind arrow
        var arrowX = x0 + 138 * scale;
        var arrowY = y0 + lineH - 4 * scale;
        var arrowLen = 8 * scale;
        var windAngle = wind.heading_rad + Math.PI; // direction wind blows TO
        ctx.beginPath();
        ctx.moveTo(arrowX, arrowY);
        ctx.lineTo(arrowX + arrowLen * Math.sin(windAngle), arrowY - arrowLen * Math.cos(windAngle));
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 2 * scale;
        ctx.stroke();

        // Crosswind component relative to heading
        var xwindAngle = wind.heading_rad - (state.heading || 0);
        var xwind = windSpd * Math.sin(xwindAngle);
        var xwindKts = Math.abs(xwind * 1.94384).toFixed(0);
        ctx.fillStyle = Math.abs(xwind) > 10 ? '#ff4444' : '#00ff00';
        ctx.fillText('XWIND ' + xwindKts + 'KT ' + (xwind > 0.5 ? 'R' : (xwind < -0.5 ? 'L' : '')), x0 + 5 * scale, y0 + lineH * 2);

        // Visibility
        ctx.fillStyle = vis < 3 ? '#ff4444' : (vis < 10 ? '#ffff00' : '#00ff00');
        ctx.fillText('VIS ' + (vis < 1 ? vis.toFixed(1) : vis.toFixed(0)) + ' KM', x0 + 5 * scale, y0 + lineH * 3);

        // Precipitation
        var precip = cloud.inCloud ? 'IN CLOUD' : '';
        if (!precip) {
            // Check general weather precip
            var cond = wind; // WeatherSystem doesn't expose _conditions directly
            // Use visibility as proxy: <5km = probably precip, <2km = heavy
            if (vis < 2) precip = 'PRECIP HVY';
            else if (vis < 5) precip = 'PRECIP LT';
        }
        if (precip) {
            ctx.fillStyle = '#ff8800';
            ctx.fillText(precip, x0 + 80 * scale, y0 + lineH * 3);
        }

        // Turbulence
        var turbLabels = ['SMOOTH', 'LIGHT', 'MODERATE', 'SEVERE'];
        var turbIdx = Math.min(3, Math.floor(turb.intensity));
        var turbLabel = turbLabels[turbIdx];
        ctx.fillStyle = turbIdx >= 3 ? '#ff0000' : (turbIdx >= 2 ? '#ff8800' : (turbIdx >= 1 ? '#ffff00' : '#00ff00'));
        ctx.fillText('TURB ' + turbLabel, x0 + 5 * scale, y0 + lineH * 4);

        // G-load variation from turbulence
        if (turb.gLoad_variation > 0.05) {
            ctx.fillStyle = turb.gLoad_variation > 0.5 ? '#ff4444' : '#ffff00';
            ctx.fillText('\u00B1' + turb.gLoad_variation.toFixed(1) + 'G', x0 + 100 * scale, y0 + lineH * 4);
        }

        // Cloud info
        if (cloud.inCloud) {
            ctx.fillStyle = '#ff8800';
            ctx.fillText('\u2601 IN CLOUD', x0 + 5 * scale, y0 + lineH * 5);
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Waypoint Steering Cue — shows bearing/distance/ETA to next mission waypoint
    // -----------------------------------------------------------------------
    function drawWaypointCue(state, scale) {
        if (!state._waypointInfo || state._waypointInfo.length === 0) return;

        var w = canvas.width;
        var h = canvas.height;
        var x0 = w - 165 * scale;
        var y0 = h - 120 * scale;
        var lineH = 13 * scale;

        ctx.save();
        ctx.font = (10 * scale) + 'px monospace';
        ctx.textAlign = 'left';

        // Background
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.strokeStyle = 'rgba(0,255,170,0.3)';
        ctx.lineWidth = 1;
        var boxH = Math.min(state._waypointInfo.length, 4) * lineH + 18 * scale;
        ctx.fillRect(x0, y0, 155 * scale, boxH);
        ctx.strokeRect(x0, y0, 155 * scale, boxH);

        ctx.fillStyle = '#00ffaa';
        ctx.fillText('WAYPOINTS', x0 + 5 * scale, y0 + 12 * scale);

        var maxShow = Math.min(state._waypointInfo.length, 4);
        for (var i = 0; i < maxShow; i++) {
            var wp = state._waypointInfo[i];
            var brgDeg = ((wp.bearing_rad * 180 / Math.PI) + 360) % 360;
            var distNm = (wp.dist_m / 1852).toFixed(1);
            var etaStr = wp.eta_s < 9999 ? (wp.eta_s / 60).toFixed(0) + 'm' : '--';

            ctx.fillStyle = i === 0 ? '#00ffaa' : '#008855';
            ctx.fillText(
                wp.name + ' ' + brgDeg.toFixed(0).padStart(3, '0') + '\u00B0 ' + distNm + 'nm ' + etaStr,
                x0 + 5 * scale,
                y0 + (18 + i * lineH) * scale / scale * scale
            );
        }

        // Steer cue: small arrow on heading tape direction
        var nextWp = state._waypointInfo[0];
        if (nextWp) {
            var heading = state.heading || 0;
            var brgRad = nextWp.bearing_rad;
            var diff = brgRad - heading;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;

            // Draw steer-to caret at bottom center (below heading tape)
            var cx = w / 2 + diff * 200 * scale;
            cx = Math.max(w / 2 - 120 * scale, Math.min(w / 2 + 120 * scale, cx));
            var cy = 55 * scale;

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx - 6 * scale, cy - 10 * scale);
            ctx.lineTo(cx + 6 * scale, cy - 10 * scale);
            ctx.closePath();
            ctx.fillStyle = '#00ffaa';
            ctx.fill();
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------------
    // ILS Approach Guidance — glideslope, localizer, distance, decision height
    // -----------------------------------------------------------------------
    function drawILSGuidance(state, scale) {
        if (!state._ilsData) return;
        var ils = state._ilsData;

        var w = canvas.width;
        var h = canvas.height;

        // Only show when below 5000ft and within 30nm of runway
        if ((state.alt || 0) > 1525 || !ils.distNm || ils.distNm > 30) return;

        ctx.save();

        // --- Glideslope (right side vertical scale) ---
        var gsX = w * 0.82;
        var gsY = h * 0.5;
        var gsH = 120 * scale;

        // Scale: 2 dots = full deflection
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1 * scale;

        // Reference dots
        for (var d = -2; d <= 2; d++) {
            if (d === 0) continue;
            var dotY = gsY + d * (gsH / 4);
            ctx.beginPath();
            ctx.arc(gsX, dotY, 2 * scale, 0, Math.PI * 2);
            ctx.stroke();
        }
        // Center line
        ctx.beginPath();
        ctx.moveTo(gsX - 8 * scale, gsY);
        ctx.lineTo(gsX + 8 * scale, gsY);
        ctx.stroke();

        // GS deviation diamond (clamped to +/-2 dots)
        var gsDevDeg = ils.gsDeviation || 0;  // degrees above/below glidepath
        var gsDots = Math.max(-2, Math.min(2, gsDevDeg / 0.35));  // 0.35 deg per dot
        var diamondY = gsY + gsDots * (gsH / 4);

        ctx.fillStyle = Math.abs(gsDots) > 1 ? '#ffff00' : '#00ff88';
        ctx.beginPath();
        ctx.moveTo(gsX, diamondY - 5 * scale);
        ctx.lineTo(gsX + 4 * scale, diamondY);
        ctx.lineTo(gsX, diamondY + 5 * scale);
        ctx.lineTo(gsX - 4 * scale, diamondY);
        ctx.closePath();
        ctx.fill();

        // "GS" label
        ctx.font = (9 * scale) + 'px monospace';
        ctx.fillStyle = '#00aa66';
        ctx.textAlign = 'center';
        ctx.fillText('GS', gsX, gsY - gsH/2 - 8 * scale);

        // --- Localizer (bottom horizontal scale) ---
        var locX = w * 0.5;
        var locY = h * 0.72;
        var locW = 120 * scale;

        // Reference dots
        for (var ld = -2; ld <= 2; ld++) {
            if (ld === 0) continue;
            var dotX = locX + ld * (locW / 4);
            ctx.strokeStyle = '#00ff00';
            ctx.beginPath();
            ctx.arc(dotX, locY, 2 * scale, 0, Math.PI * 2);
            ctx.stroke();
        }
        // Center line
        ctx.beginPath();
        ctx.moveTo(locX, locY - 8 * scale);
        ctx.lineTo(locX, locY + 8 * scale);
        ctx.stroke();

        // LOC deviation diamond
        var locDevDeg = ils.locDeviation || 0;  // degrees left/right of centerline
        var locDots = Math.max(-2, Math.min(2, locDevDeg / 1.0));  // 1 deg per dot
        var diamondX = locX + locDots * (locW / 4);

        ctx.fillStyle = Math.abs(locDots) > 1 ? '#ffff00' : '#00ff88';
        ctx.beginPath();
        ctx.moveTo(diamondX, locY - 5 * scale);
        ctx.lineTo(diamondX + 4 * scale, locY);
        ctx.lineTo(diamondX, locY + 5 * scale);
        ctx.lineTo(diamondX - 4 * scale, locY);
        ctx.closePath();
        ctx.fill();

        // "LOC" label
        ctx.fillStyle = '#00aa66';
        ctx.fillText('LOC', locX - locW/2 - 15 * scale, locY);

        // --- Distance and altitude readout ---
        var infoX = w * 0.82;
        var infoY = gsY + gsH/2 + 15 * scale;
        ctx.font = (10 * scale) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#00ff88';
        ctx.fillText(ils.distNm.toFixed(1) + ' NM', infoX, infoY);

        // Runway identifier
        if (ils.rwyId) {
            ctx.fillText('RWY ' + ils.rwyId, infoX, infoY + 12 * scale);
        }

        // --- Decision Height warning ---
        var agl = (state.alt || 0) - (ils.rwyAlt || 0);
        if (agl < 70 && agl > 0) {  // ~200ft AGL
            ctx.font = 'bold ' + (16 * scale) + 'px monospace';
            ctx.fillStyle = '#ffff00';
            ctx.textAlign = 'center';
            var flashOn = Math.floor(Date.now() / 500) % 2 === 0;
            if (flashOn) {
                ctx.fillText('DECISION HEIGHT', w/2, h * 0.62);
            }
        }
        // Minimums callout
        if (agl < 30 && agl > 0) {
            ctx.font = 'bold ' + (18 * scale) + 'px monospace';
            ctx.fillStyle = '#ff4444';
            ctx.textAlign = 'center';
            ctx.fillText('MINIMUMS', w/2, h * 0.58);
        }

        ctx.restore();
    }

    // -----------------------------------------------------------------
    // TCAS — Traffic Collision Avoidance System
    // Shows traffic diamonds on altitude tape + center screen warnings
    // -----------------------------------------------------------------
    function drawTCAS(state, scale) {
        if (!state._nearby || state._nearby.length === 0) return;
        if (state.alt < 30) return; // don't show on ground

        var altFt = state.alt * M_TO_FT;
        var tapeX = width - 80 * scale;
        var pxPerFt = 0.15 * scale;
        var tapeH = 250 * scale;

        var pLat = state.lat;
        var pLon = state.lon;
        var pAlt = state.alt;

        var tcasAlerts = [];

        for (var i = 0; i < state._nearby.length; i++) {
            var ent = state._nearby[i];
            if (!ent || ent.alt == null || ent.lat == null) continue;
            if (ent.type === 'ground_station' || ent.type === 'ground' || ent.type === 'static') continue;

            // Compute range
            var dLat = pLat - ent.lat;
            var dLon = pLon - ent.lon;
            var rangeM = Math.sqrt(dLat * dLat + dLon * dLon) * 6371000;
            var dAltM = Math.abs(pAlt - ent.alt);

            // TCAS thresholds
            var threat = 'none';
            if (rangeM < 2000 && dAltM < 300) threat = 'ra';       // Resolution Advisory
            else if (rangeM < 5000 && dAltM < 500) threat = 'ta';  // Traffic Advisory
            else if (rangeM < 10000 && dAltM < 1000) threat = 'prox'; // Proximity

            if (threat === 'none') continue;

            // Draw diamond on altitude tape
            var entAltFt = ent.alt * M_TO_FT;
            var dy = cy - (entAltFt - altFt) * pxPerFt;

            if (Math.abs(dy - cy) < tapeH / 2) {
                var dSize = 5 * scale;
                var dX = tapeX - 12 * scale;

                var dColor = threat === 'ra' ? HUD_ALERT : threat === 'ta' ? HUD_WARN : '#00aa00';

                ctx.fillStyle = dColor;
                ctx.beginPath();
                ctx.moveTo(dX, dy - dSize);
                ctx.lineTo(dX + dSize, dy);
                ctx.lineTo(dX, dy + dSize);
                ctx.lineTo(dX - dSize, dy);
                ctx.closePath();
                ctx.fill();

                // +/- indicator for above/below
                ctx.font = (8 * scale) + 'px monospace';
                ctx.textAlign = 'right';
                ctx.fillStyle = dColor;
                var relAlt = Math.round((entAltFt - altFt) / 100);
                var relStr = (relAlt >= 0 ? '+' : '') + relAlt;
                ctx.fillText(relStr, dX - dSize - 2 * scale, dy + 3 * scale);
            }

            if (threat === 'ra' || threat === 'ta') {
                tcasAlerts.push({ threat: threat, range: rangeM, dAlt: ent.alt - pAlt, name: ent.name || '' });
            }
        }

        // Center screen TCAS warning
        if (tcasAlerts.length > 0) {
            var worst = tcasAlerts[0];
            for (var j = 1; j < tcasAlerts.length; j++) {
                if (tcasAlerts[j].threat === 'ra' && worst.threat !== 'ra') worst = tcasAlerts[j];
                else if (tcasAlerts[j].range < worst.range) worst = tcasAlerts[j];
            }

            var flashOn = Math.floor(Date.now() / 400) % 2 === 0;
            if (worst.threat === 'ra') {
                if (flashOn) {
                    ctx.font = 'bold ' + (18 * scale) + 'px monospace';
                    ctx.textAlign = 'center';
                    ctx.fillStyle = HUD_ALERT;
                    ctx.fillText('TRAFFIC', cx, cy + 95 * scale);
                    // Resolution advisory
                    var raText = worst.dAlt > 0 ? 'DESCEND' : 'CLIMB';
                    ctx.font = 'bold ' + (14 * scale) + 'px monospace';
                    ctx.fillText(raText, cx, cy + 112 * scale);
                }
            } else if (worst.threat === 'ta') {
                ctx.font = (14 * scale) + 'px monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = HUD_WARN;
                ctx.fillText('TRAFFIC  ' + (worst.range / 1852).toFixed(1) + 'NM', cx, cy + 95 * scale);
            }
        }
    }

    // -----------------------------------------------------------------
    // GPWS — Ground Proximity Warning System
    // Enhanced terrain proximity warnings beyond basic PULL UP
    // -----------------------------------------------------------------
    var _prevAlt = -1;
    var _descentRate = 0;
    function drawGPWS(state, scale) {
        if (!state || state.phase !== 'FLIGHT') return;
        if (state.alt > 800) { _prevAlt = state.alt; _descentRate = 0; return; }

        // Compute descent rate (m/s, smoothed)
        if (_prevAlt > 0) {
            var rawRate = (_prevAlt - state.alt) * 60; // approx m/s (assumes 60fps)
            _descentRate = _descentRate * 0.9 + rawRate * 0.1;
        }
        _prevAlt = state.alt;

        var altAGL = state.alt - (state.groundAlt || 0);
        var warnings = [];

        // Mode 1: Excessive descent rate
        if (_descentRate > 15 && altAGL < 600) {
            warnings.push({ text: 'SINK RATE', color: HUD_WARN, priority: 2 });
        }
        if (_descentRate > 30 && altAGL < 400) {
            warnings.push({ text: 'PULL UP', color: HUD_ALERT, priority: 1 });
        }

        // Mode 2: Terrain closure rate (descending + low)
        if (state.gamma < -8 * DEG && altAGL < 300) {
            warnings.push({ text: 'TERRAIN', color: HUD_ALERT, priority: 1 });
        }

        // Mode 3: Altitude loss after takeoff (descending below 200m after being higher)
        if (state.alt < 200 && state.gamma < -3 * DEG && state.speed > 50 && !state.gearDown) {
            warnings.push({ text: "DON'T SINK", color: HUD_WARN, priority: 2 });
        }

        // Mode 4: Insufficient terrain clearance (too low, not configured for landing)
        if (altAGL < 150 && !state.gearDown && state.speed > 80) {
            warnings.push({ text: 'TOO LOW GEAR', color: HUD_WARN, priority: 2 });
        }
        if (altAGL < 100 && state.speed > 60) {
            warnings.push({ text: 'TOO LOW TERRAIN', color: HUD_ALERT, priority: 1 });
        }

        if (warnings.length === 0) return;

        // Show highest priority warning
        warnings.sort(function(a, b) { return a.priority - b.priority; });
        var w = warnings[0];
        var flashOn = Math.floor(Date.now() / 350) % 2 === 0;

        if (flashOn) {
            ctx.font = 'bold ' + (20 * scale) + 'px monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = w.color;
            ctx.fillText(w.text, cx, cy + 145 * scale);
        }

        // GPWS altitude bar at bottom of screen
        if (altAGL < 500) {
            var barW = width * 0.4;
            var barH = 4 * scale;
            var barY = height - 15 * scale;
            var barX = cx - barW / 2;
            var pct = Math.max(0, Math.min(1, altAGL / 500));
            ctx.fillStyle = pct < 0.2 ? HUD_ALERT : pct < 0.5 ? HUD_WARN : HUD_DIM;
            ctx.fillRect(barX, barY, barW * pct, barH);
            ctx.strokeStyle = HUD_DIM;
            ctx.lineWidth = 1 * scale;
            ctx.strokeRect(barX, barY, barW, barH);

            ctx.font = (9 * scale) + 'px monospace';
            ctx.textAlign = 'left';
            ctx.fillStyle = HUD_DIM;
            ctx.fillText('AGL ' + Math.round(altAGL * M_TO_FT) + 'ft', barX + barW + 5 * scale, barY + barH);
        }
    }

    // -----------------------------------------------------------------
    // Terrain Following / Terrain Avoidance Profile
    // Shows terrain elevation ahead, clearance line, and AGL readout
    // -----------------------------------------------------------------
    function drawTerrainProfile(state, scale) {
        if (!state || !state._tfEnabled) return;

        var terrainAhead = state._terrainAhead;
        var currentAGL = state._tfAgl || 0;
        var aglTarget = state._tfAglTarget || 150;
        var terrainElev = state._tfTerrainElev || 0;
        var alt = state.alt || 0;

        // Profile strip dimensions — bottom-center of HUD
        var stripW = 280 * scale;
        var stripH = 60 * scale;
        var stripX = cx - stripW / 2;
        var stripY = height - 85 * scale;

        // Background
        ctx.fillStyle = 'rgba(0, 10, 0, 0.6)';
        ctx.fillRect(stripX, stripY, stripW, stripH);
        ctx.strokeStyle = HUD_DIM;
        ctx.lineWidth = 1 * scale;
        ctx.strokeRect(stripX, stripY, stripW, stripH);

        // Title
        ctx.font = (9 * scale) + 'px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = HUD_CYAN;
        ctx.fillText('TF/TA', stripX + 3 * scale, stripY - 3 * scale);

        // Build terrain points: [0m (current), 2000m, 5000m, 10000m]
        var terrainPts = [{ dist: 0, elev: terrainElev }];
        if (terrainAhead && terrainAhead.length > 0) {
            for (var i = 0; i < terrainAhead.length; i++) {
                terrainPts.push({ dist: terrainAhead[i].dist, elev: terrainAhead[i].terrainElev });
            }
        }

        // Find min/max elevation for scaling
        var minElev = terrainElev;
        var maxElev = terrainElev;
        for (var k = 0; k < terrainPts.length; k++) {
            if (terrainPts[k].elev < minElev) minElev = terrainPts[k].elev;
            if (terrainPts[k].elev > maxElev) maxElev = terrainPts[k].elev;
        }
        // Include aircraft and clearance line in scale
        var clearanceElev = maxElev + aglTarget;
        var displayMax = Math.max(alt, clearanceElev) + 50;
        var displayMin = minElev - 50;
        if (displayMax - displayMin < 200) {
            var mid = (displayMax + displayMin) / 2;
            displayMax = mid + 100;
            displayMin = mid - 100;
        }
        var elevRange = displayMax - displayMin;

        // Helper: elevation -> Y pixel
        var margin = 4 * scale;
        var innerH = stripH - margin * 2;
        function elevToY(e) {
            var pct = (e - displayMin) / elevRange;
            return stripY + stripH - margin - pct * innerH;
        }

        // Helper: distance -> X pixel
        var maxDist = 10000;
        var innerW = stripW - margin * 2;
        function distToX(d) {
            return stripX + margin + (d / maxDist) * innerW;
        }

        // Draw terrain fill (brown/green)
        ctx.beginPath();
        ctx.moveTo(distToX(0), elevToY(displayMin));
        for (var t = 0; t < terrainPts.length; t++) {
            ctx.lineTo(distToX(terrainPts[t].dist), elevToY(terrainPts[t].elev));
        }
        ctx.lineTo(distToX(terrainPts[terrainPts.length - 1].dist), elevToY(displayMin));
        ctx.closePath();
        ctx.fillStyle = 'rgba(80, 60, 20, 0.5)';
        ctx.fill();

        // Draw terrain line
        ctx.beginPath();
        for (var t2 = 0; t2 < terrainPts.length; t2++) {
            var tx = distToX(terrainPts[t2].dist);
            var ty = elevToY(terrainPts[t2].elev);
            if (t2 === 0) ctx.moveTo(tx, ty);
            else ctx.lineTo(tx, ty);
        }
        ctx.strokeStyle = '#886622';
        ctx.lineWidth = 2 * scale;
        ctx.stroke();

        // Draw clearance line (terrain + AGL target) — dashed green
        ctx.beginPath();
        ctx.setLineDash([4 * scale, 3 * scale]);
        for (var c = 0; c < terrainPts.length; c++) {
            var cx2 = distToX(terrainPts[c].dist);
            var cy2 = elevToY(terrainPts[c].elev + aglTarget);
            if (c === 0) ctx.moveTo(cx2, cy2);
            else ctx.lineTo(cx2, cy2);
        }
        ctx.strokeStyle = HUD_GREEN;
        ctx.lineWidth = 1.5 * scale;
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw aircraft position (small triangle at dist=0, current altitude)
        var acX = distToX(0);
        var acY = elevToY(alt);
        ctx.beginPath();
        ctx.moveTo(acX, acY - 4 * scale);
        ctx.lineTo(acX + 5 * scale, acY + 3 * scale);
        ctx.lineTo(acX - 5 * scale, acY + 3 * scale);
        ctx.closePath();
        ctx.fillStyle = HUD_GREEN;
        ctx.fill();

        // Draw desired altitude line (thin cyan line)
        if (state._tfDesiredAlt) {
            var desY = elevToY(state._tfDesiredAlt);
            ctx.beginPath();
            ctx.moveTo(stripX + margin, desY);
            ctx.lineTo(stripX + stripW - margin, desY);
            ctx.strokeStyle = HUD_CYAN;
            ctx.lineWidth = 1 * scale;
            ctx.setLineDash([2 * scale, 2 * scale]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // AGL readout — large text centered below strip
        var aglColor = currentAGL < aglTarget * 0.5 ? HUD_ALERT :
                       currentAGL < aglTarget * 0.8 ? HUD_WARN : HUD_GREEN;
        ctx.font = 'bold ' + (16 * scale) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = aglColor;
        ctx.fillText('AGL ' + Math.round(currentAGL) + 'm', cx, stripY + stripH + 14 * scale);

        // Target AGL readout
        ctx.font = (9 * scale) + 'px monospace';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('TGT ' + aglTarget + 'm', cx, stripY + stripH + 24 * scale);

        // Distance scale labels
        ctx.font = (8 * scale) + 'px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = HUD_DIM;
        ctx.fillText('0', distToX(0), stripY + stripH + 8 * scale);
        ctx.fillText('2k', distToX(2000), stripY + stripH + 8 * scale);
        ctx.fillText('5k', distToX(5000), stripY + stripH + 8 * scale);
        ctx.fillText('10k', distToX(10000), stripY + stripH + 8 * scale);

        // Terrain ahead warning — flash if terrain ahead is higher than current altitude
        if (terrainAhead && terrainAhead.length > 0) {
            var highestAhead = 0;
            for (var h = 0; h < terrainAhead.length; h++) {
                if (terrainAhead[h].terrainElev > highestAhead) highestAhead = terrainAhead[h].terrainElev;
            }
            if (highestAhead + aglTarget * 0.5 > alt) {
                var flashOn = Math.floor(Date.now() / 300) % 2 === 0;
                if (flashOn) {
                    ctx.font = 'bold ' + (12 * scale) + 'px monospace';
                    ctx.textAlign = 'right';
                    ctx.fillStyle = HUD_WARN;
                    ctx.fillText('TERRAIN AHEAD', stripX + stripW - 3 * scale, stripY - 3 * scale);
                }
            }
        }
    }

    /**
     * Set a HUD element toggle.
     * @param {string} key - toggle name (hud, speedTape, altTape, heading, pitchLadder, fpm, gMeter, engineFuel, weapons, warnings, orbital, minimap, rwr, radar, coordinates, warpIndicator, approachAids, weather)
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
