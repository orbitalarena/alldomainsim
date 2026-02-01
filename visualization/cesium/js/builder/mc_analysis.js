/**
 * MCAnalysis — Monte Carlo results aggregation and display module.
 *
 * After MCRunner completes N headless simulation runs, MCAnalysis
 * aggregates the results and displays them in a styled panel overlay.
 *
 * Public API:
 *   MCAnalysis.aggregate(results)             → aggregated stats object
 *   MCAnalysis.showPanel(aggregated, results) — render results DOM panel
 *   MCAnalysis.hidePanel()                    — remove results panel
 *   MCAnalysis.exportCSV(results)             — download engagement logs as CSV
 *   MCAnalysis.exportJSON(results, aggregated)— download full results as JSON
 */
var MCAnalysis = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    var PANEL_ID = 'mc-analysis-panel';
    var STYLES_ID = 'mc-analysis-styles';
    var HISTOGRAM_BINS = 10;

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _panel = null;
    var _sortColumn = null;
    var _sortAscending = true;
    var _chartInstances = [];
    var _renderedTabs = {};

    // -------------------------------------------------------------------
    // Utility Functions
    // -------------------------------------------------------------------

    /**
     * Arithmetic mean of a numeric array.
     * @param {number[]} arr
     * @returns {number}
     */
    function _mean(arr) {
        if (!arr || arr.length === 0) return 0;
        var sum = 0;
        for (var i = 0; i < arr.length; i++) {
            sum += arr[i];
        }
        return sum / arr.length;
    }

    /**
     * Sample standard deviation (N-1 denominator).
     * @param {number[]} arr
     * @param {number} [m] - precomputed mean (optional)
     * @returns {number}
     */
    function _stddev(arr, m) {
        if (!arr || arr.length < 2) return 0;
        if (m === undefined) m = _mean(arr);
        var sumSq = 0;
        for (var i = 0; i < arr.length; i++) {
            var diff = arr[i] - m;
            sumSq += diff * diff;
        }
        return Math.sqrt(sumSq / (arr.length - 1));
    }

    /**
     * Escape HTML special characters to prevent XSS in dynamic content.
     * @param {string} str
     * @returns {string}
     */
    function _escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * Format a survival rate (0.0–1.0) as a percentage string.
     * @param {number} rate
     * @returns {string}
     */
    function _fmtPct(rate) {
        if (rate === undefined || rate === null || isNaN(rate)) return '---';
        return (rate * 100).toFixed(1) + '%';
    }

    /**
     * Format seconds as M:SS.
     * @param {number} seconds
     * @returns {string}
     */
    function _fmtTime(seconds) {
        if (seconds === undefined || seconds === null || isNaN(seconds)) return '---';
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // -------------------------------------------------------------------
    // Aggregation
    // -------------------------------------------------------------------

    /**
     * Aggregate an array of per-run results into summary statistics.
     *
     * @param {Object[]} results - Array of per-run result objects
     * @returns {Object} Aggregated statistics
     */
    function aggregate(results) {
        // Filter out error runs
        var validRuns = [];
        var numErrors = 0;
        for (var i = 0; i < results.length; i++) {
            if (results[i].error) {
                numErrors++;
            } else {
                validRuns.push(results[i]);
            }
        }

        var N = validRuns.length;

        // ----- Entity survival rates -----
        var entityStats = {};
        for (var r = 0; r < N; r++) {
            var survival = validRuns[r].entitySurvival;
            if (!survival) continue;
            var ids = Object.keys(survival);
            for (var j = 0; j < ids.length; j++) {
                var eid = ids[j];
                var info = survival[eid];
                if (!entityStats[eid]) {
                    entityStats[eid] = {
                        name: info.name,
                        team: info.team,
                        type: info.type,
                        role: info.role || null,
                        survivals: 0,
                        total: 0,
                        survivalRate: 0
                    };
                }
                entityStats[eid].total++;
                if (info.alive) {
                    entityStats[eid].survivals++;
                }
            }
        }
        // Compute survival rates
        var entityIds = Object.keys(entityStats);
        for (var k = 0; k < entityIds.length; k++) {
            var es = entityStats[entityIds[k]];
            es.survivalRate = es.total > 0 ? es.survivals / es.total : 0;
        }

        // ----- Team statistics -----
        var teamEntities = {};  // teamName -> [survivalRate, ...]
        for (var k2 = 0; k2 < entityIds.length; k2++) {
            var ent = entityStats[entityIds[k2]];
            var team = ent.team || 'unknown';
            if (!teamEntities[team]) {
                teamEntities[team] = [];
            }
            teamEntities[team].push(ent.survivalRate);
        }
        var teamStats = {};
        var teamNames = Object.keys(teamEntities);
        for (var t = 0; t < teamNames.length; t++) {
            var tName = teamNames[t];
            var rates = teamEntities[tName];
            var tMean = _mean(rates);
            teamStats[tName] = {
                entityCount: rates.length,
                meanSurvivalRate: tMean,
                stdSurvivalRate: _stddev(rates, tMean)
            };
        }

        // ----- Role statistics (for large orbital scenarios) -----
        var roleEntities = {};
        for (var k3 = 0; k3 < entityIds.length; k3++) {
            var entR = entityStats[entityIds[k3]];
            if (!entR.role) continue;
            var roleKey = (entR.team || 'unknown') + '-' + entR.role;
            if (!roleEntities[roleKey]) {
                roleEntities[roleKey] = { rates: [], team: entR.team, role: entR.role };
            }
            roleEntities[roleKey].rates.push(entR.survivalRate);
        }
        var roleStats = {};
        var roleKeys = Object.keys(roleEntities);
        for (var rk = 0; rk < roleKeys.length; rk++) {
            var re = roleEntities[roleKeys[rk]];
            var rMean = _mean(re.rates);
            roleStats[roleKeys[rk]] = {
                team: re.team,
                role: re.role,
                entityCount: re.rates.length,
                meanSurvivalRate: rMean,
                stdSurvivalRate: _stddev(re.rates, rMean)
            };
        }

        // ----- Weapon effectiveness -----
        var weaponStats = {};
        for (var r2 = 0; r2 < N; r2++) {
            var log = validRuns[r2].engagementLog;
            if (!log) continue;
            for (var e = 0; e < log.length; e++) {
                var evt = log[e];
                var wt = evt.weaponType || 'UNKNOWN';
                if (!weaponStats[wt]) {
                    weaponStats[wt] = { launches: 0, kills: 0, misses: 0, observedPk: 0 };
                }
                var result = (evt.result || '').toUpperCase();
                if (result === 'LAUNCH') {
                    weaponStats[wt].launches++;
                } else if (result === 'KILL') {
                    weaponStats[wt].kills++;
                } else if (result === 'MISS') {
                    weaponStats[wt].misses++;
                }
            }
        }
        // Compute observed Pk
        var weaponTypes = Object.keys(weaponStats);
        for (var w = 0; w < weaponTypes.length; w++) {
            var ws = weaponStats[weaponTypes[w]];
            var outcomes = ws.kills + ws.misses;
            ws.observedPk = outcomes > 0 ? ws.kills / outcomes : 0;
        }

        // ----- Kill distribution -----
        var killsPerRun = [];
        var engPerRun = [];
        var perRunSummaries = [];
        for (var r3 = 0; r3 < N; r3++) {
            var run = validRuns[r3];
            var runLog = run.engagementLog || [];
            var runKills = 0;
            var runMisses = 0;
            var runEngagements = runLog.length;
            for (var e2 = 0; e2 < runLog.length; e2++) {
                var res = (runLog[e2].result || '').toUpperCase();
                if (res === 'KILL') runKills++;
                else if (res === 'MISS') runMisses++;
            }
            killsPerRun.push(runKills);
            engPerRun.push(runEngagements);
            perRunSummaries.push({
                runIndex: run.runIndex,
                seed: run.seed,
                kills: runKills,
                misses: runMisses,
                engagements: runEngagements,
                simTimeFinal: run.simTimeFinal
            });
        }

        var killMean = _mean(killsPerRun);
        var killStd = _stddev(killsPerRun, killMean);
        var killMin = killsPerRun.length > 0 ? killsPerRun[0] : 0;
        var killMax = killsPerRun.length > 0 ? killsPerRun[0] : 0;
        for (var q = 1; q < killsPerRun.length; q++) {
            if (killsPerRun[q] < killMin) killMin = killsPerRun[q];
            if (killsPerRun[q] > killMax) killMax = killsPerRun[q];
        }

        var engMean = _mean(engPerRun);
        var engStd = _stddev(engPerRun, engMean);

        return {
            numRuns: N,
            numErrors: numErrors,
            entityStats: entityStats,
            teamStats: teamStats,
            roleStats: roleStats,
            weaponStats: weaponStats,
            killsPerRun: killsPerRun,
            killMean: killMean,
            killStd: killStd,
            killMin: killMin,
            killMax: killMax,
            engMean: engMean,
            engStd: engStd,
            perRunSummaries: perRunSummaries
        };
    }

    // -------------------------------------------------------------------
    // CSS Injection
    // -------------------------------------------------------------------

    /**
     * Inject the stylesheet for the analysis panel (idempotent).
     */
    function _injectStyles() {
        if (document.getElementById(STYLES_ID)) return;

        var css = [
            '#' + PANEL_ID + ' {',
            '  position: fixed;',
            '  top: 70px;',
            '  left: 50%;',
            '  transform: translateX(-50%);',
            '  max-width: 700px;',
            '  width: 90%;',
            '  max-height: calc(100vh - 100px);',
            '  overflow-y: auto;',
            '  background: rgba(10, 15, 10, 0.95);',
            '  border: 1px solid #ff8800;',
            '  border-radius: 6px;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 12px;',
            '  color: #cccccc;',
            '  z-index: 60;',
            '  padding: 16px;',
            '  box-sizing: border-box;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-header {',
            '  display: flex;',
            '  justify-content: space-between;',
            '  align-items: center;',
            '  border-bottom: 1px solid #ff8800;',
            '  padding-bottom: 8px;',
            '  margin-bottom: 12px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-title {',
            '  color: #ff8800;',
            '  font-size: 16px;',
            '  font-weight: bold;',
            '  letter-spacing: 2px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-subtitle {',
            '  color: #888888;',
            '  font-size: 11px;',
            '  margin-top: 2px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-close {',
            '  color: #ff8800;',
            '  font-size: 18px;',
            '  cursor: pointer;',
            '  padding: 4px 8px;',
            '  border: 1px solid #ff8800;',
            '  border-radius: 3px;',
            '  background: transparent;',
            '  font-family: "Courier New", monospace;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-close:hover {',
            '  background: #ff8800;',
            '  color: #000000;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-section {',
            '  margin-bottom: 16px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-section-title {',
            '  color: #ff8800;',
            '  font-size: 13px;',
            '  font-weight: bold;',
            '  margin-bottom: 8px;',
            '  border-bottom: 1px solid #333333;',
            '  padding-bottom: 4px;',
            '  text-transform: uppercase;',
            '  letter-spacing: 1px;',
            '}',
            '',
            '/* Team survival two-column */',
            '#' + PANEL_ID + ' .mca-team-grid {',
            '  display: flex;',
            '  flex-wrap: wrap;',
            '  gap: 12px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-team-card {',
            '  flex: 1;',
            '  min-width: 140px;',
            '  padding: 8px 12px;',
            '  border: 1px solid #444444;',
            '  border-radius: 4px;',
            '  text-align: center;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-team-name {',
            '  font-size: 13px;',
            '  font-weight: bold;',
            '  margin-bottom: 4px;',
            '  text-transform: uppercase;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-team-rate {',
            '  font-size: 18px;',
            '  font-weight: bold;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-team-detail {',
            '  font-size: 10px;',
            '  color: #888888;',
            '  margin-top: 2px;',
            '}',
            '',
            '/* Entity survival table */',
            '#' + PANEL_ID + ' .mca-entity-table {',
            '  width: 100%;',
            '  border-collapse: collapse;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-entity-table td {',
            '  padding: 3px 6px;',
            '  vertical-align: middle;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-entity-name {',
            '  color: #cccccc;',
            '  white-space: nowrap;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-team-badge {',
            '  display: inline-block;',
            '  padding: 1px 5px;',
            '  border-radius: 2px;',
            '  font-size: 10px;',
            '  font-weight: bold;',
            '  margin-left: 4px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-bar-cell {',
            '  width: 50%;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-bar-bg {',
            '  background: #1a1a1a;',
            '  border-radius: 2px;',
            '  height: 14px;',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-bar-fill {',
            '  height: 100%;',
            '  border-radius: 2px;',
            '  transition: width 0.3s ease;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-bar-label {',
            '  position: absolute;',
            '  right: 4px;',
            '  top: 0;',
            '  line-height: 14px;',
            '  font-size: 10px;',
            '  color: #ffffff;',
            '  text-shadow: 0 0 3px #000000;',
            '}',
            '',
            '/* Weapon table */',
            '#' + PANEL_ID + ' .mca-weapon-table {',
            '  width: 100%;',
            '  border-collapse: collapse;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-weapon-table th {',
            '  color: #ff8800;',
            '  text-align: left;',
            '  padding: 4px 8px;',
            '  border-bottom: 1px solid #444444;',
            '  font-size: 11px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-weapon-table td {',
            '  padding: 4px 8px;',
            '  color: #ffcc00;',
            '  border-bottom: 1px solid #222222;',
            '}',
            '',
            '/* Histogram */',
            '#' + PANEL_ID + ' .mca-histogram {',
            '  margin-top: 6px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-hist-row {',
            '  display: flex;',
            '  align-items: center;',
            '  margin-bottom: 2px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-hist-label {',
            '  width: 70px;',
            '  text-align: right;',
            '  padding-right: 6px;',
            '  font-size: 10px;',
            '  color: #888888;',
            '  flex-shrink: 0;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-hist-bar-bg {',
            '  flex: 1;',
            '  background: #1a1a1a;',
            '  height: 16px;',
            '  border-radius: 2px;',
            '  position: relative;',
            '  overflow: hidden;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-hist-bar {',
            '  height: 100%;',
            '  background: #ff8800;',
            '  border-radius: 2px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-hist-count {',
            '  width: 30px;',
            '  padding-left: 6px;',
            '  font-size: 10px;',
            '  color: #ffcc00;',
            '  flex-shrink: 0;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-dist-summary {',
            '  color: #ffcc00;',
            '  margin-bottom: 6px;',
            '}',
            '',
            '/* Per-run results table */',
            '#' + PANEL_ID + ' .mca-run-table-wrap {',
            '  max-height: 200px;',
            '  overflow-y: auto;',
            '  border: 1px solid #333333;',
            '  border-radius: 3px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-run-table {',
            '  width: 100%;',
            '  border-collapse: collapse;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-run-table th {',
            '  color: #ff8800;',
            '  text-align: left;',
            '  padding: 4px 8px;',
            '  border-bottom: 1px solid #444444;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '  user-select: none;',
            '  position: sticky;',
            '  top: 0;',
            '  background: rgba(10, 15, 10, 0.98);',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-run-table th:hover {',
            '  color: #ffcc00;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-run-table td {',
            '  padding: 3px 8px;',
            '  color: #cccccc;',
            '  border-bottom: 1px solid #1a1a1a;',
            '  font-size: 11px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-run-table tr:hover td {',
            '  background: rgba(255, 136, 0, 0.1);',
            '}',
            '',
            '/* Export buttons */',
            '#' + PANEL_ID + ' .mca-export-row {',
            '  display: flex;',
            '  gap: 10px;',
            '  margin-top: 12px;',
            '  padding-top: 12px;',
            '  border-top: 1px solid #333333;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-export-btn {',
            '  padding: 6px 14px;',
            '  border: 1px solid #ff8800;',
            '  border-radius: 3px;',
            '  background: transparent;',
            '  color: #ff8800;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 12px;',
            '  cursor: pointer;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-export-btn:hover {',
            '  background: #ff8800;',
            '  color: #000000;',
            '}',
            '',
            '/* Tabs */',
            '#' + PANEL_ID + ' .mca-tabs {',
            '  display: flex;',
            '  gap: 0;',
            '  margin-bottom: 0;',
            '  border-bottom: 2px solid #ff8800;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-tab {',
            '  padding: 6px 16px;',
            '  background: transparent;',
            '  border: 1px solid #333;',
            '  border-bottom: none;',
            '  border-radius: 4px 4px 0 0;',
            '  color: #666;',
            '  font-family: "Courier New", monospace;',
            '  font-size: 11px;',
            '  cursor: pointer;',
            '  letter-spacing: 1px;',
            '  text-transform: uppercase;',
            '  margin-right: 2px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-tab.active {',
            '  color: #ff8800;',
            '  border-color: #ff8800;',
            '  background: rgba(255, 136, 0, 0.1);',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-tab:hover {',
            '  color: #ffcc00;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-tab-content {',
            '  min-height: 80px;',
            '  padding-top: 12px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-chart-wrap {',
            '  position: relative;',
            '  margin: 8px 0 16px 0;',
            '  background: rgba(0, 0, 0, 0.3);',
            '  border-radius: 4px;',
            '  padding: 8px;',
            '}',
            '',
            '#' + PANEL_ID + ' .mca-chart-title {',
            '  color: #ff8800;',
            '  font-size: 11px;',
            '  font-weight: bold;',
            '  text-transform: uppercase;',
            '  letter-spacing: 1px;',
            '  margin-bottom: 6px;',
            '}',
            '',
            '/* Error banner */',
            '#' + PANEL_ID + ' .mca-error-banner {',
            '  background: rgba(255, 68, 68, 0.15);',
            '  border: 1px solid #ff4444;',
            '  border-radius: 3px;',
            '  padding: 6px 10px;',
            '  color: #ff4444;',
            '  margin-bottom: 12px;',
            '  font-size: 11px;',
            '}',
            '',
            '/* Scrollbar styling */',
            '#' + PANEL_ID + '::-webkit-scrollbar {',
            '  width: 6px;',
            '}',
            '#' + PANEL_ID + '::-webkit-scrollbar-track {',
            '  background: #1a1a1a;',
            '}',
            '#' + PANEL_ID + '::-webkit-scrollbar-thumb {',
            '  background: #ff8800;',
            '  border-radius: 3px;',
            '}',
            '#' + PANEL_ID + ' .mca-run-table-wrap::-webkit-scrollbar {',
            '  width: 5px;',
            '}',
            '#' + PANEL_ID + ' .mca-run-table-wrap::-webkit-scrollbar-track {',
            '  background: #1a1a1a;',
            '}',
            '#' + PANEL_ID + ' .mca-run-table-wrap::-webkit-scrollbar-thumb {',
            '  background: #555555;',
            '  border-radius: 3px;',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.id = STYLES_ID;
        style.textContent = css;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------
    // Panel Rendering Helpers
    // -------------------------------------------------------------------

    /**
     * Get a color for a team name.
     * @param {string} team
     * @returns {string} hex color
     */
    function _teamColor(team) {
        var t = (team || '').toLowerCase();
        if (t === 'blue') return '#4488ff';
        if (t === 'red') return '#ff4444';
        if (t === 'green') return '#44ff44';
        return '#aaaaaa';
    }

    /**
     * Get a color for a survival rate bar.
     * @param {number} rate 0–1
     * @returns {string} hex color
     */
    function _barColor(rate) {
        if (rate > 0.7) return '#00ff00';
        if (rate >= 0.4) return '#ffcc00';
        return '#ff4444';
    }

    /**
     * Build the header section HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildHeader(agg) {
        var html = '<div class="mca-header">';
        html += '<div>';
        html += '<div class="mca-title">MONTE CARLO ANALYSIS</div>';
        html += '<div class="mca-subtitle">' + agg.numRuns + ' runs completed';
        if (agg.numErrors > 0) {
            html += ' (' + agg.numErrors + ' errors)';
        }
        html += '</div>';
        html += '</div>';
        html += '<button class="mca-close" id="mca-close-btn">[X]</button>';
        html += '</div>';
        return html;
    }

    /**
     * Build the error banner if there are error runs.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildErrorBanner(agg) {
        if (agg.numErrors === 0) return '';
        return '<div class="mca-error-banner">' +
            agg.numErrors + ' of ' + (agg.numRuns + agg.numErrors) +
            ' runs failed with errors and were excluded from analysis.</div>';
    }

    /**
     * Build the team survival section HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildTeamSurvival(agg) {
        var teamNames = Object.keys(agg.teamStats);
        if (teamNames.length === 0) return '';

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Team Survival</div>';
        html += '<div class="mca-team-grid">';

        for (var i = 0; i < teamNames.length; i++) {
            var name = teamNames[i];
            var ts = agg.teamStats[name];
            var color = _teamColor(name);
            var rateColor = _barColor(ts.meanSurvivalRate);

            html += '<div class="mca-team-card" style="border-color:' + color + ';">';
            html += '<div class="mca-team-name" style="color:' + color + ';">' +
                _escapeHtml(name.toUpperCase()) + '</div>';
            html += '<div class="mca-team-rate" style="color:' + rateColor + ';">' +
                _fmtPct(ts.meanSurvivalRate) + '</div>';
            html += '<div class="mca-team-detail">&plusmn; ' +
                _fmtPct(ts.stdSurvivalRate) + ' | ' +
                ts.entityCount + ' entities</div>';
            html += '</div>';
        }

        html += '</div></div>';
        return html;
    }

    /**
     * Build the entity survival rates table HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildEntitySurvival(agg) {
        var entityIds = Object.keys(agg.entityStats);
        if (entityIds.length === 0) return '';

        // For large scenarios with roles, show role-based survival summary
        var roleKeys = agg.roleStats ? Object.keys(agg.roleStats) : [];
        if (entityIds.length > 50 && roleKeys.length > 0) {
            return _buildRoleSurvival(agg);
        }

        // Sort by survival rate ascending
        entityIds.sort(function(a, b) {
            return agg.entityStats[a].survivalRate - agg.entityStats[b].survivalRate;
        });

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Entity Survival Rates</div>';
        html += '<table class="mca-entity-table">';

        for (var i = 0; i < entityIds.length; i++) {
            var es = agg.entityStats[entityIds[i]];
            var pct = es.survivalRate * 100;
            var color = _barColor(es.survivalRate);
            var teamCol = _teamColor(es.team);

            html += '<tr>';
            html += '<td class="mca-entity-name">' + _escapeHtml(es.name);
            html += '<span class="mca-team-badge" style="background:' +
                teamCol + ';color:#000;">' + _escapeHtml((es.team || '?').toUpperCase()) +
                '</span></td>';
            html += '<td class="mca-bar-cell"><div class="mca-bar-bg">';
            html += '<div class="mca-bar-fill" style="width:' + pct.toFixed(1) +
                '%;background:' + color + ';"></div>';
            html += '<div class="mca-bar-label">' + _fmtPct(es.survivalRate) + '</div>';
            html += '</div></td>';
            html += '</tr>';
        }

        html += '</table></div>';
        return html;
    }

    /**
     * Build role-based survival summary for large scenarios (e.g. Orbital Arena).
     * Groups entities by team+role and shows mean survival per group.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildRoleSurvival(agg) {
        var roleKeys = Object.keys(agg.roleStats);
        if (roleKeys.length === 0) return '';

        // Sort: by team then by role priority (hva first)
        var rolePriority = { hva: 0, defender: 1, attacker: 2, escort: 3, sweep: 4 };
        roleKeys.sort(function(a, b) {
            var ra = agg.roleStats[a];
            var rb = agg.roleStats[b];
            var teamCmp = (ra.team || '').localeCompare(rb.team || '');
            if (teamCmp !== 0) return teamCmp;
            return (rolePriority[ra.role] || 99) - (rolePriority[rb.role] || 99);
        });

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Survival by Role</div>';
        html += '<table class="mca-entity-table">';

        for (var i = 0; i < roleKeys.length; i++) {
            var rs = agg.roleStats[roleKeys[i]];
            var pct = rs.meanSurvivalRate * 100;
            var color = _barColor(rs.meanSurvivalRate);
            var teamCol = _teamColor(rs.team);
            var roleLabel = _escapeHtml((rs.role || '?').toUpperCase());
            var countLabel = rs.entityCount + ' units';

            html += '<tr>';
            html += '<td class="mca-entity-name">';
            html += '<span class="mca-team-badge" style="background:' +
                teamCol + ';color:#000;">' + _escapeHtml((rs.team || '?').toUpperCase()) +
                '</span> ' + roleLabel;
            html += '<span style="color:#666;font-size:10px;margin-left:6px;">' + countLabel + '</span>';
            html += '</td>';
            html += '<td class="mca-bar-cell"><div class="mca-bar-bg">';
            html += '<div class="mca-bar-fill" style="width:' + pct.toFixed(1) +
                '%;background:' + color + ';"></div>';
            html += '<div class="mca-bar-label">' + _fmtPct(rs.meanSurvivalRate) +
                ' &plusmn; ' + _fmtPct(rs.stdSurvivalRate) + '</div>';
            html += '</div></td>';
            html += '</tr>';
        }

        html += '</table></div>';
        return html;
    }

    /**
     * Build the weapon effectiveness table HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildWeaponEffectiveness(agg) {
        var weaponTypes = Object.keys(agg.weaponStats);
        if (weaponTypes.length === 0) return '';

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Weapon Effectiveness</div>';
        html += '<table class="mca-weapon-table">';
        html += '<tr><th>Weapon</th><th>Launches</th><th>Kills</th>' +
            '<th>Misses</th><th>Pk</th></tr>';

        for (var i = 0; i < weaponTypes.length; i++) {
            var wt = weaponTypes[i];
            var ws = agg.weaponStats[wt];
            var pkColor = ws.observedPk >= 0.5 ? '#00ff00' : '#ff4444';

            html += '<tr>';
            html += '<td>' + _escapeHtml(wt) + '</td>';
            html += '<td>' + ws.launches + '</td>';
            html += '<td style="color:#00ff00;">' + ws.kills + '</td>';
            html += '<td style="color:#ff4444;">' + ws.misses + '</td>';
            html += '<td style="color:' + pkColor + ';">' +
                _fmtPct(ws.observedPk) + '</td>';
            html += '</tr>';
        }

        html += '</table></div>';
        return html;
    }

    /**
     * Build the kill distribution histogram HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildKillDistribution(agg) {
        var kills = agg.killsPerRun;
        if (!kills || kills.length === 0) return '';

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Kill Distribution</div>';
        html += '<div class="mca-dist-summary">Mean: ' +
            agg.killMean.toFixed(2) + ' &plusmn; ' + agg.killStd.toFixed(2) +
            '  (min: ' + agg.killMin + ', max: ' + agg.killMax + ')</div>';

        // Build histogram bins
        var minVal = agg.killMin;
        var maxVal = agg.killMax;
        var bins;
        var binEdges;

        if (minVal === maxVal) {
            // All runs have same kill count — single bin
            bins = [kills.length];
            binEdges = [{ lo: minVal, hi: maxVal }];
        } else {
            var numBins = Math.min(HISTOGRAM_BINS, maxVal - minVal + 1);
            var binWidth = (maxVal - minVal) / numBins;

            bins = [];
            binEdges = [];
            for (var b = 0; b < numBins; b++) {
                bins.push(0);
                binEdges.push({
                    lo: minVal + b * binWidth,
                    hi: minVal + (b + 1) * binWidth
                });
            }

            for (var i = 0; i < kills.length; i++) {
                var idx = Math.floor((kills[i] - minVal) / binWidth);
                if (idx >= numBins) idx = numBins - 1;  // handle maxVal edge case
                bins[idx]++;
            }
        }

        // Find max bin count for scaling
        var maxCount = 0;
        for (var j = 0; j < bins.length; j++) {
            if (bins[j] > maxCount) maxCount = bins[j];
        }

        html += '<div class="mca-histogram">';
        for (var k = 0; k < bins.length; k++) {
            var lo = binEdges[k].lo;
            var hi = binEdges[k].hi;
            var label;
            if (lo === hi) {
                label = Math.round(lo) + '';
            } else {
                label = Math.round(lo) + '-' + Math.round(hi);
            }
            var barPct = maxCount > 0 ? (bins[k] / maxCount) * 100 : 0;

            html += '<div class="mca-hist-row">';
            html += '<div class="mca-hist-label">' + label + '</div>';
            html += '<div class="mca-hist-bar-bg">';
            html += '<div class="mca-hist-bar" style="width:' + barPct.toFixed(1) + '%;"></div>';
            html += '</div>';
            html += '<div class="mca-hist-count">' + bins[k] + '</div>';
            html += '</div>';
        }
        html += '</div></div>';
        return html;
    }

    /**
     * Build the per-run results table HTML.
     * @param {Object} agg - aggregated stats
     * @returns {string}
     */
    function _buildPerRunTable(agg) {
        var summaries = agg.perRunSummaries;
        if (!summaries || summaries.length === 0) return '';

        var html = '<div class="mca-section">';
        html += '<div class="mca-section-title">Per-Run Results</div>';
        html += '<div class="mca-run-table-wrap" id="mca-run-table-wrap">';
        html += _renderRunTableBody(summaries, null, true);
        html += '</div></div>';
        return html;
    }

    /**
     * Render just the table HTML for per-run results (used for sorting).
     * @param {Object[]} summaries
     * @param {string|null} sortCol
     * @param {boolean} asc
     * @returns {string}
     */
    function _renderRunTableBody(summaries, sortCol, asc) {
        // Clone and sort
        var sorted = summaries.slice();
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
        var html = '<table class="mca-run-table">';
        html += '<tr>';
        html += '<th data-col="runIndex">#' + (sortCol === 'runIndex' ? arrow : '') + '</th>';
        html += '<th data-col="seed">Seed' + (sortCol === 'seed' ? arrow : '') + '</th>';
        html += '<th data-col="kills">Kills' + (sortCol === 'kills' ? arrow : '') + '</th>';
        html += '<th data-col="engagements">Eng' + (sortCol === 'engagements' ? arrow : '') + '</th>';
        html += '<th data-col="simTimeFinal">Time' + (sortCol === 'simTimeFinal' ? arrow : '') + '</th>';
        html += '</tr>';

        for (var i = 0; i < sorted.length; i++) {
            var s = sorted[i];
            html += '<tr>';
            html += '<td>' + s.runIndex + '</td>';
            html += '<td>' + s.seed + '</td>';
            html += '<td>' + s.kills + '</td>';
            html += '<td>' + s.engagements + '</td>';
            html += '<td>' + _fmtTime(s.simTimeFinal) + '</td>';
            html += '</tr>';
        }

        html += '</table>';
        return html;
    }

    /**
     * Build export buttons HTML.
     * @returns {string}
     */
    function _buildExportButtons() {
        var html = '<div class="mca-export-row">';
        html += '<button class="mca-export-btn" id="mca-export-csv">Export CSV</button>';
        html += '<button class="mca-export-btn" id="mca-export-json">Export JSON</button>';
        html += '</div>';
        return html;
    }

    // -------------------------------------------------------------------
    // Chart.js Rendering
    // -------------------------------------------------------------------

    /**
     * Destroy all active Chart.js instances and reset tab tracking.
     */
    function _destroyCharts() {
        for (var i = 0; i < _chartInstances.length; i++) {
            _chartInstances[i].destroy();
        }
        _chartInstances = [];
        _renderedTabs = {};
    }

    /**
     * Create a Chart.js chart inside a wrapper div, append to container.
     * @param {HTMLElement} container
     * @param {string} type - Chart.js chart type
     * @param {Object} data - Chart.js data config
     * @param {Object} options - Chart.js options config
     * @param {number} [height] - optional explicit height in px
     * @returns {Chart}
     */
    function _createChart(container, type, data, options, height) {
        var wrap = document.createElement('div');
        wrap.className = 'mca-chart-wrap';
        var canvas = document.createElement('canvas');
        wrap.appendChild(canvas);
        container.appendChild(wrap);
        if (height) {
            wrap.style.height = height + 'px';
        }
        var chart = new Chart(canvas, {
            type: type,
            data: data,
            options: options
        });
        _chartInstances.push(chart);
        return chart;
    }

    /**
     * Common Chart.js scale config for dark theme.
     */
    function _darkScale(opts) {
        var base = {
            ticks: { color: '#888', font: { family: '"Courier New", monospace', size: 10 } },
            grid: { color: '#222' }
        };
        if (opts) {
            var keys = Object.keys(opts);
            for (var i = 0; i < keys.length; i++) {
                base[keys[i]] = opts[keys[i]];
            }
        }
        return base;
    }

    /**
     * Render Overview tab charts: survival bar + kill histogram.
     */
    function _renderOverviewCharts(agg) {
        var container = document.getElementById('mca-charts-overview');
        if (!container) return;

        // 1. Entity survival horizontal bar chart
        var entityIds = Object.keys(agg.entityStats);
        if (entityIds.length > 0 && entityIds.length <= 50) {
            entityIds.sort(function(a, b) {
                return agg.entityStats[a].survivalRate - agg.entityStats[b].survivalRate;
            });
            var labels = [];
            var data = [];
            var bgColors = [];
            for (var i = 0; i < entityIds.length; i++) {
                var es = agg.entityStats[entityIds[i]];
                labels.push(es.name);
                data.push(es.survivalRate);
                bgColors.push(_teamColor(es.team));
            }
            var chartHeight = Math.max(180, entityIds.length * 28);
            _createChart(container, 'bar', {
                labels: labels,
                datasets: [{
                    label: 'Survival Rate',
                    data: data,
                    backgroundColor: bgColors,
                    borderWidth: 0
                }]
            }, {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: 4 },
                scales: {
                    x: _darkScale({
                        min: 0, max: 1,
                        ticks: {
                            color: '#888',
                            callback: function(v) { return (v * 100) + '%'; },
                            font: { family: '"Courier New", monospace', size: 10 }
                        }
                    }),
                    y: _darkScale({
                        ticks: {
                            color: '#ccc',
                            font: { family: '"Courier New", monospace', size: 10 }
                        },
                        grid: { display: false }
                    })
                },
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true, text: 'ENTITY SURVIVAL RATES',
                        color: '#ff8800',
                        font: { family: '"Courier New", monospace', size: 12, weight: 'bold' }
                    }
                }
            }, chartHeight);
        }

        // 2. Kill distribution histogram
        if (agg.killsPerRun && agg.killsPerRun.length > 0) {
            var kills = agg.killsPerRun;
            var minVal = agg.killMin;
            var maxVal = agg.killMax;
            var binLabels = [];
            var binData = [];

            if (minVal === maxVal) {
                binLabels = ['' + minVal];
                binData = [kills.length];
            } else {
                var numBins = Math.min(HISTOGRAM_BINS, maxVal - minVal + 1);
                var binWidth = (maxVal - minVal) / numBins;
                for (var b = 0; b < numBins; b++) {
                    var lo = minVal + b * binWidth;
                    var hi = minVal + (b + 1) * binWidth;
                    binLabels.push(Math.round(lo) + '-' + Math.round(hi));
                    binData.push(0);
                }
                for (var j = 0; j < kills.length; j++) {
                    var idx = Math.floor((kills[j] - minVal) / binWidth);
                    if (idx >= numBins) idx = numBins - 1;
                    binData[idx]++;
                }
            }

            _createChart(container, 'bar', {
                labels: binLabels,
                datasets: [{
                    label: 'Runs',
                    data: binData,
                    backgroundColor: '#ff8800',
                    borderWidth: 0
                }]
            }, {
                responsive: true,
                maintainAspectRatio: true,
                scales: {
                    x: _darkScale({
                        title: { display: true, text: 'Kills per Run', color: '#888' }
                    }),
                    y: _darkScale({
                        beginAtZero: true,
                        title: { display: true, text: 'Frequency', color: '#888' },
                        ticks: {
                            color: '#888', stepSize: 1,
                            font: { family: '"Courier New", monospace', size: 10 }
                        }
                    })
                },
                plugins: {
                    legend: { display: false },
                    title: {
                        display: true, text: 'KILL DISTRIBUTION',
                        color: '#ff8800',
                        font: { family: '"Courier New", monospace', size: 12, weight: 'bold' }
                    }
                }
            });
        }
    }

    /**
     * Render Weapons tab charts: effectiveness doughnut + kill chain funnel.
     */
    function _renderWeaponsCharts(agg) {
        var container = document.getElementById('mca-charts-weapons');
        if (!container) return;

        var weaponTypes = Object.keys(agg.weaponStats);
        if (weaponTypes.length === 0) return;

        // Color palette for weapon types
        var palette = ['#ff8800', '#4488ff', '#00ff00', '#ff44ff', '#44ffff', '#ffcc00'];

        // 1. Kills by weapon type doughnut
        var dLabels = [];
        var dData = [];
        var dColors = [];
        for (var i = 0; i < weaponTypes.length; i++) {
            var ws = agg.weaponStats[weaponTypes[i]];
            if (ws.kills > 0) {
                dLabels.push(weaponTypes[i]);
                dData.push(ws.kills);
                dColors.push(palette[i % palette.length]);
            }
        }

        if (dData.length > 0) {
            _createChart(container, 'doughnut', {
                labels: dLabels,
                datasets: [{
                    data: dData,
                    backgroundColor: dColors,
                    borderWidth: 1,
                    borderColor: '#1a1a1a'
                }]
            }, {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: '#ccc', font: { family: '"Courier New", monospace', size: 11 } }
                    },
                    title: {
                        display: true, text: 'KILLS BY WEAPON TYPE',
                        color: '#ff8800',
                        font: { family: '"Courier New", monospace', size: 12, weight: 'bold' }
                    }
                }
            });
        }

        // 2. Kill chain funnel: launches / kills / misses per weapon
        var fLabels = [];
        var launches = [];
        var fKills = [];
        var misses = [];
        for (var j = 0; j < weaponTypes.length; j++) {
            var ws2 = agg.weaponStats[weaponTypes[j]];
            fLabels.push(weaponTypes[j]);
            launches.push(ws2.launches);
            fKills.push(ws2.kills);
            misses.push(ws2.misses);
        }

        _createChart(container, 'bar', {
            labels: fLabels,
            datasets: [
                { label: 'Launches', data: launches, backgroundColor: '#ffcc00', borderWidth: 0 },
                { label: 'Kills', data: fKills, backgroundColor: '#00ff00', borderWidth: 0 },
                { label: 'Misses', data: misses, backgroundColor: '#ff4444', borderWidth: 0 }
            ]
        }, {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                x: _darkScale(),
                y: _darkScale({
                    beginAtZero: true,
                    ticks: {
                        color: '#888', stepSize: 1,
                        font: { family: '"Courier New", monospace', size: 10 }
                    }
                })
            },
            plugins: {
                legend: {
                    labels: { color: '#ccc', font: { family: '"Courier New", monospace', size: 11 } }
                },
                title: {
                    display: true, text: 'KILL CHAIN FUNNEL',
                    color: '#ff8800',
                    font: { family: '"Courier New", monospace', size: 12, weight: 'bold' }
                }
            }
        });
    }

    /**
     * Render Timeline tab chart: engagement scatter plot.
     */
    function _renderTimelineCharts(agg, results) {
        var container = document.getElementById('mca-charts-timeline');
        if (!container) return;

        var killPts = [];
        var launchPts = [];
        var missPts = [];

        for (var r = 0; r < results.length; r++) {
            var run = results[r];
            if (run.error) continue;
            var log = run.engagementLog || [];
            var runIdx = run.runIndex !== undefined ? run.runIndex : r;
            for (var e = 0; e < log.length; e++) {
                var evt = log[e];
                var pt = { x: evt.time || 0, y: runIdx };
                var res = (evt.result || '').toUpperCase();
                if (res === 'KILL') killPts.push(pt);
                else if (res === 'LAUNCH') launchPts.push(pt);
                else if (res === 'MISS') missPts.push(pt);
            }
        }

        if (killPts.length + launchPts.length + missPts.length === 0) {
            container.innerHTML = '<div style="color:#666;padding:20px;text-align:center;">' +
                'No engagement events to display.</div>';
            return;
        }

        _createChart(container, 'scatter', {
            datasets: [
                {
                    label: 'Kill', data: killPts,
                    backgroundColor: '#ff4444', pointRadius: 5,
                    pointStyle: 'crossRot'
                },
                {
                    label: 'Launch', data: launchPts,
                    backgroundColor: '#ffcc00', pointRadius: 4,
                    pointStyle: 'triangle'
                },
                {
                    label: 'Miss', data: missPts,
                    backgroundColor: '#888888', pointRadius: 3,
                    pointStyle: 'circle'
                }
            ]
        }, {
            responsive: true,
            maintainAspectRatio: true,
            scales: {
                x: _darkScale({
                    title: { display: true, text: 'Sim Time (s)', color: '#888' }
                }),
                y: _darkScale({
                    title: { display: true, text: 'Run #', color: '#888' },
                    ticks: {
                        color: '#888', stepSize: 1,
                        font: { family: '"Courier New", monospace', size: 10 }
                    },
                    reverse: true
                })
            },
            plugins: {
                legend: {
                    labels: { color: '#ccc', font: { family: '"Courier New", monospace', size: 11 } }
                },
                title: {
                    display: true, text: 'ENGAGEMENT TIMELINE',
                    color: '#ff8800',
                    font: { family: '"Courier New", monospace', size: 12, weight: 'bold' }
                },
                tooltip: {
                    callbacks: {
                        label: function(ctx) {
                            return ctx.dataset.label + ' at t=' + ctx.parsed.x.toFixed(1) +
                                's (run ' + ctx.parsed.y + ')';
                        }
                    }
                }
            }
        });
    }

    // -------------------------------------------------------------------
    // Panel Show / Hide
    // -------------------------------------------------------------------

    /**
     * Display the Monte Carlo analysis results panel.
     *
     * @param {Object} aggregated - result from aggregate()
     * @param {Object[]} results  - raw per-run results array
     */
    function showPanel(aggregated, results) {
        // Remove old panel if present
        hidePanel();

        // Inject styles
        _injectStyles();

        // Build panel HTML
        var panel = document.createElement('div');
        panel.id = PANEL_ID;

        var html = '';
        html += _buildHeader(aggregated);
        html += _buildErrorBanner(aggregated);

        // Tab navigation
        html += '<div class="mca-tabs">';
        html += '<button class="mca-tab active" data-tab="overview">Overview</button>';
        html += '<button class="mca-tab" data-tab="weapons">Weapons</button>';
        html += '<button class="mca-tab" data-tab="timeline">Timeline</button>';
        html += '<button class="mca-tab" data-tab="rawdata">Raw Data</button>';
        html += '</div>';

        // Overview tab (visible by default)
        html += '<div class="mca-tab-content" id="mca-tab-overview">';
        html += _buildTeamSurvival(aggregated);
        html += '<div id="mca-charts-overview"></div>';
        html += _buildEntitySurvival(aggregated);
        html += '</div>';

        // Weapons tab
        html += '<div class="mca-tab-content" id="mca-tab-weapons" style="display:none;">';
        html += '<div id="mca-charts-weapons"></div>';
        html += _buildWeaponEffectiveness(aggregated);
        html += '</div>';

        // Timeline tab
        html += '<div class="mca-tab-content" id="mca-tab-timeline" style="display:none;">';
        html += '<div id="mca-charts-timeline"></div>';
        html += '</div>';

        // Raw Data tab
        html += '<div class="mca-tab-content" id="mca-tab-rawdata" style="display:none;">';
        html += _buildKillDistribution(aggregated);
        html += _buildPerRunTable(aggregated);
        html += _buildExportButtons();
        html += '</div>';

        panel.innerHTML = html;
        document.body.appendChild(panel);
        _panel = panel;

        // Render overview charts immediately (visible tab)
        if (typeof Chart !== 'undefined') {
            _renderOverviewCharts(aggregated);
            _renderedTabs['overview'] = true;
        }

        // --- Event Listeners ---

        // Tab switching
        var tabs = panel.querySelectorAll('.mca-tab');
        for (var t = 0; t < tabs.length; t++) {
            tabs[t].addEventListener('click', function() {
                var tabName = this.getAttribute('data-tab');
                // Update active tab button
                var allTabs = panel.querySelectorAll('.mca-tab');
                for (var i = 0; i < allTabs.length; i++) {
                    allTabs[i].classList.remove('active');
                }
                this.classList.add('active');
                // Show/hide content
                var contents = panel.querySelectorAll('.mca-tab-content');
                for (var j = 0; j < contents.length; j++) {
                    contents[j].style.display = 'none';
                }
                var target = document.getElementById('mca-tab-' + tabName);
                if (target) target.style.display = 'block';
                // Lazy-render charts on first visit
                if (typeof Chart !== 'undefined' && !_renderedTabs[tabName]) {
                    _renderedTabs[tabName] = true;
                    if (tabName === 'weapons') _renderWeaponsCharts(aggregated);
                    else if (tabName === 'timeline') _renderTimelineCharts(aggregated, results);
                }
            });
        }

        // Close button
        var closeBtn = document.getElementById('mca-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                hidePanel();
            });
        }

        // Export CSV
        var csvBtn = document.getElementById('mca-export-csv');
        if (csvBtn) {
            csvBtn.addEventListener('click', function() {
                exportCSV(results);
            });
        }

        // Export JSON
        var jsonBtn = document.getElementById('mca-export-json');
        if (jsonBtn) {
            jsonBtn.addEventListener('click', function() {
                exportJSON(results, aggregated);
            });
        }

        // Sortable table headers
        _sortColumn = null;
        _sortAscending = true;
        var wrap = document.getElementById('mca-run-table-wrap');
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

                wrap.innerHTML = _renderRunTableBody(
                    aggregated.perRunSummaries, _sortColumn, _sortAscending
                );
            });
        }
    }

    /**
     * Remove the analysis panel from the DOM.
     */
    function hidePanel() {
        _destroyCharts();
        var existing = document.getElementById(PANEL_ID);
        if (existing) {
            existing.parentNode.removeChild(existing);
        }
        _panel = null;
    }

    // -------------------------------------------------------------------
    // Export Functions
    // -------------------------------------------------------------------

    /**
     * Download flattened engagement logs as a CSV file.
     *
     * @param {Object[]} results - raw per-run results array
     */
    function exportCSV(results) {
        var lines = ['Run,Seed,Time,Source,SourceTeam,Target,Result,WeaponType'];

        for (var i = 0; i < results.length; i++) {
            var run = results[i];
            if (run.error) continue;
            var log = run.engagementLog || [];
            for (var j = 0; j < log.length; j++) {
                var evt = log[j];
                var fields = [
                    run.runIndex,
                    run.seed,
                    (evt.time !== undefined ? evt.time.toFixed(2) : ''),
                    _csvEscape(evt.sourceName || ''),
                    _csvEscape(evt.sourceTeam || ''),
                    _csvEscape(evt.targetName || ''),
                    _csvEscape(evt.result || ''),
                    _csvEscape(evt.weaponType || '')
                ];
                lines.push(fields.join(','));
            }
        }

        var csv = lines.join('\n');
        var timestamp = _timestamp();
        _downloadBlob(csv, 'text/csv', 'mc_results_' + timestamp + '.csv');
    }

    /**
     * Download full results as a JSON file.
     *
     * @param {Object[]} results     - raw per-run results array
     * @param {Object}   aggregated  - result from aggregate()
     */
    function exportJSON(results, aggregated) {
        var payload = {
            aggregated: aggregated,
            runs: results
        };
        var json = JSON.stringify(payload, null, 2);
        var timestamp = _timestamp();
        _downloadBlob(json, 'application/json', 'mc_results_' + timestamp + '.json');
    }

    /**
     * Escape a value for CSV (wrap in quotes if it contains comma, quote, or newline).
     * @param {string} val
     * @returns {string}
     */
    function _csvEscape(val) {
        var s = String(val);
        if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }

    /**
     * Generate a compact timestamp string for filenames.
     * @returns {string} e.g. "20260130_143022"
     */
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

    /**
     * Create a Blob and trigger a browser download.
     * @param {string} content
     * @param {string} mimeType
     * @param {string} filename
     */
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

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        aggregate: aggregate,
        showPanel: showPanel,
        hidePanel: hidePanel,
        exportCSV: exportCSV,
        exportJSON: exportJSON
    };

})();
