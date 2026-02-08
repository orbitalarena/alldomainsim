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

    let _isPaused = false;
    let _timeWarp = 1;
    let _simElapsed = 0;
    let _lastTickTime = null;
    let _cameraMode = 'chase';
    let _plannerMode = false;
    let _lastRegime = 'ATMOSPHERIC';
    let _started = false;

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
        optical: { css: 'grayscale(1) contrast(1.2)', noise: 0.12, label: 'EO | B&W' },
        ir:      { css: 'grayscale(1) invert(0.85) contrast(1.8) brightness(1.1)', noise: 0.08, label: 'FLIR | WHT-HOT' }
    };

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
    let _orbitPolyline = null;
    let _eciOrbitPolyline = null;
    let _predictedOrbitPolyline = null;
    let _apMarker = null;
    let _peMarker = null;
    let _anMarker = null;
    let _dnMarker = null;

    // Display toggles (persisted in localStorage)
    let _showEciOrbit = false;
    let _showEcefOrbit = true;
    let _orbitRevs = 1;
    let _showTrail = true;
    let _trailDurationSec = 0;  // 0 = infinite

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

        _world = ScenarioLoader.build(scenarioJson, viewer);

        // 2. Select player entity
        _playerEntity = _selectPlayer(_world, playerIdParam);
        if (!_playerEntity) {
            throw new Error('No controllable aircraft found in scenario');
        }

        // 3. Hijack player from ECS
        _hijackPlayer(_playerEntity);

        // 4. Initialize cockpit systems
        _initCockpit(_playerEntity);

        // 5. Create orbit visualization entities
        _createOrbitEntities();

        // 6. Build entity list for UI
        _buildEntityList();

        // 7. Setup camera handlers
        _setupCameraHandlers();

        // 8. Setup keyboard
        _setupKeyboard();

        // 9. Init settings gear (load prefs, wire handlers)
        _initSettingsGear();

        // 9b. Init planner click handler (orbit click → create node)
        _initPlannerClickHandler();

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

        _started = true;
        _lastTickTime = null;

        return {
            world: _world,
            playerEntity: _playerEntity,
            playerName: _playerEntity.name,
            entityCount: _world.entities.size
        };
    }

    // -----------------------------------------------------------------------
    // Player selection
    // -----------------------------------------------------------------------
    function _selectPlayer(world, preferredId) {
        // Preferred ID
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

        // First entity with any physics
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
        var phys = entity.getComponent('physics');
        var physType = phys && phys.config && phys.config.type;

        if (physType === 'orbital_2body') {
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

        // Set initial propulsion mode — high-altitude entities default to first ROCKET
        // (AIR mode has zero thrust at orbital altitude due to density lapse)
        if (!_playerState.forcedPropMode) {
            var defaultEntry = _propModes[0];
            var isHighAlt = (_playerState.alt || 0) > 100000;
            if (isHighAlt) {
                for (var pi = 0; pi < _propModes.length; pi++) {
                    if (_propModes[pi].mode === 'ROCKET') {
                        defaultEntry = _propModes[pi];
                        _propModeIndex = pi;
                        break;
                    }
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
        if (_playerState.phase === 'PARKED' || _playerState.phase === 'LANDED') {
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

        // Create or update noise overlay
        _startSensorNoise(filter.noise);
    }

    function _removeSensorViewEffects() {
        var container = document.getElementById('cesiumContainer');
        if (container) container.style.filter = '';
        _activeSensorFilter = null;
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
        _world.entities.forEach(function(entity) {
            _entityListItems.push({
                id: entity.id,
                name: entity.name,
                type: entity.type,
                team: entity.team,
                isPlayer: entity.id === _playerEntity.id,
                entity: entity,
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
            _camHeadingOffset += dx * 0.005;
            _camPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(0.3, _camPitch - dy * 0.005));
        });

        window.addEventListener('mouseup', function() { _camDragging = false; });

        container.addEventListener('wheel', function(e) {
            if (_cameraMode === 'free' || _isGlobeMode()) return;
            if (_plannerMode) {
                _plannerCamRange *= (1 + e.deltaY * 0.001);
                _plannerCamRange = Math.max(1e5, Math.min(1e8, _plannerCamRange));
            } else {
                _camRange *= (1 + e.deltaY * 0.001);
                _camRange = Math.max(20, Math.min(50000, _camRange));
            }
            e.preventDefault();
        }, { passive: false });

        container.addEventListener('contextmenu', function(e) {
            if (_cameraMode !== 'free' && !_isGlobeMode()) e.preventDefault();
        });
    }

    function _positionInitialCamera() {
        if (!_playerState) return;
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

    function _cycleCamera() {
        if (_plannerMode) return;
        var modes = ['chase', 'cockpit', 'free', 'earth', 'moon'];
        var idx = modes.indexOf(_cameraMode);

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
        var vis = _playerEntity.getComponent('visual');
        if (vis && vis._cesiumEntity) {
            vis._cesiumEntity.show = (_cameraMode !== 'cockpit');
        }

        // HUD visibility — hide in globe modes
        var hudCanvas = document.getElementById('hudCanvas');
        if (hudCanvas) hudCanvas.style.display = isGlobe ? 'none' : 'block';

        // Remove sensor view effects in globe/free modes (restore on chase/cockpit)
        if (isGlobe || _cameraMode === 'free') {
            _removeSensorViewEffects();
        } else if (_sensorIndex >= 0 && SENSOR_FILTERS[_sensorList[_sensorIndex].type]) {
            // Restore sensor view effects when returning to chase/cockpit
            _applySensorViewEffects(_sensorList[_sensorIndex].type);
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
                        var dvPerFrameAt1x = dvPerSecondAt1x / 60;
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
                            // Done when SMA is within 10km of target radius and ecc < 0.01
                            burnDone = Math.abs(curSMA - tR) < 10000 || curEcc < 0.003;
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
            _keys[e.code] = true;
            if (e.repeat) return;

            var handled = true;

            // Panel toggles in both modes
            if (_handlePanelToggle(e.code)) {
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
                        _cyclePropulsionMode();
                        _updatePlannerEngineParams();
                        break;
                    case 'Escape':
                        if (_autoExecState) {
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
                    case 'KeyH': _togglePanel('help'); break;
                    default: handled = false; break;
                }
                if (handled) { e.preventDefault(); e.stopPropagation(); }
                return;
            }

            // In globe modes, only handle camera/meta keys — pass rest to Cesium
            if (_cameraMode === 'earth' || _cameraMode === 'moon') {
                switch (e.code) {
                    case 'Escape':
                        _isPaused = !_isPaused;
                        _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                        _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                        if (!_isPaused) _lastTickTime = null;
                        break;
                    case 'KeyC': _cycleCamera(); break;
                    case 'KeyG':
                        _globeControlsEnabled = !_globeControlsEnabled;
                        _showMessage('Flight controls: ' + (_globeControlsEnabled ? 'ON' : 'OFF'));
                        break;
                    case 'KeyH': _togglePanel('help'); break;
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
                    _isPaused = !_isPaused;
                    _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                    _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                    if (!_isPaused) _lastTickTime = null;
                    break;
                case 'Space':
                    _fireWeapon();
                    break;
                case 'KeyW':
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
                    if (_autopilotState && typeof FighterAutopilot !== 'undefined') {
                        FighterAutopilot.toggle(_autopilotState, _playerState);
                        _showMessage(_autopilotState.enabled ? 'AUTOPILOT ON' : 'AUTOPILOT OFF');
                    }
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
                    _cyclePropulsionMode();
                    break;
                case 'KeyM': _togglePlannerMode(); break;
                case 'KeyC': _cycleCamera(); break;
                case 'KeyH': _togglePanel('help'); break;
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
                    if (typeof SpaceplanePlanner !== 'undefined') {
                        SpaceplanePlanner.createNode(_playerState, _simElapsed);
                        _showMessage('MANEUVER NODE CREATED');
                    }
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
    // Main tick
    // -----------------------------------------------------------------------
    function tick() {
        if (!_started || !_playerState) return;
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

        // 3. Step player physics (sub-stepped)
        var maxSubDt = 0.05;
        var maxSubSteps = 500;
        var remaining = totalDt;
        var steps = 0;
        while (remaining > 0 && steps < maxSubSteps) {
            var subDt = Math.min(remaining, maxSubDt);
            FighterSimEngine.step(_playerState, controls, subDt, _playerConfig);
            remaining -= subDt;
            steps++;
        }

        // 3b. Auto-execute state machine (warp/orient/burn)
        if (_autoExecState) _tickAutoExec(totalDt);

        // 3c. Quest system update
        if (_questActive) _tickQuest();

        // 4. Update player trail (with time-based trimming)
        _trailCounter++;
        if (_trailCounter % 10 === 0) {
            _playerTrail.push(Cesium.Cartesian3.fromRadians(
                _playerState.lon, _playerState.lat, _playerState.alt));
            _playerTrailTimes.push(_simElapsed);
            // Time-based trim
            if (_trailDurationSec > 0) {
                var cutoff = _simElapsed - _trailDurationSec;
                while (_playerTrailTimes.length > 0 && _playerTrailTimes[0] < cutoff) {
                    _playerTrailTimes.shift();
                    _playerTrail.shift();
                }
            } else if (_playerTrail.length > 100000) {
                // Infinite mode cap
                _playerTrail.shift();
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

        // --- Check player death ---
        if (!_playerEntity.active) {
            _showMessage('DESTROYED', 5000);
        }

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
                // Attach sensor/trim to state for HUD display
                _playerState._sensor = sensorHud;
                _playerState._trim = _playerState.trimAlpha;
                FighterHUD.render(_playerState, _autopilotState, weaponHud, null, _simElapsed);

                if (typeof SpaceplaneHUD !== 'undefined' && _playerState.alt > 30000) {
                    SpaceplaneHUD.renderOverlay(hudCanvas, _playerState, _simElapsed);
                }
            }
        }

        // 10. Update UI panels
        _updateFlightDataPanel();
        _updateSystemsPanel();
        _updateOrbitalPanel();
        _updateTimeDisplay();
        _updateEntityListPanel();
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
        var mins = Math.floor(_simElapsed / 60);
        var secs = Math.floor(_simElapsed % 60);
        _setText('simTime', mins + ':' + secs.toString().padStart(2, '0'));
    }

    var _entityListThrottle = 0;
    function _updateEntityListPanel() {
        _entityListThrottle++;
        if (_entityListThrottle % 30 !== 0) return; // ~2Hz at 60fps

        var listEl = document.getElementById('entityListInner');
        if (!listEl) return;

        var html = '';
        for (var i = 0; i < _entityListItems.length; i++) {
            var item = _entityListItems[i];
            var alive = item.entity.active;
            var teamColor = item.team === 'blue' ? '#4488ff' :
                item.team === 'red' ? '#ff4444' : '#888888';
            var statusIcon = alive ? '\u25CF' : '\u2716';
            var style = alive ? '' : 'opacity:0.4;text-decoration:line-through;';
            var playerTag = item.isPlayer ? ' <span style="color:#44aaff">[YOU]</span>' : '';

            html += '<div class="entity-row" style="' + style + '">' +
                '<span style="color:' + teamColor + '">' + statusIcon + '</span> ' +
                '<span class="entity-name">' + item.name + '</span>' + playerTag +
                ' <span class="entity-type">' + item.type + '</span>' +
                '</div>';
        }
        listEl.innerHTML = html;
    }

    // -----------------------------------------------------------------------
    // Panel toggles
    // -----------------------------------------------------------------------
    function _handlePanelToggle(code) {
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
        switch (code) {
            case 'Digit1': case 'Numpad1': _togglePanel('flightData'); return true;
            case 'Digit2': case 'Numpad2': _togglePanel('systems'); return true;
            case 'Digit3': case 'Numpad3': _togglePanel('entityList'); return true;
            case 'KeyO': _togglePanel('orbital'); return true;
            case 'Tab': _toggleAllPanels(); return true;
            default: return false;
        }
    }

    function _togglePanel(name) {
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

        var btn = document.getElementById('settingsBtn');
        var dropdown = document.getElementById('settingsDropdown');
        if (!btn || !dropdown) return;

        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var isOpen = dropdown.classList.toggle('open');
            btn.classList.toggle('open', isOpen);
        });

        // Close dropdown when clicking elsewhere
        document.addEventListener('click', function() {
            dropdown.classList.remove('open');
            btn.classList.remove('open');
        });

        // Single delegated click handler for all settings items
        dropdown.addEventListener('click', function(e) {
            e.stopPropagation();
            var item = e.target.closest('.settings-item');
            if (!item) return;
            var panel = item.getAttribute('data-panel');
            var hudKey = item.getAttribute('data-hud');
            var traceKey = item.getAttribute('data-trace');
            if (panel) _togglePanel(panel);
            else if (hudKey) _toggleHud(hudKey);
            else if (traceKey) _toggleTrace(traceKey);
        });

        // Orbit revolutions selector
        var revSelect = document.getElementById('orbitRevSelect');
        if (revSelect) {
            revSelect.value = String(_orbitRevs);
            revSelect.addEventListener('change', function() {
                _orbitRevs = parseInt(revSelect.value) || 1;
                _showMessage('ORBIT REVS: ' + _orbitRevs);
                _savePanelPrefs();
            });
        }

        // Trail duration input
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

        _syncSettingsUI();
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
                else if (traceKey === 'trail') isActive = _showTrail;
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
                if (prefs.orbitRevs !== undefined) _orbitRevs = prefs.orbitRevs;
                if (prefs.showTrail !== undefined) _showTrail = prefs.showTrail;
                if (prefs.trailDurationSec !== undefined) _trailDurationSec = prefs.trailDurationSec;
                // Restore HUD element toggles
                if (prefs.hudToggles && typeof FighterHUD !== 'undefined' && FighterHUD.setToggle) {
                    var keys = Object.keys(prefs.hudToggles);
                    for (var i = 0; i < keys.length; i++) {
                        FighterHUD.setToggle(keys[i], prefs.hudToggles[keys[i]]);
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    function _savePanelPrefs() {
        try {
            var data = JSON.parse(JSON.stringify(_panelVisible));
            // Include trace/orbit display settings
            data.showEcefOrbit = _showEcefOrbit;
            data.showEciOrbit = _showEciOrbit;
            data.orbitRevs = _orbitRevs;
            data.showTrail = _showTrail;
            data.trailDurationSec = _trailDurationSec;
            // Include HUD toggle states
            if (typeof FighterHUD !== 'undefined' && FighterHUD.getToggles) {
                data.hudToggles = FighterHUD.getToggles();
            }
            localStorage.setItem('livesim_panels', JSON.stringify(data));
        } catch (e) { /* ignore */ }
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
    // Public API
    // -----------------------------------------------------------------------
    return {
        init: init,
        tick: tick,
        showUI: showUI,

        get isPaused() { return _isPaused; },
        get timeWarp() { return _timeWarp; },
        get simElapsed() { return _simElapsed; },
        get playerEntity() { return _playerEntity; },
        get playerState() { return _playerState; },
        get world() { return _world; },
    };
})();
