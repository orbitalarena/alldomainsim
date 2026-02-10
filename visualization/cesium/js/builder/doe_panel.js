/**
 * DOEPanel — Design of Experiments configuration UI panel for Orbital Arena.
 *
 * Modal dialog for configuring and launching DOE sweeps across role compositions.
 * Generates Cartesian product of role ranges (HVA, Defender, Attacker, Escort, Sweep),
 * sends permutations to the server, and polls for completion.
 *
 * Usage:
 *   DOEPanel.init();    // inject CSS and create DOM (idempotent)
 *   DOEPanel.show();    // open the panel
 *   DOEPanel.hide();    // close the panel
 */
var DOEPanel = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _initialized = false;
    var _overlay = null;
    var _modal = null;
    var _progressFill = null;
    var _progressTextEl = null;
    var _statusText = null;
    var _btnStart = null;
    var _btnCancel = null;
    var _permCountDisplay = null;
    var _inputSeed = null;
    var _inputMaxTime = null;
    var _arenaSection = null;
    var _arenaInputs = {};
    var _abortController = null;
    var _pollTimer = null;
    var _startTime = 0;

    // Role definitions: name, label, defaults
    var _roles = [
        { name: 'hva',      label: 'HVA',      minDef: 10, maxDef: 50,  stepDef: 10 },
        { name: 'defender',  label: 'Defender',  minDef: 0,  maxDef: 100, stepDef: 25 },
        { name: 'attacker',  label: 'Attacker',  minDef: 0,  maxDef: 100, stepDef: 25 },
        { name: 'escort',    label: 'Escort',    minDef: 0,  maxDef: 50,  stepDef: 25 },
        { name: 'sweep',     label: 'Sweep',     minDef: 0,  maxDef: 50,  stepDef: 25 }
    ];

    // Role input elements: { hva: { min, max, step }, ... }
    var _roleInputs = {};

    // Advanced parameter inputs
    var _advancedInputs = {};
    var _weaponCheckboxes = {};

    // -------------------------------------------------------------------
    // CSS Injection
    // -------------------------------------------------------------------

    function _injectCSS() {
        if (document.getElementById('doe-panel-styles')) return;

        var style = document.createElement('style');
        style.id = 'doe-panel-styles';
        style.textContent = [
            '#doeOverlay {',
            '  position: fixed; top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(0,0,0,0.5); z-index: 70; display: none;',
            '}',
            '#doeModal {',
            '  position: fixed; top: 50%; left: 50%;',
            '  transform: translate(-50%, -50%);',
            '  width: 560px;',
            '  max-height: 85vh;',
            '  overflow-y: auto;',
            '  background: rgba(10, 15, 10, 0.95);',
            '  border: 1px solid #00ccff;',
            '  border-radius: 6px;',
            '  padding: 20px;',
            '  font-family: "Courier New", monospace;',
            '  color: #00ccff;',
            '  z-index: 71;',
            '  display: none;',
            '}',
            '#doeModal .doe-title-row {',
            '  display: flex; justify-content: space-between; align-items: center;',
            '  margin-bottom: 12px; padding-bottom: 8px;',
            '  border-bottom: 1px solid #334;',
            '}',
            '#doeModal .doe-title {',
            '  font-size: 14px; font-weight: bold; letter-spacing: 1px;',
            '}',
            '#doeModal .doe-close-btn {',
            '  background: none; border: none; color: #888; font-size: 18px;',
            '  cursor: pointer; padding: 0 4px; line-height: 1;',
            '}',
            '#doeModal .doe-close-btn:hover { color: #fff; }',
            '#doeModal .doe-section {',
            '  margin-bottom: 16px;',
            '}',
            '#doeModal .doe-section-label {',
            '  font-size: 11px; color: #aaa; text-transform: uppercase;',
            '  letter-spacing: 0.5px; margin-bottom: 8px;',
            '  border-bottom: 1px solid #223; padding-bottom: 4px;',
            '}',
            '#doeModal .doe-field { margin-bottom: 12px; }',
            '#doeModal .doe-label {',
            '  display: block; font-size: 11px; color: #aaa;',
            '  margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px;',
            '}',
            '#doeModal .doe-input {',
            '  background: #0a0e17; border: 1px solid #334; color: #ffcc00;',
            '  padding: 6px; width: 100%; font-family: monospace; font-size: 13px;',
            '  border-radius: 3px; box-sizing: border-box;',
            '}',
            '#doeModal .doe-input:focus {',
            '  outline: none; border-color: #00ccff;',
            '}',
            '#doeModal .doe-seed-row {',
            '  display: flex; gap: 8px; align-items: stretch;',
            '}',
            '#doeModal .doe-seed-row .doe-input { flex: 1; }',
            '#doeModal .doe-random-btn {',
            '  background: #1a1e2a; border: 1px solid #334; color: #888;',
            '  font-family: monospace; font-size: 11px; padding: 4px 10px;',
            '  cursor: pointer; border-radius: 3px; white-space: nowrap;',
            '}',
            '#doeModal .doe-random-btn:hover { color: #ffcc00; border-color: #00ccff; }',
            /* Role table */
            '#doeModal .doe-role-table {',
            '  width: 100%; border-collapse: collapse;',
            '}',
            '#doeModal .doe-role-table th {',
            '  font-size: 10px; color: #888; text-transform: uppercase;',
            '  letter-spacing: 0.5px; padding: 4px 6px; text-align: center;',
            '  border-bottom: 1px solid #223;',
            '}',
            '#doeModal .doe-role-table th:first-child { text-align: left; }',
            '#doeModal .doe-role-table td {',
            '  padding: 4px 6px;',
            '}',
            '#doeModal .doe-role-table td:first-child {',
            '  font-size: 12px; color: #00ccff; white-space: nowrap;',
            '}',
            '#doeModal .doe-role-input {',
            '  background: #0a0e17; border: 1px solid #334; color: #ffcc00;',
            '  padding: 4px 6px; width: 70px; font-family: monospace; font-size: 12px;',
            '  border-radius: 3px; box-sizing: border-box; text-align: center;',
            '}',
            '#doeModal .doe-role-input:focus {',
            '  outline: none; border-color: #00ccff;',
            '}',
            '#doeModal .doe-perm-count {',
            '  margin-top: 10px; font-size: 12px; color: #00ccff;',
            '  text-align: right;',
            '}',
            '#doeModal .doe-perm-count.warn { color: #ffcc00; }',
            '#doeModal .doe-perm-count.danger { color: #ff4444; }',
            /* Collapsible arena section */
            '#doeModal .doe-collapsible-header {',
            '  cursor: pointer; font-size: 11px; color: #888;',
            '  text-transform: uppercase; letter-spacing: 0.5px;',
            '  padding: 6px 0; user-select: none;',
            '}',
            '#doeModal .doe-collapsible-header:hover { color: #00ccff; }',
            '#doeModal .doe-collapsible-header .doe-arrow {',
            '  display: inline-block; transition: transform 0.2s; margin-right: 6px;',
            '}',
            '#doeModal .doe-collapsible-header.open .doe-arrow {',
            '  transform: rotate(90deg);',
            '}',
            '#doeModal .doe-collapsible-body {',
            '  display: none; padding-left: 12px;',
            '}',
            '#doeModal .doe-collapsible-body.open { display: block; }',
            '#doeModal .doe-arena-grid {',
            '  display: grid; grid-template-columns: 1fr 1fr; gap: 8px;',
            '}',
            '#doeModal .doe-arena-field { }',
            '#doeModal .doe-arena-label {',
            '  display: block; font-size: 10px; color: #888;',
            '  margin-bottom: 2px; text-transform: uppercase;',
            '}',
            '#doeModal .doe-arena-input {',
            '  background: #0a0e17; border: 1px solid #334; color: #ffcc00;',
            '  padding: 4px 6px; width: 100%; font-family: monospace; font-size: 12px;',
            '  border-radius: 3px; box-sizing: border-box;',
            '}',
            '#doeModal .doe-arena-input:focus {',
            '  outline: none; border-color: #00ccff;',
            '}',
            /* Progress */
            '#doeModal .doe-progress-section {',
            '  margin-top: 4px; padding-top: 12px; border-top: 1px solid #334;',
            '}',
            '#doeProgressBar {',
            '  height: 20px; background: #1a1a1a;',
            '  border: 1px solid #334; border-radius: 3px;',
            '  overflow: hidden; position: relative;',
            '}',
            '#doeProgressFill {',
            '  height: 100%; background: #00ccff; border-radius: 2px;',
            '  width: 0%; transition: width 0.2s;',
            '}',
            '#doeProgressBar .doe-progress-text {',
            '  position: absolute; top: 0; left: 0; width: 100%; height: 100%;',
            '  display: flex; align-items: center; justify-content: center;',
            '  font-size: 11px; color: #fff; font-weight: bold;',
            '  text-shadow: 0 0 3px #000;',
            '}',
            '#doeStatusText {',
            '  font-size: 11px; color: #888; margin-top: 4px;',
            '}',
            /* Buttons */
            '#doeModal .doe-btn-row {',
            '  display: flex; justify-content: center; gap: 16px;',
            '  margin-top: 12px; padding-top: 12px; border-top: 1px solid #334;',
            '}',
            '#doeBtnStart {',
            '  background: #00ccff; color: #000; font-weight: bold;',
            '  padding: 8px 24px; border: none; border-radius: 4px;',
            '  cursor: pointer; font-family: monospace; font-size: 13px;',
            '}',
            '#doeBtnStart:hover { background: #33ddff; }',
            '#doeBtnStart:disabled { background: #005566; color: #666; cursor: default; }',
            '#doeBtnCancel {',
            '  background: transparent; color: #00ccff;',
            '  border: 1px solid #00ccff; padding: 8px 24px;',
            '  border-radius: 4px; cursor: pointer;',
            '  font-family: monospace; font-size: 13px;',
            '}',
            '#doeBtnCancel:hover { background: rgba(0, 204, 255, 0.1); }',
            '#doeBtnCancel:disabled {',
            '  color: #005566; border-color: #005566; cursor: default;',
            '  background: transparent;',
            '}',
            /* Advanced parameters section */
            '#doeModal .doe-advanced-section {',
            '  margin-top: 8px;',
            '}',
            '#doeModal .doe-advanced-grid {',
            '  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;',
            '  margin-top: 6px;',
            '}',
            '#doeModal .doe-advanced-field label {',
            '  display: block; font-size: 10px; color: #888;',
            '  margin-bottom: 2px; text-transform: uppercase;',
            '}',
            '#doeModal .doe-advanced-input {',
            '  background: #0a0e17; border: 1px solid #334; color: #ffcc00;',
            '  padding: 4px 6px; width: 100%; font-family: monospace; font-size: 12px;',
            '  border-radius: 3px; box-sizing: border-box; text-align: center;',
            '}',
            '#doeModal .doe-advanced-input:focus {',
            '  outline: none; border-color: #00ccff;',
            '}',
            '#doeModal .doe-weapon-checks {',
            '  display: flex; gap: 16px; margin-top: 6px; flex-wrap: wrap;',
            '}',
            '#doeModal .doe-weapon-check {',
            '  display: flex; align-items: center; gap: 4px;',
            '  font-size: 11px; color: #aaa; cursor: pointer;',
            '}',
            '#doeModal .doe-weapon-check input[type="checkbox"] {',
            '  accent-color: #00ccff; cursor: pointer;',
            '}',
            '#doeModal .doe-perm-warning {',
            '  margin-top: 4px; font-size: 10px; color: #ffcc00;',
            '  display: none;',
            '}',
            '#doeModal .doe-perm-warning.visible { display: block; }',
            '#doeModal .doe-perm-est {',
            '  font-size: 10px; color: #889; margin-top: 2px;',
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
        _overlay.id = 'doeOverlay';
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) {
                _handleClose();
            }
        });

        // Modal
        _modal = document.createElement('div');
        _modal.id = 'doeModal';

        // --- Title Row ---
        var titleRow = document.createElement('div');
        titleRow.className = 'doe-title-row';

        var title = document.createElement('span');
        title.className = 'doe-title';
        title.textContent = 'DESIGN OF EXPERIMENTS \u2014 ORBITAL ARENA';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'doe-close-btn';
        closeBtn.textContent = '\u00D7';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', function() {
            _handleClose();
        });

        titleRow.appendChild(title);
        titleRow.appendChild(closeBtn);
        _modal.appendChild(titleRow);

        // --- Section: Role Composition ---
        _modal.appendChild(_buildRoleSection());

        // --- Section: Advanced Parameters (collapsible) ---
        _modal.appendChild(_buildAdvancedParamsSection());

        // --- Section: Simulation Parameters ---
        _modal.appendChild(_buildSimParamsSection());

        // --- Progress Section ---
        _modal.appendChild(_buildProgressSection());

        // --- Button Row ---
        _modal.appendChild(_buildButtonRow());

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
    // Section Builders
    // -------------------------------------------------------------------

    function _buildRoleSection() {
        var section = document.createElement('div');
        section.className = 'doe-section';

        var label = document.createElement('div');
        label.className = 'doe-section-label';
        label.textContent = 'ROLE RANGES (PER SIDE)';
        section.appendChild(label);

        // Table
        var table = document.createElement('table');
        table.className = 'doe-role-table';

        // Header row
        var thead = document.createElement('thead');
        var headerRow = document.createElement('tr');
        var headers = ['Role', 'Min', 'Max', 'Step'];
        for (var h = 0; h < headers.length; h++) {
            var th = document.createElement('th');
            th.textContent = headers[h];
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body rows
        var tbody = document.createElement('tbody');
        for (var i = 0; i < _roles.length; i++) {
            var role = _roles[i];
            var tr = document.createElement('tr');

            // Role label cell
            var tdLabel = document.createElement('td');
            tdLabel.textContent = role.label;
            tr.appendChild(tdLabel);

            // Min, Max, Step cells
            _roleInputs[role.name] = {};

            var fields = [
                { key: 'min', val: role.minDef },
                { key: 'max', val: role.maxDef },
                { key: 'step', val: role.stepDef }
            ];

            for (var f = 0; f < fields.length; f++) {
                var td = document.createElement('td');
                var input = document.createElement('input');
                input.type = 'number';
                input.className = 'doe-role-input';
                input.min = '0';
                if (fields[f].key === 'step') {
                    input.min = '1';
                }
                input.value = String(fields[f].val);
                input.addEventListener('input', _updatePermutationCount);
                _roleInputs[role.name][fields[f].key] = input;
                td.appendChild(input);
                tr.appendChild(td);
            }

            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        section.appendChild(table);

        // Permutation count display
        _permCountDisplay = document.createElement('div');
        _permCountDisplay.className = 'doe-perm-count';
        _permCountDisplay.textContent = '0 permutations';
        section.appendChild(_permCountDisplay);

        // Initialize count
        setTimeout(_updatePermutationCount, 0);

        return section;
    }

    function _buildAdvancedParamsSection() {
        var wrapper = document.createElement('div');
        wrapper.className = 'doe-section doe-advanced-section';

        var header = document.createElement('div');
        header.className = 'doe-collapsible-header';

        var arrow = document.createElement('span');
        arrow.className = 'doe-arrow';
        arrow.textContent = '\u25B6';
        header.appendChild(arrow);

        var headerText = document.createTextNode('Advanced Parameters');
        header.appendChild(headerText);

        var body = document.createElement('div');
        body.className = 'doe-collapsible-body';

        header.addEventListener('click', function() {
            var isOpen = body.classList.contains('open');
            if (isOpen) {
                body.classList.remove('open');
                header.classList.remove('open');
            } else {
                body.classList.add('open');
                header.classList.add('open');
            }
        });

        // --- Orbital Altitude Range ---
        var altLabel = document.createElement('div');
        altLabel.className = 'doe-section-label';
        altLabel.textContent = 'ORBITAL ALTITUDE (SMA, km)';
        altLabel.style.marginTop = '8px';
        body.appendChild(altLabel);

        var altGrid = document.createElement('div');
        altGrid.className = 'doe-advanced-grid';

        var altFields = [
            { key: 'altMin',  label: 'Min (km)', value: '42164' },
            { key: 'altMax',  label: 'Max (km)', value: '42164' },
            { key: 'altStep', label: 'Step (km)', value: '100' }
        ];
        for (var ai = 0; ai < altFields.length; ai++) {
            var af = altFields[ai];
            var afDiv = document.createElement('div');
            afDiv.className = 'doe-advanced-field';
            var afLabel = document.createElement('label');
            afLabel.textContent = af.label;
            var afInput = document.createElement('input');
            afInput.type = 'number';
            afInput.className = 'doe-advanced-input';
            afInput.min = '100';
            if (af.key === 'altStep') afInput.min = '1';
            afInput.value = af.value;
            afInput.addEventListener('input', _updatePermutationCount);
            _advancedInputs[af.key] = afInput;
            afDiv.appendChild(afLabel);
            afDiv.appendChild(afInput);
            altGrid.appendChild(afDiv);
        }
        body.appendChild(altGrid);

        // --- Inclination Range ---
        var incLabel = document.createElement('div');
        incLabel.className = 'doe-section-label';
        incLabel.textContent = 'INCLINATION (degrees)';
        incLabel.style.marginTop = '12px';
        body.appendChild(incLabel);

        var incGrid = document.createElement('div');
        incGrid.className = 'doe-advanced-grid';

        var incFields = [
            { key: 'incMin',  label: 'Min (\u00B0)', value: '0' },
            { key: 'incMax',  label: 'Max (\u00B0)', value: '0' },
            { key: 'incStep', label: 'Step (\u00B0)', value: '15' }
        ];
        for (var ii = 0; ii < incFields.length; ii++) {
            var inf = incFields[ii];
            var inDiv = document.createElement('div');
            inDiv.className = 'doe-advanced-field';
            var inLabel = document.createElement('label');
            inLabel.textContent = inf.label;
            var inInput = document.createElement('input');
            inInput.type = 'number';
            inInput.className = 'doe-advanced-input';
            inInput.min = '0';
            inInput.max = '180';
            if (inf.key === 'incStep') inInput.min = '1';
            inInput.value = inf.value;
            inInput.addEventListener('input', _updatePermutationCount);
            _advancedInputs[inf.key] = inInput;
            inDiv.appendChild(inLabel);
            inDiv.appendChild(inInput);
            incGrid.appendChild(inDiv);
        }
        body.appendChild(incGrid);

        // --- Engagement Range ---
        var engLabel = document.createElement('div');
        engLabel.className = 'doe-section-label';
        engLabel.textContent = 'ENGAGEMENT RANGE (initial separation, km)';
        engLabel.style.marginTop = '12px';
        body.appendChild(engLabel);

        var engGrid = document.createElement('div');
        engGrid.className = 'doe-advanced-grid';

        var engFields = [
            { key: 'engMin',  label: 'Min (km)', value: '0' },
            { key: 'engMax',  label: 'Max (km)', value: '0' },
            { key: 'engStep', label: 'Step (km)', value: '50' }
        ];
        for (var ei = 0; ei < engFields.length; ei++) {
            var ef = engFields[ei];
            var efDiv = document.createElement('div');
            efDiv.className = 'doe-advanced-field';
            var efLabel = document.createElement('label');
            efLabel.textContent = ef.label;
            var efInput = document.createElement('input');
            efInput.type = 'number';
            efInput.className = 'doe-advanced-input';
            efInput.min = '0';
            if (ef.key === 'engStep') efInput.min = '1';
            efInput.value = ef.value;
            efInput.addEventListener('input', _updatePermutationCount);
            _advancedInputs[ef.key] = efInput;
            efDiv.appendChild(efLabel);
            efDiv.appendChild(efInput);
            engGrid.appendChild(efDiv);
        }
        body.appendChild(engGrid);

        // --- Weapon Loadout Variants ---
        var wpnLabel = document.createElement('div');
        wpnLabel.className = 'doe-section-label';
        wpnLabel.textContent = 'WEAPON LOADOUT VARIANTS';
        wpnLabel.style.marginTop = '12px';
        body.appendChild(wpnLabel);

        var wpnDesc = document.createElement('div');
        wpnDesc.style.fontSize = '10px';
        wpnDesc.style.color = '#667';
        wpnDesc.style.marginBottom = '6px';
        wpnDesc.textContent = 'Check types to include as separate variants (each creates a permutation axis)';
        body.appendChild(wpnDesc);

        var wpnRow = document.createElement('div');
        wpnRow.className = 'doe-weapon-checks';

        var weapons = [
            { key: 'kkv', label: 'KKV (Kinetic Kill)', checked: true },
            { key: 'a2a', label: 'A2A Missile', checked: false },
            { key: 'sam', label: 'SAM Battery', checked: false }
        ];
        for (var wi = 0; wi < weapons.length; wi++) {
            var wp = weapons[wi];
            var wpLabel2 = document.createElement('label');
            wpLabel2.className = 'doe-weapon-check';

            var wpCheck = document.createElement('input');
            wpCheck.type = 'checkbox';
            wpCheck.checked = wp.checked;
            wpCheck.addEventListener('change', _updatePermutationCount);
            _weaponCheckboxes[wp.key] = wpCheck;

            var wpText = document.createTextNode(wp.label);
            wpLabel2.appendChild(wpCheck);
            wpLabel2.appendChild(wpText);
            wpnRow.appendChild(wpLabel2);
        }
        body.appendChild(wpnRow);

        wrapper.appendChild(header);
        wrapper.appendChild(body);

        return wrapper;
    }

    function _buildSimParamsSection() {
        var section = document.createElement('div');
        section.className = 'doe-section';

        var label = document.createElement('div');
        label.className = 'doe-section-label';
        label.textContent = 'SIMULATION PARAMETERS';
        section.appendChild(label);

        // --- Seed ---
        var fieldSeed = document.createElement('div');
        fieldSeed.className = 'doe-field';

        var labelSeed = document.createElement('label');
        labelSeed.className = 'doe-label';
        labelSeed.textContent = 'Seed:';

        var seedRow = document.createElement('div');
        seedRow.className = 'doe-seed-row';

        _inputSeed = document.createElement('input');
        _inputSeed.type = 'number';
        _inputSeed.className = 'doe-input';
        _inputSeed.min = '0';
        _inputSeed.value = '42';

        var randomBtn = document.createElement('button');
        randomBtn.className = 'doe-random-btn';
        randomBtn.textContent = 'Random';
        randomBtn.title = 'Generate random seed';
        randomBtn.addEventListener('click', function() {
            _inputSeed.value = String(Math.floor(Math.random() * 100000));
        });

        seedRow.appendChild(_inputSeed);
        seedRow.appendChild(randomBtn);
        fieldSeed.appendChild(labelSeed);
        fieldSeed.appendChild(seedRow);
        section.appendChild(fieldSeed);

        // --- Max Sim Time ---
        var fieldTime = document.createElement('div');
        fieldTime.className = 'doe-field';

        var labelTime = document.createElement('label');
        labelTime.className = 'doe-label';
        labelTime.textContent = 'Max Sim Time (seconds):';

        _inputMaxTime = document.createElement('input');
        _inputMaxTime.type = 'number';
        _inputMaxTime.className = 'doe-input';
        _inputMaxTime.min = '10';
        _inputMaxTime.max = '3600';
        _inputMaxTime.value = '600';

        fieldTime.appendChild(labelTime);
        fieldTime.appendChild(_inputMaxTime);
        section.appendChild(fieldTime);

        // --- Arena Parameters (collapsible) ---
        section.appendChild(_buildArenaParamsSection());

        return section;
    }

    function _buildArenaParamsSection() {
        var wrapper = document.createElement('div');

        var header = document.createElement('div');
        header.className = 'doe-collapsible-header';

        var arrow = document.createElement('span');
        arrow.className = 'doe-arrow';
        arrow.textContent = '\u25B6';
        header.appendChild(arrow);

        var headerText = document.createTextNode('Arena Parameters');
        header.appendChild(headerText);

        var body = document.createElement('div');
        body.className = 'doe-collapsible-body';

        header.addEventListener('click', function() {
            var isOpen = body.classList.contains('open');
            if (isOpen) {
                body.classList.remove('open');
                header.classList.remove('open');
            } else {
                body.classList.add('open');
                header.classList.add('open');
            }
        });

        var grid = document.createElement('div');
        grid.className = 'doe-arena-grid';

        var arenaFields = [
            { key: 'pk',             label: 'Pk',                 value: '0.7',  step: '0.05' },
            { key: 'sensorRange',    label: 'Sensor Range (km)',  value: '1000', step: '100'  },
            { key: 'defenseRadius',  label: 'Defense Radius (km)',value: '500',  step: '100'  },
            { key: 'killRange',      label: 'Kill Range (km)',    value: '50',   step: '10'   },
            { key: 'maxAccel',       label: 'Max Accel (m/s\u00B2)', value: '50', step: '5'   }
        ];

        for (var i = 0; i < arenaFields.length; i++) {
            var af = arenaFields[i];
            var fieldDiv = document.createElement('div');
            fieldDiv.className = 'doe-arena-field';

            var fieldLabel = document.createElement('label');
            fieldLabel.className = 'doe-arena-label';
            fieldLabel.textContent = af.label;

            var fieldInput = document.createElement('input');
            fieldInput.type = 'number';
            fieldInput.className = 'doe-arena-input';
            fieldInput.min = '0';
            fieldInput.step = af.step;
            fieldInput.value = af.value;

            _arenaInputs[af.key] = fieldInput;

            fieldDiv.appendChild(fieldLabel);
            fieldDiv.appendChild(fieldInput);
            grid.appendChild(fieldDiv);
        }

        body.appendChild(grid);
        wrapper.appendChild(header);
        wrapper.appendChild(body);

        return wrapper;
    }

    function _buildProgressSection() {
        var progressSection = document.createElement('div');
        progressSection.className = 'doe-progress-section';

        var progressBar = document.createElement('div');
        progressBar.id = 'doeProgressBar';

        _progressFill = document.createElement('div');
        _progressFill.id = 'doeProgressFill';

        _progressTextEl = document.createElement('div');
        _progressTextEl.className = 'doe-progress-text';
        _progressTextEl.id = 'doeProgressText';
        _progressTextEl.textContent = '0%';

        progressBar.appendChild(_progressFill);
        progressBar.appendChild(_progressTextEl);
        progressSection.appendChild(progressBar);

        _statusText = document.createElement('div');
        _statusText.id = 'doeStatusText';
        _statusText.textContent = 'Ready';
        progressSection.appendChild(_statusText);

        return progressSection;
    }

    function _buildButtonRow() {
        var btnRow = document.createElement('div');
        btnRow.className = 'doe-btn-row';

        _btnStart = document.createElement('button');
        _btnStart.id = 'doeBtnStart';
        _btnStart.textContent = 'Start DOE';
        _btnStart.addEventListener('click', function() {
            _startDOE();
        });

        _btnCancel = document.createElement('button');
        _btnCancel.id = 'doeBtnCancel';
        _btnCancel.textContent = 'Cancel';
        _btnCancel.disabled = true;
        _btnCancel.addEventListener('click', function() {
            _onCancel();
        });

        btnRow.appendChild(_btnStart);
        btnRow.appendChild(_btnCancel);

        return btnRow;
    }

    // -------------------------------------------------------------------
    // Permutation Logic
    // -------------------------------------------------------------------

    /**
     * Read current role range values from DOM inputs.
     * @returns {Array<{name: string, min: number, max: number, step: number}>}
     */
    function _getRoleRanges() {
        var ranges = [];
        for (var i = 0; i < _roles.length; i++) {
            var role = _roles[i];
            var inputs = _roleInputs[role.name];
            var min  = parseInt(inputs.min.value, 10)  || 0;
            var max  = parseInt(inputs.max.value, 10)  || 0;
            var step = parseInt(inputs.step.value, 10)  || 1;
            if (step < 1) step = 1;
            if (max < min) max = min;
            ranges.push({ name: role.name, min: min, max: max, step: step });
        }
        return ranges;
    }

    /**
     * Read advanced parameter ranges from DOM inputs.
     * Returns arrays of values for altitude, inclination, engagement range, and weapon types.
     * Single-value ranges (min === max) produce one value and do not multiply permutation count.
     */
    function _getAdvancedRanges() {
        var result = { altitudes: [], inclinations: [], engagementRanges: [], weaponTypes: [] };

        // Altitude (SMA in km)
        if (_advancedInputs.altMin && _advancedInputs.altMax && _advancedInputs.altStep) {
            var altMin  = parseFloat(_advancedInputs.altMin.value) || 42164;
            var altMax  = parseFloat(_advancedInputs.altMax.value) || 42164;
            var altStep = parseFloat(_advancedInputs.altStep.value) || 100;
            if (altStep < 1) altStep = 1;
            if (altMax < altMin) altMax = altMin;
            for (var a = altMin; a <= altMax; a += altStep) {
                result.altitudes.push(a);
            }
            if (result.altitudes.length === 0) result.altitudes.push(altMin);
        } else {
            result.altitudes.push(42164);
        }

        // Inclination (degrees)
        if (_advancedInputs.incMin && _advancedInputs.incMax && _advancedInputs.incStep) {
            var incMin  = parseFloat(_advancedInputs.incMin.value) || 0;
            var incMax  = parseFloat(_advancedInputs.incMax.value) || 0;
            var incStep = parseFloat(_advancedInputs.incStep.value) || 15;
            if (incStep < 1) incStep = 1;
            if (incMax < incMin) incMax = incMin;
            for (var b = incMin; b <= incMax; b += incStep) {
                result.inclinations.push(b);
            }
            if (result.inclinations.length === 0) result.inclinations.push(incMin);
        } else {
            result.inclinations.push(0);
        }

        // Engagement range (km)
        if (_advancedInputs.engMin && _advancedInputs.engMax && _advancedInputs.engStep) {
            var engMin  = parseFloat(_advancedInputs.engMin.value) || 0;
            var engMax  = parseFloat(_advancedInputs.engMax.value) || 0;
            var engStep = parseFloat(_advancedInputs.engStep.value) || 50;
            if (engStep < 1) engStep = 1;
            if (engMax < engMin) engMax = engMin;
            for (var c = engMin; c <= engMax; c += engStep) {
                result.engagementRanges.push(c);
            }
            if (result.engagementRanges.length === 0) result.engagementRanges.push(engMin);
        } else {
            result.engagementRanges.push(0);
        }

        // Weapon loadout variants
        if (_weaponCheckboxes.kkv || _weaponCheckboxes.a2a || _weaponCheckboxes.sam) {
            if (_weaponCheckboxes.kkv && _weaponCheckboxes.kkv.checked) result.weaponTypes.push('kkv');
            if (_weaponCheckboxes.a2a && _weaponCheckboxes.a2a.checked) result.weaponTypes.push('a2a');
            if (_weaponCheckboxes.sam && _weaponCheckboxes.sam.checked) result.weaponTypes.push('sam');
        }
        if (result.weaponTypes.length === 0) result.weaponTypes.push('kkv');

        return result;
    }

    /**
     * Count the number of permutations without generating them.
     * Includes role ranges AND advanced parameters.
     * @returns {number}
     */
    function _countPermutations() {
        var roles = _getRoleRanges();
        var count = 1;
        for (var i = 0; i < roles.length; i++) {
            var r = roles[i];
            var vals = 0;
            for (var v = r.min; v <= r.max; v += Math.max(r.step, 1)) {
                vals++;
            }
            if (vals === 0) vals = 1;
            count *= vals;
        }

        // Multiply by advanced parameter dimensions
        var adv = _getAdvancedRanges();
        if (adv.altitudes.length > 1) count *= adv.altitudes.length;
        if (adv.inclinations.length > 1) count *= adv.inclinations.length;
        if (adv.engagementRanges.length > 1) count *= adv.engagementRanges.length;
        if (adv.weaponTypes.length > 1) count *= adv.weaponTypes.length;

        return count;
    }

    /**
     * Generate the Cartesian product of all role ranges AND advanced parameters.
     * @returns {Array<Object>} Array of permutation objects
     */
    function _generatePermutations() {
        var roles = _getRoleRanges();
        var ranges = roles.map(function(r) {
            var vals = [];
            for (var v = r.min; v <= r.max; v += Math.max(r.step, 1)) {
                vals.push(v);
            }
            if (vals.length === 0) vals.push(r.min);
            return vals;
        });

        // Cartesian product of role ranges
        var perms = [{}];
        for (var i = 0; i < roles.length; i++) {
            var next = [];
            for (var j = 0; j < perms.length; j++) {
                for (var k = 0; k < ranges[i].length; k++) {
                    var p = Object.assign({}, perms[j]);
                    p[roles[i].name] = ranges[i][k];
                    next.push(p);
                }
            }
            perms = next;
        }

        // Expand with advanced parameters (only if they have multiple values)
        var adv = _getAdvancedRanges();

        // Altitude (SMA km)
        if (adv.altitudes.length > 1) {
            var nextPerms = [];
            for (var ai = 0; ai < perms.length; ai++) {
                for (var aj = 0; aj < adv.altitudes.length; aj++) {
                    var ap = Object.assign({}, perms[ai]);
                    ap.smaKm = adv.altitudes[aj];
                    nextPerms.push(ap);
                }
            }
            perms = nextPerms;
        } else {
            // Single value -- attach it to every permutation
            for (var a1 = 0; a1 < perms.length; a1++) {
                perms[a1].smaKm = adv.altitudes[0];
            }
        }

        // Inclination (degrees)
        if (adv.inclinations.length > 1) {
            var nextPerms2 = [];
            for (var bi = 0; bi < perms.length; bi++) {
                for (var bj = 0; bj < adv.inclinations.length; bj++) {
                    var bp = Object.assign({}, perms[bi]);
                    bp.incDeg = adv.inclinations[bj];
                    nextPerms2.push(bp);
                }
            }
            perms = nextPerms2;
        } else {
            for (var b1 = 0; b1 < perms.length; b1++) {
                perms[b1].incDeg = adv.inclinations[0];
            }
        }

        // Engagement range (km)
        if (adv.engagementRanges.length > 1) {
            var nextPerms3 = [];
            for (var ci = 0; ci < perms.length; ci++) {
                for (var cj = 0; cj < adv.engagementRanges.length; cj++) {
                    var cp = Object.assign({}, perms[ci]);
                    cp.engRangeKm = adv.engagementRanges[cj];
                    nextPerms3.push(cp);
                }
            }
            perms = nextPerms3;
        } else {
            for (var c1 = 0; c1 < perms.length; c1++) {
                perms[c1].engRangeKm = adv.engagementRanges[0];
            }
        }

        // Weapon types
        if (adv.weaponTypes.length > 1) {
            var nextPerms4 = [];
            for (var di = 0; di < perms.length; di++) {
                for (var dj = 0; dj < adv.weaponTypes.length; dj++) {
                    var dp = Object.assign({}, perms[di]);
                    dp.weaponType = adv.weaponTypes[dj];
                    nextPerms4.push(dp);
                }
            }
            perms = nextPerms4;
        } else {
            for (var d1 = 0; d1 < perms.length; d1++) {
                perms[d1].weaponType = adv.weaponTypes[0];
            }
        }

        return perms;
    }

    /**
     * Update the permutation count display. Called on every role/advanced input change.
     * Shows total count, estimated time (~2s per permutation), and warnings.
     */
    function _updatePermutationCount() {
        if (!_permCountDisplay) return;

        var count = _countPermutations();
        var text = count + ' permutation' + (count !== 1 ? 's' : '');

        // Estimated time (~2 seconds per permutation)
        var estSec = count * 2;
        var estStr;
        if (estSec < 60) {
            estStr = estSec + 's';
        } else if (estSec < 3600) {
            estStr = (estSec / 60).toFixed(1) + 'm';
        } else {
            estStr = (estSec / 3600).toFixed(1) + 'h';
        }

        _permCountDisplay.className = 'doe-perm-count';

        if (count > 2000) {
            text += ' \u2014 May take hours (~' + estStr + ')';
            _permCountDisplay.className = 'doe-perm-count danger';
        } else if (count > 1000) {
            text += ' \u2014 This may take a long time (~' + estStr + ')';
            _permCountDisplay.className = 'doe-perm-count danger';
        } else if (count > 500) {
            text += ' \u2014 Large sweep (~' + estStr + ')';
            _permCountDisplay.className = 'doe-perm-count warn';
        } else if (count > 1) {
            text += ' (~' + estStr + ')';
        }

        _permCountDisplay.textContent = text;
    }

    // -------------------------------------------------------------------
    // Progress Helpers
    // -------------------------------------------------------------------

    function _resetProgress() {
        if (_progressFill) _progressFill.style.width = '0%';
        if (_progressTextEl) _progressTextEl.textContent = '0%';
        if (_statusText) _statusText.textContent = 'Ready';
    }

    function _setProgress(pct, label) {
        if (_progressFill) _progressFill.style.width = pct + '%';
        if (_progressTextEl) _progressTextEl.textContent = label || (Math.round(pct) + '%');
    }

    // -------------------------------------------------------------------
    // Server Connectivity Check
    // -------------------------------------------------------------------

    var _serverAvailable = false;

    /**
     * Ping the MC server and update status display if unavailable.
     */
    function _checkServerAvailability() {
        fetch('/api/mc/status')
            .then(function(resp) { return resp.json(); })
            .then(function(data) {
                _serverAvailable = data.ready === true;
                if (!_serverAvailable && _statusText) {
                    _statusText.textContent = 'C++ engine not found. Build with: cd build && cmake .. && ninja mc_engine';
                    _statusText.style.color = '#ffcc00';
                }
            })
            .catch(function() {
                _serverAvailable = false;
                if (_statusText) {
                    _statusText.textContent = 'MC server not running. Start with: node mc_server.js';
                    _statusText.style.color = '#ff4444';
                }
            });
    }

    // -------------------------------------------------------------------
    // Execution
    // -------------------------------------------------------------------

    /**
     * Read arena parameter inputs and build the config object.
     * Converts km values to meters for range/distance fields.
     * @returns {Object}
     */
    function _getArenaConfig() {
        var pk          = parseFloat(_arenaInputs.pk.value) || 0.7;
        var sensorRange = (parseFloat(_arenaInputs.sensorRange.value) || 1000) * 1000;   // km -> m
        var defenseRad  = (parseFloat(_arenaInputs.defenseRadius.value) || 500) * 1000;   // km -> m
        var killRange   = (parseFloat(_arenaInputs.killRange.value) || 50) * 1000;        // km -> m
        var maxAccel    = parseFloat(_arenaInputs.maxAccel.value) || 50;                  // already m/s^2

        return {
            Pk: pk,
            sensorRange: sensorRange,
            defenseRadius: defenseRad,
            killRange: killRange,
            maxAccel: maxAccel
        };
    }

    /**
     * Start the DOE sweep.
     */
    function _startDOE() {
        // Check server availability before starting
        if (!_serverAvailable) {
            if (_statusText) {
                _statusText.textContent = 'MC server not running. Start it with: node mc_server.js';
                _statusText.style.color = '#ff4444';
            }
            return;
        }

        var seed    = parseInt(_inputSeed.value, 10);
        var maxTime = parseInt(_inputMaxTime.value, 10);

        // Validate
        if (isNaN(seed) || seed < 0) {
            _inputSeed.value = '0';
            seed = 0;
        }
        if (isNaN(maxTime) || maxTime < 10) {
            _inputMaxTime.value = '10';
            maxTime = 10;
        }

        // Generate permutations
        var permutations = _generatePermutations();
        if (permutations.length === 0) {
            if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                BuilderApp.showMessage('No permutations generated');
            }
            return;
        }

        // Disable Start, enable Cancel
        _btnStart.disabled = true;
        _btnCancel.disabled = false;

        // Reset progress
        _resetProgress();
        _statusText.textContent = 'Starting DOE sweep...';
        _startTime = Date.now();

        // Build payload — map role names to the expected per-side keys
        // and include advanced parameters
        var mappedPerms = permutations.map(function(p) {
            var mapped = {
                hvaPerSide:       p.hva       !== undefined ? p.hva       : 0,
                defendersPerSide: p.defender   !== undefined ? p.defender   : 0,
                attackersPerSide: p.attacker   !== undefined ? p.attacker   : 0,
                escortsPerSide:   p.escort     !== undefined ? p.escort     : 0,
                sweepsPerSide:    p.sweep      !== undefined ? p.sweep      : 0
            };
            // Advanced params — attach per-permutation overrides
            if (p.smaKm !== undefined)      mapped.smaKm = p.smaKm;
            if (p.incDeg !== undefined)      mapped.incDeg = p.incDeg;
            if (p.engRangeKm !== undefined)  mapped.engRangeKm = p.engRangeKm;
            if (p.weaponType !== undefined)  mapped.weaponType = p.weaponType;
            return mapped;
        });

        var payload = {
            permutations: mappedPerms,
            seed: seed,
            maxTime: maxTime,
            arenaConfig: _getArenaConfig()
        };

        // POST to server
        _abortController = new AbortController();

        fetch('/api/mc/doe', {
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
            _statusText.textContent = 'DOE sweep running...';
            _setProgress(2, '...');
            _pollDOEJob(data.jobId, mappedPerms.length);
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

    /**
     * Poll the server for DOE job status.
     * @param {string} jobId
     * @param {number} totalPerms
     */
    function _pollDOEJob(jobId, totalPerms) {
        _pollTimer = setInterval(function() {
            fetch('/api/mc/jobs/' + jobId)
            .then(function(resp) { return resp.json(); })
            .then(function(job) {
                if (job.status === 'running') {
                    var p = job.progress || {};
                    var pct = p.pct || 0;
                    // Clamp to 2-95 range while running
                    pct = Math.max(2, Math.min(95, pct));
                    _setProgress(pct, pct + '%');

                    if (p.completed !== undefined && p.total !== undefined) {
                        var elapsed = job.elapsed || 0;
                        var perPerm = p.completed > 0 ? elapsed / p.completed : 0;
                        var remaining = perPerm * (p.total - p.completed);
                        var remStr = remaining < 60 ?
                            remaining.toFixed(1) + 's' :
                            (remaining / 60).toFixed(1) + 'm';
                        _statusText.textContent = 'Permutation ' + p.completed + '/' + p.total +
                            ' (' + pct + '%) ~' + remStr + ' remaining';
                    } else {
                        _statusText.textContent = 'DOE sweep: ' + pct + '%';
                    }
                } else if (job.status === 'complete') {
                    clearInterval(_pollTimer);
                    _pollTimer = null;

                    var elapsed = ((Date.now() - _startTime) / 1000).toFixed(2);
                    _setProgress(100, '100%');
                    _statusText.textContent = 'DOE complete: ' + totalPerms + ' permutations in ' + elapsed + 's';

                    _btnStart.disabled = false;
                    _btnCancel.disabled = true;
                    _abortController = null;

                    // Show results
                    if (typeof DOEResults !== 'undefined' && DOEResults.showPanel) {
                        DOEResults.showPanel(job.results);
                    }

                    // Hide self
                    hide();

                    if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                        BuilderApp.showMessage('DOE complete: ' + totalPerms + ' permutations in ' + elapsed + 's');
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
                _statusText.textContent = 'Lost connection to server';
                _btnStart.disabled = false;
                _btnCancel.disabled = true;
                _abortController = null;
            });
        }, 500);
    }

    // -------------------------------------------------------------------
    // Cancel / Close
    // -------------------------------------------------------------------

    function _onCancel() {
        if (_abortController) {
            _abortController.abort();
            _abortController = null;
        }

        if (_pollTimer) {
            clearInterval(_pollTimer);
            _pollTimer = null;
        }

        _statusText.textContent = 'Cancelled';
        _btnStart.disabled = false;
        _btnCancel.disabled = true;
    }

    function _handleClose() {
        hide();
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Inject CSS and create DOM elements. Idempotent -- safe to call multiple times.
     */
    function init() {
        if (_initialized) return;

        _injectCSS();
        _createDOM();
        _initialized = true;
    }

    /**
     * Show the DOE configuration panel. Resets progress if no run is active.
     */
    function show() {
        if (!_initialized) {
            init();
        }

        // Reset if not running
        if (!_pollTimer) {
            _resetProgress();
            _btnStart.disabled = false;
            _btnCancel.disabled = true;
        } else {
            _btnStart.disabled = true;
            _btnCancel.disabled = false;
        }

        // Refresh permutation count
        _updatePermutationCount();

        // Check MC server connectivity
        _checkServerAvailability();

        _overlay.style.display = 'block';
        _modal.style.display = 'block';
    }

    /**
     * Hide the DOE configuration panel.
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
