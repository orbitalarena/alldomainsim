/**
 * PorkchopRenderer - Canvas 2D contour plot for interplanetary transfer porkchop plots
 *
 * Renders C3 or delta-V contour-filled plots with color ramp, axis labels,
 * optimal point crosshair, and interactive hit-testing.
 *
 * Depends on: SolarSystemEngine (for jdToDateString)
 *
 * Usage:
 *   PorkchopRenderer.render(canvas, data, { useC3: true });
 *   var point = PorkchopRenderer.hitTest(canvas, data, mouseX, mouseY);
 */
var PorkchopRenderer = (function() {
    'use strict';

    // ─── Color Ramp: C3/DV value to RGB ────────────────────────────────
    // Blue (low) -> Cyan -> Green -> Yellow -> Red (high)
    function valueToColor(val, min_val, max_val) {
        if (val < 0 || !isFinite(val)) return 'rgba(0,0,0,0)';
        var t = (val - min_val) / (max_val - min_val);
        t = Math.max(0, Math.min(1, t));

        var r, g, b;
        if (t < 0.25) {
            var s = t / 0.25;
            r = 0; g = Math.floor(255 * s); b = 255;
        } else if (t < 0.5) {
            var s = (t - 0.25) / 0.25;
            r = 0; g = 255; b = Math.floor(255 * (1 - s));
        } else if (t < 0.75) {
            var s = (t - 0.5) / 0.25;
            r = Math.floor(255 * s); g = 255; b = 0;
        } else {
            var s = (t - 0.75) / 0.25;
            r = 255; g = Math.floor(255 * (1 - s)); b = 0;
        }
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    // ─── Default Margin ────────────────────────────────────────────────
    var DEFAULT_MARGIN = { top: 40, right: 80, bottom: 60, left: 80 };

    // ─── Render Porkchop Plot ──────────────────────────────────────────
    // data: {
    //   grid: [{lj, aj, c3, dv, v}],
    //   launch_jd_start, launch_jd_end, arrival_jd_start, arrival_jd_end,
    //   launch_steps, arrival_steps,
    //   departure_planet, arrival_planet,
    //   optimal: { launch_jd, arrival_jd, c3_departure, total_delta_v }
    // }
    function render(canvas, data, options) {
        options = options || {};
        var ctx = canvas.getContext('2d');
        var W = canvas.width;
        var H = canvas.height;
        var margin = options.margin || DEFAULT_MARGIN;
        var plotW = W - margin.left - margin.right;
        var plotH = H - margin.top - margin.bottom;
        var useC3 = options.useC3 !== false;  // Default: plot C3

        // Clear canvas
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, W, H);

        // Validate data
        if (!data || !data.grid || data.grid.length === 0) {
            ctx.fillStyle = '#888';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('No porkchop data loaded', W / 2, H / 2);
            return;
        }

        // Filter valid points and determine value range
        var validPoints = data.grid.filter(function(p) { return p.v; });
        if (validPoints.length === 0) {
            ctx.fillStyle = '#888';
            ctx.font = '14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('No valid transfer solutions found', W / 2, H / 2);
            return;
        }

        var values = validPoints.map(function(p) { return useC3 ? p.c3 : p.dv; });
        var min_val = Math.min.apply(null, values);
        var max_val = Math.min(min_val * 10, Math.max.apply(null, values));  // Cap at 10x minimum

        var ls = data.launch_steps || 50;
        var as = data.arrival_steps || 50;
        var cellW = plotW / ls;
        var cellH = plotH / as;

        var ljRange = data.launch_jd_end - data.launch_jd_start;
        var ajRange = data.arrival_jd_end - data.arrival_jd_start;

        // ─── Draw grid cells (filled contour) ──────────────────────────
        for (var i = 0; i < data.grid.length; i++) {
            var pt = data.grid[i];
            if (!pt.v) continue;
            var val = useC3 ? pt.c3 : pt.dv;
            if (!isFinite(val) || val > max_val) continue;

            // Normalize to plot coordinates
            var lx = (pt.lj - data.launch_jd_start) / ljRange;
            var ly = (pt.aj - data.arrival_jd_start) / ajRange;

            var px = margin.left + lx * plotW;
            var py = margin.top + (1 - ly) * plotH;  // Y-axis flipped (arrival increases upward)

            ctx.fillStyle = valueToColor(val, min_val, max_val);
            ctx.fillRect(px - cellW / 2, py - cellH / 2, cellW + 1, cellH + 1);
        }

        // ─── Iso-level contour lines ───────────────────────────────────
        var numLevels = 8;
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 0.5;

        // Build 2D grid for contour extraction
        var gridMap = {};
        for (var i = 0; i < data.grid.length; i++) {
            var pt = data.grid[i];
            if (!pt.v) continue;
            var key = Math.round((pt.lj - data.launch_jd_start) / ljRange * ls) + ',' +
                      Math.round((pt.aj - data.arrival_jd_start) / ajRange * as);
            gridMap[key] = useC3 ? pt.c3 : pt.dv;
        }

        // Draw thin contour boundaries between cells with different level bands
        for (var li = 0; li < ls; li++) {
            for (var ai = 0; ai < as; ai++) {
                var v0 = gridMap[li + ',' + ai];
                if (v0 === undefined || !isFinite(v0)) continue;
                var band0 = Math.floor((v0 - min_val) / (max_val - min_val) * numLevels);

                // Check right neighbor
                var vr = gridMap[(li + 1) + ',' + ai];
                if (vr !== undefined && isFinite(vr)) {
                    var bandr = Math.floor((vr - min_val) / (max_val - min_val) * numLevels);
                    if (band0 !== bandr) {
                        var x = margin.left + (li + 0.5) / ls * plotW;
                        var y1 = margin.top + (1 - ai / as) * plotH;
                        var y2 = margin.top + (1 - (ai + 1) / as) * plotH;
                        ctx.beginPath();
                        ctx.moveTo(x, y1);
                        ctx.lineTo(x, y2);
                        ctx.stroke();
                    }
                }

                // Check upper neighbor
                var vu = gridMap[li + ',' + (ai + 1)];
                if (vu !== undefined && isFinite(vu)) {
                    var bandu = Math.floor((vu - min_val) / (max_val - min_val) * numLevels);
                    if (band0 !== bandu) {
                        var x1 = margin.left + li / ls * plotW;
                        var x2 = margin.left + (li + 1) / ls * plotW;
                        var y = margin.top + (1 - (ai + 0.5) / as) * plotH;
                        ctx.beginPath();
                        ctx.moveTo(x1, y);
                        ctx.lineTo(x2, y);
                        ctx.stroke();
                    }
                }
            }
        }

        // ─── Time-of-flight diagonal lines ─────────────────────────────
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([4, 4]);
        var tofDays = [100, 150, 200, 250, 300, 350, 400];
        for (var ti = 0; ti < tofDays.length; ti++) {
            var tof = tofDays[ti];
            // Line where arrival_jd = launch_jd + tof
            var x1 = margin.left;
            var y1 = margin.top + (1 - (data.launch_jd_start + tof - data.arrival_jd_start) / ajRange) * plotH;
            var x2 = margin.left + plotW;
            var y2 = margin.top + (1 - (data.launch_jd_end + tof - data.arrival_jd_start) / ajRange) * plotH;

            if (y1 > margin.top + plotH && y2 > margin.top + plotH) continue;
            if (y1 < margin.top && y2 < margin.top) continue;

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            // Label
            var labelX = x2 - 30;
            var labelY = y2 - 5;
            if (labelY > margin.top && labelY < margin.top + plotH) {
                ctx.fillStyle = 'rgba(255,255,255,0.2)';
                ctx.font = '9px monospace';
                ctx.textAlign = 'right';
                ctx.fillText(tof + 'd', labelX, labelY);
            }
        }
        ctx.setLineDash([]);

        // ─── Optimal point crosshair ───────────────────────────────────
        if (data.optimal) {
            var ox = margin.left + (data.optimal.launch_jd - data.launch_jd_start) / ljRange * plotW;
            var oy = margin.top + (1 - (data.optimal.arrival_jd - data.arrival_jd_start) / ajRange) * plotH;

            // Crosshair
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ox - 15, oy);
            ctx.lineTo(ox + 15, oy);
            ctx.moveTo(ox, oy - 15);
            ctx.lineTo(ox, oy + 15);
            ctx.stroke();

            // Circle around optimal
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(ox, oy, 20, 0, 2 * Math.PI);
            ctx.stroke();

            // Value label
            ctx.fillStyle = '#fff';
            ctx.font = '12px monospace';
            ctx.textAlign = 'left';
            var label;
            if (useC3) {
                label = 'C3=' + data.optimal.c3_departure.toFixed(1) + ' km\u00B2/s\u00B2';
            } else {
                label = '\u0394V=' + (data.optimal.total_delta_v / 1000).toFixed(2) + ' km/s';
            }
            ctx.fillText(label, ox + 25, oy - 5);

            // Date labels for optimal
            ctx.font = '10px monospace';
            ctx.fillStyle = '#aaa';
            if (typeof SolarSystemEngine !== 'undefined') {
                ctx.fillText('L: ' + SolarSystemEngine.jdToDateString(data.optimal.launch_jd), ox + 25, oy + 10);
                ctx.fillText('A: ' + SolarSystemEngine.jdToDateString(data.optimal.arrival_jd), ox + 25, oy + 22);
            }
        }

        // ─── Axes ──────────────────────────────────────────────────────
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin.left, margin.top);
        ctx.lineTo(margin.left, margin.top + plotH);
        ctx.lineTo(margin.left + plotW, margin.top + plotH);
        ctx.stroke();

        // ─── X-axis tick labels (launch date) ──────────────────────────
        ctx.fillStyle = '#aaa';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        var numXTicks = 5;
        for (var i = 0; i <= numXTicks; i++) {
            var t = i / numXTicks;
            var jd = data.launch_jd_start + t * ljRange;
            var x = margin.left + t * plotW;

            // Tick mark
            ctx.strokeStyle = '#555';
            ctx.beginPath();
            ctx.moveTo(x, margin.top + plotH);
            ctx.lineTo(x, margin.top + plotH + 5);
            ctx.stroke();

            // Label
            if (typeof SolarSystemEngine !== 'undefined') {
                ctx.fillStyle = '#aaa';
                ctx.fillText(SolarSystemEngine.jdToDateString(jd), x, margin.top + plotH + 20);
            }

            // Grid line
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(x, margin.top);
            ctx.lineTo(x, margin.top + plotH);
            ctx.stroke();
        }

        // ─── Y-axis tick labels (arrival date) ─────────────────────────
        ctx.textAlign = 'right';
        var numYTicks = 5;
        for (var i = 0; i <= numYTicks; i++) {
            var t = i / numYTicks;
            var jd = data.arrival_jd_start + t * ajRange;
            var y = margin.top + (1 - t) * plotH;

            // Tick mark
            ctx.strokeStyle = '#555';
            ctx.beginPath();
            ctx.moveTo(margin.left - 5, y);
            ctx.lineTo(margin.left, y);
            ctx.stroke();

            // Label
            if (typeof SolarSystemEngine !== 'undefined') {
                ctx.fillStyle = '#aaa';
                ctx.fillText(SolarSystemEngine.jdToDateString(jd), margin.left - 10, y + 4);
            }

            // Grid line
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.moveTo(margin.left, y);
            ctx.lineTo(margin.left + plotW, y);
            ctx.stroke();
        }

        // ─── Title ─────────────────────────────────────────────────────
        ctx.fillStyle = '#e8ecf2';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        var titleText = (useC3 ? 'Departure C3' : 'Total \u0394V') + ' \u2014 ' +
                        (data.departure_planet || 'Earth') + ' \u2192 ' +
                        (data.arrival_planet || 'Mars');
        ctx.fillText(titleText, W / 2, margin.top - 15);

        // ─── Axis titles ───────────────────────────────────────────────
        ctx.fillStyle = '#8a96a6';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Launch Date', W / 2, H - 8);

        ctx.save();
        ctx.translate(15, H / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('Arrival Date', 0, 0);
        ctx.restore();

        // ─── Color bar ─────────────────────────────────────────────────
        var barX = margin.left + plotW + 15;
        var barW = 15;
        var barH = plotH;

        for (var i = 0; i < barH; i++) {
            var t = 1 - i / barH;
            var val = min_val + t * (max_val - min_val);
            ctx.fillStyle = valueToColor(val, min_val, max_val);
            ctx.fillRect(barX, margin.top + i, barW, 1);
        }

        // Color bar border
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, margin.top, barW, barH);

        // Color bar labels
        ctx.fillStyle = '#aaa';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        var numBarTicks = 5;
        for (var i = 0; i <= numBarTicks; i++) {
            var t = i / numBarTicks;
            var val = min_val + (1 - t) * (max_val - min_val);
            var label = val.toFixed(1);
            if (useC3) label += '';
            ctx.fillText(label, barX + barW + 5, margin.top + t * barH + 4);
        }

        // Color bar unit label
        ctx.font = '9px monospace';
        ctx.fillStyle = '#666';
        ctx.textAlign = 'center';
        var unitLabel = useC3 ? 'km\u00B2/s\u00B2' : 'km/s';
        ctx.fillText(unitLabel, barX + barW / 2, margin.top + barH + 15);
    }

    // ─── Hit Test: Get Grid Point at Pixel Coordinates ─────────────────
    function hitTest(canvas, data, x, y, options) {
        options = options || {};
        var margin = options.margin || DEFAULT_MARGIN;
        var plotW = canvas.width - margin.left - margin.right;
        var plotH = canvas.height - margin.top - margin.bottom;

        // Normalized coordinates within plot area
        var lx = (x - margin.left) / plotW;
        var ly = 1 - (y - margin.top) / plotH;

        if (lx < 0 || lx > 1 || ly < 0 || ly > 1) return null;

        var launch_jd = data.launch_jd_start + lx * (data.launch_jd_end - data.launch_jd_start);
        var arrival_jd = data.arrival_jd_start + ly * (data.arrival_jd_end - data.arrival_jd_start);

        // Find nearest valid grid point
        var best = null;
        var bestDist = Infinity;
        for (var i = 0; i < data.grid.length; i++) {
            var pt = data.grid[i];
            if (!pt.v) continue;
            var dl = pt.lj - launch_jd;
            var da = pt.aj - arrival_jd;
            var d = dl * dl + da * da;
            if (d < bestDist) {
                bestDist = d;
                best = pt;
            }
        }
        return best;
    }

    // ─── Draw Selection Highlight at a Specific Point ──────────────────
    function drawSelection(canvas, data, point, options) {
        if (!point) return;
        options = options || {};
        var ctx = canvas.getContext('2d');
        var margin = options.margin || DEFAULT_MARGIN;
        var plotW = canvas.width - margin.left - margin.right;
        var plotH = canvas.height - margin.top - margin.bottom;

        var ljRange = data.launch_jd_end - data.launch_jd_start;
        var ajRange = data.arrival_jd_end - data.arrival_jd_start;

        var px = margin.left + (point.lj - data.launch_jd_start) / ljRange * plotW;
        var py = margin.top + (1 - (point.aj - data.arrival_jd_start) / ajRange) * plotH;

        // Selection ring
        ctx.strokeStyle = '#4a9eff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, 2 * Math.PI);
        ctx.stroke();

        // Dashed crosshairs extending to axes
        ctx.strokeStyle = 'rgba(74, 158, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(px, margin.top);
        ctx.lineTo(px, margin.top + plotH);
        ctx.moveTo(margin.left, py);
        ctx.lineTo(margin.left + plotW, py);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // ─── Public API ────────────────────────────────────────────────────
    return {
        render: render,
        hitTest: hitTest,
        drawSelection: drawSelection,
        valueToColor: valueToColor
    };
})();
