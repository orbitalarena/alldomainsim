/**
 * PlatformBuilder — Modal dialog for creating custom platform templates.
 *
 * Allows composing entities from selectable components:
 * - Physics: TLE, COE (orbital elements), or Atmospheric flight
 * - Propulsion: Air/Hypersonic/Rocket engines (P key cycles)
 * - Sensors: Radar, Optical camera (S key opens sensor view)
 * - Payload: Debris (collision trigger) or missiles
 *
 * Custom platforms are saved to localStorage and embedded in scenario JSON.
 */
const PlatformBuilder = (function() {
    'use strict';

    const R_EARTH_KM = 6371;
    const MU_EARTH = 3.986004418e14;
    const STORAGE_KEY = 'customPlatforms';

    let _overlay = null;
    let _dialog = null;
    let _resolvePromise = null;
    let _rejectPromise = null;

    // Tab state
    let _activeTab = 'physics';
    let _tabs = {};
    let _tabContents = {};

    // Form state
    let _formState = {
        name: 'Custom Platform',
        team: 'blue',
        isEnvironment: false,  // true = environment effect, not a platform
        physics: {
            mode: 'coe',
            tle: { line1: '', line2: '' },
            coe: { sma_km: 6771, ecc: 0.001, inc_deg: 51.6, raan_deg: 0, argPe_deg: 0, ma_deg: 0 },
            atmospheric: { config: 'f16', alt: 5000, speed: 200, heading: 90 }
        },
        propulsion: {
            air: false,
            hypersonic: false,
            rocket: false,
            ion: false,
            rcs: false,
            defaultMode: 'rocket'
        },
        sensors: {
            radar: { enabled: false, maxRange_m: 150000, fov_deg: 120 },
            optical: { enabled: false, fov_deg: 30, gsd_m: 1.0 },
            ir: { enabled: false, fov_deg: 45, sensitivity: 'high' },
            sigint: { enabled: false, maxRange_m: 500000 },
            sar: { enabled: false, resolution_m: 1.0, swath_km: 50 },
            lidar: { enabled: false, maxRange_m: 10000, resolution_m: 0.1 }
        },
        payload: {
            spaceDebris: { enabled: false, numPieces: 100, trigger: 'collision' },
            airDebris: { enabled: false, numPieces: 20 },
            a2aMissiles: { enabled: false, loadout: 'standard' },
            a2gMissiles: { enabled: false, loadout: 'standard' },
            kineticKill: { enabled: false, interceptRange_km: 500 },
            jammer: { enabled: false, power_w: 1000, range_km: 200 },
            decoys: { enabled: false, count: 20 },
            cargo: { enabled: false, deployable: 'cubesat' },
            // Nuclear options
            nuclearWarhead: { enabled: false, yield_kt: 1400, burstType: 'exoatmospheric', trigger: 'command' },
            nuclearCruiseMissile: { enabled: false, yield_kt: 150, burstType: 'airburst', range_km: 2500 }
        },
        environment: {
            gravity: { model: 'earth', customMu: 3.986e14 },
            atmosphere: { model: 'earth_standard', scaleHeight: 8500 },
            magneticField: { enabled: false, model: 'earth_dipole', intensity: 1.0 },
            ionosphere: { enabled: false, model: 'standard', disturbance: 'none' },
            radiationBelt: { enabled: false, model: 'van_allen', intensity: 1.0 }
        }
    };

    // Aircraft configs available for atmospheric mode
    const AIRCRAFT_CONFIGS = [
        { id: 'f16', name: 'F-16 Fighting Falcon' },
        { id: 'f15', name: 'F-15 Strike Eagle' },
        { id: 'f22', name: 'F-22 Raptor' },
        { id: 'mig29', name: 'MiG-29 Fulcrum' },
        { id: 'su27', name: 'Su-27 Flanker' },
        { id: 'spaceplane', name: 'X-37 Spaceplane' },
        { id: 'bomber', name: 'B-2 Spirit' },
        { id: 'awacs', name: 'E-3 AWACS' },
        { id: 'transport', name: 'C-130 Hercules' },
        { id: 'drone_male', name: 'MQ-9 Reaper' }
    ];

    /**
     * Initialize the dialog DOM (called once from BuilderApp.init).
     */
    function init() {
        if (_overlay) return; // Already initialized

        _overlay = document.createElement('div');
        _overlay.className = 'platform-builder-overlay';
        _overlay.style.display = 'none';
        _overlay.addEventListener('click', e => {
            if (e.target === _overlay) _cancel();
        });

        _dialog = document.createElement('div');
        _dialog.className = 'platform-builder-dialog';

        // Build dialog structure
        _dialog.appendChild(_createHeader());
        _dialog.appendChild(_createMetaFields());
        _dialog.appendChild(_createTabBar());
        _dialog.appendChild(_createTabContents());
        _dialog.appendChild(_createButtons());

        _overlay.appendChild(_dialog);
        document.body.appendChild(_overlay);

        _injectStyles();
        _loadFromStorage();
    }

    function _createHeader() {
        const header = document.createElement('div');
        header.className = 'pb-header';
        header.textContent = 'ADD CUSTOM PLATFORM';
        return header;
    }

    function _createMetaFields() {
        const meta = document.createElement('div');
        meta.className = 'pb-meta';

        // Name field
        const nameGroup = document.createElement('div');
        nameGroup.className = 'pb-field-group';
        nameGroup.innerHTML = `
            <label>Name:</label>
            <input type="text" id="pb-name" value="${_formState.name}" />
        `;
        meta.appendChild(nameGroup);

        // Team select
        const teamGroup = document.createElement('div');
        teamGroup.className = 'pb-field-group';
        teamGroup.innerHTML = `
            <label>Team:</label>
            <select id="pb-team">
                <option value="blue" ${_formState.team === 'blue' ? 'selected' : ''}>Blue</option>
                <option value="red" ${_formState.team === 'red' ? 'selected' : ''}>Red</option>
                <option value="neutral" ${_formState.team === 'neutral' ? 'selected' : ''}>Neutral</option>
            </select>
        `;
        meta.appendChild(teamGroup);

        // Icon preview
        const iconGroup = document.createElement('div');
        iconGroup.className = 'pb-field-group';
        iconGroup.innerHTML = `
            <label>Icon:</label>
            <span id="pb-icon-preview" class="pb-icon-preview" style="background: ${_getTeamColor(_formState.team)}"></span>
        `;
        meta.appendChild(iconGroup);

        return meta;
    }

    function _createTabBar() {
        const bar = document.createElement('div');
        bar.className = 'pb-tab-bar';

        const tabDefs = [
            { id: 'physics', label: 'PHYSICS' },
            { id: 'propulsion', label: 'PROPULSION' },
            { id: 'sensors', label: 'SENSORS' },
            { id: 'payload', label: 'PAYLOAD' },
            { id: 'environment', label: 'ENVIRON' }
        ];

        tabDefs.forEach(def => {
            const tab = document.createElement('div');
            tab.className = 'pb-tab' + (def.id === _activeTab ? ' pb-tab-active' : '');
            tab.textContent = def.label;
            tab.dataset.tab = def.id;
            tab.addEventListener('click', () => _switchTab(def.id));
            _tabs[def.id] = tab;
            bar.appendChild(tab);
        });

        return bar;
    }

    function _createTabContents() {
        const container = document.createElement('div');
        container.className = 'pb-tab-contents';

        _tabContents.physics = _createPhysicsTab();
        _tabContents.propulsion = _createPropulsionTab();
        _tabContents.sensors = _createSensorsTab();
        _tabContents.payload = _createPayloadTab();
        _tabContents.environment = _createEnvironmentTab();

        Object.keys(_tabContents).forEach(id => {
            _tabContents[id].style.display = id === _activeTab ? 'block' : 'none';
            container.appendChild(_tabContents[id]);
        });

        return container;
    }

    // -------------------------------------------------------------------------
    // Physics Tab
    // -------------------------------------------------------------------------
    function _createPhysicsTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">PHYSICS TYPE</div>

            <div class="pb-radio-group">
                <label class="pb-radio-item">
                    <input type="radio" name="physics-mode" value="tle" ${_formState.physics.mode === 'tle' ? 'checked' : ''} />
                    <span>TLE - Paste Two-Line Element</span>
                </label>
                <div class="pb-sub-fields pb-tle-fields" style="display: ${_formState.physics.mode === 'tle' ? 'block' : 'none'}">
                    <input type="text" id="pb-tle-line1" placeholder="Line 1: 1 25544U 98067A..." value="${_formState.physics.tle.line1}" />
                    <input type="text" id="pb-tle-line2" placeholder="Line 2: 2 25544  51.6400..." value="${_formState.physics.tle.line2}" />
                </div>
            </div>

            <div class="pb-radio-group">
                <label class="pb-radio-item">
                    <input type="radio" name="physics-mode" value="coe" ${_formState.physics.mode === 'coe' ? 'checked' : ''} />
                    <span>Orbital Elements (COE)</span>
                </label>
                <div class="pb-sub-fields pb-coe-fields" style="display: ${_formState.physics.mode === 'coe' ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>SMA (km)</label>
                            <input type="number" id="pb-coe-sma" value="${_formState.physics.coe.sma_km}" min="6400" max="100000" step="1" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Eccentricity</label>
                            <input type="number" id="pb-coe-ecc" value="${_formState.physics.coe.ecc}" min="0" max="0.99" step="0.001" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Inc (°)</label>
                            <input type="number" id="pb-coe-inc" value="${_formState.physics.coe.inc_deg}" min="0" max="180" step="0.1" />
                        </div>
                    </div>
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>RAAN (°)</label>
                            <input type="number" id="pb-coe-raan" value="${_formState.physics.coe.raan_deg}" min="0" max="360" step="0.1" />
                        </div>
                        <div class="pb-coe-field">
                            <label>ArgPe (°)</label>
                            <input type="number" id="pb-coe-argpe" value="${_formState.physics.coe.argPe_deg}" min="0" max="360" step="0.1" />
                        </div>
                        <div class="pb-coe-field">
                            <label>MA (°)</label>
                            <input type="number" id="pb-coe-ma" value="${_formState.physics.coe.ma_deg}" min="0" max="360" step="0.1" />
                        </div>
                    </div>
                    <div class="pb-computed" id="pb-coe-computed">Pe: -- | Ap: -- | Period: --</div>
                </div>
            </div>

            <div class="pb-radio-group">
                <label class="pb-radio-item">
                    <input type="radio" name="physics-mode" value="atmospheric" ${_formState.physics.mode === 'atmospheric' ? 'checked' : ''} />
                    <span>Atmospheric Flight</span>
                </label>
                <div class="pb-sub-fields pb-atmo-fields" style="display: ${_formState.physics.mode === 'atmospheric' ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field" style="flex: 2">
                            <label>Base Config</label>
                            <select id="pb-atmo-config">
                                ${AIRCRAFT_CONFIGS.map(c => `<option value="${c.id}" ${_formState.physics.atmospheric.config === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Alt (m)</label>
                            <input type="number" id="pb-atmo-alt" value="${_formState.physics.atmospheric.alt}" min="0" max="100000" step="100" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Speed (m/s)</label>
                            <input type="number" id="pb-atmo-speed" value="${_formState.physics.atmospheric.speed}" min="0" max="3000" step="10" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Hdg (°)</label>
                            <input type="number" id="pb-atmo-heading" value="${_formState.physics.atmospheric.heading}" min="0" max="360" step="1" />
                        </div>
                    </div>
                </div>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Propulsion Tab
    // -------------------------------------------------------------------------
    function _createPropulsionTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">ENGINE MODES <span class="pb-hint">(P key cycles through enabled modes)</span></div>
            <div class="pb-propulsion-hint">Select multiple engines for multi-regime vehicles (spaceplanes, reentry capsules, etc.)</div>

            <div class="pb-checkbox-group" id="pb-propulsion-options">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-prop-air" ${_formState.propulsion.air ? 'checked' : ''} />
                    <span class="pb-check-label">Air-Breathing</span>
                    <span class="pb-check-desc">Turbofan/turbojet, 90-160 kN with density lapse</span>
                </label>

                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-prop-hypersonic" ${_formState.propulsion.hypersonic ? 'checked' : ''} />
                    <span class="pb-check-label">Hypersonic</span>
                    <span class="pb-check-desc">Scramjet/ramjet, 400 kN constant, Mach 2-10</span>
                </label>

                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-prop-rocket" ${_formState.propulsion.rocket ? 'checked' : ''} />
                    <span class="pb-check-label">Rocket</span>
                    <span class="pb-check-desc">Chemical rocket, 2 MN, works in vacuum</span>
                </label>

                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-prop-ion" ${_formState.propulsion.ion ? 'checked' : ''} />
                    <span class="pb-check-label">Ion/Electric</span>
                    <span class="pb-check-desc">Low thrust (0.5 N), high Isp, station-keeping</span>
                </label>

                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-prop-rcs" ${_formState.propulsion.rcs ? 'checked' : ''} />
                    <span class="pb-check-label">RCS Thrusters</span>
                    <span class="pb-check-desc">Attitude control, proximity ops, docking</span>
                </label>
            </div>

            <div class="pb-default-mode" id="pb-default-mode">
                <label>Default Mode:</label>
                <select id="pb-prop-default">
                    <option value="rocket">Rocket</option>
                    <option value="air">Air-Breathing</option>
                    <option value="hypersonic">Hypersonic</option>
                    <option value="ion">Ion</option>
                    <option value="rcs">RCS</option>
                </select>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Sensors Tab
    // -------------------------------------------------------------------------
    function _createSensorsTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">SENSOR SYSTEMS <span class="pb-hint">(S key opens sensor view)</span></div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-radar" ${_formState.sensors.radar.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">Search Radar</span>
                    <span class="pb-check-desc">Active radar with rotating scan pattern</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="radar" style="display: ${_formState.sensors.radar.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Range (km)</label>
                            <input type="number" id="pb-radar-range" value="${_formState.sensors.radar.maxRange_m / 1000}" min="10" max="500" step="10" />
                        </div>
                        <div class="pb-coe-field">
                            <label>FOV (°)</label>
                            <input type="number" id="pb-radar-fov" value="${_formState.sensors.radar.fov_deg}" min="30" max="360" step="10" />
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-optical" ${_formState.sensors.optical.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">Electro-Optical</span>
                    <span class="pb-check-desc">Visible-light imaging camera</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="optical" style="display: ${_formState.sensors.optical.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>FOV (°)</label>
                            <input type="number" id="pb-optical-fov" value="${_formState.sensors.optical.fov_deg}" min="0.5" max="60" step="0.5" />
                        </div>
                        <div class="pb-coe-field">
                            <label>GSD (m)</label>
                            <input type="number" id="pb-optical-gsd" value="${_formState.sensors.optical.gsd_m}" min="0.1" max="100" step="0.1" />
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-ir" ${_formState.sensors.ir.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">Infrared / Thermal</span>
                    <span class="pb-check-desc">Heat signature detection, works day/night</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="ir" style="display: ${_formState.sensors.ir.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>FOV (°)</label>
                            <input type="number" id="pb-ir-fov" value="${_formState.sensors.ir.fov_deg}" min="5" max="120" step="5" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Sensitivity</label>
                            <select id="pb-ir-sensitivity">
                                <option value="low">Low (vehicles)</option>
                                <option value="medium">Medium (aircraft)</option>
                                <option value="high" selected>High (missiles)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-sar" ${_formState.sensors.sar.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">SAR (Synthetic Aperture)</span>
                    <span class="pb-check-desc">All-weather imaging radar, sees through clouds</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="sar" style="display: ${_formState.sensors.sar.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Resolution (m)</label>
                            <input type="number" id="pb-sar-resolution" value="${_formState.sensors.sar.resolution_m}" min="0.1" max="30" step="0.1" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Swath (km)</label>
                            <input type="number" id="pb-sar-swath" value="${_formState.sensors.sar.swath_km}" min="5" max="500" step="5" />
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-sigint" ${_formState.sensors.sigint.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">SIGINT / ESM</span>
                    <span class="pb-check-desc">Electronic signals intelligence, passive detection</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="sigint" style="display: ${_formState.sensors.sigint.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Range (km)</label>
                            <input type="number" id="pb-sigint-range" value="${_formState.sensors.sigint.maxRange_m / 1000}" min="50" max="2000" step="50" />
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-sensor-group">
                <label class="pb-checkbox-item">
                    <input type="checkbox" id="pb-sensor-lidar" ${_formState.sensors.lidar.enabled ? 'checked' : ''} />
                    <span class="pb-check-label">LIDAR</span>
                    <span class="pb-check-desc">Laser ranging, high-precision 3D mapping</span>
                </label>
                <div class="pb-sub-fields pb-sensor-config" data-sensor="lidar" style="display: ${_formState.sensors.lidar.enabled ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Range (km)</label>
                            <input type="number" id="pb-lidar-range" value="${_formState.sensors.lidar.maxRange_m / 1000}" min="1" max="100" step="1" />
                        </div>
                        <div class="pb-coe-field">
                            <label>Resolution (m)</label>
                            <input type="number" id="pb-lidar-resolution" value="${_formState.sensors.lidar.resolution_m}" min="0.01" max="10" step="0.01" />
                        </div>
                    </div>
                </div>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Payload Tab
    // -------------------------------------------------------------------------
    function _createPayloadTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">PAYLOAD SYSTEMS <span class="pb-hint">(select multiple)</span></div>

            <div class="pb-payload-section">
                <div class="pb-payload-category">Weapons</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-a2a" ${_formState.payload.a2aMissiles.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Air-to-Air Missiles</span>
                        <span class="pb-check-desc">AIM-9/AIM-120 or R-73/R-77 loadout</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="a2a" style="display: ${_formState.payload.a2aMissiles.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Loadout</label>
                                <select id="pb-a2a-loadout">
                                    <option value="standard">Standard (2x WVR, 4x BVR)</option>
                                    <option value="heavy">Heavy (4x WVR, 6x BVR)</option>
                                    <option value="wvr_only">WVR Only (6x short-range)</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-a2g" ${_formState.payload.a2gMissiles.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Air-to-Ground</span>
                        <span class="pb-check-desc">Bombs, cruise missiles, AGMs</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="a2g" style="display: ${_formState.payload.a2gMissiles.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Loadout</label>
                                <select id="pb-a2g-loadout">
                                    <option value="bombs">Guided Bombs (8x GBU)</option>
                                    <option value="cruise">Cruise Missiles (4x JASSM)</option>
                                    <option value="mixed">Mixed (4x bombs, 2x AGM)</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-kinetic" ${_formState.payload.kineticKill.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Kinetic Kill Vehicle</span>
                        <span class="pb-check-desc">Co-orbital ASAT interceptor</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="kinetic" style="display: ${_formState.payload.kineticKill.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Intercept Range (km)</label>
                                <input type="number" id="pb-kinetic-range" value="${_formState.payload.kineticKill.interceptRange_km}" min="10" max="2000" step="10" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section">
                <div class="pb-payload-category">Electronic Warfare</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-jammer" ${_formState.payload.jammer.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Jammer / ECM</span>
                        <span class="pb-check-desc">Radar/comms jamming, electronic attack</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="jammer" style="display: ${_formState.payload.jammer.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Power (kW)</label>
                                <input type="number" id="pb-jammer-power" value="${_formState.payload.jammer.power_w / 1000}" min="0.1" max="100" step="0.1" />
                            </div>
                            <div class="pb-coe-field">
                                <label>Range (km)</label>
                                <input type="number" id="pb-jammer-range" value="${_formState.payload.jammer.range_km}" min="10" max="500" step="10" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-decoys" ${_formState.payload.decoys.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Decoys / Chaff</span>
                        <span class="pb-check-desc">Countermeasures, flares, radar decoys</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="decoys" style="display: ${_formState.payload.decoys.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Count</label>
                                <input type="number" id="pb-decoys-count" value="${_formState.payload.decoys.count}" min="5" max="100" step="5" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section">
                <div class="pb-payload-category">Debris / Effects</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-space-debris" ${_formState.payload.spaceDebris.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Space Debris</span>
                        <span class="pb-check-desc">Generates orbital debris on collision/destruction</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="space-debris" style="display: ${_formState.payload.spaceDebris.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Pieces</label>
                                <input type="number" id="pb-space-debris-pieces" value="${_formState.payload.spaceDebris.numPieces}" min="10" max="1000" step="10" />
                            </div>
                            <div class="pb-coe-field">
                                <label>Trigger</label>
                                <select id="pb-space-debris-trigger">
                                    <option value="collision" ${_formState.payload.spaceDebris.trigger === 'collision' ? 'selected' : ''}>On Collision</option>
                                    <option value="destruction" ${_formState.payload.spaceDebris.trigger === 'destruction' ? 'selected' : ''}>On Destruction</option>
                                    <option value="command" ${_formState.payload.spaceDebris.trigger === 'command' ? 'selected' : ''}>On Command</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-air-debris" ${_formState.payload.airDebris.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Air Debris</span>
                        <span class="pb-check-desc">Falling debris on atmospheric destruction</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="air-debris" style="display: ${_formState.payload.airDebris.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Pieces</label>
                                <input type="number" id="pb-air-debris-pieces" value="${_formState.payload.airDebris.numPieces}" min="5" max="100" step="5" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section">
                <div class="pb-payload-category">Special</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-cargo" ${_formState.payload.cargo.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Cargo / Deployer</span>
                        <span class="pb-check-desc">Can deploy other entities (cubesats, drones)</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="cargo" style="display: ${_formState.payload.cargo.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Deployable Type</label>
                                <select id="pb-cargo-type">
                                    <option value="cubesat">CubeSats (6x)</option>
                                    <option value="drone">Mini-drones (4x)</option>
                                    <option value="sensor">Sensor pods (2x)</option>
                                    <option value="decoy_sat">Decoy satellites (3x)</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section pb-nuclear-section">
                <div class="pb-payload-category" style="color: #f80;">☢ Nuclear</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-nuke-warhead" ${_formState.payload.nuclearWarhead.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Nuclear Warhead</span>
                        <span class="pb-check-desc">Direct detonation (Starfish Prime style EMP)</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="nuke-warhead" style="display: ${_formState.payload.nuclearWarhead.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Yield</label>
                                <select id="pb-nuke-warhead-yield">
                                    <option value="10">10 kt (tactical)</option>
                                    <option value="150">150 kt (W80)</option>
                                    <option value="475">475 kt (W88)</option>
                                    <option value="1400" selected>1.4 Mt (Starfish Prime)</option>
                                    <option value="5000">5 Mt (strategic)</option>
                                    <option value="50000">50 Mt (Tsar Bomba)</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Burst Type</label>
                                <select id="pb-nuke-warhead-burst">
                                    <option value="exoatmospheric" selected>Exoatmospheric (EMP)</option>
                                    <option value="high_altitude">High Altitude</option>
                                    <option value="airburst">Airburst</option>
                                    <option value="surface">Surface</option>
                                </select>
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Trigger</label>
                                <select id="pb-nuke-warhead-trigger">
                                    <option value="command" selected>On Command</option>
                                    <option value="timer">Timer</option>
                                    <option value="proximity">Proximity</option>
                                    <option value="collision">On Collision</option>
                                </select>
                            </div>
                        </div>
                        <div class="pb-nuke-note">⚡ Exoatmospheric detonation generates EMP via magnetic field interaction</div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-nuke-cruise" ${_formState.payload.nuclearCruiseMissile.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Nuclear Cruise Missile</span>
                        <span class="pb-check-desc">Air-launched (AGM-86B / Kh-55 style)</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="nuke-cruise" style="display: ${_formState.payload.nuclearCruiseMissile.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Yield</label>
                                <select id="pb-nuke-cruise-yield">
                                    <option value="5">5 kt (W80-0)</option>
                                    <option value="150" selected>150 kt (W80-1)</option>
                                    <option value="200">200 kt (Kh-55)</option>
                                    <option value="350">350 kt (W84)</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Range (km)</label>
                                <input type="number" id="pb-nuke-cruise-range" value="${_formState.payload.nuclearCruiseMissile.range_km}" min="500" max="5000" step="100" />
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Burst Type</label>
                                <select id="pb-nuke-cruise-burst">
                                    <option value="airburst" selected>Airburst</option>
                                    <option value="surface">Surface</option>
                                    <option value="groundburst">Ground Penetrating</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Environment Tab
    // -------------------------------------------------------------------------
    function _createEnvironmentTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">ENVIRONMENT CONFIGURATION <span class="pb-hint">(affects scenario physics)</span></div>
            <div class="pb-env-note">Configure environmental factors for the scenario. These settings apply globally.</div>

            <div class="pb-env-section">
                <div class="pb-payload-category">Gravity & Atmosphere</div>

                <div class="pb-sensor-group">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Gravity Model</label>
                            <select id="pb-env-gravity">
                                <option value="earth" selected>Earth (μ = 3.986e14)</option>
                                <option value="moon">Moon (μ = 4.905e12)</option>
                                <option value="mars">Mars (μ = 4.283e13)</option>
                                <option value="jupiter">Jupiter (μ = 1.267e17)</option>
                                <option value="venus">Venus (μ = 3.249e14)</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>
                        <div class="pb-coe-field" id="pb-env-custom-mu-field" style="display: none;">
                            <label>Custom μ (m³/s²)</label>
                            <input type="number" id="pb-env-custom-mu" value="3.986e14" step="1e12" />
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Atmosphere Model</label>
                            <select id="pb-env-atmosphere">
                                <option value="earth_standard" selected>Earth (US Standard 1976)</option>
                                <option value="earth_thermosphere">Earth + Thermosphere</option>
                                <option value="mars">Mars (CO₂, 0.6% Earth)</option>
                                <option value="venus">Venus (dense CO₂)</option>
                                <option value="titan">Titan (N₂, 1.5x Earth)</option>
                                <option value="none">None (vacuum)</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-env-section">
                <div class="pb-payload-category">Magnetic Field & Ionosphere</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-env-magnetic" ${_formState.environment.magneticField.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Magnetic Field</span>
                        <span class="pb-check-desc">Required for EMP propagation & charged particle effects</span>
                    </label>
                    <div class="pb-sub-fields pb-env-config" data-env="magnetic" style="display: ${_formState.environment.magneticField.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Model</label>
                                <select id="pb-env-magnetic-model">
                                    <option value="earth_dipole" selected>Earth Dipole (IGRF)</option>
                                    <option value="jupiter">Jupiter (14x Earth)</option>
                                    <option value="custom">Custom Intensity</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Intensity Multiplier</label>
                                <input type="number" id="pb-env-magnetic-intensity" value="${_formState.environment.magneticField.intensity}" min="0.1" max="100" step="0.1" />
                            </div>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-env-ionosphere" ${_formState.environment.ionosphere.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Ionosphere</span>
                        <span class="pb-check-desc">Affects RF propagation, EMP coupling, aurora</span>
                    </label>
                    <div class="pb-sub-fields pb-env-config" data-env="ionosphere" style="display: ${_formState.environment.ionosphere.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Model</label>
                                <select id="pb-env-ionosphere-model">
                                    <option value="standard" selected>Standard (IRI)</option>
                                    <option value="solar_max">Solar Maximum</option>
                                    <option value="solar_min">Solar Minimum</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Disturbance</label>
                                <select id="pb-env-ionosphere-disturbance">
                                    <option value="none" selected>None</option>
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

            <div class="pb-env-section">
                <div class="pb-payload-category">Radiation Environment</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-env-radiation" ${_formState.environment.radiationBelt.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Radiation Belts</span>
                        <span class="pb-check-desc">Van Allen belts, affects satellite survivability</span>
                    </label>
                    <div class="pb-sub-fields pb-env-config" data-env="radiation" style="display: ${_formState.environment.radiationBelt.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Model</label>
                                <select id="pb-env-radiation-model">
                                    <option value="van_allen" selected>Van Allen (AP-8/AE-8)</option>
                                    <option value="starfish_enhanced">Starfish-Enhanced</option>
                                    <option value="jupiter">Jupiter (extreme)</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Intensity</label>
                                <input type="number" id="pb-env-radiation-intensity" value="${_formState.environment.radiationBelt.intensity}" min="0.1" max="10" step="0.1" />
                            </div>
                        </div>
                        <div class="pb-env-hint">Starfish Prime created artificial radiation belts that persisted for years</div>
                    </div>
                </div>
            </div>
        `;

        return tab;
    }

    function _createButtons() {
        const btns = document.createElement('div');
        btns.className = 'pb-buttons';

        const btnCancel = document.createElement('button');
        btnCancel.className = 'pb-btn pb-btn-cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', _cancel);
        btns.appendChild(btnCancel);

        const btnCreate = document.createElement('button');
        btnCreate.className = 'pb-btn pb-btn-confirm';
        btnCreate.textContent = 'Create Platform';
        btnCreate.addEventListener('click', _confirm);
        btns.appendChild(btnCreate);

        return btns;
    }

    // -------------------------------------------------------------------------
    // Tab switching and event handlers
    // -------------------------------------------------------------------------
    function _switchTab(tabId) {
        _activeTab = tabId;
        Object.keys(_tabs).forEach(id => {
            _tabs[id].classList.toggle('pb-tab-active', id === tabId);
            _tabContents[id].style.display = id === tabId ? 'block' : 'none';
        });
        _updatePropulsionAvailability();
    }

    function _attachEventListeners() {
        // Name and team
        document.getElementById('pb-name')?.addEventListener('input', e => {
            _formState.name = e.target.value;
        });

        document.getElementById('pb-team')?.addEventListener('change', e => {
            _formState.team = e.target.value;
            const preview = document.getElementById('pb-icon-preview');
            if (preview) preview.style.background = _getTeamColor(_formState.team);
        });

        // Physics mode radio buttons
        document.querySelectorAll('input[name="physics-mode"]').forEach(radio => {
            radio.addEventListener('change', e => {
                _formState.physics.mode = e.target.value;
                _updatePhysicsVisibility();
                _updatePropulsionAvailability();
            });
        });

        // TLE fields
        document.getElementById('pb-tle-line1')?.addEventListener('input', e => {
            _formState.physics.tle.line1 = e.target.value;
        });
        document.getElementById('pb-tle-line2')?.addEventListener('input', e => {
            _formState.physics.tle.line2 = e.target.value;
        });

        // COE fields with live update
        ['sma', 'ecc', 'inc', 'raan', 'argpe', 'ma'].forEach(field => {
            const el = document.getElementById(`pb-coe-${field}`);
            if (el) {
                el.addEventListener('input', () => {
                    _formState.physics.coe.sma_km = parseFloat(document.getElementById('pb-coe-sma')?.value) || 6771;
                    _formState.physics.coe.ecc = parseFloat(document.getElementById('pb-coe-ecc')?.value) || 0;
                    _formState.physics.coe.inc_deg = parseFloat(document.getElementById('pb-coe-inc')?.value) || 0;
                    _formState.physics.coe.raan_deg = parseFloat(document.getElementById('pb-coe-raan')?.value) || 0;
                    _formState.physics.coe.argPe_deg = parseFloat(document.getElementById('pb-coe-argpe')?.value) || 0;
                    _formState.physics.coe.ma_deg = parseFloat(document.getElementById('pb-coe-ma')?.value) || 0;
                    _updateCOEComputed();
                });
            }
        });

        // Atmospheric fields
        document.getElementById('pb-atmo-config')?.addEventListener('change', e => {
            _formState.physics.atmospheric.config = e.target.value;
        });
        document.getElementById('pb-atmo-alt')?.addEventListener('input', e => {
            _formState.physics.atmospheric.alt = parseFloat(e.target.value) || 5000;
        });
        document.getElementById('pb-atmo-speed')?.addEventListener('input', e => {
            _formState.physics.atmospheric.speed = parseFloat(e.target.value) || 200;
        });
        document.getElementById('pb-atmo-heading')?.addEventListener('input', e => {
            _formState.physics.atmospheric.heading = parseFloat(e.target.value) || 90;
        });

        // Propulsion checkboxes
        ['air', 'hypersonic', 'rocket', 'ion', 'rcs'].forEach(mode => {
            document.getElementById(`pb-prop-${mode}`)?.addEventListener('change', e => {
                _formState.propulsion[mode] = e.target.checked;
                _updateDefaultModeOptions();
            });
        });
        document.getElementById('pb-prop-default')?.addEventListener('change', e => {
            _formState.propulsion.defaultMode = e.target.value;
        });

        // Sensor checkboxes - generic handler for all sensors
        ['radar', 'optical', 'ir', 'sar', 'sigint', 'lidar'].forEach(sensor => {
            document.getElementById(`pb-sensor-${sensor}`)?.addEventListener('change', e => {
                _formState.sensors[sensor].enabled = e.target.checked;
                const config = document.querySelector(`.pb-sensor-config[data-sensor="${sensor}"]`);
                if (config) config.style.display = e.target.checked ? 'block' : 'none';
            });
        });

        // Sensor config inputs
        document.getElementById('pb-radar-range')?.addEventListener('input', e => {
            _formState.sensors.radar.maxRange_m = (parseFloat(e.target.value) || 150) * 1000;
        });
        document.getElementById('pb-radar-fov')?.addEventListener('input', e => {
            _formState.sensors.radar.fov_deg = parseFloat(e.target.value) || 120;
        });
        document.getElementById('pb-optical-fov')?.addEventListener('input', e => {
            _formState.sensors.optical.fov_deg = parseFloat(e.target.value) || 30;
        });
        document.getElementById('pb-optical-gsd')?.addEventListener('input', e => {
            _formState.sensors.optical.gsd_m = parseFloat(e.target.value) || 1.0;
        });
        document.getElementById('pb-ir-fov')?.addEventListener('input', e => {
            _formState.sensors.ir.fov_deg = parseFloat(e.target.value) || 45;
        });
        document.getElementById('pb-ir-sensitivity')?.addEventListener('change', e => {
            _formState.sensors.ir.sensitivity = e.target.value;
        });
        document.getElementById('pb-sar-resolution')?.addEventListener('input', e => {
            _formState.sensors.sar.resolution_m = parseFloat(e.target.value) || 1.0;
        });
        document.getElementById('pb-sar-swath')?.addEventListener('input', e => {
            _formState.sensors.sar.swath_km = parseFloat(e.target.value) || 50;
        });
        document.getElementById('pb-sigint-range')?.addEventListener('input', e => {
            _formState.sensors.sigint.maxRange_m = (parseFloat(e.target.value) || 500) * 1000;
        });
        document.getElementById('pb-lidar-range')?.addEventListener('input', e => {
            _formState.sensors.lidar.maxRange_m = (parseFloat(e.target.value) || 10) * 1000;
        });
        document.getElementById('pb-lidar-resolution')?.addEventListener('input', e => {
            _formState.sensors.lidar.resolution_m = parseFloat(e.target.value) || 0.1;
        });

        // Payload checkboxes - generic handler
        const payloadMap = {
            'a2a': 'a2aMissiles',
            'a2g': 'a2gMissiles',
            'kinetic': 'kineticKill',
            'jammer': 'jammer',
            'decoys': 'decoys',
            'space-debris': 'spaceDebris',
            'air-debris': 'airDebris',
            'cargo': 'cargo'
        };
        Object.keys(payloadMap).forEach(key => {
            document.getElementById(`pb-payload-${key}`)?.addEventListener('change', e => {
                _formState.payload[payloadMap[key]].enabled = e.target.checked;
                const config = document.querySelector(`.pb-payload-config[data-payload="${key}"]`);
                if (config) config.style.display = e.target.checked ? 'block' : 'none';
            });
        });

        // Payload config inputs
        document.getElementById('pb-a2a-loadout')?.addEventListener('change', e => {
            _formState.payload.a2aMissiles.loadout = e.target.value;
        });
        document.getElementById('pb-a2g-loadout')?.addEventListener('change', e => {
            _formState.payload.a2gMissiles.loadout = e.target.value;
        });
        document.getElementById('pb-kinetic-range')?.addEventListener('input', e => {
            _formState.payload.kineticKill.interceptRange_km = parseFloat(e.target.value) || 500;
        });
        document.getElementById('pb-jammer-power')?.addEventListener('input', e => {
            _formState.payload.jammer.power_w = (parseFloat(e.target.value) || 1) * 1000;
        });
        document.getElementById('pb-jammer-range')?.addEventListener('input', e => {
            _formState.payload.jammer.range_km = parseFloat(e.target.value) || 200;
        });
        document.getElementById('pb-decoys-count')?.addEventListener('input', e => {
            _formState.payload.decoys.count = parseInt(e.target.value) || 20;
        });
        document.getElementById('pb-space-debris-pieces')?.addEventListener('input', e => {
            _formState.payload.spaceDebris.numPieces = parseInt(e.target.value) || 100;
        });
        document.getElementById('pb-space-debris-trigger')?.addEventListener('change', e => {
            _formState.payload.spaceDebris.trigger = e.target.value;
        });
        document.getElementById('pb-air-debris-pieces')?.addEventListener('input', e => {
            _formState.payload.airDebris.numPieces = parseInt(e.target.value) || 20;
        });
        document.getElementById('pb-cargo-type')?.addEventListener('change', e => {
            _formState.payload.cargo.deployable = e.target.value;
        });

        // Nuclear payload checkboxes
        document.getElementById('pb-payload-nuke-warhead')?.addEventListener('change', e => {
            _formState.payload.nuclearWarhead.enabled = e.target.checked;
            const config = document.querySelector('.pb-payload-config[data-payload="nuke-warhead"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-payload-nuke-cruise')?.addEventListener('change', e => {
            _formState.payload.nuclearCruiseMissile.enabled = e.target.checked;
            const config = document.querySelector('.pb-payload-config[data-payload="nuke-cruise"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });

        // Nuclear payload config inputs
        document.getElementById('pb-nuke-warhead-yield')?.addEventListener('change', e => {
            _formState.payload.nuclearWarhead.yield_kt = parseInt(e.target.value) || 1400;
        });
        document.getElementById('pb-nuke-warhead-burst')?.addEventListener('change', e => {
            _formState.payload.nuclearWarhead.burstType = e.target.value;
        });
        document.getElementById('pb-nuke-warhead-trigger')?.addEventListener('change', e => {
            _formState.payload.nuclearWarhead.trigger = e.target.value;
        });
        document.getElementById('pb-nuke-cruise-yield')?.addEventListener('change', e => {
            _formState.payload.nuclearCruiseMissile.yield_kt = parseInt(e.target.value) || 150;
        });
        document.getElementById('pb-nuke-cruise-range')?.addEventListener('input', e => {
            _formState.payload.nuclearCruiseMissile.range_km = parseFloat(e.target.value) || 2500;
        });
        document.getElementById('pb-nuke-cruise-burst')?.addEventListener('change', e => {
            _formState.payload.nuclearCruiseMissile.burstType = e.target.value;
        });

        // Environment inputs
        document.getElementById('pb-env-gravity')?.addEventListener('change', e => {
            _formState.environment.gravity.model = e.target.value;
            const customField = document.getElementById('pb-env-custom-mu-field');
            if (customField) customField.style.display = e.target.value === 'custom' ? 'block' : 'none';
        });
        document.getElementById('pb-env-custom-mu')?.addEventListener('input', e => {
            _formState.environment.gravity.customMu = parseFloat(e.target.value) || 3.986e14;
        });
        document.getElementById('pb-env-atmosphere')?.addEventListener('change', e => {
            _formState.environment.atmosphere.model = e.target.value;
        });

        // Environment toggles
        document.getElementById('pb-env-magnetic')?.addEventListener('change', e => {
            _formState.environment.magneticField.enabled = e.target.checked;
            const config = document.querySelector('.pb-env-config[data-env="magnetic"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-env-magnetic-model')?.addEventListener('change', e => {
            _formState.environment.magneticField.model = e.target.value;
        });
        document.getElementById('pb-env-magnetic-intensity')?.addEventListener('input', e => {
            _formState.environment.magneticField.intensity = parseFloat(e.target.value) || 1.0;
        });

        document.getElementById('pb-env-ionosphere')?.addEventListener('change', e => {
            _formState.environment.ionosphere.enabled = e.target.checked;
            const config = document.querySelector('.pb-env-config[data-env="ionosphere"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-env-ionosphere-model')?.addEventListener('change', e => {
            _formState.environment.ionosphere.model = e.target.value;
        });
        document.getElementById('pb-env-ionosphere-disturbance')?.addEventListener('change', e => {
            _formState.environment.ionosphere.disturbance = e.target.value;
        });

        document.getElementById('pb-env-radiation')?.addEventListener('change', e => {
            _formState.environment.radiationBelt.enabled = e.target.checked;
            const config = document.querySelector('.pb-env-config[data-env="radiation"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-env-radiation-model')?.addEventListener('change', e => {
            _formState.environment.radiationBelt.model = e.target.value;
        });
        document.getElementById('pb-env-radiation-intensity')?.addEventListener('input', e => {
            _formState.environment.radiationBelt.intensity = parseFloat(e.target.value) || 1.0;
        });
    }

    function _updatePhysicsVisibility() {
        const mode = _formState.physics.mode;
        document.querySelector('.pb-tle-fields').style.display = mode === 'tle' ? 'block' : 'none';
        document.querySelector('.pb-coe-fields').style.display = mode === 'coe' ? 'block' : 'none';
        document.querySelector('.pb-atmo-fields').style.display = mode === 'atmospheric' ? 'block' : 'none';
    }

    // Payload visibility is now handled by checkbox event listeners in _attachEventListeners

    function _updatePropulsionAvailability() {
        // Propulsion is now available for all physics types
        // (spaceplanes can re-enter, satellites can have thrusters, etc.)
        const defaultMode = document.getElementById('pb-default-mode');
        if (defaultMode) defaultMode.style.display = 'flex';
    }

    function _updateDefaultModeOptions() {
        const select = document.getElementById('pb-prop-default');
        if (!select) return;

        const modeLabels = {
            air: 'Air-Breathing',
            hypersonic: 'Hypersonic',
            rocket: 'Rocket',
            ion: 'Ion',
            rcs: 'RCS'
        };

        const enabledModes = [];
        if (_formState.propulsion.air) enabledModes.push('air');
        if (_formState.propulsion.hypersonic) enabledModes.push('hypersonic');
        if (_formState.propulsion.rocket) enabledModes.push('rocket');
        if (_formState.propulsion.ion) enabledModes.push('ion');
        if (_formState.propulsion.rcs) enabledModes.push('rcs');

        select.innerHTML = enabledModes.map(m =>
            `<option value="${m}" ${_formState.propulsion.defaultMode === m ? 'selected' : ''}>${modeLabels[m]}</option>`
        ).join('');

        // Update default if current isn't available
        if (!enabledModes.includes(_formState.propulsion.defaultMode) && enabledModes.length > 0) {
            _formState.propulsion.defaultMode = enabledModes[0];
        }
    }

    function _updateCOEComputed() {
        const computed = document.getElementById('pb-coe-computed');
        if (!computed) return;

        const sma_km = _formState.physics.coe.sma_km;
        const ecc = _formState.physics.coe.ecc;

        if (sma_km <= 0 || ecc < 0 || ecc >= 1) {
            computed.textContent = 'Pe: -- | Ap: -- | Period: --';
            return;
        }

        const pe_km = sma_km * (1 - ecc) - R_EARTH_KM;
        const ap_km = sma_km * (1 + ecc) - R_EARTH_KM;
        const sma_m = sma_km * 1000;
        const period_s = 2 * Math.PI * Math.sqrt(sma_m * sma_m * sma_m / MU_EARTH);
        const period_min = period_s / 60;

        const periodStr = period_min < 120
            ? `${period_min.toFixed(1)} min`
            : `${(period_min / 60).toFixed(2)} hr`;

        computed.textContent = `Pe: ${pe_km.toFixed(0)} km | Ap: ${ap_km.toFixed(0)} km | Period: ${periodStr}`;
    }

    // -------------------------------------------------------------------------
    // Platform generation
    // -------------------------------------------------------------------------
    function _generatePlatformTemplate() {
        const mode = _formState.physics.mode;
        const isOrbital = mode === 'tle' || mode === 'coe';

        const platform = {
            id: 'custom_' + Date.now(),
            category: 'Custom',
            name: _formState.name || 'Custom Platform',
            icon: _getTeamColor(_formState.team),
            description: _generateDescription(),
            type: isOrbital ? 'satellite' : 'aircraft',
            team: _formState.team,
            defaults: {},
            components: {},
            // Custom platform metadata
            _custom: {
                physics: JSON.parse(JSON.stringify(_formState.physics)),
                propulsion: JSON.parse(JSON.stringify(_formState.propulsion)),
                sensors: JSON.parse(JSON.stringify(_formState.sensors)),
                payload: JSON.parse(JSON.stringify(_formState.payload))
            }
        };

        // Physics component
        if (mode === 'tle') {
            platform.defaults = { alt: 400000, speed: 7670, heading: 45, gamma: 0 };
            platform.components.physics = {
                type: 'orbital_2body',
                source: 'tle',
                tle1: _formState.physics.tle.line1,
                tle2: _formState.physics.tle.line2
            };
            platform.components.visual = {
                type: 'satellite',
                color: platform.icon,
                pixelSize: 8,
                orbitPath: true,
                groundTrack: true,
                apPeMarkers: true
            };
        } else if (mode === 'coe') {
            const coe = _formState.physics.coe;
            const pe_alt = coe.sma_km * 1000 * (1 - coe.ecc) - R_EARTH_KM * 1000;
            platform.defaults = { alt: pe_alt, speed: 7670, heading: coe.inc_deg, gamma: 0 };
            platform.components.physics = {
                type: 'orbital_2body',
                source: 'elements',
                sma: coe.sma_km * 1000,
                eccentricity: coe.ecc,
                inclination: coe.inc_deg,
                raan: coe.raan_deg,
                argPerigee: coe.argPe_deg,
                meanAnomaly: coe.ma_deg
            };
            platform.components.visual = {
                type: 'satellite',
                color: platform.icon,
                pixelSize: 8,
                orbitPath: true,
                groundTrack: true,
                apPeMarkers: true
            };
        } else {
            // Atmospheric
            const atmo = _formState.physics.atmospheric;
            platform.defaults = {
                alt: atmo.alt,
                speed: atmo.speed,
                heading: atmo.heading,
                gamma: 0,
                throttle: 0.6,
                engineOn: true,
                gearDown: false,
                infiniteFuel: true
            };
            platform.components.physics = {
                type: 'flight3dof',
                config: atmo.config
            };
            platform.components.control = {
                type: 'player_input',
                config: atmo.config === 'spaceplane' ? 'spaceplane' : 'fighter'
            };
            platform.components.visual = {
                type: 'point',
                color: platform.icon,
                pixelSize: 12,
                trail: true
            };
        }

        // Propulsion modes (available for ALL physics types - satellites can have thrusters, spaceplanes can re-enter)
        const enabledModes = [];
        if (_formState.propulsion.air) enabledModes.push('air');
        if (_formState.propulsion.hypersonic) enabledModes.push('hypersonic');
        if (_formState.propulsion.rocket) enabledModes.push('rocket');
        if (_formState.propulsion.ion) enabledModes.push('ion');
        if (_formState.propulsion.rcs) enabledModes.push('rcs');
        if (enabledModes.length > 0) {
            platform.components.propulsion = {
                modes: enabledModes,
                defaultMode: _formState.propulsion.defaultMode
            };
        }

        // Sensors (multiple can be enabled)
        if (_formState.sensors.radar.enabled) {
            platform.components.sensors = {
                type: 'radar',
                maxRange_m: _formState.sensors.radar.maxRange_m,
                fov_deg: _formState.sensors.radar.fov_deg,
                scanRate_dps: 60,
                detectionProbability: 0.85
            };
        }
        if (_formState.sensors.optical.enabled) {
            platform.components.optical = {
                type: 'optical_camera',
                fov_deg: _formState.sensors.optical.fov_deg,
                gsd_m: _formState.sensors.optical.gsd_m
            };
        }
        if (_formState.sensors.ir.enabled) {
            platform.components.ir_sensor = {
                type: 'ir_camera',
                fov_deg: _formState.sensors.ir.fov_deg,
                sensitivity: _formState.sensors.ir.sensitivity
            };
        }
        if (_formState.sensors.sar.enabled) {
            platform.components.sar = {
                type: 'sar_radar',
                resolution_m: _formState.sensors.sar.resolution_m,
                swath_km: _formState.sensors.sar.swath_km
            };
        }
        if (_formState.sensors.sigint.enabled) {
            platform.components.sigint = {
                type: 'sigint_receiver',
                maxRange_m: _formState.sensors.sigint.maxRange_m
            };
        }
        if (_formState.sensors.lidar.enabled) {
            platform.components.lidar = {
                type: 'lidar_scanner',
                maxRange_m: _formState.sensors.lidar.maxRange_m,
                resolution_m: _formState.sensors.lidar.resolution_m
            };
        }

        // Payloads (multiple can be enabled)
        const payloads = [];

        // Weapons
        if (_formState.payload.a2aMissiles.enabled) {
            const loadoutDef = _getA2ALoadout(_formState.payload.a2aMissiles.loadout);
            platform.components.weapons = {
                type: 'a2a_missile',
                loadout: loadoutDef,
                engagementRules: 'weapons_free'
            };
            payloads.push('a2a');
        }
        if (_formState.payload.a2gMissiles.enabled) {
            platform.components.a2g_weapons = {
                type: 'a2g_ordnance',
                loadout: _formState.payload.a2gMissiles.loadout
            };
            payloads.push('a2g');
        }
        if (_formState.payload.kineticKill.enabled) {
            platform.components.kinetic_kill = {
                type: 'kinetic_interceptor',
                interceptRange_km: _formState.payload.kineticKill.interceptRange_km,
                cooldown_s: 30,
                Pk: 0.7
            };
            payloads.push('kkv');
        }

        // Electronic Warfare
        if (_formState.payload.jammer.enabled) {
            platform.components.jammer = {
                type: 'ecm_jammer',
                power_w: _formState.payload.jammer.power_w,
                range_km: _formState.payload.jammer.range_km
            };
            payloads.push('jammer');
        }
        if (_formState.payload.decoys.enabled) {
            platform.components.decoys = {
                type: 'countermeasures',
                count: _formState.payload.decoys.count,
                types: ['chaff', 'flare', 'active_decoy']
            };
            payloads.push('decoys');
        }

        // Debris
        if (_formState.payload.spaceDebris.enabled) {
            platform.components.space_debris = {
                type: 'debris_payload',
                debrisType: 'space',
                numPieces: _formState.payload.spaceDebris.numPieces,
                trigger: _formState.payload.spaceDebris.trigger
            };
            payloads.push('space_debris');
        }
        if (_formState.payload.airDebris.enabled) {
            platform.components.air_debris = {
                type: 'debris_payload',
                debrisType: 'air',
                numPieces: _formState.payload.airDebris.numPieces,
                trigger: 'destruction'
            };
            payloads.push('air_debris');
        }

        // Special
        if (_formState.payload.cargo.enabled) {
            platform.components.cargo = {
                type: 'deployer',
                deployable: _formState.payload.cargo.deployable,
                deployCount: _getDeployCount(_formState.payload.cargo.deployable)
            };
            payloads.push('cargo');
        }

        // Nuclear payloads
        if (_formState.payload.nuclearWarhead.enabled) {
            platform.components.nuclear_warhead = {
                type: 'nuclear_device',
                yield_kt: _formState.payload.nuclearWarhead.yield_kt,
                burstType: _formState.payload.nuclearWarhead.burstType,
                trigger: _formState.payload.nuclearWarhead.trigger,
                emp: _formState.payload.nuclearWarhead.burstType === 'exoatmospheric' ||
                     _formState.payload.nuclearWarhead.burstType === 'high_altitude'
            };
            payloads.push('nuclear');
        }
        if (_formState.payload.nuclearCruiseMissile.enabled) {
            platform.components.nuclear_cruise = {
                type: 'nuclear_cruise_missile',
                yield_kt: _formState.payload.nuclearCruiseMissile.yield_kt,
                range_km: _formState.payload.nuclearCruiseMissile.range_km,
                burstType: _formState.payload.nuclearCruiseMissile.burstType,
                speed_mach: 0.85,
                terrain_following: true
            };
            payloads.push('cruise_nuke');
        }

        // Store payload list for reference
        if (payloads.length > 0) {
            platform._custom.activePayloads = payloads;
        }

        // Environment configuration (stored in platform for scenario-level settings)
        const env = _formState.environment;
        const hasEnvConfig = env.magneticField.enabled || env.ionosphere.enabled ||
                            env.radiationBelt.enabled || env.gravity.model !== 'earth' ||
                            env.atmosphere.model !== 'earth_standard';
        if (hasEnvConfig) {
            platform._custom.environment = {
                gravity: {
                    model: env.gravity.model,
                    mu: _getGravityMu(env.gravity.model, env.gravity.customMu)
                },
                atmosphere: {
                    model: env.atmosphere.model
                }
            };
            if (env.magneticField.enabled) {
                platform._custom.environment.magneticField = {
                    model: env.magneticField.model,
                    intensity: env.magneticField.intensity
                };
            }
            if (env.ionosphere.enabled) {
                platform._custom.environment.ionosphere = {
                    model: env.ionosphere.model,
                    disturbance: env.ionosphere.disturbance
                };
            }
            if (env.radiationBelt.enabled) {
                platform._custom.environment.radiationBelt = {
                    model: env.radiationBelt.model,
                    intensity: env.radiationBelt.intensity
                };
            }
        }

        return platform;
    }

    function _getGravityMu(model, customMu) {
        switch (model) {
            case 'earth': return 3.986004418e14;
            case 'moon': return 4.9048695e12;
            case 'mars': return 4.282837e13;
            case 'jupiter': return 1.26686534e17;
            case 'venus': return 3.24859e14;
            case 'custom': return customMu;
            default: return 3.986004418e14;
        }
    }

    function _getA2ALoadout(loadoutType) {
        switch (loadoutType) {
            case 'heavy':
                return [
                    { type: 'AIM-9X', count: 4, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 6, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ];
            case 'wvr_only':
                return [
                    { type: 'AIM-9X', count: 6, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 }
                ];
            default: // standard
                return [
                    { type: 'AIM-9X', count: 2, minRange: 500, maxRange: 18000, seekerFOV: 90, Pk: 0.85, speed: 900, flightTime: 20 },
                    { type: 'AIM-120C', count: 4, minRange: 2000, maxRange: 80000, seekerFOV: 360, Pk: 0.75, speed: 1200, flightTime: 40 }
                ];
        }
    }

    function _getDeployCount(deployableType) {
        switch (deployableType) {
            case 'cubesat': return 6;
            case 'drone': return 4;
            case 'sensor': return 2;
            case 'decoy_sat': return 3;
            default: return 1;
        }
    }

    function _generateDescription() {
        const parts = [];
        const mode = _formState.physics.mode;

        // Physics type
        if (mode === 'tle') parts.push('TLE orbit');
        else if (mode === 'coe') parts.push(`${_formState.physics.coe.sma_km.toFixed(0)}km orbit`);
        else parts.push(`${_formState.physics.atmospheric.config} flight`);

        // Propulsion
        const propModes = [];
        if (_formState.propulsion.air) propModes.push('air');
        if (_formState.propulsion.hypersonic) propModes.push('hyper');
        if (_formState.propulsion.rocket) propModes.push('rocket');
        if (_formState.propulsion.ion) propModes.push('ion');
        if (_formState.propulsion.rcs) propModes.push('rcs');
        if (propModes.length > 0) parts.push(propModes.join('/'));

        // Sensors
        const sensors = [];
        if (_formState.sensors.radar.enabled) sensors.push('radar');
        if (_formState.sensors.optical.enabled) sensors.push('EO');
        if (_formState.sensors.ir.enabled) sensors.push('IR');
        if (_formState.sensors.sar.enabled) sensors.push('SAR');
        if (_formState.sensors.sigint.enabled) sensors.push('SIGINT');
        if (_formState.sensors.lidar.enabled) sensors.push('LIDAR');
        if (sensors.length > 0) parts.push(sensors.join('/'));

        // Payloads
        const payloads = [];
        if (_formState.payload.a2aMissiles.enabled) payloads.push('A2A');
        if (_formState.payload.a2gMissiles.enabled) payloads.push('A2G');
        if (_formState.payload.kineticKill.enabled) payloads.push('KKV');
        if (_formState.payload.jammer.enabled) payloads.push('ECM');
        if (_formState.payload.decoys.enabled) payloads.push('CM');
        if (_formState.payload.spaceDebris.enabled) payloads.push('debris');
        if (_formState.payload.airDebris.enabled) payloads.push('wreckage');
        if (_formState.payload.cargo.enabled) payloads.push('deployer');
        if (_formState.payload.nuclearWarhead.enabled) payloads.push('☢NUKE');
        if (_formState.payload.nuclearCruiseMissile.enabled) payloads.push('☢ALCM');
        if (payloads.length > 0) parts.push(payloads.join('/'));

        // Environment
        const env = _formState.environment;
        const envParts = [];
        if (env.gravity.model !== 'earth') envParts.push(env.gravity.model);
        if (env.magneticField.enabled) envParts.push('B-field');
        if (env.ionosphere.enabled) envParts.push('iono');
        if (env.radiationBelt.enabled) envParts.push('rad');
        if (envParts.length > 0) parts.push('env:' + envParts.join('/'));

        return 'Custom: ' + parts.join(', ');
    }

    function _getTeamColor(team) {
        switch (team) {
            case 'blue': return '#4488ff';
            case 'red': return '#ff4444';
            case 'neutral': return '#ffaa00';
            default: return '#888888';
        }
    }

    // -------------------------------------------------------------------------
    // LocalStorage persistence
    // -------------------------------------------------------------------------
    function _loadFromStorage() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const platforms = JSON.parse(stored);
                platforms.forEach(p => {
                    // Add to DOM palette
                    _addToDOMPalette(p);

                    // Add to ObjectPalette (for lookups)
                    if (typeof ObjectPalette !== 'undefined' && ObjectPalette.addCustomTemplate) {
                        ObjectPalette.addCustomTemplate(p);
                    }
                });
                console.log('[PlatformBuilder] Loaded', platforms.length, 'custom platforms from storage');
            }
        } catch (e) {
            console.warn('[PlatformBuilder] Failed to load from storage:', e);
        }
    }

    function _saveToStorage(platform) {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const platforms = stored ? JSON.parse(stored) : [];
            platforms.push(platform);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(platforms));
        } catch (e) {
            console.warn('[PlatformBuilder] Failed to save to storage:', e);
        }
    }

    function _getAllCustomPlatforms() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }

    // -------------------------------------------------------------------------
    // Show / confirm / cancel
    // -------------------------------------------------------------------------
    function show() {
        return new Promise((resolve, reject) => {
            _resolvePromise = resolve;
            _rejectPromise = reject;

            // Reset form state
            _formState.name = 'Custom Platform';
            _activeTab = 'physics';

            _overlay.style.display = 'flex';
            _switchTab('physics');
            _attachEventListeners();
            _updateCOEComputed();
            _updatePropulsionAvailability();
            _updateDefaultModeOptions();

            document.getElementById('pb-name')?.focus();
        });
    }

    function _confirm() {
        // Validate
        if (!_formState.name.trim()) {
            alert('Please enter a platform name.');
            return;
        }

        if (_formState.physics.mode === 'tle') {
            if (!_formState.physics.tle.line1 || !_formState.physics.tle.line2) {
                alert('Please enter both TLE lines.');
                return;
            }
        }

        if (_formState.physics.mode === 'atmospheric') {
            const hasEngine = _formState.propulsion.air || _formState.propulsion.hypersonic ||
                              _formState.propulsion.rocket || _formState.propulsion.ion || _formState.propulsion.rcs;
            if (!hasEngine) {
                alert('Please select at least one propulsion mode for atmospheric flight.');
                return;
            }
        }

        const platform = _generatePlatformTemplate();

        // Add to DOM palette
        _addToDOMPalette(platform);

        // Add to ObjectPalette (for getTemplates/getTemplateByName)
        if (typeof ObjectPalette !== 'undefined' && ObjectPalette.addCustomTemplate) {
            ObjectPalette.addCustomTemplate(platform);
        }

        // Save to localStorage
        _saveToStorage(platform);

        _overlay.style.display = 'none';
        if (_resolvePromise) _resolvePromise(platform);
        _resolvePromise = null;
        _rejectPromise = null;
    }

    /**
     * Add a custom platform to the DOM palette.
     */
    function _addToDOMPalette(platform) {
        const section = document.getElementById('paletteCustom');
        const body = document.getElementById('paletteSectionCustom');
        if (!section || !body) return;

        // Show the Custom section
        section.style.display = 'block';

        // Create palette item
        const item = document.createElement('div');
        item.className = 'palette-item';
        item.setAttribute('data-entity-type', platform.type);
        item.setAttribute('data-custom-id', platform.id);
        item.setAttribute('data-team', platform.team);

        const dot = document.createElement('div');
        dot.className = 'palette-dot';
        dot.style.backgroundColor = platform.icon;
        item.appendChild(dot);

        const info = document.createElement('div');
        info.className = 'palette-item-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'palette-item-name';
        nameEl.innerHTML = platform.name + ' <span style="color:#4af;font-size:9px;">★</span>';
        info.appendChild(nameEl);

        const descEl = document.createElement('div');
        descEl.className = 'palette-item-desc';
        descEl.textContent = platform.description;
        info.appendChild(descEl);

        item.appendChild(info);

        // Click handler - start placement with this custom platform
        item.addEventListener('click', function() {
            // Remove selected from all items
            document.querySelectorAll('.palette-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            if (typeof BuilderApp !== 'undefined' && BuilderApp.startPlacement) {
                BuilderApp.startPlacement(platform);
            }
        });

        body.appendChild(item);
    }

    function _cancel() {
        _overlay.style.display = 'none';
        if (_rejectPromise) _rejectPromise(new Error('Cancelled'));
        _resolvePromise = null;
        _rejectPromise = null;
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------
    function _injectStyles() {
        if (document.getElementById('platform-builder-styles')) return;

        const style = document.createElement('style');
        style.id = 'platform-builder-styles';
        style.textContent = `
            .platform-builder-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            }
            .platform-builder-dialog {
                background: #1a1a2e;
                border: 1px solid #333;
                border-radius: 8px;
                width: 480px;
                max-height: 90vh;
                overflow-y: auto;
                color: #ddd;
                font-family: sans-serif;
                font-size: 13px;
            }
            .pb-header {
                background: #0f0f1a;
                padding: 12px 16px;
                font-size: 14px;
                font-weight: bold;
                letter-spacing: 1px;
                border-bottom: 1px solid #333;
            }
            .pb-meta {
                display: flex;
                gap: 12px;
                padding: 12px 16px;
                border-bottom: 1px solid #333;
                background: #141424;
            }
            .pb-field-group {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .pb-field-group label {
                color: #888;
                font-size: 11px;
            }
            .pb-field-group input[type="text"] {
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 4px 8px;
                border-radius: 3px;
                width: 140px;
            }
            .pb-field-group select {
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 4px 8px;
                border-radius: 3px;
            }
            .pb-icon-preview {
                display: inline-block;
                width: 16px;
                height: 16px;
                border-radius: 50%;
            }
            .pb-tab-bar {
                display: flex;
                background: #0f0f1a;
                border-bottom: 1px solid #333;
            }
            .pb-tab {
                flex: 1;
                padding: 10px 8px;
                text-align: center;
                font-size: 11px;
                font-weight: bold;
                cursor: pointer;
                color: #666;
                border-bottom: 2px solid transparent;
            }
            .pb-tab:hover {
                color: #aaa;
                background: #141424;
            }
            .pb-tab-active {
                color: #4af;
                border-bottom-color: #4af;
            }
            .pb-tab-contents {
                min-height: 280px;
            }
            .pb-tab-content {
                padding: 16px;
            }
            .pb-section-title {
                font-size: 11px;
                font-weight: bold;
                color: #4af;
                margin-bottom: 12px;
                text-transform: uppercase;
            }
            .pb-hint {
                color: #666;
                font-weight: normal;
                font-size: 10px;
            }
            .pb-radio-group {
                margin-bottom: 12px;
            }
            .pb-radio-item {
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                padding: 6px 0;
            }
            .pb-radio-item input[type="radio"] {
                accent-color: #4af;
            }
            .pb-sub-fields {
                margin-left: 24px;
                padding: 10px;
                background: #0f0f1a;
                border-radius: 4px;
                margin-top: 6px;
            }
            .pb-sub-fields input[type="text"],
            .pb-sub-fields input[type="number"] {
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 6px 8px;
                border-radius: 3px;
                width: 100%;
                margin-bottom: 6px;
                box-sizing: border-box;
            }
            .pb-sub-fields select {
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 6px 8px;
                border-radius: 3px;
                width: 100%;
            }
            .pb-coe-row {
                display: flex;
                gap: 10px;
                margin-bottom: 8px;
            }
            .pb-coe-field {
                flex: 1;
            }
            .pb-coe-field label {
                display: block;
                font-size: 10px;
                color: #888;
                margin-bottom: 3px;
            }
            .pb-coe-field input,
            .pb-coe-field select {
                width: 100%;
                box-sizing: border-box;
            }
            .pb-computed {
                font-size: 11px;
                color: #4f4;
                padding: 6px 0;
                text-align: center;
                border-top: 1px solid #333;
                margin-top: 6px;
            }
            .pb-checkbox-group {
                margin-bottom: 12px;
            }
            .pb-checkbox-item {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                padding: 8px 0;
                border-bottom: 1px solid #222;
            }
            .pb-checkbox-item input[type="checkbox"] {
                accent-color: #4af;
            }
            .pb-check-label {
                font-weight: bold;
                min-width: 140px;
            }
            .pb-check-desc {
                color: #666;
                font-size: 11px;
                flex: 1;
            }
            .pb-propulsion-note {
                background: #2a2a1a;
                border: 1px solid #553;
                padding: 8px 12px;
                border-radius: 4px;
                color: #aa8;
                font-size: 11px;
                margin-bottom: 12px;
            }
            .pb-default-mode {
                display: flex;
                align-items: center;
                gap: 10px;
                padding-top: 10px;
                border-top: 1px solid #333;
            }
            .pb-default-mode label {
                color: #888;
                font-size: 11px;
            }
            .pb-default-mode select {
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 4px 8px;
                border-radius: 3px;
            }
            .pb-sensor-group {
                margin-bottom: 12px;
            }
            .pb-payload-desc {
                display: block;
                color: #666;
                font-size: 11px;
                margin-left: 24px;
            }
            .pb-buttons {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
                padding: 12px 16px;
                border-top: 1px solid #333;
                background: #0f0f1a;
            }
            .pb-btn {
                padding: 8px 20px;
                border-radius: 4px;
                font-size: 12px;
                cursor: pointer;
                border: none;
            }
            .pb-btn-cancel {
                background: #333;
                color: #aaa;
            }
            .pb-btn-cancel:hover {
                background: #444;
            }
            .pb-btn-confirm {
                background: #2a6;
                color: #fff;
            }
            .pb-btn-confirm:hover {
                background: #3b7;
            }
            .pb-propulsion-hint {
                color: #666;
                font-size: 11px;
                margin-bottom: 12px;
                font-style: italic;
            }
            .pb-payload-section {
                margin-bottom: 16px;
            }
            .pb-payload-category {
                font-size: 10px;
                font-weight: bold;
                color: #888;
                text-transform: uppercase;
                letter-spacing: 1px;
                padding: 6px 0;
                border-bottom: 1px solid #333;
                margin-bottom: 8px;
            }
            .pb-nuclear-section {
                background: rgba(255, 120, 0, 0.05);
                border: 1px solid rgba(255, 120, 0, 0.2);
                border-radius: 4px;
                padding: 10px;
                margin-top: 10px;
            }
            .pb-nuke-note {
                font-size: 10px;
                color: #f80;
                margin-top: 8px;
                padding: 6px;
                background: rgba(255, 120, 0, 0.1);
                border-radius: 3px;
            }
            .pb-env-section {
                margin-bottom: 16px;
            }
            .pb-env-note {
                color: #666;
                font-size: 11px;
                margin-bottom: 16px;
                font-style: italic;
            }
            .pb-env-hint {
                font-size: 10px;
                color: #888;
                margin-top: 6px;
                font-style: italic;
            }
            .pb-env-config {
                margin-left: 24px;
                padding: 10px;
                background: #0f0f1a;
                border-radius: 4px;
                margin-top: 6px;
            }
        `;
        document.head.appendChild(style);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    return {
        init,
        show,
        getAllCustomPlatforms: _getAllCustomPlatforms
    };
})();
