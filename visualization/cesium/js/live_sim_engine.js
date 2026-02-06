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
    let _isSpaceplane = false;

    let _isPaused = false;
    let _timeWarp = 1;
    let _simElapsed = 0;
    let _lastTickTime = null;
    let _cameraMode = 'chase';
    let _plannerMode = false;
    let _lastRegime = 'ATMOSPHERIC';
    let _started = false;

    // Propulsion
    let _propModes = ['AIR', 'HYPERSONIC', 'ROCKET'];

    // Weapons & Sensors
    let _weaponList = [];       // [{name, type, count, maxCount}]
    let _weaponIndex = -1;      // -1 = no weapon selected
    let _sensorList = [];       // [{name, type}]
    let _sensorIndex = -1;      // -1 = no sensor active

    // Camera
    let _camHeadingOffset = 0;
    let _camPitch = -0.3;
    let _camRange = 150;
    let _camDragging = false;
    let _camDragStart = { x: 0, y: 0 };
    let _plannerCamRange = 5e7;

    // Trail
    let _playerTrail = [];
    let _trailCounter = 0;
    let _trailEntity = null;
    let _orbitPolyline = null;
    let _predictedOrbitPolyline = null;
    let _apMarker = null;
    let _peMarker = null;

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

        // Determine engine config from physics component
        var phys = entity.getComponent('physics');
        var physType = phys && phys.config && phys.config.type;

        if (physType === 'orbital_2body') {
            // Orbital entities use spaceplane config (handles vacuum, centrifugal, orbital mechanics)
            _playerConfig = FighterSimEngine.SPACEPLANE_CONFIG;
        } else if (phys && phys._engineConfig) {
            _playerConfig = phys._engineConfig;
        } else {
            // Fallback: check config name
            var configName = (phys && phys.config && phys.config.config) || 'f16';
            _playerConfig = (configName === 'spaceplane') ?
                FighterSimEngine.SPACEPLANE_CONFIG : FighterSimEngine.F16_CONFIG;
        }

        // Determine if spaceplane-capable (orbital entities are always spaceplane-capable)
        _isSpaceplane = physType === 'orbital_2body' ||
                        (_playerConfig === FighterSimEngine.SPACEPLANE_CONFIG) ||
                        (_playerConfig.spaceplane === true);

        // Determine available propulsion modes
        _propModes = _resolvePropModes(entity);

        // Set initial propulsion mode
        if (!_playerState.forcedPropMode) {
            _playerState.forcedPropMode = _propModes[0] || 'AIR';
            _playerState.propulsionMode = _playerState.forcedPropMode;
        }

        // For orbital entities, derive heading/gamma from ECI velocity
        if (physType === 'orbital_2body' && phys && phys._eciVel && phys._eciPos) {
            _deriveFlightStateFromECI(phys._eciPos, phys._eciVel, _playerState);
        }

        // Ensure critical state fields exist
        if (_playerState.throttle === undefined) _playerState.throttle = 0.6;
        if (_playerState.engineOn === undefined) _playerState.engineOn = true;
        if (_playerState.gearDown === undefined) _playerState.gearDown = false;
        if (_playerState.flapsDown === undefined) _playerState.flapsDown = false;
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

        // Create autopilot
        if (typeof FighterAutopilot !== 'undefined') {
            _autopilotState = FighterAutopilot.createAutopilotState();
        }

        // Build weapon & sensor lists from entity definition
        _initWeaponsAndSensors(entity);
    }

    function _resolvePropModes(entity) {
        // Check entity definition for propulsion config
        var def = entity.def || {};

        // From Platform Builder _custom metadata
        if (def._custom && def._custom.propulsion) {
            var p = def._custom.propulsion;
            var modes = [];
            if (p.air) modes.push('AIR');
            if (p.hypersonic) modes.push('HYPERSONIC');
            if (p.rocket) modes.push('ROCKET');
            if (modes.length > 0) return modes;
        }

        // From components.propulsion
        var compDef = (def.components && def.components.propulsion) || {};
        if (compDef.modes && compDef.modes.length > 0) {
            return compDef.modes.map(function(m) { return m.toUpperCase(); });
        }

        // Default based on config
        if (_isSpaceplane) return ['AIR', 'HYPERSONIC', 'ROCKET'];

        // Check physics type — orbital entities default to rocket
        var phys = entity.getComponent('physics');
        var physType = phys && phys.config && phys.config.type;
        if (physType === 'orbital_2body') return ['ROCKET', 'ION'];

        return ['AIR'];
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

        // Default: aircraft always have radar
        if (!_sensorList.length && (def.type === 'aircraft' || def.type === 'fighter')) {
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
        _sensorIndex = (_sensorIndex + 1) % _sensorList.length;
        var s = _sensorList[_sensorIndex];
        _showMessage('SENSOR: ' + s.name);
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
        // ECI velocity from the Kepler propagator INCLUDES Earth rotation, so we must
        // subtract ω×r to get the non-rotating-frame speed the physics engine expects.
        // Otherwise, the initial speed is ~494 m/s too high at the equator.
        vE_comp -= OMEGA * R * cosLat;

        var vHoriz = Math.sqrt(vE_comp * vE_comp + vN_comp * vN_comp);

        // Heading (azimuth from North, clockwise)
        state.heading = Math.atan2(vE_comp, vN_comp);

        // Flight path angle (positive = climbing)
        state.gamma = Math.atan2(vU_comp, vHoriz);

        // Speed: use magnitude after removing Earth rotation (non-rotating frame speed)
        var vNonRot = Math.sqrt(vE_comp * vE_comp + vN_comp * vN_comp + vU_comp * vU_comp);
        if (!state.speed || state.speed < 100) {
            state.speed = vNonRot;
        }
    }

    // -----------------------------------------------------------------------
    // Orbit visualization entities
    // -----------------------------------------------------------------------
    function _createOrbitEntities() {
        // Trail polyline
        _trailEntity = _viewer.entities.add({
            name: 'Player Trail',
            polyline: {
                positions: new Cesium.CallbackProperty(function() { return _playerTrail; }, false),
                width: 2,
                material: Cesium.Color.CYAN.withAlpha(0.6),
            },
        });

        if (!_isSpaceplane) return;

        // Current orbit (green)
        _orbitPolyline = _viewer.entities.add({
            name: 'Current Orbit',
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return (typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.currentOrbitPositions) ?
                        SpaceplaneOrbital.currentOrbitPositions : [];
                }, false),
                width: 2,
                material: Cesium.Color.LIME.withAlpha(0.7),
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
    function _setupCameraHandlers() {
        var container = document.getElementById('cesiumContainer');

        container.addEventListener('mousedown', function(e) {
            if (_cameraMode === 'free') return;
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
            if (_cameraMode === 'free') return;
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
            if (_cameraMode !== 'free') e.preventDefault();
        });
    }

    function _positionInitialCamera() {
        if (!_playerState) return;
        var pos = Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, _playerState.alt);
        var range = _playerState.alt > 100000 ? 5000 : 200;
        _viewer.camera.lookAt(pos,
            new Cesium.HeadingPitchRange(_playerState.heading || 0, -0.3, range));
        _camRange = range;
    }

    function _updateCamera() {
        if (!_playerState || _cameraMode === 'free') return;

        var pos = Cesium.Cartesian3.fromRadians(_playerState.lon, _playerState.lat, _playerState.alt);

        if (_plannerMode) {
            _viewer.camera.lookAt(pos,
                new Cesium.HeadingPitchRange(
                    _playerState.heading + _camHeadingOffset,
                    -Math.PI / 2.5,
                    _plannerCamRange
                ));
            return;
        }

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

            // Aircraft body frame: heading + pitch + roll
            var h = _playerState.heading + _camHeadingOffset;
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
        var modes = ['chase', 'cockpit', 'free'];
        var idx = modes.indexOf(_cameraMode);
        _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        _cameraMode = modes[(idx + 1) % modes.length];
        _viewer.scene.screenSpaceCameraController.enableInputs = (_cameraMode !== 'cockpit');

        // Hide player point in cockpit mode
        var vis = _playerEntity.getComponent('visual');
        if (vis && vis._cesiumEntity) {
            vis._cesiumEntity.show = (_cameraMode !== 'cockpit');
        }

        if (_cameraMode === 'chase') {
            _camHeadingOffset = 0;
            _camPitch = -0.3;
            _camRange = 150;
        }
        _setText('camMode', _cameraMode.toUpperCase());
        _showMessage('Camera: ' + _cameraMode.toUpperCase());
    }

    function _togglePlannerMode() {
        if (!_isSpaceplane) return;
        _plannerMode = !_plannerMode;

        var modeEl = document.getElementById('modeIndicator');
        if (modeEl) modeEl.style.display = _plannerMode ? 'block' : 'none';

        if (_plannerMode) {
            _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            _plannerCamRange = Math.max(_playerState.alt * 5, 5e6);
            _showMessage('PLANNER MODE');
        } else {
            _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            _cameraMode = 'chase';
            _viewer.scene.screenSpaceCameraController.enableInputs = true;
            _camHeadingOffset = 0;
            _camPitch = -0.3;
            _camRange = _playerState.alt > 100000 ? 5000 : 150;
            _setText('camMode', 'CHASE');
            _showMessage('COCKPIT MODE');
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
                switch (e.code) {
                    case 'KeyM': _togglePlannerMode(); break;
                    case 'KeyN':
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            SpaceplanePlanner.createNode(_playerState, _simElapsed);
                            _showMessage('MANEUVER NODE CREATED');
                        } break;
                    case 'Delete': case 'Backspace':
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            SpaceplanePlanner.deleteSelectedNode();
                            _showMessage('NODE DELETED');
                        } break;
                    case 'Enter': case 'NumpadEnter':
                        if (typeof SpaceplanePlanner !== 'undefined') {
                            SpaceplanePlanner.executeNode(_playerState, _simElapsed);
                            _showMessage('EXECUTING NODE');
                        } break;
                    case 'KeyP': _cyclePropulsionMode(); break;
                    case 'Escape':
                        _isPaused = !_isPaused;
                        _setText('pauseStatus', _isPaused ? 'PAUSED' : 'RUNNING');
                        _showMessage(_isPaused ? 'PAUSED' : 'RESUMED');
                        if (!_isPaused) _lastTickTime = null;
                        break;
                    case 'Equal': case 'NumpadAdd':
                        _timeWarp = Math.min(_timeWarp * 2, 1024);
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

            // Normal cockpit mode
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
                case 'KeyB':
                    _playerState.brakesOn = !_playerState.brakesOn;
                    _showMessage(_playerState.brakesOn ? 'BRAKES ON' : 'BRAKES OFF');
                    break;
                case 'KeyA':
                    if (_autopilotState && typeof FighterAutopilot !== 'undefined') {
                        FighterAutopilot.toggle(_autopilotState, _playerState);
                        _showMessage(_autopilotState.enabled ? 'AUTOPILOT ON' : 'AUTOPILOT OFF');
                    }
                    break;
                case 'KeyT':
                    _adjustTrim(e.shiftKey ? -1 : 1);
                    break;
                case 'KeyP': _cyclePropulsionMode(); break;
                case 'KeyM': _togglePlannerMode(); break;
                case 'KeyC': _cycleCamera(); break;
                case 'KeyH': _togglePanel('help'); break;
                case 'Equal': case 'NumpadAdd':
                    _timeWarp = Math.min(_timeWarp * 2, 1024);
                    _setText('timeWarpDisplay', _timeWarp + 'x');
                    _showMessage('TIME WARP: ' + _timeWarp + 'x');
                    break;
                case 'Minus': case 'NumpadSubtract':
                    _timeWarp = Math.max(_timeWarp / 2, 0.25);
                    _setText('timeWarpDisplay', _timeWarp + 'x');
                    _showMessage('TIME WARP: ' + _timeWarp + 'x');
                    break;
                case 'KeyN':
                    if (_isSpaceplane && typeof SpaceplanePlanner !== 'undefined') {
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
            if (handled) { e.preventDefault(); e.stopPropagation(); }
        }, true);

        window.addEventListener('keyup', function(e) {
            _keys[e.code] = false;
            if (_started) {
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

        controls.throttleUp = _keys['KeyW'];
        controls.throttleDown = _keys['KeyS'];

        if (_keys['ArrowDown']) controls.pitch = 1;
        else if (_keys['ArrowUp']) controls.pitch = -1;
        else controls.pitch = 0;

        if (_keys['ArrowLeft'] && !_keys['ControlLeft'] && !_keys['ControlRight']) controls.roll = -1;
        else if (_keys['ArrowRight'] && !_keys['ControlLeft'] && !_keys['ControlRight']) controls.roll = 1;
        else controls.roll = 0;

        // Yaw: Ctrl+Arrow OR Q/D keys (Q=left, D=right — natural for orbital rotation)
        if ((_keys['ControlLeft'] || _keys['ControlRight']) && _keys['ArrowLeft'] || _keys['KeyQ']) controls.yaw = -1;
        else if ((_keys['ControlLeft'] || _keys['ControlRight']) && _keys['ArrowRight'] || _keys['KeyD']) controls.yaw = 1;
        else controls.yaw = 0;

        return controls;
    }

    // -----------------------------------------------------------------------
    // Pitch trim
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Propulsion mode cycling
    // -----------------------------------------------------------------------
    function _cyclePropulsionMode() {
        if (!_playerState || _propModes.length <= 1) return;
        var cur = _playerState.forcedPropMode || _propModes[0];
        var idx = _propModes.indexOf(cur);
        var next = _propModes[(idx + 1) % _propModes.length];
        _playerState.forcedPropMode = next;
        _playerState.propulsionMode = next;
        _setText('propModeDisplay', next);
        var propColor = next === 'ROCKET' ? 'alert' : next === 'HYPERSONIC' ? 'warn' : '';
        _setTextWithClass('sysProp', next, propColor);
        _showMessage('PROPULSION: ' + next);
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

        // 4. Update player trail
        _trailCounter++;
        if (_trailCounter % 10 === 0) {
            _playerTrail.push(Cesium.Cartesian3.fromRadians(
                _playerState.lon, _playerState.lat, _playerState.alt));
            if (_playerTrail.length > 1000) _playerTrail.shift();
        }

        // 5. Update orbital state
        if (_isSpaceplane && typeof SpaceplaneOrbital !== 'undefined') {
            try {
                SpaceplaneOrbital.update(_playerState, _simElapsed);
            } catch (orbErr) {
                console.warn('Orbital update error (escape?):', orbErr.message);
                // Clear orbit display on error to prevent stale polylines
                if (SpaceplaneOrbital.currentOrbitPositions) {
                    SpaceplaneOrbital.currentOrbitPositions.length = 0;
                }
            }
        }

        // 6. Update planner
        if (_isSpaceplane && typeof SpaceplanePlanner !== 'undefined') {
            SpaceplanePlanner.update(_playerState, _simElapsed);
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
                    allSensors: _sensorList,
                    sensorIndex: _sensorIndex
                } : null;
                // Attach sensor/trim to state for HUD display
                _playerState._sensor = sensorHud;
                _playerState._trim = _playerState.trimAlpha;
                FighterHUD.render(_playerState, _autopilotState, weaponHud, null, _simElapsed);

                if (_isSpaceplane && typeof SpaceplaneHUD !== 'undefined' && _playerState.alt > 30000) {
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

        var propMode = _playerState.propulsionMode || 'AIR';
        var propColor = propMode === 'ROCKET' ? 'alert' : propMode === 'HYPERSONIC' ? 'warn' : '';
        _setTextWithClass('sysProp', propMode, propColor);
        _setText('propModeDisplay', propMode);

        _setText('sysGear', _playerState.gearDown ? 'DOWN' : 'UP');
        _setText('sysFlaps', _playerState.flapsDown ? 'DOWN' : 'UP');
        _setText('sysBrakes', _playerState.brakesOn ? 'ON' : 'OFF');

        // Flight regime
        if (_isSpaceplane && typeof SpaceplaneOrbital !== 'undefined' && SpaceplaneOrbital.flightRegime) {
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
        if (typeof SpaceplaneOrbital === 'undefined' || !_isSpaceplane) return;

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

        _setText('orbTAP', elems.timeToApoapsis != null ? _formatTime(elems.timeToApoapsis) : '---');
        _setText('orbTPE', elems.timeToPeriapsis != null ? _formatTime(elems.timeToPeriapsis) : '---');

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
            if (panel) _togglePanel(panel);
            else if (hudKey) _toggleHud(hudKey);
        });

        _syncSettingsUI();
    }

    function _syncSettingsUI() {
        var dropdown = document.getElementById('settingsDropdown');
        if (!dropdown) return;

        var items = dropdown.querySelectorAll('.settings-item');
        for (var i = 0; i < items.length; i++) {
            var panel = items[i].getAttribute('data-panel');
            var hudKey = items[i].getAttribute('data-hud');
            var isActive = false;

            if (panel) {
                if (panel === 'orbital') {
                    isActive = _panelVisible.orbital !== 'off';
                } else {
                    isActive = !!_panelVisible[panel];
                }
            } else if (hudKey && typeof FighterHUD !== 'undefined' && FighterHUD.toggles) {
                isActive = !!FighterHUD.toggles[hudKey];
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
