/**
 * MCPanel — Monte Carlo configuration UI panel.
 *
 * Modal dialog for configuring and launching Monte Carlo batch runs.
 * Allows user to set number of runs, base seed, and max sim time.
 * Displays a progress bar during execution and auto-opens the
 * MCAnalysis results panel on completion.
 *
 * Usage:
 *   MCPanel.init();    // inject CSS and create DOM (idempotent)
 *   MCPanel.show();    // open the panel
 *   MCPanel.hide();    // close the panel
 */
var MCPanel = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _initialized = false;
    var _overlay = null;
    var _modal = null;
    var _progressFill = null;
    var _statusText = null;
    var _warningDiv = null;
    var _btnStart = null;
    var _btnCancel = null;
    var _inputNumRuns = null;
    var _inputBaseSeed = null;
    var _inputMaxTime = null;
    var _selectEngine = null;
    var _startTime = 0;
    var _cppEngineAvailable = false;
    var _abortController = null;

    // -------------------------------------------------------------------
    // CSS Injection
    // -------------------------------------------------------------------

    function _injectCSS() {
        if (document.getElementById('mc-panel-styles')) return;

        var style = document.createElement('style');
        style.id = 'mc-panel-styles';
        style.textContent = [
            '#mcOverlay {',
            '  position: fixed; top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(0,0,0,0.5); z-index: 70; display: none;',
            '}',
            '#mcModal {',
            '  position: fixed; top: 50%; left: 50%;',
            '  transform: translate(-50%, -50%);',
            '  width: 420px;',
            '  background: rgba(10, 15, 10, 0.95);',
            '  border: 1px solid #ff8800;',
            '  border-radius: 6px;',
            '  padding: 20px;',
            '  font-family: "Courier New", monospace;',
            '  color: #ff8800;',
            '  z-index: 71;',
            '  display: none;',
            '}',
            '#mcModal .mc-title-row {',
            '  display: flex; justify-content: space-between; align-items: center;',
            '  margin-bottom: 12px; padding-bottom: 8px;',
            '  border-bottom: 1px solid #334;',
            '}',
            '#mcModal .mc-title {',
            '  font-size: 14px; font-weight: bold; letter-spacing: 1px;',
            '}',
            '#mcModal .mc-close-btn {',
            '  background: none; border: none; color: #888; font-size: 18px;',
            '  cursor: pointer; padding: 0 4px; line-height: 1;',
            '}',
            '#mcModal .mc-close-btn:hover { color: #fff; }',
            '#mcModal .mc-field { margin-bottom: 12px; }',
            '#mcModal .mc-label {',
            '  display: block; font-size: 11px; color: #aaa;',
            '  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;',
            '}',
            '#mcModal .mc-input {',
            '  background: #0a0e17; border: 1px solid #334; color: #ffcc00;',
            '  padding: 6px; width: 100%; font-family: monospace; font-size: 13px;',
            '  border-radius: 3px; box-sizing: border-box;',
            '}',
            '#mcModal .mc-input:focus {',
            '  outline: none; border-color: #ff8800;',
            '}',
            '#mcModal .mc-seed-row {',
            '  display: flex; gap: 8px; align-items: stretch;',
            '}',
            '#mcModal .mc-seed-row .mc-input { flex: 1; }',
            '#mcModal .mc-random-btn {',
            '  background: #1a1e2a; border: 1px solid #334; color: #888;',
            '  font-family: monospace; font-size: 11px; padding: 4px 10px;',
            '  cursor: pointer; border-radius: 3px; white-space: nowrap;',
            '}',
            '#mcModal .mc-random-btn:hover { color: #ffcc00; border-color: #ff8800; }',
            '#mcWarning {',
            '  display: none; margin-bottom: 12px; padding: 8px;',
            '  background: rgba(255, 136, 0, 0.1);',
            '  border: 1px solid rgba(255, 136, 0, 0.3);',
            '  border-radius: 3px; font-size: 11px; color: #ff8800;',
            '}',
            '#mcModal .mc-progress-section {',
            '  margin-top: 4px; padding-top: 12px; border-top: 1px solid #334;',
            '}',
            '#mcProgressBar {',
            '  height: 20px; background: #1a1a1a;',
            '  border: 1px solid #334; border-radius: 3px;',
            '  overflow: hidden; position: relative;',
            '}',
            '#mcProgressFill {',
            '  height: 100%; background: #ff8800; border-radius: 2px;',
            '  width: 0%; transition: width 0.2s;',
            '}',
            '#mcProgressBar .mc-progress-text {',
            '  position: absolute; top: 0; left: 0; width: 100%; height: 100%;',
            '  display: flex; align-items: center; justify-content: center;',
            '  font-size: 11px; color: #fff; font-weight: bold;',
            '  text-shadow: 0 0 3px #000;',
            '}',
            '#mcStatusText {',
            '  font-size: 11px; color: #888; margin-top: 4px;',
            '}',
            '#mcModal .mc-btn-row {',
            '  display: flex; justify-content: center; gap: 16px;',
            '  margin-top: 12px; padding-top: 12px; border-top: 1px solid #334;',
            '}',
            '#mcBtnStart {',
            '  background: #ff8800; color: #000; font-weight: bold;',
            '  padding: 8px 24px; border: none; border-radius: 4px;',
            '  cursor: pointer; font-family: monospace; font-size: 13px;',
            '}',
            '#mcBtnStart:hover { background: #ffaa33; }',
            '#mcBtnStart:disabled { background: #554400; color: #666; cursor: default; }',
            '#mcBtnCancel {',
            '  background: transparent; color: #ff8800;',
            '  border: 1px solid #ff8800; padding: 8px 24px;',
            '  border-radius: 4px; cursor: pointer;',
            '  font-family: monospace; font-size: 13px;',
            '}',
            '#mcBtnCancel:hover { background: rgba(255, 136, 0, 0.1); }',
            '#mcBtnCancel:disabled {',
            '  color: #554400; border-color: #554400; cursor: default;',
            '  background: transparent;',
            '}'
        ].join('\n');

        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------
    // DOM Construction
    // -------------------------------------------------------------------

    function _createDOM() {
        // Overlay
        _overlay = document.createElement('div');
        _overlay.id = 'mcOverlay';
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) {
                _handleClose();
            }
        });

        // Modal
        _modal = document.createElement('div');
        _modal.id = 'mcModal';

        // Title row
        var titleRow = document.createElement('div');
        titleRow.className = 'mc-title-row';

        var title = document.createElement('span');
        title.className = 'mc-title';
        title.textContent = 'MONTE CARLO SIMULATION';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'mc-close-btn';
        closeBtn.textContent = '\u00D7';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', function() {
            _handleClose();
        });

        titleRow.appendChild(title);
        titleRow.appendChild(closeBtn);
        _modal.appendChild(titleRow);

        // --- Number of Runs ---
        var fieldRuns = document.createElement('div');
        fieldRuns.className = 'mc-field';

        var labelRuns = document.createElement('label');
        labelRuns.className = 'mc-label';
        labelRuns.textContent = 'Number of Runs:';
        labelRuns.setAttribute('for', 'mcNumRuns');

        _inputNumRuns = document.createElement('input');
        _inputNumRuns.type = 'number';
        _inputNumRuns.id = 'mcNumRuns';
        _inputNumRuns.className = 'mc-input';
        _inputNumRuns.min = '1';
        _inputNumRuns.max = '10000';
        _inputNumRuns.value = '100';

        fieldRuns.appendChild(labelRuns);
        fieldRuns.appendChild(_inputNumRuns);
        _modal.appendChild(fieldRuns);

        // --- Base Seed ---
        var fieldSeed = document.createElement('div');
        fieldSeed.className = 'mc-field';

        var labelSeed = document.createElement('label');
        labelSeed.className = 'mc-label';
        labelSeed.textContent = 'Base Seed:';
        labelSeed.setAttribute('for', 'mcBaseSeed');

        var seedRow = document.createElement('div');
        seedRow.className = 'mc-seed-row';

        _inputBaseSeed = document.createElement('input');
        _inputBaseSeed.type = 'number';
        _inputBaseSeed.id = 'mcBaseSeed';
        _inputBaseSeed.className = 'mc-input';
        _inputBaseSeed.min = '0';
        _inputBaseSeed.value = '42';

        var randomBtn = document.createElement('button');
        randomBtn.className = 'mc-random-btn';
        randomBtn.textContent = 'Random';
        randomBtn.title = 'Generate random seed';
        randomBtn.addEventListener('click', function() {
            _inputBaseSeed.value = String(Math.floor(Math.random() * 100000));
        });

        seedRow.appendChild(_inputBaseSeed);
        seedRow.appendChild(randomBtn);
        fieldSeed.appendChild(labelSeed);
        fieldSeed.appendChild(seedRow);
        _modal.appendChild(fieldSeed);

        // --- Max Sim Time ---
        var fieldTime = document.createElement('div');
        fieldTime.className = 'mc-field';

        var labelTime = document.createElement('label');
        labelTime.className = 'mc-label';
        labelTime.textContent = 'Max Sim Time (seconds):';
        labelTime.setAttribute('for', 'mcMaxTime');

        _inputMaxTime = document.createElement('input');
        _inputMaxTime.type = 'number';
        _inputMaxTime.id = 'mcMaxTime';
        _inputMaxTime.className = 'mc-input';
        _inputMaxTime.min = '10';
        _inputMaxTime.max = '3600';
        _inputMaxTime.value = '300';

        fieldTime.appendChild(labelTime);
        fieldTime.appendChild(_inputMaxTime);
        _modal.appendChild(fieldTime);

        // --- Engine Selector ---
        var fieldEngine = document.createElement('div');
        fieldEngine.className = 'mc-field';

        var labelEngine = document.createElement('label');
        labelEngine.className = 'mc-label';
        labelEngine.textContent = 'Simulation Engine:';
        labelEngine.setAttribute('for', 'mcEngine');

        _selectEngine = document.createElement('select');
        _selectEngine.id = 'mcEngine';
        _selectEngine.className = 'mc-input';
        _selectEngine.style.cursor = 'pointer';

        var optJS = document.createElement('option');
        optJS.value = 'js';
        optJS.textContent = 'JavaScript (in-browser, slow)';
        _selectEngine.appendChild(optJS);

        var optCpp = document.createElement('option');
        optCpp.value = 'cpp';
        optCpp.textContent = 'C++ Engine (fast, requires mc_server)';
        _selectEngine.appendChild(optCpp);

        fieldEngine.appendChild(labelEngine);
        fieldEngine.appendChild(_selectEngine);
        _modal.appendChild(fieldEngine);

        // Check C++ engine availability
        _checkCppEngine();

        // --- Warning ---
        _warningDiv = document.createElement('div');
        _warningDiv.id = 'mcWarning';
        _modal.appendChild(_warningDiv);

        // --- Progress Section ---
        var progressSection = document.createElement('div');
        progressSection.className = 'mc-progress-section';

        var progressBar = document.createElement('div');
        progressBar.id = 'mcProgressBar';

        _progressFill = document.createElement('div');
        _progressFill.id = 'mcProgressFill';

        var progressText = document.createElement('div');
        progressText.className = 'mc-progress-text';
        progressText.id = 'mcProgressText';
        progressText.textContent = '0%';

        progressBar.appendChild(_progressFill);
        progressBar.appendChild(progressText);
        progressSection.appendChild(progressBar);

        _statusText = document.createElement('div');
        _statusText.id = 'mcStatusText';
        _statusText.textContent = 'Ready';
        progressSection.appendChild(_statusText);

        _modal.appendChild(progressSection);

        // --- Buttons ---
        var btnRow = document.createElement('div');
        btnRow.className = 'mc-btn-row';

        _btnStart = document.createElement('button');
        _btnStart.id = 'mcBtnStart';
        _btnStart.textContent = 'Start';
        _btnStart.addEventListener('click', function() {
            _onStart();
        });

        _btnCancel = document.createElement('button');
        _btnCancel.id = 'mcBtnCancel';
        _btnCancel.textContent = 'Cancel';
        _btnCancel.disabled = true;
        _btnCancel.addEventListener('click', function() {
            _onCancel();
        });

        btnRow.appendChild(_btnStart);
        btnRow.appendChild(_btnCancel);
        _modal.appendChild(btnRow);

        // Attach to body
        document.body.appendChild(_overlay);
        document.body.appendChild(_modal);

        // Escape key handler
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && _modal && _modal.style.display !== 'none') {
                _handleClose();
            }
        });
    }

    // -------------------------------------------------------------------
    // Warning Check
    // -------------------------------------------------------------------

    /**
     * Check scenario entities for player_input control and show/hide warning.
     * @param {Object} scenarioData
     */
    function _checkPlayerInputWarning(scenarioData) {
        var hasPlayerInput = false;

        if (scenarioData && scenarioData.entities && scenarioData.entities.length > 0) {
            for (var i = 0; i < scenarioData.entities.length; i++) {
                var entity = scenarioData.entities[i];
                if (entity.components &&
                    entity.components.control &&
                    entity.components.control.type === 'player_input') {
                    hasPlayerInput = true;
                    break;
                }
            }
        }

        if (hasPlayerInput) {
            _warningDiv.textContent = '\u26A0 Warning: Player-controlled entities will have no input in MC runs. Use AI control for all entities.';
            _warningDiv.style.display = 'block';
        } else {
            _warningDiv.style.display = 'none';
        }
    }

    // -------------------------------------------------------------------
    // Progress Helpers
    // -------------------------------------------------------------------

    /**
     * Reset the progress bar and status text to initial state.
     */
    function _resetProgress() {
        _progressFill.style.width = '0%';
        var progressTextEl = document.getElementById('mcProgressText');
        if (progressTextEl) {
            progressTextEl.textContent = '0%';
        }
        _statusText.textContent = 'Ready';
    }

    /**
     * Update the progress bar to a given percentage.
     * @param {number} pct — 0 to 100
     * @param {string} label — text to show inside bar
     */
    function _setProgress(pct, label) {
        _progressFill.style.width = pct + '%';
        var progressTextEl = document.getElementById('mcProgressText');
        if (progressTextEl) {
            progressTextEl.textContent = label || (Math.round(pct) + '%');
        }
    }

    // -------------------------------------------------------------------
    // Start / Cancel / Close
    // -------------------------------------------------------------------

    /**
     * Check if C++ MC engine is available via the bridge server.
     */
    function _checkCppEngine() {
        fetch('/api/mc/status')
            .then(function(resp) { return resp.json(); })
            .then(function(data) {
                _cppEngineAvailable = data.ready === true;
                if (_cppEngineAvailable && _selectEngine) {
                    _selectEngine.value = 'cpp';  // Auto-select C++ if available
                }
                if (!_cppEngineAvailable && _statusText) {
                    _statusText.textContent = 'C++ engine not found. Build with: cd build && cmake .. && ninja mc_engine';
                    _statusText.style.color = '#ff8800';
                }
            })
            .catch(function() {
                _cppEngineAvailable = false;
                if (_statusText) {
                    _statusText.textContent = 'MC server not running. Start with: node mc_server.js';
                    _statusText.style.color = '#ff4444';
                }
            });
    }

    /**
     * Run batch MC via the C++ engine bridge server.
     */
    var _pollTimer = null;

    function _runCppBatch(scenarioData, numRuns, baseSeed, maxSimTime) {
        _abortController = new AbortController();

        _statusText.textContent = 'Sending to C++ engine...';
        _setProgress(2, '...');

        var payload = {
            scenario: scenarioData,
            runs: numRuns,
            seed: baseSeed,
            maxTime: maxSimTime
        };

        fetch('/api/mc/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: _abortController.signal
        })
        .then(function(resp) {
            if (!resp.ok) {
                return resp.json().catch(function() {
                    throw new Error(resp.statusText || ('HTTP ' + resp.status));
                }).then(function(d) {
                    throw new Error(d.error || ('HTTP ' + resp.status));
                });
            }
            return resp.json();
        })
        .then(function(data) {
            if (!data.jobId) throw new Error('No jobId returned');
            _statusText.textContent = 'C++ engine running...';
            _setProgress(5, '5%');
            _pollBatchJob(data.jobId, numRuns);
        })
        .catch(function(err) {
            if (err.name === 'AbortError') {
                _statusText.textContent = 'Cancelled';
            } else {
                _statusText.textContent = 'Error: ' + err.message;
            }
            _btnStart.disabled = false;
            _btnCancel.disabled = true;
            _abortController = null;
        });
    }

    function _pollBatchJob(jobId, numRuns) {
        _pollTimer = setInterval(function() {
            fetch('/api/mc/jobs/' + jobId)
            .then(function(resp) { return resp.json(); })
            .then(function(job) {
                if (job.status === 'running') {
                    var p = job.progress || {};
                    var pct = p.pct || 0;
                    // Clamp to 5-95 range while running
                    pct = Math.max(5, Math.min(95, pct));
                    _setProgress(pct, pct + '%');

                    if (p.completed !== undefined && p.total !== undefined) {
                        var elapsed = job.elapsed || 0;
                        var perRun = p.completed > 0 ? elapsed / p.completed : 0;
                        var remaining = perRun * (p.total - p.completed);
                        var remStr = remaining < 60 ?
                            remaining.toFixed(1) + 's' :
                            (remaining / 60).toFixed(1) + 'm';
                        _statusText.textContent = 'Run ' + p.completed + '/' + p.total +
                            ' (' + pct + '%) ~' + remStr + ' remaining';
                    } else {
                        _statusText.textContent = 'C++ engine: ' + pct + '%';
                    }
                } else if (job.status === 'complete') {
                    clearInterval(_pollTimer);
                    _pollTimer = null;

                    var elapsed = ((Date.now() - _startTime) / 1000).toFixed(2);
                    _setProgress(100, '100%');
                    _statusText.textContent = 'C++ engine: ' + numRuns + ' runs in ' + elapsed + 's';

                    _btnStart.disabled = false;
                    _btnCancel.disabled = true;
                    _abortController = null;

                    var results = job.results;
                    if (typeof MCAnalysis !== 'undefined') {
                        var aggData = _convertCppResults(results, numRuns);
                        MCAnalysis.showPanel(aggData, aggData._rawRuns || []);
                    }

                    hide();

                    if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                        BuilderApp.showMessage('C++ MC complete: ' + numRuns + ' runs in ' + elapsed + 's');
                    }
                } else if (job.status === 'failed') {
                    clearInterval(_pollTimer);
                    _pollTimer = null;
                    _statusText.textContent = 'Error: ' + (job.error || 'unknown');
                    _btnStart.disabled = false;
                    _btnCancel.disabled = true;
                    _abortController = null;
                }
            })
            .catch(function() {
                clearInterval(_pollTimer);
                _pollTimer = null;
                _statusText.textContent = 'Lost connection to MC server';
                _btnStart.disabled = false;
                _btnCancel.disabled = true;
                _abortController = null;
            });
        }, 500);
    }

    /**
     * Convert C++ mc_engine batch results to MCAnalysis-compatible format.
     */
    function _convertCppResults(cppResults, numRuns) {
        // The C++ engine outputs: { runs: [...], summary: {...}, engagements: [...] }
        // MCAnalysis.aggregate expects per-run results with entitySurvival and engagementLog

        // Build synthetic per-run results from C++ output
        var syntheticRuns = [];
        var runs = cppResults.runs || [];

        for (var i = 0; i < runs.length; i++) {
            var run = runs[i];
            syntheticRuns.push({
                runIndex: run.runIndex !== undefined ? run.runIndex : i,
                seed: run.seed !== undefined ? run.seed : i,
                engagementLog: (run.engagements || []).map(function(e) {
                    return {
                        time: e.time,
                        sourceId: e.sourceId || e.attackerId || '',
                        sourceName: e.sourceName || e.attackerName || '',
                        sourceTeam: e.sourceTeam || '',
                        targetId: e.targetId || '',
                        targetName: e.targetName || '',
                        result: e.result || e.type || '',
                        weaponType: e.weaponType || 'UNKNOWN'
                    };
                }),
                entitySurvival: run.entitySurvival || run.survival || {},
                simTimeFinal: run.simTimeFinal || run.duration || 0,
                error: run.error || null
            });
        }

        // Use MCAnalysis.aggregate if available
        if (typeof MCAnalysis !== 'undefined' && MCAnalysis.aggregate) {
            var agg = MCAnalysis.aggregate(syntheticRuns);
            agg._rawRuns = syntheticRuns;
            agg._cppMeta = cppResults._serverMeta || {};
            return agg;
        }

        // Fallback: return raw data with minimal wrapping
        return {
            numRuns: numRuns,
            numErrors: 0,
            entityStats: {},
            teamStats: {},
            roleStats: {},
            weaponStats: {},
            killsPerRun: [],
            killMean: 0, killStd: 0, killMin: 0, killMax: 0,
            engMean: 0, engStd: 0,
            perRunSummaries: [],
            _rawRuns: syntheticRuns,
            _cppMeta: cppResults._serverMeta || {}
        };
    }

    function _onStart() {
        // Check server availability for C++ engine
        var engine = _selectEngine ? _selectEngine.value : 'js';
        if (engine === 'cpp' && !_cppEngineAvailable) {
            _statusText.textContent = 'MC server not running. Start it with: node mc_server.js';
            _statusText.style.color = '#ff4444';
            return;
        }

        var numRuns = parseInt(_inputNumRuns.value, 10);
        var baseSeed = parseInt(_inputBaseSeed.value, 10);
        var maxSimTime = parseInt(_inputMaxTime.value, 10);

        // Validate inputs
        if (isNaN(numRuns) || numRuns < 1) {
            _inputNumRuns.value = '1';
            numRuns = 1;
        }
        if (isNaN(baseSeed) || baseSeed < 0) {
            _inputBaseSeed.value = '0';
            baseSeed = 0;
        }
        if (isNaN(maxSimTime) || maxSimTime < 10) {
            _inputMaxTime.value = '10';
            maxSimTime = 10;
        }

        // Get scenario data
        var scenarioData = null;
        if (typeof BuilderApp !== 'undefined' && BuilderApp.getScenarioData) {
            scenarioData = BuilderApp.getScenarioData();
        }

        if (!scenarioData || !scenarioData.entities || scenarioData.entities.length === 0) {
            if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                BuilderApp.showMessage('No entities in scenario');
            }
            return;
        }

        // Disable Start, enable Cancel
        _btnStart.disabled = true;
        _btnCancel.disabled = false;

        // Reset progress
        _resetProgress();
        _statusText.textContent = 'Starting...';

        // Record start time
        _startTime = Date.now();

        // Check engine selection
        var engine = _selectEngine ? _selectEngine.value : 'js';
        if (engine === 'cpp') {
            _runCppBatch(scenarioData, numRuns, baseSeed, maxSimTime);
            return;
        }

        // Build config for JS runner
        var config = {
            scenarioData: scenarioData,
            numRuns: numRuns,
            baseSeed: baseSeed,
            maxSimTime: maxSimTime,
            onProgress: function(completed, total, pct) {
                var roundedPct = Math.round(pct);
                _setProgress(pct, roundedPct + '%');

                var elapsed = (Date.now() - _startTime) / 1000;
                var perRun = completed > 0 ? elapsed / completed : 0;
                var remaining = perRun * (total - completed);
                var remainStr = remaining < 1 ? '<1s' : Math.round(remaining) + 's';

                _statusText.textContent = completed + '/' + total +
                    ' (' + roundedPct + '%) ~' + remainStr + ' remaining';
            },
            onComplete: function(results) {
                var elapsed = ((Date.now() - _startTime) / 1000).toFixed(1);
                _setProgress(100, '100%');
                _statusText.textContent = 'Complete: ' + results.length + ' runs in ' + elapsed + 's';

                // Re-enable buttons
                _btnStart.disabled = false;
                _btnCancel.disabled = true;

                // Aggregate and show results
                if (typeof MCAnalysis !== 'undefined') {
                    var agg = MCAnalysis.aggregate(results);
                    MCAnalysis.showPanel(agg, results);
                }

                // Hide MC panel (auto-close on completion)
                hide();

                // Show completion message
                if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                    BuilderApp.showMessage('Monte Carlo complete: ' + results.length + ' runs');
                }
            }
        };

        // Launch the run
        if (typeof MCRunner !== 'undefined' && MCRunner.start) {
            MCRunner.start(config);
        }
    }

    function _onCancel() {
        // Cancel C++ engine request if active
        if (_abortController) {
            _abortController.abort();
            _abortController = null;
        }

        // Cancel JS runner if active
        if (typeof MCRunner !== 'undefined' && MCRunner.cancel) {
            MCRunner.cancel();
        }

        _statusText.textContent = 'Cancelled';
        _btnStart.disabled = false;
        _btnCancel.disabled = true;
    }

    function _handleClose() {
        // If a run is in progress, just hide the panel (runner continues in background)
        hide();
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Inject CSS and create DOM elements. Idempotent — safe to call multiple times.
     */
    function init() {
        if (_initialized) return;

        _injectCSS();
        _createDOM();
        _initialized = true;
    }

    /**
     * Show the Monte Carlo configuration panel.
     * Resets progress if no run is currently active.
     */
    function show() {
        if (!_initialized) {
            init();
        }

        // Get scenario data and check for player_input warnings
        var scenarioData = null;
        if (typeof BuilderApp !== 'undefined' && BuilderApp.getScenarioData) {
            scenarioData = BuilderApp.getScenarioData();
        }
        _checkPlayerInputWarning(scenarioData);

        // If a run is active, show current progress state. Otherwise reset.
        var running = (typeof MCRunner !== 'undefined' && MCRunner.isRunning && MCRunner.isRunning());
        if (!running) {
            _resetProgress();
            _btnStart.disabled = false;
            _btnCancel.disabled = true;
        } else {
            _btnStart.disabled = true;
            _btnCancel.disabled = false;
        }

        _overlay.style.display = 'block';
        _modal.style.display = 'block';
    }

    /**
     * Hide the Monte Carlo configuration panel.
     */
    function hide() {
        if (!_initialized) return;

        _overlay.style.display = 'none';
        _modal.style.display = 'none';
    }

    // -------------------------------------------------------------------
    // Module Export
    // -------------------------------------------------------------------
    return {
        init: init,
        show: show,
        hide: hide
    };

})();
