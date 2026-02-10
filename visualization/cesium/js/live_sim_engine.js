/**
 * LiveSimEngine — Hybrid player cockpit + ECS world simulation.
 *
 * The player entity gets full standalone-sim treatment (FighterSimEngine physics,
 * FighterHUD rendering, camera tracking, keyboard controls). All other entities
 * run through the normal ECS system pipeline (AI, physics, sensors, weapons, events).
 *
 * Usage:
 *   const info = await LiveSimEngine.init(scenarioUrl, playerId, viewer);
 *   viewer.clock.onTick.addEventListener(() => LiveSimEngine.tick());
 */
const LiveSimEngine = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const MPS_TO_KNOTS = 1.94384;
    const M_TO_FT = 3.28084;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    let _world = null;
    let _viewer = null;
    let _playerEntity = null;   // ECS entity reference
    let _playerState = null;    // Direct reference to entity.state
    let _playerConfig = null;   // FighterSimEngine config
    let _playerDef = null;      // Original entity definition
    let _autopilotState = null;
    let _apPanelOpen = false;
    let _scenarioJson = null;      // Stored scenario data for subsystem init

    let _isPaused = false;
    let _timeWarp = 1;
    let _simElapsed = 0;
    let _lastTickTime = null;
    let _cameraMode = 'chase';
    let _plannerMode = false;
    let _lastRegime = 'ATMOSPHERIC';
    let _started = false;
    let _observerMode = false;
    let _isStaticPlayer = false; // true when player is a static_ground entity (cyber ops, command post)

    // Per-entity visualization control groups
    let _vizGroups = {};  // { groupKey: { show, orbits, trails, labels, sensors } }
    let _vizGlobalOrbits = false;
    let _vizGlobalTrails = false;
    let _vizGlobalLabels = true;
    let _vizGlobalSensors = true;

    // Entity picker state
    let _pickPopup = null;
    let _pickedEntity = null;
    let _trackingEntity = null; // entity being camera-tracked in observer mode

    // Search state
    let _searchMatchedIds = new Set();
    let _searchPanelOpen = false;

    // Analytics state
    let _analyticsHistory = [];
    let _analyticsCharts = {};  // {chartId: Chart instance}
    let _analyticsPanelOpen = false;
    let _analyticsRecordCounter = 0;

    // Propulsion — flat list of all individual engines
    let _propModes = [];   // [{name, mode, thrust?, desc?, color}]
    let _propModeIndex = 0;

    // Engine presets — expanded into _propModes when rocket is enabled
    // Sorted smallest→largest. P key cycles through all sequentially.
    var ROCKET_ENGINES = [
        // Micro thrusters
        { name: 'ION 0.5N',       thrust: 0.5,        desc: 'Station Keeping' },
        { name: 'HALL 5N',        thrust: 5,           desc: 'Hall Effect' },
        { name: 'Cold Gas 50N',   thrust: 50,          desc: 'Attitude Jets' },
        { name: 'RCS 500N',       thrust: 500,         desc: 'Reaction Control' },
        // Prop / light
        { name: 'PROP 2kN',       thrust: 2000,        desc: 'Propeller' },
        { name: 'TURBOPROP 15kN', thrust: 15000,       desc: 'Cargo Aircraft' },
        // Medium rockets
        { name: 'OMS 25kN',       thrust: 25000,       desc: 'Orbital Maneuvering' },
        { name: 'AJ10 100kN',     thrust: 100000,      desc: 'Medium Rocket' },
        { name: '1G ACCEL 147kN', thrust: 147150,      desc: '1G Constant Accel' },
        // Large rockets
        { name: 'NERVA 350kN',    thrust: 350000,      desc: 'Nuclear Thermal' },
        { name: 'RL10 500kN',     thrust: 500000,      desc: 'Heavy Vacuum' },
        { name: 'Raptor 2.2MN',   thrust: 2200000,     desc: 'Methalox' },
        { name: 'RS25 5MN',       thrust: 5000000,     desc: 'Launch Engine' },
        { name: 'TORCH 50MN',     thrust: 50000000,    desc: '1 AU/day Class' },
    ];
    // Weapons & Sensors
    let _weaponList = [];       // [{name, type, count, maxCount}]
    let _weaponIndex = -1;      // -1 = no weapon selected
    let _sensorList = [];       // [{name, type}]
    let _sensorIndex = -1;      // -1 = no sensor active

    // Sensor view effects
    let _sensorNoiseCanvas = null;
    let _sensorNoiseCtx = null;
    let _sensorNoiseAnimFrame = null;
    let _activeSensorFilter = null;
    var SENSOR_FILTERS = {
        optical: { css: 'grayscale(1) contrast(1.2) brightness(0.4)', noise: 0.12, label: 'EO | B&W', visual: true },
        ir:      { css: 'grayscale(1) invert(0.85) contrast(1.8) brightness(0.6)', noise: 0.08, label: 'FLIR | WHT-HOT', visual: true }
    };

    // Pilot display modes (NVG / FLIR)
    let _displayMode = 0;  // 0=normal, 1=NVG, 2=FLIR
    var DISPLAY_MODE_FILTERS = {
        1: { css: 'brightness(1.5) contrast(1.2) saturate(0) sepia(1) hue-rotate(70deg) brightness(0.8)', label: 'NVG', noise: 0.06 },
        2: { css: 'brightness(1.1) contrast(1.5) saturate(0) invert(1)', label: 'FLIR', noise: 0.04 }
    };

    // Auto-pointing system
    let _pointingMode = 'manual';  // manual|prograde|retrograde|normal|antinormal|radial|radial_neg|nadir|sun|target
    let _pointingLocked = true;    // when true, pointing is maintained each frame
    let _pointingTarget = null;    // entity id for 'target' mode
    let _pointingPanelOpen = false;
    var _JD_SIM_EPOCH_LOCAL = 2460676.5; // JD of 2026-01-01 00:00 UTC

    var POINTING_MODES = [
        { id: 'manual',       label: 'MANUAL',       desc: 'Free flight controls' },
        { id: 'prograde',     label: 'PROGRADE',     desc: 'Velocity direction' },
        { id: 'retrograde',   label: 'RETROGRADE',   desc: 'Anti-velocity' },
        { id: 'normal',       label: 'NORMAL',       desc: 'Orbit normal (+H)' },
        { id: 'antinormal',   label: 'ANTI-NORMAL',  desc: 'Orbit anti-normal (-H)' },
        { id: 'radial',       label: 'RADIAL OUT',   desc: 'Away from Earth' },
        { id: 'radial_neg',   label: 'RADIAL IN',    desc: 'Toward Earth' },
        { id: 'nadir',        label: 'NADIR',        desc: 'Earth center (down)' },
        { id: 'sun',          label: 'SUN',          desc: 'Solar direction' },
        { id: 'target',       label: 'TARGET',       desc: 'Track selected target' },
    ];

    // Camera
    let _camHeadingOffset = 0;
    let _camPitch = -0.3;
    let _camRange = 150;
    let _camDragging = false;
    let _camDragStart = { x: 0, y: 0 };
    let _plannerCamRange = 5e7;
    let _globeControlsEnabled = true; // arrow keys active in earth/moon modes

    // Trail & orbit display
    let _playerTrail = [];
    let _playerTrailTimes = [];
    let _trailCounter = 0;
    let _trailEntity = null;
    let _groundTrackEntity = null;
    let _playerGroundTrack = [];
    let _orbitPolyline = null;
    let _eciOrbitPolyline = null;
    let _predictedOrbitPolyline = null;
    let _predictedGroundTrackEntity = null;
    let _predictedGroundTrackPositions = [];
    let _apMarker = null;
    let _peMarker = null;
    let _anMarker = null;
    let _dnMarker = null;

    // Display toggles (persisted in localStorage)
    let _showEciOrbit = false;
    let _showEcefOrbit = true;
    let _showPredictedGroundTrack = true;
    let _orbitRevs = 1;
    let _showTrail = true;
    let _trailDurationSec = 0;  // 0 = infinite

    // Subsystem toggles (persisted in localStorage)
    let _audioEnabled = true;
    let _visualFxEnabled = true;

    // Area-of-Interest regions (polygons/circles on globe)
    let _regionEntities = [];

    // Threat assessment overlay (SAM/radar coverage rings)
    let _threatOverlayEnabled = false;
    let _threatOverlayEntities = [];

    // Mission waypoint planner
    let _missionWaypoints = [];         // { lat, lon, alt, name, cesiumEntity }
    let _waypointRouteEntity = null;    // Cesium polyline for route
    let _waypointMode = false;          // When true, clicks add waypoints

    // Performance stats
    let _perfStats = { fps: 60, frameMs: 0, entityCount: 0, physicsMs: 0, renderMs: 0 };
    let _perfFrameTimes = [];  // rolling window of last 60 frame times
    let _perfLastDisplay = 0;

    // Tactical data link (Link 16 style)
    let _dataLinksEnabled = false;
    let _dataLinkEntities = [];    // Cesium polyline entities for link lines
    let _dataLinkLastTick = 0;     // timestamp for 2Hz throttle

    // Engine selection panel
    let _enginePanelOpen = false;
    let _propKeyMap = {};  // digit string -> _propModes index

    // Terrain Following / Terrain Avoidance
    let _tfEnabled = false;
    let _tfAglTarget = 150;          // target AGL in meters
    let _tfLastSampleTime = 0;       // throttle terrain queries to 2Hz
    let _tfTerrainAhead = [];        // [{dist, terrainElev}] for HUD profile
    let _tfCurrentTerrainElev = 0;   // terrain elevation at current position (m MSL)

    // Maneuver dialog
    let _maneuverDialogOpen = false;
    let _maneuverDialogNode = null;   // node being edited in dialog
    let _maneuverUpdateTimer = null;  // debounce timer for dialog input

    // Auto-execute state machine
    let _autoExecState = null;    // null | 'warp_only' | 'warping' | 'orienting' | 'burning'
    let _autoExecNode = null;     // reference to the executing node
    let _autoExecBurnEnd = 0;     // simTime when burn should end (safety fallback)
    let _autoExecOrientStart = 0; // simTime when orientation phase started
    let _autoExecCumulativeDV = 0; // accumulated dV during burn (m/s)
    let _autoExecTargetDV = 0;    // target dV for this burn (m/s)
    let _autoExecTarget = null;   // orbital element targeting: {type, targetAltM, targetR}
    let _pendingHohmann = null;   // {targetAltKm} for two-burn Hohmann sequence

    // Quest/mission guidance system
    let _questActive = false;
    let _questMode = 'takeoff';    // 'takeoff' or 'landing'
    let _questWaypoints = [];      // [{lat, lon, radius, name, msg, hint, reached}]
    let _questMilestones = [];     // [{type, value, msg, triggered}]
    let _questCurrentWP = 0;       // index of next waypoint
    let _questEntities = [];       // Cesium entities for cleanup
    let _questRouteEntity = null;  // taxi route polyline
    let _questArrowEntity = null;  // direction arrow from player to next WP
    let _questComplete = false;
    let _questRouteAlt = 40;       // altitude for route polyline & markers

    /**
     * Max time warp scaled by orbital altitude.
     * Orbital period ∝ SMA^1.5, so warp scales the same way to keep
     * GEO operations feeling as snappy as LEO at 1024x.
     * LEO (400km) = 1024x, GEO (35793km) ≈ 10000x, cap at 10000x.
     */
    function _getMaxWarp() {
        var LEO_SMA = 6771000;
        var sma = 6371000 + (_playerState ? (_playerState.alt || 0) : 0);
        if (sma <= LEO_SMA) return 1024;
        var ratio = Math.pow(sma / LEO_SMA, 1.5);
        return Math.min(10000, Math.round(1024 * ratio));
    }

    // Keyboard
    const _keys = {};

    // Panel visibility — start with panels off, user enables via settings gear
    let _panelVisible = {
        flightData: false,
        systems: false,
        orbital: 'auto',
        help: false,
        entityList: false,
        statusBar: true,
    };
    let _panelsMinimized = false;

    // Entity list for display
    let _entityListItems = [];

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    async function init(scenarioUrl, playerIdParam, viewer) {
        _viewer = viewer;

        // Recover from render errors (model shaders, polyline buffer overflow, etc.)
        _viewer.scene.renderError.addEventListener(function(scene, error) {
            console.error('[LiveSim] Cesium render error:', error);
            var entities = _viewer.entities.values;
            for (var i = 0; i < entities.length; i++) {
                if (entities[i].model) entities[i].model = undefined;
                // Clear polylines that may have caused buffer overflow
                if (entities[i].polyline) entities[i].polyline.show = false;
            }
            // Clear orbital trace arrays
            if (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.currentOrbitPositions) {
                SpaceplaneOrbital.currentOrbitPositions.length = 0;
            }
            _playerTrail.length = 0;
            _playerGroundTrack.length = 0;
            _predictedGroundTrackPositions.length = 0;
            // Restart render loop
            _viewer.useDefaultRenderLoop = false;
            setTimeout(function() {
                _viewer.useDefaultRenderLoop = true;
                // Re-enable polylines after render recovery
                var ents = _viewer.entities.values;
                for (var j = 0; j < ents.length; j++) {
                    if (ents[j].polyline) ents[j].polyline.show = true;
                }
            }, 200);
            _showMessage('Render recovered — orbit trace cleared');
        });

        // 1. Fetch + build ECS world
        const resp = await fetch(scenarioUrl);
        if (!resp.ok) throw new Error('Failed to load scenario: ' + resp.status);
        const scenarioJson = await resp.json();
        _scenarioJson = scenarioJson;

        // Dynamic sim epoch from scenario or system clock
        if (_scenarioJson && _scenarioJson.environment && _scenarioJson.environment.simStartTime) {
            var startMs = Date.parse(_scenarioJson.environment.simStartTime);
            if (!isNaN(startMs)) {
                _JD_SIM_EPOCH_LOCAL = 2440587.5 + startMs / 86400000;
            }
        } else {
            // Default to system clock
            _JD_SIM_EPOCH_LOCAL = 2440587.5 + Date.now() / 86400000;
        }

        _world = ScenarioLoader.build(scenarioJson, viewer);
        _world.simEpochJD = _JD_SIM_EPOCH_LOCAL;

        // Initialize Communications Engine
        if (typeof CommEngine !== 'undefined' && scenarioJson.networks && scenarioJson.networks.length > 0) {
            CommEngine.init(scenarioJson.networks, _world);
        }

        // Check for observer mode (no player)
        _observerMode = (playerIdParam === '__observer__');

        if (_observerMode) {
            // OBSERVER MODE — no player entity, just ECS world + camera
            _playerEntity = null;
            _playerState = null;

            _buildEntityList();
            _setupCameraHandlers();
            _setupKeyboard();
            _initSettingsGear();
            _initSearchPanel();
            _initAnalyticsPanel();
            _initCommPanel();
            _initCyberLogPanel();
            _initAARPanel();
            _initStatusBoard();
            _initEngTimeline();
            _initEngagementStats();
            _initDataExport();
            _initAutopilotPanel();
            _setupEntityPicker();
            _setupWaypointPlacer();
            _buildVizGroups();

            // Init entity hover tooltip
            if (typeof EntityTooltip !== 'undefined') EntityTooltip.init(_viewer, _world);

            // Start in earth camera mode
            _cameraMode = 'earth';
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            _viewer.camera.flyHome(0);

            // Hide HUD in observer mode
            var hudCanvas = document.getElementById('hudCanvas');
            if (hudCanvas) hudCanvas.style.display = 'none';

            // Show entity list by default
            _panelVisible.entityList = true;
            _panelVisible.flightData = false;
            _panelVisible.systems = false;

            // Set keyboard help to observer mode
            if (typeof KeyboardHelp !== 'undefined') KeyboardHelp.setMode('observer');

        } else {
            // COCKPIT MODE — normal player path
            // 2. Select player entity
            _playerEntity = _selectPlayer(_world, playerIdParam);
            if (!_playerEntity) {
                console.warn('No controllable entity found — switching to observer mode');
                _observerMode = true;
            }

            if (_playerEntity && !_observerMode) {
                // 3. Hijack player from ECS
                _hijackPlayer(_playerEntity);

                // 4. Initialize cockpit systems
                _initCockpit(_playerEntity);

                // 5. Create orbit visualization entities
                _createOrbitEntities();
            } else if (_observerMode) {
                // Fallback observer: set camera, hide HUD
                _cameraMode = 'earth';
                _viewer.scene.screenSpaceCameraController.enableInputs = true;
                _viewer.camera.flyHome(0);
                var hud = document.getElementById('hudCanvas');
                if (hud) hud.style.display = 'none';
                _panelVisible.entityList = true;
                _panelVisible.flightData = false;
                _panelVisible.systems = false;
                if (typeof KeyboardHelp !== 'undefined') KeyboardHelp.setMode('observer');
            }

            // 6. Build entity list for UI
            _buildEntityList();

            // 7. Setup camera handlers
            _setupCameraHandlers();

            // 8. Setup keyboard
            _setupKeyboard();

            // 9. Init settings gear (load prefs, wire handlers)
            _initSettingsGear();
            _initSearchPanel();
            _initAnalyticsPanel();
            _initCyberLogPanel();
            _initAARPanel();
            _initStatusBoard();
            _initEngTimeline();
            _initEngagementStats();
            _initDataExport();
            _initAutopilotPanel();

            // 9b. Init planner click handler (orbit click → create node)
            _initPlannerClickHandler();

            // Setup entity picker (works in both modes)
            _setupEntityPicker();
            _setupWaypointPlacer();
            _buildVizGroups();

            // Init entity hover tooltip
            if (typeof EntityTooltip !== 'undefined') EntityTooltip.init(_viewer, _world);

            // Init cyber cockpit
            if (typeof CyberCockpit !== 'undefined') {
                CyberCockpit.init(_world);
                CyberCockpit.setPlayerTeam(_playerEntity ? _playerEntity.team : 'blue');
                // Auto-open cyber cockpit for static ground entities (cyber ops centers, command posts)
                if (_isStaticPlayer) CyberCockpit.show();
            }

            if (!_observerMode) {
                // 10. Position camera on player
                _positionInitialCamera();

                // 10. Init HUD
                var hudCanvas = document.getElementById('hudCanvas');
                if (hudCanvas) {
                    hudCanvas.width = hudCanvas.clientWidth;
                    hudCanvas.height = hudCanvas.clientHeight;
                    FighterHUD.init(hudCanvas);

                    window.addEventListener('resize', function() {
                        hudCanvas.width = hudCanvas.clientWidth;
                        hudCanvas.height = hudCanvas.clientHeight;
                        FighterHUD.resize();
                        if (typeof SpaceplaneHUD !== 'undefined') SpaceplaneHUD.resize(hudCanvas);
                    });
                }

                // 11. Init gamepad
                if (typeof GamepadInput !== 'undefined') GamepadInput.init();
            }
        }

        // 12. Init simulation subsystems (both modes)
        if (_audioEnabled && typeof SimAudio !== 'undefined') SimAudio.init();
        if (_visualFxEnabled && typeof SimEffects !== 'undefined') SimEffects.init(viewer);
        if (typeof WeatherSystem !== 'undefined') {
            var weatherCfg = (_scenarioJson && _scenarioJson.environment && _scenarioJson.environment.weather)
                ? _scenarioJson.environment.weather : null;
            if (weatherCfg) {
                WeatherSystem.init(viewer, weatherCfg.preset === 'custom' ? weatherCfg : weatherCfg.preset);
            } else {
                WeatherSystem.init(viewer);
            }
        }
        if (typeof EWSystem !== 'undefined') EWSystem.init();
        if (typeof Minimap !== 'undefined') Minimap.init(document.getElementById('minimapCanvas'));
        if (typeof ConjunctionSystem !== 'undefined') ConjunctionSystem.init(_world, viewer);

        // Load scenario regions (AOI, exclusion zones, engagement zones)
        _loadRegions(scenarioJson.regions || []);

        _started = true;
        _lastTickTime = null;

        return {
            world: _world,
            playerEntity: _playerEntity,
            playerName: _playerEntity ? _playerEntity.name : 'OBSERVER',
            entityCount: _world.entities.size,
            observerMode: _observerMode
        };
    }

    // -----------------------------------------------------------------------
    // Area-of-Interest Regions
    // -----------------------------------------------------------------------
    var REGION_TYPE_COLORS = {
        'engagement':  { fill: 'rgba(255,50,50,0.12)',   border: Cesium.Color.fromCssColorString('rgba(255,80,80,0.6)') },
        'exclusion':   { fill: 'rgba(255,200,0,0.10)',   border: Cesium.Color.fromCssColorString('rgba(255,200,0,0.6)') },
        'operational': { fill: 'rgba(0,150,255,0.10)',   border: Cesium.Color.fromCssColorString('rgba(0,150,255,0.5)') },
        'adiz':        { fill: 'rgba(255,100,0,0.10)',   border: Cesium.Color.fromCssColorString('rgba(255,130,30,0.6)') },
        'safe':        { fill: 'rgba(0,200,100,0.10)',   border: Cesium.Color.fromCssColorString('rgba(0,200,100,0.5)') },
        'objective':   { fill: 'rgba(200,0,255,0.12)',   border: Cesium.Color.fromCssColorString('rgba(200,100,255,0.6)') },
        'custom':      { fill: 'rgba(128,128,128,0.10)', border: Cesium.Color.fromCssColorString('rgba(180,180,180,0.5)') }
    };

    function _loadRegions(regions) {
        // Remove previous region entities
        for (var i = 0; i < _regionEntities.length; i++) {
            _viewer.entities.remove(_regionEntities[i]);
        }
        _regionEntities = [];

        if (!regions || regions.length === 0) return;

        for (var r = 0; r < regions.length; r++) {
            var reg = regions[r];
            var rType = reg.type || 'custom';
            var colors = REGION_TYPE_COLORS[rType] || REGION_TYPE_COLORS['custom'];
            var fillColor = reg.color ? Cesium.Color.fromCssColorString(reg.color).withAlpha(0.12)
                                      : Cesium.Color.fromCssColorString(colors.fill);
            var borderColor = reg.borderColor ? Cesium.Color.fromCssColorString(reg.borderColor)
                                               : colors.border;

            if (reg.shape === 'circle' && reg.center && reg.radius) {
                // Circle region
                var ent = _viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(reg.center[1], reg.center[0]),
                    ellipse: {
                        semiMajorAxis: reg.radius,
                        semiMinorAxis: reg.radius,
                        material: fillColor,
                        outline: true,
                        outlineColor: borderColor,
                        outlineWidth: 2,
                        height: 0
                    },
                    label: reg.name ? {
                        text: reg.name.toUpperCase(),
                        font: '12px monospace',
                        fillColor: borderColor,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        pixelOffset: new Cesium.Cartesian2(0, 0),
                        disableDepthTestDistance: 5000000
                    } : undefined
                });
                _regionEntities.push(ent);
            } else if (reg.shape === 'polygon' && reg.points && reg.points.length >= 3) {
                // Polygon region — points as [[lat,lon], [lat,lon], ...]
                var coords = [];
                for (var p = 0; p < reg.points.length; p++) {
                    coords.push(reg.points[p][1], reg.points[p][0]); // lon, lat
                }
                var ent2 = _viewer.entities.add({
                    polygon: {
                        hierarchy: Cesium.Cartesian3.fromDegreesArray(coords),
                        material: fillColor,
                        outline: true,
                        outlineColor: borderColor,
                        outlineWidth: 2,
                        height: 0
                    }
                });
                _regionEntities.push(ent2);

                // Label at centroid
                if (reg.name) {
                    var cLat = 0, cLon = 0;
                    for (var cp = 0; cp < reg.points.length; cp++) {
                        cLat += reg.points[cp][0];
                        cLon += reg.points[cp][1];
                    }
                    cLat /= reg.points.length;
                    cLon /= reg.points.length;
                    var lbl = _viewer.entities.add({
                        position: Cesium.Cartesian3.fromDegrees(cLon, cLat),
                        label: {
                            text: reg.name.toUpperCase(),
                            font: '13px monospace',
                            fillColor: borderColor,
                            outlineColor: Cesium.Color.BLACK,
                            outlineWidth: 2,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            verticalOrigin: Cesium.VerticalOrigin.CENTER,
                            disableDepthTestDistance: 5000000
                        }
                    });
                    _regionEntities.push(lbl);
                }
            } else if (reg.shape === 'rect' && reg.bounds) {
                // Rectangle region — bounds: [south, west, north, east] in degrees
                var ent3 = _viewer.entities.add({
                    rectangle: {
                        coordinates: Cesium.Rectangle.fromDegrees(
                            reg.bounds[1], reg.bounds[0], reg.bounds[3], reg.bounds[2]),
                        material: fillColor,
                        outline: true,
                        outlineColor: borderColor,
                        outlineWidth: 2,
                        height: 0
                    }
                });
                _regionEntities.push(ent3);

                // Label at center
                if (reg.name) {
                    var rLat = (reg.bounds[0] + reg.bounds[2]) / 2;
                    var rLon = (reg.bounds[1] + reg.bounds[3]) / 2;
                    var lbl2 = _viewer.entities.add({
                        position: Cesium.Cartesian3.fromDegrees(rLon, rLat),
                        label: {
                            text: reg.name.toUpperCase(),
                            font: '13px monospace',
                            fillColor: borderColor,
                            outlineColor: Cesium.Color.BLACK,
                            outlineWidth: 2,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            verticalOrigin: Cesium.VerticalOrigin.CENTER,
                            disableDepthTestDistance: 5000000
                        }
                    });
                    _regionEntities.push(lbl2);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Threat Assessment Overlay (SAM/radar/weapon engagement zones)
    // -----------------------------------------------------------------------
    function _toggleThreatOverlay() {
        _threatOverlayEnabled = !_threatOverlayEnabled;
        if (_threatOverlayEnabled) {
            _buildThreatOverlay();
        } else {
            _clearThreatOverlay();
        }
    }

    function _clearThreatOverlay() {
        for (var i = 0; i < _threatOverlayEntities.length; i++) {
            _viewer.entities.remove(_threatOverlayEntities[i]);
        }
        _threatOverlayEntities = [];
    }

    function _buildThreatOverlay() {
        _clearThreatOverlay();
        if (!_world) return;

        _world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var s = entity.state || {};
            var team = entity.team || 'neutral';
            var lat = s.lat || s.latitude;
            var lon = s.lon || s.longitude;
            if (lat == null || lon == null) return;

            var isEnemy = (_playerEntity && _playerEntity.team) ? (team !== _playerEntity.team) : (team === 'red');
            var threatColor = isEnemy ? Cesium.Color.RED : Cesium.Color.BLUE;
            var detectColor = isEnemy ? Cesium.Color.YELLOW : Cesium.Color.CYAN;

            // Check for weapon ranges (SAM batteries)
            var weaponRange = 0;
            var samComp = entity.getComponent ? entity.getComponent('weapons/sam_battery') : null;
            if (samComp && samComp.config) {
                weaponRange = samComp.config.maxRange_m || samComp.config.range_m || 0;
            }
            if (!weaponRange && entity._custom && entity._custom.payloads) {
                var payloads = entity._custom.payloads;
                if (payloads.indexOf && (payloads.indexOf('sam') >= 0 || payloads.indexOf('SAM') >= 0)) {
                    weaponRange = 150000; // default SAM range
                }
            }

            // Check for sensor ranges (radar)
            var sensorRange = 0;
            var radarComp = entity.getComponent ? entity.getComponent('sensors/radar') : null;
            if (radarComp && radarComp.config) {
                sensorRange = radarComp.config.maxRange_m || 0;
            }
            if (!sensorRange && entity._custom && entity._custom.sensors) {
                var sensors = entity._custom.sensors;
                for (var si = 0; si < sensors.length; si++) {
                    if (sensors[si].type === 'radar' && sensors[si].range_km) {
                        sensorRange = Math.max(sensorRange, sensors[si].range_km * 1000);
                    }
                }
            }

            var pos = Cesium.Cartesian3.fromDegrees(lon * (180 / Math.PI), lat * (180 / Math.PI));
            // Loader stores lat/lon in radians for runtime
            var latDeg = lat * (180 / Math.PI);
            var lonDeg = lon * (180 / Math.PI);

            // Weapon engagement zone (red/blue filled circle)
            if (weaponRange > 5000) {
                var wez = _viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg),
                    ellipse: {
                        semiMajorAxis: weaponRange,
                        semiMinorAxis: weaponRange,
                        height: 0,
                        material: threatColor.withAlpha(0.08),
                        outline: true,
                        outlineColor: threatColor.withAlpha(0.5),
                        outlineWidth: 2
                    },
                    label: {
                        text: (entity.name || entity.id) + ' WEZ',
                        font: '10px monospace',
                        fillColor: threatColor.withAlpha(0.7),
                        style: Cesium.LabelStyle.FILL,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        pixelOffset: new Cesium.Cartesian2(0, -15),
                        disableDepthTestDistance: 5000000,
                        show: weaponRange > 50000
                    }
                });
                _threatOverlayEntities.push(wez);
            }

            // Detection zone (yellow/cyan ring)
            if (sensorRange > 10000) {
                var dz = _viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg),
                    ellipse: {
                        semiMajorAxis: sensorRange,
                        semiMinorAxis: sensorRange,
                        height: 0,
                        material: detectColor.withAlpha(0.04),
                        outline: true,
                        outlineColor: detectColor.withAlpha(0.35),
                        outlineWidth: 1
                    }
                });
                _threatOverlayEntities.push(dz);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Weather Visual Overlay (rain/snow/fog on cockpit)
    // -----------------------------------------------------------------------
    var _lastWeatherClass = '';
    function _updateWeatherOverlay() {
        var overlay = document.getElementById('weatherOverlay');
        if (!overlay) return;

        // Only show in cockpit/chase camera
        var isCockpitView = (_cameraMode === 'cockpit' || _cameraMode === 'chase');
        if (!isCockpitView || _observerMode || typeof WeatherSystem === 'undefined') {
            overlay.style.display = 'none';
            return;
        }

        var alt = _playerState ? _playerState.alt || 0 : 0;
        if (alt > 15000) { overlay.style.display = 'none'; return; } // Above weather

        var vis = WeatherSystem.getVisibility(alt);
        var cloud = WeatherSystem.getCloudLayer(alt);

        var newClass = '';
        if (cloud.inCloud) {
            newClass = 'fog';
        } else if (vis < 3) {
            newClass = 'rain'; // Low vis = precipitation
        } else if (vis < 5) {
            // Light precip — check temperature proxy (snow above 5000m in cold)
            newClass = alt > 5000 ? 'snow' : 'rain';
        }

        if (newClass !== _lastWeatherClass) {
            overlay.className = newClass;
            _lastWeatherClass = newClass;
        }
        overlay.style.display = newClass ? 'block' : 'none';

        // Fog intensity based on visibility
        if (newClass === 'fog') {
            var fogAlpha = Math.min(0.6, (1.0 - vis / 5) * 0.5);
            overlay.style.background = 'radial-gradient(ellipse at center, rgba(200,200,210,0.0) 20%, rgba(180,180,190,' + (fogAlpha * 0.6) + ') 60%, rgba(160,160,170,' + fogAlpha + ') 100%)';
        }
    }

    // -----------------------------------------------------------------------
    // Mission Waypoint Planner
    // -----------------------------------------------------------------------
    function _toggleWaypointMode() {
        _waypointMode = !_waypointMode;
        _showMessage(_waypointMode ? 'WAYPOINT MODE: Click globe to add waypoints. Shift+W again to exit.' : 'WAYPOINT MODE OFF');
    }

    function _addWaypoint(lat, lon) {
        var DEG = 180 / Math.PI;
        var idx = _missionWaypoints.length;
        var wpName = 'WP' + (idx + 1);
        var alt = (_playerState && _playerState.alt > 100) ? _playerState.alt : 5000;

        // Create marker entity
        var marker = _viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, 100),
            point: {
                pixelSize: 10,
                color: Cesium.Color.fromCssColorString('#00ffaa'),
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 1,
                disableDepthTestDistance: 5000000
            },
            label: {
                text: wpName,
                font: '12px monospace',
                fillColor: Cesium.Color.fromCssColorString('#00ffaa'),
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                pixelOffset: new Cesium.Cartesian2(12, -5),
                disableDepthTestDistance: 5000000
            }
        });

        var wp = {
            lat: lat * Math.PI / 180,
            lon: lon * Math.PI / 180,
            alt: alt,
            name: wpName,
            cesiumEntity: marker,
            latDeg: lat,
            lonDeg: lon
        };
        _missionWaypoints.push(wp);
        _updateWaypointRoute();
        _showMessage(wpName + ' placed (' + lat.toFixed(2) + ', ' + lon.toFixed(2) + ')');
    }

    function _removeLastWaypoint() {
        if (_missionWaypoints.length === 0) return;
        var wp = _missionWaypoints.pop();
        if (wp.cesiumEntity) _viewer.entities.remove(wp.cesiumEntity);
        _updateWaypointRoute();
        _showMessage(wp.name + ' removed');
    }

    function _clearAllWaypoints() {
        for (var i = 0; i < _missionWaypoints.length; i++) {
            if (_missionWaypoints[i].cesiumEntity) {
                _viewer.entities.remove(_missionWaypoints[i].cesiumEntity);
            }
        }
        _missionWaypoints = [];
        if (_waypointRouteEntity) {
            _viewer.entities.remove(_waypointRouteEntity);
            _waypointRouteEntity = null;
        }
        _showMessage('All waypoints cleared');
    }

    function _updateWaypointRoute() {
        if (_waypointRouteEntity) {
            _viewer.entities.remove(_waypointRouteEntity);
            _waypointRouteEntity = null;
        }
        if (_missionWaypoints.length < 2) return;

        var positions = [];
        // Start from player position if available
        if (_playerState && _playerState.lat != null) {
            positions.push(Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, 100));
        }
        for (var i = 0; i < _missionWaypoints.length; i++) {
            positions.push(Cesium.Cartesian3.fromDegrees(
                _missionWaypoints[i].lonDeg,
                _missionWaypoints[i].latDeg,
                100
            ));
        }

        _waypointRouteEntity = _viewer.entities.add({
            polyline: {
                positions: positions,
                width: 2,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.fromCssColorString('rgba(0,255,170,0.6)'),
                    dashLength: 16
                }),
                clampToGround: false
            }
        });
    }

    function _getWaypointInfo() {
        if (_missionWaypoints.length === 0) return null;
        if (!_playerState || _playerState.lat == null) return null;

        var DEG = 180 / Math.PI;
        var pLat = _playerState.lat;
        var pLon = _playerState.lon;

        // Find nearest unvisited waypoint (simple sequential for now)
        var result = [];
        var prevLat = pLat, prevLon = pLon;
        for (var i = 0; i < _missionWaypoints.length; i++) {
            var wp = _missionWaypoints[i];
            var dLat = wp.lat - prevLat;
            var dLon = wp.lon - prevLon;
            var dist = Math.sqrt(dLat * dLat + dLon * dLon * Math.cos(prevLat) * Math.cos(prevLat)) * 6371000;
            var brg = Math.atan2(dLon * Math.cos(wp.lat), dLat);
            if (brg < 0) brg += 2 * Math.PI;
            var eta = (_playerState.speed > 10) ? dist / _playerState.speed : Infinity;

            result.push({
                name: wp.name,
                dist_m: dist,
                bearing_rad: brg,
                eta_s: eta
            });
            prevLat = wp.lat;
            prevLon = wp.lon;
        }
        return result;
    }

    // Setup globe click handler for waypoint placement
    function _setupWaypointPlacer() {
        var handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
        handler.setInputAction(function(click) {
            if (!_waypointMode) return;

            var ray = _viewer.camera.getPickRay(click.position);
            if (!ray) return;
            var cartesian = _viewer.scene.globe.pick(ray, _viewer.scene);
            if (!cartesian) return;
            var carto = Cesium.Cartographic.fromCartesian(cartesian);
            var latDeg = carto.latitude * 180 / Math.PI;
            var lonDeg = carto.longitude * 180 / Math.PI;

            _addWaypoint(latDeg, lonDeg);
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
    }

    // -----------------------------------------------------------------------
    // Multi-Platform Spread Launch — generate N copies with swept parameter
    // -----------------------------------------------------------------------
    let _spreadEntities = [];

    function _openSpreadDialog() {
        // Remove existing dialog
        var existing = document.getElementById('spreadDialog');
        if (existing) { existing.remove(); return; }

        var dlg = document.createElement('div');
        dlg.id = 'spreadDialog';
        dlg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10001;background:#1a1a2a;border:1px solid #44aaff;border-radius:8px;padding:20px;color:#ccc;font-family:monospace;width:380px;box-shadow:0 0 30px rgba(68,170,255,0.3);';

        dlg.innerHTML = '<div style="font-size:14px;color:#44aaff;font-weight:bold;margin-bottom:12px;letter-spacing:2px;">SPREAD LAUNCH</div>' +
            '<div style="font-size:10px;color:#888;margin-bottom:10px;">Generate N entities with swept parameter</div>' +
            '<div style="margin-bottom:8px;"><label style="font-size:11px;color:#aaa;">Platform Type:</label><br>' +
            '<select id="spreadType" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;">' +
            '<option value="aircraft">Aircraft (F-16)</option>' +
            '<option value="satellite_leo">Satellite (LEO 400km)</option>' +
            '<option value="satellite_geo">Satellite (GEO)</option>' +
            '<option value="launch">Launch Vehicle</option>' +
            '</select></div>' +
            '<div style="margin-bottom:8px;"><label style="font-size:11px;color:#aaa;">Sweep Parameter:</label><br>' +
            '<select id="spreadParam" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;">' +
            '<option value="heading">Heading (0-360°)</option>' +
            '<option value="inclination">Inclination (0-180°)</option>' +
            '<option value="raan">RAAN (0-360°)</option>' +
            '<option value="altitude">Altitude</option>' +
            '<option value="speed">Speed</option>' +
            '</select></div>' +
            '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
            '<div style="flex:1;"><label style="font-size:11px;color:#aaa;">Count:</label><br>' +
            '<input id="spreadCount" type="number" value="36" min="2" max="720" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;"></div>' +
            '<div style="flex:1;"><label style="font-size:11px;color:#aaa;">From:</label><br>' +
            '<input id="spreadFrom" type="number" value="0" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;"></div>' +
            '<div style="flex:1;"><label style="font-size:11px;color:#aaa;">To:</label><br>' +
            '<input id="spreadTo" type="number" value="360" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;"></div>' +
            '</div>' +
            '<div style="margin-bottom:8px;"><label style="font-size:11px;color:#aaa;">Team:</label><br>' +
            '<select id="spreadTeam" style="width:100%;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;">' +
            '<option value="blue">Blue</option><option value="red">Red</option><option value="neutral">Neutral</option>' +
            '</select></div>' +
            '<div style="margin-bottom:12px;"><label style="font-size:11px;color:#aaa;">Origin (if aircraft/launch):</label><br>' +
            '<div style="display:flex;gap:6px;">' +
            '<input id="spreadLat" type="number" value="28.5" step="0.1" placeholder="Lat" style="flex:1;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;">' +
            '<input id="spreadLon" type="number" value="-80.6" step="0.1" placeholder="Lon" style="flex:1;background:#111;color:#ccc;border:1px solid #444;padding:4px;font-family:monospace;">' +
            '</div></div>' +
            '<div style="display:flex;gap:8px;">' +
            '<button id="spreadGo" style="flex:1;padding:8px;background:#224466;color:#44aaff;border:1px solid #44aaff;border-radius:4px;font-family:monospace;cursor:pointer;font-weight:bold;">GENERATE</button>' +
            '<button id="spreadClear" style="flex:1;padding:8px;background:#442222;color:#ff6644;border:1px solid #ff6644;border-radius:4px;font-family:monospace;cursor:pointer;">CLEAR SPREAD</button>' +
            '<button id="spreadClose" style="padding:8px;background:#333;color:#aaa;border:1px solid #555;border-radius:4px;font-family:monospace;cursor:pointer;">X</button>' +
            '</div>';

        document.body.appendChild(dlg);

        // Update defaults when type changes
        document.getElementById('spreadType').addEventListener('change', function() {
            var param = document.getElementById('spreadParam');
            var type = this.value;
            if (type === 'satellite_leo' || type === 'satellite_geo') {
                param.value = 'inclination';
                document.getElementById('spreadFrom').value = '0';
                document.getElementById('spreadTo').value = '180';
            } else if (type === 'launch') {
                param.value = 'heading';
                document.getElementById('spreadFrom').value = '0';
                document.getElementById('spreadTo').value = '360';
            } else {
                param.value = 'heading';
                document.getElementById('spreadFrom').value = '0';
                document.getElementById('spreadTo').value = '360';
            }
        });

        document.getElementById('spreadGo').addEventListener('click', function() { _executeSpread(); });
        document.getElementById('spreadClear').addEventListener('click', function() { _clearSpread(); });
        document.getElementById('spreadClose').addEventListener('click', function() { dlg.remove(); });

        // Prevent keyboard events from triggering flight controls
        dlg.addEventListener('keydown', function(e) { e.stopPropagation(); });
        dlg.addEventListener('keyup', function(e) { e.stopPropagation(); });
    }

    function _executeSpread() {
        var type = document.getElementById('spreadType').value;
        var param = document.getElementById('spreadParam').value;
        var count = parseInt(document.getElementById('spreadCount').value) || 36;
        var fromVal = parseFloat(document.getElementById('spreadFrom').value) || 0;
        var toVal = parseFloat(document.getElementById('spreadTo').value) || 360;
        var team = document.getElementById('spreadTeam').value;
        var originLat = parseFloat(document.getElementById('spreadLat').value) || 28.5;
        var originLon = parseFloat(document.getElementById('spreadLon').value) || -80.6;

        count = Math.min(count, 720);
        var step = (toVal - fromVal) / count;
        var DEG_R = Math.PI / 180;

        _showMessage('GENERATING ' + count + ' ENTITIES...');

        for (var i = 0; i < count; i++) {
            var val = fromVal + i * step;
            var entityDef = _buildSpreadEntity(type, param, val, i, team, originLat, originLon);
            if (!entityDef) continue;

            // Add to ECS world via ScenarioLoader
            var entity = ScenarioLoader.addEntity(_world, entityDef, _viewer);
            if (entity) {
                _spreadEntities.push(entity.id);
            }
        }

        _buildVizGroups();
        _buildEntityList();
        _showMessage(count + ' ENTITIES GENERATED (' + param + ' ' + fromVal + '° to ' + toVal + '°)');
    }

    function _buildSpreadEntity(type, param, val, index, team, lat, lon) {
        var id = 'spread_' + index;
        var name = 'SP-' + (index + 1).toString().padStart(3, '0');
        var DEG_R = Math.PI / 180;

        // Color gradient across the spread — rainbow from red to violet
        var hue = (index / Math.max(1, parseInt(document.getElementById('spreadCount').value) || 36)) * 300;
        var color = 'hsl(' + hue + ', 80%, 55%)';

        if (type === 'aircraft') {
            var def = {
                id: id, name: name, type: 'aircraft', team: team,
                initialState: {
                    lat: lat, lon: lon, alt: 5000, speed: 250, heading: 90, gamma: 0
                },
                components: {
                    physics: { type: 'flight3dof', config: 'f16' },
                    visual: { type: 'point', color: color, trail: true, size: 6 }
                }
            };
            if (param === 'heading') def.initialState.heading = val;
            else if (param === 'altitude') def.initialState.alt = val;
            else if (param === 'speed') def.initialState.speed = val;
            return def;

        } else if (type === 'satellite_leo') {
            var def2 = {
                id: id, name: name, type: 'satellite', team: team,
                initialState: {
                    semiMajorAxis: 6778, eccentricity: 0.001,
                    inclination: 51.6, raan: 0, argPerigee: 0, meanAnomaly: index * (360 / Math.max(1, parseInt(document.getElementById('spreadCount').value)))
                },
                components: {
                    physics: { type: 'orbital_2body' },
                    visual: { type: 'satellite', color: color, size: 5, showOrbit: true }
                }
            };
            if (param === 'inclination') def2.initialState.inclination = val;
            else if (param === 'raan') def2.initialState.raan = val;
            else if (param === 'altitude') {
                var sma = 6371 + val; // val in km
                def2.initialState.semiMajorAxis = sma;
            }
            return def2;

        } else if (type === 'satellite_geo') {
            var def3 = {
                id: id, name: name, type: 'satellite', team: team,
                initialState: {
                    semiMajorAxis: 42164, eccentricity: 0.0001,
                    inclination: 0.05, raan: 0, argPerigee: 0, meanAnomaly: index * (360 / Math.max(1, parseInt(document.getElementById('spreadCount').value)))
                },
                components: {
                    physics: { type: 'orbital_2body' },
                    visual: { type: 'satellite', color: color, size: 6, showOrbit: true }
                }
            };
            if (param === 'inclination') def3.initialState.inclination = val;
            else if (param === 'raan') def3.initialState.raan = val;
            return def3;

        } else if (type === 'launch') {
            // Launch vehicles: start from ground, heading swept, with gamma=80° (nearly vertical)
            var def4 = {
                id: id, name: name, type: 'aircraft', team: team,
                initialState: {
                    lat: lat, lon: lon, alt: 100, speed: 50, heading: 90, gamma: 80
                },
                components: {
                    physics: { type: 'flight3dof', config: 'spaceplane' },
                    visual: { type: 'point', color: color, trail: true, size: 5 }
                },
                _custom: {
                    propulsion: { modes: ['ROCKET'], rocketEngine: 'RS25' }
                }
            };
            if (param === 'heading') def4.initialState.heading = val;
            else if (param === 'altitude') def4.initialState.alt = val;
            else if (param === 'speed') def4.initialState.speed = val;
            return def4;
        }
        return null;
    }

    function _clearSpread() {
        for (var i = 0; i < _spreadEntities.length; i++) {
            var ent = _world.getEntity(_spreadEntities[i]);
            if (ent) {
                // Remove Cesium visuals
                var visComp = ent.getComponent('visual');
                if (visComp && typeof visComp.cleanup === 'function') visComp.cleanup(_world);
                _world.removeEntity(_spreadEntities[i]);
            }
        }
        _spreadEntities = [];
        _buildVizGroups();
        _buildEntityList();
        _showMessage('SPREAD ENTITIES CLEARED');
    }

    // -----------------------------------------------------------------------
    // Player selection
    // -----------------------------------------------------------------------
    function _selectPlayer(world, preferredId) {
        // Preferred ID — accept any entity with physics (including static_ground)
        if (preferredId) {
            var e = world.getEntity(preferredId);
            if (e && e.getComponent('physics')) return e;
        }

        // First entity with player_input control
        var candidates = world.entitiesWith('control');
        for (var i = 0; i < candidates.length; i++) {
            var ctrl = candidates[i].getComponent('control');
            if (ctrl && ctrl.config && ctrl.config.type === 'player_input') {
                return candidates[i];
            }
        }

        // First aircraft with flight3dof
        var physEntities = world.entitiesWith('physics');
        for (var j = 0; j < physEntities.length; j++) {
            var phys = physEntities[j].getComponent('physics');
            if (phys && phys.config && phys.config.type === 'flight3dof') {
                return physEntities[j];
            }
        }

        // First entity with any non-static physics (orbital, naval)
        for (var k = 0; k < physEntities.length; k++) {
            var p = physEntities[k].getComponent('physics');
            if (p && p.config && p.config.type !== 'static_ground') {
                return physEntities[k];
            }
        }

        // Last resort: first entity with static_ground physics (cyber/command)
        if (physEntities.length > 0) return physEntities[0];

        return null;
    }

    // -----------------------------------------------------------------------
    // Hijack player from ECS
    // -----------------------------------------------------------------------
    function _hijackPlayer(entity) {
        // Disable ECS systems from driving this entity
        var phys = entity.getComponent('physics');
        if (phys) phys.enabled = false;

        var ctrl = entity.getComponent('control');
        if (ctrl) ctrl.enabled = false;

        var ai = entity.getComponent('ai');
        if (ai) ai.enabled = false;

        // Visual component stays enabled — ECS VisualizationSystem still renders it
    }

    // -----------------------------------------------------------------------
    // Init cockpit systems from entity data
    // -----------------------------------------------------------------------
    function _initCockpit(entity) {
        _playerState = entity.state;
        _playerDef = entity.def || {};

        // Determine engine config from physics component.
        // The unified physics model treats all entities the same — no type flags needed.
        // Orbital entities use SPACEPLANE_CONFIG as a reasonable aero+thrust default.
        // Static ground entities (cyber ops, command posts) skip flight physics entirely.
        var phys = entity.getComponent('physics');
        var physType = phys && phys.config && phys.config.type;

        _isStaticPlayer = (physType === 'static_ground');

        if (_isStaticPlayer) {
            // Static ground entity — no flight physics, cyber cockpit is primary UI
            _playerConfig = Object.assign({}, FighterSimEngine.F16_CONFIG); // placeholder, unused
        } else if (physType === 'orbital_2body') {
            _playerConfig = Object.assign({}, FighterSimEngine.SPACEPLANE_CONFIG);
        } else if (phys && phys._engineConfig) {
            _playerConfig = Object.assign({}, phys._engineConfig);
        } else {
            var configName = (phys && phys.config && phys.config.config) || 'f16';
            _playerConfig = Object.assign({},
                (configName === 'spaceplane') ?
                    FighterSimEngine.SPACEPLANE_CONFIG : FighterSimEngine.F16_CONFIG);
        }

        // Determine available propulsion modes (flat list — P cycles all)
        _propModes = _resolvePropModes(entity);
        _propModeIndex = 0;

        // Set initial propulsion mode — high-altitude entities default to OMS 25kN
        // (AIR mode has zero thrust at orbital altitude due to density lapse,
        //  and micro-thrusters like ION 0.5N are too weak for maneuvering)
        if (!_playerState.forcedPropMode) {
            var defaultEntry = _propModes[0];
            var isHighAlt = (_playerState.alt || 0) > 100000;
            if (isHighAlt) {
                // Find OMS 25kN by name, else first engine with thrust >= 25kN,
                // else first ROCKET of any size
                var firstRocketIdx = -1;
                var firstUsableIdx = -1;
                for (var pi = 0; pi < _propModes.length; pi++) {
                    if (_propModes[pi].mode === 'ROCKET') {
                        if (firstRocketIdx < 0) firstRocketIdx = pi;
                        if (_propModes[pi].name === 'OMS 25kN') {
                            defaultEntry = _propModes[pi];
                            _propModeIndex = pi;
                            firstUsableIdx = -1; // signal found exact match
                            break;
                        }
                        if (firstUsableIdx < 0 && _propModes[pi].thrust >= 25000) {
                            firstUsableIdx = pi;
                        }
                    }
                }
                // If no exact OMS match, use first usable or first rocket
                if (defaultEntry === _propModes[0] && (firstUsableIdx >= 0 || firstRocketIdx >= 0)) {
                    var idx = firstUsableIdx >= 0 ? firstUsableIdx : firstRocketIdx;
                    defaultEntry = _propModes[idx];
                    _propModeIndex = idx;
                }
            }
            _playerState.forcedPropMode = defaultEntry.mode;
            _playerState.propulsionMode = defaultEntry.mode;
            if (defaultEntry.mode === 'ROCKET' && defaultEntry.thrust) {
                _playerConfig.thrust_rocket = defaultEntry.thrust;
            }
        }

        // For orbital entities, derive heading/gamma from ECI velocity
        if (physType === 'orbital_2body' && phys && phys._eciVel && phys._eciPos) {
            _deriveFlightStateFromECI(phys._eciPos, phys._eciVel, _playerState);
        }

        // Ensure critical state fields exist.
        // High-altitude entities default to coasting (engine off, zero throttle).
        // Low-altitude entities default to flying (engine on, 60% throttle).
        var isHighAlt = (_playerState.alt || 0) > 100000;
        if (_playerState.throttle === undefined) _playerState.throttle = isHighAlt ? 0 : 0.6;
        if (_playerState.engineOn === undefined) _playerState.engineOn = !isHighAlt;
        if (_playerState.gearDown === undefined) _playerState.gearDown = false;
        if (_playerState.flapsDown === undefined) _playerState.flapsDown = false;
        if (_playerState.speedBrakeOut === undefined) _playerState.speedBrakeOut = false;
        if (_playerState.brakesOn === undefined) _playerState.brakesOn = false;
        if (_playerState.infiniteFuel === undefined) _playerState.infiniteFuel = true;
        if (_playerState.weaponMass === undefined) _playerState.weaponMass = 0;
        if (_playerState.phase === undefined) _playerState.phase = 'FLIGHT';
        if (_playerState.alpha === undefined) _playerState.alpha = 0;
        if (_playerState.pitch === undefined) _playerState.pitch = _playerState.gamma || 0;
        if (_playerState.roll === undefined) _playerState.roll = 0;
        if (_playerState.mach === undefined) _playerState.mach = 0;
        if (_playerState.g_load === undefined) _playerState.g_load = 1;
        if (_playerState.yawOffset === undefined) _playerState.yawOffset = 0;
        if (_playerState.trimAlpha === undefined) _playerState.trimAlpha = 2 * Math.PI / 180;  // 2° default trim

        // Set ground altitude reference for non-Edwards airports
        if (_playerState.phase === 'PARKED' || _playerState.phase === 'LANDED' || _playerState.phase === 'STATIC') {
            _playerState.groundAlt = _playerState.alt;
        }

        // Create autopilot
        if (typeof FighterAutopilot !== 'undefined') {
            _autopilotState = FighterAutopilot.createAutopilotState();
        }

        // Build weapon & sensor lists from entity definition
        _initWeaponsAndSensors(entity);

        // Initialize quest system if entity has quest data
        if (_playerDef._quest) {
            _initQuest(_playerDef._quest);
        }
    }

    function _resolvePropModes(entity) {
        var def = entity.def || {};
        var entries = [];

        function addRocketEngines(selected) {
            for (var i = 0; i < ROCKET_ENGINES.length; i++) {
                // If selected list provided, only include matching engines
                if (selected && selected.indexOf(ROCKET_ENGINES[i].name) < 0) continue;
                entries.push({
                    name: ROCKET_ENGINES[i].name,
                    mode: 'ROCKET',
                    thrust: ROCKET_ENGINES[i].thrust,
                    desc: ROCKET_ENGINES[i].desc,
                    color: 'alert'
                });
            }
        }

        // From Platform Builder _custom metadata
        if (def._custom && def._custom.propulsion) {
            var p = def._custom.propulsion;
            if (p.taxi) entries.push({ name: 'TAXI', mode: 'TAXI', color: 'blue' });
            if (p.air) entries.push({ name: 'AIR', mode: 'AIR', color: '' });
            if (p.hypersonic) entries.push({ name: 'HYPERSONIC', mode: 'HYPERSONIC', color: 'warn' });
            // engines[] selects specific rocket engines; rocket:true = all rockets
            if (p.engines && p.engines.length > 0) {
                addRocketEngines(p.engines);
            } else if (p.rocket) {
                addRocketEngines();
            }
            if (entries.length > 0) return entries;
        }

        // From components.propulsion (legacy modes[] or new taxi/air/hypersonic/engines[] format)
        var compDef = (def.components && def.components.propulsion) || {};
        if (compDef.taxi || compDef.air || compDef.hypersonic || (compDef.engines && compDef.engines.length > 0)) {
            if (compDef.taxi) entries.push({ name: 'TAXI', mode: 'TAXI', color: 'blue' });
            if (compDef.air) entries.push({ name: 'AIR', mode: 'AIR', color: '' });
            if (compDef.hypersonic) entries.push({ name: 'HYPERSONIC', mode: 'HYPERSONIC', color: 'warn' });
            if (compDef.engines && compDef.engines.length > 0) addRocketEngines(compDef.engines);
            if (entries.length > 0) return entries;
        }
        if (compDef.modes && compDef.modes.length > 0) {
            compDef.modes.forEach(function(m) {
                var mode = m.toUpperCase();
                if (mode === 'ROCKET') {
                    addRocketEngines();
                } else {
                    var color = mode === 'TAXI' ? 'blue' : mode === 'HYPERSONIC' ? 'warn' : '';
                    entries.push({ name: mode, mode: mode, color: color });
                }
            });
            if (entries.length > 0) return entries;
        }

        // Detect from config
        entries.push({ name: 'AIR', mode: 'AIR', color: '' });
        if (_playerConfig && _playerConfig.thrust_hypersonic) {
            entries.push({ name: 'HYPERSONIC', mode: 'HYPERSONIC', color: 'warn' });
        }
        if (_playerConfig && _playerConfig.thrust_rocket) {
            addRocketEngines();
        }
        return entries;
    }

    function _initWeaponsAndSensors(entity) {
        var def = entity.def || {};
        var custom = def._custom || {};

        // --- Weapons ---
        _weaponList = [];
        _weaponIndex = -1;

        // From _custom payloads
        if (custom.payloads) {
            var p = custom.payloads;
            if (p.a2a)     _weaponList.push({ name: 'AIM-120', type: 'a2a', count: 6, maxCount: 6 });
            if (p.a2g)     _weaponList.push({ name: 'GBU-31', type: 'a2g', count: 4, maxCount: 4 });
            if (p.kkv)     _weaponList.push({ name: 'KKV',    type: 'kkv', count: 2, maxCount: 2 });
            if (p.jammer)  _weaponList.push({ name: 'JAMMER', type: 'jammer', count: 1, maxCount: 1, active: false });
            if (p.decoys)  _weaponList.push({ name: 'DECOY',  type: 'decoy', count: 30, maxCount: 30 });
            if (p.nuclear_warhead) _weaponList.push({ name: 'NUKE', type: 'nuclear', count: 1, maxCount: 1,
                yield_kt: p.nuclear_warhead.yield_kt || 500 });
            if (p.nuclear_cruise) _weaponList.push({ name: 'AGM-86B', type: 'cruise', count: 1, maxCount: 1,
                yield_kt: p.nuclear_cruise.yield_kt || 150 });
            if (p.space_debris) _weaponList.push({ name: 'DEBRIS', type: 'debris', count: 100, maxCount: 100 });
        }

        // From weapon components (SAM, fighter_loadout, etc.)
        var wComp = entity.getComponent('weapons') || entity.getComponent('weapon');
        if (wComp && wComp.config) {
            var wc = wComp.config;
            if (wc.type === 'fighter_loadout' || wc.type === 'a2a_missile') {
                if (!_weaponList.length) {
                    _weaponList.push({ name: 'AIM-120', type: 'a2a', count: 4, maxCount: 4 });
                    _weaponList.push({ name: 'AIM-9',   type: 'a2a_short', count: 2, maxCount: 2 });
                    _weaponList.push({ name: 'GUN',     type: 'gun', count: 500, maxCount: 500 });
                }
            }
        }

        // Default loadout for any fighter-type entity
        if (!_weaponList.length && (def.type === 'aircraft' || def.type === 'fighter')) {
            _weaponList.push({ name: 'AIM-120', type: 'a2a', count: 4, maxCount: 4 });
            _weaponList.push({ name: 'AIM-9',   type: 'a2a_short', count: 2, maxCount: 2 });
            _weaponList.push({ name: 'GUN',     type: 'gun', count: 500, maxCount: 500 });
        }

        if (_weaponList.length > 0) _weaponIndex = 0;

        // --- Sensors ---
        _sensorList = [];
        _sensorIndex = -1;

        if (custom.sensors) {
            var s = custom.sensors;
            if (s.radar && s.radar.enabled)   _sensorList.push({ name: 'RADAR',  type: 'radar' });
            if (s.optical && s.optical.enabled) _sensorList.push({ name: 'EO/IR',  type: 'optical' });
            if (s.ir && s.ir.enabled)          _sensorList.push({ name: 'IR',     type: 'ir' });
            if (s.sar && s.sar.enabled)        _sensorList.push({ name: 'SAR',    type: 'sar' });
            if (s.sigint && s.sigint.enabled)  _sensorList.push({ name: 'SIGINT', type: 'sigint' });
            if (s.lidar && s.lidar.enabled)    _sensorList.push({ name: 'LIDAR',  type: 'lidar' });
        }

        // From sensor component
        var sComp = entity.getComponent('sensors') || entity.getComponent('sensor');
        if (sComp && sComp.config) {
            if (sComp.config.type === 'radar' && !_sensorList.some(function(s) { return s.type === 'radar'; })) {
                _sensorList.push({ name: 'RADAR', type: 'radar' });
            }
        }

        // Default sensor loadout — all platforms get at least RADAR
        if (!_sensorList.length) {
            _sensorList.push({ name: 'RADAR', type: 'radar' });
        }
    }

    function _cycleWeapon() {
        if (_weaponList.length === 0) {
            _showMessage('NO WEAPONS');
            return;
        }
        _weaponIndex = (_weaponIndex + 1) % _weaponList.length;
        var w = _weaponList[_weaponIndex];
        _showMessage(w.name + ' ×' + w.count);
    }

    function _fireWeapon() {
        if (_weaponIndex < 0 || _weaponIndex >= _weaponList.length) {
            _showMessage('NO WEAPON SELECTED');
            return;
        }
        var w = _weaponList[_weaponIndex];
        if (w.count <= 0) {
            _showMessage(w.name + ' EMPTY');
            return;
        }

        if (w.type === 'jammer') {
            w.active = !w.active;
            _showMessage(w.name + (w.active ? ' ON' : ' OFF'));
            return;
        }

        w.count--;
        if (w.type === 'nuclear' || w.type === 'cruise') {
            _showMessage(w.name + ' LAUNCH — ' + (w.yield_kt || 0) + ' kT');
        } else if (w.type === 'gun') {
            w.count = Math.max(0, w.count - 19);  // 20 rounds per burst
            _showMessage('GUN BURST — ' + w.count + ' RND');
        } else {
            _showMessage(w.name + ' AWAY — ' + w.count + ' REM');
        }
    }

    function _cycleSensor() {
        if (_sensorList.length === 0) {
            _showMessage('NO SENSORS');
            return;
        }
        // Cycle: -1 (OFF) → 0 → 1 → ... → N-1 → -1 (OFF)
        _sensorIndex++;
        if (_sensorIndex >= _sensorList.length) _sensorIndex = -1;

        if (_sensorIndex < 0) {
            _showMessage('SENSOR OFF');
            _removeSensorViewEffects();
        } else {
            var s = _sensorList[_sensorIndex];
            var filter = SENSOR_FILTERS[s.type];
            if (filter) {
                _applySensorViewEffects(s.type);
                _showMessage('SENSOR: ' + s.name + ' — ' + filter.label);
            } else {
                // Non-visual sensor (radar, sar, sigint, lidar) — HUD info only
                _removeSensorViewEffects();
                _showMessage('SENSOR: ' + s.name);
            }
        }
    }

    function _applySensorViewEffects(sensorType) {
        var filter = SENSOR_FILTERS[sensorType];
        if (!filter) { _removeSensorViewEffects(); return; }

        // Apply CSS filter to cesium container (not HUD)
        var container = document.getElementById('cesiumContainer');
        if (container) container.style.filter = filter.css;
        _activeSensorFilter = sensorType;

        // Enhance darkness: disable atmospheric glow and fog for sensor realism
        if (_viewer) {
            _viewer.scene.globe.showGroundAtmosphere = false;
            _viewer.scene.fog.enabled = false;
        }

        // Create or update noise overlay
        _startSensorNoise(filter.noise);
    }

    function _removeSensorViewEffects() {
        var container = document.getElementById('cesiumContainer');
        _activeSensorFilter = null;

        // Restore atmospheric glow and fog
        if (_viewer) {
            _viewer.scene.globe.showGroundAtmosphere = true;
            _viewer.scene.fog.enabled = true;
        }

        // If display mode is active, restore its effects instead of clearing
        if (_displayMode > 0) {
            var dm = DISPLAY_MODE_FILTERS[_displayMode];
            if (dm && container) {
                container.style.filter = dm.css;
                _startSensorNoise(dm.noise);
            }
        } else {
            if (container) container.style.filter = '';
            _stopSensorNoise();
        }
    }

    // --- Pilot display mode (NVG / FLIR) ---
    function _cycleDisplayMode() {
        _displayMode = (_displayMode + 1) % 3;
        if (_displayMode === 0) {
            _removeDisplayModeEffects();
            _showMessage('DISPLAY: NORMAL');
        } else {
            var dm = DISPLAY_MODE_FILTERS[_displayMode];
            _applyDisplayModeEffects();
            _showMessage('DISPLAY: ' + dm.label);
        }
    }

    function _applyDisplayModeEffects() {
        var dm = DISPLAY_MODE_FILTERS[_displayMode];
        if (!dm) { _removeDisplayModeEffects(); return; }

        // If sensor view is active, sensor view takes priority — don't override
        if (_activeSensorFilter) return;

        var container = document.getElementById('cesiumContainer');
        if (container) container.style.filter = dm.css;

        // Noise overlay for display mode
        _startSensorNoise(dm.noise);
    }

    function _removeDisplayModeEffects() {
        // Only remove if sensor view is not active (sensor view owns the filter when active)
        if (_activeSensorFilter) return;

        var container = document.getElementById('cesiumContainer');
        if (container) container.style.filter = '';
        _stopSensorNoise();
    }

    function _startSensorNoise(opacity) {
        if (!_sensorNoiseCanvas) {
            _sensorNoiseCanvas = document.createElement('canvas');
            _sensorNoiseCanvas.width = 256;
            _sensorNoiseCanvas.height = 256;
            _sensorNoiseCanvas.style.cssText =
                'position:absolute;top:0;left:0;width:100%;height:100%;' +
                'pointer-events:none;z-index:5;mix-blend-mode:overlay;';
            var container = document.getElementById('cesiumContainer');
            if (container) container.appendChild(_sensorNoiseCanvas);
            _sensorNoiseCtx = _sensorNoiseCanvas.getContext('2d');
        }
        _sensorNoiseCanvas.style.display = 'block';
        _sensorNoiseCanvas.style.opacity = opacity;

        // Animate noise at 60fps
        function drawNoise() {
            var w = 256, h = 256;
            var imgData = _sensorNoiseCtx.createImageData(w, h);
            var d = imgData.data;
            for (var i = 0; i < d.length; i += 4) {
                var v = (Math.random() * 255) | 0;
                d[i] = v; d[i+1] = v; d[i+2] = v; d[i+3] = 255;
            }
            _sensorNoiseCtx.putImageData(imgData, 0, 0);
            _sensorNoiseAnimFrame = requestAnimationFrame(drawNoise);
        }
        if (_sensorNoiseAnimFrame) cancelAnimationFrame(_sensorNoiseAnimFrame);
        drawNoise();
    }

    function _stopSensorNoise() {
        if (_sensorNoiseAnimFrame) {
            cancelAnimationFrame(_sensorNoiseAnimFrame);
            _sensorNoiseAnimFrame = null;
        }
        if (_sensorNoiseCanvas) {
            _sensorNoiseCanvas.style.display = 'none';
        }
    }

    // -----------------------------------------------------------------------
    // Quest / Mission Guidance System
    // -----------------------------------------------------------------------

    function _initQuest(questDef) {
        _questActive = true;
        _questComplete = false;
        _questCurrentWP = 0;
        _questMode = questDef.mode || 'takeoff';

        // Set ground altitude from quest definition (for non-Edwards airports in landing mode)
        if (questDef.groundAlt != null && _playerState) {
            _playerState.groundAlt = questDef.groundAlt;
        }

        // Route altitude for polyline and markers
        _questRouteAlt = questDef.routeAlt || ((_playerState ? _playerState.alt : 38) + 2);

        // Parse waypoints (convert deg → rad for distance/bearing calculations)
        _questWaypoints = (questDef.waypoints || []).map(function(wp) {
            return {
                lat: wp.lat * DEG,
                lon: wp.lon * DEG,
                latDeg: wp.lat,
                lonDeg: wp.lon,
                radius: wp.radius || 200,
                name: wp.name || 'WAYPOINT',
                msg: wp.msg || '',
                hint: wp.hint || '',
                reached: false
            };
        });

        // Parse milestones
        _questMilestones = (questDef.milestones || []).map(function(ms) {
            return {
                type: ms.type,
                value: ms.value,
                msg: ms.msg || '',
                triggered: false
            };
        });

        // Create Cesium visualization
        if (_viewer && _questWaypoints.length > 0) {
            _createQuestVisuals();
        }

        // Show initial objective — configurable per quest mode
        var initialMsg = questDef.initialMsg || (_questMode === 'landing'
            ? 'Begin approach — reduce throttle, descend'
            : 'Press E to start engine');
        var initialHint = questDef.initialHint || (_questMode === 'landing'
            ? 'Nose down gently (S/Down). Follow the approach path.'
            : 'Throttle up (W/Up), release B to roll. P cycles TAXI/AIR modes.');

        _updateQuestPanel(
            initialMsg,
            initialHint,
            'Waypoint 1/' + _questWaypoints.length + ': ' + (_questWaypoints[0] ? _questWaypoints[0].name : '')
        );

        // Show quest panel
        var panel = document.getElementById('questPanel');
        if (panel) panel.style.display = 'block';
    }

    function _createQuestVisuals() {
        // Route polyline — dashed line at quest-defined altitude
        // NOT clampToGround — ground clamping can freeze Cesium on dynamic scenes
        var routeAlt = _questRouteAlt;
        var routeColor = _questMode === 'landing'
            ? Cesium.Color.CYAN.withAlpha(0.7)     // cyan for approach path
            : Cesium.Color.LIME.withAlpha(0.8);     // green for taxi route
        var routePositions = _questWaypoints.map(function(wp) {
            return Cesium.Cartesian3.fromRadians(wp.lon, wp.lat, routeAlt);
        });

        // Add player start position at the beginning
        if (_playerState) {
            routePositions.unshift(
                Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat,
                    _questMode === 'landing' ? _playerState.alt : routeAlt)
            );
        }

        _questRouteEntity = _viewer.entities.add({
            name: 'Quest Route',
            polyline: {
                positions: routePositions,
                width: 4,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: routeColor,
                    dashLength: 12
                })
            }
        });
        _questEntities.push(_questRouteEntity);

        // Waypoint markers — at route altitude, no ground clamping
        for (var i = 0; i < _questWaypoints.length; i++) {
            var wp = _questWaypoints[i];
            var isNext = (i === 0);
            var marker = _viewer.entities.add({
                name: 'Quest WP ' + wp.name,
                position: Cesium.Cartesian3.fromRadians(wp.lon, wp.lat, routeAlt),
                point: {
                    pixelSize: isNext ? 14 : 8,
                    color: isNext ? Cesium.Color.GOLD : Cesium.Color.YELLOW.withAlpha(0.6),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: wp.name,
                    font: isNext ? 'bold 14px monospace' : '11px monospace',
                    fillColor: isNext ? Cesium.Color.GOLD : Cesium.Color.YELLOW.withAlpha(0.6),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -16),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });
            wp._marker = marker;
            _questEntities.push(marker);
        }

        // Direction arrow — polyline from player to next waypoint (updated per tick)
        // NOT clampToGround — dynamic ground-clamped polylines are expensive and can freeze Cesium
        _questArrowEntity = _viewer.entities.add({
            name: 'Quest Arrow',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    if (!_questActive || _questComplete || _questCurrentWP >= _questWaypoints.length) return [];
                    if (!_playerState) return [];
                    // Takeoff: hide arrow once airborne. Landing: hide after landed/crashed.
                    if (_questMode === 'takeoff' && _playerState.phase === 'FLIGHT') return [];
                    if (_playerState.phase === 'LANDED' || _playerState.phase === 'CRASHED') return [];
                    var wp = _questWaypoints[_questCurrentWP];
                    var arrowAlt = _questMode === 'landing' ? _playerState.alt : routeAlt;
                    var pPos = Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, arrowAlt);
                    var wPos = Cesium.Cartesian3.fromRadians(wp.lon, wp.lat, routeAlt);
                    return [pPos, wPos];
                }, false),
                width: 3,
                material: new Cesium.PolylineGlowMaterialProperty({
                    color: Cesium.Color.GOLD.withAlpha(0.6),
                    glowPower: 0.3
                })
            }
        });
        _questEntities.push(_questArrowEntity);
    }

    function _tickQuest() {
        if (!_questActive || _questComplete) return;

        // Remove ground visuals once airborne (takeoff mode only)
        // Landing mode starts in FLIGHT — don't remove visuals
        if (_questMode === 'takeoff' && _playerState && _playerState.phase === 'FLIGHT' && _questRouteEntity) {
            _viewer.entities.remove(_questRouteEntity);
            _questRouteEntity = null;
            if (_questArrowEntity) {
                _viewer.entities.remove(_questArrowEntity);
                _questArrowEntity = null;
            }
            // Remove waypoint markers
            for (var w = 0; w < _questWaypoints.length; w++) {
                if (_questWaypoints[w]._marker) {
                    _viewer.entities.remove(_questWaypoints[w]._marker);
                    _questWaypoints[w]._marker = null;
                }
            }
        }

        // Landing mode: remove route visuals after touchdown
        if (_questMode === 'landing' && _playerState &&
            (_playerState.phase === 'LANDED' || _playerState.phase === 'CRASHED') && _questRouteEntity) {
            _viewer.entities.remove(_questRouteEntity);
            _questRouteEntity = null;
            if (_questArrowEntity) {
                _viewer.entities.remove(_questArrowEntity);
                _questArrowEntity = null;
            }
            for (var w2 = 0; w2 < _questWaypoints.length; w2++) {
                if (_questWaypoints[w2]._marker) {
                    _viewer.entities.remove(_questWaypoints[w2]._marker);
                    _questWaypoints[w2]._marker = null;
                }
            }
        }

        // 1. Waypoint proximity check
        if (_questCurrentWP < _questWaypoints.length && _playerState) {
            var wp = _questWaypoints[_questCurrentWP];
            var dist = FighterSimEngine.distance(
                _playerState.lat, _playerState.lon,
                wp.lat, wp.lon
            );

            if (dist < wp.radius) {
                wp.reached = true;
                _questCurrentWP++;
                _showMessage(wp.name + ' REACHED', 2000);

                // Update quest panel
                if (_questCurrentWP < _questWaypoints.length) {
                    var next = _questWaypoints[_questCurrentWP];
                    _updateQuestPanel(
                        wp.msg,
                        next.hint || wp.hint || '',
                        'Waypoint ' + (_questCurrentWP + 1) + '/' + _questWaypoints.length + ': ' + next.name
                    );

                    // Highlight next waypoint, dim reached one
                    if (wp._marker) {
                        wp._marker.point.pixelSize = 6;
                        wp._marker.point.color = Cesium.Color.GREEN.withAlpha(0.4);
                        wp._marker.label.fillColor = Cesium.Color.GREEN.withAlpha(0.4);
                        wp._marker.label.font = '10px monospace';
                    }
                    if (next._marker) {
                        next._marker.point.pixelSize = 14;
                        next._marker.point.color = Cesium.Color.GOLD;
                        next._marker.label.fillColor = Cesium.Color.GOLD;
                        next._marker.label.font = 'bold 14px monospace';
                    }
                } else {
                    // All waypoints reached
                    var allReachedMsg = _questMode === 'landing'
                        ? 'On final — touchdown imminent!'
                        : 'All waypoints reached — complete takeoff!';
                    var allReachedPhase = _questMode === 'landing' ? 'LANDING' : 'TAKEOFF PHASE';
                    _updateQuestPanel(wp.msg, allReachedMsg, allReachedPhase);
                    // Dim last waypoint
                    if (wp._marker) {
                        wp._marker.point.pixelSize = 6;
                        wp._marker.point.color = Cesium.Color.GREEN.withAlpha(0.4);
                        wp._marker.label.fillColor = Cesium.Color.GREEN.withAlpha(0.4);
                    }
                }
            }
        }

        // 2. Milestone checks
        for (var i = 0; i < _questMilestones.length; i++) {
            var ms = _questMilestones[i];
            if (ms.triggered) continue;

            var fired = false;
            var agl;
            switch (ms.type) {
                // --- Takeoff milestones ---
                case 'engine':
                    fired = _playerState.engineOn;
                    break;
                case 'phase':
                    fired = (_playerState.phase === ms.value);
                    break;
                case 'speed':
                    fired = (_playerState.speed >= ms.value);
                    break;
                case 'alt':
                    agl = _playerState.alt - (_playerState.groundAlt || 0);
                    fired = (agl >= ms.value);
                    break;
                case 'gearUp':
                    fired = (!_playerState.gearDown && _playerState.phase === 'FLIGHT');
                    break;
                case 'flapsUp':
                    fired = (!_playerState.flapsDown && _playerState.phase === 'FLIGHT');
                    break;

                // --- Landing milestones ---
                case 'gearDown':
                    fired = (_playerState.gearDown === true);
                    break;
                case 'flapsDown':
                    fired = (_playerState.flapsDown === true);
                    break;
                case 'speedBelow':
                    fired = (_playerState.speed <= ms.value);
                    break;
                case 'altBelow':
                    agl = _playerState.alt - (_playerState.groundAlt || 0);
                    fired = (agl <= ms.value);
                    break;
                case 'landed':
                    fired = (_playerState.phase === 'LANDED');
                    break;
                case 'stopped':
                    fired = (_playerState.phase === 'LANDED' && _playerState.speed < 1);
                    break;
            }

            if (fired) {
                ms.triggered = true;
                _showMessage(ms.msg, 3000);

                // Mode-aware quest panel updates
                if (_questMode === 'landing') {
                    _tickQuestLandingPanel(ms);
                } else {
                    _tickQuestTakeoffPanel(ms);
                }
            }
        }

        // Crash detection for landing mode
        if (_questMode === 'landing' && _playerState && _playerState.phase === 'CRASHED' && !_questComplete) {
            _questComplete = true;
            _showMessage('CRASH! Try again.', 5000);
            _updateQuestPanel('CRASHED', 'Too fast, no gear, steep angle, or wings not level.', 'FAILED');
            setTimeout(function() { _cleanupQuest(); }, 5000);
        }
    }

    function _tickQuestTakeoffPanel(ms) {
        if (ms.type === 'phase' && ms.value === 'FLIGHT') {
            _updateQuestPanel(ms.msg, 'Retract gear (G) and flaps (F)', 'CLIMB OUT');
        } else if (ms.type === 'gearUp') {
            _updateQuestPanel(ms.msg, 'Now raise flaps (F)', 'CLEAN CONFIG');
        } else if (ms.type === 'alt' && ms.value >= 1000) {
            _questComplete = true;
            _updateQuestPanel(ms.msg, '', 'COMPLETE');
            setTimeout(function() { _cleanupQuest(); }, 5000);
        }
    }

    function _tickQuestLandingPanel(ms) {
        if (ms.type === 'gearDown') {
            _updateQuestPanel(ms.msg, 'Now deploy flaps (F)', 'GEAR DOWN');
        } else if (ms.type === 'flapsDown') {
            _updateQuestPanel(ms.msg, 'Slow to 80-100 m/s approach speed', 'CONFIGURED');
        } else if (ms.type === 'altBelow' && ms.value <= 50) {
            _updateQuestPanel(ms.msg, 'Idle throttle, ease nose up', 'FLARE');
        } else if (ms.type === 'landed') {
            _updateQuestPanel(ms.msg, 'Hold B to brake!', 'ROLLOUT');
        } else if (ms.type === 'stopped') {
            _questComplete = true;
            _updateQuestPanel(ms.msg, '', 'COMPLETE');
            setTimeout(function() { _cleanupQuest(); }, 5000);
        }
    }

    function _updateQuestPanel(objective, hint, progress) {
        var objEl = document.getElementById('questObjective');
        var hintEl = document.getElementById('questHint');
        var progEl = document.getElementById('questProgress');
        if (objEl) objEl.textContent = objective || '';
        if (hintEl) hintEl.textContent = hint || '';
        if (progEl) progEl.textContent = progress || '';
    }

    function _cleanupQuest() {
        // Remove Cesium entities
        for (var i = 0; i < _questEntities.length; i++) {
            _viewer.entities.remove(_questEntities[i]);
        }
        _questEntities = [];
        _questRouteEntity = null;
        _questArrowEntity = null;
        _questActive = false;

        // Hide quest panel
        var panel = document.getElementById('questPanel');
        if (panel) panel.style.display = 'none';
    }

    /**
     * Derive heading and gamma (flight path angle) from ECI position/velocity.
     * Converts ECI velocity to ENU at the entity's geodetic position.
     */
    function _deriveFlightStateFromECI(eciPos, eciVel, state) {
        var OMEGA = 7.2921159e-5;
        var R_E = 6371000;

        // ECI velocity → ECEF velocity (approximate: ignore gmst rotation for velocity transform)
        // For heading/gamma derivation, we just need ENU components
        var lat = state.lat;
        var lon = state.lon;
        var cosLat = Math.cos(lat);
        var sinLat = Math.sin(lat);
        var cosLon = Math.cos(lon);
        var sinLon = Math.sin(lon);

        // Position in ECEF for Earth rotation correction
        var R = R_E + (state.alt || 0);
        var x_ecef = R * cosLat * cosLon;
        var y_ecef = R * cosLat * sinLon;

        // ECI velocity magnitude
        var vMag = Math.sqrt(eciVel[0] * eciVel[0] + eciVel[1] * eciVel[1] + eciVel[2] * eciVel[2]);

        // Simplified: use ECI velocity directly as approximation for ENU decomposition
        // (full conversion would need gmst which we don't have here)
        // ECI → local ENU at (lat, lon) with gmst=0 approximation
        // This is approximate but sufficient for initial heading/gamma setup
        var vx = eciVel[0];
        var vy = eciVel[1];
        var vz = eciVel[2];

        // Transform ECI vel to ECEF-aligned (approximate: assume lon ~= gmst + lon_ecef)
        // For the purpose of getting heading/gamma, we use the ECI velocity
        // decomposed in the ENU frame at the current geodetic position

        // East  = (-sinLon, cosLon, 0) in ECEF, but in ECI we'd need gmst
        // For a quick approximation, use the geographic longitude directly
        var eE = [-sinLon, cosLon, 0];
        var eN = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
        var eU = [cosLat * cosLon, cosLat * sinLon, sinLat];

        var vE_comp = vx * eE[0] + vy * eE[1] + vz * eE[2];
        var vN_comp = vx * eN[0] + vy * eN[1] + vz * eN[2];
        var vU_comp = vx * eU[0] + vy * eU[1] + vz * eU[2];

        // The 3-DOF physics engine models a non-rotating Earth where state.speed is
        // inertial speed and centrifugal = V²/R sustains orbit at V = sqrt(μ/R).
        // ECI velocity is already inertial (non-rotating frame) — do NOT subtract ω×r.
        // Subtracting Earth rotation would make initial speed ~494 m/s too low, creating
        // a decaying orbit whose perigee dips into atmosphere.
        var vHoriz = Math.sqrt(vE_comp * vE_comp + vN_comp * vN_comp);

        // Heading (azimuth from North, clockwise)
        state.heading = Math.atan2(vE_comp, vN_comp);

        // Flight path angle (positive = climbing)
        state.gamma = Math.atan2(vU_comp, vHoriz);

        // Speed: ECI magnitude is already the inertial speed the physics engine expects
        var vInertial = Math.sqrt(vE_comp * vE_comp + vN_comp * vN_comp + vU_comp * vU_comp);
        if (!state.speed || state.speed < 100) {
            state.speed = vInertial;
        }
    }

    // -----------------------------------------------------------------------
    // Orbit visualization entities
    // -----------------------------------------------------------------------
    function _createOrbitEntities() {
        // Trail polyline (cyan, gated on _showTrail)
        _trailEntity = _viewer.entities.add({
            name: 'Player Trail',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return _showTrail ? _playerTrail : [];
                }, false),
                width: 2,
                material: Cesium.Color.CYAN.withAlpha(0.6),
            },
        });

        // Ground track polyline (projected trail on surface)
        _groundTrackEntity = _viewer.entities.add({
            name: 'Player Ground Track',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return _showTrail ? _playerGroundTrack : [];
                }, false),
                width: 1,
                material: Cesium.Color.CYAN.withAlpha(0.25),
                clampToGround: true,
            },
        });

        // Predicted ground track polyline (projected future orbit onto surface)
        _predictedGroundTrackEntity = _viewer.entities.add({
            name: 'Predicted Ground Track',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return _showPredictedGroundTrack ? _predictedGroundTrackPositions : [];
                }, false),
                width: 1.5,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.YELLOW.withAlpha(0.4),
                    dashLength: 16,
                }),
            },
        });

        // Orbit visualization — always created, SpaceplaneOrbital provides data when applicable
        // Current ECEF orbit (lime green, gated on _showEcefOrbit)
        _orbitPolyline = _viewer.entities.add({
            name: 'ECEF Orbit',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    if (!_showEcefOrbit) return [];
                    return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.currentOrbitPositions) ?
                        SpaceplaneOrbital.currentOrbitPositions : [];
                }, false),
                width: 2,
                material: Cesium.Color.LIME.withAlpha(0.7),
            },
        });

        // ECI orbit (yellow dashed, gated on _showEciOrbit)
        _eciOrbitPolyline = _viewer.entities.add({
            name: 'ECI Orbit',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    if (!_showEciOrbit) return [];
                    return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.eciOrbitPositions) ?
                        SpaceplaneOrbital.eciOrbitPositions : [];
                }, false),
                width: 2,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.YELLOW.withAlpha(0.8),
                    dashLength: 16,
                }),
            },
        });

        // Predicted orbit (blue dashed, shown with maneuver node)
        _predictedOrbitPolyline = _viewer.entities.add({
            name: 'Predicted Orbit',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return (typeof SpaceplanePlanner !== 'undefined' && SpaceplanePlanner.predictedOrbitPositions) ?
                        SpaceplanePlanner.predictedOrbitPositions : [];
                }, false),
                width: 2,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: Cesium.Color.DODGERBLUE.withAlpha(0.8),
                    dashLength: 16,
                }),
            },
        });

        // Apoapsis marker
        _apMarker = _viewer.entities.add({
            name: 'Apoapsis',
            position: new Cesium.CallbackProperty(function() {
                return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.apoapsisPosition) ?
                    SpaceplaneOrbital.apoapsisPosition : Cesium.Cartesian3.fromDegrees(0, 0, 0);
            }, false),
            show: new Cesium.CallbackProperty(function() {
                return typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.apoapsisPosition != null;
            }, false),
            point: { pixelSize: 8, color: Cesium.Color.RED },
            label: {
                text: new Cesium.CallbackProperty(function() {
                    if (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.orbitalElements) {
                        var ap = SpaceplaneOrbital.orbitalElements.apoapsisAlt;
                        if (ap != null) return 'AP ' + (ap / 1000).toFixed(0) + ' km';
                    }
                    return 'AP';
                }, false),
                font: '12px monospace',
                fillColor: Cesium.Color.RED,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });

        // Periapsis marker
        _peMarker = _viewer.entities.add({
            name: 'Periapsis',
            position: new Cesium.CallbackProperty(function() {
                return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.periapsisPosition) ?
                    SpaceplaneOrbital.periapsisPosition : Cesium.Cartesian3.fromDegrees(0, 0, 0);
            }, false),
            show: new Cesium.CallbackProperty(function() {
                return typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.periapsisPosition != null;
            }, false),
            point: { pixelSize: 8, color: Cesium.Color.CYAN },
            label: {
                text: new Cesium.CallbackProperty(function() {
                    if (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.orbitalElements) {
                        var pe = SpaceplaneOrbital.orbitalElements.periapsisAlt;
                        if (pe != null) return 'PE ' + (pe / 1000).toFixed(0) + ' km';
                    }
                    return 'PE';
                }, false),
                font: '12px monospace',
                fillColor: Cesium.Color.CYAN,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });

        // Ascending Node marker
        _anMarker = _viewer.entities.add({
            name: 'Ascending Node',
            position: new Cesium.CallbackProperty(function() {
                return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.ascNodePosition) ?
                    SpaceplaneOrbital.ascNodePosition : Cesium.Cartesian3.fromDegrees(0, 0, 0);
            }, false),
            show: new Cesium.CallbackProperty(function() {
                return typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.ascNodePosition != null;
            }, false),
            point: { pixelSize: 7, color: Cesium.Color.YELLOW },
            label: {
                text: 'AN',
                font: '11px monospace',
                fillColor: Cesium.Color.YELLOW,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -10),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });

        // Descending Node marker
        _dnMarker = _viewer.entities.add({
            name: 'Descending Node',
            position: new Cesium.CallbackProperty(function() {
                return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.descNodePosition) ?
                    SpaceplaneOrbital.descNodePosition : Cesium.Cartesian3.fromDegrees(0, 0, 0);
            }, false),
            show: new Cesium.CallbackProperty(function() {
                return typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.descNodePosition != null;
            }, false),
            point: { pixelSize: 7, color: Cesium.Color.YELLOW },
            label: {
                text: 'DN',
                font: '11px monospace',
                fillColor: Cesium.Color.YELLOW,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -10),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });
    }

    // -----------------------------------------------------------------------
    // Entity list for UI
    // -----------------------------------------------------------------------
    function _buildEntityList() {
        _entityListItems = [];
        var playerId = _playerEntity ? _playerEntity.id : null;
        _world.entities.forEach(function(entity) {
            var isCarrier = entity.state && entity.state._isCarrier;
            _entityListItems.push({
                id: entity.id,
                name: entity.name,
                type: entity.type,
                team: entity.team,
                isPlayer: playerId && entity.id === playerId,
                entity: entity,
                vizCategory: entity.vizCategory || null,
                hasPhysics: !!entity.getComponent('physics'),
                isCarrier: isCarrier,
                carrierType: isCarrier ? entity.state._carrierType : null,
                carrierReady: isCarrier ? entity.state._carrierReady : 0,
                carrierAirborne: isCarrier ? entity.state._carrierAirborne : 0,
            });
        });
    }

    // -----------------------------------------------------------------------
    // Camera setup
    // -----------------------------------------------------------------------
    function _isGlobeMode() {
        return _cameraMode === 'earth' || _cameraMode === 'moon';
    }

    function _setupCameraHandlers() {
        var container = document.getElementById('cesiumContainer');

        container.addEventListener('mousedown', function(e) {
            if (_cameraMode === 'free' || _isGlobeMode()) return;
            // Middle-click: reset chase camera to defaults
            if (e.button === 1 && (_cameraMode === 'chase' || _cameraMode === 'cockpit')) {
                _camRange = 150;
                _camHeadingOffset = 0;
                _camPitch = -0.3;
                e.preventDefault();
                return;
            }
            if (e.shiftKey || e.button === 2) {
                _camDragging = true;
                _camDragStart = { x: e.clientX, y: e.clientY };
                e.preventDefault();
            }
        });

        window.addEventListener('mousemove', function(e) {
            if (!_camDragging) return;
            var dx = e.clientX - _camDragStart.x;
            var dy = e.clientY - _camDragStart.y;
            _camDragStart = { x: e.clientX, y: e.clientY };
            _camHeadingOffset += dx * 0.003;
            // Wrap heading offset at +/- PI
            if (_camHeadingOffset > Math.PI) _camHeadingOffset -= 2 * Math.PI;
            if (_camHeadingOffset < -Math.PI) _camHeadingOffset += 2 * Math.PI;
            _camPitch = Math.max(-1.2, Math.min(0.3, _camPitch - dy * 0.003));
        });

        window.addEventListener('mouseup', function() { _camDragging = false; });

        container.addEventListener('wheel', function(e) {
            if (_cameraMode === 'free' || _isGlobeMode()) return;
            if (_plannerMode) {
                _plannerCamRange *= (1 + e.deltaY * 0.001);
                _plannerCamRange = Math.max(1e5, Math.min(1e8, _plannerCamRange));
            } else if (_cameraMode === 'chase' || _cameraMode === 'cockpit') {
                // Smooth multiplicative zoom: 0.9x per scroll-up, 1.1x per scroll-down
                var factor = e.deltaY > 0 ? 1.1 : 0.9;
                _camRange *= factor;
                _camRange = Math.max(30, Math.min(3000, _camRange));
            }
            e.preventDefault();
        }, { passive: false });

        container.addEventListener('contextmenu', function(e) {
            if (_cameraMode !== 'free' && !_isGlobeMode()) e.preventDefault();
        });
    }

    function _positionInitialCamera() {
        if (!_playerState) return;
        if (isNaN(_playerState.lat) || isNaN(_playerState.lon) || isNaN(_playerState.alt)) return;
        // Start in chase mode — disable Cesium camera controls so arrow keys go to us
        _viewer.scene.screenSpaceCameraController.enableInputs = false;
        var pos = Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, _playerState.alt);
        var range = _playerState.alt > 100000 ? 5000 : 200;
        _viewer.camera.lookAt(pos,
            new Cesium.HeadingPitchRange(_playerState.heading || 0, -0.3, range));
        _camRange = range;
    }

    function _updateCamera() {
        if (!_playerState || _cameraMode === 'free' || _isGlobeMode()) return;
        if (isNaN(_playerState.lat) || isNaN(_playerState.lon) || isNaN(_playerState.alt)) return;

        var pos = Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, _playerState.alt);

        // Planner mode: camera is free (Cesium handles rotation/zoom)
        if (_plannerMode) return;

        // Shared helper: linear combination a*v1 + b*v2
        function lc(a, v1, b, v2) {
            var r = new Cesium.Cartesian3();
            Cesium.Cartesian3.add(
                Cesium.Cartesian3.multiplyByScalar(v1, a, new Cesium.Cartesian3()),
                Cesium.Cartesian3.multiplyByScalar(v2, b, new Cesium.Cartesian3()), r);
            return r;
        }

        // Build ENU basis at aircraft position
        var enuT = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
        var em = Cesium.Matrix4.getMatrix3(enuT, new Cesium.Matrix3());
        var E = new Cesium.Cartesian3(em[0], em[1], em[2]);
        var N = new Cesium.Cartesian3(em[3], em[4], em[5]);
        var U = new Cesium.Cartesian3(em[6], em[7], em[8]);

        if (_cameraMode === 'chase') {
            var adaptiveRange = _playerState.alt > 100000 ?
                Math.max(_camRange, _playerState.alt * 0.01) : _camRange;

            // Aircraft body frame: heading + yawOffset + camera drag offset + roll
            var h = _playerState.heading + (_playerState.yawOffset || 0) + _camHeadingOffset;
            var p = _camPitch;
            var rollAngle = -(_playerState.roll || 0);

            var fwd = lc(Math.sin(h), E, Math.cos(h), N);
            var rgt = lc(Math.cos(h), E, -Math.sin(h), N);
            var up = Cesium.Cartesian3.clone(U);

            // Apply mouse-drag pitch to get camera orbit angle
            var fwd2 = lc(Math.cos(p), fwd, Math.sin(p), up);
            var up2 = lc(-Math.sin(p), fwd, Math.cos(p), up);
            fwd = fwd2; up = up2;

            // Camera position: behind and above aircraft
            var camPos = Cesium.Cartesian3.clone(pos);
            Cesium.Cartesian3.add(camPos,
                Cesium.Cartesian3.multiplyByScalar(fwd, -adaptiveRange, new Cesium.Cartesian3()), camPos);

            // Camera looks toward aircraft
            var dir = Cesium.Cartesian3.normalize(
                Cesium.Cartesian3.subtract(pos, camPos, new Cesium.Cartesian3()),
                new Cesium.Cartesian3());

            // Apply aircraft roll to camera up/right so horizon tilts with bank
            var rgt2 = lc(Math.cos(rollAngle), rgt, Math.sin(rollAngle), up);
            var up3 = lc(-Math.sin(rollAngle), rgt, Math.cos(rollAngle), up);

            _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            _viewer.camera.position = camPos;
            _viewer.camera.direction = dir;
            _viewer.camera.up = Cesium.Cartesian3.normalize(up3, up3);
            _viewer.camera.right = Cesium.Cartesian3.normalize(rgt2, rgt2);

        } else if (_cameraMode === 'cockpit') {
            // Check if sensor view is active with non-manual pointing
            var sensorActive = _sensorIndex >= 0 && _sensorList[_sensorIndex] &&
                SENSOR_FILTERS[_sensorList[_sensorIndex].type];
            var usePointingCam = sensorActive && _pointingMode !== 'manual' && _playerState.alt > 80000;

            if (usePointingCam) {
                // Sensor view camera: look in pointing direction
                var dirECI = _getPointingDirectionECI();
                if (dirECI) {
                    // Convert ECI direction to ENU at player position
                    // ENU basis: E, N, U already computed above
                    // ECI→ECEF rotation: need GMST angle
                    var omega = 7.2921159e-5;
                    var gmst = omega * _simElapsed;
                    var cg = Math.cos(gmst), sg = Math.sin(gmst);
                    // Rotate ECI direction to ECEF
                    var ecefDir = [
                        cg * dirECI[0] + sg * dirECI[1],
                        -sg * dirECI[0] + cg * dirECI[1],
                        dirECI[2]
                    ];
                    // Project ECEF direction onto ENU basis
                    var enuE = E, enuN = N, enuU = U;
                    var dE = ecefDir[0] * enuE.x + ecefDir[1] * enuE.y + ecefDir[2] * enuE.z;
                    var dN = ecefDir[0] * enuN.x + ecefDir[1] * enuN.y + ecefDir[2] * enuN.z;
                    var dU = ecefDir[0] * enuU.x + ecefDir[1] * enuU.y + ecefDir[2] * enuU.z;

                    // Build camera direction in ECEF
                    var fwd = lc(dE, E, 0, N);
                    Cesium.Cartesian3.add(fwd,
                        Cesium.Cartesian3.multiplyByScalar(N, dN, new Cesium.Cartesian3()), fwd);
                    Cesium.Cartesian3.add(fwd,
                        Cesium.Cartesian3.multiplyByScalar(U, dU, new Cesium.Cartesian3()), fwd);
                    Cesium.Cartesian3.normalize(fwd, fwd);

                    // Up vector: use U unless looking straight up/down, then use N
                    var up = Cesium.Cartesian3.clone(U);
                    if (Math.abs(dU) > 0.95) {
                        up = Cesium.Cartesian3.clone(N);
                    }
                    var rgt = Cesium.Cartesian3.cross(fwd, up, new Cesium.Cartesian3());
                    Cesium.Cartesian3.normalize(rgt, rgt);
                    up = Cesium.Cartesian3.cross(rgt, fwd, new Cesium.Cartesian3());
                    Cesium.Cartesian3.normalize(up, up);

                    _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
                    _viewer.camera.position = pos;
                    _viewer.camera.direction = fwd;
                    _viewer.camera.up = up;
                    _viewer.camera.right = rgt;
                } else {
                    // Fallback to nose direction
                    usePointingCam = false;
                }
            }

            if (!usePointingCam) {
                // Standard cockpit: look along nose direction
                var h = _playerState.heading + (_playerState.yawOffset || 0);
                var p = _playerState.pitch;
                var r = -_playerState.roll;

                var fwd = lc(Math.sin(h), E, Math.cos(h), N);
                var rgt = lc(Math.cos(h), E, -Math.sin(h), N);
                var up = Cesium.Cartesian3.clone(U);

                var fwd2 = lc(Math.cos(p), fwd, Math.sin(p), up);
                var up2 = lc(-Math.sin(p), fwd, Math.cos(p), up);
                fwd = fwd2; up = up2;

                var rgt2 = lc(Math.cos(r), rgt, Math.sin(r), up);
                var up3 = lc(-Math.sin(r), rgt, Math.cos(r), up);
                rgt = rgt2; up = up3;

                var camPos = Cesium.Cartesian3.clone(pos);
                Cesium.Cartesian3.add(camPos,
                    Cesium.Cartesian3.multiplyByScalar(fwd, 20, new Cesium.Cartesian3()), camPos);
                Cesium.Cartesian3.add(camPos,
                    Cesium.Cartesian3.multiplyByScalar(up, 2, new Cesium.Cartesian3()), camPos);

                _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
                _viewer.camera.position = camPos;
                _viewer.camera.direction = Cesium.Cartesian3.normalize(fwd, fwd);
                _viewer.camera.up = Cesium.Cartesian3.normalize(up, up);
                _viewer.camera.right = Cesium.Cartesian3.normalize(rgt, rgt);
            }
        }
    }

    function _cycleCamera() {
        if (_plannerMode) return;
        // Close engine panel on camera change
        if (_enginePanelOpen) {
            _enginePanelOpen = false;
            var epanel = document.getElementById('enginePanel');
            if (epanel) epanel.classList.remove('open');
        }
        if (_pointingPanelOpen) {
            _pointingPanelOpen = false;
            var ppanel = document.getElementById('pointingPanel');
            if (ppanel) ppanel.classList.remove('open');
        }
        var modes = (_observerMode && !_playerEntity) ?
            ['free', 'earth', 'moon'] : ['chase', 'cockpit', 'free', 'earth', 'moon'];
        var idx = modes.indexOf(_cameraMode);
        if (idx < 0) idx = 0;

        // Fully release camera from any lookAt / trackedEntity binding
        _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        if (_viewer.trackedEntity) _viewer.trackedEntity = undefined;

        _cameraMode = modes[(idx + 1) % modes.length];

        var isGlobe = _isGlobeMode();
        // Disable Cesium camera controls in chase/cockpit (we position camera manually)
        // Only enable in free/earth/moon modes where Cesium handles the camera
        _viewer.scene.screenSpaceCameraController.enableInputs =
            (_cameraMode === 'free' || _cameraMode === 'earth' || _cameraMode === 'moon');

        // Hide player point in cockpit mode
        if (_playerEntity) {
            var vis = _playerEntity.getComponent('visual');
            if (vis && vis._cesiumEntity) {
                vis._cesiumEntity.show = (_cameraMode !== 'cockpit');
            }
        }

        // HUD visibility — hide in globe modes
        var hudCanvas = document.getElementById('hudCanvas');
        if (hudCanvas) hudCanvas.style.display = isGlobe ? 'none' : 'block';

        // Remove sensor/display view effects in globe/free modes (restore on chase/cockpit)
        if (isGlobe || _cameraMode === 'free') {
            // Force-clear all visual filters in globe/free modes
            _activeSensorFilter = null;
            var container = document.getElementById('cesiumContainer');
            if (container) container.style.filter = '';
            _stopSensorNoise();
            if (_viewer) {
                _viewer.scene.globe.showGroundAtmosphere = true;
                _viewer.scene.fog.enabled = true;
            }
        } else if (_sensorIndex >= 0 && SENSOR_FILTERS[_sensorList[_sensorIndex].type]) {
            // Restore sensor view effects when returning to chase/cockpit (sensor overrides display mode)
            _applySensorViewEffects(_sensorList[_sensorIndex].type);
        } else if (_displayMode > 0) {
            // Restore display mode effects when returning to chase/cockpit
            _applyDisplayModeEffects();
        }

        if (_cameraMode === 'chase') {
            _camHeadingOffset = 0;
            _camPitch = -0.3;
            _camRange = 150;
        } else if (_cameraMode === 'earth') {
            // Standard Cesium globe view — zoom out to see the whole Earth
            // Use setView for reliable instant positioning (flyHome can be unreliable)
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            _viewer.camera.setView({
                destination: Cesium.Cartesian3.fromDegrees(0, 20, 25000000),
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-90),
                    roll: 0
                }
            });
        } else if (_cameraMode === 'moon') {
            // Fly out to lunar distance — view the Earth-Moon system
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            var moonDist = 384400000; // 384,400 km in meters
            // Approximate lunar position using sim elapsed time
            var moonAngle = (_simElapsed / 2360591.5) * 2 * Math.PI; // ~27.3 day period
            var moonX = moonDist * Math.cos(moonAngle);
            var moonY = moonDist * Math.sin(moonAngle);
            var moonZ = moonDist * Math.sin(5.14 * DEG) * Math.sin(moonAngle);
            // Position camera near the Moon, looking back toward Earth
            var earthDir = Cesium.Cartesian3.normalize(
                new Cesium.Cartesian3(-moonX, -moonY, -moonZ), new Cesium.Cartesian3());
            _viewer.camera.setView({
                destination: new Cesium.Cartesian3(moonX, moonY, moonZ),
                orientation: {
                    direction: earthDir,
                    up: new Cesium.Cartesian3(0, 0, 1)
                }
            });
        }

        var label = _cameraMode === 'earth' ? 'EARTH' :
                    _cameraMode === 'moon' ? 'MOON' :
                    _cameraMode.toUpperCase();
        _setText('camMode', label);
        _showMessage('Camera: ' + label);
    }

    function _togglePlannerMode() {
        _plannerMode = !_plannerMode;

        var modeEl = document.getElementById('modeIndicator');
        if (modeEl) modeEl.style.display = _plannerMode ? 'block' : 'none';

        // Update keyboard help mode
        if (typeof KeyboardHelp !== 'undefined') {
            KeyboardHelp.setMode(_plannerMode ? 'planner' : (_observerMode ? 'observer' : 'flight'));
        }

        if (_plannerMode) {
            _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            // Fly camera to Earth-centered overview — orbit fully visible
            var orbitAlt = _playerState.alt || 400000;
            var range = (6371000 + orbitAlt) * 3.5;
            _viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromRadians(
                    _playerState.lon, 0, range),
                orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
                duration: 0.8
            });
            _showMessage('PLANNER MODE');
        } else {
            // Close dialog if open
            if (_maneuverDialogOpen) _closeManeuverDialog(false);
            _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            _cameraMode = 'chase';
            _viewer.scene.screenSpaceCameraController.enableInputs = false; // chase = we control camera
            _camHeadingOffset = 0;
            _camPitch = -0.3;
            _camRange = _playerState.alt > 100000 ? 5000 : 150;
            _setText('camMode', 'CHASE');
            var hudCanvas = document.getElementById('hudCanvas');
            if (hudCanvas) hudCanvas.style.display = 'block';
            _showMessage('COCKPIT MODE');
        }
    }

    // -----------------------------------------------------------------------
    // Planner click handler — click on orbit to create node
    // -----------------------------------------------------------------------
    function _initPlannerClickHandler() {
        var handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
        handler.setInputAction(function(click) {
            if (!_plannerMode || _maneuverDialogOpen) return;
            if (typeof SpaceplaneOrbital === 'undefined' || typeof SpaceplanePlanner === 'undefined') return;

            // Get click position in ECEF
            var clickPos = _viewer.scene.pickPosition(click.position);
            if (!clickPos) {
                // Fallback: ray-globe intersection
                var ray = _viewer.camera.getPickRay(click.position);
                clickPos = _viewer.scene.globe.pick(ray, _viewer.scene);
            }
            if (!clickPos) return;

            // Find closest point on current ECEF orbit polyline
            var orbitPts = SpaceplaneOrbital.currentOrbitPositions;
            if (!orbitPts || orbitPts.length < 2) return;

            var bestIdx = -1;
            var bestDist = Infinity;
            for (var i = 0; i < orbitPts.length; i++) {
                var d = Cesium.Cartesian3.distance(clickPos, orbitPts[i]);
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            }

            // Distance threshold: proportional to camera height for usability
            var camHeight = _viewer.camera.positionCartographic.height;
            var threshold = Math.max(camHeight * 0.05, 50000); // at least 50km
            if (bestDist > threshold) return;

            // Map orbit index to time offset
            var elems = SpaceplaneOrbital.orbitalElements;
            if (!elems || !elems.period || !isFinite(elems.period)) return;
            var totalPoints = orbitPts.length - 1;
            if (totalPoints <= 0) return;
            var period = elems.period;
            var dt = (bestIdx / totalPoints) * period;
            // Wrap to first period
            if (dt > period) dt = dt % period;

            // Update engine params before creating node
            _updatePlannerEngineParams();

            // Create node at that future time
            var node = SpaceplanePlanner.createNodeAtTime(_playerState, _simElapsed, dt);
            if (node) {
                _openManeuverDialog(node);
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    // -----------------------------------------------------------------------
    // Engine params for planner burn time
    // -----------------------------------------------------------------------
    function _getPlannerEngineParams() {
        var mode = _playerState.forcedPropMode || 'ROCKET';
        var thrust;
        if (mode === 'ROCKET') thrust = _playerConfig.thrust_rocket || 5000000;
        else if (mode === 'HYPERSONIC') thrust = _playerConfig.thrust_hypersonic || 800000;
        else thrust = _playerConfig.thrust_ab || _playerConfig.thrust_mil || 130000;
        var mass = _playerConfig.mass_empty +
                   (isFinite(_playerState.fuel) ? _playerState.fuel : 0) +
                   (_playerState.weaponMass || 0);
        var entry = _propModes[_propModeIndex];
        var label = entry ? entry.name : mode;
        return { thrust: thrust, mass: mass, label: label + ' ' + (thrust / 1000).toFixed(0) + 'kN' };
    }

    function _updatePlannerEngineParams() {
        if (typeof SpaceplanePlanner === 'undefined') return;
        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);
    }

    // -----------------------------------------------------------------------
    // Maneuver Dialog
    // -----------------------------------------------------------------------
    function _openManeuverDialog(node) {
        _maneuverDialogNode = node;
        _maneuverDialogOpen = true;

        var dlg = document.getElementById('maneuverDialog');
        if (!dlg) return;
        dlg.classList.add('open');

        // Populate inputs
        document.getElementById('mnvPrograde').value = node.dvPrograde || 0;
        document.getElementById('mnvNormal').value = node.dvNormal || 0;
        document.getElementById('mnvRadial').value = node.dvRadial || 0;

        // Update computed fields
        _refreshManeuverDialog();

        // Wire input listeners (remove old ones by replacing)
        var inputs = ['mnvPrograde', 'mnvNormal', 'mnvRadial'];
        for (var i = 0; i < inputs.length; i++) {
            var el = document.getElementById(inputs[i]);
            if (!el) continue;
            var newEl = el.cloneNode(true);
            el.parentNode.replaceChild(newEl, el);
            newEl.addEventListener('input', _onManeuverInput);
            // Stop keyboard events from reaching flight controls
            newEl.addEventListener('keydown', function(e) { e.stopPropagation(); });
            newEl.addEventListener('keyup', function(e) { e.stopPropagation(); });
        }

        // Wire execute time selector
        var execTimeSel = document.getElementById('mnvExecTime');
        if (execTimeSel) {
            var newSel = execTimeSel.cloneNode(true);
            execTimeSel.parentNode.replaceChild(newSel, execTimeSel);
            newSel.value = 'current';
            newSel.addEventListener('change', _onExecTimeChange);
            newSel.addEventListener('keydown', function(e) { e.stopPropagation(); });
        }
        var customTimeEl = document.getElementById('mnvCustomTime');
        if (customTimeEl) {
            var newCT = customTimeEl.cloneNode(true);
            customTimeEl.parentNode.replaceChild(newCT, customTimeEl);
            newCT.addEventListener('input', _onExecTimeChange);
            newCT.addEventListener('keydown', function(e) { e.stopPropagation(); });
            newCT.addEventListener('keyup', function(e) { e.stopPropagation(); });
        }
        var customRow = document.getElementById('mnvCustomTimeRow');
        if (customRow) customRow.style.display = 'none';

        // Wire buttons
        _wireManeuverButton('mnvAccept', function() {
            _createNodeMarker(_maneuverDialogNode);
            _closeManeuverDialog(false);
        });
        _wireManeuverButton('mnvWarpToT', function() {
            _createNodeMarker(_maneuverDialogNode);
            _startAutoExec(_maneuverDialogNode, 'warp_only');
            _closeManeuverDialog(false);
        });
        _wireManeuverButton('mnvExecute', function() {
            _createNodeMarker(_maneuverDialogNode);
            // Build orbital element target for Hohmann burn 1
            var execTarget = null;
            if (_pendingHohmann) {
                var tgtR = 6371000 + _pendingHohmann.targetAltKm * 1000;
                var curR = 6371000 + (_playerState.alt || 0);
                execTarget = tgtR > curR
                    ? { type: 'raise_apo', targetAltM: _pendingHohmann.targetAltKm * 1000 }
                    : { type: 'lower_pe', targetAltM: _pendingHohmann.targetAltKm * 1000 };
            }
            _startAutoExec(_maneuverDialogNode, 'warping', execTarget);
            _closeManeuverDialog(false);
        });
        _wireManeuverButton('mnvCancel', function() {
            _closeManeuverDialog(true); // true = delete node
        });

        // Circularize helpers
        _wireManeuverButton('mnvCircAP', function() { _circularizeAt('apogee'); });
        _wireManeuverButton('mnvCircPE', function() { _circularizeAt('perigee'); });

        // Solver buttons
        _wireManeuverButton('mnvHohmann', function() { _openSolverPanel('hohmann'); });
        _wireManeuverButton('mnvIntercept', function() { _openSolverPanel('intercept'); });
        _wireManeuverButton('mnvNMC', function() { _openSolverPanel('nmc'); });
        _wireManeuverButton('mnvOrbit', function() { _openSolverPanel('orbit'); });
        _wireManeuverButton('mnvLagrange', function() { _openSolverPanel('lagrange'); });
        _wireManeuverButton('mnvInclChg', function() { _openSolverPanel('inclChg'); });
        _wireManeuverButton('mnvPlaneMatch', function() { _openSolverPanel('planeMatch'); });
        _wireManeuverButton('mnvPlanet', function() { _openSolverPanel('planet'); });

        // Reset solver panel
        var solverPanel = document.getElementById('mnvSolverPanel');
        if (solverPanel) { solverPanel.style.display = 'none'; solverPanel.innerHTML = ''; }
        // Clear active state on solver buttons
        ['mnvHohmann', 'mnvIntercept', 'mnvNMC', 'mnvOrbit', 'mnvLagrange', 'mnvInclChg', 'mnvPlaneMatch', 'mnvPlanet'].forEach(function(id) {
            var btn = document.getElementById(id);
            if (btn) btn.classList.remove('active');
        });
    }

    function _wireManeuverButton(id, handler) {
        var btn = document.getElementById(id);
        if (!btn) return;
        var newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', handler);
    }

    function _onManeuverInput() {
        if (_maneuverUpdateTimer) clearTimeout(_maneuverUpdateTimer);
        _maneuverUpdateTimer = setTimeout(function() {
            if (!_maneuverDialogNode || typeof SpaceplanePlanner === 'undefined') return;
            var pro = parseFloat(document.getElementById('mnvPrograde').value) || 0;
            var norm = parseFloat(document.getElementById('mnvNormal').value) || 0;
            var rad = parseFloat(document.getElementById('mnvRadial').value) || 0;
            SpaceplanePlanner.setNodeDV(pro, norm, rad);
            _refreshManeuverDialog();
        }, 150);
    }

    function _onExecTimeChange() {
        if (!_maneuverDialogNode || typeof SpaceplanePlanner === 'undefined') return;
        if (typeof SpaceplaneOrbital === 'undefined') return;

        var sel = document.getElementById('mnvExecTime');
        var customRow = document.getElementById('mnvCustomTimeRow');
        if (!sel) return;

        var val = sel.value;

        // Show/hide custom time input
        if (customRow) customRow.style.display = val === 'custom' ? 'flex' : 'none';

        // Keep current if "current" selected
        if (val === 'current') return;

        // Get the target dt from orbital elements
        var elems = SpaceplaneOrbital.orbitalElements;
        var dt = 0;

        if (val === 'apogee' && elems && elems.timeToApoapsis != null) {
            dt = elems.timeToApoapsis;
        } else if (val === 'perigee' && elems && elems.timeToPeriapsis != null) {
            dt = elems.timeToPeriapsis;
        } else if (val === 'asc_node' && elems && elems.timeToAscendingNode != null) {
            dt = elems.timeToAscendingNode;
        } else if (val === 'desc_node' && elems && elems.timeToDescendingNode != null) {
            dt = elems.timeToDescendingNode;
        } else if (val === 'ta90' && elems && elems.timeToTA90 != null) {
            dt = elems.timeToTA90;
        } else if (val === 'ta270' && elems && elems.timeToTA270 != null) {
            dt = elems.timeToTA270;
        } else if (val === 'custom') {
            var customEl = document.getElementById('mnvCustomTime');
            dt = customEl ? (parseFloat(customEl.value) || 0) : 0;
            if (dt <= 0) return;
        } else {
            return; // No valid time available
        }

        if (dt <= 0) return;

        // Save current DV inputs
        var savedPro = _maneuverDialogNode.dvPrograde || 0;
        var savedNorm = _maneuverDialogNode.dvNormal || 0;
        var savedRad = _maneuverDialogNode.dvRadial || 0;

        // Delete old node
        SpaceplanePlanner.deleteNode(_maneuverDialogNode);

        // Create new node at target time
        var newNode = SpaceplanePlanner.createNodeAtTime(_playerState, _simElapsed, dt);
        if (!newNode) return;

        // Re-apply DV
        _maneuverDialogNode = newNode;
        SpaceplanePlanner.setNodeDV(savedPro, savedNorm, savedRad);

        // Update engine params
        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);

        // Refresh UI
        document.getElementById('mnvPrograde').value = savedPro;
        document.getElementById('mnvNormal').value = savedNorm;
        document.getElementById('mnvRadial').value = savedRad;
        _refreshManeuverDialog();
    }

    function _circularizeAt(point) {
        if (!_maneuverDialogNode || typeof SpaceplanePlanner === 'undefined') return;
        if (typeof SpaceplaneOrbital === 'undefined') return;

        var elems = SpaceplaneOrbital.orbitalElements;
        if (!elems || !elems.sma || elems.eccentricity >= 1.0) return;

        var MU = 3.986004418e14;
        var a = elems.sma;
        var e = elems.eccentricity;
        var dt, rTarget, vCurrent, vCirc, dvPro;

        if (point === 'apogee') {
            dt = elems.timeToApoapsis || 0;
            rTarget = a * (1 + e);                        // radius at apoapsis
            vCurrent = Math.sqrt(MU * (2 / rTarget - 1 / a)); // vis-viva at apoapsis
            vCirc = Math.sqrt(MU / rTarget);               // circular velocity at that radius
            dvPro = vCirc - vCurrent;                       // positive = prograde (speed up at AP)
        } else {
            dt = elems.timeToPeriapsis || 0;
            rTarget = a * (1 - e);                        // radius at periapsis
            vCurrent = Math.sqrt(MU * (2 / rTarget - 1 / a)); // vis-viva at periapsis
            vCirc = Math.sqrt(MU / rTarget);               // circular velocity at that radius
            dvPro = vCirc - vCurrent;                       // negative = retrograde (slow down at PE)
        }

        if (!isFinite(dvPro)) return;

        // Delete old node, create at the correct time
        SpaceplanePlanner.deleteNode(_maneuverDialogNode);
        var newNode = SpaceplanePlanner.createNodeAtTime(_playerState, _simElapsed, dt);
        if (!newNode) return;

        _maneuverDialogNode = newNode;
        SpaceplanePlanner.setNodeDV(dvPro, 0, 0); // pure prograde/retrograde

        // Store orbital element target for auto-execute
        newNode._autoExecTarget = { type: 'circularize', targetR: rTarget };

        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);

        // Update UI
        document.getElementById('mnvPrograde').value = Math.round(dvPro * 10) / 10;
        document.getElementById('mnvNormal').value = 0;
        document.getElementById('mnvRadial').value = 0;
        var execSel = document.getElementById('mnvExecTime');
        if (execSel) execSel.value = point === 'apogee' ? 'apogee' : 'perigee';
        var customRow = document.getElementById('mnvCustomTimeRow');
        if (customRow) customRow.style.display = 'none';
        _refreshManeuverDialog();
    }

    // -----------------------------------------------------------------------
    // Solver panel UI
    // -----------------------------------------------------------------------
    var _activeSolver = null;

    function _openSolverPanel(type) {
        var panel = document.getElementById('mnvSolverPanel');
        if (!panel) return;

        // Toggle off if same solver clicked
        if (_activeSolver === type) {
            panel.style.display = 'none';
            panel.innerHTML = '';
            _activeSolver = null;
            ['mnvHohmann', 'mnvIntercept', 'mnvNMC', 'mnvOrbit', 'mnvLagrange', 'mnvInclChg', 'mnvPlaneMatch', 'mnvPlanet'].forEach(function(id) {
                var btn = document.getElementById(id);
                if (btn) btn.classList.remove('active');
            });
            return;
        }

        _activeSolver = type;
        ['mnvHohmann', 'mnvIntercept', 'mnvNMC', 'mnvOrbit', 'mnvLagrange', 'mnvInclChg', 'mnvPlaneMatch', 'mnvPlanet'].forEach(function(id) {
            var btn = document.getElementById(id);
            if (btn) btn.classList.remove('active');
        });
        var btnIdMap = {
            hohmann: 'mnvHohmann', intercept: 'mnvIntercept', nmc: 'mnvNMC',
            orbit: 'mnvOrbit', lagrange: 'mnvLagrange', inclChg: 'mnvInclChg',
            planeMatch: 'mnvPlaneMatch', planet: 'mnvPlanet'
        };
        var activeBtn = document.getElementById(btnIdMap[type] || '');
        if (activeBtn) activeBtn.classList.add('active');

        if (type === 'hohmann') _renderHohmannPanel(panel);
        else if (type === 'intercept') _renderInterceptPanel(panel);
        else if (type === 'nmc') _renderNMCPanel(panel);
        else if (type === 'orbit') _renderOrbitPanel(panel);
        else if (type === 'lagrange') _renderLagrangePanel(panel);
        else if (type === 'inclChg') _renderInclChgPanel(panel);
        else if (type === 'planeMatch') _renderPlaneMatchPanel(panel);
        else if (type === 'planet') _renderPlanetPanel(panel);

        panel.style.display = 'block';

        // Stop keyboard propagation on solver inputs
        var inputs = panel.querySelectorAll('input, select');
        for (var i = 0; i < inputs.length; i++) {
            inputs[i].addEventListener('keydown', function(e) { e.stopPropagation(); });
            inputs[i].addEventListener('keyup', function(e) { e.stopPropagation(); });
        }
    }

    function _getOrbitalTargets() {
        var targets = [];
        for (var i = 0; i < _entityListItems.length; i++) {
            var item = _entityListItems[i];
            if (item.entity && (!_playerEntity || item.entity.id !== _playerEntity.id)) {
                var st = item.entity.state;
                if (st && st._eci_pos && st._eci_vel) {
                    targets.push({ id: item.entity.id, name: item.name || item.entity.name || item.entity.id, state: st });
                }
            }
        }
        return targets;
    }

    function _targetDropdownHTML(selectId) {
        var targets = _getOrbitalTargets();
        var html = '<select id="' + selectId + '">';
        if (targets.length === 0) {
            html += '<option value="">No orbital targets</option>';
        } else {
            for (var i = 0; i < targets.length; i++) {
                html += '<option value="' + targets[i].id + '">' + targets[i].name + '</option>';
            }
        }
        html += '</select>';
        return html;
    }

    function _getTargetState(selectId) {
        var sel = document.getElementById(selectId);
        if (!sel || !sel.value) return null;
        var targets = _getOrbitalTargets();
        for (var i = 0; i < targets.length; i++) {
            if (targets[i].id === sel.value) return targets[i].state;
        }
        return null;
    }

    function _applySolverResult(dvPro, dvNrm, dvRad) {
        if (!_maneuverDialogNode || typeof SpaceplanePlanner === 'undefined') return;
        SpaceplanePlanner.setNodeDV(dvPro, dvNrm, dvRad);
        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);
        document.getElementById('mnvPrograde').value = Math.round(dvPro * 10) / 10;
        document.getElementById('mnvNormal').value = Math.round(dvNrm * 10) / 10;
        document.getElementById('mnvRadial').value = Math.round(dvRad * 10) / 10;
        _refreshManeuverDialog();
    }

    // --- Hohmann Panel ---
    function _renderHohmannPanel(panel) {
        var elems = (typeof SpaceplaneOrbital !== 'undefined') ? SpaceplaneOrbital.orbitalElements : null;
        var curAlt = elems ? ((elems.sma - 6371000) / 1000).toFixed(0) : '400';
        var curSMA = elems ? (elems.sma / 1000).toFixed(0) : '6771';

        panel.innerHTML =
            '<div class="slv-row"><label>Mode</label>' +
            '<select id="slvHohMode" style="flex:1;background:#111;color:#ccc;border:1px solid #555;padding:2px 4px;font-size:11px">' +
            '<option value="alt">Altitude (km)</option>' +
            '<option value="sma">SMA (km)</option></select></div>' +
            '<div class="slv-row"><label id="slvHohLabel">Target Alt</label>' +
            '<input type="number" id="slvHohTarget" value="' + (parseInt(curAlt) + 200) + '" step="10">' +
            '<span class="slv-unit">km</span></div>' +
            '<button class="slv-compute" id="slvHohCompute">Compute Hohmann</button>' +
            '<div class="slv-result" id="slvHohResult" style="display:none"></div>';

        document.getElementById('slvHohMode').addEventListener('change', function() {
            var label = document.getElementById('slvHohLabel');
            var input = document.getElementById('slvHohTarget');
            if (this.value === 'sma') {
                label.textContent = 'Target SMA';
                input.value = curSMA;
            } else {
                label.textContent = 'Target Alt';
                input.value = parseInt(curAlt) + 200;
            }
        });
        document.getElementById('slvHohCompute').addEventListener('click', _computeHohmann);
    }

    function _computeHohmann() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;
        var elems = SpaceplaneOrbital.orbitalElements;
        if (!elems || !elems.sma) return;

        var mode = document.getElementById('slvHohMode').value;
        var inputVal = parseFloat(document.getElementById('slvHohTarget').value) || 0;
        if (inputVal <= 0) return;

        // Convert to altitude (km) for computeHohmann
        var targetAltKm = (mode === 'sma') ? (inputVal - 6371) : inputVal;
        if (targetAltKm <= 0) return;

        // Pass actual current radius for accurate vis-viva on elliptical orbits
        var currentRadius = _playerState.alt ? (6371000 + _playerState.alt) : elems.sma;
        var result = SpaceplanePlanner.computeHohmann(elems.sma, targetAltKm, currentRadius);
        if (!result.valid) return;

        var targetR = 6371 + targetAltKm;
        var resultDiv = document.getElementById('slvHohResult');
        if (resultDiv) {
            var tMin = (result.transferTime / 60).toFixed(1);
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'Target: <span class="slv-val">' + targetAltKm.toFixed(0) + ' km alt</span> (' +
                targetR.toFixed(0) + ' km SMA)<br>' +
                'Burn 1: <span class="slv-val">' + result.dv1.toFixed(1) + ' m/s</span> prograde<br>' +
                'Burn 2: <span class="slv-val">' + result.dv2.toFixed(1) + ' m/s</span> at target<br>' +
                'Transfer: <span class="slv-val">' + tMin + ' min</span> &nbsp; Total: <span class="slv-val">' +
                (Math.abs(result.dv1) + Math.abs(result.dv2)).toFixed(1) + ' m/s</span><br>' +
                '<span style="color:#887700;font-size:10px">Both burns will execute automatically.</span>';
        }

        // Store pending Hohmann target — burn 2 will be recalculated after
        // burn 1 completes using actual post-burn orbital elements
        _pendingHohmann = {
            targetAltKm: targetAltKm
        };

        // Apply burn 1 as prograde DV on current node
        _applySolverResult(result.dv1, 0, 0);
    }

    // --- Orbit Calculator Panel ---
    function _renderOrbitPanel(panel) {
        var elems = (typeof SpaceplaneOrbital !== 'undefined') ? SpaceplaneOrbital.orbitalElements : null;
        var curPeAlt = elems && elems.periapsisAlt != null ? (elems.periapsisAlt / 1000).toFixed(0) : '400';
        var curApAlt = elems && elems.apoapsisAlt != null ? (elems.apoapsisAlt / 1000).toFixed(0) : '400';

        panel.innerHTML =
            '<div class="slv-row"><label>Perigee</label>' +
            '<input type="number" id="slvOrbPe" value="' + curPeAlt + '" step="10" style="flex:1">' +
            '<select id="slvOrbPeMode" style="width:58px;background:#111;color:#ccc;border:1px solid #555;padding:2px;font-size:10px">' +
            '<option value="alt">Alt km</option><option value="rad">Rad km</option></select></div>' +
            '<div class="slv-row"><label>Apogee</label>' +
            '<input type="number" id="slvOrbAp" value="' + curApAlt + '" step="10" style="flex:1">' +
            '<select id="slvOrbApMode" style="width:58px;background:#111;color:#ccc;border:1px solid #555;padding:2px;font-size:10px">' +
            '<option value="alt">Alt km</option><option value="rad">Rad km</option></select></div>' +
            '<button class="slv-compute" id="slvOrbCompute">Compute Orbit</button>' +
            '<div class="slv-result" id="slvOrbResult" style="display:none"></div>';

        document.getElementById('slvOrbCompute').addEventListener('click', _computeOrbit);
    }

    function _computeOrbit() {
        var peVal = parseFloat(document.getElementById('slvOrbPe').value) || 0;
        var apVal = parseFloat(document.getElementById('slvOrbAp').value) || 0;
        var peMode = document.getElementById('slvOrbPeMode').value;
        var apMode = document.getElementById('slvOrbApMode').value;
        if (peVal <= 0 || apVal <= 0) return;

        // Convert to radius in km
        var rPeKm = (peMode === 'rad') ? peVal : (peVal + 6371);
        var rApKm = (apMode === 'rad') ? apVal : (apVal + 6371);

        // Ensure perigee <= apogee
        if (rPeKm > rApKm) { var tmp = rPeKm; rPeKm = rApKm; rApKm = tmp; }

        var MU_KM = 3.986004418e5; // km³/s²
        var sma = (rPeKm + rApKm) / 2;
        var ecc = (rApKm - rPeKm) / (rApKm + rPeKm);
        var period = 2 * Math.PI * Math.sqrt(sma * sma * sma / MU_KM);
        var vPe = Math.sqrt(MU_KM * (2 / rPeKm - 1 / sma));
        var vAp = Math.sqrt(MU_KM * (2 / rApKm - 1 / sma));
        var peAlt = rPeKm - 6371;
        var apAlt = rApKm - 6371;

        // Format period
        var pStr;
        if (period < 3600) pStr = (period / 60).toFixed(1) + ' min';
        else if (period < 86400) pStr = (period / 3600).toFixed(2) + ' hr';
        else pStr = (period / 86400).toFixed(2) + ' days';

        var rd = document.getElementById('slvOrbResult');
        if (rd) {
            rd.style.display = 'block';
            rd.innerHTML =
                'SMA: <span class="slv-val">' + sma.toFixed(1) + ' km</span> &nbsp; ' +
                'Ecc: <span class="slv-val">' + ecc.toFixed(6) + '</span><br>' +
                'Period: <span class="slv-val">' + pStr + '</span><br>' +
                'Perigee: <span class="slv-val">' + peAlt.toFixed(0) + ' km alt</span> (' +
                rPeKm.toFixed(0) + ' km rad) &nbsp; V = <span class="slv-val">' + (vPe * 1000).toFixed(0) + ' m/s</span><br>' +
                'Apogee: <span class="slv-val">' + apAlt.toFixed(0) + ' km alt</span> (' +
                rApKm.toFixed(0) + ' km rad) &nbsp; V = <span class="slv-val">' + (vAp * 1000).toFixed(0) + ' m/s</span>';
        }
    }

    // --- Intercept Panel ---
    function _renderInterceptPanel(panel) {
        var elems = (typeof SpaceplaneOrbital !== 'undefined') ? SpaceplaneOrbital.orbitalElements : null;
        var defTOF = elems && elems.sma > 0 ? Math.round(Math.PI * Math.sqrt(elems.sma * elems.sma * elems.sma / 3.986004418e14)) : 2700;

        panel.innerHTML =
            '<div class="slv-row"><label>Target</label>' + _targetDropdownHTML('slvIntTarget') + '</div>' +
            '<div class="slv-row"><label>TOF</label>' +
            '<input type="number" id="slvIntTOF" value="' + defTOF + '" step="60">' +
            '<span class="slv-unit">s</span></div>' +
            '<div class="slv-row"><label>R offset</label>' +
            '<input type="number" id="slvIntR" value="0" step="100">' +
            '<span class="slv-unit">m</span></div>' +
            '<div class="slv-row"><label>I offset</label>' +
            '<input type="number" id="slvIntI" value="0" step="100">' +
            '<span class="slv-unit">m</span></div>' +
            '<div class="slv-row"><label>C offset</label>' +
            '<input type="number" id="slvIntC" value="0" step="100">' +
            '<span class="slv-unit">m</span></div>' +
            '<button class="slv-compute" id="slvIntCompute">Compute Intercept</button>' +
            '<div class="slv-result" id="slvIntResult" style="display:none"></div>';

        document.getElementById('slvIntCompute').addEventListener('click', _computeIntercept);
    }

    function _computeIntercept() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;

        var targetState = _getTargetState('slvIntTarget');
        if (!targetState) {
            var rd = document.getElementById('slvIntResult');
            if (rd) { rd.style.display = 'block'; rd.innerHTML = '<span style="color:#aa4400">No target selected or target has no ECI state</span>'; }
            return;
        }

        var tof = parseFloat(document.getElementById('slvIntTOF').value) || 0;
        if (tof <= 0) return;

        var ricOffset = {
            r: parseFloat(document.getElementById('slvIntR').value) || 0,
            i: parseFloat(document.getElementById('slvIntI').value) || 0,
            c: parseFloat(document.getElementById('slvIntC').value) || 0,
        };

        var result = SpaceplanePlanner.computeIntercept(_playerState, targetState, _simElapsed, tof, ricOffset);

        var resultDiv = document.getElementById('slvIntResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<span style="color:#aa4400">Lambert solver failed — try different TOF</span>';
                return;
            }
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'Pro: <span class="slv-val">' + result.dvPro.toFixed(1) + '</span> ' +
                'Nrm: <span class="slv-val">' + result.dvNrm.toFixed(1) + '</span> ' +
                'Rad: <span class="slv-val">' + result.dvRad.toFixed(1) + '</span> m/s<br>' +
                'Total: <span class="slv-val">' + result.dvTotal.toFixed(1) + ' m/s</span>' +
                (ricOffset.r || ricOffset.i || ricOffset.c ? ' (w/ RIC offset)' : '');
        }

        _applySolverResult(result.dvPro, result.dvNrm, result.dvRad);
    }

    // --- NMC Panel ---
    function _renderNMCPanel(panel) {
        panel.innerHTML =
            '<div class="slv-row"><label>Target</label>' + _targetDropdownHTML('slvNMCTarget') + '</div>' +
            '<div class="slv-row"><label>Semi-minor</label>' +
            '<input type="number" id="slvNMCSemiMinor" value="1.0" step="0.1">' +
            '<span class="slv-unit">km</span></div>' +
            '<div class="slv-row"><label>Phase</label>' +
            '<input type="number" id="slvNMCPhase" value="0" step="15">' +
            '<span class="slv-unit">deg</span></div>' +
            '<button class="slv-compute" id="slvNMCCompute">Compute NMC</button>' +
            '<div class="slv-result" id="slvNMCResult" style="display:none"></div>';

        document.getElementById('slvNMCCompute').addEventListener('click', _computeNMC);
    }

    function _computeNMC() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;

        var targetState = _getTargetState('slvNMCTarget');
        if (!targetState) {
            var rd = document.getElementById('slvNMCResult');
            if (rd) { rd.style.display = 'block'; rd.innerHTML = '<span style="color:#aa4400">No target selected or target has no ECI state</span>'; }
            return;
        }

        var semiMinor = parseFloat(document.getElementById('slvNMCSemiMinor').value) || 1.0;
        var phase = parseFloat(document.getElementById('slvNMCPhase').value) || 0;

        var result = SpaceplanePlanner.computeNMC(_playerState, targetState, _simElapsed, semiMinor, phase);

        var resultDiv = document.getElementById('slvNMCResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<span style="color:#aa4400">NMC computation failed</span>';
                return;
            }
            var periodMin = (result.period / 60).toFixed(1);
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'Pro: <span class="slv-val">' + result.dvPro.toFixed(1) + '</span> ' +
                'Nrm: <span class="slv-val">' + result.dvNrm.toFixed(1) + '</span> ' +
                'Rad: <span class="slv-val">' + result.dvRad.toFixed(1) + '</span> m/s<br>' +
                'Total: <span class="slv-val">' + result.dvTotal.toFixed(1) + ' m/s</span><br>' +
                'NMC: <span class="slv-val">' + result.semiMinor + ' x ' + result.semiMajor + ' km</span> ' +
                'Period: <span class="slv-val">' + periodMin + ' min</span>';
        }

        _applySolverResult(result.dvPro, result.dvNrm, result.dvRad);
    }

    // --- Lagrange Panel ---
    function _renderLagrangePanel(panel) {
        panel.innerHTML =
            '<div class="slv-row"><label>System</label>' +
            '<select id="slvLagSystem" style="flex:1;background:#111;color:#ccc;border:1px solid #555;padding:2px 4px;font-size:11px">' +
            '<option value="earth-moon">Earth-Moon</option>' +
            '<option value="earth-sun">Earth-Sun</option></select></div>' +
            '<div class="slv-row"><label>Point</label>' +
            '<select id="slvLagPoint" style="flex:1;background:#111;color:#ccc;border:1px solid #555;padding:2px 4px;font-size:11px">' +
            '<option value="1">L1</option><option value="2">L2</option>' +
            '<option value="3">L3</option><option value="4">L4</option>' +
            '<option value="5">L5</option></select></div>' +
            '<div class="slv-row"><label>TOF</label>' +
            '<input type="number" id="slvLagTOF" value="3.0" step="0.5" min="0.1">' +
            '<span class="slv-unit">days</span></div>' +
            '<button class="slv-compute" id="slvLagCompute">Compute Transfer</button>' +
            '<div class="slv-result" id="slvLagResult" style="display:none"></div>';

        // Update default TOF when system changes
        document.getElementById('slvLagSystem').addEventListener('change', function() {
            var tofInput = document.getElementById('slvLagTOF');
            tofInput.value = (this.value === 'earth-sun') ? '120' : '3.0';
        });
        document.getElementById('slvLagCompute').addEventListener('click', _computeLagrange);
    }

    function _computeLagrange() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;

        var system = document.getElementById('slvLagSystem').value;
        var lNum = parseInt(document.getElementById('slvLagPoint').value);
        var tofDays = parseFloat(document.getElementById('slvLagTOF').value) || 3.0;
        if (tofDays <= 0) return;

        var result = SpaceplanePlanner.computeLagrangeTransfer(
            _playerState, system, lNum, _simElapsed, tofDays
        );

        var resultDiv = document.getElementById('slvLagResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                var distStr = result.targetDist ? (result.targetDist / 1000).toFixed(0) + ' km' : 'unknown';
                resultDiv.innerHTML = '<span style="color:#aa4400">Lambert solver failed for ' +
                    (result.targetName || 'L' + lNum) + '</span><br>' +
                    'Distance: ' + distStr + '. Try adjusting TOF.';
                return;
            }
            var distKm = result.targetDist / 1000;
            var distStr;
            if (distKm > 1e6) distStr = (distKm / 1e6).toFixed(2) + ' M km';
            else distStr = distKm.toFixed(0) + ' km';

            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'Target: <span class="slv-val">' + result.targetName + '</span> at ' +
                '<span class="slv-val">' + distStr + '</span><br>' +
                'Pro: <span class="slv-val">' + result.dvPro.toFixed(1) + '</span> ' +
                'Nrm: <span class="slv-val">' + result.dvNrm.toFixed(1) + '</span> ' +
                'Rad: <span class="slv-val">' + result.dvRad.toFixed(1) + '</span> m/s<br>' +
                'Total: <span class="slv-val">' + result.dvTotal.toFixed(1) + ' m/s</span> &nbsp; ' +
                'TOF: <span class="slv-val">' + tofDays.toFixed(1) + ' days</span>';
        }

        _applySolverResult(result.dvPro, result.dvNrm, result.dvRad);
    }

    // --- Inclination Change Panel ---
    function _renderInclChgPanel(panel) {
        var elems = (typeof SpaceplaneOrbital !== 'undefined') ? SpaceplaneOrbital.orbitalElements : null;
        var curInc = elems && elems.inclination != null ? (elems.inclination * RAD).toFixed(2) : '?';

        panel.innerHTML =
            '<div class="slv-row"><label>Target Inc</label>' +
            '<input type="number" id="slvInclTarget" value="0" step="0.1">' +
            '<span class="slv-unit">deg</span></div>' +
            '<div style="font-size:10px;color:#887700;margin-bottom:6px">Current: ' + curInc + '\u00B0</div>' +
            '<button class="slv-compute" id="slvInclCompute">Compute Incl Change</button>' +
            '<div class="slv-result" id="slvInclResult" style="display:none"></div>';

        document.getElementById('slvInclCompute').addEventListener('click', _computeInclChg);
    }

    function _computeInclChg() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;

        var targetIncDeg = parseFloat(document.getElementById('slvInclTarget').value);
        if (isNaN(targetIncDeg) || targetIncDeg < 0 || targetIncDeg > 180) return;

        var result = SpaceplanePlanner.computeInclinationChange(_playerState, _simElapsed, targetIncDeg);

        var resultDiv = document.getElementById('slvInclResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<span style="color:#aa4400">Cannot compute plane change</span>';
                return;
            }
            if (result.dvTotal < 0.1) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = 'Already at target inclination';
                return;
            }
            var escapeWarning = result.wouldEscape ?
                '<br><span style="color:#ff4444">WARNING: DV exceeds escape velocity — orbit will be unbound! Use a higher orbit or smaller change.</span>' : '';
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'From <span class="slv-val">' + result.currentIncDeg.toFixed(2) + '\u00B0</span>' +
                ' \u2192 <span class="slv-val">' + result.targetIncDeg.toFixed(2) + '\u00B0</span><br>' +
                'DV: <span class="slv-val">' + (result.dvTotal / 1000).toFixed(2) + ' km/s</span> normal at ' +
                '<span class="slv-val">' + result.nodeName + '</span> (T-' +
                _fmtTimeDuration(result.nodeTimeDt) + ')' + escapeWarning;
        }

        // Don't create node if it would escape
        if (result.wouldEscape) return;

        // Create node at the specified time and apply normal DV
        if (_maneuverDialogNode) {
            SpaceplanePlanner.deleteNode(_maneuverDialogNode);
        }
        var newNode = SpaceplanePlanner.createNodeAtTime(_playerState, _simElapsed, result.nodeTimeDt);
        if (!newNode) return;
        _maneuverDialogNode = newNode;
        SpaceplanePlanner.setNodeDV(0, result.dvNrm, 0);
        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);
        document.getElementById('mnvPrograde').value = 0;
        document.getElementById('mnvNormal').value = Math.round(result.dvNrm * 10) / 10;
        document.getElementById('mnvRadial').value = 0;
        _refreshManeuverDialog();
    }

    // --- Plane Match Panel ---
    function _renderPlaneMatchPanel(panel) {
        panel.innerHTML =
            '<div class="slv-row"><label>Target</label>' +
            _targetDropdownHTML('slvPlaneTarget') + '</div>' +
            '<button class="slv-compute" id="slvPlaneCompute">Compute Plane Match</button>' +
            '<div class="slv-result" id="slvPlaneResult" style="display:none"></div>';

        document.getElementById('slvPlaneCompute').addEventListener('click', _computePlaneMatch);
    }

    function _computePlaneMatch() {
        if (typeof SpaceplanePlanner === 'undefined' || typeof SpaceplaneOrbital === 'undefined') return;

        var targetState = _getTargetState('slvPlaneTarget');
        if (!targetState) return;

        var result = SpaceplanePlanner.computePlaneMatch(_playerState, targetState, _simElapsed);

        var resultDiv = document.getElementById('slvPlaneResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<span style="color:#aa4400">Cannot compute plane match</span>';
                return;
            }
            if (result.dvTotal < 0.1) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = 'Planes already matched';
                return;
            }
            var escapeWarning = result.wouldEscape ?
                '<br><span style="color:#ff4444">WARNING: DV exceeds escape velocity — orbit will be unbound!</span>' : '';
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                '\u0394i = <span class="slv-val">' + result.deltaIncDeg.toFixed(2) + '\u00B0</span><br>' +
                'DV: <span class="slv-val">' + (result.dvTotal / 1000).toFixed(2) + ' km/s</span> normal at intersection (T-' +
                _fmtTimeDuration(result.nodeTimeDt) + ')' + escapeWarning;
        }

        // Don't create node if it would escape
        if (result.wouldEscape) return;

        // Create node at intersection and apply normal DV
        if (_maneuverDialogNode) {
            SpaceplanePlanner.deleteNode(_maneuverDialogNode);
        }
        var newNode = SpaceplanePlanner.createNodeAtTime(_playerState, _simElapsed, result.nodeTimeDt);
        if (!newNode) return;
        _maneuverDialogNode = newNode;
        SpaceplanePlanner.setNodeDV(0, result.dvNrm, 0);
        var ep = _getPlannerEngineParams();
        SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);
        document.getElementById('mnvPrograde').value = 0;
        document.getElementById('mnvNormal').value = Math.round(result.dvNrm * 10) / 10;
        document.getElementById('mnvRadial').value = 0;
        _refreshManeuverDialog();
    }

    // --- Planetary Transfer Panel ---
    function _renderPlanetPanel(panel) {
        var planets = ['MERCURY', 'VENUS', 'MARS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE'];
        var defaultTOF = (typeof SpaceplanePlanner !== 'undefined') ?
            SpaceplanePlanner.defaultPlanetaryTOF('MARS') : 259;

        var selectHTML = '<select id="slvPlanetTarget">';
        for (var i = 0; i < planets.length; i++) {
            var name = planets[i].charAt(0) + planets[i].slice(1).toLowerCase();
            var sel = planets[i] === 'MARS' ? ' selected' : '';
            selectHTML += '<option value="' + planets[i] + '"' + sel + '>' + name + '</option>';
        }
        selectHTML += '</select>';

        panel.innerHTML =
            '<div class="slv-row"><label>Target</label>' + selectHTML + '</div>' +
            '<div class="slv-row"><label>TOF</label>' +
            '<input type="number" id="slvPlanetTOF" value="' + defaultTOF + '" step="10">' +
            '<span class="slv-unit">days</span></div>' +
            '<button class="slv-compute" id="slvPlanetCompute">Compute Transfer</button>' +
            '<div class="slv-result" id="slvPlanetResult" style="display:none"></div>';

        // Update default TOF when planet changes
        document.getElementById('slvPlanetTarget').addEventListener('change', function() {
            if (typeof SpaceplanePlanner !== 'undefined') {
                document.getElementById('slvPlanetTOF').value =
                    SpaceplanePlanner.defaultPlanetaryTOF(this.value);
            }
        });
        document.getElementById('slvPlanetCompute').addEventListener('click', _computePlanetTransfer);
    }

    function _computePlanetTransfer() {
        if (typeof SpaceplanePlanner === 'undefined') return;

        var planet = document.getElementById('slvPlanetTarget').value;
        var tofDays = parseFloat(document.getElementById('slvPlanetTOF').value) || 200;
        if (tofDays <= 0) return;

        var result = SpaceplanePlanner.computePlanetaryTransfer(
            _playerState, _simElapsed, planet, tofDays
        );

        var resultDiv = document.getElementById('slvPlanetResult');
        if (resultDiv) {
            if (!result.valid) {
                resultDiv.style.display = 'block';
                resultDiv.innerHTML = '<span style="color:#aa4400">Lambert solver failed for ' +
                    (result.targetName || planet) + '</span><br>Try adjusting TOF.';
                return;
            }
            resultDiv.style.display = 'block';
            resultDiv.innerHTML =
                'Target: <span class="slv-val">' + result.targetName + '</span><br>' +
                'Departure \u0394V: <span class="slv-val">' + (result.dvDepart / 1000).toFixed(2) + ' km/s</span><br>' +
                'C3: <span class="slv-val">' + (result.c3 / 1e6).toFixed(2) + ' km\u00B2/s\u00B2</span> &nbsp; ' +
                'V\u221E: <span class="slv-val">' + (result.vInfMag / 1000).toFixed(2) + ' km/s</span><br>' +
                'Pro: <span class="slv-val">' + result.dvPro.toFixed(1) + '</span> ' +
                'Nrm: <span class="slv-val">' + result.dvNrm.toFixed(1) + '</span> ' +
                'Rad: <span class="slv-val">' + result.dvRad.toFixed(1) + '</span> m/s<br>' +
                'TOF: <span class="slv-val">' + tofDays + ' days</span>';
        }

        _applySolverResult(result.dvPro, result.dvNrm, result.dvRad);
    }

    function _refreshManeuverDialog() {
        var node = _maneuverDialogNode;
        if (!node) return;

        // Time display
        var ttn = node.timeToNode || (node.simTime - _simElapsed);
        document.getElementById('mnvTimeToNode').textContent = 'T- ' + _fmtTimeDuration(Math.abs(ttn));

        var burnAtSec = node.simTime;
        var h = Math.floor(burnAtSec / 3600);
        var m = Math.floor((burnAtSec % 3600) / 60);
        var s = Math.floor(burnAtSec % 60);
        document.getElementById('mnvBurnAt').textContent = 'Burn @ ' +
            String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');

        // Computed fields
        document.getElementById('mnvTotalDV').textContent = node.dv.toFixed(1) + ' m/s';

        var bt = node.burnTime || 0;
        var btText = bt < 60 ? bt.toFixed(1) + 's' : (bt / 60).toFixed(1) + 'min';
        document.getElementById('mnvBurnTime').textContent = btText;

        document.getElementById('mnvEngine').textContent = node.engineLabel || _getPlannerEngineParams().label;

        document.getElementById('mnvPostAP').textContent =
            node.postAP != null ? (node.postAP / 1000).toFixed(0) + ' km' : '-- km';
        document.getElementById('mnvPostPE').textContent =
            node.postPE != null ? (node.postPE / 1000).toFixed(0) + ' km' : '-- km';
    }

    function _closeManeuverDialog(deleteNode) {
        _maneuverDialogOpen = false;
        _activeSolver = null;
        var dlg = document.getElementById('maneuverDialog');
        if (dlg) dlg.classList.remove('open');

        // Clean up solver panel
        var solverPanel = document.getElementById('mnvSolverPanel');
        if (solverPanel) { solverPanel.style.display = 'none'; solverPanel.innerHTML = ''; }

        if (deleteNode && _maneuverDialogNode && typeof SpaceplanePlanner !== 'undefined') {
            SpaceplanePlanner.deleteNode(_maneuverDialogNode);
            _pendingHohmann = null; // clear pending 2-burn if node deleted
        }
        _maneuverDialogNode = null;
        if (_maneuverUpdateTimer) { clearTimeout(_maneuverUpdateTimer); _maneuverUpdateTimer = null; }
    }

    function _fmtTimeDuration(sec) {
        if (!isFinite(sec)) return '--:--';
        sec = Math.round(sec);
        if (sec >= 86400) return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
        if (sec >= 3600) return Math.floor(sec / 3600) + 'h ' + String(Math.floor((sec % 3600) / 60)).padStart(2, '0') + 'm';
        return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
    }

    // -----------------------------------------------------------------------
    // Node marker entities
    // -----------------------------------------------------------------------
    function _createNodeMarker(node) {
        if (!node || !_viewer) return;
        // Remove existing marker if any
        if (node._marker) {
            try { _viewer.entities.remove(node._marker); } catch(e) {}
        }

        var gmst = 7.2921159e-5 * node.simTime;
        var cosG = Math.cos(-gmst), sinG = Math.sin(-gmst);
        var ex = node.eciPos[0], ey = node.eciPos[1], ez = node.eciPos[2];
        var ecefX = cosG * ex - sinG * ey;
        var ecefY = sinG * ex + cosG * ey;
        var ecefZ = ez;

        var markerPos = new Cesium.Cartesian3(ecefX, ecefY, ecefZ);

        var dvLabel = '\u0394V ' + node.dv.toFixed(0) + ' m/s';
        var btLabel = (node.burnTime < 60 ? node.burnTime.toFixed(1) + 's' : (node.burnTime / 60).toFixed(1) + 'min');

        node._marker = _viewer.entities.add({
            name: 'Maneuver Node',
            position: markerPos,
            point: { pixelSize: 12, color: Cesium.Color.ORANGE, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
            label: {
                text: dvLabel + '\n' + btLabel + ' ' + (node.engineLabel || ''),
                font: '11px monospace',
                fillColor: Cesium.Color.ORANGE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -10),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
        });
        // Store viewer ref for cleanup
        node._marker._viewer = _viewer;
    }

    function _removeNodeMarker(node) {
        if (!node || !node._marker || !_viewer) return;
        try { _viewer.entities.remove(node._marker); } catch(e) {}
        node._marker = null;
    }

    // -----------------------------------------------------------------------
    // Auto-execute state machine
    // -----------------------------------------------------------------------
    function _startAutoExec(node, mode, target) {
        _autoExecNode = node;
        _autoExecState = mode; // 'warp_only' or 'warping'
        _autoExecTarget = target || node._autoExecTarget || null;
        // Ensure no thrust during coast
        _playerState.throttle = 0;
        _playerState.alpha = 0;
        _playerState.yawOffset = 0;
        // Unpause if paused
        if (_isPaused) {
            _isPaused = false;
            _setText('pauseStatus', 'RUNNING');
            _lastTickTime = null;
        }
        _timeWarp = _getMaxWarp();
        _setText('timeWarpDisplay', _timeWarp + 'x');
        _showMessage('WARPING TO BURN POINT');
    }

    function _cancelAutoExec() {
        if (!_autoExecState) return;
        _autoExecState = null;
        _autoExecNode = null;
        _autoExecTarget = null;
        _pendingHohmann = null;
        _timeWarp = 1;
        _setText('timeWarpDisplay', '1x');
        _playerState.throttle = 0;
        _playerState.alpha = 0;
        _playerState.yawOffset = 0;
        _showMessage('AUTO-EXECUTE CANCELLED');
    }

    /**
     * Compute burn alpha/yawOffset from CURRENT orbital frame.
     * Uses the node's dvPrograde/dvNormal/dvRadial in the player's current
     * orbital frame, NOT the stored node frame. This ensures the burn direction
     * is always correct relative to the current velocity (prograde stays prograde).
     */
    function _computeBurnOrientation(node) {
        if (typeof SpaceplaneOrbital === 'undefined' || typeof SpaceplanePlanner === 'undefined') return;
        var dvP = node.dvPrograde || 0;
        var dvN = node.dvNormal || 0;
        var dvR = node.dvRadial || 0;
        var dvMag = Math.sqrt(dvP * dvP + dvN * dvN + dvR * dvR);
        if (dvMag < 0.01) return;

        var eci = SpaceplaneOrbital.geodeticToECI(_playerState, _simElapsed);
        var vMag = SpaceplaneOrbital.vecMag(eci.vel);
        if (vMag < 100) return;

        // Compute burn direction in ECI from CURRENT orbital frame
        var frame = SpaceplanePlanner.computeOrbitalFrame(eci.pos, eci.vel);
        var burnDirECI = [
            (frame.prograde[0] * dvP + frame.normal[0] * dvN + frame.radial[0] * dvR) / dvMag,
            (frame.prograde[1] * dvP + frame.normal[1] * dvN + frame.radial[1] * dvR) / dvMag,
            (frame.prograde[2] * dvP + frame.normal[2] * dvN + frame.radial[2] * dvR) / dvMag
        ];

        // Project onto physics frame (prograde / up-from-vel / lateral)
        var proDir = SpaceplaneOrbital.vecScale(eci.vel, 1 / vMag);
        var rMag = SpaceplaneOrbital.vecMag(eci.pos);
        var rHat = SpaceplaneOrbital.vecScale(eci.pos, 1 / rMag);
        var rDotPro = SpaceplaneOrbital.vecDot(rHat, proDir);
        var upFromVel = [
            rHat[0] - rDotPro * proDir[0],
            rHat[1] - rDotPro * proDir[1],
            rHat[2] - rDotPro * proDir[2]
        ];
        var upMag = SpaceplaneOrbital.vecMag(upFromVel);
        if (upMag > 0.001) upFromVel = SpaceplaneOrbital.vecScale(upFromVel, 1 / upMag);
        var latFromVel = SpaceplaneOrbital.vecCross(proDir, upFromVel);

        var bPro = SpaceplaneOrbital.vecDot(burnDirECI, proDir);
        var bUp = SpaceplaneOrbital.vecDot(burnDirECI, upFromVel);
        var bLat = SpaceplaneOrbital.vecDot(burnDirECI, latFromVel);

        _playerState.alpha = Math.atan2(bUp, Math.sqrt(bPro * bPro + bLat * bLat));
        _playerState.yawOffset = Math.atan2(bLat, bPro);
    }

    // -----------------------------------------------------------------------
    // Auto-Pointing System
    // -----------------------------------------------------------------------

    /**
     * Convert an ECI target direction into alpha/yawOffset on the player.
     * Same math as _computeBurnOrientation() but takes an arbitrary ECI direction.
     */
    function _eciDirToAttitude(dirECI) {
        if (typeof SpaceplaneOrbital === 'undefined') return;
        var O = SpaceplaneOrbital;

        var eci = O.geodeticToECI(_playerState, _simElapsed);
        var vMag = O.vecMag(eci.vel);
        if (vMag < 100) return;

        // Velocity-aligned frame
        var proDir = O.vecScale(eci.vel, 1 / vMag);
        var rMag = O.vecMag(eci.pos);
        var rHat = O.vecScale(eci.pos, 1 / rMag);
        var rDotPro = O.vecDot(rHat, proDir);
        var upFromVel = [
            rHat[0] - rDotPro * proDir[0],
            rHat[1] - rDotPro * proDir[1],
            rHat[2] - rDotPro * proDir[2]
        ];
        var upMag = O.vecMag(upFromVel);
        if (upMag > 0.001) upFromVel = O.vecScale(upFromVel, 1 / upMag);
        var latFromVel = O.vecCross(proDir, upFromVel);

        // Project target direction onto physics frame
        var bPro = O.vecDot(dirECI, proDir);
        var bUp = O.vecDot(dirECI, upFromVel);
        var bLat = O.vecDot(dirECI, latFromVel);

        _playerState.alpha = Math.atan2(bUp, Math.sqrt(bPro * bPro + bLat * bLat));
        _playerState.yawOffset = Math.atan2(bLat, bPro);
    }

    /**
     * Compute the ECI pointing direction for the current pointing mode.
     * Returns a unit vector [x,y,z] in ECI, or null if mode is manual.
     */
    function _getPointingDirectionECI() {
        if (_pointingMode === 'manual') return null;
        if (typeof SpaceplaneOrbital === 'undefined') return null;
        var O = SpaceplaneOrbital;

        var eci = O.geodeticToECI(_playerState, _simElapsed);
        var vMag = O.vecMag(eci.vel);
        var rMag = O.vecMag(eci.pos);
        if (vMag < 100 || rMag < 1000) return null;

        // Orbital frame
        var frame = null;
        if (typeof SpaceplanePlanner !== 'undefined') {
            frame = SpaceplanePlanner.computeOrbitalFrame(eci.pos, eci.vel);
        } else {
            // Fallback: compute inline
            var prograde = O.vecScale(eci.vel, 1 / vMag);
            var h = O.vecCross(eci.pos, eci.vel);
            var hMag = O.vecMag(h);
            var normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];
            var radial = O.vecCross(prograde, normal);
            frame = { prograde: prograde, normal: normal, radial: radial };
        }

        switch (_pointingMode) {
            case 'prograde':
                return frame.prograde;
            case 'retrograde':
                return O.vecScale(frame.prograde, -1);
            case 'normal':
                return frame.normal;
            case 'antinormal':
                return O.vecScale(frame.normal, -1);
            case 'radial':
                return frame.radial;
            case 'radial_neg':
                return O.vecScale(frame.radial, -1);
            case 'nadir':
                // Negative position unit vector (toward Earth center)
                return O.vecScale(eci.pos, -1 / rMag);
            case 'sun': {
                // Use Cesium's own sun model so pointing matches rendered sun exactly.
                // Cesium gives sun position in ICRF (J2000 ECI). Our sim ECI frame has
                // GMST=0 at simTime=0, so we convert ICRF→ECEF via Cesium, then ECEF→simECI.
                try {
                    var ct = _viewer.clock.currentTime;
                    var sunICRF = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(ct);
                    // ICRF → ECEF via Cesium's own Earth rotation (includes precession/nutation)
                    var icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(ct);
                    if (!icrfToFixed) icrfToFixed = Cesium.Transforms.computeTemeToPseudoFixedMatrix(ct);
                    var sunECEF = Cesium.Matrix3.multiplyByVector(icrfToFixed, sunICRF, new Cesium.Cartesian3());
                    // ECEF → sim-ECI: rotate by -simGmst around Z
                    var simGmst = 7.2921159e-5 * _simElapsed;
                    var cg = Math.cos(-simGmst), sg = Math.sin(-simGmst);
                    var sunDir = [
                        cg * sunECEF.x + sg * sunECEF.y,
                        -sg * sunECEF.x + cg * sunECEF.y,
                        sunECEF.z
                    ];
                    var sunMag = Math.sqrt(sunDir[0]*sunDir[0] + sunDir[1]*sunDir[1] + sunDir[2]*sunDir[2]);
                    if (sunMag > 0) return O.vecScale(sunDir, 1 / sunMag);
                } catch (e) { /* fallback below */ }
                // Fallback: SolarSystemEngine (won't match Cesium exactly)
                if (typeof SolarSystemEngine !== 'undefined') {
                    var jd = _JD_SIM_EPOCH_LOCAL + _simElapsed / 86400;
                    var earthPos = SolarSystemEngine.getPlanetPositionHCI('EARTH', jd);
                    var sunDir2 = [-earthPos.x, -earthPos.y, -earthPos.z];
                    var sunMag2 = Math.sqrt(sunDir2[0]*sunDir2[0] + sunDir2[1]*sunDir2[1] + sunDir2[2]*sunDir2[2]);
                    if (sunMag2 > 0) return O.vecScale(sunDir2, 1 / sunMag2);
                }
                return null;
            }
            case 'target': {
                // Direction to target entity (position-only, no velocity needed)
                if (!_pointingTarget || !_world) return null;
                var targetEnt = _world.entities[_pointingTarget];
                if (!targetEnt || !targetEnt.state) return null;
                var ts = targetEnt.state;
                // Convert target geodetic to ECEF→ECI (position only)
                var tR = 6371000 + (ts.alt || 0);
                var tCosLat = Math.cos(ts.lat || 0), tSinLat = Math.sin(ts.lat || 0);
                var tCosLon = Math.cos(ts.lon || 0), tSinLon = Math.sin(ts.lon || 0);
                var tX_ecef = tR * tCosLat * tCosLon;
                var tY_ecef = tR * tCosLat * tSinLon;
                var tZ_ecef = tR * tSinLat;
                // Rotate ECEF→ECI via GMST
                var tGmst = 7.2921159e-5 * _simElapsed;
                var tCg = Math.cos(tGmst), tSg = Math.sin(tGmst);
                var tPosECI = [
                    tCg * tX_ecef - tSg * tY_ecef,
                    tSg * tX_ecef + tCg * tY_ecef,
                    tZ_ecef
                ];
                var dir = [
                    tPosECI[0] - eci.pos[0],
                    tPosECI[1] - eci.pos[1],
                    tPosECI[2] - eci.pos[2]
                ];
                var dirMag = O.vecMag(dir);
                if (dirMag < 1) return null;
                return O.vecScale(dir, 1 / dirMag);
            }
            default:
                return null;
        }
    }

    /**
     * Per-frame pointing update. Sets alpha/yawOffset to maintain pointing direction.
     */
    function _tickPointing() {
        if (_pointingMode === 'manual') return;
        if (!_pointingLocked) return;
        // Only active above 80km (vacuum — aero forces would fight it below)
        if (_playerState.alt < 80000) return;
        // Don't override during auto-exec burns
        if (_autoExecState) return;

        var dir = _getPointingDirectionECI();
        if (dir) {
            _eciDirToAttitude(dir);
        }
    }

    function _cyclePointingMode() {
        if (_playerState.alt < 80000) {
            _showMessage('POINTING: ATM — orbit only');
            return;
        }
        var modes = POINTING_MODES;
        var curIdx = 0;
        for (var i = 0; i < modes.length; i++) {
            if (modes[i].id === _pointingMode) { curIdx = i; break; }
        }
        // Skip 'target' if no target available
        var nextIdx = (curIdx + 1) % modes.length;
        if (modes[nextIdx].id === 'target' && !_pointingTarget) {
            nextIdx = (nextIdx + 1) % modes.length;
        }
        _pointingMode = modes[nextIdx].id;
        _pointingLocked = (_pointingMode !== 'manual');
        var label = modes[nextIdx].label;
        _showMessage('POINTING: ' + label);
        _setText('pointingModeDisplay', _pointingMode === 'manual' ? '' : 'PTG:' + label + ' | ');
    }

    function _buildPointingPanel() {
        var container = document.getElementById('pointingPanelContent');
        if (!container) return;
        var html = '';
        for (var i = 0; i < POINTING_MODES.length; i++) {
            var m = POINTING_MODES[i];
            // Skip target if no target
            if (m.id === 'target' && !_pointingTarget) continue;
            var activeCls = (m.id === _pointingMode) ? ' active' : '';
            html += '<div class="pp-item' + activeCls + '" data-mode="' + m.id + '">' +
                '<span class="pp-label">' + m.label + '</span>' +
                '<span class="pp-desc">' + m.desc + '</span>' +
                '</div>';
        }
        container.innerHTML = html;
    }

    function _togglePointingPanel() {
        if (_playerState.alt < 80000) {
            _showMessage('POINTING: ATM — orbit only');
            return;
        }
        _pointingPanelOpen = !_pointingPanelOpen;
        var panel = document.getElementById('pointingPanel');
        if (panel) {
            panel.classList.toggle('open', _pointingPanelOpen);
            if (_pointingPanelOpen) _buildPointingPanel();
        }
    }

    function _selectPointingMode(modeId) {
        _pointingMode = modeId;
        _pointingLocked = (modeId !== 'manual');
        var label = 'MANUAL';
        for (var i = 0; i < POINTING_MODES.length; i++) {
            if (POINTING_MODES[i].id === modeId) { label = POINTING_MODES[i].label; break; }
        }
        _showMessage('POINTING: ' + label);
        _setText('pointingModeDisplay', modeId === 'manual' ? '' : 'PTG:' + label + ' | ');
        // Close panel
        _pointingPanelOpen = false;
        var panel = document.getElementById('pointingPanel');
        if (panel) panel.classList.remove('open');
    }

    function _tickAutoExec(frameDt) {
        if (!_autoExecState || !_autoExecNode) return;

        var node = _autoExecNode;
        var burnStartTime = node.simTime - (node.burnTime || 0) / 2;

        var timeRemaining = burnStartTime - _simElapsed;

        switch (_autoExecState) {
            case 'warp_only':
            case 'warping':
                if (timeRemaining <= 0) {
                    if (_autoExecState === 'warp_only') {
                        _timeWarp = 1;
                        _setText('timeWarpDisplay', '1x');
                        _autoExecState = null;
                        _autoExecNode = null;
                        _showMessage('ARRIVED AT BURN POINT');
                    } else {
                        // Skip separate orient phase — set orientation instantly
                        // and go straight to burning. Keeps warp high.
                        var dvTotal = Math.sqrt(
                            (node.dvPrograde || 0) * (node.dvPrograde || 0) +
                            (node.dvNormal || 0) * (node.dvNormal || 0) +
                            (node.dvRadial || 0) * (node.dvRadial || 0)
                        );
                        if (dvTotal < 0.01) {
                            _autoExecState = null;
                            _autoExecNode = null;
                            _timeWarp = 1;
                            _setText('timeWarpDisplay', '1x');
                            _showMessage('NO BURN REQUIRED');
                        } else {
                            // Set orientation instantly from current orbital frame
                            _computeBurnOrientation(node);
                            _autoExecState = 'burning';
                            _playerState.throttle = 1.0;
                            _playerState.engineOn = true;
                            _autoExecBurnEnd = _simElapsed + (node.burnTime || 1) * 2; // safety fallback at 2x
                            _autoExecCumulativeDV = 0;
                            _autoExecTargetDV = node.dv || 0;
                            // Drop warp to 1 at burn start — dynamic warp ramps
                            // up in subsequent frames. Prevents first-frame DV
                            // overshoot when transitioning from high coast warp.
                            _timeWarp = 1;
                            _setText('timeWarpDisplay', '1x');
                            _showMessage('EXECUTING BURN');
                        }
                    }
                } else {
                    // Maintain max warp while coasting to burn point
                    _timeWarp = _getMaxWarp();
                    _setText('timeWarpDisplay', _timeWarp + 'x');
                }
                break;

            case 'burning':
                // Maintain throttle
                _playerState.throttle = 1.0;
                _playerState.engineOn = true;

                // Accumulate delivered delta-V
                if (frameDt > 0) {
                    var epBurn = _getPlannerEngineParams();
                    if (epBurn.mass > 0 && epBurn.thrust > 0) {
                        _autoExecCumulativeDV += (epBurn.thrust / epBurn.mass) * frameDt;
                    }

                    // Dynamic warp: scale down as burn approaches completion to prevent overshoot
                    var dvEstRemaining = _autoExecTargetDV - _autoExecCumulativeDV;
                    if (dvEstRemaining > 0 && epBurn.thrust > 0 && epBurn.mass > 0) {
                        var dvPerSecondAt1x = epBurn.thrust / epBurn.mass;
                        // Use actual frame dt (not assumed 60fps) for accurate warp scaling
                        var realFrameDt = _timeWarp > 0 ? frameDt / _timeWarp : 0.017;
                        var dvPerFrameAt1x = dvPerSecondAt1x * realFrameDt;
                        var mxW = _getMaxWarp();
                        var maxWarpForDV = dvPerFrameAt1x > 0 ?
                            Math.max(1, Math.floor(dvEstRemaining / dvPerFrameAt1x)) : mxW;
                        _timeWarp = Math.min(mxW, maxWarpForDV);
                        _setText('timeWarpDisplay', _timeWarp + 'x');
                    } else if (_autoExecTarget && dvEstRemaining <= 0) {
                        // Past estimated DV but orbital target not yet reached —
                        // this is finite burn loss compensation. Use moderate warp.
                        _timeWarp = 8;
                        _setText('timeWarpDisplay', '8x');
                    }
                }

                // Update orientation from CURRENT orbital frame (not stale node state)
                _computeBurnOrientation(node);

                // Check burn completion via orbital element targeting or DV fallback
                var burnDone = false;

                if (_autoExecTarget && typeof SpaceplaneOrbital !== 'undefined') {
                    // Orbital element targeting — compute elements from current ECI state
                    var eci = SpaceplaneOrbital.geodeticToECI(_playerState, _simElapsed);
                    var rr = eci.pos, vv = eci.vel;
                    var rM = Math.sqrt(rr[0]*rr[0] + rr[1]*rr[1] + rr[2]*rr[2]);
                    var vM = Math.sqrt(vv[0]*vv[0] + vv[1]*vv[1] + vv[2]*vv[2]);
                    var ene = 0.5 * vM * vM - 3.986004418e14 / rM;

                    if (ene < 0) {
                        var curSMA = -3.986004418e14 / (2 * ene);
                        var rdv = rr[0]*vv[0] + rr[1]*vv[1] + rr[2]*vv[2];
                        var cf1 = vM*vM - 3.986004418e14 / rM;
                        var evx = (cf1*rr[0] - rdv*vv[0]) / 3.986004418e14;
                        var evy = (cf1*rr[1] - rdv*vv[1]) / 3.986004418e14;
                        var evz = (cf1*rr[2] - rdv*vv[2]) / 3.986004418e14;
                        var curEcc = Math.sqrt(evx*evx + evy*evy + evz*evz);
                        var curApoAlt = curSMA * (1 + curEcc) - 6371000;
                        var curPeAlt = curSMA * (1 - curEcc) - 6371000;

                        if (_autoExecTarget.type === 'raise_apo') {
                            burnDone = curApoAlt >= _autoExecTarget.targetAltM;
                        } else if (_autoExecTarget.type === 'lower_pe') {
                            burnDone = curPeAlt <= _autoExecTarget.targetAltM;
                        } else if (_autoExecTarget.type === 'circularize') {
                            var tR = _autoExecTarget.targetR;
                            // Monotonic SMA crossing — prograde burns increase SMA,
                            // retrograde burns decrease it. This check can never be
                            // missed at high warp (unlike threshold-based checks where
                            // a single frame can overshoot both ecc and SMA windows).
                            var dvSign = (node.dvPrograde || 0) >= 0 ? 1 : -1;
                            if (dvSign > 0) {
                                burnDone = curSMA >= tR;
                            } else {
                                burnDone = curSMA <= tR;
                            }
                        }

                        // SMA-proximity warp scaling for circularize precision
                        // Reduces warp as SMA approaches target to limit per-frame
                        // overshoot from the monotonic crossing check.
                        if (_autoExecTarget.type === 'circularize' && !burnDone) {
                            var tRw = _autoExecTarget.targetR;
                            var smaDist = Math.abs(curSMA - tRw);
                            if (smaDist < 500000) {
                                var smaMaxWarp = Math.max(1, Math.floor(smaDist / 10000));
                                if (_timeWarp > smaMaxWarp) {
                                    _timeWarp = smaMaxWarp;
                                    _setText('timeWarpDisplay', _timeWarp + 'x');
                                }
                            }
                        }
                    }

                    // Safety: don't burn more than 2x the computed DV
                    if (_autoExecCumulativeDV >= _autoExecTargetDV * 2.0) burnDone = true;
                } else {
                    // No orbital targeting — use DV-based cutoff
                    burnDone = _autoExecCumulativeDV >= _autoExecTargetDV;
                }

                // Time safety fallback
                if (_simElapsed >= _autoExecBurnEnd) burnDone = true;

                if (burnDone) {
                    // Burn complete — the continuous thrust already applied the DV
                    // through the physics engine. Just clean up the node (do NOT call
                    // executeNode which would apply the full impulse DV again).
                    _playerState.throttle = 0;
                    _playerState.alpha = 0;
                    _playerState.yawOffset = 0;
                    _removeNodeMarker(node);
                    SpaceplanePlanner.deleteNode(node);
                    _autoExecState = null;
                    _autoExecNode = null;
                    _autoExecTarget = null;

                    // Check for pending Hohmann burn 2
                    if (_pendingHohmann && typeof SpaceplaneOrbital !== 'undefined') {
                        var ph = _pendingHohmann;
                        _pendingHohmann = null;
                        _showMessage('BURN 1 COMPLETE — COMPUTING BURN 2');

                        // Force orbital elements update from actual post-burn state
                        SpaceplaneOrbital.update(_playerState, _simElapsed);
                        var postElems = SpaceplaneOrbital.orbitalElements;

                        if (postElems && postElems.sma > 0 && (postElems.eccentricity || 0) < 1.0) {
                            var MU_E = 3.986004418e14;
                            var e = postElems.eccentricity || 0;
                            var apoR = postElems.sma * (1 + e);
                            var peR = postElems.sma * (1 - e);
                            var targetR = 6371000 + ph.targetAltKm * 1000;

                            // Determine which end of the transfer orbit is the target:
                            // Raising orbit → target is near apoapsis (far end)
                            // Lowering orbit → target is near periapsis (near end)
                            var diffApo = Math.abs(targetR - apoR);
                            var diffPe = Math.abs(targetR - peR);

                            var burnR, dtToBurn, burnLabel;
                            if (diffApo <= diffPe) {
                                burnR = apoR;
                                dtToBurn = postElems.timeToApoapsis;
                                burnLabel = 'apoapsis';
                            } else {
                                burnR = peR;
                                dtToBurn = postElems.timeToPeriapsis;
                                burnLabel = 'periapsis';
                            }

                            // Guard: ensure valid time
                            if (dtToBurn == null || !isFinite(dtToBurn) || dtToBurn < 1) {
                                // Fallback: use half the orbital period
                                dtToBurn = postElems.period ? postElems.period / 2 : 2700;
                            }

                            var vAtBurn = Math.sqrt(MU_E * (2 / burnR - 1 / postElems.sma));
                            var vCirc = Math.sqrt(MU_E / burnR);
                            var dv2 = vCirc - vAtBurn; // positive=prograde at AP, negative=retrograde at PE

                            if (!isFinite(dv2)) {
                                _timeWarp = 1;
                                _setText('timeWarpDisplay', '1x');
                                _showMessage('BURN 1 COMPLETE — Invalid transfer orbit');
                            } else {
                                var node2 = SpaceplanePlanner.createNodeAtTime(
                                    _playerState, _simElapsed, dtToBurn
                                );
                                if (node2) {
                                    SpaceplanePlanner.setNodeDV(dv2, 0, 0);
                                    var ep = _getPlannerEngineParams();
                                    SpaceplanePlanner.setEngineParams(ep.thrust, ep.mass, ep.label);
                                    _createNodeMarker(node2);
                                    SpaceplanePlanner.updateNodePrediction();
                                    _showMessage('BURN 2: ' + dv2.toFixed(1) + ' m/s at ' + burnLabel + ' (' +
                                        (dtToBurn / 60).toFixed(1) + ' min)');
                                    _startAutoExec(node2, 'warping', { type: 'circularize', targetR: targetR });
                                } else {
                                    _timeWarp = 1;
                                    _setText('timeWarpDisplay', '1x');
                                    _showMessage('BURN 1 COMPLETE — Could not create burn 2 node');
                                }
                            }
                        } else {
                            _timeWarp = 1;
                            _setText('timeWarpDisplay', '1x');
                            _showMessage('BURN 1 COMPLETE — No valid orbit for burn 2');
                        }
                    } else {
                        // All burns complete — drop warp
                        _timeWarp = 1;
                        _setText('timeWarpDisplay', '1x');
                        _showMessage('BURN COMPLETE');
                    }
                    // Stay in planner mode so user can chain maneuvers
                }
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Keyboard handling
    // -----------------------------------------------------------------------
    function _setupKeyboard() {
        window.addEventListener('keydown', function(e) {
            if (!_started) return;

            // Don't capture keys when cyber cockpit is focused
            if (typeof CyberCockpit !== 'undefined' && CyberCockpit.isVisible() &&
                document.activeElement && document.activeElement.id === 'cyberInput') {
                return;
            }

            _keys[e.code] = true;
            if (e.repeat) return;

            var handled = true;

            // Panel toggles in both modes
            if (_handlePanelToggle(e.code, e)) {
                e.preventDefault(); e.stopPropagation();
                return;
            }

            // Planner mode controls
            if (_plannerMode) {
                // If dialog is open, only handle Escape to cancel
                if (_maneuverDialogOpen) {
                    if (e.code === 'Escape') {
                        _closeManeuverDialog(true);
                    }
                    // Let inputs handle their own keys
                    return;
                }

                switch (e.code) {
                    case 'KeyM':
                        if (_autoExecState) _cancelAutoExec();
                        _togglePlannerMode();
                        break;
                    case 'KeyN':
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            _updatePlannerEngineParams();
                            var node = SpaceplanePlanner.createNode(_playerState, _simElapsed);
                            if (node) _openManeuverDialog(node);
                        } break;
                    case 'Delete': case 'Backspace':
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            var selNode = SpaceplanePlanner.selectedNode;
                            if (selNode) _removeNodeMarker(selNode);
                            SpaceplanePlanner.deleteSelectedNode();
                            _showMessage('NODE DELETED');
                        } break;
                    case 'Enter': case 'NumpadEnter':
                        // Quick-execute as impulse (advanced)
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            var execNode = SpaceplanePlanner.selectedNode;
                            if (execNode) _removeNodeMarker(execNode);
                            SpaceplanePlanner.executeNode(_playerState, _simElapsed);
                            _showMessage('EXECUTING NODE');
                        } break;
                    case 'KeyP':
                        _toggleEnginePanel();
                        break;
                    case 'KeyI':
                        _cyclePointingMode();
                        break;
                    case 'KeyL':
                        _togglePointingPanel();
                        break;
                    case 'Escape':
                        if (typeof KeyboardHelp !== 'undefined' && KeyboardHelp.isVisible()) {
                            KeyboardHelp.hide();
                        } else if (_autoExecState) {
                            _cancelAutoExec();
                        } else {
                            _isPaused = !_isPaused;
                            _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                            _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                            if (!_isPaused) _lastTickTime = null;
                        }
                        break;
                    case 'Equal': case 'NumpadAdd':
                        _timeWarp = Math.min(_timeWarp * 2, _getMaxWarp());
                        _setText('timeWarpDisplay', _timeWarp + 'x');
                        _showMessage('TIME WARP: ' + _timeWarp + 'x');
                        break;
                    case 'Minus': case 'NumpadSubtract':
                        _timeWarp = Math.max(_timeWarp / 2, 0.25);
                        _setText('timeWarpDisplay', _timeWarp + 'x');
                        _showMessage('TIME WARP: ' + _timeWarp + 'x');
                        break;
                    case 'KeyF': _toggleSearchPanel(); break;
                    case 'KeyH':
                        if (typeof KeyboardHelp !== 'undefined') KeyboardHelp.toggle();
                        else _togglePanel('help');
                        break;
                    default: handled = false; break;
                }
                if (handled) { e.preventDefault(); e.stopPropagation(); }
                return;
            }

            // In globe modes, only handle camera/meta keys — pass rest to Cesium
            if (_cameraMode === 'earth' || _cameraMode === 'moon') {
                switch (e.code) {
                    case 'Escape':
                        if (typeof KeyboardHelp !== 'undefined' && KeyboardHelp.isVisible()) {
                            KeyboardHelp.hide();
                        } else {
                            _isPaused = !_isPaused;
                            _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                            _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                            if (!_isPaused) _lastTickTime = null;
                        }
                        break;
                    case 'KeyC': _cycleCamera(); break;
                    case 'KeyF': _toggleSearchPanel(); break;
                    case 'KeyG':
                        _globeControlsEnabled = !_globeControlsEnabled;
                        _showMessage('Flight controls: ' + (_globeControlsEnabled ? 'ON' : 'OFF'));
                        break;
                    case 'KeyH':
                        if (typeof KeyboardHelp !== 'undefined') KeyboardHelp.toggle();
                        else _togglePanel('help');
                        break;
                    case 'Equal': case 'NumpadAdd':
                        _timeWarp = Math.min(_timeWarp * 2, _getMaxWarp());
                        _setText('timeWarpDisplay', _timeWarp + 'x');
                        _showMessage('TIME WARP: ' + _timeWarp + 'x');
                        break;
                    case 'Minus': case 'NumpadSubtract':
                        _timeWarp = Math.max(_timeWarp / 2, 0.25);
                        _setText('timeWarpDisplay', _timeWarp + 'x');
                        _showMessage('TIME WARP: ' + _timeWarp + 'x');
                        break;
                    default: handled = false; break;
                }
                if (handled) { e.preventDefault(); e.stopPropagation(); }
                return;
            }

            // Chase/cockpit/free mode — we handle ALL keys here and always
            // preventDefault to stop Cesium from consuming arrow keys etc.
            switch (e.code) {
                case 'Escape':
                    if (typeof KeyboardHelp !== 'undefined' && KeyboardHelp.isVisible()) {
                        KeyboardHelp.hide();
                        break;
                    }
                    if (_enginePanelOpen) {
                        _enginePanelOpen = false;
                        var epanel = document.getElementById('enginePanel');
                        if (epanel) epanel.classList.remove('open');
                        break;
                    }
                    if (_pointingPanelOpen) {
                        _pointingPanelOpen = false;
                        var ppanel = document.getElementById('pointingPanel');
                        if (ppanel) ppanel.classList.remove('open');
                        break;
                    }
                    _isPaused = !_isPaused;
                    _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                    _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                    if (!_isPaused) _lastTickTime = null;
                    break;
                case 'Space':
                    _fireWeapon();
                    break;
                case 'KeyR':
                    _cycleWeapon();
                    break;
                case 'KeyV':
                    _cycleSensor();
                    break;
                case 'KeyE':
                    _playerState.engineOn = !_playerState.engineOn;
                    _showMessage(_playerState.engineOn ? 'ENGINE START' : 'ENGINE STOP');
                    break;
                case 'KeyG':
                    _playerState.gearDown = !_playerState.gearDown;
                    _playerState.gearTransition = _playerConfig.gear_transition_time || 3;
                    _showMessage(_playerState.gearDown ? 'GEAR DOWN' : 'GEAR UP');
                    break;
                case 'KeyF':
                    _playerState.flapsDown = !_playerState.flapsDown;
                    _showMessage(_playerState.flapsDown ? 'FLAPS DOWN' : 'FLAPS UP');
                    break;
                case 'KeyX':
                    _playerState.speedBrakeOut = !_playerState.speedBrakeOut;
                    _showMessage(_playerState.speedBrakeOut ? 'SPEED BRAKE OUT' : 'SPEED BRAKE IN');
                    break;
                case 'KeyB':
                    // Hold-to-brake: keydown = brakes on, keyup = brakes off
                    _playerState.brakesOn = true;
                    _showMessage('BRAKES ON');
                    break;
                case 'KeyA':
                    _toggleAutopilotPanel();
                    break;
                case 'KeyT':
                    // Shift+T = manual trim step down, Ctrl+T = manual trim step up
                    // Plain T = auto-trim (handled per-frame in tick while held)
                    if (e.shiftKey) {
                        _adjustTrim(-1);
                    } else if (e.ctrlKey) {
                        _adjustTrim(1);
                    }
                    // Plain T: auto-trim runs in tick() via _keys['KeyT']
                    break;
                case 'KeyP':
                    _toggleEnginePanel();
                    break;
                case 'KeyI':
                    _cyclePointingMode();
                    break;
                case 'KeyL':
                    _togglePointingPanel();
                    break;
                case 'KeyM': _togglePlannerMode(); break;
                case 'KeyC': _cycleCamera(); break;
                case 'KeyH':
                    if (typeof KeyboardHelp !== 'undefined') KeyboardHelp.toggle();
                    else _togglePanel('help');
                    break;
                case 'Equal': case 'NumpadAdd':
                    _timeWarp = Math.min(_timeWarp * 2, _getMaxWarp());
                    _setText('timeWarpDisplay', _timeWarp + 'x');
                    _showMessage('TIME WARP: ' + _timeWarp + 'x');
                    break;
                case 'Minus': case 'NumpadSubtract':
                    _timeWarp = Math.max(_timeWarp / 2, 0.25);
                    _setText('timeWarpDisplay', _timeWarp + 'x');
                    _showMessage('TIME WARP: ' + _timeWarp + 'x');
                    break;
                case 'KeyN':
                    _cycleDisplayMode();
                    break;
                case 'Delete': case 'Backspace':
                    if (typeof SpaceplanePlanner !== 'undefined') {
                        SpaceplanePlanner.deleteSelectedNode();
                        _showMessage('NODE DELETED');
                    }
                    break;
                case 'Enter': case 'NumpadEnter':
                    if (typeof SpaceplanePlanner !== 'undefined') {
                        SpaceplanePlanner.executeNode(_playerState, _simElapsed);
                        _showMessage('EXECUTING NODE');
                    }
                    break;
                default: handled = false; break;
            }
            // Always prevent default for arrow keys in chase/cockpit/free modes
            // to stop Cesium from stealing them for camera control
            var isArrowKey = (e.code === 'ArrowUp' || e.code === 'ArrowDown' ||
                              e.code === 'ArrowLeft' || e.code === 'ArrowRight');
            if (handled || isArrowKey) { e.preventDefault(); e.stopPropagation(); }
        }, true);

        window.addEventListener('keyup', function(e) {
            // Don't capture keys when cyber cockpit is focused
            if (typeof CyberCockpit !== 'undefined' && CyberCockpit.isVisible() &&
                document.activeElement && document.activeElement.id === 'cyberInput') {
                return;
            }

            _keys[e.code] = false;

            // Hold-to-brake: release B = brakes off
            if (e.code === 'KeyB' && _playerState) {
                _playerState.brakesOn = false;
            }

            // Only capture keyup in chase/cockpit — let free/globe pass to Cesium
            if (_started && (_cameraMode === 'chase' || _cameraMode === 'cockpit')) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
    }

    function _getControls() {
        var controls = {};

        if (_plannerMode && typeof SpaceplanePlanner !== 'undefined') {
            if (_keys['KeyW']) SpaceplanePlanner.adjustNodeDV('prograde', 1);
            if (_keys['KeyS']) SpaceplanePlanner.adjustNodeDV('retrograde', 1);
            if (_keys['KeyA']) SpaceplanePlanner.adjustNodeDV('normal', 1);
            if (_keys['KeyD']) SpaceplanePlanner.adjustNodeDV('antinormal', 1);
            if (_keys['KeyQ']) SpaceplanePlanner.adjustNodeDV('radial_in', 1);
            if (_keys['KeyE']) SpaceplanePlanner.adjustNodeDV('radial_out', 1);
            if (_keys['ArrowUp']) SpaceplanePlanner.adjustNodeDV('increase', 1);
            if (_keys['ArrowDown']) SpaceplanePlanner.adjustNodeDV('decrease', 1);
            if (_keys['ArrowLeft']) SpaceplanePlanner.adjustNodeTime(-10);
            if (_keys['ArrowRight']) SpaceplanePlanner.adjustNodeTime(10);
            return controls;
        }

        // In globe camera modes, suppress flight controls
        // (arrow keys optionally still work via _globeControlsEnabled toggle)
        if (_cameraMode === 'earth' || _cameraMode === 'moon') {
            if (!_globeControlsEnabled) return controls;
        }

        controls.throttleUp = _keys['KeyW'];
        controls.throttleDown = _keys['KeyS'];

        if (_keys['ArrowDown']) controls.pitch = 1;
        else if (_keys['ArrowUp']) controls.pitch = -1;
        else controls.pitch = 0;

        if (_keys['ArrowLeft'] && !_keys['ControlLeft'] && !_keys['ControlRight']) controls.roll = -1;
        else if (_keys['ArrowRight'] && !_keys['ControlLeft'] && !_keys['ControlRight']) controls.roll = 1;
        else controls.roll = 0;

        // Yaw: Ctrl+Arrow OR Q/D keys (Q=left, D=right)
        var hasCtrl = _keys['ControlLeft'] || _keys['ControlRight'];
        if ((hasCtrl && _keys['ArrowLeft']) || _keys['KeyQ']) controls.yaw = -1;
        else if ((hasCtrl && _keys['ArrowRight']) || _keys['KeyD']) controls.yaw = 1;
        else controls.yaw = 0;

        return controls;
    }

    // -----------------------------------------------------------------------
    // Pitch trim
    // -----------------------------------------------------------------------
    // Manual trim: Shift+T = nose down, no modifier on T starts auto-trim
    function _adjustTrim(dir) {
        if (!_playerState) return;
        var DEG = Math.PI / 180;
        var step = 0.5 * DEG;  // 0.5° per press
        _playerState.trimAlpha = (_playerState.trimAlpha || 0) + dir * step;
        // Clamp to -5° to +10°
        _playerState.trimAlpha = Math.max(-5 * DEG, Math.min(10 * DEG, _playerState.trimAlpha));
        var trimDeg = (_playerState.trimAlpha / DEG).toFixed(1);
        _showMessage('TRIM: ' + trimDeg + '°');
    }

    // Auto-trim: called each tick while T is held.
    // Observes gamma drift and adjusts trimAlpha to converge on zero drift.
    var _lastGamma = null;
    var _autoTrimActive = false;
    function _runAutoTrim(dt) {
        if (!_playerState || dt <= 0) return;
        var DEG = Math.PI / 180;

        var gamma = _playerState.gamma || 0;

        if (_lastGamma === null) {
            _lastGamma = gamma;
            return;
        }

        // Gamma rate (rad/s) — positive = climbing, negative = descending
        var gammaRate = (gamma - _lastGamma) / dt;
        _lastGamma = gamma;

        // Adjust trim to oppose drift: if climbing, reduce trim; if descending, increase trim
        // Gain tuned for convergence in 2-3 seconds
        var trimAdj = -gammaRate * 0.3 * dt;
        _playerState.trimAlpha = (_playerState.trimAlpha || 0) + trimAdj;

        // Also nudge alpha toward trim for immediate effect
        _playerState.alpha = _playerState.alpha + trimAdj * 0.5;

        // Clamp
        _playerState.trimAlpha = Math.max(-5 * DEG, Math.min(10 * DEG, _playerState.trimAlpha));

        if (!_autoTrimActive) {
            _autoTrimActive = true;
            _showMessage('AUTO TRIM');
        }
    }

    // -----------------------------------------------------------------------
    // Propulsion mode cycling
    // -----------------------------------------------------------------------
    function _cyclePropulsionMode() {
        if (!_playerState || _propModes.length <= 1) return;
        _propModeIndex = (_propModeIndex + 1) % _propModes.length;
        var entry = _propModes[_propModeIndex];
        _playerState.forcedPropMode = entry.mode;
        _playerState.propulsionMode = entry.mode;
        if (entry.mode === 'ROCKET' && entry.thrust) {
            _playerConfig.thrust_rocket = entry.thrust;
        }
        _setText('propModeDisplay', entry.name);
        _setTextWithClass('sysProp', entry.name, entry.color || '');
        var desc = entry.desc ? ' (' + entry.desc + ')' : '';
        _showMessage('PROPULSION: ' + entry.name + desc);
    }

    // -----------------------------------------------------------------------
    // Engine Selection Panel
    // -----------------------------------------------------------------------

    function _formatThrust(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MN';
        if (n >= 1000) return (n / 1000).toFixed(0) + ' kN';
        return n.toFixed(1) + ' N';
    }

    function _buildEnginePanel() {
        var container = document.getElementById('enginePanelContent');
        if (!container) return;

        // Group by category
        var cats = [
            { label: 'ATMOSPHERIC', entries: [] },
            { label: 'MICRO THRUSTERS', entries: [] },
            { label: 'PROP / LIGHT', entries: [] },
            { label: 'MEDIUM ROCKETS', entries: [] },
            { label: 'HEAVY / EXOTIC', entries: [] }
        ];

        for (var i = 0; i < _propModes.length; i++) {
            var e = _propModes[i];
            var catIdx;
            if (e.mode === 'TAXI' || e.mode === 'AIR' || e.mode === 'HYPERSONIC') {
                catIdx = 0;
            } else if (!e.thrust || e.thrust <= 500) {
                catIdx = 1;
            } else if (e.thrust <= 15000) {
                catIdx = 2;
            } else if (e.thrust <= 200000) {
                catIdx = 3;
            } else {
                catIdx = 4;
            }
            cats[catIdx].entries.push({ index: i, entry: e });
        }

        var html = '';
        var keyNum = 1;
        _propKeyMap = {};
        cats.forEach(function(cat) {
            if (cat.entries.length === 0) return;
            html += '<div class="ep-cat">' + cat.label + '</div>';
            cat.entries.forEach(function(item) {
                var shortcut = '';
                if (keyNum <= 9) { shortcut = String(keyNum); _propKeyMap[shortcut] = item.index; keyNum++; }
                else if (keyNum === 10) { shortcut = '0'; _propKeyMap['0'] = item.index; keyNum++; }
                var activeCls = (item.index === _propModeIndex) ? ' active' : '';
                var thrustStr = item.entry.thrust ? _formatThrust(item.entry.thrust) : '';
                html += '<div class="ep-item' + activeCls + '" data-idx="' + item.index + '">' +
                    '<span class="ep-key">' + shortcut + '</span>' +
                    '<span class="ep-name">' + item.entry.name + '</span>' +
                    '<span class="ep-thrust">' + thrustStr + '</span>' +
                    '<span class="ep-desc">' + (item.entry.desc || '') + '</span>' +
                    '</div>';
            });
        });

        container.innerHTML = html;
    }

    function _toggleEnginePanel() {
        if (_propModes.length <= 1) {
            _showMessage('SINGLE ENGINE');
            return;
        }
        _enginePanelOpen = !_enginePanelOpen;
        var panel = document.getElementById('enginePanel');
        if (panel) {
            panel.classList.toggle('open', _enginePanelOpen);
            if (_enginePanelOpen) _buildEnginePanel();
        }
    }

    function _selectEngineByIndex(idx) {
        if (idx < 0 || idx >= _propModes.length) return;
        _propModeIndex = idx;
        var entry = _propModes[idx];
        _playerState.forcedPropMode = entry.mode;
        _playerState.propulsionMode = entry.mode;
        if (entry.mode === 'ROCKET' && entry.thrust) {
            _playerConfig.thrust_rocket = entry.thrust;
        }
        _setText('propModeDisplay', entry.name);
        _setTextWithClass('sysProp', entry.name, entry.color || '');
        var desc = entry.desc ? ' (' + entry.desc + ')' : '';
        _showMessage('ENGINE: ' + entry.name + desc);

        // Close panel
        _enginePanelOpen = false;
        var panel = document.getElementById('enginePanel');
        if (panel) panel.classList.remove('open');

        // If in planner mode, update engine params for burn time calc
        if (_plannerMode && typeof _updatePlannerEngineParams === 'function') {
            _updatePlannerEngineParams();
        }
    }

    // Attach click handler for engine panel (event delegation)
    document.addEventListener('DOMContentLoaded', function() {
        var epContent = document.getElementById('enginePanelContent');
        if (epContent) {
            epContent.addEventListener('click', function(e) {
                var item = e.target.closest('.ep-item');
                if (!item) return;
                var idx = parseInt(item.getAttribute('data-idx'));
                if (!isNaN(idx)) _selectEngineByIndex(idx);
            });
        }
        // Pointing panel click handler
        var ppContent = document.getElementById('pointingPanelContent');
        if (ppContent) {
            ppContent.addEventListener('click', function(e) {
                var item = e.target.closest('.pp-item');
                if (!item) return;
                var mode = item.getAttribute('data-mode');
                if (mode) _selectPointingMode(mode);
            });
        }
    });

    // -----------------------------------------------------------------------
    // Tactical Data Link (Link 16 style visualization)
    // -----------------------------------------------------------------------
    function _tickDataLinks() {
        if (!_viewer || !_world) return;

        // If disabled, hide all existing link entities and return
        if (!_dataLinksEnabled) {
            for (var di = 0; di < _dataLinkEntities.length; di++) {
                _dataLinkEntities[di].show = false;
            }
            // Update HUD indicator
            var dlInd = document.getElementById('dataLinkIndicator');
            if (dlInd) dlInd.style.display = 'none';
            return;
        }

        // Throttle to 2Hz (every 500ms)
        var now = Date.now();
        if (now - _dataLinkLastTick < 500) return;
        _dataLinkLastTick = now;

        // Update HUD indicator
        var dlInd2 = document.getElementById('dataLinkIndicator');
        if (dlInd2) dlInd2.style.display = 'inline';

        // Determine the player team
        var playerTeam = _playerEntity ? _playerEntity.team : null;
        if (_observerMode && !playerTeam) playerTeam = 'blue'; // default for observer

        // Collect all active same-team entities with valid positions
        var teamEnts = [];
        _world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.team !== playerTeam) return;
            var s = ent.state;
            if (!s || s.lat == null || s.lon == null) return;
            teamEnts.push({
                id: ent.id,
                pos: Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.alt || 0)
            });
        });

        // Build pairs within 500km, limited to 50 links
        var MAX_LINKS = 50;
        var MAX_RANGE = 500000; // 500km in meters
        var links = [];
        for (var i = 0; i < teamEnts.length && links.length < MAX_LINKS; i++) {
            for (var j = i + 1; j < teamEnts.length && links.length < MAX_LINKS; j++) {
                var dist = Cesium.Cartesian3.distance(teamEnts[i].pos, teamEnts[j].pos);
                if (dist <= MAX_RANGE) {
                    links.push({ a: teamEnts[i], b: teamEnts[j] });
                }
            }
        }

        // Create or update Cesium polyline entities
        // Reuse existing entities, create new ones if needed, hide extras
        for (var li = 0; li < links.length; li++) {
            var link = links[li];
            if (li < _dataLinkEntities.length) {
                // Reuse existing entity
                var ent = _dataLinkEntities[li];
                ent.show = true;
                ent.polyline.positions = new Cesium.CallbackProperty((function(a, b) {
                    return function() { return [a, b]; };
                })(link.a.pos, link.b.pos), false);
            } else {
                // Create new entity
                var newEnt = _viewer.entities.add({
                    polyline: {
                        positions: new Cesium.CallbackProperty((function(a, b) {
                            return function() { return [a, b]; };
                        })(link.a.pos, link.b.pos), false),
                        width: 1,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.CYAN.withAlpha(0.3),
                            dashLength: 16
                        })
                    }
                });
                _dataLinkEntities.push(newEnt);
            }
        }

        // Hide any extra entities beyond current link count
        for (var hi = links.length; hi < _dataLinkEntities.length; hi++) {
            _dataLinkEntities[hi].show = false;
        }
    }

    function _cleanupDataLinks() {
        for (var i = 0; i < _dataLinkEntities.length; i++) {
            _viewer.entities.remove(_dataLinkEntities[i]);
        }
        _dataLinkEntities = [];
        _dataLinksEnabled = false;
    }

    // -----------------------------------------------------------------------
    // Terrain Following / Terrain Avoidance
    // -----------------------------------------------------------------------

    /**
     * Sample terrain elevation at current position and look-ahead points,
     * then drive autopilot altitude hold to maintain target AGL.
     * Throttled to 2Hz. Auto-disables above 3000m AGL.
     */
    function _tickTerrainFollowing(dt) {
        if (!_tfEnabled || !_playerState || !_viewer) return;

        // Throttle to 2Hz (500ms)
        var now = Date.now();
        if (now - _tfLastSampleTime < 500) {
            // Still pass current state to HUD between samples
            _playerState._tfEnabled = _tfEnabled;
            _playerState._tfAgl = _playerState.alt - _tfCurrentTerrainElev;
            _playerState._tfAglTarget = _tfAglTarget;
            _playerState._terrainAhead = _tfTerrainAhead;
            return;
        }
        _tfLastSampleTime = now;

        var lat = _playerState.lat;   // radians
        var lon = _playerState.lon;   // radians
        var alt = _playerState.alt;   // meters MSL
        var hdg = _playerState.heading; // radians

        if (lat == null || lon == null) return;

        // Sample terrain at current position using globe.getHeight (synchronous)
        var globe = _viewer.scene.globe;
        var currentCarto = new Cesium.Cartographic(lon, lat);
        var terrainElev = globe.getHeight(currentCarto);
        if (terrainElev == null || !isFinite(terrainElev)) terrainElev = 0;
        _tfCurrentTerrainElev = terrainElev;

        var currentAGL = alt - terrainElev;

        // Auto-disable above 3000m AGL
        if (currentAGL > 3000) {
            _tfEnabled = false;
            _showMessage('TF/TA OFF (above 3000m AGL)');
            _playerState._tfEnabled = false;
            _playerState._tfAgl = currentAGL;
            _playerState._tfAglTarget = _tfAglTarget;
            _playerState._terrainAhead = [];
            _syncAutopilotPanel();
            return;
        }

        // Sample terrain at look-ahead points along heading
        // Distances: 2km, 5km, 10km ahead
        var lookAheadDists = [2000, 5000, 10000];
        var terrainAhead = [];
        var R_EARTH_M = 6371000;

        for (var i = 0; i < lookAheadDists.length; i++) {
            var dist = lookAheadDists[i];
            // Great-circle destination from current position
            var angDist = dist / R_EARTH_M;
            var sinLat = Math.sin(lat);
            var cosLat = Math.cos(lat);
            var sinAng = Math.sin(angDist);
            var cosAng = Math.cos(angDist);
            var sinHdg = Math.sin(hdg);
            var cosHdg = Math.cos(hdg);

            var newLat = Math.asin(sinLat * cosAng + cosLat * sinAng * cosHdg);
            var newLon = lon + Math.atan2(sinHdg * sinAng * cosLat, cosAng - sinLat * Math.sin(newLat));

            var aheadCarto = new Cesium.Cartographic(newLon, newLat);
            var aheadElev = globe.getHeight(aheadCarto);
            if (aheadElev == null || !isFinite(aheadElev)) aheadElev = 0;

            terrainAhead.push({ dist: dist, terrainElev: aheadElev });
        }
        _tfTerrainAhead = terrainAhead;

        // Find the highest terrain ahead (including current position)
        var maxTerrainElev = terrainElev;
        for (var j = 0; j < terrainAhead.length; j++) {
            if (terrainAhead[j].terrainElev > maxTerrainElev) {
                maxTerrainElev = terrainAhead[j].terrainElev;
            }
        }

        // Compute desired MSL altitude = highest terrain ahead + AGL target + safety margin
        // Use the higher of current terrain and look-ahead terrain for terrain avoidance
        var desiredAlt = maxTerrainElev + _tfAglTarget;

        // Drive autopilot altitude hold if autopilot is available
        if (_autopilotState) {
            // Enable altitude hold if not already enabled
            if (!_autopilotState.altHold) {
                _autopilotState.altHold = true;
                if (!_autopilotState.enabled) _autopilotState.enabled = true;
            }
            _autopilotState.targetAlt = desiredAlt;
        }

        // Pass TF state to playerState for HUD display
        _playerState._tfEnabled = true;
        _playerState._tfAgl = currentAGL;
        _playerState._tfAglTarget = _tfAglTarget;
        _playerState._terrainAhead = terrainAhead;
        _playerState._tfDesiredAlt = desiredAlt;
        _playerState._tfTerrainElev = terrainElev;
    }

    function _toggleTerrainFollowing() {
        _tfEnabled = !_tfEnabled;
        if (_tfEnabled) {
            // Require low altitude to enable
            if (_playerState && _playerState.alt > 3500) {
                _tfEnabled = false;
                _showMessage('TF/TA: TOO HIGH (descend below 3000m AGL)');
                return;
            }
            _showMessage('TF/TA ON | AGL ' + _tfAglTarget + 'm');
            // Make sure autopilot is in a state to use
            if (_autopilotState && !_autopilotState.enabled) {
                _autopilotState.enabled = true;
                _autopilotState.altHold = true;
                if (_playerState) _autopilotState.targetSpeed = _playerState.speed;
                _autopilotState.spdHold = true;
            }
        } else {
            _showMessage('TF/TA OFF');
            _playerState._tfEnabled = false;
            _playerState._terrainAhead = [];
        }
        _syncAutopilotPanel();
    }

    // -----------------------------------------------------------------------
    // Radar Warning Receiver — populate _playerState._rwr from ECS radar/SAM entities
    // -----------------------------------------------------------------------
    var _rwrLastTick = 0;

    function _tickRWR() {
        if (!_world || !_playerState || !_playerEntity) return;

        // Throttle to 4Hz
        var now = Date.now();
        if (now - _rwrLastTick < 250) return;
        _rwrLastTick = now;

        var playerTeam = _playerEntity.team;
        var pLat = _playerState.lat;
        var pLon = _playerState.lon;
        var pHeading = _playerState.heading || 0; // radians

        if (pLat == null || pLon == null) {
            _playerState._rwr = [];
            return;
        }

        var threats = [];
        var playerId = _playerEntity.id;

        _world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.id === playerId) return;
            if (ent.team === playerTeam) return;

            var s = ent.state;
            if (!s || s.lat == null || s.lon == null) return;

            // Must have a radar sensor component
            var radarComp = ent.getComponent('sensors');
            if (!radarComp || !radarComp._maxRange) return;

            var maxRange = radarComp._maxRange;

            // Compute bearing from player to this entity (great circle)
            var lat1 = pLat;
            var lon1 = pLon;
            var lat2 = s.lat;
            var lon2 = s.lon;
            var dlon = lon2 - lon1;
            var y = Math.sin(dlon) * Math.cos(lat2);
            var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
            var bearing = Math.atan2(y, x); // radians, CW from north

            // Convert to degrees relative to player heading
            var relBearingRad = bearing - pHeading;
            var relBearingDeg = relBearingRad * 180 / Math.PI;
            // Normalize to 0-360
            relBearingDeg = ((relBearingDeg % 360) + 360) % 360;

            // Compute slant range for normalized distance
            var R = 6371000;
            var dlat = lat2 - lat1;
            var a2 = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
                     Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
            var c = 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
            var surfDist = R * c;
            var dAlt = (s.alt || 0) - (_playerState.alt || 0);
            var range = Math.sqrt(surfDist * surfDist + dAlt * dAlt);

            // Normalized range (0 = at entity, 1 = at max radar range)
            var rangeNorm = Math.min(range / maxRange, 1);

            // Skip if well beyond radar range (> 1.5x maxRange)
            if (range > maxRange * 1.5) return;

            // Determine threat type
            var threatType = 'search';
            var weapComp = ent.getComponent('weapons');
            if (weapComp && s._engagements && s._engagements.length > 0) {
                for (var ei = 0; ei < s._engagements.length; ei++) {
                    var eng = s._engagements[ei];
                    if (eng.targetId === playerId) {
                        if (eng.state === 'ENGAGE') {
                            threatType = 'lock';
                            break;
                        } else if (eng.state === 'TRACK' || eng.state === 'DETECT') {
                            threatType = 'track';
                        }
                    }
                }
            }

            // Label: entity name shortened to 6 chars
            var label = (ent.name || ent.id || '?').substring(0, 6);

            threats.push({
                bearing: relBearingDeg,
                type: threatType,
                range_norm: rangeNorm,
                label: label
            });
        });

        _playerState._rwr = threats;
    }

    // -----------------------------------------------------------------------
    // Missile Warning System — detect active missiles targeting player
    // -----------------------------------------------------------------------
    var _mwsLastTick = 0;

    function _tickMWS() {
        if (!_world || !_playerState || !_playerEntity) return;
        var now = Date.now();
        if (now - _mwsLastTick < 200) return; // 5Hz
        _mwsLastTick = now;

        var pLat = _playerState.lat;
        var pLon = _playerState.lon;
        if (pLat == null || pLon == null) { _playerState._mws = []; return; }

        var playerId = _playerEntity.id;
        var missiles = [];

        _world.entities.forEach(function(ent) {
            if (!ent.active) return;
            var s = ent.state;
            if (!s) return;

            // Check for SAM battery engagements targeting player
            var samComp = ent.getComponent ? ent.getComponent('weapons/sam_battery') : null;
            if (samComp && s._engagements) {
                for (var i = 0; i < s._engagements.length; i++) {
                    var eng = s._engagements[i];
                    if (eng.targetId === playerId && eng.state === 'ENGAGE') {
                        // Active missile from this SAM
                        var bearing = _bearingTo(pLat, pLon, s.lat, s.lon);
                        var range = _rangeTo(pLat, pLon, s.lat, s.lon, _playerState.alt || 0, s.alt || 0);
                        missiles.push({
                            type: 'SAM',
                            bearing: bearing,
                            range: range,
                            label: (ent.name || 'SAM').substring(0, 6),
                            tof: eng.tof || 0
                        });
                    }
                }
            }

            // Check for A2A missile engagements
            var a2aComp = ent.getComponent ? ent.getComponent('weapons/a2a_missile') : null;
            if (a2aComp && s._engagements) {
                for (var j = 0; j < s._engagements.length; j++) {
                    var eng2 = s._engagements[j];
                    if (eng2.targetId === playerId && (eng2.state === 'ENGAGE' || eng2.state === 'FIRE')) {
                        var bearing2 = _bearingTo(pLat, pLon, s.lat, s.lon);
                        var range2 = _rangeTo(pLat, pLon, s.lat, s.lon, _playerState.alt || 0, s.alt || 0);
                        missiles.push({
                            type: 'A2A',
                            bearing: bearing2,
                            range: range2,
                            label: (ent.name || 'AIR').substring(0, 6),
                            tof: eng2.tof || 0
                        });
                    }
                }
            }
        });

        _playerState._mws = missiles;
    }

    function _bearingTo(lat1, lon1, lat2, lon2) {
        var dlon = lon2 - lon1;
        var y = Math.sin(dlon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
        return Math.atan2(y, x) * (180 / Math.PI);
    }

    function _rangeTo(lat1, lon1, lat2, lon2, alt1, alt2) {
        var R = 6371000;
        var dlat = lat2 - lat1;
        var dlon = lon2 - lon1;
        var a2 = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
                 Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a2), Math.sqrt(1 - a2));
        var surfDist = R * c;
        var dAlt = alt2 - alt1;
        return Math.sqrt(surfDist * surfDist + dAlt * dAlt);
    }

    // -----------------------------------------------------------------------
    // Formation Status — identify wingmen targeting the player
    // -----------------------------------------------------------------------
    var _formationLastTick = 0;

    function _tickFormation() {
        if (!_world || !_playerState || !_playerEntity) return;
        var now = Date.now();
        if (now - _formationLastTick < 500) return; // 2Hz
        _formationLastTick = now;

        var playerId = _playerEntity.id;
        var pLat = _playerState.lat;
        var pLon = _playerState.lon;
        if (pLat == null || pLon == null) { _playerState._formation = []; return; }

        var wingmen = [];

        _world.entities.forEach(function(ent) {
            if (!ent.active || ent.id === playerId) return;
            if (ent.team !== _playerEntity.team) return;
            var s = ent.state;
            if (!s || s.lat == null || s.lon == null) return;

            // Check if this entity follows the player (intercept AI or formation component)
            var isFollower = false;
            var formationType = 'LOOSE';

            var interceptComp = ent.getComponent ? ent.getComponent('ai/intercept') : null;
            if (interceptComp && interceptComp.config && interceptComp.config.targetId === playerId) {
                isFollower = true;
            }
            // Also check formation AI
            var formComp = ent.getComponent ? ent.getComponent('ai/formation') : null;
            if (formComp && formComp.config) {
                if (formComp.config.leaderId === playerId) {
                    isFollower = true;
                    formationType = (formComp.config.pattern || 'ECHELON').toUpperCase();
                }
            }

            if (!isFollower) return;

            var bearing = _bearingTo(pLat, pLon, s.lat, s.lon);
            var relBearing = bearing - (_playerState.heading || 0) * (180 / Math.PI);
            relBearing = ((relBearing % 360) + 360) % 360;
            var range = _rangeTo(pLat, pLon, s.lat, s.lon, _playerState.alt || 0, s.alt || 0);
            var altDiff = (s.alt || 0) - (_playerState.alt || 0);

            var status = 'ON STATION';
            if (range > 10000) status = 'REJOINING';
            if (range > 50000) status = 'LOST';

            wingmen.push({
                name: (ent.name || ent.id).substring(0, 10),
                bearing: relBearing,
                range: range,
                altDiff: altDiff,
                status: status,
                formation: formationType
            });
        });

        _playerState._formation = wingmen;
    }

    // -----------------------------------------------------------------------
    // ILS Approach Data — compute glideslope/localizer deviation for HUD
    // -----------------------------------------------------------------------
    function _computeILSData() {
        if (!_playerState || !_world) return;
        _playerState._ilsData = null;

        // Only compute when below 1600m (5000ft)
        if (_playerState.alt > 1600) return;

        var DEG = Math.PI / 180;
        var pLat = _playerState.lat;
        var pLon = _playerState.lon;
        var pAlt = _playerState.alt;
        var pHdg = _playerState.heading || 0;

        // Find nearest ground station (airport) within 30nm
        var bestDist = Infinity;
        var bestStation = null;

        _world.entities.forEach(function(ent) {
            if (!ent || !ent.state) return;
            var eType = ent.type || '';
            if (eType !== 'ground_station' && eType !== 'ground' && eType !== 'static') return;
            var s = ent.state;
            if (s.lat == null || s.lon == null) return;

            var dist = FighterSimEngine.distance(pLat, pLon, s.lat, s.lon);
            if (dist < bestDist && dist < 55000) {  // Within 30nm
                bestDist = dist;
                bestStation = ent;
            }
        });

        if (!bestStation) return;

        var sLat = bestStation.state.lat;
        var sLon = bestStation.state.lon;
        var sAlt = bestStation.state.alt || 0;

        // Compute bearing from station to player
        var brg = FighterSimEngine.bearing(sLat, sLon, pLat, pLon);

        // Guess runway heading — use player approach heading rounded to nearest 10 deg
        var approachHdg = ((pHdg * 180 / Math.PI + 180) % 360);  // reciprocal of player heading
        var rwyHdg = Math.round(approachHdg / 10) * 10;
        var rwyHdgRad = rwyHdg * DEG;

        // Localizer deviation: angular difference between bearing-from-station and runway heading
        var locDev = brg - rwyHdgRad;
        while (locDev > Math.PI) locDev -= 2 * Math.PI;
        while (locDev < -Math.PI) locDev += 2 * Math.PI;
        var locDevDeg = locDev * 180 / Math.PI;

        // Glideslope deviation: compare actual angle to 3 deg glidepath
        var horizDist = bestDist;
        var altAboveRwy = pAlt - sAlt;
        var actualAngle = Math.atan2(altAboveRwy, horizDist) * 180 / Math.PI;
        var gsDevDeg = actualAngle - 3.0;  // positive = above glidepath

        // Distance in NM
        var distNm = bestDist / 1852;

        // Runway identifier from heading
        var rwyId = Math.round(rwyHdg / 10).toString().padStart(2, '0');

        var stationName = (bestStation.name || '').toUpperCase();

        _playerState._ilsData = {
            gsDeviation: gsDevDeg,
            locDeviation: locDevDeg,
            distNm: distNm,
            rwyAlt: sAlt,
            rwyId: rwyId,
            stationName: stationName
        };
    }

    // -----------------------------------------------------------------------
    // Main tick
    // -----------------------------------------------------------------------
    function tick() {
        if (!_started) return;
        // Observer mode with no player: tick ECS only
        if (_observerMode && !_playerState) {
            if (_isPaused) { _lastTickTime = null; return; }
            var now = Date.now();
            if (_lastTickTime === null) { _lastTickTime = now; return; }
            var realDt = (now - _lastTickTime) / 1000;
            _lastTickTime = now;
            realDt = Math.min(realDt, 0.1);
            var totalDt = realDt * _timeWarp;
            _simElapsed += totalDt;

            // Tick ECS world only
            _world.simTime = _simElapsed;
            _world.timeWarp = _timeWarp;
            for (var si = 0; si < _world.systems.length; si++) {
                _world.systems[si].fn(totalDt, _world);
            }

            // Apply viz controls
            _applyVizControls();

            // Update observer camera tracking
            if (_trackingEntity && _trackingEntity.state) {
                var ts = _trackingEntity.state;
                if (ts.lat != null && ts.lon != null) {
                    var tpos = Cesium.Cartesian3.fromRadians(ts.lon, ts.lat, ts.alt || 0);
                    _viewer.camera.lookAt(tpos,
                        new Cesium.HeadingPitchRange(0, -0.5, (ts.alt || 500) * 3 + 1000));
                }
            }

            // Update UI
            _updateTimeDisplay();
            _updateEntityListPanel();
            if (typeof EntityTooltip !== 'undefined') EntityTooltip.update();
            if (typeof CyberCockpit !== 'undefined') CyberCockpit.update(totalDt);

            // Analytics
            _recordAnalyticsSnapshot();
            _refreshAnalyticsIfOpen();

            // Subsystems
            if (typeof WeatherSystem !== 'undefined') WeatherSystem.update(totalDt, _simElapsed);
            if (typeof EWSystem !== 'undefined') EWSystem.update(totalDt, _simElapsed);

            // Minimap (observer mode)
            if (typeof Minimap !== 'undefined' && Minimap.isVisible()) Minimap.update(null, _world, _simElapsed);
            if (typeof ConjunctionSystem !== 'undefined') ConjunctionSystem.update(_world, _simElapsed);

            // Cyber event scanner (observer mode)
            _scanCyberEvents(totalDt);

            // Tactical data links (observer mode)
            _tickDataLinks();

            // Engagement stats (observer mode)
            _tickEngagementStats();
            return;
        }
        if (!_playerState) return;
        if (_isPaused) { _lastTickTime = null; return; }

        var now = Date.now();
        if (_lastTickTime === null) { _lastTickTime = now; return; }

        var realDt = (now - _lastTickTime) / 1000;
        _lastTickTime = now;
        realDt = Math.min(realDt, 0.1);
        var totalDt = realDt * _timeWarp;
        _simElapsed += totalDt;

        // --- PLAYER PATH ---

        // Auto-trim: hold T to auto-converge on zero gamma drift
        if (_keys['KeyT'] && !_keys['ShiftLeft'] && !_keys['ShiftRight'] &&
            !_keys['ControlLeft'] && !_keys['ControlRight']) {
            _runAutoTrim(totalDt);
        } else {
            _autoTrimActive = false;
            _lastGamma = null;
        }

        // 1. Read controls (keyboard + gamepad)
        var controls = _getControls();
        if (typeof GamepadInput !== 'undefined') {
            var gpControls = GamepadInput.poll();
            controls = GamepadInput.merge(controls, gpControls);

            if (gpControls.connected) {
                if (gpControls.justPressed && gpControls.justPressed.engine) {
                    _playerState.engineOn = !_playerState.engineOn;
                    _showMessage(_playerState.engineOn ? 'ENGINE START' : 'ENGINE STOP');
                }
                if (gpControls.justPressed && gpControls.justPressed.pause) {
                    _isPaused = !_isPaused;
                    _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                    _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                    if (!_isPaused) _lastTickTime = null;
                }
                if (gpControls.justPressed && gpControls.justPressed.camera) _cycleCamera();
                if (gpControls.justPressed && gpControls.justPressed.propulsionMode) _cyclePropulsionMode();
            }
        }

        // 2. Autopilot
        if (_autopilotState && _autopilotState.enabled && !_plannerMode &&
            typeof FighterAutopilot !== 'undefined') {
            var apControls = FighterAutopilot.update(_autopilotState, _playerState, totalDt);
            if (apControls.pitch !== undefined) controls.pitch = apControls.pitch;
            if (apControls.roll !== undefined) controls.roll = apControls.roll;
            if (apControls.throttleSet !== undefined) controls.throttleSet = apControls.throttleSet;
        }

        // 3. Step player physics (sub-stepped, no hard cap)
        // Static ground entities skip flight physics entirely — they don't move.
        if (!_isStaticPlayer) {
            // Substep count scales with totalDt so physics always keeps pace
            // with _simElapsed at high warp. FighterSimEngine.step() internally
            // caps dt to 0.05s, so each substep must be ≤ 0.05s.
            if (totalDt > 0) {
                var maxSubDt = 0.05;
                var numSteps = Math.ceil(totalDt / maxSubDt);
                var subDt = totalDt / numSteps;
                for (var _ss = 0; _ss < numSteps; _ss++) {
                    FighterSimEngine.step(_playerState, controls, subDt, _playerConfig);
                }
            }

            // Apply weather wind to player
            if (typeof WeatherSystem !== 'undefined') {
                var windDelta = WeatherSystem.applyWindToState(_playerState, totalDt);
                if (windDelta) {
                    _playerState.speed += windDelta.dSpeed;
                    _playerState.heading += windDelta.dHeading;
                    if (windDelta.dGamma) _playerState.gamma += windDelta.dGamma;
                }
            }
        }

        // 3b. Auto-pointing system (maintains attitude toward reference direction)
        _tickPointing();

        // 3c. Auto-execute state machine (warp/orient/burn)
        if (_autoExecState) _tickAutoExec(totalDt);

        // 3d. Terrain following / terrain avoidance
        if (_tfEnabled) _tickTerrainFollowing(totalDt);

        // 3e. Quest system update
        if (_questActive) _tickQuest();

        // 4. Update player trail (with time-based trimming)
        _trailCounter++;
        if (_trailCounter % 10 === 0) {
            _playerTrail.push(Cesium.Cartesian3.fromRadians(
                _playerState.lon, _playerState.lat, _playerState.alt));
            _playerGroundTrack.push(Cesium.Cartesian3.fromRadians(
                _playerState.lon, _playerState.lat, 0));
            _playerTrailTimes.push(_simElapsed);
            // Time-based trim
            if (_trailDurationSec > 0) {
                var cutoff = _simElapsed - _trailDurationSec;
                while (_playerTrailTimes.length > 0 && _playerTrailTimes[0] < cutoff) {
                    _playerTrailTimes.shift();
                    _playerTrail.shift();
                    _playerGroundTrack.shift();
                }
            } else if (_playerTrail.length > 100000) {
                // Infinite mode cap
                _playerTrail.shift();
                _playerGroundTrack.shift();
                _playerTrailTimes.shift();
            }
        }

        // 5. Update orbital state (always — SpaceplaneOrbital handles regime detection)
        if (typeof SpaceplaneOrbital !== 'undefined') {
            try {
                SpaceplaneOrbital.setNumRevs(_orbitRevs);
                SpaceplaneOrbital.update(_playerState, _simElapsed);
            } catch (orbErr) {
                console.warn('Orbital update error (escape?):', orbErr.message);
                // Clear orbit display on error to prevent stale polylines
                if (SpaceplaneOrbital.currentOrbitPositions) {
                    SpaceplaneOrbital.currentOrbitPositions.length = 0;
                }
                if (SpaceplaneOrbital.eciOrbitPositions) {
                    SpaceplaneOrbital.eciOrbitPositions.length = 0;
                }
            }
        }

        // 5b. Update predicted ground track (throttled to every 120 frames ~ 2 seconds)
        if (_trailCounter % 120 === 0 && _showPredictedGroundTrack && typeof SpaceplaneOrbital !== 'undefined') {
            if (_playerState.alt > 80000 && SpaceplaneOrbital.currentOrbitPositions && SpaceplaneOrbital.currentOrbitPositions.length > 0) {
                var orbitPts = SpaceplaneOrbital.currentOrbitPositions;
                var groundPts = [];
                for (var gi = 0; gi < orbitPts.length; gi++) {
                    var cart = orbitPts[gi];
                    if (!cart) continue;
                    try {
                        var carto = Cesium.Cartographic.fromCartesian(cart);
                        if (carto && isFinite(carto.longitude) && isFinite(carto.latitude)) {
                            groundPts.push(Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 100));
                        }
                    } catch (e) {
                        // Skip invalid points
                    }
                }
                _predictedGroundTrackPositions = groundPts;
            } else {
                _predictedGroundTrackPositions = [];
            }
        }

        // 6. Update planner
        if (typeof SpaceplanePlanner !== 'undefined') {
            SpaceplanePlanner.update(_playerState, _simElapsed);
            // Keep dialog time display updated (throttled to ~4Hz)
            if (_maneuverDialogOpen && _maneuverDialogNode && _trailCounter % 15 === 0) {
                _refreshManeuverDialog();
            }
        }

        // --- ECS PATH ---

        // 7. Tick ECS world (non-player entities)
        _world.simTime = _simElapsed;
        _world.timeWarp = _timeWarp;
        for (var i = 0; i < _world.systems.length; i++) {
            _world.systems[i].fn(totalDt, _world);
        }

        // Apply visualization controls
        _applyVizControls();

        // --- Check player death ---
        if (_playerEntity && !_playerEntity.active) {
            _showMessage('DESTROYED', 5000);
        }

        // --- SIMULATION SUBSYSTEMS ---

        // Audio engine — drive sounds from player state
        if (_audioEnabled && typeof SimAudio !== 'undefined') {
            SimAudio.update(_playerState, totalDt);
        }

        // Visual effects — update particles, trails, reentry glow
        if (_visualFxEnabled && typeof SimEffects !== 'undefined') {
            // Build lightweight entity array for effects system
            var effectEntities = [];
            if (_playerState) {
                effectEntities.push({
                    id: _playerEntity ? _playerEntity.id : 'player',
                    engineOn: _playerState.engineOn,
                    throttle: _playerState.throttle,
                    position: Cesium.Cartesian3.fromRadians(
                        _playerState.lon, _playerState.lat, _playerState.alt),
                    propulsionMode: _playerState.forcedPropMode || 'AIR',
                    alt: _playerState.alt,
                    speed: _playerState.speed,
                    mach: _playerState.mach || 0,
                    aeroBlend: _playerState.aeroBlend || 0,
                    dynamicPressure: _playerState.dynamicPressure || 0
                });
            }
            SimEffects.update(totalDt, effectEntities);
        }

        // Weather — apply wind to player physics and update environment
        if (typeof WeatherSystem !== 'undefined') {
            WeatherSystem.update(totalDt, _simElapsed);
        }

        // EW system — update jamming/detection/decoys
        if (typeof EWSystem !== 'undefined') {
            EWSystem.update(totalDt, _simElapsed);
        }

        // Communications engine — route packets, compute link budgets, process jammers/cyber
        if (typeof CommEngine !== 'undefined' && CommEngine.isInitialized()) {
            CommEngine.tick(totalDt, _world);
            // Update comm panel (throttled to ~2Hz)
            if (_panelVisible.comm && _trailCounter % 30 === 0) {
                _updateCommPanel();
            }
        }

        // Cyber event scanner — detect state transitions for log panel
        _scanCyberEvents(totalDt);

        // Tactical data links (player mode)
        _tickDataLinks();

        // Radar Warning Receiver — populate _rwr from hostile radar/SAM entities
        _tickRWR();
        // Missile Warning System — detect active missiles targeting player
        _tickMWS();
        // Formation status — track wingmen
        _tickFormation();
        // ILS approach guidance — glideslope/localizer for HUD
        _computeILSData();
        // Engagement log — record weapon events
        _tickEngagementLog();
        // Engagement stats — aggregated weapon statistics
        _tickEngagementStats();
        // Auto-refresh engagement timeline if open
        if (_engTimelineOpen && Math.floor(_simElapsed) % 2 === 0) _renderEngTimeline();

        // --- COCKPIT RENDERING ---

        // 8. Update camera
        _updateCamera();

        // 9. Render HUD
        var hudCanvas = document.getElementById('hudCanvas');
        if (hudCanvas) {
            if (_plannerMode) {
                if (typeof SpaceplaneHUD !== 'undefined') {
                    SpaceplaneHUD.render(hudCanvas, _playerState, _simElapsed);
                }
            } else {
                var weaponHud = _weaponIndex >= 0 ? {
                    selectedWeapon: _weaponList[_weaponIndex].name,
                    selectedType: _weaponList[_weaponIndex].type,
                    count: _weaponList[_weaponIndex].count,
                    maxCount: _weaponList[_weaponIndex].maxCount,
                    active: _weaponList[_weaponIndex].active,
                    allWeapons: _weaponList,
                    weaponIndex: _weaponIndex
                } : null;
                var sensorHud = _sensorIndex >= 0 ? {
                    name: _sensorList[_sensorIndex].name,
                    type: _sensorList[_sensorIndex].type,
                    filterInfo: SENSOR_FILTERS[_sensorList[_sensorIndex].type] || null,
                    allSensors: _sensorList,
                    sensorIndex: _sensorIndex
                } : null;
                // Attach sensor/trim/pointing/warp/nearby to state for HUD display
                _playerState._sensor = sensorHud;
                _playerState._trim = _playerState.trimAlpha;
                _playerState._pointingMode = _pointingMode;
                _playerState._pointingLocked = _pointingLocked;
                _playerState._timeWarp = _timeWarp;
                _playerState._displayMode = _displayMode > 0 ? DISPLAY_MODE_FILTERS[_displayMode].label : null;
                _playerState._simEpochJD = _JD_SIM_EPOCH_LOCAL;
                _playerState._simElapsed = _simElapsed;
                // Build nearby entity list for minimap
                var nearbyList = [];
                _world.entities.forEach(function(ent) {
                    if (_playerEntity && ent.id === _playerEntity.id) return;
                    var s = ent.state;
                    if (!s || s.lat == null || s.lon == null) return;
                    nearbyList.push({
                        lat: s.lat, lon: s.lon, alt: s.alt || 0,
                        name: ent.name, team: ent.team, type: ent.type
                    });
                });
                _playerState._nearby = nearbyList;
                // Fuel/propulsion metadata for HUD fuel gauge & delta-V display
                _playerState._fuelCapacity = _playerConfig ? (_playerConfig.fuel_capacity || Infinity) : Infinity;
                _playerState._dryMass = _playerConfig ? (_playerConfig.mass_empty || 8570) : 8570;
                var _curPropEntry = _propModes[_propModeIndex];
                _playerState._propName = _curPropEntry ? _curPropEntry.name : (_playerState.forcedPropMode || 'AIR');
                // Current thrust level (for HUD display)
                var _mode = _playerState.forcedPropMode || 'AIR';
                if (_mode === 'ROCKET') _playerState._currentThrust = (_curPropEntry && _curPropEntry.thrust) || (_playerConfig && _playerConfig.thrust_rocket) || 5000000;
                else if (_mode === 'HYPERSONIC') _playerState._currentThrust = (_playerConfig && _playerConfig.thrust_hypersonic) || 800000;
                else _playerState._currentThrust = (_playerConfig && _playerConfig.thrust_ab) || (_playerConfig && _playerConfig.thrust_mil) || 130000;
                // Pass waypoint info to state for HUD rendering
                _playerState._waypointInfo = _getWaypointInfo();
                // Pass engagement stats for HUD display
                _playerState._engagementStats = _engagementStats;
                // Pass terrain following state for HUD display
                _playerState._tfEnabled = _tfEnabled;
                _playerState._tfAglTarget = _tfAglTarget;
                if (!_tfEnabled) {
                    _playerState._tfAgl = 0;
                    _playerState._terrainAhead = [];
                }

                // Skip flight HUD for static ground entities (cyber cockpit is primary UI)
                if (!_isStaticPlayer) {
                    FighterHUD.render(_playerState, _autopilotState, weaponHud, null, _simElapsed);

                    if (typeof SpaceplaneHUD !== 'undefined' && _playerState.alt > 30000) {
                        SpaceplaneHUD.renderOverlay(hudCanvas, _playerState, _simElapsed);
                    }
                }
            }
        }

        // 9b. Weather visual overlay (cockpit/chase mode only)
        _updateWeatherOverlay();

        // 10. Update UI panels
        _updateFlightDataPanel();
        _updateSystemsPanel();
        _updateOrbitalPanel();
        _updateTimeDisplay();
        _updateEntityListPanel();
        if (typeof EntityTooltip !== 'undefined') EntityTooltip.update();
        if (typeof CyberCockpit !== 'undefined') CyberCockpit.update(totalDt);

        // Analytics
        _recordAnalyticsSnapshot();
        _refreshAnalyticsIfOpen();

        // Autopilot panel sync (~4Hz)
        if (_apPanelOpen && _analyticsRecordCounter % 15 === 0) _syncAutopilotPanel();

        // Minimap (player mode)
        if (typeof Minimap !== 'undefined' && Minimap.isVisible()) {
            // Tag player state with entity ID so minimap can skip player in entity list
            if (_playerEntity) _playerState._entityId = _playerEntity.id;
            Minimap.update(_playerState, _world, _simElapsed);
        }
        // Conjunction detection (player mode)
        if (typeof ConjunctionSystem !== 'undefined') ConjunctionSystem.update(_world, _simElapsed);

        // Record frame time for performance stats
        var frameEndTime = Date.now();
        var frameMs = frameEndTime - (now || frameEndTime);
        _perfFrameTimes.push(frameMs);
        if (_perfFrameTimes.length > 60) _perfFrameTimes.shift();
    }

    // -----------------------------------------------------------------------
    // UI Updates
    // -----------------------------------------------------------------------
    function _updateFlightDataPanel() {
        if (!_playerState) return;

        var isHighAlt = _playerState.alt > 100000;

        if (isHighAlt) {
            var speedMs = _playerState.speed;
            var speedDisplay = speedMs > 1000 ?
                (speedMs / 1000).toFixed(2) + ' km/s' : Math.round(speedMs) + ' m/s';
            _setText('fdIAS', '---');
            _setText('fdTAS', speedDisplay);
            _setText('fdMach', _playerState.mach.toFixed(1));
            _setText('fdAlt', (_playerState.alt / 1000).toFixed(1) + ' km');
            _setText('fdAGL', '---');
        } else {
            var ias = (typeof Atmosphere !== 'undefined') ?
                Atmosphere.tasToCas(_playerState.speed, _playerState.alt) * MPS_TO_KNOTS :
                _playerState.speed * MPS_TO_KNOTS;
            var tas = _playerState.speed * MPS_TO_KNOTS;
            var altFt = _playerState.alt * M_TO_FT;

            _setText('fdIAS', Math.round(ias) + ' KT');
            _setText('fdTAS', Math.round(tas) + ' KT');
            _setText('fdMach', (_playerState.mach || 0).toFixed(2));
            _setText('fdAlt', Math.round(altFt) + ' FT');
            _setText('fdAGL', '---');
        }

        var hdgDeg = (_playerState.heading || 0) * RAD;
        var vsFpm = _playerState.speed * Math.sin(_playerState.gamma || 0) * 196.85;
        var aoaDeg = (_playerState.alpha || 0) * RAD;
        var thrPct = Math.round((_playerState.throttle || 0) * 100);

        _setText('fdHdg', Math.round(hdgDeg >= 0 ? hdgDeg : hdgDeg + 360).toString().padStart(3, '0') + '\u00B0');
        _setText('fdVS', (vsFpm >= 0 ? '+' : '') + Math.round(vsFpm) + ' FPM');
        _setTextWithClass('fdG', (_playerState.g_load || 1).toFixed(1),
            Math.abs(_playerState.g_load || 1) > 5 ? 'alert' : Math.abs(_playerState.g_load || 1) > 3 ? 'warn' : '');
        _setText('fdAoA', aoaDeg.toFixed(1) + '\u00B0');
        _setText('fdThr', thrPct + '%');

        var orbVPct = _playerState.orbitalVfrac ? (_playerState.orbitalVfrac * 100).toFixed(1) : '0.0';
        _setTextWithClass('fdOrbV', orbVPct + '%', _playerState.orbitalVfrac > 0.95 ? 'blue' : '');

        var q = _playerState.dynamicPressure;
        if (q !== undefined) {
            _setText('fdDynQ', q > 1000 ? (q / 1000).toFixed(1) + ' kPa' : q.toFixed(0) + ' Pa');
        }

        var vInertial = _playerState.speed;
        if (vInertial > 1000) {
            _setText('fdVInertial', (vInertial / 1000).toFixed(2) + ' km/s');
        } else {
            _setText('fdVInertial', Math.round(vInertial) + ' m/s');
        }

        _setText('fdLat', ((_playerState.lat || 0) * RAD).toFixed(4) + '\u00B0');
        _setText('fdLon', ((_playerState.lon || 0) * RAD).toFixed(4) + '\u00B0');
    }

    function _updateSystemsPanel() {
        if (!_playerState) return;

        _setTextWithClass('sysEngine', _playerState.engineOn ? 'ON' : 'OFF',
            _playerState.engineOn ? '' : 'alert');

        var propEntry = _propModes[_propModeIndex];
        var propName = propEntry ? propEntry.name : (_playerState.propulsionMode || 'AIR');
        var propColor = propEntry ? (propEntry.color || '') :
            (_playerState.propulsionMode === 'ROCKET' ? 'alert' : _playerState.propulsionMode === 'HYPERSONIC' ? 'warn' : '');
        _setTextWithClass('sysProp', propName, propColor);
        _setText('propModeDisplay', propName);

        _setText('sysGear', _playerState.gearDown ? 'DOWN' : 'UP');
        _setText('sysFlaps', _playerState.flapsDown ? 'DOWN' : 'UP');
        _setTextWithClass('sysSpeedBrake', _playerState.speedBrakeOut ? 'OUT' : 'IN',
            _playerState.speedBrakeOut ? 'warn' : '');
        _setText('sysBrakes', _playerState.brakesOn ? 'ON' : 'OFF');

        // Flight regime (shown whenever orbital module is loaded)
        if (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.flightRegime) {
            var regime = SpaceplaneOrbital.flightRegime;
            var regimeColor = regime === 'ORBIT' ? 'blue' :
                regime === 'ESCAPE' ? 'alert' :
                regime === 'SUBORBITAL' ? 'warn' : '';
            _setTextWithClass('sysRegime', regime, regimeColor);

            var regimeEl = document.getElementById('regimeDisplay');
            if (regimeEl) {
                regimeEl.textContent = regime;
                var cssColor = regime === 'ORBIT' ? '#44ccff' :
                    regime === 'ESCAPE' ? '#ff3333' :
                    regime === 'SUBORBITAL' ? '#ffff00' : '#00ff00';
                regimeEl.style.color = cssColor;
            }

            if (regime !== _lastRegime) {
                _showMessage('DOMAIN: ' + regime, 2500);
                _lastRegime = regime;
            }
        }

        // Autopilot
        if (_autopilotState) {
            _setTextWithClass('apStatus', _autopilotState.enabled ? 'ON' : 'OFF', '');
            if (_autopilotState.enabled) {
                var modes = [];
                if (_autopilotState.altHold) modes.push('ALT');
                if (_autopilotState.hdgHold) modes.push('HDG');
                if (_autopilotState.spdHold) modes.push('SPD');
                _setText('apMode', modes.join('+') || '---');
                _setText('apAlt', Math.round(_autopilotState.targetAlt * M_TO_FT) + ' FT');
                _setText('apHdg', Math.round(_autopilotState.targetHdg * RAD) + '\u00B0');
                _setText('apSpd', Math.round(_autopilotState.targetSpeed * MPS_TO_KNOTS) + ' KT');
            } else {
                _setText('apMode', '---');
                _setText('apAlt', '---');
                _setText('apHdg', '---');
                _setText('apSpd', '---');
            }
        }
    }

    function _updateOrbitalPanel() {
        if (typeof SpaceplaneOrbital === 'undefined') return;

        var elems = SpaceplaneOrbital.orbitalElements;
        var hasValidOrbit = elems && elems.apoapsisAlt != null && elems.apoapsisAlt > 0;

        var show;
        if (_panelVisible.orbital === 'on') show = true;
        else if (_panelVisible.orbital === 'off') show = false;
        else show = _playerState && (_plannerMode || _playerState.alt > 30000 || hasValidOrbit);

        var orbPanel = document.getElementById('orbitalPanel');
        if (orbPanel) orbPanel.style.display = show ? 'block' : 'none';
        if (!show || !elems) return;

        _setText('orbAP', elems.apoapsisAlt != null ? (elems.apoapsisAlt / 1000).toFixed(1) + ' km' : '---');
        _setText('orbPE', elems.periapsisAlt != null ? (elems.periapsisAlt / 1000).toFixed(1) + ' km' : '---');
        _setText('orbINC', elems.inclination != null ? (elems.inclination * RAD).toFixed(2) + '\u00B0' : '---');
        _setText('orbECC', elems.eccentricity != null ? elems.eccentricity.toFixed(4) : '---');
        _setText('orbSMA', elems.sma != null ? (elems.sma / 1000).toFixed(0) + ' km' : '---');

        if (elems.period != null && isFinite(elems.period) && elems.period > 0) {
            _setText('orbPeriod', (elems.period / 60).toFixed(1) + ' min');
        } else {
            _setText('orbPeriod', '---');
        }

        _setText('orbRAAN', elems.raan != null ? (elems.raan * RAD).toFixed(2) + '\u00B0' : '---');
        _setText('orbArgPE', elems.argPeriapsis != null ? (elems.argPeriapsis * RAD).toFixed(2) + '\u00B0' : '---');
        _setText('orbTA', elems.trueAnomaly != null ? (elems.trueAnomaly * RAD).toFixed(2) + '\u00B0' : '---');
        _setText('orbTAP', elems.timeToApoapsis != null ? _formatTime(elems.timeToApoapsis) : '---');
        _setText('orbTPE', elems.timeToPeriapsis != null ? _formatTime(elems.timeToPeriapsis) : '---');
        _setText('orbTAN', elems.timeToAscendingNode != null ? _formatTime(elems.timeToAscendingNode) : '---');
        _setText('orbTDN', elems.timeToDescendingNode != null ? _formatTime(elems.timeToDescendingNode) : '---');
        _setText('orbTTA90', elems.timeToTA90 != null ? _formatTime(elems.timeToTA90) : '---');
        _setText('orbTTA270', elems.timeToTA270 != null ? _formatTime(elems.timeToTA270) : '---');

        // Maneuver node info
        if (typeof SpaceplanePlanner !== 'undefined' && SpaceplanePlanner.selectedNode) {
            var node = SpaceplanePlanner.selectedNode;
            _setText('nodeDV', node.dv.toFixed(1) + ' m/s');
            _setText('nodeBurnT', node.burnTime ? node.burnTime.toFixed(0) + 's' : '---');
            _setText('nodePostAP', node.postAP != null ? (node.postAP / 1000).toFixed(1) + ' km' : '---');
            _setText('nodePostPE', node.postPE != null ? (node.postPE / 1000).toFixed(1) + ' km' : '---');
        } else {
            _setText('nodeDV', '---');
            _setText('nodeBurnT', '---');
            _setText('nodePostAP', '---');
            _setText('nodePostPE', '---');
        }
    }

    function _updateTimeDisplay() {
        var t = _simElapsed;
        var parts = [];
        if (t >= 86400) { parts.push(Math.floor(t / 86400) + 'd'); t %= 86400; }
        if (t >= 3600) { parts.push(Math.floor(t / 3600) + 'h'); t %= 3600; }
        var m = Math.floor(t / 60);
        var s = Math.floor(t % 60);
        parts.push(m + ':' + s.toString().padStart(2, '0'));

        // Compute actual UTC date from epoch + elapsed
        var actualJD = _JD_SIM_EPOCH_LOCAL + _simElapsed / 86400;
        var actualMs = (actualJD - 2440587.5) * 86400000;
        var actualDate = new Date(actualMs);
        var utcStr = actualDate.toISOString().slice(0, 19).replace('T', ' ') + 'Z';

        _setText('simTime', parts.join(' ') + '  ' + utcStr);

        // Camera mode & observer indicator
        var camLabel = _cameraMode.toUpperCase();
        if (_observerMode) camLabel = 'OBSERVER';
        _setText('cameraModeDisplay', camLabel);

        // Entity count with domain breakdown
        var count = _world ? _world.entities.size : 0;
        var air = 0, space = 0, gnd = 0, nav = 0;
        if (_world && count > 0 && count < 5000) {
            _world.entities.forEach(function(e) {
                var t = (e.type || '').toLowerCase();
                if (t === 'aircraft') air++;
                else if (t === 'satellite') space++;
                else if (t === 'naval') nav++;
                else gnd++;
            });
            var parts = [];
            if (air > 0) parts.push(air + 'A');
            if (space > 0) parts.push(space + 'S');
            if (gnd > 0) parts.push(gnd + 'G');
            if (nav > 0) parts.push(nav + 'N');
            _setText('entityCountDisplay', count + ' [' + parts.join('/') + ']');
        } else {
            _setText('entityCountDisplay', count + ' ENT');
        }

        // FPS display (update every second)
        var now2 = Date.now();
        if (now2 - _perfLastDisplay > 1000) {
            _perfLastDisplay = now2;
            if (_perfFrameTimes.length > 0) {
                var avgMs = 0;
                for (var fi = 0; fi < _perfFrameTimes.length; fi++) avgMs += _perfFrameTimes[fi];
                avgMs /= _perfFrameTimes.length;
                _perfStats.fps = Math.round(1000 / avgMs);
                _perfStats.frameMs = avgMs.toFixed(1);
                _perfStats.entityCount = count;
            }
            var fpsEl = document.getElementById('fpsDisplay');
            if (fpsEl) {
                var fpsColor = _perfStats.fps >= 50 ? '#44ff44' : _perfStats.fps >= 30 ? '#ffaa44' : '#ff4444';
                fpsEl.innerHTML = '<span style="color:' + fpsColor + '">' + _perfStats.fps + ' FPS</span> <span style="color:#666">' + _perfStats.frameMs + 'ms</span>';
            }
        }
    }

    var _entityListThrottle = 0;
    function _updateEntityListPanel() {
        _entityListThrottle++;
        if (_entityListThrottle % 30 !== 0) return; // ~2Hz at 60fps

        var listEl = document.getElementById('entityListInner');
        if (!listEl) return;

        // Group items by vizCategory (null = ungrouped)
        var groups = {};
        var groupOrder = [];
        for (var i = 0; i < _entityListItems.length; i++) {
            var item = _entityListItems[i];
            var cat = item.vizCategory || '__none__';
            if (!groups[cat]) { groups[cat] = []; groupOrder.push(cat); }
            groups[cat].push(item);
        }

        var html = '';
        for (var g = 0; g < groupOrder.length; g++) {
            var cat = groupOrder[g];
            var items = groups[cat];
            if (cat !== '__none__' && groupOrder.length > 1) {
                html += '<div style="color:#666;font-size:9px;padding:3px 4px;border-top:1px solid #333;margin-top:2px">' +
                    cat.toUpperCase() + ' (' + items.length + ')</div>';
            }
            for (var j = 0; j < items.length; j++) {
                var it = items[j];
                var alive = it.entity.active;
                var teamColor = it.team === 'blue' ? '#4488ff' :
                    it.team === 'red' ? '#ff4444' : '#888888';
                var statusIcon = alive ? '\u25CF' : '\u2716';
                var style = alive ? 'cursor:pointer;' : 'opacity:0.4;text-decoration:line-through;';
                var playerTag = it.isPlayer ? ' <span style="color:#44aaff">[YOU]</span>' : '';
                var trackTag = (_trackingEntity && _trackingEntity.id === it.id) ?
                    ' <span style="color:#ff0">\u25C9</span>' : '';

                // Cyber status indicators
                var cyberTag = '';
                if (alive && it.entity.state) {
                    var cs = it.entity.state;
                    if (cs._fullControl || cs._cyberControlled) {
                        cyberTag = ' <span title="CYBER CONTROLLED" style="color:#ff0000">\u26A0</span>';
                    } else if (cs._sensorDisabled || cs._weaponsDisabled || cs._navigationHijacked) {
                        cyberTag = ' <span title="SUBSYSTEM HACKED" style="color:#ff8800">\u26A0</span>';
                    } else if (cs._cyberExploited || cs._computerCompromised) {
                        cyberTag = ' <span title="EXPLOITED" style="color:#ff44ff">\u2622</span>';
                    } else if (cs._cyberScanning) {
                        cyberTag = ' <span title="BEING SCANNED" style="color:#aaaa00">\u2299</span>';
                    } else if (cs._commBricked) {
                        cyberTag = ' <span title="BRICKED" style="color:#666">\u2298</span>';
                    }
                }

                // Carrier status badge
                var carrierTag = '';
                if (alive && it.isCarrier) {
                    var rdy = it.entity.state._carrierReady || 0;
                    var airb = it.entity.state._carrierAirborne || 0;
                    var cLabel = it.carrierType === 'orbital' ? 'DEPLOY' : 'AIR WING';
                    carrierTag = ' <span title="' + cLabel + ': ' + rdy + ' ready, ' + airb + ' airborne" style="color:#44ccff;font-size:9px;background:rgba(0,60,120,0.5);padding:0 4px;border-radius:2px">' +
                        '\u2708 ' + rdy + '/' + airb + '</span>';
                }

                html += '<div class="entity-row" data-eid="' + it.id + '" style="' + style + '">' +
                    '<span style="color:' + teamColor + '">' + statusIcon + '</span> ' +
                    '<span class="entity-name">' + it.name + '</span>' + playerTag + trackTag + cyberTag + carrierTag +
                    ' <span class="entity-type">' + it.type + '</span>' +
                    '</div>';
            }
        }
        listEl.innerHTML = html;

        // Attach click + dblclick handlers (delegated, once)
        if (!listEl._clickWired) {
            listEl._clickWired = true;
            listEl.addEventListener('click', function(e) {
                var row = e.target.closest('.entity-row');
                if (!row) return;
                var eid = row.getAttribute('data-eid');
                if (!eid) return;
                var entity = _world.getEntity(eid);
                if (!entity) return;
                _trackEntity(entity);
            });
            listEl.addEventListener('dblclick', function(e) {
                var row = e.target.closest('.entity-row');
                if (!row) return;
                var eid = row.getAttribute('data-eid');
                if (!eid) return;
                var entity = _world.getEntity(eid);
                if (!entity || !entity.active) return;
                // Double-click → assume control (if entity has physics)
                if (entity.getComponent('physics')) {
                    _assumeControl(entity);
                }
            });
        }
    }

    // -----------------------------------------------------------------------
    // Panel toggles
    // -----------------------------------------------------------------------
    function _handlePanelToggle(code, e) {
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;

        // When engine panel is open, digit keys select engines
        if (_enginePanelOpen) {
            var digit = null;
            if (code === 'Digit0' || code === 'Numpad0') digit = '0';
            else if (code >= 'Digit1' && code <= 'Digit9') digit = code.charAt(5);
            else if (code >= 'Numpad1' && code <= 'Numpad9') digit = code.charAt(6);
            if (digit !== null && _propKeyMap[digit] !== undefined) {
                _selectEngineByIndex(_propKeyMap[digit]);
                return true;
            }
        }

        switch (code) {
            case 'Digit1': case 'Numpad1': _togglePanel('flightData'); return true;
            case 'Digit2': case 'Numpad2': _togglePanel('systems'); return true;
            case 'Digit3': case 'Numpad3': _togglePanel('entityList'); return true;
            case 'KeyO': _togglePanel('orbital'); return true;
            case 'Tab': _toggleAllPanels(); return true;
            case 'Backquote': case 'Numpad0':
                if (e && e.shiftKey) {
                    // Shift+` = Cyber Cockpit
                    if (typeof CyberCockpit !== 'undefined') {
                        CyberCockpit.toggle();
                    }
                } else {
                    // ` = Tactical Minimap
                    if (typeof Minimap !== 'undefined') {
                        var mmVis = Minimap.toggle();
                        _showMessage(mmVis ? 'TAC MAP ON' : 'TAC MAP OFF');
                    }
                }
                return true;
            case 'KeyA':
                if (e && e.shiftKey) {
                    // Shift+A = After-Action Report
                    _toggleAAR();
                    _showMessage(_aarPanelOpen ? 'AAR OPEN' : 'AAR CLOSED');
                    return true;
                }
                return false;
            case 'KeyE':
                if (e && e.shiftKey) {
                    // Shift+E = Force Status Board
                    _toggleStatusBoard();
                    _showMessage(_statusBoardOpen ? 'STATUS BOARD OPEN' : 'STATUS BOARD CLOSED');
                    return true;
                }
                return false;
            case 'KeyC':
                if (e && e.shiftKey) {
                    // Shift+C = Cyber Incident Log
                    _toggleCyberLogPanel();
                    _showMessage(_cyberLogOpen ? 'CYBER LOG ON' : 'CYBER LOG OFF');
                    return true;
                }
                return false;
            case 'KeyJ':
                if (typeof ConjunctionSystem !== 'undefined') {
                    var cjVis = ConjunctionSystem.toggle();
                    _showMessage(cjVis ? 'CONJUNCTION ALERTS ON' : 'CONJUNCTION ALERTS OFF');
                }
                return true;
            case 'KeyG':
                _dataLinksEnabled = !_dataLinksEnabled;
                _showMessage(_dataLinksEnabled ? 'DATALINK ON' : 'DATALINK OFF');
                return true;
            case 'KeyT':
                if (e && e.shiftKey) {
                    // Shift+T = Threat assessment overlay
                    _toggleThreatOverlay();
                    _showMessage(_threatOverlayEnabled ? 'THREAT OVERLAY ON' : 'THREAT OVERLAY OFF');
                    return true;
                }
                return false;
            case 'KeyW':
                if (e && e.shiftKey) {
                    // Shift+W = Toggle waypoint placement mode
                    _toggleWaypointMode();
                    return true;
                }
                return false;
            case 'Backspace':
                if (_waypointMode) {
                    if (e && e.shiftKey) {
                        _clearAllWaypoints();
                    } else {
                        _removeLastWaypoint();
                    }
                    return true;
                }
                return false;
            default: return false;
        }
    }

    function _togglePanel(name) {
        if (name === 'threats') {
            _toggleThreatOverlay();
            return;
        }
        if (name === 'search') {
            _toggleSearchPanel();
            return;
        }
        if (name === 'analytics') {
            _toggleAnalyticsPanel();
            return;
        }
        if (name === 'comm') {
            _toggleCommPanel();
            return;
        }
        if (name === 'cyber') {
            if (typeof CyberCockpit !== 'undefined') CyberCockpit.toggle();
            return;
        }
        if (name === 'cyberLog') {
            _toggleCyberLogPanel();
            return;
        }
        if (name === 'aar') {
            _toggleAAR();
            return;
        }
        if (name === 'statusboard') {
            _toggleStatusBoard();
            return;
        }
        if (name === 'spread') {
            _openSpreadDialog();
            return;
        }
        if (name === 'engTimeline') {
            _toggleEngTimeline();
            return;
        }
        if (name === 'dataExport') {
            _toggleDataExport();
            return;
        }
        if (name === 'autopilot') {
            _toggleAutopilotPanel();
            return;
        }
        if (name === 'engagement') {
            _toggleEngagementStats();
            return;
        }
        if (name === 'orbital') {
            if (_panelVisible.orbital === 'auto') _panelVisible.orbital = 'on';
            else if (_panelVisible.orbital === 'on') _panelVisible.orbital = 'off';
            else _panelVisible.orbital = 'auto';
            _showMessage('ORBITAL: ' + _panelVisible.orbital.toUpperCase());
        } else {
            _panelVisible[name] = !_panelVisible[name];
            var label = name === 'flightData' ? 'FLIGHT DATA' :
                        name === 'entityList' ? 'ENTITY LIST' :
                        name === 'statusBar' ? 'STATUS BAR' :
                        name.toUpperCase();
            _showMessage(label + ': ' + (_panelVisible[name] ? 'ON' : 'OFF'));
        }
        _applyPanelVisibility();
        _savePanelPrefs();
    }

    function _toggleAllPanels() {
        _panelsMinimized = !_panelsMinimized;
        if (_panelsMinimized) {
            _panelVisible.flightData = false;
            _panelVisible.systems = false;
            _panelVisible.orbital = 'off';
            _panelVisible.help = false;
            _panelVisible.entityList = false;
            // Also hide the HUD
            if (typeof FighterHUD !== 'undefined' && FighterHUD.setToggle) {
                FighterHUD.setToggle('hud', false);
            }
            _showMessage('ALL UI HIDDEN (Tab to restore)');
        } else {
            _panelVisible.flightData = true;
            _panelVisible.systems = true;
            _panelVisible.orbital = 'auto';
            _panelVisible.help = false;
            _panelVisible.entityList = true;
            // Restore HUD
            if (typeof FighterHUD !== 'undefined' && FighterHUD.setToggle) {
                FighterHUD.setToggle('hud', true);
            }
            _showMessage('ALL UI RESTORED');
        }
        _applyPanelVisibility();
        _savePanelPrefs();
    }

    function _toggleTrace(key) {
        if (key === 'ecef') {
            _showEcefOrbit = !_showEcefOrbit;
            _showMessage('ECEF ORBIT: ' + (_showEcefOrbit ? 'ON' : 'OFF'));
        } else if (key === 'eci') {
            _showEciOrbit = !_showEciOrbit;
            _showMessage('ECI ORBIT: ' + (_showEciOrbit ? 'ON' : 'OFF'));
        } else if (key === 'groundtrack') {
            _showPredictedGroundTrack = !_showPredictedGroundTrack;
            _showMessage('PREDICTED GROUND TRACK: ' + (_showPredictedGroundTrack ? 'ON' : 'OFF'));
        } else if (key === 'trail') {
            _showTrail = !_showTrail;
            _showMessage('TRAIL: ' + (_showTrail ? 'ON' : 'OFF'));
        }
        _syncSettingsUI();
        _savePanelPrefs();
    }

    function _toggleHud(key) {
        if (typeof FighterHUD === 'undefined' || !FighterHUD.toggles) return;
        var current = FighterHUD.toggles[key];
        if (current === undefined) return;
        FighterHUD.setToggle(key, !current);
        var labels = {
            hud: 'HUD', speedTape: 'SPEED TAPE', altTape: 'ALT TAPE',
            heading: 'HEADING', pitchLadder: 'PITCH LADDER', fpm: 'FPM',
            gMeter: 'G-METER', engineFuel: 'ENGINE/FUEL', weapons: 'WEAPONS',
            warnings: 'WARNINGS', orbital: 'ORBITAL'
        };
        _showMessage((labels[key] || key.toUpperCase()) + ': ' + (!current ? 'ON' : 'OFF'));
        _syncSettingsUI();
        _savePanelPrefs();
    }

    function _toggleSubsystem(key) {
        if (key === 'audio') {
            _audioEnabled = !_audioEnabled;
            if (typeof SimAudio !== 'undefined') {
                if (_audioEnabled) {
                    SimAudio.init();
                } else {
                    SimAudio.cleanup();
                }
            }
            _showMessage('AUDIO: ' + (_audioEnabled ? 'ON' : 'OFF'));
        } else if (key === 'visualfx') {
            _visualFxEnabled = !_visualFxEnabled;
            if (typeof SimEffects !== 'undefined') {
                if (!_visualFxEnabled) {
                    SimEffects.cleanup();
                } else {
                    SimEffects.init(_viewer);
                }
            }
            _showMessage('VISUAL FX: ' + (_visualFxEnabled ? 'ON' : 'OFF'));
        }
        _syncSettingsUI();
        _savePanelPrefs();
    }

    let _vizGlobalComms = true;

    function _toggleGlobalViz(key, item) {
        switch (key) {
            case 'globalOrbits': _vizGlobalOrbits = !_vizGlobalOrbits; break;
            case 'globalTrails': _vizGlobalTrails = !_vizGlobalTrails; break;
            case 'globalLabels': _vizGlobalLabels = !_vizGlobalLabels; break;
            case 'globalSensors': _vizGlobalSensors = !_vizGlobalSensors; break;
            case 'globalComms': _vizGlobalComms = !_vizGlobalComms; break;
        }
        if (item) item.classList.toggle('active');
        _applyVizControls();
        var label = key.replace('global', '').toUpperCase();
        var val = key === 'globalOrbits' ? _vizGlobalOrbits :
                  key === 'globalTrails' ? _vizGlobalTrails :
                  key === 'globalLabels' ? _vizGlobalLabels :
                  key === 'globalComms' ? _vizGlobalComms : _vizGlobalSensors;
        _showMessage(label + ': ' + (val ? 'ON' : 'OFF'));
    }

    function _applyPanelVisibility() {
        _setDisplay('flightDataPanel', _panelVisible.flightData);
        _setDisplay('systemsPanel', _panelVisible.systems);
        _setDisplay('controlsHelp', _panelVisible.help);
        _setDisplay('entityListPanel', _panelVisible.entityList);
        _setDisplay('statusBar', _panelVisible.statusBar);
        // Orbital panel handled by _updateOrbitalPanel
        _syncSettingsUI();
    }

    // -----------------------------------------------------------------------
    // Settings gear
    // -----------------------------------------------------------------------
    function _initSettingsGear() {
        _loadPanelPrefs();

        // --- Initialize Tabbed Settings Panel ---
        if (typeof SettingsPanel !== 'undefined') {
            SettingsPanel.init({
                onTogglePanel: function(key) { _togglePanel(key); },
                onToggleHud: function(key) { _toggleHud(key); },
                onToggleTrace: function(key) { _toggleTrace(key); },
                onToggleSubsystem: function(key) { _toggleSubsystem(key); },
                onToggleViz: function(key) {
                    // Reuse old viz toggle logic
                    if (key === 'globalOrbits') { _vizGlobalOrbits = !_vizGlobalOrbits; _applyVizControls(); }
                    else if (key === 'globalTrails') { _vizGlobalTrails = !_vizGlobalTrails; _applyVizControls(); }
                    else if (key === 'globalLabels') { _vizGlobalLabels = !_vizGlobalLabels; _applyVizControls(); }
                    else if (key === 'globalSensors') { _vizGlobalSensors = !_vizGlobalSensors; _applyVizControls(); }
                    else if (key === 'globalComms') { _vizGlobalComms = !_vizGlobalComms; _applyVizControls(); }
                    _savePanelPrefs();
                },
                onHudBrightness: function(val) {
                    if (typeof FighterHUD !== 'undefined' && FighterHUD.setBrightness) FighterHUD.setBrightness(val / 100);
                    _savePanelPrefs();
                },
                onHudAllOn: function() {
                    if (typeof FighterHUD !== 'undefined' && FighterHUD.toggles) {
                        var keys = Object.keys(FighterHUD.toggles);
                        for (var i = 0; i < keys.length; i++) FighterHUD.toggles[keys[i]] = true;
                    }
                },
                onHudAllOff: function() {
                    if (typeof FighterHUD !== 'undefined' && FighterHUD.toggles) {
                        var keys = Object.keys(FighterHUD.toggles);
                        for (var i = 0; i < keys.length; i++) FighterHUD.toggles[keys[i]] = false;
                    }
                },
                onOrbitRevs: function(val) {
                    _orbitRevs = val;
                    _showMessage('ORBIT REVS: ' + _orbitRevs);
                    _savePanelPrefs();
                },
                onTrailDuration: function(val) {
                    _trailDurationSec = val;
                    _showMessage('TRAIL: ' + (val === 0 ? 'INFINITE' : val + 's'));
                    _savePanelPrefs();
                },
                onShowMessage: function(msg) { _showMessage(msg); },
                onLayoutPreset: function(preset) { _applyLayoutPreset(preset); },
                onCarrierLaunch: function() { _openCarrierLaunchUI(); },
                onSatDeploy: function() { _openSubSatDeployUI(); },
                getState: function(type, key) {
                    if (type === 'panel') {
                        if (key === 'orbital') return _panelVisible.orbital !== 'off';
                        return !!_panelVisible[key];
                    }
                    if (type === 'hud') return typeof FighterHUD !== 'undefined' && FighterHUD.toggles ? !!FighterHUD.toggles[key] : false;
                    if (type === 'trace') {
                        if (key === 'ecef') return _showEcefOrbit;
                        if (key === 'eci') return _showEciOrbit;
                        if (key === 'groundtrack') return _showPredictedGroundTrack;
                        if (key === 'trail') return _showTrail;
                    }
                    if (type === 'subsystem') {
                        if (key === 'audio') return _audioEnabled;
                        if (key === 'visualfx') return _visualFxEnabled;
                    }
                    if (type === 'viz') {
                        if (key === 'globalOrbits') return _vizGlobalOrbits;
                        if (key === 'globalTrails') return _vizGlobalTrails;
                        if (key === 'globalLabels') return _vizGlobalLabels;
                        if (key === 'globalSensors') return _vizGlobalSensors;
                        if (key === 'globalComms') return _vizGlobalComms;
                    }
                    return false;
                },
                getOrbitRevs: function() { return _orbitRevs; },
                getTrailDuration: function() { return _trailDurationSec; },
                getHudBrightness: function() { return typeof FighterHUD !== 'undefined' && FighterHUD.getBrightness ? Math.round(FighterHUD.getBrightness() * 100) : 100; },
                getVizGroupsHtml: function() { return _buildVizGroupsHtml(); }
            });
        } else {
            // Fallback: old dropdown behavior
            var btn = document.getElementById('settingsBtn');
            var dropdown = document.getElementById('settingsDropdown');
            if (btn && dropdown) {
                btn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var isOpen = dropdown.classList.toggle('open');
                    btn.classList.toggle('open', isOpen);
                });
                document.addEventListener('click', function() {
                    dropdown.classList.remove('open');
                    btn.classList.remove('open');
                });
                dropdown.addEventListener('click', function(e) {
                    e.stopPropagation();
                    var item = e.target.closest('.settings-item');
                    if (!item) return;
                    var panel = item.getAttribute('data-panel');
                    var hudKey = item.getAttribute('data-hud');
                    var traceKey = item.getAttribute('data-trace');
                    var subsysKey = item.getAttribute('data-subsystem');
                    var vizKey = item.getAttribute('data-viz');
                    if (panel) _togglePanel(panel);
                    else if (hudKey) _toggleHud(hudKey);
                    else if (traceKey) _toggleTrace(traceKey);
                    else if (subsysKey) _toggleSubsystem(subsysKey);
                    else if (vizKey) _toggleGlobalViz(vizKey, item);
                });
            }
        }

        // Orbit revolutions selector (old fallback)
        var revSelect = document.getElementById('orbitRevSelect');
        if (revSelect) {
            revSelect.value = String(_orbitRevs);
            revSelect.addEventListener('change', function() {
                _orbitRevs = parseInt(revSelect.value) || 1;
                _showMessage('ORBIT REVS: ' + _orbitRevs);
                _savePanelPrefs();
            });
        }

        // Trail duration input (old fallback)
        var trailInput = document.getElementById('trailDuration');
        if (trailInput) {
            trailInput.value = String(_trailDurationSec);
            trailInput.addEventListener('change', function() {
                _trailDurationSec = Math.max(0, parseInt(trailInput.value) || 0);
                trailInput.value = String(_trailDurationSec);
                _showMessage('TRAIL DURATION: ' + (_trailDurationSec === 0 ? 'INFINITE' : _trailDurationSec + 's'));
                _savePanelPrefs();
            });
        }

        // --- Initialize Window Manager ---
        _initWindowManager();

        _syncSettingsUI();
    }

    // -----------------------------------------------------------------------
    // Window Manager Integration
    // -----------------------------------------------------------------------
    function _initWindowManager() {
        if (typeof WindowManager === 'undefined') return;

        // Register all draggable panels
        var panelDefs = [
            { id: 'flightDataPanel', title: 'FLIGHT DATA' },
            { id: 'systemsPanel', title: 'SYSTEMS' },
            { id: 'orbitalPanel', title: 'ORBITAL' },
            { id: 'entityListPanel', title: 'ENTITIES', closable: true, onClose: function() { _panelVisible.entityList = false; _syncSettingsUI(); } },
            { id: 'searchPanel', title: 'SEARCH', closable: true, onClose: function() { _panelVisible.search = false; _syncSettingsUI(); } },
            { id: 'analyticsPanel', title: 'ANALYTICS', closable: true, onClose: function() { _panelVisible.analytics = false; _syncSettingsUI(); } },
            { id: 'commPanel', title: 'COMMS', closable: true, onClose: function() { _panelVisible.comm = false; _syncSettingsUI(); } },
            { id: 'cyberTerminal', title: 'CYBER', closable: true, onClose: function() { if (typeof CyberCockpit !== 'undefined') CyberCockpit.hide(); } },
            { id: 'engTimelinePanel', title: 'ENGAGEMENTS', closable: true },
            { id: 'engagementPanel', title: 'COMBAT STATS', closable: true },
            { id: 'threatOverlay', title: 'THREATS', closable: true },
            { id: 'statusBoard', title: 'STATUS BOARD', closable: true },
            { id: 'cyberLogPanel', title: 'CYBER LOG', closable: true }
        ];

        for (var i = 0; i < panelDefs.length; i++) {
            var def = panelDefs[i];
            var el = document.getElementById(def.id);
            if (el) {
                WindowManager.register(def.id, el, {
                    title: def.title,
                    closable: !!def.closable,
                    onClose: def.onClose || null,
                    snap: true,
                    collapsible: true
                });
            }
        }

        WindowManager.init();
    }

    // -----------------------------------------------------------------------
    // Layout Presets
    // -----------------------------------------------------------------------
    function _applyLayoutPreset(preset) {
        // First hide all optional panels
        var optionalPanels = ['search', 'analytics', 'comm', 'cyber', 'cyberLog', 'aar', 'statusboard', 'threats', 'engagement', 'engTimeline', 'dataExport', 'spread'];
        for (var i = 0; i < optionalPanels.length; i++) {
            _panelVisible[optionalPanels[i]] = false;
        }

        switch (preset) {
            case 'combat':
                _panelVisible.flightData = true;
                _panelVisible.systems = true;
                _panelVisible.entityList = true;
                _panelVisible.threats = true;
                _panelVisible.engagement = true;
                _panelVisible.engTimeline = true;
                if (typeof FighterHUD !== 'undefined' && FighterHUD.toggles) {
                    FighterHUD.toggles.hud = true;
                    FighterHUD.toggles.weapons = true;
                    FighterHUD.toggles.rwr = true;
                    FighterHUD.toggles.warnings = true;
                }
                _showMessage('COMBAT LAYOUT');
                break;

            case 'orbital':
                _panelVisible.flightData = true;
                _panelVisible.systems = false;
                _panelVisible.orbital = 'full';
                _panelVisible.entityList = true;
                _showEcefOrbit = true;
                _showEciOrbit = true;
                _vizGlobalOrbits = true;
                _applyVizControls();
                _showMessage('ORBITAL OPS LAYOUT');
                break;

            case 'observer':
                _panelVisible.flightData = false;
                _panelVisible.systems = false;
                _panelVisible.entityList = true;
                _panelVisible.analytics = true;
                _panelVisible.search = true;
                _vizGlobalLabels = true;
                _applyVizControls();
                _showMessage('OBSERVER LAYOUT');
                break;

            case 'cyber':
                _panelVisible.flightData = false;
                _panelVisible.systems = false;
                _panelVisible.cyber = true;
                _panelVisible.comm = true;
                _panelVisible.threats = true;
                _panelVisible.cyberLog = true;
                if (typeof CyberCockpit !== 'undefined') CyberCockpit.show();
                _showMessage('CYBER OPS LAYOUT');
                break;

            case 'minimal':
                _panelVisible.flightData = false;
                _panelVisible.systems = false;
                _panelVisible.entityList = false;
                _panelVisible.statusBar = false;
                _showMessage('MINIMAL LAYOUT');
                break;
        }

        _updatePanelVisibility();
        _savePanelPrefs();
        if (typeof SettingsPanel !== 'undefined') SettingsPanel.syncAll();
    }

    // -----------------------------------------------------------------------
    // Carrier Operations UI
    // -----------------------------------------------------------------------
    function _openCarrierLaunchUI() {
        // Check if player is on a carrier
        if (!_playerEntity) { _showMessage('NO PLAYER'); return; }

        var carrierComp = null;
        if (_playerEntity.components) {
            for (var key in _playerEntity.components) {
                var comp = _playerEntity.components[key];
                if (comp && comp.type === 'ai/carrier_ops') {
                    carrierComp = comp;
                    break;
                }
            }
        }

        // Also check nearby carriers if player is not a carrier
        var targetCarrier = null;
        if (carrierComp) {
            targetCarrier = _playerEntity;
        } else {
            // Find the nearest carrier entity
            targetCarrier = _findNearestCarrier();
        }

        if (!targetCarrier) {
            _showMessage('NO CARRIER IN RANGE');
            return;
        }

        _showCarrierLaunchDialog(targetCarrier);
    }

    function _findNearestCarrier() {
        if (!_world || !_world.entities) return null;
        var best = null;
        var bestDist = Infinity;
        var pState = _playerState;
        if (!pState) return null;

        _world.entities.forEach(function(entity) {
            if (!entity.components) return;
            for (var key in entity.components) {
                var comp = entity.components[key];
                if (comp && comp.type === 'ai/carrier_ops') {
                    var es = entity.state;
                    if (!es) return;
                    var dLat = (es.lat || 0) - (pState.lat || 0);
                    var dLon = (es.lon || 0) - (pState.lon || 0);
                    var dist = Math.sqrt(dLat * dLat + dLon * dLon) * 6371000;
                    if (dist < bestDist) {
                        bestDist = dist;
                        best = entity;
                    }
                }
            }
        });
        return best;
    }

    function _showCarrierLaunchDialog(carrier) {
        var comp = null;
        for (var key in carrier.components) {
            if (carrier.components[key] && carrier.components[key].type === 'ai/carrier_ops') {
                comp = carrier.components[key];
                break;
            }
        }
        if (!comp) return;

        var isOrbital = comp.config.carrierType === 'orbital';
        var wing = isOrbital ? comp.config.subSats : comp.config.airWing;

        var html = '<div style="padding:16px;font-family:monospace;color:#00ff00;max-width:400px">';
        html += '<h3 style="color:#44aaff;text-align:center;margin:0 0 12px">' + (isOrbital ? 'DEPLOY SUB-SATELLITE' : 'CARRIER LAUNCH') + '</h3>';
        html += '<div style="color:#006600;font-size:10px;margin-bottom:8px">Carrier: ' + carrier.name + ' | Airborne: ' + comp.state.airborne + '/' + comp.config.maxAirborne + '</div>';

        if (wing.length === 0) {
            html += '<div style="color:#555;text-align:center;padding:20px">No assets configured</div>';
        } else {
            for (var i = 0; i < wing.length; i++) {
                var item = wing[i];
                var ready = item.count || 0;
                html += '<div class="carrier-launch-row" data-template="' + item.template + '" data-carrier="' + carrier.id + '" style="' +
                    'display:flex;align-items:center;padding:8px 12px;margin:4px 0;' +
                    'background:rgba(0,30,0,0.6);border:1px solid #004400;border-radius:4px;' +
                    'cursor:pointer;transition:border-color 0.15s">' +
                    '<span style="flex:1;font-weight:bold">' + item.template + '</span>' +
                    '<span style="color:#006600;margin-right:12px">x' + ready + '</span>' +
                    '<button class="carrier-launch-one" style="background:rgba(0,60,0,0.8);border:1px solid #00aa00;color:#00ff00;padding:4px 10px;border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px;margin-right:4px">LAUNCH 1</button>' +
                    '<button class="carrier-launch-all" style="background:rgba(0,40,60,0.8);border:1px solid #0088aa;color:#44ccff;padding:4px 10px;border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px">ALL</button>' +
                    '</div>';
            }
        }

        html += '<div style="text-align:center;margin-top:12px">' +
            '<button id="carrierLaunchClose" style="background:rgba(60,0,0,0.8);border:1px solid #aa0000;color:#ff4444;padding:6px 20px;border-radius:3px;cursor:pointer;font-family:monospace">CLOSE</button>' +
            '</div></div>';

        // Show in a modal
        var modal = document.createElement('div');
        modal.id = 'carrierLaunchModal';
        modal.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(8,12,8,0.95);border:1px solid #00aa00;border-radius:6px;z-index:3000;box-shadow:0 4px 20px rgba(0,0,0,0.8)';
        modal.innerHTML = html;
        document.body.appendChild(modal);

        // Event handlers
        modal.querySelector('#carrierLaunchClose').addEventListener('click', function() {
            document.body.removeChild(modal);
        });

        var launchOnes = modal.querySelectorAll('.carrier-launch-one');
        for (var j = 0; j < launchOnes.length; j++) {
            launchOnes[j].addEventListener('click', function(e) {
                e.stopPropagation();
                var row = this.closest('.carrier-launch-row');
                var tmpl = row.getAttribute('data-template');
                var cId = row.getAttribute('data-carrier');
                _doCarrierLaunch(cId, tmpl, 1);
                _showMessage('LAUNCHING ' + tmpl);
                document.body.removeChild(modal);
            });
        }

        var launchAlls = modal.querySelectorAll('.carrier-launch-all');
        for (var k = 0; k < launchAlls.length; k++) {
            launchAlls[k].addEventListener('click', function(e) {
                e.stopPropagation();
                var row = this.closest('.carrier-launch-row');
                var tmpl = row.getAttribute('data-template');
                var cId = row.getAttribute('data-carrier');
                _doCarrierLaunch(cId, tmpl, -1); // -1 = all
                _showMessage('LAUNCHING ALL ' + tmpl);
                document.body.removeChild(modal);
            });
        }
    }

    function _doCarrierLaunch(carrierId, templateName, count) {
        if (!_world || !_world.entities) return;
        var carrier = null;
        _world.entities.forEach(function(e) { if (e.id === carrierId) carrier = e; });
        if (!carrier) return;

        var comp = null;
        for (var key in carrier.components) {
            if (carrier.components[key] && carrier.components[key].type === 'ai/carrier_ops') {
                comp = carrier.components[key];
                break;
            }
        }
        if (!comp) return;

        if (count === -1) {
            comp.launchAll(templateName);
        } else {
            for (var i = 0; i < count; i++) {
                comp.queueLaunch(templateName, {});
            }
        }
    }

    function _openSubSatDeployUI() {
        _openCarrierLaunchUI(); // Same UI, different wording handled internally
    }

    function _buildVizGroupsHtml() {
        if (!_vizGroups) return '';
        var html = '';
        var keys = Object.keys(_vizGroups);
        for (var i = 0; i < keys.length; i++) {
            var g = _vizGroups[keys[i]];
            var activeClass = g.show !== false ? ' sp-active' : '';
            html += '<div class="sp-check-item' + activeClass + '" data-vizgroup="' + keys[i] + '">' +
                '<div class="sp-check"><span class="sp-checkmark">&#10003;</span></div>' +
                '<span class="sp-label">' + keys[i] + ' (' + g.count + ')</span>' +
            '</div>';
        }
        return html;
    }

    function _syncSettingsUI() {
        var dropdown = document.getElementById('settingsDropdown');
        if (!dropdown) return;

        var items = dropdown.querySelectorAll('.settings-item');
        for (var i = 0; i < items.length; i++) {
            var panel = items[i].getAttribute('data-panel');
            var hudKey = items[i].getAttribute('data-hud');
            var traceKey = items[i].getAttribute('data-trace');
            var isActive = false;

            if (panel) {
                if (panel === 'orbital') {
                    isActive = _panelVisible.orbital !== 'off';
                } else {
                    isActive = !!_panelVisible[panel];
                }
            } else if (hudKey && typeof FighterHUD !== 'undefined' && FighterHUD.toggles) {
                isActive = !!FighterHUD.toggles[hudKey];
            } else if (traceKey) {
                if (traceKey === 'ecef') isActive = _showEcefOrbit;
                else if (traceKey === 'eci') isActive = _showEciOrbit;
                else if (traceKey === 'groundtrack') isActive = _showPredictedGroundTrack;
                else if (traceKey === 'trail') isActive = _showTrail;
            } else if (items[i].getAttribute('data-subsystem')) {
                var subsysKey = items[i].getAttribute('data-subsystem');
                if (subsysKey === 'audio') isActive = _audioEnabled;
                else if (subsysKey === 'visualfx') isActive = _visualFxEnabled;
            } else if (items[i].getAttribute('data-viz')) {
                var vizKey = items[i].getAttribute('data-viz');
                if (vizKey === 'globalOrbits') isActive = _vizGlobalOrbits;
                else if (vizKey === 'globalTrails') isActive = _vizGlobalTrails;
                else if (vizKey === 'globalLabels') isActive = _vizGlobalLabels;
                else if (vizKey === 'globalSensors') isActive = _vizGlobalSensors;
            }

            if (isActive) {
                items[i].classList.add('active');
            } else {
                items[i].classList.remove('active');
            }
        }
    }

    function _loadPanelPrefs() {
        try {
            var saved = localStorage.getItem('livesim_panels');
            if (saved) {
                var prefs = JSON.parse(saved);
                if (prefs.flightData !== undefined) _panelVisible.flightData = prefs.flightData;
                if (prefs.systems !== undefined) _panelVisible.systems = prefs.systems;
                if (prefs.orbital !== undefined) _panelVisible.orbital = prefs.orbital;
                if (prefs.help !== undefined) _panelVisible.help = prefs.help;
                if (prefs.entityList !== undefined) _panelVisible.entityList = prefs.entityList;
                if (prefs.statusBar !== undefined) _panelVisible.statusBar = prefs.statusBar;
                // Restore trace/orbit display settings
                if (prefs.showEcefOrbit !== undefined) _showEcefOrbit = prefs.showEcefOrbit;
                if (prefs.showEciOrbit !== undefined) _showEciOrbit = prefs.showEciOrbit;
                if (prefs.showPredictedGroundTrack !== undefined) _showPredictedGroundTrack = prefs.showPredictedGroundTrack;
                if (prefs.orbitRevs !== undefined) _orbitRevs = prefs.orbitRevs;
                if (prefs.showTrail !== undefined) _showTrail = prefs.showTrail;
                if (prefs.trailDurationSec !== undefined) _trailDurationSec = prefs.trailDurationSec;
                // Restore subsystem toggles
                if (prefs.audioEnabled !== undefined) _audioEnabled = prefs.audioEnabled;
                if (prefs.visualFxEnabled !== undefined) _visualFxEnabled = prefs.visualFxEnabled;
                // Restore HUD element toggles
                if (prefs.hudToggles && typeof FighterHUD !== 'undefined' && FighterHUD.setToggle) {
                    var keys = Object.keys(prefs.hudToggles);
                    for (var i = 0; i < keys.length; i++) {
                        FighterHUD.setToggle(keys[i], prefs.hudToggles[keys[i]]);
                    }
                }
                // Restore viz global toggles
                if (prefs.vizGlobalOrbits !== undefined) _vizGlobalOrbits = prefs.vizGlobalOrbits;
                if (prefs.vizGlobalTrails !== undefined) _vizGlobalTrails = prefs.vizGlobalTrails;
                if (prefs.vizGlobalLabels !== undefined) _vizGlobalLabels = prefs.vizGlobalLabels;
                if (prefs.vizGlobalSensors !== undefined) _vizGlobalSensors = prefs.vizGlobalSensors;
            }
        } catch (e) { /* ignore */ }
    }

    function _savePanelPrefs() {
        try {
            var data = JSON.parse(JSON.stringify(_panelVisible));
            // Include trace/orbit display settings
            data.showEcefOrbit = _showEcefOrbit;
            data.showEciOrbit = _showEciOrbit;
            data.showPredictedGroundTrack = _showPredictedGroundTrack;
            data.orbitRevs = _orbitRevs;
            data.showTrail = _showTrail;
            data.trailDurationSec = _trailDurationSec;
            // Include subsystem toggles
            data.audioEnabled = _audioEnabled;
            data.visualFxEnabled = _visualFxEnabled;
            // Include HUD toggle states
            if (typeof FighterHUD !== 'undefined' && FighterHUD.getToggles) {
                data.hudToggles = FighterHUD.getToggles();
            }
            // Include viz global toggles
            data.vizGlobalOrbits = _vizGlobalOrbits;
            data.vizGlobalTrails = _vizGlobalTrails;
            data.vizGlobalLabels = _vizGlobalLabels;
            data.vizGlobalSensors = _vizGlobalSensors;
            localStorage.setItem('livesim_panels', JSON.stringify(data));
        } catch (e) { /* ignore */ }
    }

    // -----------------------------------------------------------------------
    // Entity Picker (click-to-select, assume control)
    // -----------------------------------------------------------------------
    function _setupEntityPicker() {
        var handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);

        handler.setInputAction(function(click) {
            var picked = _viewer.scene.pick(click.position);
            if (Cesium.defined(picked) && picked.id && picked.id._ecsEntityId) {
                var ecsId = picked.id._ecsEntityId;
                var entity = _world.getEntity(ecsId);
                if (entity) {
                    _showPickPopup(entity, click.position);
                    return;
                }
            }
            // Hide popup if clicking empty space (only in observer/earth/moon modes)
            if (_observerMode || _isGlobeMode()) {
                _hidePickPopup();
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    }

    function _showPickPopup(entity, screenPos) {
        _pickedEntity = entity;
        var popup = document.getElementById('entityPickPopup');
        if (!popup) {
            // Create popup element dynamically
            popup = document.createElement('div');
            popup.id = 'entityPickPopup';
            popup.style.cssText = 'position:fixed;z-index:200;background:rgba(0,0,0,0.85);' +
                'border:1px solid #44aaff;border-radius:6px;padding:10px 14px;color:#eee;' +
                'font-family:monospace;font-size:12px;min-width:180px;display:none;' +
                'pointer-events:auto;';
            document.body.appendChild(popup);
            _pickPopup = popup;
        }

        var s = entity.state || {};
        var altStr = s.alt != null ? (s.alt > 10000 ? (s.alt / 1000).toFixed(1) + ' km' : Math.round(s.alt) + ' m') : '---';
        var teamColor = entity.team === 'blue' ? '#4488ff' : entity.team === 'red' ? '#ff4444' : '#aaa';
        var hasPhysics = !!entity.getComponent('physics');
        var isCurrentPlayer = _playerEntity && entity.id === _playerEntity.id;

        // Build comm status section
        var commHtml = '';
        if (s._commNetworks && s._commNetworks.length > 0) {
            var commColor = s._commJammed ? '#ff4444' : '#00ff88';
            var commStatus = s._commJammed ? 'JAMMED' : 'ONLINE';
            commHtml += '<div style="margin-top:4px;padding-top:4px;border-top:1px solid #333">';
            commHtml += '<div style="color:#506880;font-size:10px;margin-bottom:2px">COMM STATUS</div>';
            commHtml += '<div style="color:' + commColor + ';font-size:11px">' + commStatus + '</div>';
            commHtml += '<div style="color:#888;font-size:10px">Networks: ' + s._commNetworks.length + '</div>';
            if (s._commBandwidth != null) {
                commHtml += '<div style="color:#888;font-size:10px">BW: ' + (s._commBandwidth || 0).toFixed(1) + ' Mbps</div>';
            }
            if (s._commLatency != null && s._commLatency > 0) {
                commHtml += '<div style="color:#888;font-size:10px">Lat: ' + (s._commLatency || 0).toFixed(1) + ' ms</div>';
            }
            // F2T2EA track source for weapon entities
            if (s._samTrackSource && s._samTrackSource !== 'NONE') {
                var srcColor = s._samTrackSource === 'ORGANIC' ? '#00ff88' :
                    s._samTrackSource === 'COMM' ? '#44aaff' :
                    s._samTrackSource === 'HYBRID' ? '#ffcc44' : '#888';
                commHtml += '<div style="color:' + srcColor + ';font-size:10px">Track: ' + s._samTrackSource +
                    ' (O:' + (s._samOrganicTracks || 0) + ' C:' + (s._samCommTracks || 0) + ')</div>';
            }
            if (s._samState) {
                commHtml += '<div style="color:#aaa;font-size:10px">SAM: ' + s._samState + '</div>';
            }
            commHtml += '</div>';
        }

        var html = '<div style="font-size:14px;font-weight:bold;color:' + teamColor + ';margin-bottom:4px">' +
            entity.name + '</div>' +
            '<div style="color:#888;margin-bottom:2px">Type: ' + (entity.type || '?') + '</div>' +
            '<div style="color:#888;margin-bottom:2px">Team: ' + (entity.team || 'neutral') + '</div>' +
            (entity.vizCategory ? '<div style="color:#888;margin-bottom:2px">Group: ' + entity.vizCategory + '</div>' : '') +
            '<div style="color:#888;margin-bottom:2px">Alt: ' + altStr + '</div>' +
            commHtml +
            '<div style="display:flex;gap:6px;margin-top:6px">' +
            '<button id="pickTrackBtn" style="flex:1;padding:4px 8px;background:#335;color:#4af;border:1px solid #4af;border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px">TRACK</button>';

        if (hasPhysics && !isCurrentPlayer) {
            html += '<button id="pickAssumeBtn" style="flex:1;padding:4px 8px;background:#533;color:#fa4;border:1px solid #fa4;border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px">ASSUME CONTROL</button>';
        }
        html += '</div>';

        popup.innerHTML = html;
        popup.style.display = 'block';

        // Position near click but within viewport
        var x = Math.min(screenPos.x + 15, window.innerWidth - 250);
        var y = Math.min(screenPos.y - 20, window.innerHeight - 200);
        popup.style.left = x + 'px';
        popup.style.top = y + 'px';

        // Wire buttons
        var trackBtn = document.getElementById('pickTrackBtn');
        if (trackBtn) {
            trackBtn.onclick = function() {
                _trackEntity(entity);
                _hidePickPopup();
            };
        }
        var assumeBtn = document.getElementById('pickAssumeBtn');
        if (assumeBtn) {
            assumeBtn.onclick = function() {
                _assumeControl(entity);
                _hidePickPopup();
            };
        }
    }

    function _hidePickPopup() {
        var popup = document.getElementById('entityPickPopup');
        if (popup) popup.style.display = 'none';
        _pickedEntity = null;
    }

    function _trackEntity(entity) {
        _trackingEntity = entity;
        var s = entity.state;
        if (s && s.lat != null && s.lon != null) {
            var pos = Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.alt || 0);
            var range = (s.alt || 500) * 3 + 1000;
            _viewer.camera.flyTo({
                destination: pos,
                orientation: { heading: 0, pitch: -0.5, roll: 0 },
                duration: 1.0,
                complete: function() {
                    _viewer.camera.lookAt(pos,
                        new Cesium.HeadingPitchRange(0, -0.5, range));
                }
            });
        }
        _showMessage('TRACKING: ' + entity.name);
    }

    function _assumeControl(entity) {
        // 1. Un-hijack old player (re-enable ECS components)
        if (_playerEntity) {
            var oldPhys = _playerEntity.getComponent('physics');
            if (oldPhys) oldPhys.enabled = true;
            var oldCtrl = _playerEntity.getComponent('control');
            if (oldCtrl) oldCtrl.enabled = true;
            var oldAi = _playerEntity.getComponent('ai');
            if (oldAi) oldAi.enabled = true;
        }

        // 2. Hijack new entity
        _hijackPlayer(entity);

        // 3. Init cockpit (sets _playerState, _playerConfig, propulsion, weapons/sensors)
        _initCockpit(entity);
        _playerEntity = entity;

        // 4. Recreate orbit visualization for new player
        _cleanupOrbitEntities();
        _createOrbitEntities();

        // 5. Rebuild entity list with new [YOU] tag
        _buildEntityList();

        // 6. Exit observer mode, enter cockpit
        _observerMode = false;
        _trackingEntity = null;
        _cameraMode = 'chase';

        // 7. Reset camera orbit params to defaults (may be at odd angles from observer mode)
        _camHeadingOffset = 0;
        _camPitch = -0.3;
        _camRange = _isStaticPlayer ? 500 : (_playerState.alt > 100000 ? 5000 : 200);
        _camDragging = false;

        // 8. Show cockpit panels (observer mode hides them)
        // Static ground entities hide flight panels — cyber cockpit is primary
        _panelVisible.flightData = !_isStaticPlayer;
        _panelVisible.systems = !_isStaticPlayer;
        _applyPanelVisibility();

        // 9. Release camera from any transform/tracking
        _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        if (_viewer.trackedEntity) _viewer.trackedEntity = undefined;

        // 10. Disable Cesium controller inputs (cockpit mode takes over)
        _viewer.scene.screenSpaceCameraController.enableInputs = false;

        // 11. Position camera on new player
        _positionInitialCamera();

        // 12. Init HUD
        var hudCanvas = document.getElementById('hudCanvas');
        if (hudCanvas) {
            hudCanvas.style.display = 'block';
            if (!FighterHUD._ctx) {
                hudCanvas.width = hudCanvas.clientWidth;
                hudCanvas.height = hudCanvas.clientHeight;
                FighterHUD.init(hudCanvas);
            }
        }

        // 13. Init planner handler if not done
        if (typeof SpaceplanePlanner !== 'undefined' && !_plannerMode) {
            _initPlannerClickHandler();
        }

        // 14. Close pick popup
        if (_pickPopup) _pickPopup.style.display = 'none';

        // Auto-open cyber cockpit for static ground entities
        if (_isStaticPlayer && typeof CyberCockpit !== 'undefined') {
            CyberCockpit.setPlayerTeam(entity.team || 'blue');
            CyberCockpit.show();
        }

        _showMessage('ASSUMING CONTROL: ' + entity.name, 3000);
    }

    // -----------------------------------------------------------------------
    // Visualization Groups (per-entity/type/team/category toggles)
    // -----------------------------------------------------------------------
    function _buildVizGroups() {
        _vizGroups = {};
        _world.entities.forEach(function(entity) {
            // Group by type
            var typeKey = 'type:' + (entity.type || 'unknown');
            if (!_vizGroups[typeKey]) _vizGroups[typeKey] = { show: true, label: entity.type || 'unknown', kind: 'type' };

            // Group by team
            var teamKey = 'team:' + (entity.team || 'neutral');
            if (!_vizGroups[teamKey]) _vizGroups[teamKey] = { show: true, label: entity.team || 'neutral', kind: 'team' };

            // Group by vizCategory (constellation name, etc.)
            if (entity.vizCategory) {
                var catKey = 'cat:' + entity.vizCategory;
                if (!_vizGroups[catKey]) _vizGroups[catKey] = { show: true, label: entity.vizCategory, kind: 'category' };
            }
        });

        // Populate the viz group list in the settings panel
        _populateVizGroupList();
    }

    function _populateVizGroupList() {
        var container = document.getElementById('vizGroupList');
        if (!container) return;

        var html = '';
        // Sort groups: categories first, then types, then teams
        var keys = Object.keys(_vizGroups).sort(function(a, b) {
            var order = { category: 0, type: 1, team: 2 };
            var ka = order[_vizGroups[a].kind] || 3;
            var kb = order[_vizGroups[b].kind] || 3;
            if (ka !== kb) return ka - kb;
            return a.localeCompare(b);
        });

        for (var i = 0; i < keys.length; i++) {
            var g = _vizGroups[keys[i]];
            var icon = g.kind === 'category' ? '\u2606' : g.kind === 'type' ? '\u25CB' : '\u25A0';
            var activeClass = g.show ? ' active' : '';
            html += '<div class="settings-item' + activeClass + '" data-vizgroup="' + keys[i] + '">' +
                '<span style="margin-right:6px">' + icon + '</span>' +
                g.label.toUpperCase() +
                '<span style="color:#666;margin-left:auto;font-size:10px">' + g.kind + '</span></div>';
        }
        container.innerHTML = html;

        // Wire click handlers
        container.addEventListener('click', function(e) {
            var item = e.target.closest('.settings-item');
            if (!item) return;
            var groupKey = item.getAttribute('data-vizgroup');
            if (groupKey && _vizGroups[groupKey]) {
                _vizGroups[groupKey].show = !_vizGroups[groupKey].show;
                item.classList.toggle('active');
                _applyVizControls();
            }
        });
    }

    function _applyVizControls() {
        _world.entities.forEach(function(entity) {
            var s = entity.state;
            if (!s) return;

            // Determine effective visibility from all matching groups
            var show = true;

            // Check type group
            var typeKey = 'type:' + (entity.type || 'unknown');
            if (_vizGroups[typeKey] && !_vizGroups[typeKey].show) show = false;

            // Check team group
            var teamKey = 'team:' + (entity.team || 'neutral');
            if (_vizGroups[teamKey] && !_vizGroups[teamKey].show) show = false;

            // Check category group
            if (entity.vizCategory) {
                var catKey = 'cat:' + entity.vizCategory;
                if (_vizGroups[catKey] && !_vizGroups[catKey].show) show = false;
            }

            // Don't hide the player
            if (_playerEntity && entity.id === _playerEntity.id) show = true;

            // Write viz state for visual components to read
            s._vizShow = show;
            s._vizOrbits = show && _vizGlobalOrbits;
            s._vizTrails = show && _vizGlobalTrails;
            s._vizLabels = show && _vizGlobalLabels;
            s._vizSensors = show && _vizGlobalSensors;
            s._vizComms = show && _vizGlobalComms;
        });
    }

    // -----------------------------------------------------------------------
    // Cleanup orbit entities for player switch
    // -----------------------------------------------------------------------
    function _cleanupOrbitEntities() {
        if (_trailEntity) { _viewer.entities.remove(_trailEntity); _trailEntity = null; }
        if (_groundTrackEntity) { _viewer.entities.remove(_groundTrackEntity); _groundTrackEntity = null; }
        if (_orbitPolyline) { _viewer.entities.remove(_orbitPolyline); _orbitPolyline = null; }
        if (_eciOrbitPolyline) { _viewer.entities.remove(_eciOrbitPolyline); _eciOrbitPolyline = null; }
        if (_predictedOrbitPolyline) { _viewer.entities.remove(_predictedOrbitPolyline); _predictedOrbitPolyline = null; }
        if (_predictedGroundTrackEntity) { _viewer.entities.remove(_predictedGroundTrackEntity); _predictedGroundTrackEntity = null; }
        if (_apMarker) { _viewer.entities.remove(_apMarker); _apMarker = null; }
        if (_peMarker) { _viewer.entities.remove(_peMarker); _peMarker = null; }
        if (_anMarker) { _viewer.entities.remove(_anMarker); _anMarker = null; }
        if (_dnMarker) { _viewer.entities.remove(_dnMarker); _dnMarker = null; }
        _playerTrail = [];
        _playerGroundTrack = [];
        _playerTrailTimes = [];
        _predictedGroundTrackPositions = [];
    }

    // -----------------------------------------------------------------------
    // Mission Briefing
    // -----------------------------------------------------------------------
    function _showMissionBriefing(scenario) {
        var panel = document.getElementById('missionBriefing');
        if (!panel) return Promise.resolve();

        // Skip briefing for observer mode
        if (_observerMode) return Promise.resolve();

        // Skip for TLE catalog loads (no meaningful scenario metadata)
        if (scenario && scenario.metadata) {
            var mname = (scenario.metadata.name || '').toLowerCase();
            if (mname.indexOf('tle') >= 0 && mname.indexOf('catalog') >= 0) return Promise.resolve();
        }

        // Skip if no entities (empty scenario)
        var entities = (scenario && scenario.entities) ? scenario.entities : [];
        if (entities.length === 0) return Promise.resolve();

        // --- Populate header ---
        var meta = scenario.metadata || {};
        var titleEl = document.getElementById('mbTitle');
        var descEl = document.getElementById('mbDescription');
        if (titleEl) titleEl.textContent = meta.name || 'UNNAMED SCENARIO';
        if (descEl) descEl.textContent = meta.description || '';

        // --- Force composition ---
        var playerTeam = _playerEntity ? (_playerEntity.team || 'blue') : 'blue';
        var forceCount = {};
        var typeOrder = ['aircraft', 'satellite', 'ground_station', 'naval', 'sam', 'ground', 'other'];
        var typeLabels = {
            aircraft: 'Aircraft',
            satellite: 'Satellite',
            ground_station: 'Ground Station',
            naval: 'Naval',
            sam: 'SAM Battery',
            ground: 'Ground Unit',
            other: 'Other'
        };

        for (var ei = 0; ei < entities.length; ei++) {
            var ent = entities[ei];
            var etype = ent.type || 'other';
            if (!typeLabels[etype]) etype = 'other';
            if (!forceCount[etype]) forceCount[etype] = { friendly: 0, hostile: 0, neutral: 0 };

            var eteam = ent.team || 'neutral';
            if (eteam === playerTeam) {
                forceCount[etype].friendly++;
            } else if (eteam === 'neutral' || eteam === 'civilian') {
                forceCount[etype].neutral++;
            } else {
                forceCount[etype].hostile++;
            }
        }

        var forceBody = document.getElementById('mbForceBody');
        if (forceBody) {
            var html = '';
            var totalFriendly = 0, totalHostile = 0, totalNeutral = 0;
            for (var ti = 0; ti < typeOrder.length; ti++) {
                var tkey = typeOrder[ti];
                var fc = forceCount[tkey];
                if (!fc) continue;
                if (fc.friendly === 0 && fc.hostile === 0 && fc.neutral === 0) continue;
                totalFriendly += fc.friendly;
                totalHostile += fc.hostile;
                totalNeutral += fc.neutral;
                html += '<tr>' +
                    '<td class="type-label">' + typeLabels[tkey] + '</td>' +
                    '<td class="count-cell team-friendly">' + (fc.friendly > 0 ? fc.friendly : '-') + '</td>' +
                    '<td class="count-cell team-hostile">' + (fc.hostile > 0 ? fc.hostile : '-') + '</td>' +
                    '<td class="count-cell team-neutral">' + (fc.neutral > 0 ? fc.neutral : '-') + '</td>' +
                    '</tr>';
            }
            html += '<tr style="border-top:1px solid #335500;font-weight:bold">' +
                '<td class="type-label">TOTAL</td>' +
                '<td class="count-cell team-friendly">' + totalFriendly + '</td>' +
                '<td class="count-cell team-hostile">' + totalHostile + '</td>' +
                '<td class="count-cell team-neutral">' + (totalNeutral > 0 ? totalNeutral : '-') + '</td>' +
                '</tr>';
            forceBody.innerHTML = html;
        }

        // --- Environment ---
        var envGrid = document.getElementById('mbEnvGrid');
        if (envGrid) {
            var env = scenario.environment || {};
            var envHtml = '';

            var atmo = env.atmosphere || 'standard';
            envHtml += '<div class="mb-env-label">Atmosphere</div><div class="mb-env-value">' +
                atmo.replace(/_/g, ' ').toUpperCase() + '</div>';

            if (env.weather) {
                var wx = env.weather;
                var wxStr = '';
                if (typeof wx === 'string') {
                    wxStr = wx.toUpperCase();
                } else if (wx.preset) {
                    wxStr = wx.preset.toUpperCase();
                    if (wx.windSpeed) wxStr += ' / WIND ' + wx.windSpeed + ' m/s';
                    if (wx.visibility) wxStr += ' / VIS ' + wx.visibility + 'm';
                } else {
                    wxStr = 'CLEAR';
                }
                envHtml += '<div class="mb-env-label">Weather</div><div class="mb-env-value">' + wxStr + '</div>';
            }

            if (env.simStartTime) {
                try {
                    var dt = new Date(env.simStartTime);
                    var hours = dt.getUTCHours();
                    var tod = 'NIGHT';
                    if (hours >= 6 && hours < 12) tod = 'MORNING';
                    else if (hours >= 12 && hours < 18) tod = 'AFTERNOON';
                    else if (hours >= 18 && hours < 21) tod = 'EVENING';
                    envHtml += '<div class="mb-env-label">Time (UTC)</div><div class="mb-env-value">' +
                        dt.toISOString().replace('T', ' ').replace(/\.\d+Z/, 'Z') + ' (' + tod + ')</div>';
                } catch(e) {}
            }

            if (env.gravity) {
                envHtml += '<div class="mb-env-label">Gravity Model</div><div class="mb-env-value">' +
                    (env.gravity || 'constant').toUpperCase() + '</div>';
            }

            if (env.maxTimeWarp) {
                envHtml += '<div class="mb-env-label">Max Time Warp</div><div class="mb-env-value">' +
                    env.maxTimeWarp + 'x</div>';
            }

            envGrid.innerHTML = envHtml;
        }

        // --- Mission objectives (from player quest) ---
        var objSection = document.getElementById('mbObjectiveSection');
        var objDiv = document.getElementById('mbObjective');
        if (objSection && objDiv) {
            var questDef = null;
            if (_playerEntity && _playerDef && _playerDef._quest) {
                questDef = _playerDef._quest;
            } else {
                for (var qi = 0; qi < entities.length; qi++) {
                    if (entities[qi].id === (_playerEntity ? _playerEntity.id : null)) {
                        if (entities[qi]._quest) questDef = entities[qi]._quest;
                        break;
                    }
                }
            }

            if (questDef) {
                objSection.style.display = 'block';
                var objHtml = '';
                if (questDef.initialMsg) {
                    objHtml += '<div class="mb-objective-title">Primary Objective</div>';
                    objHtml += '<div>' + questDef.initialMsg + '</div>';
                }
                if (questDef.initialHint) {
                    objHtml += '<div style="color:#aa8800;font-size:11px;margin-top:4px">' + questDef.initialHint + '</div>';
                }
                if (questDef.waypoints && questDef.waypoints.length > 0) {
                    objHtml += '<div style="color:#007744;font-size:10px;margin-top:6px">' +
                        questDef.waypoints.length + ' waypoint(s) | Mode: ' +
                        (questDef.mode || 'takeoff').toUpperCase() + '</div>';
                }
                objDiv.innerHTML = objHtml;
            } else {
                objSection.style.display = 'none';
            }
        }

        // --- Key controls ---
        var ctrlDiv = document.getElementById('mbControls');
        if (ctrlDiv) {
            var controls = [
                ['W / S', 'Throttle Up / Down'],
                ['Arrow Keys', 'Pitch / Roll'],
                ['Q / E', 'Yaw'],
                ['P', 'Engine Selection'],
                ['Space', 'Fire Weapon'],
                ['R', 'Cycle Weapon'],
                ['V', 'Cycle Sensor'],
                ['C', 'Cycle Camera'],
                ['M', 'Maneuver Planner'],
                ['I', 'Pointing Mode'],
                ['Esc', 'Pause / Resume'],
                ['+/-', 'Time Warp'],
                ['F', 'Search Panel'],
                ['H', 'Controls Help'],
                ['Tab', 'Toggle All UI'],
                ['1/2/3', 'Panel Toggles']
            ];
            var ctrlHtml = '';
            for (var ci = 0; ci < controls.length; ci++) {
                ctrlHtml += '<div><span class="mb-ctrl-key">' + controls[ci][0] +
                    '</span> <span class="mb-ctrl-desc">' + controls[ci][1] + '</span></div>';
            }
            ctrlDiv.innerHTML = ctrlHtml;
        }

        // --- Player info ---
        var playerInfo = document.getElementById('mbPlayerInfo');
        if (playerInfo && _playerEntity) {
            playerInfo.textContent = 'Controlling: ' + _playerEntity.name +
                ' (' + (_playerEntity.type || 'unknown') + ') | Team: ' +
                (_playerEntity.team || 'none').toUpperCase();
        }

        // --- Pause sim and show ---
        _isPaused = true;
        panel.style.display = 'flex';

        // Return promise that resolves when BEGIN MISSION is clicked
        return new Promise(function(resolve) {
            var btn = document.getElementById('mbBeginBtn');
            if (!btn) { resolve(); return; }

            function handleBegin() {
                btn.removeEventListener('click', handleBegin);
                panel.style.display = 'none';
                _isPaused = false;
                _lastTickTime = null;
                resolve();
            }

            btn.addEventListener('click', handleBegin);
        });
    }

    function showUI() {
        var btn = document.getElementById('settingsBtn');
        if (btn) btn.style.display = 'flex';
        _applyPanelVisibility();
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function _setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function _setTextWithClass(id, text, cls) {
        var el = document.getElementById(id);
        if (el) {
            el.textContent = text;
            el.className = 'data-value' + (cls ? ' ' + cls : '');
        }
    }

    function _setDisplay(id, visible) {
        var el = document.getElementById(id);
        if (el) el.style.display = visible ? 'block' : 'none';
    }

    var _msgTimeout = null;
    function _showMessage(text, duration) {
        var el = document.getElementById('msgOverlay');
        if (!el) return;
        el.textContent = text;
        el.style.opacity = '1';
        if (_msgTimeout) clearTimeout(_msgTimeout);
        _msgTimeout = setTimeout(function() {
            el.style.opacity = '0';
        }, duration || 1500);
    }

    function _formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '---';
        if (seconds > 86400) return (seconds / 86400).toFixed(1) + 'd';
        if (seconds > 3600) return (seconds / 3600).toFixed(1) + 'h';
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return m + ':' + s.toString().padStart(2, '0');
    }

    // -----------------------------------------------------------------------
    // Smart Search
    // -----------------------------------------------------------------------

    var R_EARTH_SEARCH = 6371000;

    function _classifyRegime(orbital) {
        if (!orbital || !orbital.sma) return 'OTHER';
        var altKm = (orbital.sma - R_EARTH_SEARCH) / 1000;
        if (orbital.ecc > 0.25) return 'HEO';
        if (altKm < 2000) return 'LEO';
        if (altKm < 35000) return 'MEO';
        if (altKm <= 37000) return 'GEO';
        return 'OTHER';
    }

    function _searchEntities(criteria) {
        var matched = new Set();
        if (!_world) return matched;

        _world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var state = entity.state;

            // Name filter
            if (criteria.name && criteria.name.length > 0) {
                if (entity.name.toUpperCase().indexOf(criteria.name.toUpperCase()) === -1) return;
            }

            // Team filter
            if (criteria.team && entity.team !== criteria.team) return;

            var orbital = state._orbital;

            // Regime filter
            if (criteria.regime && criteria.regime !== 'ALL') {
                var regime = _classifyRegime(orbital);
                if (regime !== criteria.regime) return;
            }

            // Inclination range
            if (criteria.incMin != null || criteria.incMax != null) {
                var inc = orbital ? orbital.inc * (180 / Math.PI) : null;
                if (inc == null) return;
                if (criteria.incMin != null && inc < criteria.incMin) return;
                if (criteria.incMax != null && inc > criteria.incMax) return;
            }

            // SMA range (input in km, orbital.sma in meters)
            if (criteria.smaMinKm != null || criteria.smaMaxKm != null) {
                var smaKm = orbital ? orbital.sma / 1000 : null;
                if (smaKm == null) return;
                if (criteria.smaMinKm != null && smaKm < criteria.smaMinKm) return;
                if (criteria.smaMaxKm != null && smaKm > criteria.smaMaxKm) return;
            }

            matched.add(entity.id);
        });
        return matched;
    }

    function _highlightSearchResults(matchedIds) {
        _searchMatchedIds = matchedIds;
        if (!_world) return;

        _world.entities.forEach(function(entity) {
            entity.state._searchHighlight = matchedIds.has(entity.id);
        });
    }

    function _clearSearch() {
        _searchMatchedIds = new Set();
        if (_world) {
            _world.entities.forEach(function(entity) {
                entity.state._searchHighlight = false;
            });
        }
        // Reset UI
        var nameInput = document.getElementById('searchName');
        if (nameInput) nameInput.value = '';
        var teamSelect = document.getElementById('searchTeam');
        if (teamSelect) teamSelect.value = '';
        var incMin = document.getElementById('searchIncMin');
        if (incMin) incMin.value = '';
        var incMax = document.getElementById('searchIncMax');
        if (incMax) incMax.value = '';
        var smaMin = document.getElementById('searchSmaMin');
        if (smaMin) smaMin.value = '';
        var smaMax = document.getElementById('searchSmaMax');
        if (smaMax) smaMax.value = '';
        // Reset regime buttons
        var regBtns = document.querySelectorAll('.srch-regime');
        regBtns.forEach(function(btn) {
            btn.classList.toggle('active', btn.getAttribute('data-regime') === 'ALL');
            btn.style.background = btn.getAttribute('data-regime') === 'ALL' ? '#1a3a5a' : '#0d1a2a';
        });
        _updateSearchResults();
    }

    function _runSearch() {
        var criteria = {};
        var nameInput = document.getElementById('searchName');
        if (nameInput && nameInput.value.trim()) criteria.name = nameInput.value.trim();

        var teamSelect = document.getElementById('searchTeam');
        if (teamSelect && teamSelect.value) criteria.team = teamSelect.value;

        // Regime from active button
        var activeRegime = document.querySelector('.srch-regime.active');
        if (activeRegime) criteria.regime = activeRegime.getAttribute('data-regime');

        var incMinEl = document.getElementById('searchIncMin');
        if (incMinEl && incMinEl.value !== '') criteria.incMin = parseFloat(incMinEl.value);
        var incMaxEl = document.getElementById('searchIncMax');
        if (incMaxEl && incMaxEl.value !== '') criteria.incMax = parseFloat(incMaxEl.value);

        var smaMinEl = document.getElementById('searchSmaMin');
        if (smaMinEl && smaMinEl.value !== '') criteria.smaMinKm = parseFloat(smaMinEl.value);
        var smaMaxEl = document.getElementById('searchSmaMax');
        if (smaMaxEl && smaMaxEl.value !== '') criteria.smaMaxKm = parseFloat(smaMaxEl.value);

        // Check if any criteria specified
        var hasCriteria = criteria.name || criteria.team || (criteria.regime && criteria.regime !== 'ALL') ||
            criteria.incMin != null || criteria.incMax != null || criteria.smaMinKm != null || criteria.smaMaxKm != null;

        if (!hasCriteria) {
            _clearSearch();
            return;
        }

        var matched = _searchEntities(criteria);
        _highlightSearchResults(matched);
        _updateSearchResults();
    }

    function _updateSearchResults() {
        var el = document.getElementById('searchResults');
        if (!el) return;
        var total = _world ? _world.entities.size : 0;
        var matched = _searchMatchedIds.size;
        if (matched > 0) {
            el.style.color = '#44ff88';
            el.textContent = matched + ' / ' + total + ' entities matched';
        } else {
            el.style.color = '#4a9eff';
            el.textContent = 'No search active';
        }
    }

    function _applyBulkAction(action, value) {
        if (_searchMatchedIds.size === 0) return;
        if (!_world) return;

        _searchMatchedIds.forEach(function(id) {
            var entity = _world.getEntity(id);
            if (!entity) return;

            if (action === 'setTeam') {
                entity.team = value;
            } else if (action === 'setColor') {
                // Update visual component color
                var vis = entity.getComponent('visual');
                if (vis && vis.config) vis.config.color = value;
                // Update point entity color directly if possible
                if (vis && vis._pointEntity && vis._pointEntity.point) {
                    try { vis._pointEntity.point.color = Cesium.Color.fromCssColorString(value); } catch(e) {}
                }
                if (vis && vis._cesiumEntity && vis._cesiumEntity.point) {
                    try { vis._cesiumEntity.point.color = Cesium.Color.fromCssColorString(value); } catch(e) {}
                }
            } else if (action === 'orbitsOn') {
                entity.state._vizOrbits = true;
            } else if (action === 'orbitsOff') {
                entity.state._vizOrbits = false;
            } else if (action === 'labelsOn') {
                entity.state._vizLabels = true;
            } else if (action === 'labelsOff') {
                entity.state._vizLabels = false;
            }
        });
    }

    function _toggleSearchPanel() {
        var panel = document.getElementById('searchPanel');
        if (!panel) return;
        _searchPanelOpen = !_searchPanelOpen;
        panel.style.display = _searchPanelOpen ? '' : 'none';
        if (!_searchPanelOpen) {
            // Don't clear search on close — keep highlights
        }
    }

    function _initSearchPanel() {
        // Search input — debounced
        var searchTimeout = null;
        var nameInput = document.getElementById('searchName');
        if (nameInput) {
            nameInput.addEventListener('input', function() {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(_runSearch, 200);
            });
        }

        // Team select
        var teamSelect = document.getElementById('searchTeam');
        if (teamSelect) teamSelect.addEventListener('change', _runSearch);

        // Regime buttons
        var regBtns = document.querySelectorAll('.srch-regime');
        regBtns.forEach(function(btn) {
            btn.addEventListener('click', function() {
                regBtns.forEach(function(b) {
                    b.classList.remove('active');
                    b.style.background = '#0d1a2a';
                });
                btn.classList.add('active');
                btn.style.background = '#1a3a5a';
                _runSearch();
            });
        });

        // Inc/SMA range inputs
        ['searchIncMin', 'searchIncMax', 'searchSmaMin', 'searchSmaMax'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', _runSearch);
        });

        // Bulk actions
        var bulkTeam = document.getElementById('bulkTeam');
        if (bulkTeam) {
            bulkTeam.addEventListener('change', function() {
                if (bulkTeam.value) {
                    _applyBulkAction('setTeam', bulkTeam.value);
                    bulkTeam.value = '';
                }
            });
        }

        var bulkColor = document.getElementById('bulkColor');
        if (bulkColor) {
            bulkColor.addEventListener('input', function() {
                _applyBulkAction('setColor', bulkColor.value);
            });
        }

        var bulkOrbitsOn = document.getElementById('bulkOrbitsOn');
        if (bulkOrbitsOn) bulkOrbitsOn.addEventListener('click', function() { _applyBulkAction('orbitsOn'); });
        var bulkOrbitsOff = document.getElementById('bulkOrbitsOff');
        if (bulkOrbitsOff) bulkOrbitsOff.addEventListener('click', function() { _applyBulkAction('orbitsOff'); });
        var bulkLabelsOn = document.getElementById('bulkLabelsOn');
        if (bulkLabelsOn) bulkLabelsOn.addEventListener('click', function() { _applyBulkAction('labelsOn'); });
        var bulkLabelsOff = document.getElementById('bulkLabelsOff');
        if (bulkLabelsOff) bulkLabelsOff.addEventListener('click', function() { _applyBulkAction('labelsOff'); });

        // Clear & close
        var searchClear = document.getElementById('searchClear');
        if (searchClear) searchClear.addEventListener('click', _clearSearch);
        var searchClose = document.getElementById('searchClose');
        if (searchClose) searchClose.addEventListener('click', _toggleSearchPanel);
    }

    // -----------------------------------------------------------------------
    // Data Analytics
    // -----------------------------------------------------------------------

    function _recordAnalyticsSnapshot() {
        _analyticsRecordCounter++;
        if (_analyticsRecordCounter % 60 !== 0) return; // ~1Hz at 60fps
        if (!_world) return;

        var alive = 0, dead = 0, hasFuel = 0;
        var regimes = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };
        var teams = {};
        var types = {};
        var totalAlt = 0, altCount = 0;
        var totalSpeed = 0, speedCount = 0;

        _world.entities.forEach(function(entity) {
            if (entity.active) {
                alive++;
                if (entity.state.fuel > 0) hasFuel++;

                var team = entity.team || 'neutral';
                teams[team] = (teams[team] || 0) + 1;

                var type = entity.type || 'unknown';
                types[type] = (types[type] || 0) + 1;

                var orbital = entity.state._orbital;
                if (orbital) {
                    var regime = _classifyRegime(orbital);
                    regimes[regime]++;
                }

                if (entity.state.alt != null) {
                    totalAlt += entity.state.alt;
                    altCount++;
                }
                if (entity.state.speed != null) {
                    totalSpeed += entity.state.speed;
                    speedCount++;
                }
            } else {
                dead++;
            }
        });

        // Comm metrics
        var commMetrics = null;
        if (typeof CommEngine !== 'undefined' && CommEngine.isInitialized()) {
            commMetrics = CommEngine.getMetrics();
        }

        _analyticsHistory.push({
            t: _simElapsed,
            alive: alive,
            dead: dead,
            hasFuel: hasFuel,
            regimes: regimes,
            teams: Object.assign({}, teams),
            types: Object.assign({}, types),
            avgAlt: altCount > 0 ? totalAlt / altCount / 1000 : 0,  // km
            avgSpeed: speedCount > 0 ? totalSpeed / speedCount : 0,
            leo: regimes.LEO,
            meo: regimes.MEO,
            geo: regimes.GEO,
            heo: regimes.HEO,
            commDeliveryRate: commMetrics ? (commMetrics.packetDeliveryRate * 100) : 0,
            commAvgLatency: commMetrics ? commMetrics.avgLatency_ms : 0,
            commActiveLinks: commMetrics ? commMetrics.activeLinks : 0,
            commTotalLinks: commMetrics ? commMetrics.totalLinks : 0,
            commPacketsInFlight: commMetrics ? commMetrics.packetsInFlight : 0,
            commJammers: commMetrics ? commMetrics.activeJammers : 0,
            commCyberAttacks: commMetrics ? commMetrics.activeCyberAttacks : 0,
            commActiveNodes: commMetrics ? commMetrics.activeNodes : 0,
            commTotalNodes: commMetrics ? commMetrics.totalNodes : 0,
            commNetworks: commMetrics ? commMetrics.networks : null
        });

        // Cap history at 3600 entries (1 hour at 1Hz)
        if (_analyticsHistory.length > 3600) {
            _analyticsHistory = _analyticsHistory.slice(-3600);
        }
    }

    function _destroyAnalyticsCharts() {
        for (var key in _analyticsCharts) {
            if (_analyticsCharts[key]) {
                _analyticsCharts[key].destroy();
            }
        }
        _analyticsCharts = {};
    }

    function _renderAnalyticsTemplate(template) {
        var container = document.getElementById('analyticsContent');
        if (!container) return;

        _destroyAnalyticsCharts();
        container.innerHTML = '';

        var customRow = document.getElementById('analyticsCustomRow');
        if (customRow) customRow.style.display = template === 'custom' ? '' : 'none';

        if (typeof Chart === 'undefined') {
            container.innerHTML = '<div style="color:#ff4444;padding:10px">Chart.js not loaded</div>';
            return;
        }

        switch (template) {
            case 'overview':
                _renderOverviewCharts(container);
                break;
            case 'regime':
                _renderRegimeChart(container);
                break;
            case 'population':
                _renderPopulationChart(container);
                break;
            case 'teams':
                _renderTeamChart(container);
                break;
            case 'fuel':
                _renderFuelChart(container);
                break;
            case 'comms':
                _renderCommsCharts(container);
                break;
            case 'custom':
                _renderCustomChart(container);
                break;
        }
    }

    function _createChartCanvas(container, id, height) {
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom:10px;height:' + (height || 180) + 'px;position:relative';
        var canvas = document.createElement('canvas');
        canvas.id = id;
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);
        return canvas;
    }

    function _chartDefaults() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: '#a0b8d0', font: { family: 'monospace', size: 10 } }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#666', font: { size: 9 } },
                    grid: { color: 'rgba(42,74,106,0.3)' }
                },
                y: {
                    ticks: { color: '#666', font: { size: 9 } },
                    grid: { color: 'rgba(42,74,106,0.3)' }
                }
            }
        };
    }

    function _getLatestSnapshot() {
        return _analyticsHistory.length > 0 ? _analyticsHistory[_analyticsHistory.length - 1] : null;
    }

    function _renderOverviewCharts(container) {
        // Regime pie + Team bar side by side
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;margin-bottom:10px';
        container.appendChild(row);

        // Regime pie
        var pieWrap = document.createElement('div');
        pieWrap.style.cssText = 'flex:1;height:160px;position:relative';
        var pieCanvas = document.createElement('canvas');
        pieCanvas.id = 'chartRegimePie';
        pieWrap.appendChild(pieCanvas);
        row.appendChild(pieWrap);

        // Team bar
        var barWrap = document.createElement('div');
        barWrap.style.cssText = 'flex:1;height:160px;position:relative';
        var barCanvas = document.createElement('canvas');
        barCanvas.id = 'chartTeamBar';
        barWrap.appendChild(barCanvas);
        row.appendChild(barWrap);

        var snap = _getLatestSnapshot();
        var regimes = snap ? snap.regimes : { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };
        var teams = snap ? snap.teams : {};

        _analyticsCharts.regimePie = new Chart(pieCanvas, {
            type: 'doughnut',
            data: {
                labels: ['LEO', 'MEO', 'GEO', 'HEO', 'Other'],
                datasets: [{
                    data: [regimes.LEO, regimes.MEO, regimes.GEO, regimes.HEO, regimes.OTHER],
                    backgroundColor: ['#44ccff', '#44ff88', '#ffcc44', '#ff6688', '#aa88ff']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#a0b8d0', font: { family: 'monospace', size: 9 }, padding: 6 } },
                    title: { display: true, text: 'Orbit Regimes', color: '#6ac', font: { family: 'monospace', size: 10 } }
                }
            }
        });

        var teamLabels = Object.keys(teams);
        var teamColors = teamLabels.map(function(t) {
            return t === 'blue' ? '#4488ff' : t === 'red' ? '#ff4444' : t === 'green' ? '#44ff44' : '#888888';
        });

        _analyticsCharts.teamBar = new Chart(barCanvas, {
            type: 'bar',
            data: {
                labels: teamLabels.length > 0 ? teamLabels : ['none'],
                datasets: [{
                    label: 'Entities',
                    data: teamLabels.length > 0 ? teamLabels.map(function(t) { return teams[t]; }) : [0],
                    backgroundColor: teamLabels.length > 0 ? teamColors : ['#888']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: { display: true, text: 'Teams', color: '#6ac', font: { family: 'monospace', size: 10 } }
                },
                scales: {
                    x: { ticks: { color: '#a0b8d0', font: { size: 9 } }, grid: { display: false } },
                    y: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: 'rgba(42,74,106,0.3)' } }
                }
            }
        });

        // Type distribution
        var types = snap ? snap.types : {};
        var typeLabels = Object.keys(types);
        if (typeLabels.length > 0) {
            var typeCanvas = _createChartCanvas(container, 'chartTypeBar', 120);
            _analyticsCharts.typeBar = new Chart(typeCanvas, {
                type: 'bar',
                data: {
                    labels: typeLabels,
                    datasets: [{
                        label: 'Count',
                        data: typeLabels.map(function(t) { return types[t]; }),
                        backgroundColor: '#4a9eff'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: 'y',
                    plugins: {
                        legend: { display: false },
                        title: { display: true, text: 'Entity Types', color: '#6ac', font: { family: 'monospace', size: 10 } }
                    },
                    scales: {
                        x: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: 'rgba(42,74,106,0.3)' } },
                        y: { ticks: { color: '#a0b8d0', font: { size: 9 } }, grid: { display: false } }
                    }
                }
            });
        }

        // Summary text
        var summaryDiv = document.createElement('div');
        summaryDiv.style.cssText = 'padding:6px;background:#0a1520;border-radius:3px;font-size:10px';
        var total = _world ? _world.entities.size : 0;
        summaryDiv.innerHTML = '<span style="color:#44ff88">Alive: ' + (snap ? snap.alive : 0) + '</span>' +
            ' &middot; <span style="color:#ff4444">Dead: ' + (snap ? snap.dead : 0) + '</span>' +
            ' &middot; <span style="color:#ffcc44">Fuel: ' + (snap ? snap.hasFuel : 0) + '</span>' +
            ' &middot; Total: ' + total;
        container.appendChild(summaryDiv);
    }

    function _renderRegimeChart(container) {
        var snap = _getLatestSnapshot();
        var regimes = snap ? snap.regimes : { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };

        var canvas = _createChartCanvas(container, 'chartRegimeFull', 220);
        _analyticsCharts.regimeFull = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: ['LEO', 'MEO', 'GEO', 'HEO', 'Other'],
                datasets: [{
                    data: [regimes.LEO, regimes.MEO, regimes.GEO, regimes.HEO, regimes.OTHER],
                    backgroundColor: ['#44ccff', '#44ff88', '#ffcc44', '#ff6688', '#aa88ff']
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#a0b8d0', font: { family: 'monospace', size: 10 }, padding: 10 } },
                    title: { display: true, text: 'Orbit Regime Distribution', color: '#4a9eff', font: { family: 'monospace', size: 12 } }
                }
            }
        });

        // Detail counts
        var detailDiv = document.createElement('div');
        detailDiv.style.cssText = 'padding:8px;background:#0a1520;border-radius:3px;font-size:10px;margin-top:8px';
        var total = regimes.LEO + regimes.MEO + regimes.GEO + regimes.HEO + regimes.OTHER;
        function pct(n) { return total > 0 ? ' (' + (n / total * 100).toFixed(1) + '%)' : ''; }
        detailDiv.innerHTML =
            '<div><span style="color:#44ccff">LEO:</span> ' + regimes.LEO + pct(regimes.LEO) + '</div>' +
            '<div><span style="color:#44ff88">MEO:</span> ' + regimes.MEO + pct(regimes.MEO) + '</div>' +
            '<div><span style="color:#ffcc44">GEO:</span> ' + regimes.GEO + pct(regimes.GEO) + '</div>' +
            '<div><span style="color:#ff6688">HEO:</span> ' + regimes.HEO + pct(regimes.HEO) + '</div>' +
            '<div><span style="color:#aa88ff">Other:</span> ' + regimes.OTHER + pct(regimes.OTHER) + '</div>';
        container.appendChild(detailDiv);
    }

    function _renderTimeSeriesChart(container, id, title, fields, colors, height) {
        if (_analyticsHistory.length < 2) {
            container.innerHTML += '<div style="color:#666;padding:10px;text-align:center">Collecting data... (' + _analyticsHistory.length + ' samples)</div>';
            return;
        }

        var canvas = _createChartCanvas(container, id, height || 200);
        var times = _analyticsHistory.map(function(s) {
            var t = s.t;
            if (t >= 3600) return (t / 3600).toFixed(1) + 'h';
            if (t >= 60) return Math.floor(t / 60) + 'm';
            return Math.floor(t) + 's';
        });

        var datasets = fields.map(function(f, i) {
            return {
                label: f.label || f.key,
                data: _analyticsHistory.map(function(s) { return s[f.key] || 0; }),
                borderColor: colors[i] || '#4a9eff',
                backgroundColor: (colors[i] || '#4a9eff') + '20',
                fill: f.fill !== false,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5
            };
        });

        _analyticsCharts[id] = new Chart(canvas, {
            type: 'line',
            data: { labels: times, datasets: datasets },
            options: Object.assign(_chartDefaults(), {
                plugins: {
                    legend: { labels: { color: '#a0b8d0', font: { family: 'monospace', size: 9 } } },
                    title: { display: true, text: title, color: '#4a9eff', font: { family: 'monospace', size: 11 } }
                }
            })
        });
    }

    function _renderPopulationChart(container) {
        _renderTimeSeriesChart(container, 'chartPopulation', 'Population Over Time',
            [{ key: 'alive', label: 'Alive' }, { key: 'dead', label: 'Dead' }],
            ['#44ff88', '#ff4444'], 220);
    }

    function _renderTeamChart(container) {
        if (_analyticsHistory.length < 2) {
            container.innerHTML = '<div style="color:#666;padding:10px;text-align:center">Collecting data...</div>';
            return;
        }

        // Get all team names from history
        var allTeams = {};
        _analyticsHistory.forEach(function(s) {
            for (var t in s.teams) allTeams[t] = true;
        });
        var teamNames = Object.keys(allTeams);
        var teamColorMap = { blue: '#4488ff', red: '#ff4444', green: '#44ff44', neutral: '#888888' };

        var canvas = _createChartCanvas(container, 'chartTeams', 220);
        var times = _analyticsHistory.map(function(s) {
            var t = s.t;
            if (t >= 3600) return (t / 3600).toFixed(1) + 'h';
            if (t >= 60) return Math.floor(t / 60) + 'm';
            return Math.floor(t) + 's';
        });

        var datasets = teamNames.map(function(team) {
            return {
                label: team,
                data: _analyticsHistory.map(function(s) { return (s.teams && s.teams[team]) || 0; }),
                borderColor: teamColorMap[team] || '#aa88ff',
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5,
                fill: false
            };
        });

        _analyticsCharts.teams = new Chart(canvas, {
            type: 'line',
            data: { labels: times, datasets: datasets },
            options: Object.assign(_chartDefaults(), {
                plugins: {
                    legend: { labels: { color: '#a0b8d0', font: { family: 'monospace', size: 9 } } },
                    title: { display: true, text: 'Team Balance Over Time', color: '#4a9eff', font: { family: 'monospace', size: 11 } }
                }
            })
        });
    }

    function _renderFuelChart(container) {
        _renderTimeSeriesChart(container, 'chartFuel', 'Fuel Status Over Time',
            [{ key: 'hasFuel', label: 'With Fuel' }, { key: 'alive', label: 'Total Alive' }],
            ['#ffcc44', '#44ff8840'], 220);
    }

    function _renderCommsCharts(container) {
        if (typeof CommEngine === 'undefined' || !CommEngine.isInitialized()) {
            container.innerHTML = '<div style="color:#666;padding:10px;text-align:center">No comm networks active</div>';
            return;
        }

        var metrics = CommEngine.getMetrics();

        // --- Current status summary ---
        var statusDiv = document.createElement('div');
        statusDiv.style.cssText = 'padding:8px;background:#0a1520;border-radius:3px;margin-bottom:10px;font-size:10px';
        var delivPct = (metrics.packetDeliveryRate * 100).toFixed(1);
        var delivColor = metrics.packetDeliveryRate > 0.9 ? '#44ff88' : metrics.packetDeliveryRate > 0.5 ? '#ffcc44' : '#ff4444';
        statusDiv.innerHTML =
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:#557">DELIVERY RATE</span><span style="color:' + delivColor + '">' + delivPct + '%</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:#557">AVG LATENCY</span><span style="color:#ccc">' + metrics.avgLatency_ms.toFixed(0) + ' ms</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:#557">LINKS</span><span style="color:#ccc">' + metrics.activeLinks + ' / ' + metrics.totalLinks + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:#557">NODES</span><span style="color:#ccc">' + metrics.activeNodes + ' / ' + metrics.totalNodes + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:3px"><span style="color:#557">PACKETS</span><span style="color:#ccc">' + metrics.packetsInFlight + ' in-flight, ' + metrics.totalPacketsDelivered + ' delivered</span></div>';

        if (metrics.activeJammers > 0) {
            statusDiv.innerHTML += '<div style="display:flex;justify-content:space-between"><span style="color:#557">JAMMERS</span><span style="color:#ff8800">' + metrics.activeJammers + ' active</span></div>';
        }
        if (metrics.activeCyberAttacks > 0) {
            statusDiv.innerHTML += '<div style="display:flex;justify-content:space-between"><span style="color:#557">CYBER</span><span style="color:#ff00ff">' + metrics.activeCyberAttacks + ' attacks</span></div>';
        }
        container.appendChild(statusDiv);

        // --- Network health bars ---
        if (metrics.networks && metrics.networks.length > 0) {
            var netDiv = document.createElement('div');
            netDiv.style.cssText = 'padding:6px;background:#0a1520;border-radius:3px;margin-bottom:10px;font-size:10px';
            var netHtml = '<div style="color:#00ccaa;font-weight:bold;margin-bottom:4px">NETWORKS</div>';
            for (var ni = 0; ni < metrics.networks.length; ni++) {
                var net = metrics.networks[ni];
                var health = typeof net.health === 'number' ? net.health
                    : net.totalLinks > 0 ? net.aliveLinks / net.totalLinks : 0;
                if (net.jammedLinks > 0 && health > 0.5) health = Math.max(0.3, health - 0.2);
                var hColor = health > 0.7 ? '#44ff88' : health > 0.3 ? '#ffcc44' : '#ff4444';
                var barW = Math.max(2, health * 100);
                netHtml += '<div style="margin-bottom:4px">';
                netHtml += '<div style="display:flex;justify-content:space-between"><span style="color:#a0b8d0">' + (net.name || net.id) + '</span><span style="color:' + hColor + '">' + (health * 100).toFixed(0) + '%</span></div>';
                netHtml += '<div style="height:4px;background:#1a2a40;border-radius:2px;margin-top:2px"><div style="width:' + barW + '%;height:100%;background:' + hColor + ';border-radius:2px"></div></div>';
                netHtml += '</div>';
            }
            netDiv.innerHTML = netHtml;
            container.appendChild(netDiv);
        }

        // --- Time series: delivery rate + latency ---
        if (_analyticsHistory.length >= 2) {
            _renderTimeSeriesChart(container, 'chartCommDelivery', 'Packet Delivery Rate (%)',
                [{ key: 'commDeliveryRate', label: 'Delivery %' }],
                ['#44ff88'], 160);

            _renderTimeSeriesChart(container, 'chartCommLatency', 'Avg Comm Latency (ms)',
                [{ key: 'commAvgLatency', label: 'Latency (ms)', fill: false }],
                ['#ffcc44'], 140);

            // Link health + threat indicators
            _renderTimeSeriesChart(container, 'chartCommLinks', 'Link Health & Threats',
                [
                    { key: 'commActiveLinks', label: 'Active Links', fill: false },
                    { key: 'commJammers', label: 'Jammers', fill: false },
                    { key: 'commCyberAttacks', label: 'Cyber Attacks', fill: false }
                ],
                ['#00ccaa', '#ff8800', '#ff00ff'], 160);
        } else {
            container.innerHTML += '<div style="color:#666;padding:10px;text-align:center">Collecting comm data... (' + _analyticsHistory.length + ' samples)</div>';
        }
    }

    function _renderCustomChart(container) {
        var varSelect = document.getElementById('analyticsCustomVar');
        var varKey = varSelect ? varSelect.value : 'alive';
        var varLabel = varSelect ? varSelect.options[varSelect.selectedIndex].text : 'Alive Count';

        _renderTimeSeriesChart(container, 'chartCustom', varLabel + ' Over Time',
            [{ key: varKey, label: varLabel }],
            ['#4a9eff'], 220);
    }

    function _toggleAnalyticsPanel() {
        var panel = document.getElementById('analyticsPanel');
        if (!panel) return;
        _analyticsPanelOpen = !_analyticsPanelOpen;
        panel.style.display = _analyticsPanelOpen ? '' : 'none';
        if (_analyticsPanelOpen) {
            var sel = document.getElementById('analyticsTemplate');
            _renderAnalyticsTemplate(sel ? sel.value : 'overview');
        } else {
            _destroyAnalyticsCharts();
        }
    }

    function _refreshAnalyticsIfOpen() {
        if (!_analyticsPanelOpen) return;
        // Refresh every 5 seconds (300 frames at 60fps)
        if (_analyticsRecordCounter % 300 !== 0) return;
        var sel = document.getElementById('analyticsTemplate');
        _renderAnalyticsTemplate(sel ? sel.value : 'overview');
    }

    function _initAnalyticsPanel() {
        var templateSel = document.getElementById('analyticsTemplate');
        if (templateSel) {
            templateSel.addEventListener('change', function() {
                _renderAnalyticsTemplate(templateSel.value);
            });
        }

        var customVar = document.getElementById('analyticsCustomVar');
        if (customVar) {
            customVar.addEventListener('change', function() {
                if (_analyticsPanelOpen) {
                    var sel = document.getElementById('analyticsTemplate');
                    if (sel && sel.value === 'custom') {
                        _renderAnalyticsTemplate('custom');
                    }
                }
            });
        }

        var closeBtn = document.getElementById('analyticsClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleAnalyticsPanel);

        // CSV/JSON export buttons in analytics panel
        var csvBtn = document.getElementById('analyticsExportCSV');
        if (csvBtn) csvBtn.addEventListener('click', function() { _exportAnalyticsCSV(); });
        var jsonBtn = document.getElementById('analyticsExportJSON');
        if (jsonBtn) jsonBtn.addEventListener('click', function() { _exportEntityStatesJSON(); });
    }

    // -----------------------------------------------------------------------
    // Engagement Log — records all weapon events across the sim
    // -----------------------------------------------------------------------
    let _engagementLog = [];
    let _engLastScanTime = 0;

    function _tickEngagementLog() {
        if (!_world) return;
        var now = _simElapsed;
        if (now - _engLastScanTime < 0.5) return; // 2Hz scan
        _engLastScanTime = now;

        // Scan for new engagements from SAM and A2A components
        var entities = _world.entitiesWith('weapons');
        if (!entities || entities.length === 0) {
            entities = [];
            // Also check individual weapon component types
            var samEnts = _world.entitiesWith('weapons/sam_battery') || [];
            var a2aEnts = _world.entitiesWith('weapons/a2a_missile') || [];
            var kkvEnts = _world.entitiesWith('weapons/kinetic_kill') || [];
            entities = entities.concat(samEnts, a2aEnts, kkvEnts);
        }

        // Also scan for SAM/A2A/KKV component states directly
        _world._entities && _world._entities.forEach(function(entity) {
            var s = entity.state;
            if (!s || !s._engagements) return;
            for (var i = 0; i < s._engagements.length; i++) {
                var eng = s._engagements[i];
                if (!eng._logged) {
                    eng._logged = true;
                    _engagementLog.push({
                        time: now,
                        type: eng.phase || 'ENGAGE',
                        source: entity.name || entity.id,
                        sourceId: entity.id,
                        target: eng.targetName || eng.targetId || '?',
                        targetId: eng.targetId,
                        weapon: eng.weaponType || 'UNKNOWN',
                        result: eng.result || 'ACTIVE',
                        range: eng.range_m ? Math.round(eng.range_m / 1000) + ' km' : '?'
                    });
                }
                // Check if engagement has completed (KILL/MISS)
                if ((eng.phase === 'ASSESS' || eng.result === 'KILL' || eng.result === 'MISS') && !eng._resultLogged) {
                    eng._resultLogged = true;
                    _engagementLog.push({
                        time: now,
                        type: eng.result || 'ASSESS',
                        source: entity.name || entity.id,
                        sourceId: entity.id,
                        target: eng.targetName || eng.targetId || '?',
                        targetId: eng.targetId,
                        weapon: eng.weaponType || 'UNKNOWN',
                        result: eng.result || 'UNKNOWN',
                        range: '—'
                    });
                }
            }
        });
    }

    // -----------------------------------------------------------------------
    // Engagement Timeline Panel
    // -----------------------------------------------------------------------
    let _engTimelineOpen = false;

    function _toggleEngTimeline() {
        var panel = document.getElementById('engTimelinePanel');
        if (!panel) return;
        _engTimelineOpen = !_engTimelineOpen;
        panel.style.display = _engTimelineOpen ? '' : 'none';
        if (_engTimelineOpen) _renderEngTimeline();
    }

    function _initEngTimeline() {
        var closeBtn = document.getElementById('engTimelineClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleEngTimeline);
        var exportBtn = document.getElementById('engTimelineExport');
        if (exportBtn) exportBtn.addEventListener('click', function() { _exportEngagementCSV(); });
    }

    function _renderEngTimeline() {
        var content = document.getElementById('engTimelineContent');
        var countEl = document.getElementById('engTimelineCount');
        if (!content) return;

        if (countEl) countEl.textContent = _engagementLog.length + ' events';

        if (_engagementLog.length === 0) {
            content.innerHTML = '<div style="color:#666;text-align:center;padding:20px">No engagement events yet.<br><span style="font-size:10px">Events will appear when weapons are fired or detections occur.</span></div>';
            return;
        }

        var html = '<table style="width:100%;border-collapse:collapse;font-size:10px">';
        html += '<tr style="border-bottom:1px solid #2a4a6a;color:#5a7a9a;font-weight:bold;text-align:left">';
        html += '<td style="padding:3px 4px">TIME</td><td>TYPE</td><td>SOURCE</td><td>TARGET</td><td>WEAPON</td><td>RESULT</td>';
        html += '</tr>';

        // Show most recent first
        var sorted = _engagementLog.slice().reverse();
        var maxShow = 100;
        for (var i = 0; i < Math.min(sorted.length, maxShow); i++) {
            var ev = sorted[i];
            var typeColor = ev.result === 'KILL' ? '#ff4444' :
                            ev.result === 'MISS' ? '#ffcc44' :
                            ev.type === 'ENGAGE' || ev.type === 'LAUNCH' ? '#ff8844' :
                            '#4a9eff';
            var mins = Math.floor(ev.time / 60);
            var secs = Math.floor(ev.time % 60);
            var timeStr = mins + ':' + secs.toString().padStart(2, '0');

            html += '<tr style="border-bottom:1px solid #1a2a3a">';
            html += '<td style="padding:2px 4px;color:#5a7a9a">' + timeStr + '</td>';
            html += '<td style="color:' + typeColor + ';font-weight:bold">' + (ev.type || '').toUpperCase() + '</td>';
            html += '<td style="color:#a0b8d0">' + _escapeHtmlStr(ev.source) + '</td>';
            html += '<td style="color:#a0b8d0">' + _escapeHtmlStr(ev.target) + '</td>';
            html += '<td style="color:#888">' + (ev.weapon || '') + '</td>';
            html += '<td style="color:' + typeColor + '">' + (ev.result || '') + '</td>';
            html += '</tr>';
        }
        html += '</table>';
        if (sorted.length > maxShow) {
            html += '<div style="color:#666;text-align:center;padding:4px;font-size:10px">Showing ' + maxShow + ' of ' + sorted.length + ' events</div>';
        }
        content.innerHTML = html;
    }

    function _escapeHtmlStr(s) {
        if (s == null) return '';
        if (typeof s !== 'string') s = String(s);
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // -----------------------------------------------------------------------
    // Engagement Stats — aggregated weapon statistics overlay
    // -----------------------------------------------------------------------
    let _engagementStats = {
        kills:   { a2a: 0, sam: 0, kkv: 0, total: 0 },
        launches:{ a2a: 0, sam: 0, kkv: 0, total: 0 },
        misses:  { a2a: 0, sam: 0, kkv: 0, total: 0 },
        playerKills: 0,
        playerDeaths: 0,
        events: []   // { time, type, source, target, weapon, result }
    };
    let _engStatsLastScanTime = 0;
    let _engStatsOpen = false;
    // Track which engagements have already been counted (by unique key)
    let _engStatsCounted = {};

    function _tickEngagementStats(dt) {
        if (!_world) return;
        var now = _simElapsed;
        if (now - _engStatsLastScanTime < 0.5) return; // 2Hz
        _engStatsLastScanTime = now;

        var playerId = _playerEntity ? _playerEntity.id : null;

        // Scan all entities for weapon component state
        _world._entities && _world._entities.forEach(function(entity) {
            var s = entity.state;
            if (!s) return;

            // --- SAM engagements (stored in s._engagements on SAM entities) ---
            if (s._samState && s._engagements) {
                for (var i = 0; i < s._engagements.length; i++) {
                    var eng = s._engagements[i];
                    _processEngStatEntry(eng, 'SAM', entity, playerId, now);
                }
            }

            // --- A2A engagements (stored in s._a2aEngagements) ---
            if (s._a2aEngagements) {
                for (var i = 0; i < s._a2aEngagements.length; i++) {
                    var eng = s._a2aEngagements[i];
                    var wpnLabel = eng.weaponType ? ('A2A/' + eng.weaponType) : 'A2A';
                    _processEngStatEntry(eng, 'A2A', entity, playerId, now, wpnLabel);
                }
            }

            // --- KKV engagements (stored in s._kkEngagements) ---
            if (s._kkEngagements) {
                for (var i = 0; i < s._kkEngagements.length; i++) {
                    var eng = s._kkEngagements[i];
                    _processEngStatEntry(eng, 'KKV', entity, playerId, now);
                }
            }
        });

        // Auto-refresh stats panel if visible (~2Hz)
        if (_engStatsOpen) _renderEngagementStats();
    }

    function _processEngStatEntry(eng, weaponClass, sourceEntity, playerId, now, displayWeapon) {
        // Build a unique key for this engagement action
        var targetId = eng.targetId || '?';
        var sourceId = sourceEntity.id;
        var result = eng.result;
        if (!result) return; // no result yet (still in progress)

        // For SAM/A2A: result is 'KILL' or 'MISS' (set when engagement resolves)
        // For KKV: result is 'LAUNCH', 'KILL', 'MISS', or 'KILLED_BY'
        var key = sourceId + '|' + targetId + '|' + result + '|' + (eng.time || 0);
        if (_engStatsCounted[key]) return;
        _engStatsCounted[key] = true;

        var wc = weaponClass.toLowerCase(); // 'a2a', 'sam', 'kkv'
        var weapon = displayWeapon || weaponClass;

        if (result === 'KILL') {
            _engagementStats.kills[wc] = (_engagementStats.kills[wc] || 0) + 1;
            _engagementStats.kills.total++;
            // SAM/A2A have no separate LAUNCH entry, so count launch here.
            // KKV has a separate LAUNCH entry that already counted the launch.
            if (wc !== 'kkv') {
                _engagementStats.launches[wc] = (_engagementStats.launches[wc] || 0) + 1;
                _engagementStats.launches.total++;
            }
            // Check player involvement
            if (sourceId === playerId) _engagementStats.playerKills++;
            if (targetId === playerId) _engagementStats.playerDeaths++;
            _engagementStats.events.push({
                time: now, type: 'KILL', source: sourceEntity.name || sourceId,
                target: eng.targetName || targetId, weapon: weapon, result: 'KILL'
            });
        } else if (result === 'MISS') {
            _engagementStats.misses[wc] = (_engagementStats.misses[wc] || 0) + 1;
            _engagementStats.misses.total++;
            // SAM/A2A have no separate LAUNCH entry, so count launch here.
            if (wc !== 'kkv') {
                _engagementStats.launches[wc] = (_engagementStats.launches[wc] || 0) + 1;
                _engagementStats.launches.total++;
            }
            _engagementStats.events.push({
                time: now, type: 'MISS', source: sourceEntity.name || sourceId,
                target: eng.targetName || targetId, weapon: weapon, result: 'MISS'
            });
        } else if (result === 'LAUNCH') {
            // KKV LAUNCH events — counted as launch (only KKV produces separate LAUNCH entries)
            _engagementStats.launches[wc] = (_engagementStats.launches[wc] || 0) + 1;
            _engagementStats.launches.total++;
            _engagementStats.events.push({
                time: now, type: 'LAUNCH', source: sourceEntity.name || sourceId,
                target: eng.targetName || targetId, weapon: weapon, result: 'LAUNCH'
            });
        } else if (result === 'KILLED_BY') {
            // KKV mutual destruction — the entity was killed by its target
            if (sourceId === playerId) _engagementStats.playerDeaths++;
            _engagementStats.events.push({
                time: now, type: 'KILLED_BY', source: sourceEntity.name || sourceId,
                target: eng.targetName || targetId, weapon: weapon, result: 'KILLED_BY'
            });
        }
    }

    function _toggleEngagementStats() {
        var panel = document.getElementById('engagementStatsPanel');
        if (!panel) return;
        _engStatsOpen = !_engStatsOpen;
        panel.style.display = _engStatsOpen ? '' : 'none';
        if (_engStatsOpen) _renderEngagementStats();
    }

    function _initEngagementStats() {
        var closeBtn = document.getElementById('engStatsClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleEngagementStats);
    }

    function _renderEngagementStats() {
        var content = document.getElementById('engStatsContent');
        if (!content) return;

        var st = _engagementStats;
        var html = '';

        // --- Stats table ---
        html += '<table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px">';
        html += '<tr style="border-bottom:1px solid #2a4a6a;color:#5a7a9a;font-weight:bold">';
        html += '<td style="padding:3px 6px">WEAPON</td><td style="text-align:center">FIRED</td>';
        html += '<td style="text-align:center">HIT</td><td style="text-align:center">MISS</td>';
        html += '<td style="text-align:center">Pk</td></tr>';

        var rows = [
            { label: 'A2A', key: 'a2a', color: '#4a9eff' },
            { label: 'SAM', key: 'sam', color: '#ff6644' },
            { label: 'KKV', key: 'kkv', color: '#cc88ff' }
        ];

        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var fired = st.launches[r.key] || 0;
            var hits = st.kills[r.key] || 0;
            var misses = st.misses[r.key] || 0;
            var pk = fired > 0 ? ((hits / fired) * 100).toFixed(0) + '%' : '\u2014';
            html += '<tr style="border-bottom:1px solid #1a2a3a">';
            html += '<td style="padding:3px 6px;color:' + r.color + ';font-weight:bold">' + r.label + '</td>';
            html += '<td style="text-align:center;color:#c0d0e0">' + fired + '</td>';
            html += '<td style="text-align:center;color:#44ff88">' + hits + '</td>';
            html += '<td style="text-align:center;color:#ff4444">' + misses + '</td>';
            html += '<td style="text-align:center;color:#ffcc44">' + pk + '</td>';
            html += '</tr>';
        }

        // Totals row
        var totalFired = st.launches.total || 0;
        var totalHits = st.kills.total || 0;
        var totalMisses = st.misses.total || 0;
        var totalPk = totalFired > 0 ? ((totalHits / totalFired) * 100).toFixed(0) + '%' : '\u2014';
        html += '<tr style="border-top:2px solid #3a5a7a;font-weight:bold">';
        html += '<td style="padding:4px 6px;color:#e0e0e0">TOTAL</td>';
        html += '<td style="text-align:center;color:#e0e0e0">' + totalFired + '</td>';
        html += '<td style="text-align:center;color:#44ff88">' + totalHits + '</td>';
        html += '<td style="text-align:center;color:#ff4444">' + totalMisses + '</td>';
        html += '<td style="text-align:center;color:#ffcc44">' + totalPk + '</td>';
        html += '</tr></table>';

        // --- Player stats ---
        html += '<div style="display:flex;gap:12px;margin-bottom:10px;padding:4px 6px;background:rgba(30,50,70,0.5);border-radius:3px">';
        html += '<span style="color:#5a7a9a;font-size:10px">PLAYER</span>';
        html += '<span style="color:#44ff88;font-size:11px;font-weight:bold">KILLS: ' + st.playerKills + '</span>';
        html += '<span style="color:#ff4444;font-size:11px;font-weight:bold">DEATHS: ' + st.playerDeaths + '</span>';
        html += '</div>';

        // --- Recent events log (last 10) ---
        html += '<div style="color:#5a7a9a;font-size:10px;font-weight:bold;margin-bottom:4px">RECENT EVENTS</div>';

        if (st.events.length === 0) {
            html += '<div style="color:#444;font-size:10px;text-align:center;padding:8px">No engagements yet</div>';
        } else {
            html += '<div style="max-height:140px;overflow-y:auto">';
            html += '<table style="width:100%;border-collapse:collapse;font-size:10px">';
            var evStart = Math.max(0, st.events.length - 10);
            for (var i = st.events.length - 1; i >= evStart; i--) {
                var ev = st.events[i];
                var tStr = _fmtEngStatTime(ev.time);
                var resColor = ev.result === 'KILL' ? '#ff4444' :
                               ev.result === 'MISS' ? '#888' :
                               ev.result === 'LAUNCH' ? '#ffcc44' :
                               ev.result === 'KILLED_BY' ? '#ff6644' : '#aaa';
                html += '<tr style="border-bottom:1px solid #0a1520">';
                html += '<td style="padding:2px 4px;color:#5a7a9a;white-space:nowrap">' + tStr + '</td>';
                html += '<td style="color:' + resColor + ';font-weight:bold">' + (ev.result || '') + '</td>';
                html += '<td style="color:#a0b8d0">' + _escapeHtmlStr(ev.source) + '</td>';
                html += '<td style="color:#666">&rarr;</td>';
                html += '<td style="color:#a0b8d0">' + _escapeHtmlStr(ev.target) + '</td>';
                html += '<td style="color:#888">' + (ev.weapon || '') + '</td>';
                html += '</tr>';
            }
            html += '</table></div>';
        }

        content.innerHTML = html;
    }

    function _fmtEngStatTime(seconds) {
        if (seconds == null) return '\u2014';
        var m = Math.floor(seconds / 60);
        var s = Math.floor(seconds % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // -----------------------------------------------------------------------
    // Data Export Panel
    // -----------------------------------------------------------------------
    let _dataExportOpen = false;

    function _toggleDataExport() {
        var panel = document.getElementById('dataExportPanel');
        if (!panel) return;
        _dataExportOpen = !_dataExportOpen;
        panel.style.display = _dataExportOpen ? '' : 'none';
    }

    function _initDataExport() {
        var closeBtn = document.getElementById('dataExportClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleDataExport);

        var btn1 = document.getElementById('deEntityStates');
        if (btn1) btn1.addEventListener('click', function() { _exportEntityStatesJSON(); });
        var btn2 = document.getElementById('deAnalyticsCSV');
        if (btn2) btn2.addEventListener('click', function() { _exportAnalyticsCSV(); });
        var btn3 = document.getElementById('deEngagementLog');
        if (btn3) btn3.addEventListener('click', function() { _exportEngagementCSV(); });
        var btn4 = document.getElementById('deScenarioJSON');
        if (btn4) btn4.addEventListener('click', function() { _exportScenarioSnapshot(); });
        var btn5 = document.getElementById('deOrbitalElements');
        if (btn5) btn5.addEventListener('click', function() { _exportOrbitalElementsCSV(); });
    }

    function _downloadFile(filename, content, mimeType) {
        var blob = new Blob([content], { type: mimeType || 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        var statusEl = document.getElementById('deStatus');
        if (statusEl) statusEl.textContent = 'Downloaded: ' + filename;
    }

    function _exportAnalyticsCSV() {
        if (_analyticsHistory.length === 0) {
            _showMessage('No analytics data to export');
            return;
        }
        var headers = ['time_s', 'alive', 'dead', 'hasFuel', 'avgAlt_km', 'avgSpeed_mps',
            'LEO', 'MEO', 'GEO', 'HEO', 'commDeliveryRate', 'commAvgLatency', 'commActiveLinks'];
        var rows = [headers.join(',')];
        _analyticsHistory.forEach(function(s) {
            rows.push([
                s.t.toFixed(1), s.alive, s.dead, s.hasFuel,
                s.avgAlt.toFixed(2), s.avgSpeed.toFixed(1),
                s.leo || 0, s.meo || 0, s.geo || 0, s.heo || 0,
                (s.commDeliveryRate || 0).toFixed(1), (s.commAvgLatency || 0).toFixed(1),
                s.commActiveLinks || 0
            ].join(','));
        });
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile('analytics_' + timestamp + '.csv', rows.join('\n'), 'text/csv');
    }

    function _exportEntityStatesJSON() {
        if (!_world || !_world._entities) {
            _showMessage('No entities to export');
            return;
        }
        var entities = [];
        _world._entities.forEach(function(entity) {
            var s = entity.state;
            var record = {
                id: entity.id,
                name: entity.name,
                type: entity.type,
                team: entity.team,
                lat: s.lat != null ? (s.lat * 180 / Math.PI).toFixed(6) : null,
                lon: s.lon != null ? (s.lon * 180 / Math.PI).toFixed(6) : null,
                alt_m: s.alt != null ? Math.round(s.alt) : null,
                speed_mps: s.speed != null ? s.speed.toFixed(2) : null,
                heading_deg: s.heading != null ? (s.heading * 180 / Math.PI).toFixed(2) : null,
                alive: s._alive !== false,
                phase: s.phase || null
            };
            if (s._orbital) {
                record.orbital = {
                    sma_km: (s._orbital.sma / 1000).toFixed(3),
                    ecc: s._orbital.ecc != null ? s._orbital.ecc.toFixed(6) : null,
                    inc_deg: s._orbital.inc != null ? (s._orbital.inc * 180 / Math.PI).toFixed(4) : null,
                    raan_deg: s._orbital.raan != null ? (s._orbital.raan * 180 / Math.PI).toFixed(4) : null,
                    regime: s._orbital.regime || null
                };
            }
            entities.push(record);
        });
        var output = JSON.stringify({ simTime: _simElapsed, entityCount: entities.length, entities: entities }, null, 2);
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile('entities_' + timestamp + '.json', output, 'application/json');
    }

    function _exportEngagementCSV() {
        if (_engagementLog.length === 0) {
            _showMessage('No engagement events to export');
            return;
        }
        var headers = ['time_s', 'type', 'source', 'sourceId', 'target', 'targetId', 'weapon', 'result', 'range'];
        var rows = [headers.join(',')];
        _engagementLog.forEach(function(e) {
            rows.push([
                e.time.toFixed(1),
                '"' + (e.type || '') + '"',
                '"' + (e.source || '') + '"',
                '"' + (e.sourceId || '') + '"',
                '"' + (e.target || '') + '"',
                '"' + (e.targetId || '') + '"',
                '"' + (e.weapon || '') + '"',
                '"' + (e.result || '') + '"',
                '"' + (e.range || '') + '"'
            ].join(','));
        });
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile('engagements_' + timestamp + '.csv', rows.join('\n'), 'text/csv');
    }

    function _exportScenarioSnapshot() {
        if (!_scenarioJson) {
            _showMessage('No scenario loaded');
            return;
        }
        // Clone scenario and update entity states with current positions
        var snapshot = JSON.parse(JSON.stringify(_scenarioJson));
        if (_world && _world._entities) {
            snapshot.entities = [];
            _world._entities.forEach(function(entity) {
                var s = entity.state;
                var def = {
                    id: entity.id,
                    name: entity.name,
                    type: entity.type,
                    team: entity.team,
                    initialState: {
                        lat: s.lat != null ? (s.lat * 180 / Math.PI) : 0,
                        lon: s.lon != null ? (s.lon * 180 / Math.PI) : 0,
                        alt: s.alt || 0,
                        speed: s.speed || 0,
                        heading: s.heading != null ? (s.heading * 180 / Math.PI) : 0,
                        gamma: s.gamma != null ? (s.gamma * 180 / Math.PI) : 0,
                        throttle: s.throttle || 0,
                        engineOn: !!s.engineOn
                    }
                };
                snapshot.entities.push(def);
            });
        }
        snapshot.metadata = snapshot.metadata || {};
        snapshot.metadata.snapshotTime = _simElapsed;
        snapshot.metadata.exportedAt = new Date().toISOString();
        var output = JSON.stringify(snapshot, null, 2);
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile('snapshot_' + timestamp + '.json', output, 'application/json');
    }

    function _exportOrbitalElementsCSV() {
        if (!_world || !_world._entities) {
            _showMessage('No entities to export');
            return;
        }
        var headers = ['id', 'name', 'team', 'sma_km', 'ecc', 'inc_deg', 'raan_deg', 'argPe_deg', 'meanAnomaly_deg', 'regime', 'alt_km', 'period_min'];
        var rows = [headers.join(',')];
        var count = 0;
        _world._entities.forEach(function(entity) {
            var s = entity.state;
            if (!s._orbital) return;
            var o = s._orbital;
            var DEG = 180 / Math.PI;
            var sma_km = o.sma ? (o.sma / 1000) : 0;
            var period_min = o.period ? (o.period / 60) : 0;
            rows.push([
                '"' + entity.id + '"',
                '"' + (entity.name || '') + '"',
                '"' + (entity.team || '') + '"',
                sma_km.toFixed(3),
                o.ecc != null ? o.ecc.toFixed(6) : '',
                o.inc != null ? (o.inc * DEG).toFixed(4) : '',
                o.raan != null ? (o.raan * DEG).toFixed(4) : '',
                o.argPe != null ? (o.argPe * DEG).toFixed(4) : '',
                o.meanAnomaly != null ? (o.meanAnomaly * DEG).toFixed(4) : '',
                '"' + (o.regime || '') + '"',
                (s.alt ? (s.alt / 1000).toFixed(3) : ''),
                period_min.toFixed(2)
            ].join(','));
            count++;
        });
        if (count === 0) {
            _showMessage('No orbital entities found');
            return;
        }
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        _downloadFile('orbital_elements_' + timestamp + '.csv', rows.join('\n'), 'text/csv');
    }

    // -----------------------------------------------------------------------
    // Communications Panel
    // -----------------------------------------------------------------------
    let _commPanelOpen = false;

    function _toggleCommPanel() {
        var panel = document.getElementById('commPanel');
        if (!panel) return;
        _commPanelOpen = !_commPanelOpen;
        _panelVisible.comm = _commPanelOpen;
        panel.style.display = _commPanelOpen ? '' : 'none';
        if (_commPanelOpen) _updateCommPanel();
    }

    function _initCommPanel() {
        var closeBtn = document.getElementById('commPanelClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleCommPanel);
    }

    function _updateCommPanel() {
        if (typeof CommEngine === 'undefined' || !CommEngine.isInitialized()) return;

        var metrics = CommEngine.getMetrics();
        var status = CommEngine.getNetworkStatus();

        // Summary counts
        _setText('commNetCount', status ? status.length : 0);
        var totalLinks = 0, jammedLinks = 0, cyberLinks = 0;
        if (status) {
            for (var si = 0; si < status.length; si++) {
                var ns = status[si];
                totalLinks += ns.activeLinks || 0;
                jammedLinks += ns.jammedLinks || 0;
                cyberLinks += ns.compromisedLinks || 0;
            }
        }
        _setText('commLinkCount', totalLinks);
        _setText('commJamCount', jammedLinks);
        _setText('commCyberCount', cyberLinks);

        // Per-network list
        var netList = document.getElementById('commNetList');
        if (netList && status) {
            var html = '';
            for (var ni = 0; ni < status.length; ni++) {
                var net = status[ni];
                var healthColor = net.health > 0.7 ? '#00ff88' : net.health > 0.3 ? '#ffcc44' : '#ff4444';
                var utilizationPct = Math.round((net.avgUtilization || 0) * 100);
                var utilColor = utilizationPct > 80 ? '#ff4444' : utilizationPct > 50 ? '#ffcc44' : '#00ff88';
                html += '<div style="padding:3px 6px;margin-bottom:2px;background:#0a1520;border-radius:2px;font-size:10px">';
                html += '<div style="display:flex;justify-content:space-between">';
                html += '<span style="color:' + healthColor + '">' + (net.name || net.id) + '</span>';
                html += '<span>' + (net.type || 'mesh').toUpperCase() + '</span>';
                html += '<span>Links: ' + (net.activeLinks || 0) + '/' + (net.totalLinks || 0) + '</span>';
                html += '<span style="color:' + healthColor + '">' + Math.round((net.health || 0) * 100) + '%</span>';
                html += '</div>';
                // Utilization bar
                html += '<div style="height:3px;background:#1a2a44;margin-top:2px;border-radius:1px">';
                html += '<div style="height:100%;width:' + utilizationPct + '%;background:' + utilColor + ';border-radius:1px"></div>';
                html += '</div>';
                if (net.jammedLinks > 0) {
                    html += '<div style="color:#ff4444;font-size:9px;margin-top:1px">' + net.jammedLinks + ' jammed</div>';
                }
                if (net.compromisedLinks > 0) {
                    html += '<div style="color:#ffcc00;font-size:9px;margin-top:1px">' + net.compromisedLinks + ' cyber</div>';
                }
                html += '</div>';
            }
            netList.innerHTML = html;
        }

        // F2T2EA Targeting status section
        var tgtDiv = document.getElementById('commTargetingStatus');
        if (tgtDiv && _world) {
            var tgtHtml = '';
            var tgtCount = 0;
            _world.entities.forEach(function(entity) {
                if (!entity.active) return;
                var s = entity.state;
                if (!s._samTrackSource || s._samTrackSource === 'NONE') return;
                tgtCount++;
                var srcColor = s._samTrackSource === 'ORGANIC' ? '#00ff88' :
                    s._samTrackSource === 'COMM' ? '#44aaff' :
                    s._samTrackSource === 'HYBRID' ? '#ffcc44' : '#888';
                tgtHtml += '<div style="padding:2px 6px;margin-bottom:1px;background:#0a1520;border-radius:2px;display:flex;justify-content:space-between;font-size:10px">';
                tgtHtml += '<span style="color:#ddd">' + entity.name + '</span>';
                tgtHtml += '<span style="color:' + srcColor + '">' + s._samTrackSource + '</span>';
                tgtHtml += '<span>O:' + (s._samOrganicTracks || 0) + ' C:' + (s._samCommTracks || 0) + '</span>';
                tgtHtml += '<span>' + (s._samState || 'IDLE') + '</span>';
                tgtHtml += '</div>';
            });
            if (tgtCount === 0) {
                tgtHtml = '<div style="color:#666;font-size:10px;padding:2px 6px">No weapon nodes in network</div>';
            }
            tgtDiv.innerHTML = tgtHtml;
        }

        // Packet log (last 20)
        var logDiv = document.getElementById('commPacketLog');
        if (logDiv && metrics) {
            var log = CommEngine.getPacketLog();
            if (log && log.length > 0) {
                var logHtml = '';
                var start = Math.max(0, log.length - 20);
                for (var li = start; li < log.length; li++) {
                    var pkt = log[li];
                    var pktColor = pkt.dropped ? '#ff4444' : pkt.delivered ? '#00ff88' : '#ffcc44';
                    var pktTypeColor = pkt.type === 'targeting' ? '#ff88ff' : pkt.type === 'track' ? '#44aaff' : pktColor;
                    var t = (pkt.createdAt || 0).toFixed(1);
                    logHtml += '<div style="color:' + pktColor + '">';
                    logHtml += '[' + t + 's] <span style="color:' + pktTypeColor + '">' + (pkt.type || 'data') + '</span> ';
                    logHtml += (pkt.sourceId || '?') + ' → ' + (pkt.destId || '?');
                    logHtml += ' ' + (pkt.size_bytes || 0) + 'B';
                    if (pkt.dropped) logHtml += ' DROPPED:' + (pkt.dropReason || '?');
                    else if (pkt.delivered) logHtml += ' OK ' + ((pkt.deliveryTime - pkt.createdAt) * 1000).toFixed(0) + 'ms';
                    logHtml += '</div>';
                }
                logDiv.innerHTML = logHtml;
                logDiv.scrollTop = logDiv.scrollHeight;
            }
        }

        // Metrics
        if (metrics) {
            _setText('commTxRate', (metrics.txRate || 0).toFixed(1));
            _setText('commRxRate', (metrics.rxRate || 0).toFixed(1));
            _setText('commDropRate', (metrics.dropRate || 0).toFixed(1));
            _setText('commAvgLatency', (metrics.avgLatency || 0).toFixed(1));
        }
    }

    // -----------------------------------------------------------------------
    // Cyber Warfare Scoring & Metrics
    // -----------------------------------------------------------------------
    var _cyberScore = {
        red: { scans: 0, exploits: 0, controlled: 0, subsystemsDisabled: 0, dataExfil: 0, totalPoints: 0 },
        blue: { scans: 0, exploits: 0, controlled: 0, subsystemsDisabled: 0, dataExfil: 0, totalPoints: 0 }
    };
    var _cyberDefenseScore = {
        red: { patches: 0, isolated: 0, counterAttacks: 0, restored: 0, totalPoints: 0 },
        blue: { patches: 0, isolated: 0, counterAttacks: 0, restored: 0, totalPoints: 0 }
    };

    /** Determine the attacking team: if a BLUE entity is the victim, RED scored the attack, and vice versa. */
    function _getAttackerTeam(victimTeam) {
        if (victimTeam === 'blue') return 'red';
        if (victimTeam === 'red') return 'blue';
        return 'red'; // default fallback
    }

    /** Determine the defending team: same team as the entity performing defense. */
    function _getDefenderTeam(defenderEntityTeam) {
        if (defenderEntityTeam === 'blue') return 'blue';
        if (defenderEntityTeam === 'red') return 'red';
        return 'blue'; // default fallback
    }

    function _addAttackScore(victimTeam, field, points) {
        var atkTeam = _getAttackerTeam(victimTeam);
        _cyberScore[atkTeam][field]++;
        _cyberScore[atkTeam].totalPoints += points;
    }

    function _addDefenseScore(defenderTeam, field, points) {
        var defTeam = _getDefenderTeam(defenderTeam);
        _cyberDefenseScore[defTeam][field]++;
        _cyberDefenseScore[defTeam].totalPoints += points;
    }

    function _resetCyberScores() {
        var teams = ['red', 'blue'];
        for (var i = 0; i < teams.length; i++) {
            var t = teams[i];
            _cyberScore[t].scans = 0;
            _cyberScore[t].exploits = 0;
            _cyberScore[t].controlled = 0;
            _cyberScore[t].subsystemsDisabled = 0;
            _cyberScore[t].dataExfil = 0;
            _cyberScore[t].totalPoints = 0;
            _cyberDefenseScore[t].patches = 0;
            _cyberDefenseScore[t].isolated = 0;
            _cyberDefenseScore[t].counterAttacks = 0;
            _cyberDefenseScore[t].restored = 0;
            _cyberDefenseScore[t].totalPoints = 0;
        }
    }

    function _getCyberScoreSummary() {
        var rAtk = _cyberScore.red;
        var bAtk = _cyberScore.blue;
        var rDef = _cyberDefenseScore.red;
        var bDef = _cyberDefenseScore.blue;
        var redTotal = rAtk.totalPoints + rDef.totalPoints;
        var blueTotal = bAtk.totalPoints + bDef.totalPoints;
        return {
            red: { attack: rAtk, defense: rDef, totalPoints: redTotal },
            blue: { attack: bAtk, defense: bDef, totalPoints: blueTotal }
        };
    }

    // -----------------------------------------------------------------------
    // Cyber Incident Log & Timeline Panel
    // -----------------------------------------------------------------------
    let _cyberLogOpen = false;
    let _cyberLog = [];
    let _cyberLogDirty = false;
    let _cyberLogPrevState = {};
    let _cyberLogScanTimer = 0;

    function _toggleCyberLogPanel() {
        var panel = document.getElementById('cyberLogPanel');
        if (!panel) return;
        _cyberLogOpen = !_cyberLogOpen;
        panel.style.display = _cyberLogOpen ? '' : 'none';
        if (_cyberLogOpen) {
            _cyberLogDirty = true;
            _renderCyberLog();
        }
    }

    function _initCyberLogPanel() {
        var closeBtn = document.getElementById('cyberLogClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleCyberLogPanel);
        var clearBtn = document.getElementById('cyberLogClear');
        if (clearBtn) clearBtn.addEventListener('click', function() {
            _cyberLog = [];
            _cyberLogPrevState = {};
            _resetCyberScores();
            _cyberLogDirty = true;
            _renderCyberLog();
        });
        var filterSel = document.getElementById('cyberLogFilter');
        if (filterSel) filterSel.addEventListener('change', function() {
            _cyberLogDirty = true;
            _renderCyberLog();
        });
    }

    function _addCyberLogEntry(simTime, type, entityName, team, message, category) {
        _cyberLog.push({
            time: simTime,
            type: type,
            entity: entityName,
            team: team,
            message: message,
            category: category
        });
        _cyberLogDirty = true;
        // Keep last 500 entries
        if (_cyberLog.length > 500) _cyberLog.shift();
    }

    function _formatCyberTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return 'T+0:00';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        if (h > 0) return 'T+' + h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0');
        return 'T+' + m + ':' + s.toString().padStart(2, '0');
    }

    function _renderCyberLog() {
        if (!_cyberLogDirty) return;
        _cyberLogDirty = false;

        var content = document.getElementById('cyberLogContent');
        if (!content || content.parentElement.style.display === 'none') return;

        var filter = document.getElementById('cyberLogFilter');
        var filterVal = filter ? filter.value : 'all';

        var filtered = _cyberLog;
        if (filterVal !== 'all') {
            filtered = _cyberLog.filter(function(e) { return e.category === filterVal; });
        }

        var html = '';
        if (filtered.length === 0) {
            html = '<div style="color:#333; padding:8px; text-align:center;">No cyber events recorded yet.</div>';
        } else {
            // Show most recent first (last 100)
            var start = Math.max(0, filtered.length - 100);
            for (var i = filtered.length - 1; i >= start; i--) {
                var entry = filtered[i];
                var timeStr = _formatCyberTime(entry.time);
                var color = entry.category === 'attack' ? '#ff4444' :
                            entry.category === 'defense' ? '#44ff44' :
                            entry.category === 'exfil' ? '#ffaa00' :
                            entry.category === 'lateral' ? '#ff88ff' : '#888';
                var teamColor = entry.team === 'blue' ? '#4488ff' : entry.team === 'red' ? '#ff4444' : '#888';
                html += '<div style="padding:2px 4px; border-bottom:1px solid #222; color:' + color + ';">' +
                    '<span style="color:#666;">' + timeStr + '</span> ' +
                    '<span style="color:' + color + '; font-weight:bold;">[' + entry.type + ']</span> ' +
                    '<span style="color:' + teamColor + ';">' + entry.entity + '</span> ' +
                    '<span style="color:#aaa;">' + entry.message + '</span></div>';
            }
        }
        content.innerHTML = html;

        // Stats footer with cyber scores
        var stats = document.getElementById('cyberLogStats');
        if (stats) {
            var attacks = 0, defenses = 0, exfils = 0, laterals = 0;
            for (var j = 0; j < _cyberLog.length; j++) {
                var cat = _cyberLog[j].category;
                if (cat === 'attack') attacks++;
                else if (cat === 'defense') defenses++;
                else if (cat === 'exfil') exfils++;
                else if (cat === 'lateral') laterals++;
            }
            var summary = _getCyberScoreSummary();
            var rAtk = summary.red.attack;
            var bAtk = summary.blue.attack;
            var rDef = summary.red.defense;
            var bDef = summary.blue.defense;

            // Build attack detail strings
            var redAtkParts = [];
            if (rAtk.exploits > 0) redAtkParts.push(rAtk.exploits + ' exploit' + (rAtk.exploits !== 1 ? 's' : ''));
            if (rAtk.controlled > 0) redAtkParts.push(rAtk.controlled + ' control' + (rAtk.controlled !== 1 ? 's' : ''));
            if (rAtk.dataExfil > 0) redAtkParts.push(rAtk.dataExfil + ' exfil');
            var redAtkStr = redAtkParts.length > 0 ? ' (' + redAtkParts.join(', ') + ')' : '';

            var blueAtkParts = [];
            if (bAtk.exploits > 0) blueAtkParts.push(bAtk.exploits + ' exploit' + (bAtk.exploits !== 1 ? 's' : ''));
            if (bAtk.controlled > 0) blueAtkParts.push(bAtk.controlled + ' control' + (bAtk.controlled !== 1 ? 's' : ''));
            if (bAtk.dataExfil > 0) blueAtkParts.push(bAtk.dataExfil + ' exfil');
            var blueAtkStr = blueAtkParts.length > 0 ? ' (' + blueAtkParts.join(', ') + ')' : '';

            // Build defense detail strings
            var redDefParts = [];
            if (rDef.patches > 0) redDefParts.push(rDef.patches + ' patch' + (rDef.patches !== 1 ? 'es' : ''));
            if (rDef.restored > 0) redDefParts.push(rDef.restored + ' restored');
            if (rDef.isolated > 0) redDefParts.push(rDef.isolated + ' isolated');
            var redDefStr = redDefParts.length > 0 ? ' (' + redDefParts.join(', ') + ')' : '';

            var blueDefParts = [];
            if (bDef.patches > 0) blueDefParts.push(bDef.patches + ' patch' + (bDef.patches !== 1 ? 'es' : ''));
            if (bDef.restored > 0) blueDefParts.push(bDef.restored + ' restored');
            if (bDef.isolated > 0) blueDefParts.push(bDef.isolated + ' isolated');
            var blueDefStr = blueDefParts.length > 0 ? ' (' + blueDefParts.join(', ') + ')' : '';

            stats.innerHTML =
                '<div style="margin-bottom:2px;">Total: ' + _cyberLog.length + ' | Attacks: ' + attacks +
                ' | Defense: ' + defenses + ' | Exfil: ' + exfils + ' | Lateral: ' + laterals + '</div>' +
                '<div style="color:#ff6666;"><b>RED:</b> ' + summary.red.totalPoints + 'pts' +
                (rAtk.totalPoints > 0 ? ' atk:' + rAtk.totalPoints : '') + redAtkStr +
                (rDef.totalPoints > 0 ? ' def:' + rDef.totalPoints : '') + redDefStr + '</div>' +
                '<div style="color:#6688ff;"><b>BLUE:</b> ' + summary.blue.totalPoints + 'pts' +
                (bAtk.totalPoints > 0 ? ' atk:' + bAtk.totalPoints : '') + blueAtkStr +
                (bDef.totalPoints > 0 ? ' def:' + bDef.totalPoints : '') + blueDefStr + '</div>';
        }
    }

    // Scan entities for cyber state transitions each tick (throttled to 2Hz)
    function _scanCyberEvents(dt) {
        _cyberLogScanTimer += dt;
        if (_cyberLogScanTimer < 0.5) return; // 2Hz
        _cyberLogScanTimer = 0;

        if (!_world) return;
        var simTime = _simElapsed || 0;

        _world.entities.forEach(function(ent) {
            if (!ent.state || !ent.active) return;
            var s = ent.state;
            var prevKey = '_cyberPrev_' + ent.id;
            var prev = _cyberLogPrevState[prevKey] || {};

            // --- Attack transitions (victim entity = ent, attacker = opposing team) ---

            // Scan started: +1 point to attacker
            if (s._cyberScanning && !prev.scanning) {
                _addCyberLogEntry(simTime, 'SCAN', ent.name, ent.team, 'Cyber scan detected', 'attack');
                _addAttackScore(ent.team, 'scans', 1);
            }
            // Exploit succeeded: +5 points to attacker
            if (s._cyberExploited && !prev.exploited) {
                _addCyberLogEntry(simTime, 'EXPLOIT', ent.name, ent.team, 'System compromised', 'attack');
                _addAttackScore(ent.team, 'exploits', 5);
            }
            // Full cyber control: +10 points to attacker
            if (s._cyberControlled && !prev.controlled) {
                _addCyberLogEntry(simTime, 'CONTROL', ent.name, ent.team, 'Entity under full cyber control', 'attack');
                _addAttackScore(ent.team, 'controlled', 10);
            }
            // Intrusion detected (informational, no scoring)
            if (s._cyberAttackDetected && !prev.attackDetected) {
                _addCyberLogEntry(simTime, 'DETECT', ent.name, ent.team,
                    'Intrusion detected (' + (s._cyberAttackType || 'unknown') + ')', 'attack');
            }
            // Node bricked: +3 points to attacker (subsystem disable)
            if (s._commBricked && !prev.bricked) {
                _addCyberLogEntry(simTime, 'BRICK', ent.name, ent.team, 'Node bricked', 'attack');
                _addAttackScore(ent.team, 'subsystemsDisabled', 3);
            }

            // Subsystem disabled flags: +3 points each to attacker
            if (s._sensorDisabled && !prev.sensorDisabled) {
                _addCyberLogEntry(simTime, 'DISABLED', ent.name, ent.team, 'Sensors disabled', 'attack');
                _addAttackScore(ent.team, 'subsystemsDisabled', 3);
            }
            if (s._weaponsDisabled && !prev.weaponsDisabled) {
                _addCyberLogEntry(simTime, 'DISABLED', ent.name, ent.team, 'Weapons disabled', 'attack');
                _addAttackScore(ent.team, 'subsystemsDisabled', 3);
            }
            if (s._navigationHijacked && !prev.navHijacked) {
                _addCyberLogEntry(simTime, 'DISABLED', ent.name, ent.team, 'Navigation hijacked', 'attack');
                _addAttackScore(ent.team, 'subsystemsDisabled', 3);
            }
            if (s._commsDisabled && !prev.commsDisabled) {
                _addCyberLogEntry(simTime, 'DISABLED', ent.name, ent.team, 'Comms disabled', 'attack');
                _addAttackScore(ent.team, 'subsystemsDisabled', 3);
            }

            // Subsystem degradation crossed thresholds
            if (s._cyberDegradation) {
                var deg = s._cyberDegradation;
                var subsystems = ['sensors', 'navigation', 'weapons', 'comms'];
                for (var si = 0; si < subsystems.length; si++) {
                    var sub = subsystems[si];
                    var cur = deg[sub] || 0;
                    var prevVal = (prev.degradation && prev.degradation[sub]) || 0;
                    if (cur >= 0.5 && prevVal < 0.5) {
                        _addCyberLogEntry(simTime, 'DEGRADE', ent.name, ent.team,
                            sub + ' degraded to ' + Math.round(cur * 100) + '%', 'attack');
                    }
                    // Full disable via degradation: +3 points to attacker
                    if (cur >= 1.0 && prevVal < 1.0) {
                        _addCyberLogEntry(simTime, 'DISABLED', ent.name, ent.team,
                            sub + ' fully disabled', 'attack');
                        _addAttackScore(ent.team, 'subsystemsDisabled', 3);
                    }
                    // Recovery below threshold: +3 points to defender
                    if (cur < 0.5 && prevVal >= 0.5) {
                        _addCyberLogEntry(simTime, 'RESTORED', ent.name, ent.team,
                            sub + ' partially restored', 'defense');
                        _addDefenseScore(ent.team, 'restored', 3);
                    }
                }
            }

            // --- Lateral movement ---
            if (s._cyberLateralSpread && !prev.lateral) {
                _addCyberLogEntry(simTime, 'LATERAL', ent.name, ent.team,
                    'Lateral movement detected from ' + (s._cyberLateralSource || 'unknown'), 'lateral');
            }

            // --- Data exfiltration: +8 points to attacker ---
            if (s._dataExfiltrated && !prev.exfil) {
                _addCyberLogEntry(simTime, 'EXFIL', ent.name, ent.team, 'Data exfiltrated', 'exfil');
                _addAttackScore(ent.team, 'dataExfil', 8);
            }

            // --- Defense transitions (defender entity = ent, defense scored by ent's team) ---
            // Patch in progress: +4 points to defender
            if (s._cyberDefensePatching && !prev.patching) {
                _addCyberLogEntry(simTime, 'PATCH', ent.name, ent.team,
                    'Cyber defense patching in progress', 'defense');
                _addDefenseScore(ent.team, 'patches', 4);
            }
            // Node isolated: +2 points to defender
            if (s._commIsolated && !prev.isolated) {
                _addCyberLogEntry(simTime, 'ISOLATE', ent.name, ent.team,
                    'Network node isolated by defense', 'defense');
                _addDefenseScore(ent.team, 'isolated', 2);
            }
            // Exploit cleared (recovery): +4 points to defender (patch equivalent)
            if (!s._cyberExploited && prev.exploited) {
                _addCyberLogEntry(simTime, 'DEFEND', ent.name, ent.team, 'Exploit cleared', 'defense');
                _addDefenseScore(ent.team, 'patches', 4);
            }
            // Node rebooted (recovery from brick): +4 points to defender
            if (!s._commBricked && prev.bricked) {
                _addCyberLogEntry(simTime, 'DEFEND', ent.name, ent.team, 'Node rebooted', 'defense');
                _addDefenseScore(ent.team, 'patches', 4);
            }
            // Sensors restored: +3 points to defender
            if (!s._sensorDisabled && prev.sensorDisabled) {
                _addCyberLogEntry(simTime, 'RESTORED', ent.name, ent.team, 'Sensors restored', 'defense');
                _addDefenseScore(ent.team, 'restored', 3);
            }
            // Weapons restored: +3 points to defender
            if (!s._weaponsDisabled && prev.weaponsDisabled) {
                _addCyberLogEntry(simTime, 'RESTORED', ent.name, ent.team, 'Weapons restored', 'defense');
                _addDefenseScore(ent.team, 'restored', 3);
            }

            // Save current state snapshot for next comparison
            _cyberLogPrevState[prevKey] = {
                scanning: !!s._cyberScanning,
                exploited: !!s._cyberExploited,
                controlled: !!s._cyberControlled,
                attackDetected: !!s._cyberAttackDetected,
                bricked: !!s._commBricked,
                sensorDisabled: !!s._sensorDisabled,
                weaponsDisabled: !!s._weaponsDisabled,
                navHijacked: !!s._navigationHijacked,
                commsDisabled: !!s._commsDisabled,
                lateral: !!s._cyberLateralSpread,
                exfil: !!s._dataExfiltrated,
                patching: !!s._cyberDefensePatching,
                isolated: !!s._commIsolated,
                degradation: s._cyberDegradation ? Object.assign({}, s._cyberDegradation) : {}
            };
        });

        // Render if panel is open and data changed
        if (_cyberLogOpen) _renderCyberLog();
    }

    // -----------------------------------------------------------------------
    // Autopilot Panel
    // -----------------------------------------------------------------------

    function _toggleAutopilotPanel() {
        _apPanelOpen = !_apPanelOpen;
        var panel = document.getElementById('autopilotPanel');
        if (panel) panel.style.display = _apPanelOpen ? 'block' : 'none';
        if (_apPanelOpen) _syncAutopilotPanel();
    }

    function _syncAutopilotPanel() {
        if (!_autopilotState) return;
        var ap = _autopilotState;

        // Master toggle button
        var masterBtn = document.getElementById('apMasterToggle');
        if (masterBtn) {
            masterBtn.textContent = ap.enabled ? 'AP ON' : 'AP OFF';
            masterBtn.style.color = ap.enabled ? '#00ff88' : '#ff4444';
            masterBtn.style.borderColor = ap.enabled ? '#00ff88' : '#ff4444';
            masterBtn.style.background = ap.enabled ? 'rgba(0,255,100,0.15)' : 'rgba(255,50,50,0.15)';
        }

        // Mode buttons
        var modes = { alt: ap.altHold, hdg: ap.hdgHold, spd: ap.spdHold, wp: ap.wpNav };
        Object.keys(modes).forEach(function(mode) {
            var btn = document.getElementById('ap' + mode.charAt(0).toUpperCase() + mode.slice(1) + 'Toggle');
            if (!btn) return;
            var active = modes[mode];
            btn.style.color = active ? '#00ff88' : '#888';
            btn.style.borderColor = active ? '#00ff88' : '#555';
            btn.style.background = active ? 'rgba(0,255,100,0.15)' : 'rgba(0,0,0,0.3)';
        });

        // Target value inputs (only update if not focused)
        var altInput = document.getElementById('apAltInput');
        if (altInput && document.activeElement !== altInput) {
            altInput.value = Math.round(ap.targetAlt * M_TO_FT);
        }
        var hdgInput = document.getElementById('apHdgInput');
        if (hdgInput && document.activeElement !== hdgInput) {
            hdgInput.value = Math.round(((ap.targetHdg * RAD) + 360) % 360);
        }
        var spdInput = document.getElementById('apSpdInput');
        if (spdInput && document.activeElement !== spdInput) {
            spdInput.value = Math.round(ap.targetSpeed * MPS_TO_KNOTS);
        }

        // WP section visibility
        var wpSection = document.getElementById('apWpSection');
        if (wpSection) wpSection.style.display = ap.wpNav ? 'block' : 'none';

        // WP info
        if (ap.wpNav && ap.waypoints.length > 0) {
            var wp = ap.waypoints[ap.currentWpIndex];
            var wpInfo = document.getElementById('apWpInfo');
            if (wpInfo) wpInfo.textContent = (wp ? wp.name : '?') + ' (' + (ap.currentWpIndex + 1) + '/' + ap.waypoints.length + ')';
        }

        // TF/TA button state
        var tfBtn = document.getElementById('apTfToggle');
        if (tfBtn) {
            tfBtn.textContent = _tfEnabled ? 'TF ON' : 'TF/TA';
            tfBtn.style.color = _tfEnabled ? '#00ff88' : '#888';
            tfBtn.style.borderColor = _tfEnabled ? '#00ff88' : '#555';
            tfBtn.style.background = _tfEnabled ? 'rgba(0,255,100,0.2)' : 'rgba(0,0,0,0.3)';
        }
        // TF section visibility
        var tfSection = document.getElementById('apTfSection');
        if (tfSection) tfSection.style.display = _tfEnabled ? 'block' : 'none';
        // TF AGL input
        var tfAglInput = document.getElementById('apTfAglInput');
        if (tfAglInput) tfAglInput.value = _tfAglTarget;
        // TF AGL readout
        var tfAglStatus = document.getElementById('apTfAglStatus');
        if (tfAglStatus && _playerState) {
            var curAgl = _playerState._tfAgl || (_playerState.alt - _tfCurrentTerrainElev);
            tfAglStatus.textContent = 'AGL: ' + Math.round(curAgl) + 'm | TERRAIN: ' + Math.round(_tfCurrentTerrainElev) + 'm';
        }
    }

    function _initAutopilotPanel() {
        var closeBtn = document.getElementById('apPanelClose');
        if (closeBtn) closeBtn.onclick = function() { _toggleAutopilotPanel(); };

        var masterBtn = document.getElementById('apMasterToggle');
        if (masterBtn) masterBtn.onclick = function() {
            if (_autopilotState && typeof FighterAutopilot !== 'undefined') {
                FighterAutopilot.toggle(_autopilotState, _playerState);
                _showMessage(_autopilotState.enabled ? 'AUTOPILOT ON' : 'AUTOPILOT OFF');
                _syncAutopilotPanel();
            }
        };

        // Mode toggle buttons
        ['alt', 'hdg', 'spd', 'wp'].forEach(function(mode) {
            var btn = document.getElementById('ap' + mode.charAt(0).toUpperCase() + mode.slice(1) + 'Toggle');
            if (!btn) return;
            btn.onclick = function() {
                if (!_autopilotState) return;
                if (mode === 'alt') {
                    _autopilotState.altHold = !_autopilotState.altHold;
                    if (_autopilotState.altHold && _playerState) _autopilotState.targetAlt = _playerState.alt;
                } else if (mode === 'hdg') {
                    _autopilotState.hdgHold = !_autopilotState.hdgHold;
                    if (_autopilotState.hdgHold && _playerState) _autopilotState.targetHdg = _playerState.heading;
                } else if (mode === 'spd') {
                    _autopilotState.spdHold = !_autopilotState.spdHold;
                    if (_autopilotState.spdHold && _playerState) _autopilotState.targetSpeed = _playerState.speed;
                } else if (mode === 'wp') {
                    if (_autopilotState.wpNav) {
                        _autopilotState.wpNav = false;
                    } else if (typeof FighterAutopilot !== 'undefined') {
                        // Load mission waypoints into autopilot if available
                        if (_missionWaypoints && _missionWaypoints.length > 0) {
                            _autopilotState.waypoints = _missionWaypoints.map(function(wp) {
                                return { name: wp.name, lat: wp.lat, lon: wp.lon, alt: wp.alt || (_playerState ? _playerState.alt : 5000), speed: wp.speed || (_playerState ? _playerState.speed : 200) };
                            });
                            _autopilotState.currentWpIndex = 0;
                        }
                        FighterAutopilot.enableWpNav(_autopilotState);
                        _autopilotState.enabled = true;
                    }
                }
                if (!_autopilotState.enabled && (_autopilotState.altHold || _autopilotState.hdgHold || _autopilotState.spdHold)) {
                    _autopilotState.enabled = true;
                }
                _syncAutopilotPanel();
            };
        });

        // Target value inputs
        var altInput = document.getElementById('apAltInput');
        if (altInput) altInput.onchange = function() {
            if (_autopilotState) _autopilotState.targetAlt = parseFloat(altInput.value) / M_TO_FT;
        };
        var hdgInput = document.getElementById('apHdgInput');
        if (hdgInput) hdgInput.onchange = function() {
            if (_autopilotState) _autopilotState.targetHdg = parseFloat(hdgInput.value) * DEG;
        };
        var spdInput = document.getElementById('apSpdInput');
        if (spdInput) spdInput.onchange = function() {
            if (_autopilotState) _autopilotState.targetSpeed = parseFloat(spdInput.value) / MPS_TO_KNOTS;
        };

        // WP nav prev/next
        var wpPrev = document.getElementById('apWpPrev');
        if (wpPrev) wpPrev.onclick = function() {
            if (_autopilotState && _autopilotState.waypoints.length > 0) {
                _autopilotState.currentWpIndex = (_autopilotState.currentWpIndex - 1 + _autopilotState.waypoints.length) % _autopilotState.waypoints.length;
                var wp = _autopilotState.waypoints[_autopilotState.currentWpIndex];
                if (wp) {
                    _autopilotState.targetAlt = wp.alt;
                    _autopilotState.targetSpeed = wp.speed;
                }
                _syncAutopilotPanel();
            }
        };
        var wpNext = document.getElementById('apWpNext');
        if (wpNext) wpNext.onclick = function() {
            if (_autopilotState && typeof FighterAutopilot !== 'undefined') {
                FighterAutopilot.nextWaypoint(_autopilotState);
                _syncAutopilotPanel();
            }
        };

        // Prevent keyboard events from reaching flight controls when inputs are focused
        ['apAltInput', 'apHdgInput', 'apSpdInput', 'apTfAglInput'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                el.addEventListener('keydown', function(e) { e.stopPropagation(); });
                el.addEventListener('keyup', function(e) { e.stopPropagation(); });
            }
        });

        // TF/TA toggle button
        var tfBtn = document.getElementById('apTfToggle');
        if (tfBtn) tfBtn.onclick = function() { _toggleTerrainFollowing(); };

        // TF AGL target input
        var tfAglInput = document.getElementById('apTfAglInput');
        if (tfAglInput) {
            tfAglInput.value = _tfAglTarget;
            tfAglInput.onchange = function() {
                var val = parseFloat(tfAglInput.value);
                if (!isNaN(val) && val >= 30 && val <= 2000) {
                    _tfAglTarget = val;
                    if (_tfEnabled) _showMessage('TF/TA AGL: ' + _tfAglTarget + 'm');
                }
            };
        }
    }

    // -----------------------------------------------------------------------
    // After-Action Report (AAR)
    // -----------------------------------------------------------------------
    var _aarPanelOpen = false;

    function _toggleAAR() {
        var panel = document.getElementById('aarPanel');
        if (!panel) return;
        _aarPanelOpen = !_aarPanelOpen;
        if (_aarPanelOpen) {
            _generateAAR();
            panel.style.display = 'block';
        } else {
            panel.style.display = 'none';
        }
    }

    function _initAARPanel() {
        var closeBtn = document.getElementById('aarClose');
        if (closeBtn) closeBtn.addEventListener('click', _toggleAAR);
    }

    function _formatAARTime(seconds) {
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        return (h < 10 ? '0' : '') + h + ':' +
               (m < 10 ? '0' : '') + m + ':' +
               (s < 10 ? '0' : '') + s;
    }

    function _generateAAR() {
        var content = document.getElementById('aarContent');
        if (!content || !_world) return;

        var html = '';
        var teamColors = { blue: '#4488ff', red: '#ff4444', green: '#44ff44', neutral: '#888888' };

        // ---- Collect entity data ----
        var totalEntities = 0;
        var domainCounts = { Air: 0, Space: 0, Ground: 0, Naval: 0, Cyber: 0 };
        var teamData = {};   // { teamName: { total, alive, dead, types: {} } }
        var weaponsFired = 0;
        var totalKills = 0;
        var teamKills = {};
        var teamLosses = {};

        // Domain activity accumulators
        var airEntities = [];
        var spaceEntities = [];
        var navalEntities = [];
        var groundEntities = [];
        var cyberEntities = [];

        _world.entities.forEach(function(entity) {
            totalEntities++;
            var team = entity.team || 'neutral';
            var type = entity.type || 'unknown';
            var state = entity.state;
            var isAlive = entity.active && !state.dead;
            var isDead = !entity.active || !!state.dead;

            // Init team data
            if (!teamData[team]) {
                teamData[team] = { total: 0, alive: 0, dead: 0, types: {} };
                teamKills[team] = 0;
                teamLosses[team] = 0;
            }
            teamData[team].total++;
            if (isAlive) teamData[team].alive++;
            if (isDead) {
                teamData[team].dead++;
                teamLosses[team]++;
                totalKills++;
            }
            teamData[team].types[type] = (teamData[team].types[type] || 0) + 1;

            // Weapons fired
            if (state._weaponsFired > 0) weaponsFired += state._weaponsFired;

            // Count kills attributed to this entity
            if (state._killCount > 0) {
                teamKills[team] += state._killCount;
            }

            // Domain classification
            var domain = _classifyDomain(entity);
            if (domain === 'Air') {
                domainCounts.Air++;
                airEntities.push(entity);
            } else if (domain === 'Space') {
                domainCounts.Space++;
                spaceEntities.push(entity);
            } else if (domain === 'Naval') {
                domainCounts.Naval++;
                navalEntities.push(entity);
            } else if (domain === 'Ground') {
                domainCounts.Ground++;
                groundEntities.push(entity);
            }

            // Cyber domain detection
            if (state._cyberExploited || state._cyberControlled ||
                state._cyberScanning || state._cyberDenied ||
                state._cyberAccessLevel > 0) {
                cyberEntities.push(entity);
                domainCounts.Cyber++;
            }
        });

        // ---- Section 1: Mission Summary ----
        html += '<div style="margin-bottom:16px;">';
        html += '<div style="color:#00ff88;font-size:13px;font-weight:bold;border-bottom:1px solid #005533;padding-bottom:4px;margin-bottom:8px;letter-spacing:1px;">MISSION SUMMARY</div>';
        html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
        html += '<tr><td style="color:#888;padding:3px 8px;">Sim Time Elapsed</td><td style="color:#00ff88;padding:3px 8px;text-align:right;font-weight:bold;">' + _formatAARTime(_simElapsed) + '</td></tr>';
        html += '<tr><td style="color:#888;padding:3px 8px;">Total Entities</td><td style="color:#ccc;padding:3px 8px;text-align:right;">' + totalEntities + '</td></tr>';

        var domainStr = [];
        for (var dk in domainCounts) {
            if (domainCounts[dk] > 0) domainStr.push(dk + ': ' + domainCounts[dk]);
        }
        html += '<tr><td style="color:#888;padding:3px 8px;">Entities by Domain</td><td style="color:#ccc;padding:3px 8px;text-align:right;">' + (domainStr.length > 0 ? domainStr.join(', ') : 'N/A') + '</td></tr>';

        var playerName = _playerEntity ? (_playerEntity.name || _playerEntity.id) : '(Observer)';
        var playerStatus = 'N/A';
        if (_playerEntity) {
            playerStatus = (_playerEntity.active && !_playerEntity.state.dead) ? '<span style="color:#44ff44;">ACTIVE</span>' : '<span style="color:#ff4444;">DESTROYED</span>';
        } else if (_observerMode) {
            playerStatus = '<span style="color:#aaa;">OBSERVER</span>';
        }
        html += '<tr><td style="color:#888;padding:3px 8px;">Player Entity</td><td style="color:#ccc;padding:3px 8px;text-align:right;">' + playerName + '</td></tr>';
        html += '<tr><td style="color:#888;padding:3px 8px;">Player Status</td><td style="padding:3px 8px;text-align:right;">' + playerStatus + '</td></tr>';
        html += '</table></div>';

        // ---- Section 2: Force Disposition ----
        html += '<div style="margin-bottom:16px;">';
        html += '<div style="color:#00ff88;font-size:13px;font-weight:bold;border-bottom:1px solid #005533;padding-bottom:4px;margin-bottom:8px;letter-spacing:1px;">FORCE DISPOSITION</div>';
        html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
        html += '<tr style="border-bottom:1px solid #333;">';
        html += '<th style="color:#666;padding:4px 8px;text-align:left;">Team</th>';
        html += '<th style="color:#666;padding:4px 8px;text-align:right;">Total</th>';
        html += '<th style="color:#666;padding:4px 8px;text-align:right;">Alive</th>';
        html += '<th style="color:#666;padding:4px 8px;text-align:right;">Destroyed</th>';
        html += '<th style="color:#666;padding:4px 8px;text-align:left;">Types</th>';
        html += '</tr>';

        var sortedTeams = Object.keys(teamData).sort();
        for (var ti = 0; ti < sortedTeams.length; ti++) {
            var tName = sortedTeams[ti];
            var td = teamData[tName];
            var tColor = teamColors[tName] || '#aaa';
            var typesList = [];
            for (var tp in td.types) {
                typesList.push(tp + ':' + td.types[tp]);
            }
            html += '<tr style="border-bottom:1px solid #222;">';
            html += '<td style="color:' + tColor + ';padding:4px 8px;font-weight:bold;text-transform:uppercase;">' + tName + '</td>';
            html += '<td style="color:#ccc;padding:4px 8px;text-align:right;">' + td.total + '</td>';
            html += '<td style="color:#44ff44;padding:4px 8px;text-align:right;">' + td.alive + '</td>';
            html += '<td style="color:' + (td.dead > 0 ? '#ff4444' : '#666') + ';padding:4px 8px;text-align:right;">' + td.dead + '</td>';
            html += '<td style="color:#888;padding:4px 8px;font-size:10px;">' + typesList.join(', ') + '</td>';
            html += '</tr>';
        }
        html += '</table></div>';

        // ---- Section 3: Engagement Summary ----
        html += '<div style="margin-bottom:16px;">';
        html += '<div style="color:#00ff88;font-size:13px;font-weight:bold;border-bottom:1px solid #005533;padding-bottom:4px;margin-bottom:8px;letter-spacing:1px;">ENGAGEMENT SUMMARY</div>';
        html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
        html += '<tr><td style="color:#888;padding:3px 8px;">Total Weapons Fired</td><td style="color:#ffcc44;padding:3px 8px;text-align:right;font-weight:bold;">' + weaponsFired + '</td></tr>';
        html += '<tr><td style="color:#888;padding:3px 8px;">Total Kills</td><td style="color:#ff4444;padding:3px 8px;text-align:right;font-weight:bold;">' + totalKills + '</td></tr>';
        html += '</table>';

        // Kill-to-loss ratio per team
        if (sortedTeams.length > 0) {
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:6px;">';
            html += '<tr style="border-bottom:1px solid #333;">';
            html += '<th style="color:#666;padding:4px 8px;text-align:left;">Team</th>';
            html += '<th style="color:#666;padding:4px 8px;text-align:right;">Kills</th>';
            html += '<th style="color:#666;padding:4px 8px;text-align:right;">Losses</th>';
            html += '<th style="color:#666;padding:4px 8px;text-align:right;">K/L Ratio</th>';
            html += '</tr>';
            for (var ki = 0; ki < sortedTeams.length; ki++) {
                var kTeam = sortedTeams[ki];
                var kColor = teamColors[kTeam] || '#aaa';
                var kills = teamKills[kTeam] || 0;
                var losses = teamLosses[kTeam] || 0;
                var ratio = losses > 0 ? (kills / losses).toFixed(2) : (kills > 0 ? 'INF' : '---');
                html += '<tr style="border-bottom:1px solid #222;">';
                html += '<td style="color:' + kColor + ';padding:4px 8px;font-weight:bold;text-transform:uppercase;">' + kTeam + '</td>';
                html += '<td style="color:#ccc;padding:4px 8px;text-align:right;">' + kills + '</td>';
                html += '<td style="color:' + (losses > 0 ? '#ff6644' : '#666') + ';padding:4px 8px;text-align:right;">' + losses + '</td>';
                html += '<td style="color:#ffcc44;padding:4px 8px;text-align:right;font-weight:bold;">' + ratio + '</td>';
                html += '</tr>';
            }
            html += '</table>';
        }
        html += '</div>';

        // ---- Section 4: Domain Activity ----
        html += '<div style="margin-bottom:16px;">';
        html += '<div style="color:#00ff88;font-size:13px;font-weight:bold;border-bottom:1px solid #005533;padding-bottom:4px;margin-bottom:8px;letter-spacing:1px;">DOMAIN ACTIVITY</div>';

        // Air
        if (airEntities.length > 0) {
            var airTotalAlt = 0, airTotalSpeed = 0, airAltCount = 0, airSpeedCount = 0;
            for (var ai = 0; ai < airEntities.length; ai++) {
                var aState = airEntities[ai].state;
                if (aState.alt != null) { airTotalAlt += aState.alt; airAltCount++; }
                if (aState.speed != null) { airTotalSpeed += aState.speed; airSpeedCount++; }
            }
            html += '<div style="margin-bottom:8px;padding:6px 8px;background:rgba(68,136,255,0.08);border-left:2px solid #4488ff;border-radius:2px;">';
            html += '<div style="color:#4488ff;font-weight:bold;font-size:11px;margin-bottom:4px;">AIR (' + airEntities.length + ')</div>';
            html += '<div style="color:#888;font-size:10px;">';
            if (airAltCount > 0) html += 'Avg Altitude: <span style="color:#ccc;">' + (airTotalAlt / airAltCount / 1000).toFixed(1) + ' km</span> &nbsp; ';
            if (airSpeedCount > 0) html += 'Avg Speed: <span style="color:#ccc;">' + (airTotalSpeed / airSpeedCount).toFixed(0) + ' m/s</span>';
            html += '</div></div>';
        }

        // Space
        if (spaceEntities.length > 0) {
            var regimeCounts = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, OTHER: 0 };
            for (var si = 0; si < spaceEntities.length; si++) {
                var sOrbital = spaceEntities[si].state._orbital;
                var sRegime = _classifyRegime(sOrbital);
                regimeCounts[sRegime]++;
            }
            html += '<div style="margin-bottom:8px;padding:6px 8px;background:rgba(68,204,255,0.08);border-left:2px solid #44ccff;border-radius:2px;">';
            html += '<div style="color:#44ccff;font-weight:bold;font-size:11px;margin-bottom:4px;">SPACE (' + spaceEntities.length + ')</div>';
            html += '<div style="color:#888;font-size:10px;">';
            var regimeStrs = [];
            for (var rk in regimeCounts) {
                if (regimeCounts[rk] > 0) regimeStrs.push(rk + ': <span style="color:#ccc;">' + regimeCounts[rk] + '</span>');
            }
            html += regimeStrs.join(' &nbsp; ');
            html += '</div></div>';
        }

        // Maritime / Naval
        if (navalEntities.length > 0) {
            html += '<div style="margin-bottom:8px;padding:6px 8px;background:rgba(0,170,255,0.08);border-left:2px solid #00aaff;border-radius:2px;">';
            html += '<div style="color:#00aaff;font-weight:bold;font-size:11px;margin-bottom:4px;">MARITIME (' + navalEntities.length + ')</div>';
            html += '<div style="color:#888;font-size:10px;">';
            for (var ni = 0; ni < navalEntities.length && ni < 10; ni++) {
                var nEnt = navalEntities[ni];
                var nState = nEnt.state;
                var nLat = nState.lat != null ? (nState.lat * RAD).toFixed(2) : '?';
                var nLon = nState.lon != null ? (nState.lon * RAD).toFixed(2) : '?';
                html += '<span style="color:#ccc;">' + (nEnt.name || nEnt.id) + '</span> (' + nLat + ', ' + nLon + ')';
                if (ni < navalEntities.length - 1 && ni < 9) html += ' &nbsp; ';
            }
            if (navalEntities.length > 10) html += ' &nbsp; +' + (navalEntities.length - 10) + ' more';
            html += '</div></div>';
        }

        // Ground
        if (groundEntities.length > 0) {
            html += '<div style="margin-bottom:8px;padding:6px 8px;background:rgba(136,136,68,0.08);border-left:2px solid #888844;border-radius:2px;">';
            html += '<div style="color:#888844;font-weight:bold;font-size:11px;margin-bottom:4px;">GROUND (' + groundEntities.length + ')</div>';
            html += '<div style="color:#888;font-size:10px;">';
            var groundNames = [];
            for (var gi = 0; gi < groundEntities.length && gi < 10; gi++) {
                groundNames.push(groundEntities[gi].name || groundEntities[gi].id);
            }
            html += groundNames.join(', ');
            if (groundEntities.length > 10) html += ', +' + (groundEntities.length - 10) + ' more';
            html += '</div></div>';
        }

        // Cyber
        if (cyberEntities.length > 0) {
            var cyberExploited = 0, cyberControlled = 0, cyberDenied = 0, cyberScanning = 0;
            for (var ci = 0; ci < cyberEntities.length; ci++) {
                var cState = cyberEntities[ci].state;
                if (cState._cyberExploited) cyberExploited++;
                if (cState._cyberControlled) cyberControlled++;
                if (cState._cyberDenied) cyberDenied++;
                if (cState._cyberScanning) cyberScanning++;
            }
            html += '<div style="margin-bottom:8px;padding:6px 8px;background:rgba(0,255,136,0.08);border-left:2px solid #00ff88;border-radius:2px;">';
            html += '<div style="color:#00ff88;font-weight:bold;font-size:11px;margin-bottom:4px;">CYBER (' + cyberEntities.length + ' affected)</div>';
            html += '<div style="color:#888;font-size:10px;">';
            html += 'Scanning: <span style="color:#ffcc44;">' + cyberScanning + '</span> &nbsp; ';
            html += 'Exploited: <span style="color:#ff8844;">' + cyberExploited + '</span> &nbsp; ';
            html += 'Controlled: <span style="color:#ff4444;">' + cyberControlled + '</span> &nbsp; ';
            html += 'Denied: <span style="color:#ff2222;">' + cyberDenied + '</span>';
            html += '</div></div>';
        }

        if (airEntities.length === 0 && spaceEntities.length === 0 &&
            navalEntities.length === 0 && groundEntities.length === 0 &&
            cyberEntities.length === 0) {
            html += '<div style="color:#666;font-size:11px;font-style:italic;">No domain activity detected</div>';
        }
        html += '</div>';

        // ---- Section 5: Communications ----
        if (typeof CommEngine !== 'undefined' && CommEngine.isInitialized()) {
            var commMetrics = CommEngine.getMetrics();
            html += '<div style="margin-bottom:16px;">';
            html += '<div style="color:#00ff88;font-size:13px;font-weight:bold;border-bottom:1px solid #005533;padding-bottom:4px;margin-bottom:8px;letter-spacing:1px;">COMMUNICATIONS</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            html += '<tr><td style="color:#888;padding:3px 8px;">Total Packets Routed</td><td style="color:#00ffcc;padding:3px 8px;text-align:right;font-weight:bold;">' + (commMetrics.totalPacketsRouted || 0) + '</td></tr>';
            html += '<tr><td style="color:#888;padding:3px 8px;">Active Links</td><td style="color:#4488ff;padding:3px 8px;text-align:right;">' + (commMetrics.activeLinks || 0) + ' / ' + (commMetrics.totalLinks || 0) + '</td></tr>';
            html += '<tr><td style="color:#888;padding:3px 8px;">Jammed Links</td><td style="color:' + ((commMetrics.jammedLinks || 0) > 0 ? '#ff4444' : '#666') + ';padding:3px 8px;text-align:right;">' + (commMetrics.jammedLinks || 0) + '</td></tr>';
            html += '<tr><td style="color:#888;padding:3px 8px;">Active Jammers</td><td style="color:' + ((commMetrics.activeJammers || 0) > 0 ? '#ff4444' : '#666') + ';padding:3px 8px;text-align:right;">' + (commMetrics.activeJammers || 0) + '</td></tr>';
            html += '<tr><td style="color:#888;padding:3px 8px;">Cyber Attacks</td><td style="color:' + ((commMetrics.activeCyberAttacks || 0) > 0 ? '#ffcc44' : '#666') + ';padding:3px 8px;text-align:right;">' + (commMetrics.activeCyberAttacks || 0) + '</td></tr>';
            html += '<tr><td style="color:#888;padding:3px 8px;">Delivery Rate</td><td style="color:#ccc;padding:3px 8px;text-align:right;">' + ((commMetrics.packetDeliveryRate || 0) * 100).toFixed(1) + '%</td></tr>';
            html += '</table></div>';
        }

        // ---- Footer ----
        html += '<div style="color:#444;font-size:9px;text-align:center;margin-top:12px;border-top:1px solid #333;padding-top:8px;">';
        html += 'Report generated at T+' + _formatAARTime(_simElapsed) + ' | All-Domain Sim AAR';
        html += '</div>';

        content.innerHTML = html;
    }

    // -----------------------------------------------------------------------
    // Force Status Board
    // -----------------------------------------------------------------------
    var _statusBoardOpen = false;
    var _statusBoardSortCol = 'name';
    var _statusBoardSortAsc = true;
    var _statusBoardFilter = 'all';
    var _statusBoardInterval = null;

    function _initStatusBoard() {
        // Filter buttons
        document.querySelectorAll('.sb-filter-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.sb-filter-btn').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                _statusBoardFilter = btn.getAttribute('data-sb-filter');
                _updateStatusBoard();
            });
        });
        // Sort headers
        document.querySelectorAll('#statusBoard th[data-sb-sort]').forEach(function(th) {
            th.addEventListener('click', function() {
                var col = th.getAttribute('data-sb-sort');
                if (_statusBoardSortCol === col) {
                    _statusBoardSortAsc = !_statusBoardSortAsc;
                } else {
                    _statusBoardSortCol = col;
                    _statusBoardSortAsc = true;
                }
                // Update sort arrows
                document.querySelectorAll('#statusBoard th .sort-arrow').forEach(function(s) { s.textContent = ''; });
                th.querySelector('.sort-arrow').textContent = _statusBoardSortAsc ? '\u25B2' : '\u25BC';
                _updateStatusBoard();
            });
        });
    }

    function _toggleStatusBoard() {
        _statusBoardOpen = !_statusBoardOpen;
        var panel = document.getElementById('statusBoard');
        if (!panel) return;
        panel.style.display = _statusBoardOpen ? 'block' : 'none';
        if (_statusBoardOpen) {
            _updateStatusBoard();
            if (!_statusBoardInterval) {
                _statusBoardInterval = setInterval(_updateStatusBoard, 2000);
            }
        } else {
            if (_statusBoardInterval) {
                clearInterval(_statusBoardInterval);
                _statusBoardInterval = null;
            }
        }
    }

    function _updateStatusBoard() {
        var tbody = document.getElementById('statusBoardBody');
        if (!tbody) return;

        var rows = [];
        _world.entities.forEach(function(entity) {
            var s = entity.state || {};
            var type = entity.type || 'unknown';
            var team = entity.team || 'neutral';
            var isDead = s._dead || s._destroyed || false;
            var alt = s.alt || s.altitude || 0;
            var speed = s.speed || 0;
            var fuel = s.fuel != null ? s.fuel : -1;

            // Apply filter
            if (_statusBoardFilter !== 'all') {
                if (_statusBoardFilter === 'blue' || _statusBoardFilter === 'red') {
                    if (team !== _statusBoardFilter) return;
                } else {
                    if (type !== _statusBoardFilter) return;
                }
            }

            rows.push({
                name: entity.name || entity.id,
                team: team,
                type: type,
                status: isDead ? 'DEAD' : (s._cyberDenied ? 'DENIED' : (s._cyberExploited ? 'COMPROMISED' : 'ACTIVE')),
                alt: alt,
                speed: speed,
                fuel: fuel,
                isDead: isDead,
                entityId: entity.id
            });
        });

        // Sort
        rows.sort(function(a, b) {
            var va = a[_statusBoardSortCol];
            var vb = b[_statusBoardSortCol];
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return _statusBoardSortAsc ? -1 : 1;
            if (va > vb) return _statusBoardSortAsc ? 1 : -1;
            return 0;
        });

        var html = '';
        rows.forEach(function(r) {
            var teamClass = 'team-' + r.team;
            var statusClass = r.isDead ? 'status-dead' : (r.status === 'ACTIVE' ? 'status-ok' : 'status-damaged');
            var rowClass = r.isDead ? 'dead' : '';
            var altStr = r.alt > 100000 ? (r.alt / 1000).toFixed(0) + 'km' : (r.alt > 1000 ? (r.alt / 1000).toFixed(1) + 'km' : r.alt.toFixed(0) + 'm');
            var spdStr = r.speed > 1000 ? (r.speed / 1000).toFixed(1) + 'km/s' : r.speed.toFixed(0) + 'm/s';
            var fuelStr = r.fuel < 0 ? '---' : (r.fuel > 100 ? r.fuel.toFixed(0) + 'kg' : r.fuel.toFixed(0) + '%');

            html += '<tr class="' + rowClass + '" data-entity-id="' + r.entityId + '">';
            html += '<td>' + r.name + '</td>';
            html += '<td class="' + teamClass + '">' + r.team.toUpperCase() + '</td>';
            html += '<td>' + r.type + '</td>';
            html += '<td class="' + statusClass + '">' + r.status + '</td>';
            html += '<td>' + altStr + '</td>';
            html += '<td>' + spdStr + '</td>';
            html += '<td>' + fuelStr + '</td>';
            html += '</tr>';
        });

        tbody.innerHTML = html;

        // Click to track
        tbody.querySelectorAll('tr').forEach(function(tr) {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', function() {
                var eid = tr.getAttribute('data-entity-id');
                var entity = _world.entities.get(eid);
                if (entity && typeof _trackEntity === 'function') {
                    _trackEntity(entity);
                }
            });
        });
    }

    function _classifyDomain(entity) {
        var type = entity.type || '';
        var state = entity.state;

        // Check entity type field
        if (type === 'aircraft' || type === 'fighter' || type === 'bomber' || type === 'transport' || type === 'uav') return 'Air';
        if (type === 'satellite' || type === 'spacecraft' || type === 'spaceplane') return 'Space';
        if (type === 'naval' || type === 'ship' || type === 'submarine') return 'Naval';
        if (type === 'ground' || type === 'sam' || type === 'ground_station' || type === 'radar' || type === 'static') return 'Ground';

        // Fallback: check physics component or altitude
        var physComp = entity.getComponent('physics');
        if (physComp) {
            var compType = physComp._type || physComp.constructor.name || '';
            if (compType.indexOf('orbital') !== -1 || compType.indexOf('Orbital') !== -1) return 'Space';
            if (compType.indexOf('flight') !== -1 || compType.indexOf('Flight') !== -1) return 'Air';
            if (compType.indexOf('naval') !== -1 || compType.indexOf('Naval') !== -1) return 'Naval';
        }

        // Altitude-based fallback
        if (state.alt != null) {
            if (state.alt > 100000) return 'Space';
            if (state.alt > 50) return 'Air';
        }

        return 'Ground';
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        init: init,
        tick: tick,
        showUI: showUI,
        showMissionBriefing: _showMissionBriefing,
        assumeControl: _assumeControl,

        get isPaused() { return _isPaused; },
        get timeWarp() { return _timeWarp; },
        get simElapsed() { return _simElapsed; },
        get playerEntity() { return _playerEntity; },
        get playerState() { return _playerState; },
        get world() { return _world; },
        get observerMode() { return _observerMode; },
        get cyberScore() { return _getCyberScoreSummary(); },
    };
})();
