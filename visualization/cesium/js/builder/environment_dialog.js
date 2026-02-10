/**
 * EnvironmentDialog — Global scenario environment settings dialog.
 *
 * Shows a modal to configure gravity, atmosphere, magnetic field,
 * ionosphere, and radiation belts at the scenario level.
 *
 * Usage:
 *   EnvironmentDialog.show(currentEnv).then(env => { ... });
 */
const EnvironmentDialog = (function() {
    'use strict';

    let _overlay = null;
    let _resolvePromise = null;
    let _rejectPromise = null;

    // Gravity mu lookup
    var MU = {
        earth:   3.986004418e14,
        moon:    4.9048695e12,
        mars:    4.282837e13,
        jupiter: 1.26686534e17,
        venus:   3.24859e14
    };

    function _injectStyles() {
        if (document.getElementById('env-dialog-styles')) return;
        var style = document.createElement('style');
        style.id = 'env-dialog-styles';
        style.textContent = `
            .env-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.6); z-index: 10000;
                display: flex; align-items: center; justify-content: center;
            }
            .env-dialog {
                background: #1a2a3a; border: 1px solid #4a9eff; border-radius: 8px;
                padding: 20px; width: 560px; max-width: 90vw; max-height: 80vh;
                overflow-y: auto; color: #a0b8d0;
                font-family: 'Courier New', monospace; font-size: 12px;
            }
            .env-dialog h2 {
                color: #4a9eff; font-size: 14px; margin: 0 0 16px 0;
                border-bottom: 1px solid #2a4a6a; padding-bottom: 8px;
            }
            .env-section { margin-bottom: 16px; }
            .env-section-title {
                color: #6ac; font-size: 11px; font-weight: bold;
                margin-bottom: 8px; text-transform: uppercase;
            }
            .env-group {
                background: #0d1b2a; border: 1px solid #1a3a5a; border-radius: 4px;
                padding: 10px; margin-bottom: 8px;
            }
            .env-row { display: flex; gap: 12px; margin-bottom: 8px; }
            .env-field { flex: 1; }
            .env-field label {
                display: block; font-size: 10px; color: #6a8aaa; margin-bottom: 3px;
                text-transform: uppercase;
            }
            .env-field select, .env-field input {
                width: 100%; background: #0a1520; border: 1px solid #2a4a6a;
                color: #a0d0ff; padding: 5px 8px; border-radius: 3px;
                font-family: 'Courier New', monospace; font-size: 11px;
            }
            .env-checkbox {
                display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
                cursor: pointer;
            }
            .env-checkbox input { margin: 0; }
            .env-checkbox .env-check-label { color: #a0d0ff; font-size: 12px; }
            .env-checkbox .env-check-desc {
                font-size: 10px; color: #5a7a9a; margin-left: auto;
            }
            .env-sub-fields { margin-top: 8px; padding-left: 8px; border-left: 2px solid #2a4a6a; }
            .env-hint { font-size: 10px; color: #4a6a8a; font-style: italic; margin-top: 4px; }
            .env-buttons { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
            .env-btn {
                padding: 8px 20px; border: 1px solid #4a9eff; border-radius: 4px;
                cursor: pointer; font-family: 'Courier New', monospace; font-size: 12px;
            }
            .env-btn-confirm { background: #1a4a7a; color: #fff; }
            .env-btn-confirm:hover { background: #2a5a9a; }
            .env-btn-cancel { background: transparent; color: #a0b8d0; }
            .env-btn-cancel:hover { background: #1a2a3a; }
        `;
        document.head.appendChild(style);
    }

    function _buildDialog() {
        _overlay = document.createElement('div');
        _overlay.className = 'env-overlay';
        _overlay.style.display = 'none';

        _overlay.innerHTML = `
            <div class="env-dialog">
                <h2>SCENARIO ENVIRONMENT</h2>

                <div class="env-section">
                    <div class="env-section-title">Gravity & Atmosphere</div>
                    <div class="env-group">
                        <div class="env-row">
                            <div class="env-field">
                                <label>Gravity Model</label>
                                <select id="env-gravity">
                                    <option value="earth">Earth (&#956; = 3.986e14)</option>
                                    <option value="moon">Moon (&#956; = 4.905e12)</option>
                                    <option value="mars">Mars (&#956; = 4.283e13)</option>
                                    <option value="jupiter">Jupiter (&#956; = 1.267e17)</option>
                                    <option value="venus">Venus (&#956; = 3.249e14)</option>
                                    <option value="custom">Custom</option>
                                </select>
                            </div>
                            <div class="env-field" id="env-custom-mu-field" style="display:none">
                                <label>Custom &#956; (m&#179;/s&#178;)</label>
                                <input type="number" id="env-custom-mu" value="3.986e14" step="1e12" />
                            </div>
                        </div>
                        <div class="env-row">
                            <div class="env-field">
                                <label>Atmosphere Model</label>
                                <select id="env-atmosphere">
                                    <option value="us_standard_1976">Earth (US Standard 1976)</option>
                                    <option value="earth_thermosphere">Earth + Thermosphere</option>
                                    <option value="mars">Mars (CO&#8322;, 0.6% Earth)</option>
                                    <option value="venus">Venus (dense CO&#8322;)</option>
                                    <option value="titan">Titan (N&#8322;, 1.5x Earth)</option>
                                    <option value="none">None (vacuum)</option>
                                </select>
                            </div>
                            <div class="env-field">
                                <label>Max Time Warp</label>
                                <select id="env-timewarp">
                                    <option value="16">16x</option>
                                    <option value="64">64x</option>
                                    <option value="256">256x</option>
                                    <option value="1024">1024x</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="env-section">
                    <div class="env-section-title">Simulation Start Time</div>
                    <div class="env-row">
                        <label>Start Date/Time (UTC)</label>
                        <input type="datetime-local" id="env-start-time" step="1"
                               style="background:#0d1a2a;color:#a0b8d0;border:1px solid #2a4a6a;padding:4px 6px;font-family:monospace;font-size:11px;width:220px"
                        />
                    </div>
                    <div class="env-row" style="margin-top:4px">
                        <button id="env-use-now" style="background:#1a3a5a;color:#4a9eff;border:1px solid #2a4a6a;padding:4px 10px;cursor:pointer;font-size:10px;font-family:monospace">
                            Use Current Time
                        </button>
                    </div>
                </div>

                <div class="env-section">
                    <div class="env-section-title">Weather</div>
                    <div class="env-group">
                        <div class="env-row">
                            <div class="env-field">
                                <label>Weather Preset</label>
                                <select id="env-weather-preset">
                                    <option value="none">None (calm)</option>
                                    <option value="clear">Clear (light wind)</option>
                                    <option value="overcast">Overcast (moderate wind)</option>
                                    <option value="stormy">Stormy (heavy turbulence)</option>
                                    <option value="high_altitude_clear">High Alt Clear (jet stream)</option>
                                    <option value="arctic">Arctic (strong crosswind)</option>
                                    <option value="custom">Custom</option>
                                </select>
                            </div>
                        </div>
                        <div class="env-sub-fields" id="env-weather-custom-fields" style="display:none">
                            <div class="env-row">
                                <div class="env-field">
                                    <label>Wind Speed (m/s)</label>
                                    <input type="number" id="env-weather-windspeed" value="5" min="0" max="100" step="1" />
                                </div>
                                <div class="env-field">
                                    <label>Wind Heading (&deg;)</label>
                                    <input type="number" id="env-weather-winddir" value="270" min="0" max="360" step="5" />
                                </div>
                            </div>
                            <div class="env-row">
                                <div class="env-field">
                                    <label>Turbulence (0-5)</label>
                                    <input type="number" id="env-weather-turbulence" value="0" min="0" max="5" step="0.5" />
                                </div>
                                <div class="env-field">
                                    <label>Visibility (km)</label>
                                    <input type="number" id="env-weather-visibility" value="50" min="0.1" max="100" step="1" />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>


                <div class="env-section">
                    <div class="env-section-title">Magnetic Field & Ionosphere</div>
                    <div class="env-group">
                        <label class="env-checkbox">
                            <input type="checkbox" id="env-magnetic" />
                            <span class="env-check-label">Magnetic Field</span>
                            <span class="env-check-desc">EMP propagation & charged particles</span>
                        </label>
                        <div class="env-sub-fields" id="env-magnetic-fields" style="display:none">
                            <div class="env-row">
                                <div class="env-field">
                                    <label>Model</label>
                                    <select id="env-magnetic-model">
                                        <option value="earth_dipole">Earth Dipole (IGRF)</option>
                                        <option value="jupiter">Jupiter (14x Earth)</option>
                                        <option value="custom">Custom Intensity</option>
                                    </select>
                                </div>
                                <div class="env-field">
                                    <label>Intensity Multiplier</label>
                                    <input type="number" id="env-magnetic-intensity" value="1.0" min="0.1" max="100" step="0.1" />
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="env-group">
                        <label class="env-checkbox">
                            <input type="checkbox" id="env-ionosphere" />
                            <span class="env-check-label">Ionosphere</span>
                            <span class="env-check-desc">RF propagation, EMP coupling, aurora</span>
                        </label>
                        <div class="env-sub-fields" id="env-ionosphere-fields" style="display:none">
                            <div class="env-row">
                                <div class="env-field">
                                    <label>Model</label>
                                    <select id="env-ionosphere-model">
                                        <option value="standard">Standard (IRI)</option>
                                        <option value="solar_max">Solar Maximum</option>
                                        <option value="solar_min">Solar Minimum</option>
                                    </select>
                                </div>
                                <div class="env-field">
                                    <label>Disturbance</label>
                                    <select id="env-ionosphere-disturbance">
                                        <option value="none">None</option>
                                        <option value="minor_storm">Minor Storm (Kp=5)</option>
                                        <option value="major_storm">Major Storm (Kp=7)</option>
                                        <option value="extreme">Extreme (Kp=9)</option>
                                        <option value="nuclear_emp">Nuclear EMP Event</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="env-section">
                    <div class="env-section-title">Radiation Environment</div>
                    <div class="env-group">
                        <label class="env-checkbox">
                            <input type="checkbox" id="env-radiation" />
                            <span class="env-check-label">Radiation Belts</span>
                            <span class="env-check-desc">Van Allen belts, satellite survivability</span>
                        </label>
                        <div class="env-sub-fields" id="env-radiation-fields" style="display:none">
                            <div class="env-row">
                                <div class="env-field">
                                    <label>Model</label>
                                    <select id="env-radiation-model">
                                        <option value="van_allen">Van Allen (AP-8/AE-8)</option>
                                        <option value="starfish_enhanced">Starfish-Enhanced</option>
                                        <option value="jupiter">Jupiter (extreme)</option>
                                    </select>
                                </div>
                                <div class="env-field">
                                    <label>Intensity</label>
                                    <input type="number" id="env-radiation-intensity" value="1.0" min="0.1" max="10" step="0.1" />
                                </div>
                            </div>
                            <div class="env-hint">Starfish Prime created artificial radiation belts that persisted for years</div>
                        </div>
                    </div>
                </div>

                <div class="env-buttons">
                    <button class="env-btn env-btn-cancel" id="env-btn-cancel">Cancel</button>
                    <button class="env-btn env-btn-confirm" id="env-btn-confirm">Apply</button>
                </div>
            </div>
        `;

        document.body.appendChild(_overlay);
        _attachEvents();
    }

    function _attachEvents() {
        // Toggle sub-fields
        var toggles = [
            { cb: 'env-magnetic',    fields: 'env-magnetic-fields' },
            { cb: 'env-ionosphere',  fields: 'env-ionosphere-fields' },
            { cb: 'env-radiation',   fields: 'env-radiation-fields' }
        ];
        toggles.forEach(function(t) {
            var cb = document.getElementById(t.cb);
            var fields = document.getElementById(t.fields);
            if (cb && fields) {
                cb.addEventListener('change', function() { fields.style.display = cb.checked ? 'block' : 'none'; });
            }
        });

        // Custom mu visibility
        var gravSel = document.getElementById('env-gravity');
        var muField = document.getElementById('env-custom-mu-field');
        if (gravSel && muField) {
            gravSel.addEventListener('change', function() {
                muField.style.display = gravSel.value === 'custom' ? 'block' : 'none';
            });
        }

        // Weather preset toggle
        var weatherPreset = document.getElementById('env-weather-preset');
        var weatherCustom = document.getElementById('env-weather-custom-fields');
        if (weatherPreset && weatherCustom) {
            weatherPreset.addEventListener('change', function() {
                weatherCustom.style.display = (weatherPreset.value === 'custom') ? 'block' : 'none';
            });
        }


        // Use Current Time button
        var useNowBtn = document.getElementById('env-use-now');
        if (useNowBtn) {
            useNowBtn.addEventListener('click', function() {
                var startInput = document.getElementById('env-start-time');
                if (startInput) startInput.value = new Date().toISOString().slice(0, 19);
            });
        }

        // Buttons
        document.getElementById('env-btn-confirm').addEventListener('click', function() {
            if (_resolvePromise) _resolvePromise(_readFormValues());
            _overlay.style.display = 'none';
            _resolvePromise = null;
            _rejectPromise = null;
        });
        document.getElementById('env-btn-cancel').addEventListener('click', function() {
            _overlay.style.display = 'none';
            if (_rejectPromise) _rejectPromise();
            _resolvePromise = null;
            _rejectPromise = null;
        });

        // Click overlay background to cancel
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) {
                _overlay.style.display = 'none';
                if (_rejectPromise) _rejectPromise();
                _resolvePromise = null;
                _rejectPromise = null;
            }
        });
    }

    function _populateForm(env) {
        env = env || {};

        // Gravity
        var grav = document.getElementById('env-gravity');
        if (grav) grav.value = env.gravity || 'earth';
        var muField = document.getElementById('env-custom-mu-field');
        if (muField) muField.style.display = (env.gravity === 'custom') ? 'block' : 'none';
        var muInput = document.getElementById('env-custom-mu');
        if (muInput) muInput.value = env.gravityMu || 3.986e14;

        // Atmosphere
        var atmo = document.getElementById('env-atmosphere');
        if (atmo) atmo.value = env.atmosphere || 'us_standard_1976';

        // Time warp
        var tw = document.getElementById('env-timewarp');

        // Weather
        var wp = document.getElementById('env-weather-preset');
        var wcf = document.getElementById('env-weather-custom-fields');
        if (wp) {
            if (env.weather && env.weather.preset) {
                wp.value = env.weather.preset;
                if (env.weather.preset === 'custom' && wcf) {
                    wcf.style.display = 'block';
                    var ws = document.getElementById('env-weather-windspeed');
                    var wd = document.getElementById('env-weather-winddir');
                    var wt = document.getElementById('env-weather-turbulence');
                    var wv = document.getElementById('env-weather-visibility');
                    if (ws) ws.value = env.weather.windSpeed || 5;
                    if (wd) wd.value = env.weather.windHeading || 270;
                    if (wt) wt.value = env.weather.turbulence || 0;
                    if (wv) wv.value = env.weather.visibility || 50;
                }
            } else {
                wp.value = 'none';
                if (wcf) wcf.style.display = 'none';
            }
        }

        if (tw) tw.value = String(env.maxTimeWarp || 64);

        // Magnetic field
        var mf = env.magneticField;
        var mfCb = document.getElementById('env-magnetic');
        var mfFields = document.getElementById('env-magnetic-fields');
        if (mfCb) { mfCb.checked = !!mf; }
        if (mfFields) mfFields.style.display = mf ? 'block' : 'none';
        if (mf) {
            var mfModel = document.getElementById('env-magnetic-model');
            if (mfModel) mfModel.value = mf.model || 'earth_dipole';
            var mfInt = document.getElementById('env-magnetic-intensity');
            if (mfInt) mfInt.value = mf.intensity || 1.0;
        }

        // Ionosphere
        var ion = env.ionosphere;
        var ionCb = document.getElementById('env-ionosphere');
        var ionFields = document.getElementById('env-ionosphere-fields');
        if (ionCb) { ionCb.checked = !!ion; }
        if (ionFields) ionFields.style.display = ion ? 'block' : 'none';
        if (ion) {
            var ionModel = document.getElementById('env-ionosphere-model');
            if (ionModel) ionModel.value = ion.model || 'standard';
            var ionDist = document.getElementById('env-ionosphere-disturbance');
            if (ionDist) ionDist.value = ion.disturbance || 'none';
        }

        // Radiation belts
        var rad = env.radiationBelt;
        var radCb = document.getElementById('env-radiation');
        var radFields = document.getElementById('env-radiation-fields');
        if (radCb) { radCb.checked = !!rad; }
        if (radFields) radFields.style.display = rad ? 'block' : 'none';
        if (rad) {
            var radModel = document.getElementById('env-radiation-model');
            if (radModel) radModel.value = rad.model || 'van_allen';
            var radInt = document.getElementById('env-radiation-intensity');
            if (radInt) radInt.value = rad.intensity || 1.0;
        }

        // Simulation start time
        var startInput = document.getElementById('env-start-time');
        if (startInput) {
            if (env && env.simStartTime) {
                startInput.value = env.simStartTime.slice(0, 19);
            } else {
                startInput.value = new Date().toISOString().slice(0, 19);
            }
        }
    }

    function _readFormValues() {
        var gravModel = document.getElementById('env-gravity').value;
        var customMu = parseFloat(document.getElementById('env-custom-mu').value) || 3.986e14;
        var gravityMu = (gravModel === 'custom') ? customMu : (MU[gravModel] || MU.earth);

        var env = {
            atmosphere: document.getElementById('env-atmosphere').value,
            gravity: gravModel,
            gravityMu: gravityMu,
            maxTimeWarp: parseInt(document.getElementById('env-timewarp').value) || 64,
            magneticField: null,
            ionosphere: null,
            radiationBelt: null
        };

        // Weather
        var weatherPresetEl = document.getElementById('env-weather-preset');
        var weatherPresetVal = weatherPresetEl ? weatherPresetEl.value : 'none';
        if (weatherPresetVal !== 'none') {
            env.weather = { preset: weatherPresetVal };
            if (weatherPresetVal === 'custom') {
                env.weather.windSpeed = parseFloat(document.getElementById('env-weather-windspeed').value) || 5;
                env.weather.windHeading = parseFloat(document.getElementById('env-weather-winddir').value) || 270;
                env.weather.turbulence = parseFloat(document.getElementById('env-weather-turbulence').value) || 0;
                env.weather.visibility = parseFloat(document.getElementById('env-weather-visibility').value) || 50;
            }
        }


        if (document.getElementById('env-magnetic').checked) {
            env.magneticField = {
                model: document.getElementById('env-magnetic-model').value,
                intensity: parseFloat(document.getElementById('env-magnetic-intensity').value) || 1.0
            };
        }

        if (document.getElementById('env-ionosphere').checked) {
            env.ionosphere = {
                model: document.getElementById('env-ionosphere-model').value,
                disturbance: document.getElementById('env-ionosphere-disturbance').value
            };
        }

        if (document.getElementById('env-radiation').checked) {
            env.radiationBelt = {
                model: document.getElementById('env-radiation-model').value,
                intensity: parseFloat(document.getElementById('env-radiation-intensity').value) || 1.0
            };
        }

        // Simulation start time
        var startInput = document.getElementById('env-start-time');
        var simStartTime = startInput ? startInput.value : null;
        env.simStartTime = simStartTime || null;

        return env;
    }

    function show(currentEnv) {
        _injectStyles();
        if (!_overlay) _buildDialog();
        _populateForm(currentEnv);
        _overlay.style.display = 'flex';
        return new Promise(function(resolve, reject) {
            _resolvePromise = resolve;
            _rejectPromise = reject;
        });
    }

    return { show: show };
})();
