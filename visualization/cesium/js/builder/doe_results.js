/**
 * DOEResults — Design of Experiments results visualization panel.
 *
 * Displays results from parameter sweep runs showing how different role
 * compositions (HVA, Defender, Attacker, Escort, Sweep) affect HVA survival
 * in Orbital Arena space combat simulations.
 *
 * Public API:
 *   DOEResults.showPanel(data)   — render full-screen results overlay
 *   DOEResults.hidePanel()       — remove results panel
 *   DOEResults.exportCSV(rows)   — download processed rows as CSV
 *   DOEResults.exportJSON(data)  — download raw data as JSON
 */
var DOEResults = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    var PANEL_ID = 'doe-results-panel';
    var STYLES_ID = 'doe-results-styles';

    var TAB_NAMES = ['datatable', 'heatmap', 'sensitivity', 'pareto', 'export'];
    var TAB_LABELS = ['DATA TABLE', 'HEAT MAP', 'SENSITIVITY', 'PARETO', 'EXPORT'];

    var ROLE_FIELDS = [
        { key: 'hva', label: 'HVA' },
        { key: 'def', label: 'Defender' },
        { key: 'atk', label: 'Attacker' },
        { key: 'esc', label: 'Escort' },
        { key: 'swp', label: 'Sweep' }
    ];

    var METRIC_OPTIONS = [
        { key: 'blueHvaPct', label: 'Blue HVA Survival' },
        { key: 'redHvaPct', label: 'Red HVA Survival' },
        { key: 'totalKills', label: 'Total Kills' },
        { key: 'simTime', label: 'Sim Time' }
    ];

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _panel = null;
    var _processedRows = null;
    var _rawData = null;
    var _sortColumn = null;
    var _sortAscending = true;
    var _chartInstances = [];
    var _renderedTabs = {};
    var _escapeHandler = null;
    var _heatMapTooltipHandler = null;

    // -------------------------------------------------------------------
    // Utility Functions
    // -------------------------------------------------------------------

    function _mean(arr) {
        if (!arr || arr.length === 0) return 0;
        var sum = 0;
        for (var i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
        return sum / arr.length;
    }

    function _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _fmtPct(rate) {
        if (rate === undefined || rate === null || isNaN(rate)) return '---';
        return (rate * 100).toFixed(1) + '%';
    }

    function _timestamp() {
        var d = new Date();
        var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
        return d.getFullYear() +
            pad(d.getMonth() + 1) +
            pad(d.getDate()) + '_' +
            pad(d.getHours()) +
            pad(d.getMinutes()) +
            pad(d.getSeconds());
    }

    function _downloadBlob(content, mimeType, filename) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    function _uniqueSorted(rows, field) {
        var seen = {};
        var vals = [];
        for (var i = 0; i < rows.length; i++) {
            var v = rows[i][field];
            if (!seen[v]) {
                seen[v] = true;
                vals.push(v);
            }
        }
        vals.sort(function(a, b) { return a - b; });
        return vals;
    }

    /**
     * Check which advanced parameters have variation across rows.
     * Returns { sma: bool, inc: bool, eng: bool, wpn: bool }
     */
    function _hasVariation(rows) {
        if (!rows || rows.length < 2) return { sma: false, inc: false, eng: false, wpn: false };
        var firstSma = rows[0].smaKm;
        var firstInc = rows[0].incDeg;
        var firstEng = rows[0].engRangeKm;
        var firstWpn = rows[0].weaponType;
        var sma = false, inc = false, eng = false, wpn = false;
        for (var i = 1; i < rows.length; i++) {
            if (rows[i].smaKm !== firstSma) sma = true;
            if (rows[i].incDeg !== firstInc) inc = true;
            if (rows[i].engRangeKm !== firstEng) eng = true;
            if (rows[i].weaponType !== firstWpn) wpn = true;
        }
        return { sma: sma, inc: inc, eng: eng, wpn: wpn };
    }

    function _pearsonCorrelation(xs, ys) {
        var n = xs.length;
        if (n < 2) return 0;
        var mx = _mean(xs), my = _mean(ys);
        var num = 0, dx2 = 0, dy2 = 0;
        for (var i = 0; i < n; i++) {
            var dx = xs[i] - mx;
            var dy = ys[i] - my;
            num += dx * dy;
            dx2 += dx * dx;
            dy2 += dy * dy;
        }
        var denom = Math.sqrt(dx2 * dy2);
        return denom > 0 ? num / denom : 0;
    }

    /**
     * Map a value (0..1) to an HSL color string.
     * 0 = red (hue 0), 1 = green (hue 120).
     */
    function _survivalColor(value) {
        var h = Math.max(0, Math.min(1, value)) * 120;
        return 'hsl(' + h.toFixed(0) + ', 70%, 25%)';
    }

    /**
     * Map a value (0..1) to a brighter HSL for canvas rendering.
     */
    function _survivalColorBright(value) {
        var h = Math.max(0, Math.min(1, value)) * 120;
        return 'hsl(' + h.toFixed(0) + ', 80%, 40%)';
    }

    // -------------------------------------------------------------------
    // Data Processing
    // -------------------------------------------------------------------

    function _processResults(data) {
        var rows = [];
        if (!data || !data.permutations || !Array.isArray(data.permutations)) {
            return rows;
        }

        for (var i = 0; i < data.permutations.length; i++) {
            try {
                var p = data.permutations[i];
                var cfg = p.config || {};

                // Check if this permutation has valid results
                var hasResults = p.results && p.results.runs && Array.isArray(p.results.runs) && p.results.runs.length > 0;
                var run = hasResults ? p.results.runs[0] : null;

                if (!run) {
                    // Permutation failed or returned no results — mark as ERROR
                    rows.push({
                        permId: i,
                        hva: cfg.hvaPerSide || 0,
                        def: cfg.defendersPerSide || 0,
                        atk: cfg.attackersPerSide || 0,
                        esc: cfg.escortsPerSide || 0,
                        swp: cfg.sweepsPerSide || 0,
                        totalPerSide: (cfg.hvaPerSide || 0) + (cfg.defendersPerSide || 0) +
                            (cfg.attackersPerSide || 0) + (cfg.escortsPerSide || 0) + (cfg.sweepsPerSide || 0),
                        smaKm: cfg.smaKm !== undefined ? cfg.smaKm : 42164,
                        incDeg: cfg.incDeg !== undefined ? cfg.incDeg : 0,
                        engRangeKm: cfg.engRangeKm !== undefined ? cfg.engRangeKm : 0,
                        weaponType: cfg.weaponType || 'kkv',
                        blueHvaPct: 0,
                        redHvaPct: 0,
                        blueAlive: 0,
                        blueTotal: 0,
                        redAlive: 0,
                        redTotal: 0,
                        totalKills: 0,
                        simTime: 0,
                        error: true
                    });
                    continue;
                }

                var surv = run.entitySurvival || {};

                var blueHvaAlive = 0, blueHvaTotal = 0;
                var redHvaAlive = 0, redHvaTotal = 0;
                var blueAlive = 0, blueTotal = 0;
                var redAlive = 0, redTotal = 0;

                var ids = Object.keys(surv);
                for (var j = 0; j < ids.length; j++) {
                    var e = surv[ids[j]];
                    if (e.team === 'blue') {
                        blueTotal++;
                        if (e.alive) blueAlive++;
                        if (e.role === 'hva') {
                            blueHvaTotal++;
                            if (e.alive) blueHvaAlive++;
                        }
                    } else if (e.team === 'red') {
                        redTotal++;
                        if (e.alive) redAlive++;
                        if (e.role === 'hva') {
                            redHvaTotal++;
                            if (e.alive) redHvaAlive++;
                        }
                    }
                }

                rows.push({
                    permId: i,
                    hva: cfg.hvaPerSide || 0,
                    def: cfg.defendersPerSide || 0,
                    atk: cfg.attackersPerSide || 0,
                    esc: cfg.escortsPerSide || 0,
                    swp: cfg.sweepsPerSide || 0,
                    totalPerSide: (cfg.hvaPerSide || 0) + (cfg.defendersPerSide || 0) +
                        (cfg.attackersPerSide || 0) + (cfg.escortsPerSide || 0) + (cfg.sweepsPerSide || 0),
                    smaKm: cfg.smaKm !== undefined ? cfg.smaKm : 42164,
                    incDeg: cfg.incDeg !== undefined ? cfg.incDeg : 0,
                    engRangeKm: cfg.engRangeKm !== undefined ? cfg.engRangeKm : 0,
                    weaponType: cfg.weaponType || 'kkv',
                    blueHvaPct: blueHvaTotal > 0 ? blueHvaAlive / blueHvaTotal : 0,
                    redHvaPct: redHvaTotal > 0 ? redHvaAlive / redHvaTotal : 0,
                    blueAlive: blueAlive,
                    blueTotal: blueTotal,
                    redAlive: redAlive,
                    redTotal: redTotal,
                    totalKills: (run.engagementLog || run.engagements || []).filter(function(e) {
                        return (e.result || e.type || '').toUpperCase() === 'KILL';
                    }).length,
                    simTime: run.simTimeFinal || 0
                });
            } catch (err) {
                // Catch any unexpected errors processing this permutation
                var errCfg = (data.permutations[i] && data.permutations[i].config) || {};
                rows.push({
                    permId: i,
                    hva: errCfg.hvaPerSide || 0,
                    def: errCfg.defendersPerSide || 0,
                    atk: errCfg.attackersPerSide || 0,
                    esc: errCfg.escortsPerSide || 0,
                    swp: errCfg.sweepsPerSide || 0,
                    totalPerSide: 0,
                    smaKm: errCfg.smaKm !== undefined ? errCfg.smaKm : 42164,
                    incDeg: errCfg.incDeg !== undefined ? errCfg.incDeg : 0,
                    engRangeKm: errCfg.engRangeKm !== undefined ? errCfg.engRangeKm : 0,
                    weaponType: errCfg.weaponType || 'kkv',
                    blueHvaPct: 0,
                    redHvaPct: 0,
                    blueAlive: 0,
                    blueTotal: 0,
                    redAlive: 0,
                    redTotal: 0,
                    totalKills: 0,
                    simTime: 0,
                    error: true
                });
                console.warn('[DOEResults] Error processing permutation ' + i + ':', err);
            }
        }
        return rows;
    }

    // -------------------------------------------------------------------
    // CSS Injection
    // -------------------------------------------------------------------

    function _injectStyles() {
        if (document.getElementById(STYLES_ID)) return;

        var P = '#' + PANEL_ID;
        var css = [
            // Panel overlay
            P + ' {',
            '  position: fixed;',
            '  top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(5, 8, 15, 0.97);',
            '  z-index: 72;',
            '  display: flex;',
            '  flex-direction: column;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 12px;',
            '  color: #e0e8f0;',
            '  box-sizing: border-box;',
            '}',
            '',
            // Header bar
            P + ' .doe-header {',
            '  height: 44px;',
            '  min-height: 44px;',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  background: rgba(8, 12, 22, 0.98);',
            '  border-bottom: 1px solid #1a2a44;',
            '  padding: 0 16px;',
            '}',
            '',
            P + ' .doe-title {',
            '  color: #00ccff;',
            '  font-size: 14px;',
            '  font-weight: bold;',
            '  letter-spacing: 2px;',
            '}',
            '',
            P + ' .doe-close {',
            '  color: #00ccff;',
            '  font-size: 20px;',
            '  cursor: pointer;',
            '  padding: 4px 10px;',
            '  border: 1px solid #00ccff;',
            '  border-radius: 3px;',
            '  background: transparent;',
            '  font-family: "Courier New", monospace;',
            '  line-height: 1;',
            '}',
            P + ' .doe-close:hover {',
            '  background: #00ccff;',
            '  color: #000;',
            '}',
            '',
            // Tab bar
            P + ' .doe-tabs {',
            '  display: flex;',
            '  gap: 0;',
            '  background: rgba(8, 12, 22, 0.95);',
            '  padding: 0 16px;',
            '  border-bottom: 1px solid #1a2a44;',
            '}',
            '',
            P + ' .doe-tab {',
            '  padding: 8px 18px;',
            '  background: transparent;',
            '  border: none;',
            '  border-bottom: 2px solid transparent;',
            '  color: #556;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '  letter-spacing: 1px;',
            '  text-transform: uppercase;',
            '}',
            P + ' .doe-tab:hover {',
            '  color: #aac;',
            '}',
            P + ' .doe-tab.active {',
            '  color: #00ccff;',
            '  border-bottom-color: #00ccff;',
            '}',
            '',
            // Content area
            P + ' .doe-content {',
            '  flex: 1;',
            '  overflow-y: auto;',
            '  padding: 16px;',
            '}',
            '',
            P + ' .doe-tab-content {',
            '  display: none;',
            '}',
            P + ' .doe-tab-content.active {',
            '  display: block;',
            '}',
            '',
            // Data table
            P + ' .doe-table-wrap {',
            '  overflow-x: auto;',
            '  overflow-y: auto;',
            '  max-height: calc(100vh - 140px);',
            '}',
            '',
            P + ' .doe-table {',
            '  width: 100%;',
            '  border-collapse: collapse;',
            '  white-space: nowrap;',
            '}',
            '',
            P + ' .doe-table th {',
            '  position: sticky;',
            '  top: 0;',
            '  background: rgba(8, 12, 22, 0.98);',
            '  color: #00ccff;',
            '  text-align: right;',
            '  padding: 6px 10px;',
            '  border-bottom: 2px solid #1a2a44;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '  user-select: none;',
            '  letter-spacing: 1px;',
            '}',
            P + ' .doe-table th:hover {',
            '  color: #66ddff;',
            '}',
            P + ' .doe-table th:first-child {',
            '  text-align: center;',
            '}',
            '',
            P + ' .doe-table td {',
            '  padding: 5px 10px;',
            '  text-align: right;',
            '  font-size: 12px;',
            '  border-bottom: 1px solid #0f1525;',
            '}',
            P + ' .doe-table td:first-child {',
            '  text-align: center;',
            '  color: #556;',
            '}',
            '',
            P + ' .doe-table tr:nth-child(even) td {',
            '  background: #0a0e17;',
            '}',
            P + ' .doe-table tr:nth-child(odd) td {',
            '  background: #0d1220;',
            '}',
            P + ' .doe-table tr:hover td {',
            '  background: rgba(0, 204, 255, 0.08);',
            '}',
            '',
            // Heat map controls
            P + ' .doe-heatmap-controls {',
            '  display: flex;',
            '  gap: 16px;',
            '  align-items: center;',
            '  margin-bottom: 12px;',
            '  flex-wrap: wrap;',
            '}',
            P + ' .doe-heatmap-controls label {',
            '  color: #889;',
            '  font-size: 11px;',
            '  letter-spacing: 1px;',
            '}',
            P + ' .doe-heatmap-controls select {',
            '  background: #0d1220;',
            '  color: #e0e8f0;',
            '  border: 1px solid #1a2a44;',
            '  border-radius: 3px;',
            '  padding: 4px 8px;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '}',
            '',
            P + ' .doe-heatmap-wrap {',
            '  display: flex;',
            '  justify-content: center;',
            '  position: relative;',
            '}',
            P + ' .doe-heatmap-tooltip {',
            '  position: absolute;',
            '  background: rgba(0, 0, 0, 0.9);',
            '  color: #00ccff;',
            '  padding: 6px 10px;',
            '  border: 1px solid #00ccff;',
            '  border-radius: 3px;',
            '  font-size: 11px;',
            '  pointer-events: none;',
            '  white-space: nowrap;',
            '  z-index: 10;',
            '  display: none;',
            '}',
            '',
            // Sensitivity section
            P + ' .doe-sensitivity-controls {',
            '  display: flex;',
            '  gap: 16px;',
            '  align-items: center;',
            '  margin-bottom: 12px;',
            '}',
            P + ' .doe-sensitivity-controls label {',
            '  color: #889;',
            '  font-size: 11px;',
            '  letter-spacing: 1px;',
            '}',
            P + ' .doe-sensitivity-controls select {',
            '  background: #0d1220;',
            '  color: #e0e8f0;',
            '  border: 1px solid #1a2a44;',
            '  border-radius: 3px;',
            '  padding: 4px 8px;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '}',
            P + ' .doe-chart-wrap {',
            '  position: relative;',
            '  background: rgba(0, 0, 0, 0.3);',
            '  border-radius: 4px;',
            '  padding: 12px;',
            '  max-width: 700px;',
            '}',
            '',
            // Export section
            P + ' .doe-export-section {',
            '  max-width: 700px;',
            '}',
            P + ' .doe-export-btns {',
            '  display: flex;',
            '  gap: 12px;',
            '  margin-bottom: 20px;',
            '}',
            P + ' .doe-export-btn {',
            '  padding: 8px 20px;',
            '  border: 1px solid #00ccff;',
            '  border-radius: 3px;',
            '  background: transparent;',
            '  color: #00ccff;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 12px;',
            '  cursor: pointer;',
            '  letter-spacing: 1px;',
            '}',
            P + ' .doe-export-btn:hover {',
            '  background: #00ccff;',
            '  color: #000;',
            '}',
            '',
            P + ' .doe-summary-box {',
            '  background: rgba(0, 0, 0, 0.3);',
            '  border: 1px solid #1a2a44;',
            '  border-radius: 4px;',
            '  padding: 16px;',
            '  line-height: 1.8;',
            '}',
            P + ' .doe-summary-box .doe-sum-label {',
            '  color: #889;',
            '}',
            P + ' .doe-summary-box .doe-sum-value {',
            '  color: #00ccff;',
            '  font-weight: bold;',
            '}',
            P + ' .doe-summary-box .doe-sum-config {',
            '  color: #6f8;',
            '}',
            P + ' .doe-summary-box .doe-sum-worst {',
            '  color: #f86;',
            '}',
            '',
            // Best config highlight box
            P + ' .doe-best-config {',
            '  background: rgba(0, 100, 50, 0.2);',
            '  border: 1px solid #00cc66;',
            '  border-radius: 4px;',
            '  padding: 12px 16px;',
            '  margin-bottom: 16px;',
            '  line-height: 1.8;',
            '}',
            P + ' .doe-best-config .doe-best-title {',
            '  color: #00cc66;',
            '  font-size: 12px;',
            '  font-weight: bold;',
            '  letter-spacing: 1px;',
            '  text-transform: uppercase;',
            '  margin-bottom: 4px;',
            '}',
            P + ' .doe-best-config .doe-best-value {',
            '  color: #00ff88;',
            '  font-weight: bold;',
            '}',
            P + ' .doe-best-config .doe-best-label {',
            '  color: #889;',
            '}',
            '',
            // Pareto tab
            P + ' .doe-pareto-controls {',
            '  display: flex;',
            '  gap: 16px;',
            '  align-items: center;',
            '  margin-bottom: 12px;',
            '  flex-wrap: wrap;',
            '}',
            P + ' .doe-pareto-controls label {',
            '  color: #889;',
            '  font-size: 11px;',
            '  letter-spacing: 1px;',
            '}',
            P + ' .doe-pareto-controls select {',
            '  background: #0d1220;',
            '  color: #e0e8f0;',
            '  border: 1px solid #1a2a44;',
            '  border-radius: 3px;',
            '  padding: 4px 8px;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '}',
            P + ' .doe-pareto-wrap {',
            '  display: flex;',
            '  justify-content: center;',
            '  position: relative;',
            '}',
            P + ' .doe-pareto-tooltip {',
            '  position: absolute;',
            '  background: rgba(0, 0, 0, 0.9);',
            '  color: #00ccff;',
            '  padding: 6px 10px;',
            '  border: 1px solid #00ccff;',
            '  border-radius: 3px;',
            '  font-size: 11px;',
            '  pointer-events: none;',
            '  white-space: nowrap;',
            '  z-index: 10;',
            '  display: none;',
            '}',
            '',
            // Export status message
            P + ' .doe-export-status {',
            '  font-size: 11px;',
            '  color: #889;',
            '  margin-top: 8px;',
            '  min-height: 16px;',
            '}',
            P + ' .doe-export-status.success { color: #00cc66; }',
            P + ' .doe-export-status.error { color: #ff4444; }',
            '',
            // Scrollbar
            P + ' .doe-content::-webkit-scrollbar {',
            '  width: 6px;',
            '}',
            P + ' .doe-content::-webkit-scrollbar-track {',
            '  background: #0a0e17;',
            '}',
            P + ' .doe-content::-webkit-scrollbar-thumb {',
            '  background: #00ccff;',
            '  border-radius: 3px;',
            '}',
            P + ' .doe-table-wrap::-webkit-scrollbar {',
            '  width: 5px;',
            '}',
            P + ' .doe-table-wrap::-webkit-scrollbar-track {',
            '  background: #0a0e17;',
            '}',
            P + ' .doe-table-wrap::-webkit-scrollbar-thumb {',
            '  background: #334;',
            '  border-radius: 3px;',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.id = STYLES_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------
    // Tab 1: Data Table
    // -------------------------------------------------------------------

    function _renderDataTable(rows) {
        var container = document.getElementById('doe-tab-datatable');
        if (!container) return;

        // Best configuration summary box
        var html = '';
        var best = _findBestConfig(rows, 'blueHvaPct', true);
        if (best && rows.length > 1) {
            html += '<div class="doe-best-config">';
            html += '<div class="doe-best-title">Best Configuration</div>';
            html += '<div><span class="doe-best-label">Blue HVA Survival: </span>';
            html += '<span class="doe-best-value">' + (best.blueHvaPct * 100).toFixed(1) + '%</span></div>';
            html += '<div><span class="doe-best-label">Composition: </span>';
            html += '<span class="doe-best-value">HVA=' + best.hva + ' DEF=' + best.def +
                ' ATK=' + best.atk + ' ESC=' + best.esc + ' SWP=' + best.swp + '</span></div>';
            html += '<div><span class="doe-best-label">Total per side: </span>';
            html += '<span class="doe-best-value">' + best.totalPerSide + '</span>';
            html += '<span class="doe-best-label"> | Kills: </span>';
            html += '<span class="doe-best-value">' + best.totalKills + '</span>';
            html += '<span class="doe-best-label"> | Sim time: </span>';
            html += '<span class="doe-best-value">' + best.simTime.toFixed(1) + 's</span></div>';
            // Show advanced params if present
            if (best.smaKm !== undefined && best.smaKm !== 42164) {
                html += '<div><span class="doe-best-label">SMA: </span>';
                html += '<span class="doe-best-value">' + best.smaKm + ' km</span></div>';
            }
            if (best.incDeg !== undefined && best.incDeg !== 0) {
                html += '<div><span class="doe-best-label">Inclination: </span>';
                html += '<span class="doe-best-value">' + best.incDeg + '\u00B0</span></div>';
            }
            if (best.weaponType !== undefined && best.weaponType !== 'kkv') {
                html += '<div><span class="doe-best-label">Weapon: </span>';
                html += '<span class="doe-best-value">' + best.weaponType.toUpperCase() + '</span></div>';
            }
            html += '</div>';
        }

        html += '<div class="doe-table-wrap" id="doe-table-wrap">';
        html += _buildTableHTML(rows, _sortColumn, _sortAscending);
        html += '</div>';

        container.innerHTML = html;

        // Table header sort click handler
        var wrap = document.getElementById('doe-table-wrap');
        if (wrap) {
            wrap.addEventListener('click', function(e) {
                var th = e.target;
                if (th.tagName !== 'TH') return;
                var col = th.getAttribute('data-col');
                if (!col) return;

                if (_sortColumn === col) {
                    _sortAscending = !_sortAscending;
                } else {
                    _sortColumn = col;
                    _sortAscending = true;
                }

                wrap.innerHTML = _buildTableHTML(_processedRows, _sortColumn, _sortAscending);
            });
        }
    }

    function _buildTableHTML(rows, sortCol, asc) {
        var sorted = rows.slice();
        if (sortCol) {
            sorted.sort(function(a, b) {
                var va = a[sortCol];
                var vb = b[sortCol];
                // Handle string comparison for weaponType
                if (typeof va === 'string' && typeof vb === 'string') {
                    return asc ? va.localeCompare(vb) : vb.localeCompare(va);
                }
                if (va === vb) return 0;
                var cmp = va < vb ? -1 : 1;
                return asc ? cmp : -cmp;
            });
        }

        var arrow = asc ? ' \u25B2' : ' \u25BC';

        var columns = [
            { key: 'permId', label: '#' },
            { key: 'hva', label: 'HVA' },
            { key: 'def', label: 'DEF' },
            { key: 'atk', label: 'ATK' },
            { key: 'esc', label: 'ESC' },
            { key: 'swp', label: 'SWP' },
            { key: 'totalPerSide', label: 'Total' }
        ];

        // Conditionally add advanced parameter columns if they vary
        var hasAdvanced = _hasVariation(rows);
        if (hasAdvanced.sma) columns.push({ key: 'smaKm', label: 'SMA(km)' });
        if (hasAdvanced.inc) columns.push({ key: 'incDeg', label: 'Inc(\u00B0)' });
        if (hasAdvanced.eng) columns.push({ key: 'engRangeKm', label: 'Eng(km)' });
        if (hasAdvanced.wpn) columns.push({ key: 'weaponType', label: 'Weapon' });

        columns.push(
            { key: 'blueHvaPct', label: 'Blue HVA%' },
            { key: 'redHvaPct', label: 'Red HVA%' },
            { key: 'blueAlive', label: 'Blue Alive' },
            { key: 'redAlive', label: 'Red Alive' },
            { key: 'totalKills', label: 'Kills' },
            { key: 'simTime', label: 'Time' }
        );

        var html = '<table class="doe-table">';

        // Header row
        html += '<tr>';
        for (var c = 0; c < columns.length; c++) {
            var col = columns[c];
            html += '<th data-col="' + col.key + '">' + col.label;
            if (sortCol === col.key) html += arrow;
            html += '</th>';
        }
        html += '</tr>';

        // Data rows
        var advColCount = (hasAdvanced.sma ? 1 : 0) + (hasAdvanced.inc ? 1 : 0) +
            (hasAdvanced.eng ? 1 : 0) + (hasAdvanced.wpn ? 1 : 0);
        for (var i = 0; i < sorted.length; i++) {
            var r = sorted[i];
            html += '<tr>';
            html += '<td>' + r.permId + '</td>';
            html += '<td>' + r.hva + '</td>';
            html += '<td>' + r.def + '</td>';
            html += '<td>' + r.atk + '</td>';
            html += '<td>' + r.esc + '</td>';
            html += '<td>' + r.swp + '</td>';
            html += '<td>' + r.totalPerSide + '</td>';

            // Advanced columns
            if (hasAdvanced.sma) html += '<td>' + (r.smaKm || 42164) + '</td>';
            if (hasAdvanced.inc) html += '<td>' + (r.incDeg || 0) + '</td>';
            if (hasAdvanced.eng) html += '<td>' + (r.engRangeKm || 0) + '</td>';
            if (hasAdvanced.wpn) html += '<td>' + _escapeHtml((r.weaponType || 'kkv').toUpperCase()) + '</td>';

            if (r.error) {
                // Failed permutation — show ERROR across result columns
                html += '<td colspan="6" style="background:#3a1111;color:#ff4444;text-align:center;font-weight:bold;">ERROR</td>';
            } else {
                // Blue HVA% with color-coded background
                var blueHvaBg = _survivalColor(r.blueHvaPct);
                html += '<td style="background:' + blueHvaBg + ';color:#fff;">' +
                    (r.blueHvaPct * 100).toFixed(1) + '%</td>';

                // Red HVA% with color-coded background
                var redHvaBg = _survivalColor(r.redHvaPct);
                html += '<td style="background:' + redHvaBg + ';color:#fff;">' +
                    (r.redHvaPct * 100).toFixed(1) + '%</td>';

                html += '<td>' + r.blueAlive + '/' + r.blueTotal + '</td>';
                html += '<td>' + r.redAlive + '/' + r.redTotal + '</td>';
                html += '<td>' + r.totalKills + '</td>';
                html += '<td>' + r.simTime.toFixed(1) + 's</td>';
            }
            html += '</tr>';
        }

        html += '</table>';
        return html;
    }

    // -------------------------------------------------------------------
    // Tab 2: Heat Map
    // -------------------------------------------------------------------

    function _renderHeatMap(rows) {
        var container = document.getElementById('doe-tab-heatmap');
        if (!container) return;

        // Build axis fields: roles + any varying advanced numeric params
        var hasAdv = _hasVariation(rows);
        var axisFields = ROLE_FIELDS.slice();
        if (hasAdv.sma) axisFields.push({ key: 'smaKm', label: 'SMA (km)' });
        if (hasAdv.inc) axisFields.push({ key: 'incDeg', label: 'Inclination' });
        if (hasAdv.eng) axisFields.push({ key: 'engRangeKm', label: 'Eng Range (km)' });

        // Build controls
        var html = '<div class="doe-heatmap-controls">';

        // X Axis dropdown
        html += '<label>X AXIS </label>';
        html += '<select id="doe-hm-x">';
        for (var i = 0; i < axisFields.length; i++) {
            var sel = (axisFields[i].key === 'atk') ? ' selected' : '';
            html += '<option value="' + axisFields[i].key + '"' + sel + '>' +
                axisFields[i].label + '</option>';
        }
        html += '</select>';

        // Y Axis dropdown
        html += '<label>Y AXIS </label>';
        html += '<select id="doe-hm-y">';
        for (var j = 0; j < axisFields.length; j++) {
            var sel2 = (axisFields[j].key === 'def') ? ' selected' : '';
            html += '<option value="' + axisFields[j].key + '"' + sel2 + '>' +
                axisFields[j].label + '</option>';
        }
        html += '</select>';

        // Metric dropdown
        html += '<label>METRIC </label>';
        html += '<select id="doe-hm-metric">';
        for (var k = 0; k < METRIC_OPTIONS.length; k++) {
            html += '<option value="' + METRIC_OPTIONS[k].key + '">' +
                METRIC_OPTIONS[k].label + '</option>';
        }
        html += '</select>';

        html += '</div>';

        // Canvas and tooltip
        html += '<div class="doe-heatmap-wrap" id="doe-hm-wrap">';
        html += '<canvas id="doe-hm-canvas" width="600" height="500"></canvas>';
        html += '<div class="doe-heatmap-tooltip" id="doe-hm-tooltip"></div>';
        html += '</div>';

        container.innerHTML = html;

        // Initial render
        _drawHeatMap(rows);

        // Change event listeners
        var xSel = document.getElementById('doe-hm-x');
        var ySel = document.getElementById('doe-hm-y');
        var mSel = document.getElementById('doe-hm-metric');
        var onChange = function() { _drawHeatMap(_processedRows); };
        if (xSel) xSel.addEventListener('change', onChange);
        if (ySel) ySel.addEventListener('change', onChange);
        if (mSel) mSel.addEventListener('change', onChange);
    }

    function _drawHeatMap(rows) {
        var canvas = document.getElementById('doe-hm-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');

        var xField = document.getElementById('doe-hm-x').value;
        var yField = document.getElementById('doe-hm-y').value;
        var metricKey = document.getElementById('doe-hm-metric').value;

        var metricLabel = metricKey;
        for (var m = 0; m < METRIC_OPTIONS.length; m++) {
            if (METRIC_OPTIONS[m].key === metricKey) {
                metricLabel = METRIC_OPTIONS[m].label;
                break;
            }
        }

        // Resolve axis labels from both role fields and advanced fields
        var allAxisFields = ROLE_FIELDS.slice();
        allAxisFields.push({ key: 'smaKm', label: 'SMA (km)' });
        allAxisFields.push({ key: 'incDeg', label: 'Inclination' });
        allAxisFields.push({ key: 'engRangeKm', label: 'Eng Range (km)' });

        var xLabel = xField;
        var yLabel = yField;
        for (var rf = 0; rf < allAxisFields.length; rf++) {
            if (allAxisFields[rf].key === xField) xLabel = allAxisFields[rf].label;
            if (allAxisFields[rf].key === yField) yLabel = allAxisFields[rf].label;
        }

        var xVals = _uniqueSorted(rows, xField);
        var yVals = _uniqueSorted(rows, yField);

        // Build 2D grid
        var grid = {};
        for (var i = 0; i < rows.length; i++) {
            var key = rows[i][xField] + ',' + rows[i][yField];
            if (!grid[key]) grid[key] = { sum: 0, count: 0 };
            grid[key].sum += rows[i][metricKey];
            grid[key].count++;
        }

        // Find min/max of averaged metric for normalization
        var metricMin = Infinity, metricMax = -Infinity;
        var gKeys = Object.keys(grid);
        for (var g = 0; g < gKeys.length; g++) {
            var avg = grid[gKeys[g]].sum / grid[gKeys[g]].count;
            if (avg < metricMin) metricMin = avg;
            if (avg > metricMax) metricMax = avg;
        }
        if (metricMin === metricMax) {
            metricMin = 0;
            metricMax = Math.max(1, metricMax);
        }

        // Layout
        var marginLeft = 60;
        var marginTop = 40;
        var marginRight = 60;
        var marginBottom = 50;
        var plotW = canvas.width - marginLeft - marginRight;
        var plotH = canvas.height - marginTop - marginBottom;

        var cellW = xVals.length > 0 ? plotW / xVals.length : plotW;
        var cellH = yVals.length > 0 ? plotH / yVals.length : plotH;

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#080c14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Title
        ctx.fillStyle = '#00ccff';
        ctx.font = 'bold 12px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(metricLabel.toUpperCase(), canvas.width / 2, 20);

        // Draw cells
        // Store cell rects for tooltip
        var cellRects = [];

        for (var xi = 0; xi < xVals.length; xi++) {
            for (var yi = 0; yi < yVals.length; yi++) {
                var cKey = xVals[xi] + ',' + yVals[yi];
                var cx = marginLeft + xi * cellW;
                var cy = marginTop + yi * cellH;

                if (grid[cKey]) {
                    var val = grid[cKey].sum / grid[cKey].count;
                    var norm = (val - metricMin) / (metricMax - metricMin);
                    ctx.fillStyle = _survivalColorBright(norm);
                    ctx.fillRect(cx + 1, cy + 1, cellW - 2, cellH - 2);

                    // Show value text in cell if cells are large enough
                    if (cellW > 35 && cellH > 20) {
                        ctx.fillStyle = '#fff';
                        ctx.font = '10px "Courier New", monospace';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        var displayVal;
                        if (metricKey === 'blueHvaPct' || metricKey === 'redHvaPct') {
                            displayVal = (val * 100).toFixed(0) + '%';
                        } else if (metricKey === 'simTime') {
                            displayVal = val.toFixed(0) + 's';
                        } else {
                            displayVal = val.toFixed(0);
                        }
                        ctx.fillText(displayVal, cx + cellW / 2, cy + cellH / 2);
                    }

                    cellRects.push({
                        x: cx, y: cy, w: cellW, h: cellH,
                        xVal: xVals[xi], yVal: yVals[yi],
                        value: val, count: grid[cKey].count
                    });
                } else {
                    // No data
                    ctx.fillStyle = '#1a1a2a';
                    ctx.fillRect(cx + 1, cy + 1, cellW - 2, cellH - 2);
                }
            }
        }

        // X axis labels
        ctx.fillStyle = '#889';
        ctx.font = '10px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (var xl = 0; xl < xVals.length; xl++) {
            ctx.fillText('' + xVals[xl],
                marginLeft + xl * cellW + cellW / 2,
                marginTop + plotH + 6);
        }
        // X axis title
        ctx.fillStyle = '#00ccff';
        ctx.font = '11px "Courier New", monospace';
        ctx.fillText(xLabel, marginLeft + plotW / 2, canvas.height - 8);

        // Y axis labels
        ctx.fillStyle = '#889';
        ctx.font = '10px "Courier New", monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var yl = 0; yl < yVals.length; yl++) {
            ctx.fillText('' + yVals[yl],
                marginLeft - 8,
                marginTop + yl * cellH + cellH / 2);
        }
        // Y axis title (rotated)
        ctx.save();
        ctx.fillStyle = '#00ccff';
        ctx.font = '11px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.translate(12, marginTop + plotH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();

        // Legend bar (right side)
        var legX = canvas.width - marginRight + 15;
        var legY = marginTop;
        var legW = 14;
        var legH = plotH;
        for (var li = 0; li < legH; li++) {
            var lNorm = 1 - (li / legH);
            ctx.fillStyle = _survivalColorBright(lNorm);
            ctx.fillRect(legX, legY + li, legW, 1);
        }
        ctx.strokeStyle = '#334';
        ctx.strokeRect(legX, legY, legW, legH);

        ctx.fillStyle = '#889';
        ctx.font = '9px "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        // Top label (max)
        var maxLabel;
        if (metricKey === 'blueHvaPct' || metricKey === 'redHvaPct') {
            maxLabel = (metricMax * 100).toFixed(0) + '%';
        } else {
            maxLabel = metricMax.toFixed(0);
        }
        ctx.fillText(maxLabel, legX + legW + 4, legY);
        // Bottom label (min)
        ctx.textBaseline = 'bottom';
        var minLabel;
        if (metricKey === 'blueHvaPct' || metricKey === 'redHvaPct') {
            minLabel = (metricMin * 100).toFixed(0) + '%';
        } else {
            minLabel = metricMin.toFixed(0);
        }
        ctx.fillText(minLabel, legX + legW + 4, legY + legH);

        // Tooltip on mouse move
        if (_heatMapTooltipHandler) {
            canvas.removeEventListener('mousemove', _heatMapTooltipHandler);
            canvas.removeEventListener('mouseleave', _heatMapTooltipHandler);
        }

        var tooltip = document.getElementById('doe-hm-tooltip');
        _heatMapTooltipHandler = function(e) {
            if (e.type === 'mouseleave') {
                if (tooltip) tooltip.style.display = 'none';
                return;
            }
            var rect = canvas.getBoundingClientRect();
            var mx = e.clientX - rect.left;
            var my = e.clientY - rect.top;

            var found = null;
            for (var ci = 0; ci < cellRects.length; ci++) {
                var cr = cellRects[ci];
                if (mx >= cr.x && mx < cr.x + cr.w && my >= cr.y && my < cr.y + cr.h) {
                    found = cr;
                    break;
                }
            }

            if (found && tooltip) {
                var tipVal;
                if (metricKey === 'blueHvaPct' || metricKey === 'redHvaPct') {
                    tipVal = (found.value * 100).toFixed(1) + '%';
                } else if (metricKey === 'simTime') {
                    tipVal = found.value.toFixed(1) + 's';
                } else {
                    tipVal = found.value.toFixed(1);
                }
                tooltip.textContent = xLabel + '=' + found.xVal + ', ' +
                    yLabel + '=' + found.yVal + ': ' + metricLabel + ' ' + tipVal;
                // Position tooltip near mouse
                var wrap = document.getElementById('doe-hm-wrap');
                var wrapRect = wrap.getBoundingClientRect();
                tooltip.style.left = (e.clientX - wrapRect.left + 12) + 'px';
                tooltip.style.top = (e.clientY - wrapRect.top - 30) + 'px';
                tooltip.style.display = 'block';
            } else if (tooltip) {
                tooltip.style.display = 'none';
            }
        };

        canvas.addEventListener('mousemove', _heatMapTooltipHandler);
        canvas.addEventListener('mouseleave', _heatMapTooltipHandler);
    }

    // -------------------------------------------------------------------
    // Tab 3: Sensitivity Analysis
    // -------------------------------------------------------------------

    function _renderSensitivity(rows) {
        var container = document.getElementById('doe-tab-sensitivity');
        if (!container) return;

        // Controls
        var html = '<div class="doe-sensitivity-controls">';
        html += '<label>METRIC </label>';
        html += '<select id="doe-sens-metric">';
        for (var k = 0; k < METRIC_OPTIONS.length; k++) {
            html += '<option value="' + METRIC_OPTIONS[k].key + '">' +
                METRIC_OPTIONS[k].label + '</option>';
        }
        html += '</select>';
        html += '</div>';

        html += '<div class="doe-chart-wrap" id="doe-sens-chart-wrap"></div>';

        container.innerHTML = html;

        // Initial render
        _drawSensitivityChart(rows);

        // Change listener
        var sel = document.getElementById('doe-sens-metric');
        if (sel) {
            sel.addEventListener('change', function() {
                _drawSensitivityChart(_processedRows);
            });
        }
    }

    function _drawSensitivityChart(rows) {
        var wrap = document.getElementById('doe-sens-chart-wrap');
        if (!wrap) return;

        var metricKey = document.getElementById('doe-sens-metric').value;
        var metricLabel = metricKey;
        for (var m = 0; m < METRIC_OPTIONS.length; m++) {
            if (METRIC_OPTIONS[m].key === metricKey) {
                metricLabel = METRIC_OPTIONS[m].label;
                break;
            }
        }

        // Compute correlations
        var metricVals = [];
        for (var i = 0; i < rows.length; i++) {
            metricVals.push(rows[i][metricKey]);
        }

        // Build list of sensitivity factors: roles + any varying advanced params
        var sensFields = ROLE_FIELDS.slice(); // copy base role fields
        var hasAdv = _hasVariation(rows);
        if (hasAdv.sma) sensFields.push({ key: 'smaKm', label: 'SMA (km)' });
        if (hasAdv.inc) sensFields.push({ key: 'incDeg', label: 'Inclination' });
        if (hasAdv.eng) sensFields.push({ key: 'engRangeKm', label: 'Eng Range' });
        // Note: weaponType is categorical, not numeric -- skip Pearson for it

        var labels = [];
        var correlations = [];
        var bgColors = [];
        for (var r = 0; r < sensFields.length; r++) {
            var roleVals = [];
            for (var j = 0; j < rows.length; j++) {
                roleVals.push(rows[j][sensFields[r].key]);
            }
            var corr = _pearsonCorrelation(roleVals, metricVals);
            labels.push(sensFields[r].label);
            correlations.push(parseFloat(corr.toFixed(4)));
            bgColors.push(corr >= 0 ? '#22cc44' : '#cc4422');
        }

        // Destroy old chart instances in this wrap
        _destroySensitivityChart();

        // Try Chart.js first, then fall back to canvas
        if (typeof Chart !== 'undefined') {
            wrap.innerHTML = '<canvas id="doe-sens-canvas"></canvas>';
            var canvas = document.getElementById('doe-sens-canvas');
            var chart = new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Correlation',
                        data: correlations,
                        backgroundColor: bgColors,
                        borderWidth: 0
                    }]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: true,
                    scales: {
                        x: {
                            min: -1, max: 1,
                            ticks: {
                                color: '#888',
                                font: { family: '"Courier New", monospace', size: 10 },
                                stepSize: 0.25
                            },
                            grid: { color: '#1a2a44' },
                            title: {
                                display: true,
                                text: 'Pearson Correlation',
                                color: '#889',
                                font: { family: '"Courier New", monospace', size: 11 }
                            }
                        },
                        y: {
                            ticks: {
                                color: '#ccc',
                                font: { family: '"Courier New", monospace', size: 12 }
                            },
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        title: {
                            display: true,
                            text: 'IMPACT ON ' + metricLabel.toUpperCase(),
                            color: '#00ccff',
                            font: { family: '"Courier New", monospace', size: 13, weight: 'bold' }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) {
                                    return ctx.label + ': r = ' + ctx.parsed.x.toFixed(4);
                                }
                            }
                        }
                    }
                }
            });
            _chartInstances.push(chart);
        } else {
            // Fallback: simple canvas bar chart
            wrap.innerHTML = '<canvas id="doe-sens-canvas" width="600" height="300"></canvas>';
            var fbCanvas = document.getElementById('doe-sens-canvas');
            var ctx = fbCanvas.getContext('2d');

            ctx.clearRect(0, 0, fbCanvas.width, fbCanvas.height);
            ctx.fillStyle = '#080c14';
            ctx.fillRect(0, 0, fbCanvas.width, fbCanvas.height);

            // Title
            ctx.fillStyle = '#00ccff';
            ctx.font = 'bold 13px "Courier New", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('IMPACT ON ' + metricLabel.toUpperCase(), fbCanvas.width / 2, 22);

            var mLeft = 80;
            var mTop = 40;
            var mRight = 40;
            var mBottom = 30;
            var pW = fbCanvas.width - mLeft - mRight;
            var pH = fbCanvas.height - mTop - mBottom;
            var barH = pH / labels.length - 4;
            var centerX = mLeft + pW / 2;

            // Zero line
            ctx.strokeStyle = '#334';
            ctx.beginPath();
            ctx.moveTo(centerX, mTop);
            ctx.lineTo(centerX, mTop + pH);
            ctx.stroke();

            for (var b = 0; b < labels.length; b++) {
                var by = mTop + b * (barH + 4);
                var barWidth = Math.abs(correlations[b]) * (pW / 2);
                var bx = correlations[b] >= 0 ? centerX : centerX - barWidth;

                ctx.fillStyle = bgColors[b];
                ctx.fillRect(bx, by, barWidth, barH);

                // Label
                ctx.fillStyle = '#ccc';
                ctx.font = '11px "Courier New", monospace';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(labels[b], mLeft - 6, by + barH / 2);

                // Value
                ctx.fillStyle = '#fff';
                ctx.textAlign = correlations[b] >= 0 ? 'left' : 'right';
                var valX = correlations[b] >= 0 ? bx + barWidth + 4 : bx - 4;
                ctx.fillText(correlations[b].toFixed(3), valX, by + barH / 2);
            }

            // X axis labels
            ctx.fillStyle = '#889';
            ctx.font = '9px "Courier New", monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText('-1.0', mLeft, mTop + pH + 4);
            ctx.fillText('0', centerX, mTop + pH + 4);
            ctx.fillText('+1.0', mLeft + pW, mTop + pH + 4);
        }
    }

    function _destroySensitivityChart() {
        // Remove chart instances created by sensitivity tab
        var newInstances = [];
        for (var i = 0; i < _chartInstances.length; i++) {
            var c = _chartInstances[i];
            if (c.canvas && c.canvas.id === 'doe-sens-canvas') {
                c.destroy();
            } else {
                newInstances.push(c);
            }
        }
        _chartInstances = newInstances;
    }

    // -------------------------------------------------------------------
    // Tab 4: Pareto Front
    // -------------------------------------------------------------------

    var _paretoTooltipHandler = null;

    var PARETO_OBJECTIVES = [
        { key: 'blueHvaPct', label: 'Blue HVA Survival', higher: true },
        { key: 'redHvaPct', label: 'Red HVA Survival', higher: true },
        { key: 'totalKills', label: 'Total Kills', higher: false },
        { key: 'totalPerSide', label: 'Entity Count (Cost)', higher: false },
        { key: 'simTime', label: 'Sim Time', higher: false }
    ];

    function _renderPareto(rows) {
        var container = document.getElementById('doe-tab-pareto');
        if (!container) return;

        var html = '<div class="doe-pareto-controls">';

        // X axis objective
        html += '<label>X AXIS </label>';
        html += '<select id="doe-pareto-x">';
        for (var i = 0; i < PARETO_OBJECTIVES.length; i++) {
            var sel = (PARETO_OBJECTIVES[i].key === 'totalPerSide') ? ' selected' : '';
            html += '<option value="' + PARETO_OBJECTIVES[i].key + '"' + sel + '>' +
                PARETO_OBJECTIVES[i].label + '</option>';
        }
        html += '</select>';

        // Y axis objective
        html += '<label>Y AXIS </label>';
        html += '<select id="doe-pareto-y">';
        for (var j = 0; j < PARETO_OBJECTIVES.length; j++) {
            var sel2 = (PARETO_OBJECTIVES[j].key === 'blueHvaPct') ? ' selected' : '';
            html += '<option value="' + PARETO_OBJECTIVES[j].key + '"' + sel2 + '>' +
                PARETO_OBJECTIVES[j].label + '</option>';
        }
        html += '</select>';

        html += '</div>';

        html += '<div class="doe-pareto-wrap" id="doe-pareto-wrap">';
        html += '<canvas id="doe-pareto-canvas" width="700" height="500"></canvas>';
        html += '<div class="doe-pareto-tooltip" id="doe-pareto-tooltip"></div>';
        html += '</div>';

        container.innerHTML = html;

        _drawPareto(rows);

        var xSel = document.getElementById('doe-pareto-x');
        var ySel = document.getElementById('doe-pareto-y');
        var onChange = function() { _drawPareto(_processedRows); };
        if (xSel) xSel.addEventListener('change', onChange);
        if (ySel) ySel.addEventListener('change', onChange);
    }

    /**
     * Compute the Pareto front for two objectives.
     * @param {Array} rows - data rows
     * @param {string} xKey - x axis field
     * @param {string} yKey - y axis field
     * @param {boolean} xHigher - true if higher x is better
     * @param {boolean} yHigher - true if higher y is better
     * @returns {Array} indices of Pareto-optimal rows
     */
    function _computeParetoFront(rows, xKey, yKey, xHigher, yHigher) {
        var dominated = new Array(rows.length);
        for (var i = 0; i < rows.length; i++) dominated[i] = false;

        for (var a = 0; a < rows.length; a++) {
            if (dominated[a]) continue;
            for (var b = 0; b < rows.length; b++) {
                if (a === b || dominated[b]) continue;

                // Check if a dominates b
                var ax = rows[a][xKey], ay = rows[a][yKey];
                var bx = rows[b][xKey], by = rows[b][yKey];

                var aDomX = xHigher ? (ax >= bx) : (ax <= bx);
                var aDomY = yHigher ? (ay >= by) : (ay <= by);
                var aStrictX = xHigher ? (ax > bx) : (ax < bx);
                var aStrictY = yHigher ? (ay > by) : (ay < by);

                if (aDomX && aDomY && (aStrictX || aStrictY)) {
                    dominated[b] = true;
                }
            }
        }

        var front = [];
        for (var k = 0; k < rows.length; k++) {
            if (!dominated[k]) front.push(k);
        }
        return front;
    }

    function _drawPareto(rows) {
        var canvas = document.getElementById('doe-pareto-canvas');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');

        var xKey = document.getElementById('doe-pareto-x').value;
        var yKey = document.getElementById('doe-pareto-y').value;

        // Find objective configs
        var xObj = null, yObj = null;
        for (var oi = 0; oi < PARETO_OBJECTIVES.length; oi++) {
            if (PARETO_OBJECTIVES[oi].key === xKey) xObj = PARETO_OBJECTIVES[oi];
            if (PARETO_OBJECTIVES[oi].key === yKey) yObj = PARETO_OBJECTIVES[oi];
        }
        if (!xObj || !yObj) return;

        // Compute Pareto front
        var frontIndices = _computeParetoFront(rows, xKey, yKey, xObj.higher, yObj.higher);
        var frontSet = {};
        for (var fi = 0; fi < frontIndices.length; fi++) {
            frontSet[frontIndices[fi]] = true;
        }

        // Find data range
        var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (var ri = 0; ri < rows.length; ri++) {
            var xv = rows[ri][xKey];
            var yv = rows[ri][yKey];
            if (xv < xMin) xMin = xv;
            if (xv > xMax) xMax = xv;
            if (yv < yMin) yMin = yv;
            if (yv > yMax) yMax = yv;
        }

        // Add 5% padding
        var xRange = xMax - xMin || 1;
        var yRange = yMax - yMin || 1;
        xMin -= xRange * 0.05;
        xMax += xRange * 0.05;
        yMin -= yRange * 0.05;
        yMax += yRange * 0.05;

        // Layout
        var mL = 70, mT = 40, mR = 30, mB = 50;
        var pW = canvas.width - mL - mR;
        var pH = canvas.height - mT - mB;

        // Clear
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#080c14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Title
        ctx.fillStyle = '#00ccff';
        ctx.font = 'bold 12px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('PARETO FRONT: ' + yObj.label.toUpperCase() + ' vs ' + xObj.label.toUpperCase(),
            canvas.width / 2, 18);

        // Grid
        ctx.strokeStyle = '#1a2a44';
        ctx.lineWidth = 0.5;
        for (var gx = 0; gx <= 5; gx++) {
            var gxp = mL + (gx / 5) * pW;
            ctx.beginPath();
            ctx.moveTo(gxp, mT);
            ctx.lineTo(gxp, mT + pH);
            ctx.stroke();
        }
        for (var gy = 0; gy <= 5; gy++) {
            var gyp = mT + (gy / 5) * pH;
            ctx.beginPath();
            ctx.moveTo(mL, gyp);
            ctx.lineTo(mL + pW, gyp);
            ctx.stroke();
        }

        // Store point positions for tooltip
        var pointRects = [];

        // Draw non-Pareto points
        for (var pi = 0; pi < rows.length; pi++) {
            if (frontSet[pi]) continue;
            var px = mL + ((rows[pi][xKey] - xMin) / (xMax - xMin)) * pW;
            var py = mT + pH - ((rows[pi][yKey] - yMin) / (yMax - yMin)) * pH;

            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(100, 100, 150, 0.5)';
            ctx.fill();

            pointRects.push({ x: px, y: py, r: 6, idx: pi, pareto: false });
        }

        // Sort Pareto front points by x for line drawing
        var frontPts = [];
        for (var fpi = 0; fpi < frontIndices.length; fpi++) {
            var idx = frontIndices[fpi];
            var fpx = mL + ((rows[idx][xKey] - xMin) / (xMax - xMin)) * pW;
            var fpy = mT + pH - ((rows[idx][yKey] - yMin) / (yMax - yMin)) * pH;
            frontPts.push({ x: fpx, y: fpy, idx: idx });
        }
        frontPts.sort(function(a, b) { return a.x - b.x; });

        // Draw Pareto front line
        if (frontPts.length > 1) {
            ctx.strokeStyle = '#00ff88';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 3]);
            ctx.beginPath();
            ctx.moveTo(frontPts[0].x, frontPts[0].y);
            for (var li = 1; li < frontPts.length; li++) {
                ctx.lineTo(frontPts[li].x, frontPts[li].y);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw Pareto front points
        for (var qi = 0; qi < frontPts.length; qi++) {
            ctx.beginPath();
            ctx.arc(frontPts[qi].x, frontPts[qi].y, 6, 0, Math.PI * 2);
            ctx.fillStyle = '#00ff88';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();

            pointRects.push({ x: frontPts[qi].x, y: frontPts[qi].y, r: 8, idx: frontPts[qi].idx, pareto: true });
        }

        // Axis labels
        ctx.fillStyle = '#889';
        ctx.font = '9px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (var xl = 0; xl <= 5; xl++) {
            var xv2 = xMin + (xl / 5) * (xMax - xMin);
            var xvStr = (xKey === 'blueHvaPct' || xKey === 'redHvaPct') ?
                (xv2 * 100).toFixed(0) + '%' : xv2.toFixed(0);
            ctx.fillText(xvStr, mL + (xl / 5) * pW, mT + pH + 6);
        }

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (var yl = 0; yl <= 5; yl++) {
            var yv2 = yMin + (yl / 5) * (yMax - yMin);
            var yvStr = (yKey === 'blueHvaPct' || yKey === 'redHvaPct') ?
                (yv2 * 100).toFixed(0) + '%' : yv2.toFixed(0);
            ctx.fillText(yvStr, mL - 6, mT + pH - (yl / 5) * pH);
        }

        // Axis titles
        ctx.fillStyle = '#00ccff';
        ctx.font = '11px "Courier New", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(xObj.label, mL + pW / 2, canvas.height - 6);

        ctx.save();
        ctx.translate(12, mT + pH / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(yObj.label, 0, 0);
        ctx.restore();

        // Legend
        ctx.fillStyle = '#00ff88';
        ctx.beginPath();
        ctx.arc(canvas.width - 120, mT + 10, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#889';
        ctx.font = '10px "Courier New", monospace';
        ctx.textAlign = 'left';
        ctx.fillText('Pareto (' + frontIndices.length + ')', canvas.width - 110, mT + 13);

        ctx.fillStyle = 'rgba(100, 100, 150, 0.7)';
        ctx.beginPath();
        ctx.arc(canvas.width - 120, mT + 28, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#889';
        ctx.fillText('Dominated', canvas.width - 110, mT + 31);

        // Tooltip
        if (_paretoTooltipHandler) {
            canvas.removeEventListener('mousemove', _paretoTooltipHandler);
            canvas.removeEventListener('mouseleave', _paretoTooltipHandler);
        }

        var tooltip = document.getElementById('doe-pareto-tooltip');
        _paretoTooltipHandler = function(e) {
            if (e.type === 'mouseleave') {
                if (tooltip) tooltip.style.display = 'none';
                return;
            }
            var rect = canvas.getBoundingClientRect();
            var mx = e.clientX - rect.left;
            var my = e.clientY - rect.top;

            var found = null;
            for (var si = pointRects.length - 1; si >= 0; si--) {
                var pt = pointRects[si];
                var dx = mx - pt.x;
                var dy = my - pt.y;
                if (dx * dx + dy * dy <= pt.r * pt.r + 16) {
                    found = pt;
                    break;
                }
            }

            if (found && tooltip) {
                var row = rows[found.idx];
                var xVal = (xKey === 'blueHvaPct' || xKey === 'redHvaPct') ?
                    (row[xKey] * 100).toFixed(1) + '%' : row[xKey];
                var yVal = (yKey === 'blueHvaPct' || yKey === 'redHvaPct') ?
                    (row[yKey] * 100).toFixed(1) + '%' : row[yKey];
                tooltip.textContent = (found.pareto ? '[PARETO] ' : '') +
                    'H=' + row.hva + ' D=' + row.def + ' A=' + row.atk +
                    ' E=' + row.esc + ' S=' + row.swp +
                    ' | ' + xObj.label + '=' + xVal +
                    ', ' + yObj.label + '=' + yVal;
                var wrap = document.getElementById('doe-pareto-wrap');
                var wrapRect = wrap.getBoundingClientRect();
                tooltip.style.left = (e.clientX - wrapRect.left + 12) + 'px';
                tooltip.style.top = (e.clientY - wrapRect.top - 30) + 'px';
                tooltip.style.display = 'block';
            } else if (tooltip) {
                tooltip.style.display = 'none';
            }
        };

        canvas.addEventListener('mousemove', _paretoTooltipHandler);
        canvas.addEventListener('mouseleave', _paretoTooltipHandler);
    }

    // -------------------------------------------------------------------
    // Tab 5: Export
    // -------------------------------------------------------------------

    function _renderExport(rows, data) {
        var container = document.getElementById('doe-tab-export');
        if (!container) return;

        // Buttons — first row: data export
        var html = '<div class="doe-export-btns">';
        html += '<button class="doe-export-btn" id="doe-btn-csv">Download CSV</button>';
        html += '<button class="doe-export-btn" id="doe-btn-json">Download JSON</button>';
        html += '<button class="doe-export-btn" id="doe-btn-copy">Copy Table (TSV)</button>';
        html += '</div>';

        // Second row: scenario and report export
        html += '<div class="doe-export-btns">';
        html += '<button class="doe-export-btn" id="doe-btn-scenarios">Export Scenarios (.sim)</button>';
        html += '<button class="doe-export-btn" id="doe-btn-report">Export HTML Report</button>';
        html += '</div>';
        html += '<div class="doe-export-status" id="doe-export-status"></div>';

        // Summary stats
        html += '<div class="doe-summary-box">';
        html += '<div><span class="doe-sum-label">Total permutations: </span>' +
            '<span class="doe-sum-value">' + rows.length + '</span></div>';
        html += '<div><span class="doe-sum-label">Total simulation time: </span>' +
            '<span class="doe-sum-value">' + (data.totalElapsed || 0).toFixed(1) + 's</span></div>';
        html += '<div><span class="doe-sum-label">Seed: </span>' +
            '<span class="doe-sum-value">' + (data.seed || '---') + '</span></div>';

        // Best config for Blue HVA
        var bestBlue = _findBestConfig(rows, 'blueHvaPct', true);
        if (bestBlue) {
            html += '<div style="margin-top:8px;"><span class="doe-sum-label">Best config for Blue HVA survival: </span>' +
                '<span class="doe-sum-config">HVA=' + bestBlue.hva + ', DEF=' + bestBlue.def +
                ', ATK=' + bestBlue.atk + ', ESC=' + bestBlue.esc + ', SWP=' + bestBlue.swp +
                ' &rarr; ' + (bestBlue.blueHvaPct * 100).toFixed(1) + '%</span></div>';
        }

        // Best config for Red HVA
        var bestRed = _findBestConfig(rows, 'redHvaPct', true);
        if (bestRed) {
            html += '<div><span class="doe-sum-label">Best config for Red HVA survival: </span>' +
                '<span class="doe-sum-config">HVA=' + bestRed.hva + ', DEF=' + bestRed.def +
                ', ATK=' + bestRed.atk + ', ESC=' + bestRed.esc + ', SWP=' + bestRed.swp +
                ' &rarr; ' + (bestRed.redHvaPct * 100).toFixed(1) + '%</span></div>';
        }

        // Worst config for Blue HVA
        var worstBlue = _findBestConfig(rows, 'blueHvaPct', false);
        if (worstBlue) {
            html += '<div style="margin-top:8px;"><span class="doe-sum-label">Worst config for Blue HVA survival: </span>' +
                '<span class="doe-sum-worst">HVA=' + worstBlue.hva + ', DEF=' + worstBlue.def +
                ', ATK=' + worstBlue.atk + ', ESC=' + worstBlue.esc + ', SWP=' + worstBlue.swp +
                ' &rarr; ' + (worstBlue.blueHvaPct * 100).toFixed(1) + '%</span></div>';
        }

        // Worst config for Red HVA
        var worstRed = _findBestConfig(rows, 'redHvaPct', false);
        if (worstRed) {
            html += '<div><span class="doe-sum-label">Worst config for Red HVA survival: </span>' +
                '<span class="doe-sum-worst">HVA=' + worstRed.hva + ', DEF=' + worstRed.def +
                ', ATK=' + worstRed.atk + ', ESC=' + worstRed.esc + ', SWP=' + worstRed.swp +
                ' &rarr; ' + (worstRed.redHvaPct * 100).toFixed(1) + '%</span></div>';
        }

        html += '</div>';

        container.innerHTML = html;

        // Button listeners
        var csvBtn = document.getElementById('doe-btn-csv');
        if (csvBtn) {
            csvBtn.addEventListener('click', function() {
                exportCSV(_processedRows);
            });
        }
        var jsonBtn = document.getElementById('doe-btn-json');
        if (jsonBtn) {
            jsonBtn.addEventListener('click', function() {
                exportJSON(_rawData);
            });
        }
        var copyBtn = document.getElementById('doe-btn-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', function() {
                _copyTableToClipboard(_processedRows);
            });
        }
        var scenarioBtn = document.getElementById('doe-btn-scenarios');
        if (scenarioBtn) {
            scenarioBtn.addEventListener('click', function() {
                _exportScenarios(_processedRows, _rawData);
            });
        }
        var reportBtn = document.getElementById('doe-btn-report');
        if (reportBtn) {
            reportBtn.addEventListener('click', function() {
                _exportHTMLReport(_processedRows, _rawData);
            });
        }
    }

    function _findBestConfig(rows, metric, best) {
        if (!rows || rows.length === 0) return null;
        var result = rows[0];
        for (var i = 1; i < rows.length; i++) {
            if (best) {
                if (rows[i][metric] > result[metric]) result = rows[i];
            } else {
                if (rows[i][metric] < result[metric]) result = rows[i];
            }
        }
        return result;
    }

    function _copyTableToClipboard(rows) {
        var hasAdv = _hasVariation(rows);
        var headerParts = ['Perm', 'HVA', 'Defender', 'Attacker', 'Escort', 'Sweep', 'TotalPerSide'];
        if (hasAdv.sma) headerParts.push('SMA_km');
        if (hasAdv.inc) headerParts.push('Inc_deg');
        if (hasAdv.eng) headerParts.push('EngRange_km');
        if (hasAdv.wpn) headerParts.push('WeaponType');
        headerParts.push('BlueHVA%', 'RedHVA%', 'BlueAlive', 'RedAlive', 'Kills', 'SimTime');
        var header = headerParts.join('\t');
        var lines = [header];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var parts = [
                r.permId, r.hva, r.def, r.atk, r.esc, r.swp, r.totalPerSide
            ];
            if (hasAdv.sma) parts.push(r.smaKm || 42164);
            if (hasAdv.inc) parts.push(r.incDeg || 0);
            if (hasAdv.eng) parts.push(r.engRangeKm || 0);
            if (hasAdv.wpn) parts.push((r.weaponType || 'kkv').toUpperCase());
            parts.push(
                (r.blueHvaPct * 100).toFixed(1), (r.redHvaPct * 100).toFixed(1),
                r.blueAlive, r.redAlive, r.totalKills, r.simTime.toFixed(1)
            );
            lines.push(parts.join('\t'));
        }
        var tsv = lines.join('\n');

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(tsv).then(function() {
                _flashButton('doe-btn-copy', 'Copied!');
            });
        } else {
            // Fallback
            var ta = document.createElement('textarea');
            ta.value = tsv;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            _flashButton('doe-btn-copy', 'Copied!');
        }
    }

    /**
     * Export each DOE permutation as a separate .sim file.
     * POSTs to /api/sim/save for each permutation.
     */
    function _exportScenarios(rows, data) {
        if (!rows || rows.length === 0 || !data || !data.permutations) return;

        var statusEl = document.getElementById('doe-export-status');
        if (statusEl) {
            statusEl.textContent = 'Exporting ' + rows.length + ' scenarios...';
            statusEl.className = 'doe-export-status';
        }

        var completed = 0;
        var failed = 0;
        var total = data.permutations.length;

        for (var i = 0; i < total; i++) {
            (function(idx) {
                var perm = data.permutations[idx];
                if (!perm) {
                    completed++;
                    return;
                }

                // Build a scenario-like JSON from the permutation config
                var cfg = perm.config || {};
                var scenarioData = {
                    metadata: {
                        name: 'DOE Run ' + idx,
                        description: 'DOE permutation ' + idx + ': HVA=' + (cfg.hvaPerSide || 0) +
                            ' DEF=' + (cfg.defendersPerSide || 0) + ' ATK=' + (cfg.attackersPerSide || 0) +
                            ' ESC=' + (cfg.escortsPerSide || 0) + ' SWP=' + (cfg.sweepsPerSide || 0),
                        version: '2.0',
                        doe: {
                            permId: idx,
                            config: cfg,
                            seed: data.seed,
                            maxTime: data.maxTime
                        }
                    },
                    environment: { maxTimeWarp: 64 },
                    entities: [],
                    events: [],
                    camera: { range: 500000 }
                };

                // If the permutation has results with entity survival, embed summary
                if (perm.results && perm.results.runs && perm.results.runs[0]) {
                    scenarioData.metadata.doe.results = {
                        simTimeFinal: perm.results.runs[0].simTimeFinal,
                        entitySurvival: perm.results.runs[0].entitySurvival
                    };
                }

                var filename = 'doe_run_' + idx + '.sim';

                fetch('/api/sim/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: filename, data: scenarioData })
                })
                .then(function(resp) {
                    if (!resp.ok) failed++;
                    completed++;
                    _updateExportStatus(completed, failed, total);
                })
                .catch(function() {
                    failed++;
                    completed++;
                    _updateExportStatus(completed, failed, total);
                });
            })(i);
        }
    }

    function _updateExportStatus(completed, failed, total) {
        var statusEl = document.getElementById('doe-export-status');
        if (!statusEl) return;
        if (completed >= total) {
            if (failed > 0) {
                statusEl.textContent = 'Exported ' + (total - failed) + '/' + total +
                    ' scenarios (' + failed + ' failed)';
                statusEl.className = 'doe-export-status error';
            } else {
                statusEl.textContent = 'Exported ' + total + ' scenarios to sims/ directory';
                statusEl.className = 'doe-export-status success';
            }
            _flashButton('doe-btn-scenarios', 'Exported!');
        } else {
            statusEl.textContent = 'Exporting... ' + completed + '/' + total;
        }
    }

    /**
     * Generate a self-contained HTML report with embedded chart images and data tables.
     * Uses canvas.toDataURL() for each chart.
     */
    function _exportHTMLReport(rows, data) {
        if (!rows || rows.length === 0) return;

        var statusEl = document.getElementById('doe-export-status');
        if (statusEl) {
            statusEl.textContent = 'Generating report...';
            statusEl.className = 'doe-export-status';
        }

        // Collect chart images from existing canvases
        var chartImages = {};

        // Heat map canvas
        var hmCanvas = document.getElementById('doe-hm-canvas');
        if (hmCanvas) {
            try { chartImages.heatmap = hmCanvas.toDataURL('image/png'); } catch (e) { /* ignore */ }
        }

        // Sensitivity canvas
        var sensCanvas = document.getElementById('doe-sens-canvas');
        if (sensCanvas) {
            try { chartImages.sensitivity = sensCanvas.toDataURL('image/png'); } catch (e) { /* ignore */ }
        }

        // Pareto canvas
        var paretoCanvas = document.getElementById('doe-pareto-canvas');
        if (paretoCanvas) {
            try { chartImages.pareto = paretoCanvas.toDataURL('image/png'); } catch (e) { /* ignore */ }
        }

        // Build HTML
        var ts = _timestamp();
        var html = '<!DOCTYPE html>\n<html>\n<head>\n';
        html += '<meta charset="UTF-8">\n';
        html += '<title>DOE Report - ' + ts + '</title>\n';
        html += '<style>\n';
        html += 'body { font-family: "Courier New", monospace; background: #0a0e17; color: #e0e8f0; padding: 20px; }\n';
        html += 'h1 { color: #00ccff; border-bottom: 1px solid #1a2a44; padding-bottom: 8px; }\n';
        html += 'h2 { color: #00ccff; margin-top: 30px; }\n';
        html += 'table { border-collapse: collapse; width: 100%; margin: 10px 0; }\n';
        html += 'th { background: #0d1220; color: #00ccff; padding: 6px 10px; text-align: right; border-bottom: 2px solid #1a2a44; font-size: 11px; }\n';
        html += 'td { padding: 5px 10px; text-align: right; border-bottom: 1px solid #0f1525; font-size: 12px; }\n';
        html += 'tr:nth-child(even) td { background: #0a0e17; }\n';
        html += 'tr:nth-child(odd) td { background: #0d1220; }\n';
        html += '.summary { background: rgba(0,0,0,0.3); border: 1px solid #1a2a44; border-radius: 4px; padding: 16px; line-height: 1.8; margin: 10px 0; }\n';
        html += '.best { background: rgba(0,100,50,0.2); border-color: #00cc66; }\n';
        html += '.label { color: #889; }\n';
        html += '.value { color: #00ccff; font-weight: bold; }\n';
        html += '.good { color: #00ff88; font-weight: bold; }\n';
        html += '.bad { color: #f86; }\n';
        html += 'img { max-width: 100%; margin: 10px 0; border: 1px solid #1a2a44; border-radius: 4px; }\n';
        html += '.generated { color: #556; font-size: 10px; margin-top: 30px; border-top: 1px solid #1a2a44; padding-top: 8px; }\n';
        html += '</style>\n</head>\n<body>\n';

        html += '<h1>DOE RESULTS REPORT</h1>\n';
        html += '<div class="summary">\n';
        html += '<div><span class="label">Generated: </span><span class="value">' + new Date().toISOString() + '</span></div>\n';
        html += '<div><span class="label">Total permutations: </span><span class="value">' + rows.length + '</span></div>\n';
        html += '<div><span class="label">Seed: </span><span class="value">' + (data.seed || '---') + '</span></div>\n';
        html += '<div><span class="label">Max sim time: </span><span class="value">' + (data.maxTime || 600) + 's</span></div>\n';
        html += '<div><span class="label">Total elapsed: </span><span class="value">' + (data.totalElapsed || 0).toFixed(1) + 's</span></div>\n';
        html += '</div>\n';

        // Best configuration
        var best = _findBestConfig(rows, 'blueHvaPct', true);
        if (best) {
            html += '<div class="summary best">\n';
            html += '<div><strong style="color:#00cc66;">BEST CONFIGURATION (Blue HVA Survival)</strong></div>\n';
            html += '<div><span class="label">Survival: </span><span class="good">' + (best.blueHvaPct * 100).toFixed(1) + '%</span></div>\n';
            html += '<div><span class="label">Composition: </span><span class="good">HVA=' + best.hva + ' DEF=' + best.def +
                ' ATK=' + best.atk + ' ESC=' + best.esc + ' SWP=' + best.swp + '</span></div>\n';
            html += '</div>\n';
        }

        // Chart images
        if (chartImages.heatmap) {
            html += '<h2>HEAT MAP</h2>\n';
            html += '<img src="' + chartImages.heatmap + '" alt="Heat Map">\n';
        }
        if (chartImages.sensitivity) {
            html += '<h2>SENSITIVITY ANALYSIS</h2>\n';
            html += '<img src="' + chartImages.sensitivity + '" alt="Sensitivity">\n';
        }
        if (chartImages.pareto) {
            html += '<h2>PARETO FRONT</h2>\n';
            html += '<img src="' + chartImages.pareto + '" alt="Pareto Front">\n';
        }

        // Data table
        html += '<h2>DATA TABLE</h2>\n';
        html += '<table>\n<tr>';

        var hasAdv = _hasVariation(rows);
        var cols = ['#', 'HVA', 'DEF', 'ATK', 'ESC', 'SWP', 'Total'];
        if (hasAdv.sma) cols.push('SMA(km)');
        if (hasAdv.inc) cols.push('Inc(\u00B0)');
        if (hasAdv.eng) cols.push('Eng(km)');
        if (hasAdv.wpn) cols.push('Weapon');
        cols.push('Blue HVA%', 'Red HVA%', 'Blue Alive', 'Red Alive', 'Kills', 'Time');

        for (var ci = 0; ci < cols.length; ci++) {
            html += '<th>' + cols[ci] + '</th>';
        }
        html += '</tr>\n';

        for (var ri = 0; ri < rows.length; ri++) {
            var r = rows[ri];
            html += '<tr>';
            html += '<td>' + r.permId + '</td>';
            html += '<td>' + r.hva + '</td>';
            html += '<td>' + r.def + '</td>';
            html += '<td>' + r.atk + '</td>';
            html += '<td>' + r.esc + '</td>';
            html += '<td>' + r.swp + '</td>';
            html += '<td>' + r.totalPerSide + '</td>';
            if (hasAdv.sma) html += '<td>' + (r.smaKm || 42164) + '</td>';
            if (hasAdv.inc) html += '<td>' + (r.incDeg || 0) + '</td>';
            if (hasAdv.eng) html += '<td>' + (r.engRangeKm || 0) + '</td>';
            if (hasAdv.wpn) html += '<td>' + _escapeHtml((r.weaponType || 'kkv').toUpperCase()) + '</td>';
            if (r.error) {
                html += '<td colspan="6" style="color:#ff4444;">ERROR</td>';
            } else {
                html += '<td>' + (r.blueHvaPct * 100).toFixed(1) + '%</td>';
                html += '<td>' + (r.redHvaPct * 100).toFixed(1) + '%</td>';
                html += '<td>' + r.blueAlive + '/' + r.blueTotal + '</td>';
                html += '<td>' + r.redAlive + '/' + r.redTotal + '</td>';
                html += '<td>' + r.totalKills + '</td>';
                html += '<td>' + r.simTime.toFixed(1) + 's</td>';
            }
            html += '</tr>\n';
        }

        html += '</table>\n';
        html += '<div class="generated">Generated by DOE Analysis System</div>\n';
        html += '</body>\n</html>';

        _downloadBlob(html, 'text/html', 'doe_report_' + ts + '.html');

        if (statusEl) {
            statusEl.textContent = 'Report downloaded';
            statusEl.className = 'doe-export-status success';
        }
        _flashButton('doe-btn-report', 'Downloaded!');
    }

    function _flashButton(id, text) {
        var btn = document.getElementById(id);
        if (!btn) return;
        var orig = btn.textContent;
        btn.textContent = text;
        btn.style.background = '#00ccff';
        btn.style.color = '#000';
        setTimeout(function() {
            btn.textContent = orig;
            btn.style.background = 'transparent';
            btn.style.color = '#00ccff';
        }, 1500);
    }

    // -------------------------------------------------------------------
    // Chart cleanup
    // -------------------------------------------------------------------

    function _destroyCharts() {
        for (var i = 0; i < _chartInstances.length; i++) {
            _chartInstances[i].destroy();
        }
        _chartInstances = [];
        _renderedTabs = {};
    }

    // -------------------------------------------------------------------
    // Panel Show / Hide
    // -------------------------------------------------------------------

    function showPanel(data) {
        // Remove old panel if present
        hidePanel();

        // Inject styles
        _injectStyles();

        // Process data
        _rawData = data;
        _processedRows = _processResults(data);
        _sortColumn = null;
        _sortAscending = true;

        // Build panel
        var panel = document.createElement('div');
        panel.id = PANEL_ID;

        var html = '';

        // Header
        html += '<div class="doe-header">';
        html += '<span class="doe-title">DOE RESULTS \u2014 ORBITAL ARENA</span>';
        html += '<button class="doe-close" id="doe-close-btn">\u00D7</button>';
        html += '</div>';

        // Tab bar
        html += '<div class="doe-tabs">';
        for (var t = 0; t < TAB_NAMES.length; t++) {
            var activeClass = (t === 0) ? ' active' : '';
            html += '<button class="doe-tab' + activeClass + '" data-tab="' +
                TAB_NAMES[t] + '">' + TAB_LABELS[t] + '</button>';
        }
        html += '</div>';

        // Content area
        html += '<div class="doe-content">';
        for (var c = 0; c < TAB_NAMES.length; c++) {
            var activeTab = (c === 0) ? ' active' : '';
            html += '<div class="doe-tab-content' + activeTab + '" id="doe-tab-' +
                TAB_NAMES[c] + '"></div>';
        }
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);
        _panel = panel;

        // Render first tab immediately
        _renderDataTable(_processedRows);
        _renderedTabs['datatable'] = true;

        // --- Event Listeners ---

        // Tab switching
        var tabs = panel.querySelectorAll('.doe-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].addEventListener('click', function() {
                var tabName = this.getAttribute('data-tab');

                // Update active tab button
                var allTabs = panel.querySelectorAll('.doe-tab');
                for (var j = 0; j < allTabs.length; j++) {
                    allTabs[j].classList.remove('active');
                }
                this.classList.add('active');

                // Show/hide content
                var contents = panel.querySelectorAll('.doe-tab-content');
                for (var k = 0; k < contents.length; k++) {
                    contents[k].classList.remove('active');
                }
                var target = document.getElementById('doe-tab-' + tabName);
                if (target) target.classList.add('active');

                // Lazy-render tabs on first visit
                if (!_renderedTabs[tabName]) {
                    _renderedTabs[tabName] = true;
                    if (tabName === 'heatmap') _renderHeatMap(_processedRows);
                    else if (tabName === 'sensitivity') _renderSensitivity(_processedRows);
                    else if (tabName === 'pareto') _renderPareto(_processedRows);
                    else if (tabName === 'export') _renderExport(_processedRows, _rawData);
                }
            });
        }

        // Close button
        var closeBtn = document.getElementById('doe-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                hidePanel();
            });
        }

        // Escape key to close
        _escapeHandler = function(e) {
            if (e.key === 'Escape') {
                hidePanel();
            }
        };
        document.addEventListener('keydown', _escapeHandler);
    }

    function hidePanel() {
        _destroyCharts();

        if (_escapeHandler) {
            document.removeEventListener('keydown', _escapeHandler);
            _escapeHandler = null;
        }

        _heatMapTooltipHandler = null;
        _paretoTooltipHandler = null;

        var existing = document.getElementById(PANEL_ID);
        if (existing) {
            existing.parentNode.removeChild(existing);
        }
        _panel = null;
        _processedRows = null;
        _rawData = null;
    }

    // -------------------------------------------------------------------
    // Export Functions
    // -------------------------------------------------------------------

    function exportCSV(rows) {
        if (!rows) rows = _processedRows;
        if (!rows || rows.length === 0) return;

        var hasAdv = _hasVariation(rows);
        var headerParts = ['Perm', 'HVA', 'Defender', 'Attacker', 'Escort', 'Sweep', 'TotalPerSide'];
        if (hasAdv.sma) headerParts.push('SMA_km');
        if (hasAdv.inc) headerParts.push('Inc_deg');
        if (hasAdv.eng) headerParts.push('EngRange_km');
        if (hasAdv.wpn) headerParts.push('WeaponType');
        headerParts.push('BlueHVA%', 'RedHVA%', 'BlueAlive', 'RedAlive', 'Kills', 'SimTime');
        var header = headerParts.join(',');
        var lines = [header];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var parts = [
                r.permId, r.hva, r.def, r.atk, r.esc, r.swp, r.totalPerSide
            ];
            if (hasAdv.sma) parts.push(r.smaKm || 42164);
            if (hasAdv.inc) parts.push(r.incDeg || 0);
            if (hasAdv.eng) parts.push(r.engRangeKm || 0);
            if (hasAdv.wpn) parts.push((r.weaponType || 'kkv').toUpperCase());
            parts.push(
                (r.blueHvaPct * 100).toFixed(1), (r.redHvaPct * 100).toFixed(1),
                r.blueAlive, r.redAlive, r.totalKills, r.simTime.toFixed(1)
            );
            lines.push(parts.join(','));
        }
        var csv = lines.join('\n');
        _downloadBlob(csv, 'text/csv', 'doe_results_' + _timestamp() + '.csv');
    }

    function exportJSON(data) {
        if (!data) data = _rawData;
        if (!data) return;

        var json = JSON.stringify(data, null, 2);
        _downloadBlob(json, 'application/json', 'doe_results_' + _timestamp() + '.json');
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        showPanel: showPanel,
        hidePanel: hidePanel,
        exportCSV: exportCSV,
        exportJSON: exportJSON
    };

})();
