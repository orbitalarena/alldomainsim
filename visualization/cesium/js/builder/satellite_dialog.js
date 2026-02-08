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

        // Buttons
        var btns = document.createElement('div');
        btns.className = 'sat-dialog-buttons';

        var btnCancel = document.createElement('button');
        btnCancel.className = 'sat-dialog-btn sat-dialog-btn-cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', _cancel);
        btns.appendChild(btnCancel);

        var btnConfirm = document.createElement('button');
        btnConfirm.className = 'sat-dialog-btn sat-dialog-btn-confirm';
        btnConfirm.textContent = 'Place Satellite';
        btnConfirm.addEventListener('click', _confirm);
        btns.appendChild(btnConfirm);

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
     * Update computed periapsis, apoapsis, and period display.
     */
    function _updateComputed() {
        var sma_km = parseFloat(_fields.sma_km.value) || 0;
        var ecc = parseFloat(_fields.ecc.value) || 0;

        if (sma_km <= 0 || ecc < 0 || ecc >= 1) {
            _displays.periapsis.textContent = '--';
            _displays.apoapsis.textContent = '--';
            _displays.period.textContent = '--';
            return;
        }

        var periapsis_km = sma_km * (1 - ecc) - R_EARTH_KM;
        var apoapsis_km = sma_km * (1 + ecc) - R_EARTH_KM;

        _displays.periapsis.textContent = periapsis_km.toFixed(1) + ' km';
        _displays.apoapsis.textContent = apoapsis_km.toFixed(1) + ' km';

        // Period: T = 2π √(a³/μ)
        var sma_m = sma_km * 1000;
        var period_s = 2 * Math.PI * Math.sqrt(sma_m * sma_m * sma_m / MU_EARTH);
        var period_min = period_s / 60;

        if (period_min < 120) {
            _displays.period.textContent = period_min.toFixed(1) + ' min';
        } else {
            var hours = period_min / 60;
            _displays.period.textContent = hours.toFixed(2) + ' hr';
        }
    }

    function _confirm() {
        var sma_km = parseFloat(_fields.sma_km.value);
        var ecc    = parseFloat(_fields.ecc.value);
        var inc    = parseFloat(_fields.inc_deg.value);
        var raan   = parseFloat(_fields.raan_deg.value);
        var argPe  = parseFloat(_fields.argPe_deg.value);
        var ma     = parseFloat(_fields.meanAnom_deg.value);

        if (isNaN(sma_km) || sma_km <= R_EARTH_KM) {
            _fields.sma_km.style.borderColor = '#ff4444';
            return;
        }
        _fields.sma_km.style.borderColor = '';

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
