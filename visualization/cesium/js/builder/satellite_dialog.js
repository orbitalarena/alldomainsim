/**
 * SatelliteDialog — Modal dialog for placing satellites with Classical Orbital Elements.
 *
 * When a satellite template is placed on the globe, this dialog appears with
 * 6 COE input fields (SMA, eccentricity, inclination, RAAN, arg of perigee,
 * mean anomaly) seeded with template-specific defaults and click-position hints.
 *
 * Live-computes periapsis/apoapsis altitude and orbital period as the user edits.
 * Returns a Promise resolving with COE values on confirm, rejecting on cancel.
 */
const SatelliteDialog = (function() {
    'use strict';

    var R_EARTH_KM = 6371;
    var MU_EARTH = 3.986004418e14; // m^3/s^2

    var _overlay = null;
    var _dialog = null;
    var _fields = {};       // key -> input element
    var _displays = {};     // key -> span element
    var _validationArea = null;  // validation message element
    var _btnConfirm = null;      // confirm button reference
    var _resolvePromise = null;
    var _rejectPromise = null;

    // Template-specific COE defaults
    var _templateDefaults = {
        'LEO Satellite': {
            sma_km: 6771,       // ~400km altitude
            ecc: 0.001,
            inc_deg: 51.6,      // ISS-like
            raan_deg: 0,
            argPe_deg: 0,
            meanAnom_deg: 0
        },
        'GPS Satellite': {
            sma_km: 26571,      // ~20200km altitude
            ecc: 0.01,
            inc_deg: 55,
            raan_deg: 0,
            argPe_deg: 0,
            meanAnom_deg: 0
        },
        'GEO Comms Satellite': {
            sma_km: 42164,      // ~35786km altitude
            ecc: 0.0005,
            inc_deg: 0.05,
            raan_deg: 0,
            argPe_deg: 0,
            meanAnom_deg: 0
        }
    };

    /**
     * Initialize the dialog DOM (called once from BuilderApp.init).
     */
    function init() {
        // Overlay
        _overlay = document.createElement('div');
        _overlay.className = 'sat-dialog-overlay';
        _overlay.style.display = 'none';
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) _cancel();
        });

        // Dialog box
        _dialog = document.createElement('div');
        _dialog.className = 'sat-dialog';

        // Title
        var title = document.createElement('div');
        title.className = 'sat-dialog-title';
        title.textContent = 'Satellite Orbital Elements';
        _dialog.appendChild(title);

        // Field definitions
        var fieldDefs = [
            { key: 'sma_km',       label: 'Semi-Major Axis (km)', min: 6400, max: 100000, step: 1, decimals: 1 },
            { key: 'ecc',          label: 'Eccentricity',         min: 0,    max: 0.99,   step: 0.001, decimals: 4 },
            { key: 'inc_deg',      label: 'Inclination (\u00B0)', min: 0,    max: 180,    step: 0.1, decimals: 2 },
            { key: 'raan_deg',     label: 'RAAN (\u00B0)',        min: 0,    max: 360,    step: 0.1, decimals: 2 },
            { key: 'argPe_deg',    label: 'Arg of Perigee (\u00B0)', min: 0, max: 360,    step: 0.1, decimals: 2 },
            { key: 'meanAnom_deg', label: 'Mean Anomaly (\u00B0)',   min: 0, max: 360,    step: 0.1, decimals: 2 }
        ];

        var form = document.createElement('div');
        form.className = 'sat-dialog-form';

        for (var i = 0; i < fieldDefs.length; i++) {
            var fd = fieldDefs[i];
            var row = document.createElement('div');
            row.className = 'sat-dialog-row';

            var lbl = document.createElement('label');
            lbl.textContent = fd.label;
            lbl.className = 'sat-dialog-label';
            row.appendChild(lbl);

            var inp = document.createElement('input');
            inp.type = 'number';
            inp.className = 'sat-dialog-input';
            inp.min = fd.min;
            inp.max = fd.max;
            inp.step = fd.step;
            inp.value = 0;
            row.appendChild(inp);

            _fields[fd.key] = inp;

            // Live update on change
            inp.addEventListener('input', _updateComputed);

            form.appendChild(row);
        }

        _dialog.appendChild(form);

        // Computed display
        var computed = document.createElement('div');
        computed.className = 'sat-dialog-computed';

        var dispDefs = [
            { key: 'periapsis', label: 'Periapsis Alt' },
            { key: 'apoapsis',  label: 'Apoapsis Alt' },
            { key: 'period',    label: 'Orbital Period' }
        ];

        for (var d = 0; d < dispDefs.length; d++) {
            var dd = dispDefs[d];
            var drow = document.createElement('div');
            drow.className = 'sat-dialog-disp-row';

            var dlbl = document.createElement('span');
            dlbl.className = 'sat-dialog-disp-label';
            dlbl.textContent = dd.label + ':';
            drow.appendChild(dlbl);

            var dval = document.createElement('span');
            dval.className = 'sat-dialog-disp-value';
            dval.textContent = '--';
            drow.appendChild(dval);

            _displays[dd.key] = dval;
            computed.appendChild(drow);
        }

        _dialog.appendChild(computed);

        // Validation message area
        _validationArea = document.createElement('div');
        _validationArea.className = 'sat-dialog-validation';
        _dialog.appendChild(_validationArea);

        // Buttons
        var btns = document.createElement('div');
        btns.className = 'sat-dialog-buttons';

        var btnCancel = document.createElement('button');
        btnCancel.className = 'sat-dialog-btn sat-dialog-btn-cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', _cancel);
        btns.appendChild(btnCancel);

        _btnConfirm = document.createElement('button');
        _btnConfirm.className = 'sat-dialog-btn sat-dialog-btn-confirm';
        _btnConfirm.textContent = 'Place Satellite';
        _btnConfirm.addEventListener('click', _confirm);
        btns.appendChild(_btnConfirm);

        _dialog.appendChild(btns);

        _overlay.appendChild(_dialog);
        document.body.appendChild(_overlay);
    }

    /**
     * Show the dialog with template defaults seeded from the click location.
     * @param {object} template  The palette template being placed
     * @param {{ lat: number, lon: number }} clickLatLon  Click position in degrees
     * @returns {Promise<object>} Resolves with COE values, rejects on cancel
     */
    function show(template, clickLatLon) {
        return new Promise(function(resolve, reject) {
            _resolvePromise = resolve;
            _rejectPromise = reject;

            // Get template-specific defaults — prefer Platform Builder COE if available
            var defaults = _templateDefaults[template.name] || _templateDefaults['LEO Satellite'];
            var pbCoe = template._custom && template._custom.physics && template._custom.physics.coe;
            if (pbCoe) {
                defaults = {
                    sma_km: pbCoe.sma_km || defaults.sma_km,
                    ecc: pbCoe.ecc !== undefined ? pbCoe.ecc : defaults.ecc,
                    inc_deg: pbCoe.inc_deg !== undefined ? pbCoe.inc_deg : defaults.inc_deg,
                    raan_deg: pbCoe.raan_deg !== undefined ? pbCoe.raan_deg : defaults.raan_deg,
                    argPe_deg: pbCoe.argPe_deg !== undefined ? pbCoe.argPe_deg : defaults.argPe_deg,
                    meanAnom_deg: pbCoe.ma_deg !== undefined ? pbCoe.ma_deg : defaults.meanAnom_deg
                };
            }

            // Seed RAAN from click longitude, inclination from |latitude|
            // For Platform Builder COE templates, use their values directly (don't override)
            var seededRaan = pbCoe ? defaults.raan_deg :
                (clickLatLon ? ((clickLatLon.lon + 360) % 360) : defaults.raan_deg);
            var seededInc = pbCoe ? defaults.inc_deg :
                (clickLatLon ? Math.max(Math.abs(clickLatLon.lat), defaults.inc_deg) : defaults.inc_deg);

            // Fill fields
            _fields.sma_km.value       = defaults.sma_km;
            _fields.ecc.value          = defaults.ecc;
            _fields.inc_deg.value      = typeof seededInc === 'number' ? seededInc.toFixed(2) : seededInc;
            _fields.raan_deg.value     = typeof seededRaan === 'number' ? seededRaan.toFixed(2) : seededRaan;
            _fields.argPe_deg.value    = defaults.argPe_deg;
            _fields.meanAnom_deg.value = defaults.meanAnom_deg;

            _updateComputed();

            // Show
            _overlay.style.display = 'flex';
            _fields.sma_km.focus();
            _fields.sma_km.select();
        });
    }

    /**
     * Normalize an angle value to [0, 360) degrees.
     * @param {HTMLInputElement} field  The input element to normalize
     */
    function _normalizeAngle(field) {
        var val = parseFloat(field.value);
        if (isNaN(val)) return;
        var normalized = ((val % 360) + 360) % 360;
        if (normalized !== val) {
            field.value = normalized;
        }
    }

    /**
     * Validate all COE fields.
     * @returns {{ errors: string[], warnings: string[] }}
     */
    function _validateFields() {
        var errors = [];
        var warnings = [];

        var sma_km   = parseFloat(_fields.sma_km.value);
        var ecc      = parseFloat(_fields.ecc.value);
        var inc_deg  = parseFloat(_fields.inc_deg.value);
        var raan_deg = parseFloat(_fields.raan_deg.value);
        var argPe_deg = parseFloat(_fields.argPe_deg.value);
        var ma_deg   = parseFloat(_fields.meanAnom_deg.value);

        // NaN checks
        if (isNaN(sma_km))   { errors.push('SMA: Invalid number'); }
        if (isNaN(ecc))      { errors.push('Eccentricity: Invalid number'); }
        if (isNaN(inc_deg))  { errors.push('Inclination: Invalid number'); }
        if (isNaN(raan_deg)) { errors.push('RAAN: Invalid number'); }
        if (isNaN(argPe_deg)){ errors.push('Arg of Perigee: Invalid number'); }
        if (isNaN(ma_deg))   { errors.push('Mean Anomaly: Invalid number'); }

        // SMA validation
        if (!isNaN(sma_km)) {
            if (sma_km <= R_EARTH_KM) {
                errors.push('SMA must be > ' + R_EARTH_KM + ' km (Earth radius)');
            }
        }

        // Eccentricity validation
        if (!isNaN(ecc)) {
            if (ecc < 0) {
                errors.push('Eccentricity must be >= 0');
            } else if (ecc >= 1.0) {
                errors.push('Eccentricity >= 1.0 (hyperbolic/parabolic, not a closed orbit)');
            } else if (ecc >= 0.99) {
                warnings.push('Eccentricity >= 0.99 (near-escape, may cause instability)');
            } else if (ecc > 0.95) {
                warnings.push('Eccentricity > 0.95 (highly eccentric, near-escape regime)');
            }
        }

        // Inclination validation
        if (!isNaN(inc_deg)) {
            if (inc_deg < 0 || inc_deg > 180) {
                errors.push('Inclination must be 0-180\u00B0');
            }
        }

        // Periapsis below surface check (warning, not error)
        if (!isNaN(sma_km) && !isNaN(ecc) && sma_km > R_EARTH_KM && ecc >= 0 && ecc < 1.0) {
            var periapsis_km = sma_km * (1 - ecc);
            if (periapsis_km < R_EARTH_KM) {
                warnings.push('Periapsis below surface (' + (periapsis_km - R_EARTH_KM).toFixed(1) + ' km alt)');
            }
        }

        // Normalize angle fields (auto-wrap, not errors)
        _normalizeAngle(_fields.raan_deg);
        _normalizeAngle(_fields.argPe_deg);
        _normalizeAngle(_fields.meanAnom_deg);

        return { errors: errors, warnings: warnings };
    }

    /**
     * Display validation messages and enable/disable confirm button.
     * @param {{ errors: string[], warnings: string[] }} result
     */
    function _showValidation(result) {
        var html = '';
        for (var i = 0; i < result.errors.length; i++) {
            html += '<div class="sd-error">\u2716 ' + result.errors[i] + '</div>';
        }
        for (var j = 0; j < result.warnings.length; j++) {
            html += '<div class="sd-warning">\u26A0 ' + result.warnings[j] + '</div>';
        }
        _validationArea.innerHTML = html;

        // Disable confirm on errors only (warnings still allow confirm)
        if (_btnConfirm) {
            _btnConfirm.disabled = result.errors.length > 0;
        }

        // Reset all field borders, then highlight fields with errors
        _fields.sma_km.style.borderColor = '';
        _fields.ecc.style.borderColor = '';
        _fields.inc_deg.style.borderColor = '';
        _fields.raan_deg.style.borderColor = '';
        _fields.argPe_deg.style.borderColor = '';
        _fields.meanAnom_deg.style.borderColor = '';

        for (var k = 0; k < result.errors.length; k++) {
            var msg = result.errors[k];
            if (msg.indexOf('SMA') !== -1) _fields.sma_km.style.borderColor = '#ff4444';
            if (msg.indexOf('Eccentricity') !== -1) _fields.ecc.style.borderColor = '#ff4444';
            if (msg.indexOf('Inclination') !== -1) _fields.inc_deg.style.borderColor = '#ff4444';
            if (msg.indexOf('RAAN') !== -1) _fields.raan_deg.style.borderColor = '#ff4444';
            if (msg.indexOf('Arg of Perigee') !== -1) _fields.argPe_deg.style.borderColor = '#ff4444';
            if (msg.indexOf('Mean Anomaly') !== -1) _fields.meanAnom_deg.style.borderColor = '#ff4444';
        }
    }

    /**
     * Update computed periapsis, apoapsis, and period display.
     * Also runs validation.
     */
    function _updateComputed() {
        var sma_km = parseFloat(_fields.sma_km.value) || 0;
        var ecc = parseFloat(_fields.ecc.value) || 0;

        if (sma_km <= 0 || ecc < 0 || ecc >= 1) {
            _displays.periapsis.textContent = '--';
            _displays.apoapsis.textContent = '--';
            _displays.period.textContent = '--';
            // Still run validation to show error messages
            var result = _validateFields();
            _showValidation(result);
            return;
        }

        var periapsis_km = sma_km * (1 - ecc) - R_EARTH_KM;
        var apoapsis_km = sma_km * (1 + ecc) - R_EARTH_KM;

        _displays.periapsis.textContent = periapsis_km.toFixed(1) + ' km';
        _displays.apoapsis.textContent = apoapsis_km.toFixed(1) + ' km';

        // Color periapsis red if below surface
        _displays.periapsis.style.color = periapsis_km < 0 ? '#ff4444' : '#00cc00';

        // Period: T = 2pi sqrt(a^3/mu)
        var sma_m = sma_km * 1000;
        var period_s = 2 * Math.PI * Math.sqrt(sma_m * sma_m * sma_m / MU_EARTH);
        var period_min = period_s / 60;

        if (period_min < 120) {
            _displays.period.textContent = period_min.toFixed(1) + ' min';
        } else {
            var hours = period_min / 60;
            _displays.period.textContent = hours.toFixed(2) + ' hr';
        }

        // Run validation
        var result = _validateFields();
        _showValidation(result);
    }

    function _confirm() {
        // Run validation one final time
        var validation = _validateFields();
        if (validation.errors.length > 0) {
            _showValidation(validation);
            return;
        }

        var sma_km = parseFloat(_fields.sma_km.value);
        var ecc    = parseFloat(_fields.ecc.value);
        var inc    = parseFloat(_fields.inc_deg.value);
        var raan   = parseFloat(_fields.raan_deg.value);
        var argPe  = parseFloat(_fields.argPe_deg.value);
        var ma     = parseFloat(_fields.meanAnom_deg.value);

        var result = {
            sma: sma_km * 1000,    // convert to meters
            ecc: ecc,
            inc: inc,               // degrees
            raan: raan,             // degrees
            argPerigee: argPe,      // degrees
            meanAnomaly: ma         // degrees
        };

        _overlay.style.display = 'none';
        if (_resolvePromise) _resolvePromise(result);
        _resolvePromise = null;
        _rejectPromise = null;
    }

    function _cancel() {
        _overlay.style.display = 'none';
        if (_rejectPromise) _rejectPromise(new Error('Cancelled'));
        _resolvePromise = null;
        _rejectPromise = null;
    }

    return {
        init: init,
        show: show
    };
})();
