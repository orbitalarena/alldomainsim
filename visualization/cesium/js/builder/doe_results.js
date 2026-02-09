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

    var TAB_NAMES = ['datatable', 'heatmap', 'sensitivity', 'export'];
    var TAB_LABELS = ['DATA TABLE', 'HEAT MAP', 'SENSITIVITY', 'EXPORT'];

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

        var html = '<div class="doe-table-wrap" id="doe-table-wrap">';
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
            { key: 'totalPerSide', label: 'Total' },
            { key: 'blueHvaPct', label: 'Blue HVA%' },
            { key: 'redHvaPct', label: 'Red HVA%' },
            { key: 'blueAlive', label: 'Blue Alive' },
            { key: 'redAlive', label: 'Red Alive' },
            { key: 'totalKills', label: 'Kills' },
            { key: 'simTime', label: 'Time' }
        ];

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

        // Build controls
        var html = '<div class="doe-heatmap-controls">';

        // X Axis dropdown
        html += '<label>X AXIS </label>';
        html += '<select id="doe-hm-x">';
        for (var i = 0; i < ROLE_FIELDS.length; i++) {
            var sel = (ROLE_FIELDS[i].key === 'atk') ? ' selected' : '';
            html += '<option value="' + ROLE_FIELDS[i].key + '"' + sel + '>' +
                ROLE_FIELDS[i].label + '</option>';
        }
        html += '</select>';

        // Y Axis dropdown
        html += '<label>Y AXIS </label>';
        html += '<select id="doe-hm-y">';
        for (var j = 0; j < ROLE_FIELDS.length; j++) {
            var sel2 = (ROLE_FIELDS[j].key === 'def') ? ' selected' : '';
            html += '<option value="' + ROLE_FIELDS[j].key + '"' + sel2 + '>' +
                ROLE_FIELDS[j].label + '</option>';
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

        var xLabel = xField;
        var yLabel = yField;
        for (var rf = 0; rf < ROLE_FIELDS.length; rf++) {
            if (ROLE_FIELDS[rf].key === xField) xLabel = ROLE_FIELDS[rf].label;
            if (ROLE_FIELDS[rf].key === yField) yLabel = ROLE_FIELDS[rf].label;
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

        var labels = [];
        var correlations = [];
        var bgColors = [];
        for (var r = 0; r < ROLE_FIELDS.length; r++) {
            var roleVals = [];
            for (var j = 0; j < rows.length; j++) {
                roleVals.push(rows[j][ROLE_FIELDS[r].key]);
            }
            var corr = _pearsonCorrelation(roleVals, metricVals);
            labels.push(ROLE_FIELDS[r].label);
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
    // Tab 4: Export
    // -------------------------------------------------------------------

    function _renderExport(rows, data) {
        var container = document.getElementById('doe-tab-export');
        if (!container) return;

        // Buttons
        var html = '<div class="doe-export-btns">';
        html += '<button class="doe-export-btn" id="doe-btn-csv">Download CSV</button>';
        html += '<button class="doe-export-btn" id="doe-btn-json">Download JSON</button>';
        html += '<button class="doe-export-btn" id="doe-btn-copy">Copy Table</button>';
        html += '</div>';

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
        var header = 'Perm\tHVA\tDefender\tAttacker\tEscort\tSweep\tTotalPerSide\t' +
            'BlueHVA%\tRedHVA%\tBlueAlive\tRedAlive\tKills\tSimTime';
        var lines = [header];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            lines.push([
                r.permId, r.hva, r.def, r.atk, r.esc, r.swp, r.totalPerSide,
                (r.blueHvaPct * 100).toFixed(1), (r.redHvaPct * 100).toFixed(1),
                r.blueAlive, r.redAlive, r.totalKills, r.simTime.toFixed(1)
            ].join('\t'));
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

        var header = 'Perm,HVA,Defender,Attacker,Escort,Sweep,TotalPerSide,' +
            'BlueHVA%,RedHVA%,BlueAlive,RedAlive,Kills,SimTime';
        var lines = [header];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            lines.push([
                r.permId, r.hva, r.def, r.atk, r.esc, r.swp, r.totalPerSide,
                (r.blueHvaPct * 100).toFixed(1), (r.redHvaPct * 100).toFixed(1),
                r.blueAlive, r.redAlive, r.totalKills, r.simTime.toFixed(1)
            ].join(','));
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
