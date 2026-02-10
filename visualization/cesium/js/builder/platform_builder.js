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
    let _editingId = null; // Non-null when editing an existing platform

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
            atmospheric: { config: 'f16', alt: 5000, speed: 200, heading: 90 },
            ground: { role: 'command_post' }
        },
        propulsion: {
            taxi: false,
            air: false,
            hypersonic: false,
            engines: [],     // selected engine names from ROCKET_ENGINES roster
            defaultMode: 'air'
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
            nuclearCruiseMissile: { enabled: false, yield_kt: 150, burstType: 'airburst', range_km: 2500 },
            // Cyber actor
            cyberActor: { enabled: false, role: 'all', stealthLevel: 0.6, attackDuration_s: 30, accessTime_s: 15 },
            // Firewall
            firewall: { enabled: false, rating: 0.7, ids: true }
        },
        // Comm data config
        commData: {
            enabled: false,
            missionData: true,
            heartbeat: true,
            heartbeatInterval_s: 5,
            missionDataRate_bps: 1000000,
            emcon: false,
            encrypted: false,
            encryptionType: 'AES256',
            encryptionOverhead: 0.15  // 15% bandwidth overhead
        },
        // Computer system (hackable)
        computer: {
            enabled: true,  // ON by default for all platforms
            os: 'mil_spec',
            hardening: 0.5,
            patchLevel: 0.5,
            firewallRating: 0.5
        },
        // Cyber configuration
        cyber: {
            hardening: 5,           // 0-10 scale, stored as 0-1 (divide by 10)
            patchLevel: 5,          // 0-10 scale, stored as 0-1
            firewallEnabled: false,
            firewallRating: 5,      // 0-10 scale, stored as 0-1
            ids: false,             // intrusion detection, only when firewall on
            encryption: 'none',     // none / AES-128 / AES-256
            aiRole: 'none',         // none / offensive / defensive / hybrid
            aggressiveness: 5,      // 0-10 scale, stored as 0-1
            stealthLevel: 5         // 0-10 scale, stored as 0-1
        },
        // RCS override (null = auto by entity type)
        rcs_m2: null,
        // Environment settings moved to global scenario level (EnvironmentDialog)
        model: {
            file: '',
            scale: 1.0,
            heading: 0,
            pitch: 0,
            roll: 0
        }
    };

    // Aircraft configs available for atmospheric mode
    const AIRCRAFT_CONFIGS = [
        { id: 'f16', name: 'F-16 Fighting Falcon' },
        { id: 'f15', name: 'F-15 Strike Eagle' },
        { id: 'f22', name: 'F-22 Raptor' },
        { id: 'f35', name: 'F-35A Lightning II' },
        { id: 'f18', name: 'F/A-18E Super Hornet' },
        { id: 'a10', name: 'A-10 Thunderbolt II' },
        { id: 'mig29', name: 'MiG-29 Fulcrum' },
        { id: 'su27', name: 'Su-27 Flanker' },
        { id: 'su35', name: 'Su-35S Flanker-E' },
        { id: 'su57', name: 'Su-57 Felon' },
        { id: 'spaceplane', name: 'X-37 Spaceplane' },
        { id: 'bomber', name: 'B-2 Spirit' },
        { id: 'bomber_fast', name: 'B-1B / Tu-160 Class' },
        { id: 'awacs', name: 'E-3 AWACS' },
        { id: 'transport', name: 'C-130 Hercules' },
        { id: 'c17', name: 'C-17 Globemaster III' },
        { id: 'drone_male', name: 'MQ-9 Reaper' },
        { id: 'drone_hale', name: 'RQ-4 Global Hawk' }
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
            { id: 'model', label: 'MODEL' },
            { id: 'propulsion', label: 'PROPULSION' },
            { id: 'sensors', label: 'SENSORS' },
            { id: 'payload', label: 'PAYLOAD' },
            { id: 'cyber', label: 'CYBER' }
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
        _tabContents.model = _createModelTab();
        _tabContents.propulsion = _createPropulsionTab();
        _tabContents.sensors = _createSensorsTab();
        _tabContents.payload = _createPayloadTab();
        _tabContents.cyber = _createCyberTab();
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

            <div class="pb-radio-group">
                <label class="pb-radio-item">
                    <input type="radio" name="physics-mode" value="ground" ${_formState.physics.mode === 'ground' ? 'checked' : ''} />
                    <span>Ground Station / Fixed</span>
                </label>
                <div class="pb-sub-fields pb-ground-fields" style="display: ${_formState.physics.mode === 'ground' ? 'block' : 'none'}">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Role</label>
                            <select id="pb-ground-role">
                                <option value="command_post" ${_formState.physics.ground.role === 'command_post' ? 'selected' : ''}>Command Post</option>
                                <option value="ground_station" ${_formState.physics.ground.role === 'ground_station' ? 'selected' : ''}>Ground Station</option>
                                <option value="radar_site" ${_formState.physics.ground.role === 'radar_site' ? 'selected' : ''}>Radar Site</option>
                                <option value="comm_relay" ${_formState.physics.ground.role === 'comm_relay' ? 'selected' : ''}>Comm Relay</option>
                                <option value="sam_site" ${_formState.physics.ground.role === 'sam_site' ? 'selected' : ''}>SAM Site</option>
                                <option value="cyber_ops" ${_formState.physics.ground.role === 'cyber_ops' ? 'selected' : ''}>Cyber Ops Center</option>
                                <option value="firewall" ${_formState.physics.ground.role === 'firewall' ? 'selected' : ''}>Network Firewall</option>
                                <option value="generic" ${_formState.physics.ground.role === 'generic' ? 'selected' : ''}>Generic</option>
                            </select>
                        </div>
                    </div>
                    <div class="pb-hint" style="margin-top:6px">Static entity placed on the ground. No physics simulation — position is fixed at click location.</div>
                </div>
            </div>

            <div class="pb-coe-row" style="margin-top:10px;border-top:1px solid #333;padding-top:8px">
                <div class="pb-coe-field">
                    <label>RCS Override (m²) <span class="pb-hint">blank = auto by type</span></label>
                    <input type="number" id="pb-rcs-override" value="${_formState.rcs_m2 || ''}" min="0.0001" max="100000" step="0.01" placeholder="auto" />
                </div>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Model Tab
    // -------------------------------------------------------------------------
    function _createModelTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        tab.innerHTML = `
            <div class="pb-section-title">3D MODEL</div>
            <div class="pb-hint">Select a .glb model file. Entity uses a point marker if no model is selected.</div>

            <div style="margin: 12px 0;">
                <select id="pb-model-file" class="pb-model-select">
                    <option value="">None (point marker only)</option>
                </select>
                <div id="pb-model-info" style="color:#666;font-size:11px;margin-top:6px;">Using point marker only.</div>
            </div>

            <div id="pb-model-orient-section" style="display:none;">
                <div class="pb-model-preview-wrap">
                    <div id="pb-model-preview-container" class="pb-model-preview-box">
                        <div id="pb-model-preview-placeholder" class="pb-model-placeholder">Select a model</div>
                    </div>
                    <div class="pb-model-axis-overlay" id="pb-model-axis-overlay">
                        <canvas id="pb-model-axes" width="80" height="80"></canvas>
                    </div>
                    <div class="pb-model-drag-hint">Drag to rotate &bull; Scroll to zoom</div>
                </div>

                <div class="pb-section-title" style="margin-top:12px;">ORIENTATION OFFSET</div>
                <div class="pb-hint">Orient the model so its nose points right (&rarr;). This aligns it with the velocity vector at runtime.</div>

                <div class="pb-model-controls-row">
                    <div class="pb-coe-field">
                        <label>Heading (°)</label>
                        <input type="number" id="pb-model-heading" value="0" step="5" />
                    </div>
                    <div class="pb-coe-field">
                        <label>Pitch (°)</label>
                        <input type="number" id="pb-model-pitch" value="0" step="5" />
                    </div>
                    <div class="pb-coe-field">
                        <label>Roll (°)</label>
                        <input type="number" id="pb-model-roll" value="0" step="5" />
                    </div>
                    <div class="pb-coe-field">
                        <label>Scale</label>
                        <input type="number" id="pb-model-scale" value="1.0" step="0.1" min="0.1" max="100" />
                    </div>
                </div>
                <button id="pb-model-reset" class="pb-btn pb-btn-cancel" style="margin-top:6px;width:100%;padding:6px;">Reset Orientation</button>
            </div>
        `;

        return tab;
    }

    function _loadModelList() {
        fetch('/api/models/list')
            .then(r => r.json())
            .then(data => {
                const select = document.getElementById('pb-model-file');
                if (!select || !data.models) return;
                // Clear existing options beyond the first "None" option
                while (select.options.length > 1) select.remove(1);
                data.models.forEach(m => {
                    if (m.size < 100) return; // Skip placeholder files
                    const opt = document.createElement('option');
                    opt.value = m.path;
                    var name = m.filename.replace('.glb', '').replace('.gltf', '');
                    var sizeStr = m.size > 1024 * 1024 ?
                        (m.size / 1024 / 1024).toFixed(1) + ' MB' :
                        (m.size / 1024).toFixed(0) + ' KB';
                    opt.textContent = name + ' (' + sizeStr + ')';
                    select.appendChild(opt);
                });
                // Restore selection if model was previously set
                if (_formState.model.file) {
                    select.value = _formState.model.file;
                }
            })
            .catch(() => {});
    }

    let _modelViewerEl = null;
    let _modelDragging = false;
    let _modelDragLastX = 0;
    let _modelDragLastY = 0;

    function _updateModelUI() {
        const orientSection = document.getElementById('pb-model-orient-section');
        const infoEl = document.getElementById('pb-model-info');
        const container = document.getElementById('pb-model-preview-container');
        const placeholder = document.getElementById('pb-model-preview-placeholder');

        if (_formState.model.file) {
            if (orientSection) orientSection.style.display = 'block';
            if (infoEl) infoEl.textContent = 'Model: ' + _formState.model.file;

            // Create or update <model-viewer>
            if (!_modelViewerEl) {
                _modelViewerEl = document.createElement('model-viewer');
                // No camera-controls or auto-rotate — we handle drag ourselves
                _modelViewerEl.setAttribute('shadow-intensity', '0.3');
                _modelViewerEl.setAttribute('environment-image', 'neutral');
                _modelViewerEl.setAttribute('interaction-prompt', 'none');
                _modelViewerEl.setAttribute('camera-orbit', '0deg 75deg 105%');
                _modelViewerEl.style.cssText = 'width:100%;height:100%;background:#0a0a14;border-radius:4px;--poster-color:#0a0a14;cursor:grab;';
                if (container) {
                    if (placeholder) placeholder.style.display = 'none';
                    container.appendChild(_modelViewerEl);
                }
                _wireModelDrag(_modelViewerEl);
            }
            _modelViewerEl.src = _formState.model.file;
            _updateModelOrientation();
            _drawModelAxes();
        } else {
            if (orientSection) orientSection.style.display = 'none';
            if (infoEl) infoEl.textContent = 'Using point marker only.';
            // Remove model-viewer
            if (_modelViewerEl && _modelViewerEl.parentNode) {
                _modelViewerEl.parentNode.removeChild(_modelViewerEl);
                _modelViewerEl = null;
            }
            if (placeholder) placeholder.style.display = 'flex';
        }
    }

    function _wireModelDrag(el) {
        // Pointer drag → heading/pitch rotation
        el.addEventListener('pointerdown', function(e) {
            _modelDragging = true;
            _modelDragLastX = e.clientX;
            _modelDragLastY = e.clientY;
            el.setPointerCapture(e.pointerId);
            el.style.cursor = 'grabbing';
            e.preventDefault();
        });

        el.addEventListener('pointermove', function(e) {
            if (!_modelDragging) return;
            var dx = e.clientX - _modelDragLastX;
            var dy = e.clientY - _modelDragLastY;
            _modelDragLastX = e.clientX;
            _modelDragLastY = e.clientY;

            // Horizontal drag → heading (Y-axis), vertical drag → pitch (X-axis)
            _formState.model.heading = ((_formState.model.heading || 0) + dx * 0.5) % 360;
            _formState.model.pitch = Math.max(-90, Math.min(90,
                (_formState.model.pitch || 0) - dy * 0.5));

            _updateModelOrientation();
            _drawModelAxes();
            _syncModelInputs();
        });

        el.addEventListener('pointerup', function() {
            _modelDragging = false;
            if (_modelViewerEl) _modelViewerEl.style.cursor = 'grab';
        });

        el.addEventListener('lostpointercapture', function() {
            _modelDragging = false;
            if (_modelViewerEl) _modelViewerEl.style.cursor = 'grab';
        });

        // Scroll wheel → zoom via camera-orbit radius
        el.addEventListener('wheel', function(e) {
            e.preventDefault();
            try {
                var orbit = el.getCameraOrbit();
                var factor = e.deltaY > 0 ? 1.15 : 0.87;
                var newR = orbit.radius * factor;
                el.cameraOrbit = orbit.theta + 'rad ' + orbit.phi + 'rad ' + newR + 'm';
            } catch (err) {
                // getCameraOrbit may not be available until model loads
            }
        }, { passive: false });
    }

    function _syncModelInputs() {
        var hEl = document.getElementById('pb-model-heading');
        var pEl = document.getElementById('pb-model-pitch');
        var rEl = document.getElementById('pb-model-roll');
        if (hEl) hEl.value = Math.round(_formState.model.heading || 0);
        if (pEl) pEl.value = Math.round(_formState.model.pitch || 0);
        if (rEl) rEl.value = Math.round(_formState.model.roll || 0);
    }

    function _updateModelOrientation() {
        if (!_modelViewerEl) return;
        var h = _formState.model.heading || 0;
        var p = _formState.model.pitch || 0;
        var r = _formState.model.roll || 0;
        // model-viewer orientation: "X Y Z" axes in degrees
        _modelViewerEl.setAttribute('orientation', p + 'deg ' + h + 'deg ' + r + 'deg');
        // Scale the model in the preview
        var s = _formState.model.scale || 1.0;
        _modelViewerEl.setAttribute('scale', s + ' ' + s + ' ' + s);
    }

    function _drawModelAxes() {
        // Fixed reference frame — these axes never rotate.
        // FWD = velocity direction at runtime.  Rotate the 3D model
        // until its nose visually aligns with the green FWD arrow.
        const canvas = document.getElementById('pb-model-axes');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const cx = w / 2, cy = h / 2;
        const len = w * 0.33;

        ctx.clearRect(0, 0, w, h);

        // Isometric projection (fixed viewpoint)
        function project(v) {
            var px = v[0] * 0.866 + v[1] * (-0.866);
            var py = -v[0] * 0.5 - v[1] * 0.5 + v[2] * 1.0;
            return [cx + px * len, cy - py * len];
        }

        // Static reference axes (never change)
        var axes = [
            { dir: [1, 0, 0], color: '#00ff00', label: 'FWD' },
            { dir: [0, 1, 0], color: '#ff4444', label: 'RIGHT' },
            { dir: [0, 0, 1], color: '#4488ff', label: 'UP' }
        ];

        var origin = project([0, 0, 0]);

        axes.forEach(function(axis) {
            var end = project(axis.dir);

            ctx.beginPath();
            ctx.strokeStyle = axis.color;
            ctx.lineWidth = 2.5;
            ctx.moveTo(origin[0], origin[1]);
            ctx.lineTo(end[0], end[1]);
            ctx.stroke();

            // Arrow head
            var adx = end[0] - origin[0], ady = end[1] - origin[1];
            var angle = Math.atan2(ady, adx);
            var arrowSize = Math.max(4, w * 0.06);
            ctx.beginPath();
            ctx.moveTo(end[0], end[1]);
            ctx.lineTo(end[0] - arrowSize * Math.cos(angle - 0.4), end[1] - arrowSize * Math.sin(angle - 0.4));
            ctx.moveTo(end[0], end[1]);
            ctx.lineTo(end[0] - arrowSize * Math.cos(angle + 0.4), end[1] - arrowSize * Math.sin(angle + 0.4));
            ctx.stroke();

            // Label
            ctx.fillStyle = axis.color;
            var fontSize = Math.max(8, Math.round(w * 0.11));
            ctx.font = 'bold ' + fontSize + 'px monospace';
            ctx.fillText(axis.label, end[0] + 3, end[1] - 3);
        });

        // Center dot
        ctx.beginPath();
        ctx.fillStyle = '#888';
        ctx.arc(origin[0], origin[1], 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // -------------------------------------------------------------------------
    // Propulsion Tab
    // -------------------------------------------------------------------------
    // Engine roster — matches ROCKET_ENGINES in live_sim_engine.js
    var PB_ENGINE_ROSTER = [
        { name: 'ION 0.5N',       thrust: '0.5 N',   cat: 'micro',  desc: 'Station Keeping' },
        { name: 'HALL 5N',        thrust: '5 N',     cat: 'micro',  desc: 'Hall Effect' },
        { name: 'Cold Gas 50N',   thrust: '50 N',    cat: 'micro',  desc: 'Attitude Jets' },
        { name: 'RCS 500N',       thrust: '500 N',   cat: 'micro',  desc: 'Reaction Control' },
        { name: 'PROP 2kN',       thrust: '2 kN',    cat: 'light',  desc: 'Propeller' },
        { name: 'TURBOPROP 15kN', thrust: '15 kN',   cat: 'light',  desc: 'Cargo Aircraft' },
        { name: 'OMS 25kN',       thrust: '25 kN',   cat: 'medium', desc: 'Orbital Maneuvering' },
        { name: 'AJ10 100kN',     thrust: '100 kN',  cat: 'medium', desc: 'Medium Rocket' },
        { name: '1G ACCEL 147kN', thrust: '147 kN',  cat: 'medium', desc: '1G Constant Accel' },
        { name: 'NERVA 350kN',    thrust: '350 kN',  cat: 'heavy',  desc: 'Nuclear Thermal' },
        { name: 'RL10 500kN',     thrust: '500 kN',  cat: 'heavy',  desc: 'Heavy Vacuum' },
        { name: 'Raptor 2.2MN',   thrust: '2.2 MN',  cat: 'heavy',  desc: 'Methalox' },
        { name: 'RS25 5MN',       thrust: '5 MN',    cat: 'heavy',  desc: 'Launch Engine' },
        { name: 'TORCH 50MN',     thrust: '50 MN',   cat: 'heavy',  desc: '1 AU/day Class' },
    ];

    function _createPropulsionTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        var selectedEngines = _formState.propulsion.engines || [];

        // Build engine grid HTML grouped by category
        var categories = [
            { id: 'micro',  label: 'MICRO THRUSTERS' },
            { id: 'light',  label: 'PROP / LIGHT' },
            { id: 'medium', label: 'MEDIUM ROCKETS' },
            { id: 'heavy',  label: 'HEAVY / EXOTIC' },
        ];

        var engineGridHTML = '';
        categories.forEach(function(cat) {
            var engines = PB_ENGINE_ROSTER.filter(function(e) { return e.cat === cat.id; });
            engineGridHTML += '<div class="pb-engine-cat">' + cat.label + '</div>';
            engineGridHTML += '<div class="pb-engine-grid">';
            engines.forEach(function(eng) {
                var checked = selectedEngines.indexOf(eng.name) >= 0 ? 'checked' : '';
                var safeId = 'pb-eng-' + eng.name.replace(/[^a-zA-Z0-9]/g, '_');
                engineGridHTML += '<label class="pb-engine-item" title="' + eng.desc + '">' +
                    '<input type="checkbox" data-engine="' + eng.name + '" class="pb-engine-check" ' + checked + '/>' +
                    '<span class="pb-eng-name">' + eng.name + '</span>' +
                    '<span class="pb-eng-desc">' + eng.desc + '</span>' +
                    '</label>';
            });
            engineGridHTML += '</div>';
        });

        tab.innerHTML = `
            <div class="pb-section-title">PROPULSION <span class="pb-hint">(P key opens engine selection panel)</span></div>

            <div class="pb-checkbox-group" style="margin-bottom:8px">
                <div class="pb-engine-cat">ATMOSPHERIC MODES</div>
                <div class="pb-engine-grid">
                    <label class="pb-engine-item" title="10 kN ground taxi">
                        <input type="checkbox" id="pb-prop-taxi" ${_formState.propulsion.taxi ? 'checked' : ''} />
                        <span class="pb-eng-name">TAXI 10kN</span>
                        <span class="pb-eng-desc">Ground Ops</span>
                    </label>
                    <label class="pb-engine-item" title="Turbofan with density lapse">
                        <input type="checkbox" id="pb-prop-air" ${_formState.propulsion.air ? 'checked' : ''} />
                        <span class="pb-eng-name">AIR 79-130kN</span>
                        <span class="pb-eng-desc">Turbofan</span>
                    </label>
                    <label class="pb-engine-item" title="Scramjet, Mach 2-10">
                        <input type="checkbox" id="pb-prop-hypersonic" ${_formState.propulsion.hypersonic ? 'checked' : ''} />
                        <span class="pb-eng-name">HYPER 800kN</span>
                        <span class="pb-eng-desc">Scramjet</span>
                    </label>
                </div>
            </div>

            <div class="pb-checkbox-group" id="pb-engine-roster">
                ${engineGridHTML}
            </div>

            <div style="margin-top:8px;display:flex;gap:6px;justify-content:space-between;align-items:center">
                <button id="pb-prop-all-domain" class="pb-small-btn" style="background:rgba(0,60,120,0.5);border-color:#4488ff;color:#44aaff;flex:1;padding:6px 12px;font-size:11px;letter-spacing:1px">SELECT ALL DOMAIN</button>
                <div style="display:flex;gap:4px">
                    <button id="pb-eng-all" class="pb-small-btn">All Engines</button>
                    <button id="pb-eng-none" class="pb-small-btn">None</button>
                </div>
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

            <div class="pb-payload-section" style="margin-top:12px;background:rgba(0,255,200,0.05);border:1px solid rgba(0,255,200,0.2);border-radius:4px;padding:10px">
                <div class="pb-payload-category" style="color: #0fc;">Cyber</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-cyber" ${_formState.payload.cyberActor.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Cyber Actor</span>
                        <span class="pb-check-desc">Offensive/defensive cyber warfare capabilities</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="cyber" style="display: ${_formState.payload.cyberActor.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Cyber Role</label>
                                <select id="pb-cyber-role">
                                    <option value="offense" ${_formState.payload.cyberActor.role === 'offense' ? 'selected' : ''}>Offensive Only</option>
                                    <option value="defense" ${_formState.payload.cyberActor.role === 'defense' ? 'selected' : ''}>Defensive Only</option>
                                    <option value="all" ${_formState.payload.cyberActor.role === 'all' ? 'selected' : ''}>Full Spectrum (All)</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Stealth Level</label>
                                <input type="number" id="pb-cyber-stealth" value="${_formState.payload.cyberActor.stealthLevel}" min="0" max="1" step="0.1" />
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Attack Duration (s)</label>
                                <input type="number" id="pb-cyber-duration" value="${_formState.payload.cyberActor.attackDuration_s}" min="5" max="300" step="5" />
                            </div>
                            <div class="pb-coe-field">
                                <label>Access Time (s)</label>
                                <input type="number" id="pb-cyber-access" value="${_formState.payload.cyberActor.accessTime_s}" min="5" max="120" step="5" />
                            </div>
                        </div>
                        <div class="pb-hint">Offense: exploit, brick, ddos, mitm, inject. Defense: patch, harden, firewall, alert.</div>
                    </div>
                </div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-payload-firewall" ${_formState.payload.firewall.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Network Firewall</span>
                        <span class="pb-check-desc">Must be defeated before network traffic passes through</span>
                    </label>
                    <div class="pb-sub-fields pb-payload-config" data-payload="firewall" style="display: ${_formState.payload.firewall.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Firewall Rating</label>
                                <input type="number" id="pb-firewall-rating" value="${_formState.payload.firewall.rating}" min="0.1" max="1.0" step="0.1" />
                            </div>
                            <div class="pb-coe-field">
                                <label>IDS (Intrusion Detection)</label>
                                <select id="pb-firewall-ids">
                                    <option value="true" ${_formState.payload.firewall.ids ? 'selected' : ''}>Enabled</option>
                                    <option value="false" ${!_formState.payload.firewall.ids ? 'selected' : ''}>Disabled</option>
                                </select>
                            </div>
                        </div>
                        <div class="pb-hint">Firewall nodes sit on a network and filter traffic. Cyber actors must defeat the firewall to reach nodes behind it.</div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section" style="margin-top:12px;background:rgba(68,170,255,0.05);border:1px solid rgba(68,170,255,0.2);border-radius:4px;padding:10px">
                <div class="pb-payload-category" style="color: #4af;">Comm Data</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-commdata-enabled" ${_formState.commData.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Comm Datalink</span>
                        <span class="pb-check-desc">Configure data packets this platform sends/receives</span>
                    </label>
                    <div class="pb-sub-fields pb-commdata-fields" style="display: ${_formState.commData.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label style="display:flex;align-items:center;gap:6px">
                                    <input type="checkbox" id="pb-commdata-mission" ${_formState.commData.missionData ? 'checked' : ''} style="accent-color:#4af" />
                                    Mission Data
                                </label>
                                <div class="pb-hint">Sensor tracks, targeting data, situational awareness</div>
                            </div>
                            <div class="pb-coe-field">
                                <label>Data Rate (Mbps)</label>
                                <input type="number" id="pb-commdata-rate" value="${_formState.commData.missionDataRate_bps / 1000000}" min="0.01" max="1000" step="0.1" />
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label style="display:flex;align-items:center;gap:6px">
                                    <input type="checkbox" id="pb-commdata-heartbeat" ${_formState.commData.heartbeat ? 'checked' : ''} style="accent-color:#0f8" />
                                    Heartbeat
                                </label>
                                <div class="pb-hint">Continuous pulses to verify comm flow. Stops in EMCON.</div>
                            </div>
                            <div class="pb-coe-field">
                                <label>HB Interval (s)</label>
                                <input type="number" id="pb-commdata-hb-interval" value="${_formState.commData.heartbeatInterval_s}" min="1" max="60" step="1" />
                            </div>
                        </div>
                        <div class="pb-coe-row" style="border-top:1px solid #333;padding-top:8px;margin-top:4px">
                            <div class="pb-coe-field">
                                <label style="display:flex;align-items:center;gap:6px">
                                    <input type="checkbox" id="pb-commdata-encrypted" ${_formState.commData.encrypted ? 'checked' : ''} style="accent-color:#f80" />
                                    Encrypted
                                </label>
                                <div class="pb-hint">Adds ~15% bandwidth overhead, requires key exchange</div>
                            </div>
                            <div class="pb-coe-field pb-encryption-type" style="display:${_formState.commData.encrypted ? 'block' : 'none'}">
                                <label>Encryption Type</label>
                                <select id="pb-commdata-enc-type">
                                    <option value="AES128" ${_formState.commData.encryptionType === 'AES128' ? 'selected' : ''}>AES-128</option>
                                    <option value="AES256" ${_formState.commData.encryptionType === 'AES256' ? 'selected' : ''}>AES-256</option>
                                    <option value="Type1" ${_formState.commData.encryptionType === 'Type1' ? 'selected' : ''}>Type 1 (NSA)</option>
                                </select>
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label style="display:flex;align-items:center;gap:6px">
                                    <input type="checkbox" id="pb-commdata-emcon" ${_formState.commData.emcon ? 'checked' : ''} style="accent-color:#f44" />
                                    EMCON (Emissions Control)
                                </label>
                                <div class="pb-hint">Radio silence — no heartbeat or mission data transmitted</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section" style="margin-top:12px;background:rgba(255,255,68,0.05);border:1px solid rgba(255,255,68,0.15);border-radius:4px;padding:10px">
                <div class="pb-payload-category" style="color: #ff8;">Computer System</div>

                <div class="pb-sensor-group">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-computer-enabled" ${_formState.computer.enabled ? 'checked' : ''} />
                        <span class="pb-check-label">Onboard Computer</span>
                        <span class="pb-check-desc">Hackable — controls sensors, weapons, navigation</span>
                    </label>
                    <div class="pb-sub-fields pb-computer-fields" style="display: ${_formState.computer.enabled ? 'block' : 'none'}">
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Operating System</label>
                                <select id="pb-computer-os">
                                    <option value="mil_spec" ${_formState.computer.os === 'mil_spec' ? 'selected' : ''}>Mil-Spec RTOS</option>
                                    <option value="linux_hardened" ${_formState.computer.os === 'linux_hardened' ? 'selected' : ''}>Hardened Linux</option>
                                    <option value="vxworks" ${_formState.computer.os === 'vxworks' ? 'selected' : ''}>VxWorks</option>
                                    <option value="windows_embedded" ${_formState.computer.os === 'windows_embedded' ? 'selected' : ''}>Windows Embedded</option>
                                    <option value="custom" ${_formState.computer.os === 'custom' ? 'selected' : ''}>Custom / Proprietary</option>
                                </select>
                            </div>
                            <div class="pb-coe-field">
                                <label>Hardening (0-1)</label>
                                <input type="number" id="pb-computer-hardening" value="${_formState.computer.hardening}" min="0" max="1" step="0.1" />
                            </div>
                        </div>
                        <div class="pb-coe-row">
                            <div class="pb-coe-field">
                                <label>Patch Level (0-1)</label>
                                <input type="number" id="pb-computer-patch" value="${_formState.computer.patchLevel}" min="0" max="1" step="0.1" />
                            </div>
                            <div class="pb-coe-field">
                                <label>Firewall Rating (0-1)</label>
                                <input type="number" id="pb-computer-firewall" value="${_formState.computer.firewallRating}" min="0" max="1" step="0.1" />
                            </div>
                        </div>
                        <div class="pb-hint">When hacked, attacker can: disable sensors, redirect weapons, alter navigation, exfiltrate data, or take full control.</div>
                    </div>
                </div>
            </div>
        `;

        return tab;
    }

    // -------------------------------------------------------------------------
    // Cyber Tab
    // -------------------------------------------------------------------------
    function _createCyberTab() {
        const tab = document.createElement('div');
        tab.className = 'pb-tab-content';

        const cy = _formState.cyber;
        const showAiFields = cy.aiRole !== 'none';
        const showIdsField = cy.firewallEnabled;

        tab.innerHTML = `
            <div class="pb-section-title" style="color:#0fc;">CYBER CONFIGURATION</div>

            <div class="pb-payload-section" style="background:rgba(0,255,200,0.05);border:1px solid rgba(0,255,200,0.2);border-radius:4px;padding:10px">
                <div class="pb-payload-category" style="color: #0fc;">Defensive Posture</div>

                <div class="pb-cyber-slider-group">
                    <div class="pb-cyber-slider-row">
                        <label class="pb-cyber-slider-label">Computer Hardening</label>
                        <input type="range" id="pb-cyber-hardening" class="pb-range-slider" min="0" max="10" step="1" value="${cy.hardening}" />
                        <span class="pb-cyber-slider-value" id="pb-cyber-hardening-val">${cy.hardening}</span>
                    </div>
                    <div class="pb-hint" style="margin-left:0">OS-level hardening, attack surface reduction (0 = unpatched COTS, 10 = NSA-hardened RTOS)</div>
                </div>

                <div class="pb-cyber-slider-group">
                    <div class="pb-cyber-slider-row">
                        <label class="pb-cyber-slider-label">Patch Level</label>
                        <input type="range" id="pb-cyber-patchlevel" class="pb-range-slider" min="0" max="10" step="1" value="${cy.patchLevel}" />
                        <span class="pb-cyber-slider-value" id="pb-cyber-patchlevel-val">${cy.patchLevel}</span>
                    </div>
                    <div class="pb-hint" style="margin-left:0">Software update currency (0 = years behind, 10 = zero-day patched)</div>
                </div>

                <div class="pb-sensor-group" style="margin-top:12px">
                    <label class="pb-checkbox-item">
                        <input type="checkbox" id="pb-cyber-firewall-enabled" ${cy.firewallEnabled ? 'checked' : ''} />
                        <span class="pb-check-label">Firewall</span>
                        <span class="pb-check-desc">Network perimeter defense, packet filtering</span>
                    </label>
                    <div class="pb-sub-fields pb-cyber-firewall-fields" style="display: ${cy.firewallEnabled ? 'block' : 'none'}">
                        <div class="pb-cyber-slider-group">
                            <div class="pb-cyber-slider-row">
                                <label class="pb-cyber-slider-label">Firewall Rating</label>
                                <input type="range" id="pb-cyber-firewall-rating" class="pb-range-slider" min="0" max="10" step="1" value="${cy.firewallRating}" />
                                <span class="pb-cyber-slider-value" id="pb-cyber-firewall-rating-val">${cy.firewallRating}</span>
                            </div>
                            <div class="pb-hint" style="margin-left:0">Filter effectiveness (0 = basic ACL, 10 = next-gen deep packet inspection)</div>
                        </div>

                        <div class="pb-cyber-ids-row" style="margin-top:8px">
                            <label class="pb-checkbox-item" style="border-bottom:none;padding:4px 0">
                                <input type="checkbox" id="pb-cyber-ids" ${cy.ids ? 'checked' : ''} />
                                <span class="pb-check-label">IDS (Intrusion Detection System)</span>
                                <span class="pb-check-desc">Alerts on anomalous traffic patterns</span>
                            </label>
                        </div>
                    </div>
                </div>

                <div class="pb-sensor-group" style="margin-top:8px">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Encryption</label>
                            <select id="pb-cyber-encryption">
                                <option value="none" ${cy.encryption === 'none' ? 'selected' : ''}>None</option>
                                <option value="AES-128" ${cy.encryption === 'AES-128' ? 'selected' : ''}>AES-128</option>
                                <option value="AES-256" ${cy.encryption === 'AES-256' ? 'selected' : ''}>AES-256</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>

            <div class="pb-payload-section" style="margin-top:12px;background:rgba(255,80,80,0.05);border:1px solid rgba(255,80,80,0.2);border-radius:4px;padding:10px">
                <div class="pb-payload-category" style="color: #f66;">Cyber AI</div>

                <div class="pb-sensor-group">
                    <div class="pb-coe-row">
                        <div class="pb-coe-field">
                            <label>Cyber AI Role</label>
                            <select id="pb-cyber-ai-role">
                                <option value="none" ${cy.aiRole === 'none' ? 'selected' : ''}>None</option>
                                <option value="offensive" ${cy.aiRole === 'offensive' ? 'selected' : ''}>Offensive</option>
                                <option value="defensive" ${cy.aiRole === 'defensive' ? 'selected' : ''}>Defensive</option>
                                <option value="hybrid" ${cy.aiRole === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                            </select>
                        </div>
                    </div>
                    <div class="pb-hint" style="margin-bottom:8px">Offensive: exploit/brick/ddos. Defensive: monitor/patch/isolate. Hybrid: both capabilities.</div>
                </div>

                <div class="pb-cyber-ai-fields" style="display: ${showAiFields ? 'block' : 'none'}">
                    <div class="pb-cyber-slider-group">
                        <div class="pb-cyber-slider-row">
                            <label class="pb-cyber-slider-label">Aggressiveness</label>
                            <input type="range" id="pb-cyber-aggressiveness" class="pb-range-slider pb-range-red" min="0" max="10" step="1" value="${cy.aggressiveness}" />
                            <span class="pb-cyber-slider-value" id="pb-cyber-aggressiveness-val">${cy.aggressiveness}</span>
                        </div>
                        <div class="pb-hint" style="margin-left:0">Attack tempo (0 = passive recon only, 10 = immediate full exploitation)</div>
                    </div>

                    <div class="pb-cyber-slider-group">
                        <div class="pb-cyber-slider-row">
                            <label class="pb-cyber-slider-label">Stealth Level</label>
                            <input type="range" id="pb-cyber-stealth-level" class="pb-range-slider pb-range-purple" min="0" max="10" step="1" value="${cy.stealthLevel}" />
                            <span class="pb-cyber-slider-value" id="pb-cyber-stealth-level-val">${cy.stealthLevel}</span>
                        </div>
                        <div class="pb-hint" style="margin-left:0">Operational security (0 = noisy/fast, 10 = APT-level persistence)</div>
                    </div>

                    <div class="pb-hint" id="pb-cyber-ai-summary" style="margin-top:8px;padding:6px;background:rgba(0,255,200,0.08);border-radius:3px;color:#0fc"></div>
                </div>
            </div>
        `;

        return tab;
    }

    function _updateCyberAiSummary() {
        var summary = document.getElementById('pb-cyber-ai-summary');
        if (!summary) return;
        var role = _formState.cyber.aiRole;
        if (role === 'none') { summary.textContent = ''; return; }

        var aggr = _formState.cyber.aggressiveness;
        var stealth = _formState.cyber.stealthLevel;
        var desc = '';
        if (role === 'offensive') {
            desc = 'Offensive cyber ops: exploit, brick, DDoS, MITM, inject. ';
            desc += aggr >= 7 ? 'High tempo attacks.' : aggr >= 4 ? 'Moderate engagement.' : 'Cautious probing.';
        } else if (role === 'defensive') {
            desc = 'Defensive cyber ops: monitor, patch, isolate, alert. ';
            desc += 'Prefers disrupting enemy comms. ';
            desc += stealth >= 7 ? 'Covert counter-ops.' : 'Active defense posture.';
        } else if (role === 'hybrid') {
            desc = 'Full-spectrum cyber: offense + defense. ';
            desc += aggr >= 7 ? 'Aggressive hybrid warfare.' : 'Balanced cyber posture.';
        }
        summary.textContent = desc;
    }

    // -------------------------------------------------------------------------
    // Environment tab removed — settings moved to global EnvironmentDialog

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

        // Ground role
        document.getElementById('pb-ground-role')?.addEventListener('change', e => {
            _formState.physics.ground.role = e.target.value;
        });

        // Model tab
        document.getElementById('pb-model-file')?.addEventListener('change', e => {
            _formState.model.file = e.target.value;
            _updateModelUI();
        });
        _loadModelList();

        ['heading', 'pitch', 'roll', 'scale'].forEach(field => {
            const el = document.getElementById('pb-model-' + field);
            if (el) {
                el.addEventListener('input', e => {
                    _formState.model[field] = parseFloat(e.target.value) || (field === 'scale' ? 1.0 : 0);
                    _updateModelOrientation();
                    _drawModelAxes();
                });
            }
        });

        document.getElementById('pb-model-reset')?.addEventListener('click', () => {
            _formState.model.heading = 0;
            _formState.model.pitch = 0;
            _formState.model.roll = 0;
            _formState.model.scale = 1.0;
            ['heading', 'pitch', 'roll'].forEach(f => {
                const el = document.getElementById('pb-model-' + f);
                if (el) el.value = '0';
            });
            const scaleEl = document.getElementById('pb-model-scale');
            if (scaleEl) scaleEl.value = '1.0';
            _updateModelOrientation();
            _drawModelAxes();
        });

        // Propulsion: atmospheric mode checkboxes
        ['taxi', 'air', 'hypersonic'].forEach(mode => {
            document.getElementById(`pb-prop-${mode}`)?.addEventListener('change', e => {
                _formState.propulsion[mode] = e.target.checked;
            });
        });

        // Propulsion: individual engine checkboxes
        document.querySelectorAll('.pb-engine-check').forEach(cb => {
            cb.addEventListener('change', e => {
                var engName = e.target.getAttribute('data-engine');
                var engines = _formState.propulsion.engines;
                if (e.target.checked) {
                    if (engines.indexOf(engName) < 0) engines.push(engName);
                } else {
                    var idx = engines.indexOf(engName);
                    if (idx >= 0) engines.splice(idx, 1);
                }
            });
        });

        // All / None buttons
        document.getElementById('pb-prop-all-domain')?.addEventListener('click', () => {
            // Check all atmospheric modes
            _formState.propulsion.taxi = true;
            _formState.propulsion.air = true;
            _formState.propulsion.hypersonic = true;
            ['taxi', 'air', 'hypersonic'].forEach(mode => {
                var cb = document.getElementById('pb-prop-' + mode);
                if (cb) cb.checked = true;
            });
            // Check all engines
            _formState.propulsion.engines = PB_ENGINE_ROSTER.map(e => e.name);
            document.querySelectorAll('.pb-engine-check').forEach(cb => { cb.checked = true; });
        });
        document.getElementById('pb-eng-all')?.addEventListener('click', () => {
            _formState.propulsion.engines = PB_ENGINE_ROSTER.map(e => e.name);
            document.querySelectorAll('.pb-engine-check').forEach(cb => { cb.checked = true; });
        });
        document.getElementById('pb-eng-none')?.addEventListener('click', () => {
            _formState.propulsion.engines = [];
            document.querySelectorAll('.pb-engine-check').forEach(cb => { cb.checked = false; });
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

        // Cyber Actor payload
        document.getElementById('pb-payload-cyber')?.addEventListener('change', e => {
            _formState.payload.cyberActor.enabled = e.target.checked;
            const config = document.querySelector('.pb-payload-config[data-payload="cyber"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-cyber-role')?.addEventListener('change', e => {
            _formState.payload.cyberActor.role = e.target.value;
        });
        document.getElementById('pb-cyber-stealth')?.addEventListener('input', e => {
            _formState.payload.cyberActor.stealthLevel = parseFloat(e.target.value) || 0.6;
        });
        document.getElementById('pb-cyber-duration')?.addEventListener('input', e => {
            _formState.payload.cyberActor.attackDuration_s = parseInt(e.target.value) || 30;
        });
        document.getElementById('pb-cyber-access')?.addEventListener('input', e => {
            _formState.payload.cyberActor.accessTime_s = parseInt(e.target.value) || 15;
        });

        // Firewall payload
        document.getElementById('pb-payload-firewall')?.addEventListener('change', e => {
            _formState.payload.firewall.enabled = e.target.checked;
            const config = document.querySelector('.pb-payload-config[data-payload="firewall"]');
            if (config) config.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-firewall-rating')?.addEventListener('input', e => {
            _formState.payload.firewall.rating = parseFloat(e.target.value) || 0.7;
        });
        document.getElementById('pb-firewall-ids')?.addEventListener('change', e => {
            _formState.payload.firewall.ids = e.target.value === 'true';
        });

        // Comm Data section
        document.getElementById('pb-commdata-enabled')?.addEventListener('change', e => {
            _formState.commData.enabled = e.target.checked;
            var fields = document.querySelector('.pb-commdata-fields');
            if (fields) fields.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-commdata-mission')?.addEventListener('change', e => {
            _formState.commData.missionData = e.target.checked;
        });
        document.getElementById('pb-commdata-heartbeat')?.addEventListener('change', e => {
            _formState.commData.heartbeat = e.target.checked;
        });
        document.getElementById('pb-commdata-rate')?.addEventListener('input', e => {
            _formState.commData.missionDataRate_bps = (parseFloat(e.target.value) || 1) * 1000000;
        });
        document.getElementById('pb-commdata-hb-interval')?.addEventListener('input', e => {
            _formState.commData.heartbeatInterval_s = parseInt(e.target.value) || 5;
        });
        document.getElementById('pb-commdata-encrypted')?.addEventListener('change', e => {
            _formState.commData.encrypted = e.target.checked;
            var encType = document.querySelector('.pb-encryption-type');
            if (encType) encType.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-commdata-enc-type')?.addEventListener('change', e => {
            _formState.commData.encryptionType = e.target.value;
        });
        document.getElementById('pb-commdata-emcon')?.addEventListener('change', e => {
            _formState.commData.emcon = e.target.checked;
        });

        // Computer system
        document.getElementById('pb-computer-enabled')?.addEventListener('change', e => {
            _formState.computer.enabled = e.target.checked;
            var fields = document.querySelector('.pb-computer-fields');
            if (fields) fields.style.display = e.target.checked ? 'block' : 'none';
        });
        document.getElementById('pb-computer-os')?.addEventListener('change', e => {
            _formState.computer.os = e.target.value;
        });
        document.getElementById('pb-computer-hardening')?.addEventListener('input', e => {
            _formState.computer.hardening = parseFloat(e.target.value) || 0.5;
        });
        document.getElementById('pb-computer-patch')?.addEventListener('input', e => {
            _formState.computer.patchLevel = parseFloat(e.target.value) || 0.5;
        });
        document.getElementById('pb-computer-firewall')?.addEventListener('input', e => {
            _formState.computer.firewallRating = parseFloat(e.target.value) || 0.5;
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

        // Environment settings moved to global EnvironmentDialog

        // Cyber tab
        document.getElementById('pb-cyber-hardening')?.addEventListener('input', e => {
            _formState.cyber.hardening = parseInt(e.target.value) || 0;
            var valEl = document.getElementById('pb-cyber-hardening-val');
            if (valEl) valEl.textContent = _formState.cyber.hardening;
        });
        document.getElementById('pb-cyber-patchlevel')?.addEventListener('input', e => {
            _formState.cyber.patchLevel = parseInt(e.target.value) || 0;
            var valEl = document.getElementById('pb-cyber-patchlevel-val');
            if (valEl) valEl.textContent = _formState.cyber.patchLevel;
        });
        document.getElementById('pb-cyber-firewall-enabled')?.addEventListener('change', e => {
            _formState.cyber.firewallEnabled = e.target.checked;
            var fields = document.querySelector('.pb-cyber-firewall-fields');
            if (fields) fields.style.display = e.target.checked ? 'block' : 'none';
            // IDS is only available when firewall is on
            if (!e.target.checked) {
                _formState.cyber.ids = false;
                var idsCb = document.getElementById('pb-cyber-ids');
                if (idsCb) idsCb.checked = false;
            }
        });
        document.getElementById('pb-cyber-firewall-rating')?.addEventListener('input', e => {
            _formState.cyber.firewallRating = parseInt(e.target.value) || 0;
            var valEl = document.getElementById('pb-cyber-firewall-rating-val');
            if (valEl) valEl.textContent = _formState.cyber.firewallRating;
        });
        document.getElementById('pb-cyber-ids')?.addEventListener('change', e => {
            _formState.cyber.ids = e.target.checked;
        });
        document.getElementById('pb-cyber-encryption')?.addEventListener('change', e => {
            _formState.cyber.encryption = e.target.value;
        });
        document.getElementById('pb-cyber-ai-role')?.addEventListener('change', e => {
            _formState.cyber.aiRole = e.target.value;
            var aiFields = document.querySelector('.pb-cyber-ai-fields');
            if (aiFields) aiFields.style.display = e.target.value !== 'none' ? 'block' : 'none';
            // Set role-specific defaults
            if (e.target.value === 'defensive') {
                _formState.cyber.aggressiveness = 3;
                _formState.cyber.stealthLevel = 7;
            } else if (e.target.value === 'offensive') {
                _formState.cyber.aggressiveness = 7;
                _formState.cyber.stealthLevel = 5;
            } else if (e.target.value === 'hybrid') {
                _formState.cyber.aggressiveness = 5;
                _formState.cyber.stealthLevel = 5;
            }
            // Sync slider positions and value labels
            var aggrSlider = document.getElementById('pb-cyber-aggressiveness');
            var stealthSlider = document.getElementById('pb-cyber-stealth-level');
            if (aggrSlider) { aggrSlider.value = _formState.cyber.aggressiveness; }
            if (stealthSlider) { stealthSlider.value = _formState.cyber.stealthLevel; }
            var aggrVal = document.getElementById('pb-cyber-aggressiveness-val');
            var stealthVal = document.getElementById('pb-cyber-stealth-level-val');
            if (aggrVal) aggrVal.textContent = _formState.cyber.aggressiveness;
            if (stealthVal) stealthVal.textContent = _formState.cyber.stealthLevel;
            _updateCyberAiSummary();
        });
        document.getElementById('pb-cyber-aggressiveness')?.addEventListener('input', e => {
            _formState.cyber.aggressiveness = parseInt(e.target.value) || 0;
            var valEl = document.getElementById('pb-cyber-aggressiveness-val');
            if (valEl) valEl.textContent = _formState.cyber.aggressiveness;
            _updateCyberAiSummary();
        });
        document.getElementById('pb-cyber-stealth-level')?.addEventListener('input', e => {
            _formState.cyber.stealthLevel = parseInt(e.target.value) || 0;
            var valEl = document.getElementById('pb-cyber-stealth-level-val');
            if (valEl) valEl.textContent = _formState.cyber.stealthLevel;
            _updateCyberAiSummary();
        });
    }

    function _updatePhysicsVisibility() {
        const mode = _formState.physics.mode;
        document.querySelector('.pb-tle-fields').style.display = mode === 'tle' ? 'block' : 'none';
        document.querySelector('.pb-coe-fields').style.display = mode === 'coe' ? 'block' : 'none';
        document.querySelector('.pb-atmo-fields').style.display = mode === 'atmospheric' ? 'block' : 'none';
        var groundFields = document.querySelector('.pb-ground-fields');
        if (groundFields) groundFields.style.display = mode === 'ground' ? 'block' : 'none';
    }

    // Payload visibility is now handled by checkbox event listeners in _attachEventListeners

    function _updatePropulsionAvailability() {
        // Propulsion is available for all physics types — no restrictions
    }

    function _updateDefaultModeOptions() {
        // No longer needed — P cycles all enabled engines sequentially
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
        const isGround = mode === 'ground';

        var entityType = isOrbital ? 'satellite' : (isGround ? 'ground' : 'aircraft');

        const platform = {
            id: 'custom_' + Date.now(),
            category: 'Custom',
            name: _formState.name || 'Custom Platform',
            icon: _getTeamColor(_formState.team),
            description: _generateDescription(),
            type: entityType,
            team: _formState.team,
            defaults: {},
            components: {},
            // Custom platform metadata
            _custom: {
                physics: JSON.parse(JSON.stringify(_formState.physics)),
                propulsion: JSON.parse(JSON.stringify(_formState.propulsion)),
                sensors: JSON.parse(JSON.stringify(_formState.sensors)),
                payload: JSON.parse(JSON.stringify(_formState.payload)),
                commData: JSON.parse(JSON.stringify(_formState.commData)),
                computer: JSON.parse(JSON.stringify(_formState.computer)),
                cyber: JSON.parse(JSON.stringify(_formState.cyber))
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
        } else if (mode === 'ground') {
            // Ground station — no physics, fixed position
            var groundRole = _formState.physics.ground.role || 'generic';
            platform.defaults = {
                alt: 0,
                speed: 0,
                heading: 0,
                gamma: 0
            };
            // No physics component — static entity
            platform.components.visual = {
                type: 'ground_station',
                color: platform.icon,
                pixelSize: 14
            };
            platform._custom.groundRole = groundRole;
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

        // 3D Model (optional — applied to visual component)
        if (_formState.model.file) {
            platform._custom.model = {
                file: _formState.model.file,
                scale: _formState.model.scale || 1.0,
                heading: _formState.model.heading || 0,
                pitch: _formState.model.pitch || 0,
                roll: _formState.model.roll || 0
            };
            // Add model info to visual component config
            platform.components.visual.model = _formState.model.file;
            platform.components.visual.modelScale = _formState.model.scale || 1.0;
            platform.components.visual.modelHeading = _formState.model.heading || 0;
            platform.components.visual.modelPitch = _formState.model.pitch || 0;
            platform.components.visual.modelRoll = _formState.model.roll || 0;
        }

        // RCS override (store in _custom if user entered a value)
        var rcsInput = document.getElementById('pb-rcs-override');
        var rcsVal = rcsInput ? parseFloat(rcsInput.value) : NaN;
        if (!isNaN(rcsVal) && rcsVal > 0) {
            platform._custom.rcs_m2 = rcsVal;
        }

        // Propulsion modes (available for ALL physics types - satellites can have thrusters, spaceplanes can re-enter)
        // New format: taxi/air/hypersonic booleans + engines[] array of individual engine names
        var hasProp = _formState.propulsion.taxi || _formState.propulsion.air ||
            _formState.propulsion.hypersonic || (_formState.propulsion.engines && _formState.propulsion.engines.length > 0);
        if (hasProp) {
            platform.components.propulsion = {
                taxi: _formState.propulsion.taxi || false,
                air: _formState.propulsion.air || false,
                hypersonic: _formState.propulsion.hypersonic || false,
                engines: _formState.propulsion.engines.slice()
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

        // Cyber actor
        if (_formState.payload.cyberActor.enabled) {
            var cyberCaps;
            switch (_formState.payload.cyberActor.role) {
                case 'offense': cyberCaps = ['exploit', 'brick', 'ddos', 'mitm', 'inject']; break;
                case 'defense': cyberCaps = ['patch', 'harden', 'firewall', 'alert']; break;
                default: cyberCaps = ['exploit', 'brick', 'ddos', 'mitm', 'inject', 'patch', 'harden', 'firewall', 'alert']; break;
            }
            platform.components.cyber = {
                type: 'cyber_actor',
                capabilities: cyberCaps,
                autoTarget: true,
                stealthLevel: _formState.payload.cyberActor.stealthLevel,
                attackDuration_s: _formState.payload.cyberActor.attackDuration_s,
                accessTime_s: _formState.payload.cyberActor.accessTime_s
            };
            payloads.push('cyber');
        }

        // Firewall
        if (_formState.payload.firewall.enabled) {
            platform.components.firewall = {
                type: 'firewall',
                rating: _formState.payload.firewall.rating,
                ids: _formState.payload.firewall.ids
            };
            payloads.push('firewall');
        }

        // Comm data configuration
        if (_formState.commData.enabled) {
            platform._custom.commData = {
                enabled: true,
                missionData: _formState.commData.missionData,
                heartbeat: _formState.commData.heartbeat,
                heartbeatInterval_s: _formState.commData.heartbeatInterval_s,
                missionDataRate_bps: _formState.commData.missionDataRate_bps,
                emcon: _formState.commData.emcon,
                encrypted: _formState.commData.encrypted,
                encryptionType: _formState.commData.encryptionType,
                encryptionOverhead: _formState.commData.encrypted ? 0.15 : 0
            };
        }

        // Computer system (hackable onboard computer)
        if (_formState.computer.enabled) {
            platform.components.computer = {
                type: 'computer',
                os: _formState.computer.os,
                hardening: _formState.computer.hardening,
                patchLevel: _formState.computer.patchLevel,
                firewallRating: _formState.computer.firewallRating,
                // What can be hacked on this platform
                hackableSubsystems: ['sensors', 'navigation', 'weapons', 'comms']
            };
            platform._custom.computer = JSON.parse(JSON.stringify(_formState.computer));
        }

        // Cyber configuration
        var cy = _formState.cyber;
        var hasCyber = cy.firewallEnabled || cy.encryption !== 'none' || cy.aiRole !== 'none' ||
                       cy.hardening !== 5 || cy.patchLevel !== 5;
        if (hasCyber) {
            // cyber_computer component: hardening and patch level
            platform.components.cyber_computer = {
                type: 'cyber_computer',
                hardening: cy.hardening / 10,
                patchLevel: cy.patchLevel / 10,
                firewallRating: cy.firewallEnabled ? cy.firewallRating / 10 : 0
            };

            // cyber_firewall component (only if firewall enabled)
            if (cy.firewallEnabled) {
                platform.components.cyber_firewall = {
                    type: 'cyber_firewall',
                    rating: cy.firewallRating / 10,
                    ids: cy.ids
                };
            }

            // ai/cyber_ops component (only if AI role selected)
            if (cy.aiRole !== 'none') {
                var cyberAiConfig = {
                    type: 'cyber_ops',
                    role: cy.aiRole,
                    aggressiveness: cy.aggressiveness / 10,
                    stealthLevel: cy.stealthLevel / 10
                };
                if (cy.aiRole === 'offensive') {
                    cyberAiConfig.capabilities = ['exploit', 'brick', 'ddos', 'mitm', 'inject'];
                    cyberAiConfig.preferredTarget = 'sensors';
                } else if (cy.aiRole === 'defensive') {
                    cyberAiConfig.capabilities = ['monitor', 'patch', 'isolate', 'alert'];
                    cyberAiConfig.preferredTarget = 'comms';
                } else if (cy.aiRole === 'hybrid') {
                    cyberAiConfig.capabilities = ['exploit', 'brick', 'ddos', 'mitm', 'inject', 'monitor', 'patch', 'isolate', 'alert'];
                    cyberAiConfig.preferredTarget = 'sensors';
                }
                platform.components.cyber_ai = cyberAiConfig;
            }

            // Store full cyber config in _custom for persistence
            platform._custom.cyber = {
                hardening: cy.hardening / 10,
                patchLevel: cy.patchLevel / 10,
                firewallEnabled: cy.firewallEnabled,
                firewallRating: cy.firewallRating / 10,
                ids: cy.ids,
                encryption: cy.encryption,
                aiRole: cy.aiRole,
                aggressiveness: cy.aggressiveness / 10,
                stealthLevel: cy.stealthLevel / 10
            };
        }

        // Store payload list for reference
        if (payloads.length > 0) {
            platform._custom.activePayloads = payloads;
        }

        return platform;
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
        else if (mode === 'ground') parts.push(`ground (${_formState.physics.ground.role})`);
        else parts.push(`${_formState.physics.atmospheric.config} flight`);

        // Propulsion
        const propModes = [];
        if (_formState.propulsion.taxi) propModes.push('taxi');
        if (_formState.propulsion.air) propModes.push('air');
        if (_formState.propulsion.hypersonic) propModes.push('hyper');
        var numEngines = (_formState.propulsion.engines || []).length;
        if (numEngines > 0) propModes.push(numEngines + ' engine' + (numEngines > 1 ? 's' : ''));
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
        if (_formState.payload.cyberActor.enabled) payloads.push('CYBER');
        if (_formState.payload.firewall.enabled) payloads.push('FW');
        if (payloads.length > 0) parts.push(payloads.join('/'));

        // Comm
        if (_formState.commData.enabled) {
            var commParts = [];
            if (_formState.commData.missionData) commParts.push('data');
            if (_formState.commData.heartbeat) commParts.push('HB');
            if (_formState.commData.encrypted) commParts.push('ENC');
            if (_formState.commData.emcon) commParts.push('EMCON');
            if (commParts.length > 0) parts.push('comm:' + commParts.join('/'));
        }

        // Computer
        if (_formState.computer.enabled) parts.push('CPU');

        // Cyber
        var cyberParts = [];
        if (_formState.cyber.firewallEnabled) cyberParts.push('FW');
        if (_formState.cyber.ids) cyberParts.push('IDS');
        if (_formState.cyber.encryption !== 'none') cyberParts.push(_formState.cyber.encryption);
        if (_formState.cyber.aiRole !== 'none') cyberParts.push('AI:' + _formState.cyber.aiRole);
        if (cyberParts.length > 0) parts.push('cyber:' + cyberParts.join('/'));

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

    function _saveToStorage(platform, replaceId) {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            const platforms = stored ? JSON.parse(stored) : [];
            if (replaceId) {
                var found = false;
                for (var i = 0; i < platforms.length; i++) {
                    if (platforms[i].id === replaceId) {
                        platforms[i] = platform;
                        found = true;
                        break;
                    }
                }
                if (!found) platforms.push(platform);
            } else {
                platforms.push(platform);
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(platforms));
        } catch (e) {
            console.warn('[PlatformBuilder] Failed to save to storage:', e);
        }
    }

    function _deleteFromStorage(id) {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (!stored) return;
            const platforms = JSON.parse(stored).filter(p => p.id !== id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(platforms));
        } catch (e) {
            console.warn('[PlatformBuilder] Failed to delete from storage:', e);
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
            _formState.model = { file: '', scale: 1.0, heading: 0, pitch: 0, roll: 0 };
            _formState.propulsion = { taxi: false, air: false, hypersonic: false, engines: [], defaultMode: 'air' };
            _formState.cyber = { hardening: 5, patchLevel: 5, firewallEnabled: false,
                firewallRating: 5, ids: false, encryption: 'none', aiRole: 'none',
                aggressiveness: 5, stealthLevel: 5 };
            _activeTab = 'physics';

            _overlay.style.display = 'flex';
            _switchTab('physics');
            _attachEventListeners();

            // Reset propulsion checkboxes in DOM
            ['taxi', 'air', 'hypersonic'].forEach(function(m) {
                var cb = document.getElementById('pb-prop-' + m);
                if (cb) cb.checked = false;
            });
            document.querySelectorAll('.pb-engine-check').forEach(function(cb) { cb.checked = false; });

            // Reset cyber tab DOM elements
            var cySliders = ['pb-cyber-hardening', 'pb-cyber-patchlevel', 'pb-cyber-firewall-rating',
                             'pb-cyber-aggressiveness', 'pb-cyber-stealth-level'];
            cySliders.forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = 5;
                var valEl = document.getElementById(id + '-val');
                if (valEl) valEl.textContent = '5';
            });
            var cyFwCb = document.getElementById('pb-cyber-firewall-enabled');
            if (cyFwCb) cyFwCb.checked = false;
            var cyFwFields = document.querySelector('.pb-cyber-firewall-fields');
            if (cyFwFields) cyFwFields.style.display = 'none';
            var cyIdsCb = document.getElementById('pb-cyber-ids');
            if (cyIdsCb) cyIdsCb.checked = false;
            var cyEncSel = document.getElementById('pb-cyber-encryption');
            if (cyEncSel) cyEncSel.value = 'none';
            var cyAiSel = document.getElementById('pb-cyber-ai-role');
            if (cyAiSel) cyAiSel.value = 'none';
            var cyAiFields = document.querySelector('.pb-cyber-ai-fields');
            if (cyAiFields) cyAiFields.style.display = 'none';

            _updateCOEComputed();
            _updatePropulsionAvailability();
            _updateDefaultModeOptions();
            _updateModelUI();

            document.getElementById('pb-name')?.focus();
        });
    }

    function edit(existingPlatform) {
        return new Promise((resolve, reject) => {
            _resolvePromise = resolve;
            _rejectPromise = reject;
            _editingId = existingPlatform.id;

            // Populate _formState from the platform's _custom snapshot
            var c = existingPlatform._custom || {};
            _formState.name = existingPlatform.name || 'Custom Platform';
            _formState.team = existingPlatform.team || 'blue';

            // Physics
            if (c.physics) {
                _formState.physics.mode = c.physics.mode || 'coe';
                if (c.physics.tle) Object.assign(_formState.physics.tle, c.physics.tle);
                if (c.physics.coe) Object.assign(_formState.physics.coe, c.physics.coe);
                if (c.physics.atmospheric) Object.assign(_formState.physics.atmospheric, c.physics.atmospheric);
            }

            // Propulsion — handle legacy format (rocket/ion/rcs booleans) + new format (engines[])
            if (c.propulsion) {
                _formState.propulsion.taxi = !!c.propulsion.taxi;
                _formState.propulsion.air = !!c.propulsion.air;
                _formState.propulsion.hypersonic = !!c.propulsion.hypersonic;
                if (c.propulsion.engines && c.propulsion.engines.length > 0) {
                    _formState.propulsion.engines = c.propulsion.engines.slice();
                } else if (c.propulsion.rocket) {
                    // Legacy: had rocket=true with optional rocketEngine name
                    // Map old rocketEngine id to new engine name, or default to OMS
                    var legacyMap = { 'oms_25kn': 'OMS 25kN', 'aj10_100kn': 'AJ10 100kN',
                        'rl10_500kn': 'RL10 500kN', 'rs25_5mn': 'RS25 5MN' };
                    var mapped = legacyMap[c.propulsion.rocketEngine];
                    _formState.propulsion.engines = mapped ? [mapped] : ['OMS 25kN'];
                } else {
                    _formState.propulsion.engines = [];
                }
                // Legacy ion/rcs → map to closest new engines
                if (c.propulsion.ion) {
                    if (_formState.propulsion.engines.indexOf('ION 0.5N') < 0)
                        _formState.propulsion.engines.push('ION 0.5N');
                }
                if (c.propulsion.rcs) {
                    if (_formState.propulsion.engines.indexOf('RCS 500N') < 0)
                        _formState.propulsion.engines.push('RCS 500N');
                }
            }

            // Sensors
            if (c.sensors) {
                Object.keys(c.sensors).forEach(function(key) {
                    if (_formState.sensors[key]) {
                        Object.assign(_formState.sensors[key], c.sensors[key]);
                    }
                });
            }

            // Payload
            if (c.payload) {
                Object.keys(c.payload).forEach(function(key) {
                    if (_formState.payload[key]) {
                        Object.assign(_formState.payload[key], c.payload[key]);
                    }
                });
            }

            // Model
            if (c.model) {
                _formState.model = Object.assign({ file: '', scale: 1.0, heading: 0, pitch: 0, roll: 0 }, c.model);
            } else {
                _formState.model = { file: '', scale: 1.0, heading: 0, pitch: 0, roll: 0 };
            }

            // Cyber — restore from _custom.cyber (values stored as 0-1, convert back to 0-10 for sliders)
            if (c.cyber) {
                _formState.cyber.hardening = Math.round((c.cyber.hardening || 0) * 10);
                _formState.cyber.patchLevel = Math.round((c.cyber.patchLevel || 0) * 10);
                _formState.cyber.firewallEnabled = !!c.cyber.firewallEnabled;
                _formState.cyber.firewallRating = Math.round((c.cyber.firewallRating || 0) * 10);
                _formState.cyber.ids = !!c.cyber.ids;
                _formState.cyber.encryption = c.cyber.encryption || 'none';
                _formState.cyber.aiRole = c.cyber.aiRole || 'none';
                _formState.cyber.aggressiveness = Math.round((c.cyber.aggressiveness || 0) * 10);
                _formState.cyber.stealthLevel = Math.round((c.cyber.stealthLevel || 0) * 10);
            } else {
                _formState.cyber = { hardening: 5, patchLevel: 5, firewallEnabled: false,
                    firewallRating: 5, ids: false, encryption: 'none', aiRole: 'none',
                    aggressiveness: 5, stealthLevel: 5 };
            }

            _activeTab = 'physics';
            _overlay.style.display = 'flex';
            _switchTab('physics');
            _attachEventListeners();

            // Populate DOM fields from restored state
            var nameEl = document.getElementById('pb-name');
            if (nameEl) nameEl.value = _formState.name;
            var teamEl = document.getElementById('pb-team');
            if (teamEl) teamEl.value = _formState.team;

            // Physics radio
            var physRadio = document.querySelector('input[name="physics-mode"][value="' + _formState.physics.mode + '"]');
            if (physRadio) { physRadio.checked = true; physRadio.dispatchEvent(new Event('change')); }

            // Propulsion: atmospheric mode checkboxes
            ['taxi', 'air', 'hypersonic'].forEach(function(m) {
                var cb = document.getElementById('pb-prop-' + m);
                if (cb) cb.checked = !!_formState.propulsion[m];
            });
            // Engine roster checkboxes
            var engines = _formState.propulsion.engines || [];
            document.querySelectorAll('.pb-engine-check').forEach(function(cb) {
                var engName = cb.getAttribute('data-engine');
                cb.checked = engines.indexOf(engName) >= 0;
            });

            // Model select
            var modelSel = document.getElementById('pb-model-file');
            if (modelSel) modelSel.value = _formState.model.file || '';
            ['heading', 'pitch', 'roll'].forEach(function(f) {
                var el = document.getElementById('pb-model-' + f);
                if (el) el.value = _formState.model[f] || 0;
            });
            var scaleEl = document.getElementById('pb-model-scale');
            if (scaleEl) scaleEl.value = _formState.model.scale || 1.0;

            // Cyber tab DOM restore
            var cyState = _formState.cyber;
            var hardeningSlider = document.getElementById('pb-cyber-hardening');
            if (hardeningSlider) { hardeningSlider.value = cyState.hardening; }
            var hardeningVal = document.getElementById('pb-cyber-hardening-val');
            if (hardeningVal) hardeningVal.textContent = cyState.hardening;
            var patchSlider = document.getElementById('pb-cyber-patchlevel');
            if (patchSlider) { patchSlider.value = cyState.patchLevel; }
            var patchVal = document.getElementById('pb-cyber-patchlevel-val');
            if (patchVal) patchVal.textContent = cyState.patchLevel;
            var fwCb = document.getElementById('pb-cyber-firewall-enabled');
            if (fwCb) fwCb.checked = cyState.firewallEnabled;
            var fwFields = document.querySelector('.pb-cyber-firewall-fields');
            if (fwFields) fwFields.style.display = cyState.firewallEnabled ? 'block' : 'none';
            var fwRatingSlider = document.getElementById('pb-cyber-firewall-rating');
            if (fwRatingSlider) { fwRatingSlider.value = cyState.firewallRating; }
            var fwRatingVal = document.getElementById('pb-cyber-firewall-rating-val');
            if (fwRatingVal) fwRatingVal.textContent = cyState.firewallRating;
            var idsCb = document.getElementById('pb-cyber-ids');
            if (idsCb) idsCb.checked = cyState.ids;
            var encSel = document.getElementById('pb-cyber-encryption');
            if (encSel) encSel.value = cyState.encryption;
            var aiRoleSel = document.getElementById('pb-cyber-ai-role');
            if (aiRoleSel) aiRoleSel.value = cyState.aiRole;
            var aiFields = document.querySelector('.pb-cyber-ai-fields');
            if (aiFields) aiFields.style.display = cyState.aiRole !== 'none' ? 'block' : 'none';
            var aggrSlider = document.getElementById('pb-cyber-aggressiveness');
            if (aggrSlider) { aggrSlider.value = cyState.aggressiveness; }
            var aggrVal = document.getElementById('pb-cyber-aggressiveness-val');
            if (aggrVal) aggrVal.textContent = cyState.aggressiveness;
            var stealthSlider = document.getElementById('pb-cyber-stealth-level');
            if (stealthSlider) { stealthSlider.value = cyState.stealthLevel; }
            var stealthVal = document.getElementById('pb-cyber-stealth-level-val');
            if (stealthVal) stealthVal.textContent = cyState.stealthLevel;

            _updateCOEComputed();
            _updatePropulsionAvailability();
            _updateDefaultModeOptions();
            _updateModelUI();
            _updateCyberAiSummary();

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
            const hasEngine = _formState.propulsion.taxi || _formState.propulsion.air ||
                              _formState.propulsion.hypersonic ||
                              (_formState.propulsion.engines && _formState.propulsion.engines.length > 0);
            if (!hasEngine) {
                alert('Please select at least one propulsion mode for atmospheric flight.');
                return;
            }
        }
        // Ground mode needs no validation — just a click on the globe

        const platform = _generatePlatformTemplate();

        if (_editingId) {
            // Edit mode: preserve original id, update in-place
            platform.id = _editingId;
            _saveToStorage(platform, _editingId);
            if (typeof ObjectPalette !== 'undefined' && ObjectPalette.updateCustomTemplate) {
                ObjectPalette.updateCustomTemplate(platform);
            }
        } else {
            // New mode: add to palette + storage
            _addToDOMPalette(platform);
            if (typeof ObjectPalette !== 'undefined' && ObjectPalette.addCustomTemplate) {
                ObjectPalette.addCustomTemplate(platform);
            }
            _saveToStorage(platform);
        }

        _overlay.style.display = 'none';
        _editingId = null;
        // Clean up model-viewer to free WebGL context
        if (_modelViewerEl && _modelViewerEl.parentNode) {
            _modelViewerEl.parentNode.removeChild(_modelViewerEl);
            _modelViewerEl = null;
        }
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
        item.className = 'palette-item custom-palette-item';
        item.setAttribute('data-entity-type', platform.type);
        item.setAttribute('data-custom-id', platform.id);
        item.setAttribute('data-team', platform.team);

        const dot = document.createElement('div');
        dot.className = 'palette-dot';
        dot.style.backgroundColor = platform.icon;
        item.appendChild(dot);

        const info = document.createElement('div');
        info.className = 'palette-item-info';
        info.style.flex = '1';
        info.style.minWidth = '0';

        const nameEl = document.createElement('div');
        nameEl.className = 'palette-item-name';
        nameEl.innerHTML = platform.name + ' <span style="color:#4af;font-size:9px;">★</span>';
        info.appendChild(nameEl);

        const descEl = document.createElement('div');
        descEl.className = 'palette-item-desc';
        descEl.textContent = platform.description;
        info.appendChild(descEl);

        item.appendChild(info);

        // --- Actions: placement dropdown + edit + delete ---
        var actions = document.createElement('div');
        actions.className = 'custom-actions';

        // Placement mode dropdown
        var modeSelect = document.createElement('select');
        modeSelect.className = 'custom-placement-mode';
        var isAtmospheric = platform.components && platform.components.physics &&
            platform.components.physics.type === 'flight3dof';
        // Default to 'spacecraft' if orbital physics OR space-capable propulsion
        var hasSpaceProp = platform._custom && platform._custom.propulsion &&
            (platform._custom.propulsion.hypersonic ||
             (platform._custom.propulsion.engines && platform._custom.propulsion.engines.length > 0));
        var defaultMode = (isAtmospheric && !hasSpaceProp) ? 'aircraft' : 'spacecraft';
        [{ v: 'spacecraft', l: 'Space' }, { v: 'aircraft', l: 'Air' }, { v: 'ground', l: 'Ground' }].forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m.v;
            opt.textContent = m.l;
            if (m.v === defaultMode) opt.selected = true;
            modeSelect.appendChild(opt);
        });
        modeSelect.addEventListener('click', function(e) { e.stopPropagation(); });
        modeSelect.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        actions.appendChild(modeSelect);

        // Edit button
        var editBtn = document.createElement('button');
        editBtn.className = 'custom-action-btn custom-edit-btn';
        editBtn.innerHTML = '&#9998;';
        editBtn.title = 'Edit platform';
        editBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            edit(platform).then(function(updated) {
                // Refresh: remove old DOM item and re-add
                _removeDOMPaletteItem(platform.id);
                _addToDOMPalette(updated);
                if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                    BuilderApp.showMessage('Updated: ' + updated.name, 3000);
                }
            }).catch(function() {});
        });
        actions.appendChild(editBtn);

        // Delete button
        var delBtn = document.createElement('button');
        delBtn.className = 'custom-action-btn custom-del-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Delete platform';
        delBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (!confirm('Delete "' + platform.name + '"?')) return;
            _deleteFromStorage(platform.id);
            _removeDOMPaletteItem(platform.id);
            // Hide custom section if empty
            var remaining = body.querySelectorAll('.palette-item');
            if (remaining.length === 0) section.style.display = 'none';
        });
        actions.appendChild(delBtn);

        item.appendChild(actions);

        // Store mode select reference for click handler
        item._modeSelect = modeSelect;

        // Click handler - start placement with this custom platform
        item.addEventListener('click', function() {
            document.querySelectorAll('.palette-item.selected').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');

            // Set placement mode from dropdown
            platform._placementMode = modeSelect.value;

            if (typeof BuilderApp !== 'undefined' && BuilderApp.startPlacement) {
                BuilderApp.startPlacement(platform);
            }
        });

        body.appendChild(item);
    }

    /** Remove a custom platform DOM item by id. */
    function _removeDOMPaletteItem(id) {
        var el = document.querySelector('.palette-item[data-custom-id="' + id + '"]');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function _cancel() {
        _overlay.style.display = 'none';
        _editingId = null;
        // Clean up model-viewer to free WebGL context
        if (_modelViewerEl && _modelViewerEl.parentNode) {
            _modelViewerEl.parentNode.removeChild(_modelViewerEl);
            _modelViewerEl = null;
        }
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
            .pb-engine-cat {
                color: #888;
                font-size: 10px;
                font-weight: bold;
                text-transform: uppercase;
                letter-spacing: 1px;
                padding: 6px 0 4px 0;
                border-bottom: 1px solid #222;
                margin-bottom: 4px;
            }
            .pb-engine-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 2px 8px;
                margin-bottom: 6px;
            }
            .pb-engine-item {
                display: flex;
                align-items: center;
                gap: 6px;
                cursor: pointer;
                padding: 4px 6px;
                border-radius: 3px;
                font-size: 11px;
            }
            .pb-engine-item:hover {
                background: #1a1a2e;
            }
            .pb-engine-item input[type="checkbox"] {
                accent-color: #4af;
                margin: 0;
            }
            .pb-eng-name {
                font-weight: bold;
                color: #ccc;
                white-space: nowrap;
                font-size: 11px;
            }
            .pb-eng-desc {
                color: #666;
                font-size: 10px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .pb-small-btn {
                background: #333;
                color: #aaa;
                border: 1px solid #444;
                padding: 3px 10px;
                border-radius: 3px;
                font-size: 10px;
                cursor: pointer;
            }
            .pb-small-btn:hover {
                background: #444;
                color: #ddd;
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
            .pb-model-select {
                width: 100%;
                padding: 8px;
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                border-radius: 3px;
                font-size: 12px;
            }
            .pb-model-preview-wrap {
                position: relative;
                width: 100%;
                margin-bottom: 8px;
            }
            .pb-model-preview-box {
                width: 100%;
                height: 220px;
                background: #0a0a14;
                border: 1px solid #333;
                border-radius: 4px;
                overflow: hidden;
                position: relative;
            }
            .pb-model-placeholder {
                display: flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 100%;
                color: #444;
                font-size: 12px;
                font-style: italic;
            }
            .pb-model-axis-overlay {
                position: absolute;
                bottom: 6px;
                left: 6px;
                pointer-events: none;
                opacity: 0.8;
            }
            .pb-model-axis-overlay canvas {
                background: rgba(10, 10, 20, 0.7);
                border-radius: 3px;
            }
            .pb-model-drag-hint {
                position: absolute;
                bottom: 6px;
                right: 6px;
                pointer-events: none;
                color: #555;
                font-size: 10px;
                background: rgba(10, 10, 20, 0.7);
                padding: 2px 6px;
                border-radius: 3px;
            }
            .pb-model-controls-row {
                display: grid;
                grid-template-columns: 1fr 1fr 1fr 1fr;
                gap: 8px;
                margin-top: 8px;
            }
            .pb-model-controls-row .pb-coe-field input {
                width: 100%;
                box-sizing: border-box;
                background: #0a0a14;
                border: 1px solid #333;
                color: #ddd;
                padding: 6px 8px;
                border-radius: 3px;
            }
            /* Cyber tab slider styles */
            .pb-cyber-slider-group {
                margin-bottom: 10px;
            }
            .pb-cyber-slider-row {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .pb-cyber-slider-label {
                flex: 0 0 140px;
                font-size: 11px;
                color: #aaa;
                font-weight: bold;
            }
            .pb-range-slider {
                flex: 1;
                -webkit-appearance: none;
                appearance: none;
                height: 6px;
                border-radius: 3px;
                background: #333;
                outline: none;
                cursor: pointer;
            }
            .pb-range-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #0fc;
                cursor: pointer;
                border: 2px solid #0a0a14;
            }
            .pb-range-slider::-moz-range-thumb {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #0fc;
                cursor: pointer;
                border: 2px solid #0a0a14;
            }
            .pb-range-slider:hover::-webkit-slider-thumb {
                box-shadow: 0 0 6px rgba(0, 255, 200, 0.4);
            }
            .pb-range-red::-webkit-slider-thumb {
                background: #f66;
            }
            .pb-range-red::-moz-range-thumb {
                background: #f66;
            }
            .pb-range-purple::-webkit-slider-thumb {
                background: #a6f;
            }
            .pb-range-purple::-moz-range-thumb {
                background: #a6f;
            }
            .pb-cyber-slider-value {
                flex: 0 0 24px;
                text-align: center;
                font-size: 13px;
                font-weight: bold;
                color: #0fc;
                font-family: monospace;
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
        edit,
        deleteTemplate: _deleteFromStorage,
        getAllCustomPlatforms: _getAllCustomPlatforms
    };
})();
