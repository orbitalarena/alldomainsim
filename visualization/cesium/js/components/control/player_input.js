/**
 * PlayerInput component — keyboard input -> entity.state._commands
 *
 * Supports two modes:
 *   "fighter"    — F-16 style controls (throttle, pitch, roll, yaw, toggle keys)
 *   "spaceplane" — adds propulsion mode cycling (P), time warp, orbital controls
 *
 * Key bindings match the existing fighter_sim_viewer.html and spaceplane_viewer.html.
 * Toggle keys (E, G, F, B, P, Space, etc.) fire on keydown (non-repeat).
 * Continuous keys (WASD, arrows) are read every frame from the key map.
 */
(function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;

    // Shared key state — one global listener drives all PlayerInput components.
    // (Only one player entity per scenario, but this avoids duplicate listeners.)
    const _keys = {};
    const _justPressed = {};   // set true on keydown (non-repeat), cleared after read
    let _listenerInstalled = false;

    function _installListeners() {
        if (_listenerInstalled) return;
        _listenerInstalled = true;

        window.addEventListener('keydown', function(e) {
            _keys[e.code] = true;
            if (!e.repeat) {
                _justPressed[e.code] = true;
            }
        }, true);

        window.addEventListener('keyup', function(e) {
            _keys[e.code] = false;
        }, true);
    }

    /** Consume a just-pressed key (returns true once per press). */
    function _consume(code) {
        if (_justPressed[code]) {
            _justPressed[code] = false;
            return true;
        }
        return false;
    }

    class PlayerInput extends ECS.Component {
        constructor(config) {
            super(config);
            this._mode = config.config || 'fighter';  // 'fighter' or 'spaceplane'
        }

        init(world) {
            _installListeners();
            this._world = world;
        }

        update(dt, world) {
            const state = this.entity.state;
            const commands = {};

            // --- Continuous controls ---

            // Throttle
            commands.throttleUp = !!_keys['KeyW'];
            commands.throttleDown = !!_keys['KeyS'];

            // Pitch (down arrow = pull back = pitch up)
            if (_keys['ArrowDown']) commands.pitch = 1;
            else if (_keys['ArrowUp']) commands.pitch = -1;
            else commands.pitch = 0;

            // Roll (left arrow = roll left)
            const ctrlDown = _keys['ControlLeft'] || _keys['ControlRight'];
            if (_keys['ArrowLeft'] && !ctrlDown) commands.roll = -1;
            else if (_keys['ArrowRight'] && !ctrlDown) commands.roll = 1;
            else commands.roll = 0;

            // Yaw (Ctrl + arrows, or Q/E for spaceplane)
            if (ctrlDown && _keys['ArrowLeft']) commands.yaw = -1;
            else if (ctrlDown && _keys['ArrowRight']) commands.yaw = 1;
            else if (this._mode === 'spaceplane' && _keys['KeyQ']) commands.yaw = -1;
            else if (this._mode === 'spaceplane' && _keys['KeyE']) commands.yaw = 1;
            else commands.yaw = 0;

            state._commands = commands;

            // --- Toggle keys (non-repeat) ---
            this._handleToggles(state, world);
        }

        _handleToggles(state, world) {
            // Engine toggle
            if (this._mode === 'fighter') {
                if (_consume('KeyE')) {
                    state.engineOn = !state.engineOn;
                    _showMessage(state.engineOn ? 'ENGINE START' : 'ENGINE STOP');
                }
            }
            // Spaceplane engine is always on; E is yaw so toggle via different key
            // (could add a separate key in future)

            // Gear
            if (_consume('KeyG')) {
                state.gearDown = !state.gearDown;
                state.gearTransition = 3;
                _showMessage(state.gearDown ? 'GEAR DOWN' : 'GEAR UP');
            }

            // Flaps
            if (_consume('KeyF')) {
                state.flapsDown = !state.flapsDown;
                _showMessage(state.flapsDown ? 'FLAPS DOWN' : 'FLAPS UP');
            }

            // Brakes
            if (_consume('KeyB')) {
                state.brakesOn = !state.brakesOn;
                _showMessage(state.brakesOn ? 'BRAKES ON' : 'BRAKES OFF');
            }

            // Pause
            if (_consume('Space')) {
                world.isPaused = !world.isPaused;
                _showMessage(world.isPaused ? 'PAUSED' : 'RESUMED');
                if (!world.isPaused) world._lastTickTime = null;
            }

            // Time warp
            const maxWarp = world._maxTimeWarp || 1024;
            if (_consume('Equal') || _consume('NumpadAdd')) {
                world.timeWarp = Math.min(world.timeWarp * 2, maxWarp);
                _showMessage('TIME WARP: ' + world.timeWarp + 'x');
            }
            if (_consume('Minus') || _consume('NumpadSubtract')) {
                world.timeWarp = Math.max(world.timeWarp / 2, 0.25);
                _showMessage('TIME WARP: ' + world.timeWarp + 'x');
            }

            // Camera cycle
            if (_consume('KeyC')) {
                _cycleCamera(world);
            }

            // Controls help
            if (_consume('KeyH')) {
                const help = document.getElementById('scenarioControlsHelp');
                if (help) help.style.display = help.style.display === 'none' ? 'block' : 'none';
            }

            // Propulsion mode cycle (spaceplane only)
            if (this._mode === 'spaceplane' && _consume('KeyP')) {
                const modes = FighterSimEngine.PROP_MODES;
                const cur = state.forcedPropMode || 'AIR';
                const idx = modes.indexOf(cur);
                state.forcedPropMode = modes[(idx + 1) % modes.length];
                _showMessage('PROPULSION: ' + state.forcedPropMode);
            }

            // Panel toggles (1/2/3)
            if (_consume('Digit1')) {
                _togglePanel('scenarioFlightPanel');
            }
            if (_consume('Digit2')) {
                _togglePanel('scenarioSystemsPanel');
            }
            if (_consume('Tab')) {
                _toggleAllPanels();
            }
        }
    }

    // --- Camera ---
    let _cameraMode = 'chase';
    let _camHeadingOffset = 0;
    let _camPitch = -0.3;
    let _camRange = 200;
    let _camDragging = false;
    let _camDragStart = { x: 0, y: 0 };

    function _setupCameraControls(world) {
        const container = document.getElementById('cesiumContainer');
        if (!container) return;

        container.addEventListener('mousedown', function(e) {
            if (_cameraMode !== 'chase') return;
            if (e.shiftKey || e.button === 2) {
                _camDragging = true;
                _camDragStart = { x: e.clientX, y: e.clientY };
                e.preventDefault();
            }
        });
        window.addEventListener('mousemove', function(e) {
            if (!_camDragging) return;
            const dx = e.clientX - _camDragStart.x;
            const dy = e.clientY - _camDragStart.y;
            _camDragStart = { x: e.clientX, y: e.clientY };
            _camHeadingOffset += dx * 0.005;
            _camPitch = Math.max(-Math.PI / 2 + 0.05, Math.min(0.3, _camPitch - dy * 0.005));
        });
        window.addEventListener('mouseup', function() { _camDragging = false; });
        container.addEventListener('wheel', function(e) {
            if (_cameraMode !== 'chase') return;
            _camRange *= (1 + e.deltaY * 0.001);
            _camRange = Math.max(20, Math.min(50000, _camRange));
            e.preventDefault();
        }, { passive: false });
        container.addEventListener('contextmenu', function(e) {
            if (_cameraMode === 'chase') e.preventDefault();
        });
    }

    let _cameraControlsInstalled = false;

    /**
     * Update camera based on player entity position.
     * Called by VisualizationSystem (via CesiumEntity) or standalone.
     */
    function updateCamera(world) {
        const player = world._playerEntity;
        if (!player || _cameraMode === 'free') return;

        if (!_cameraControlsInstalled) {
            _setupCameraControls(world);
            _cameraControlsInstalled = true;
        }

        const s = player.state;
        const pos = Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.alt);

        if (_cameraMode === 'chase') {
            world.viewer.camera.lookAt(
                pos,
                new Cesium.HeadingPitchRange(
                    s.heading + _camHeadingOffset,
                    _camPitch,
                    _camRange
                )
            );
        } else if (_cameraMode === 'cockpit') {
            _updateCockpitCamera(world.viewer, pos, s);
        }
    }

    function _updateCockpitCamera(viewer, pos, state) {
        const enuT = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
        const em = Cesium.Matrix4.getMatrix3(enuT, new Cesium.Matrix3());
        const E = new Cesium.Cartesian3(em[0], em[1], em[2]);
        const N = new Cesium.Cartesian3(em[3], em[4], em[5]);
        const U = new Cesium.Cartesian3(em[6], em[7], em[8]);

        function lc(a, v1, b, v2) {
            const r = new Cesium.Cartesian3();
            Cesium.Cartesian3.add(
                Cesium.Cartesian3.multiplyByScalar(v1, a, new Cesium.Cartesian3()),
                Cesium.Cartesian3.multiplyByScalar(v2, b, new Cesium.Cartesian3()),
                r);
            return r;
        }

        const h = state.heading;
        const p = state.pitch;
        const r = -state.roll;

        let fwd = lc(Math.sin(h), E, Math.cos(h), N);
        let rgt = lc(Math.cos(h), E, -Math.sin(h), N);
        let up = Cesium.Cartesian3.clone(U);

        const fwd2 = lc(Math.cos(p), fwd, Math.sin(p), up);
        const up2 = lc(-Math.sin(p), fwd, Math.cos(p), up);
        fwd = fwd2;
        up = up2;

        const rgt2 = lc(Math.cos(r), rgt, Math.sin(r), up);
        const up3 = lc(-Math.sin(r), rgt, Math.cos(r), up);
        rgt = rgt2;
        up = up3;

        const camPos = Cesium.Cartesian3.clone(pos);
        Cesium.Cartesian3.add(camPos,
            Cesium.Cartesian3.multiplyByScalar(fwd, 20, new Cesium.Cartesian3()), camPos);
        Cesium.Cartesian3.add(camPos,
            Cesium.Cartesian3.multiplyByScalar(up, 2, new Cesium.Cartesian3()), camPos);

        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        viewer.camera.position = camPos;
        viewer.camera.direction = Cesium.Cartesian3.normalize(fwd, fwd);
        viewer.camera.up = Cesium.Cartesian3.normalize(up, up);
        viewer.camera.right = Cesium.Cartesian3.normalize(rgt, rgt);
    }

    function _cycleCamera(world) {
        const modes = ['chase', 'cockpit', 'free'];
        const idx = modes.indexOf(_cameraMode);
        world.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        _cameraMode = modes[(idx + 1) % modes.length];
        world.viewer.scene.screenSpaceCameraController.enableInputs = (_cameraMode !== 'cockpit');

        // Hide player visual entity in cockpit
        const player = world._playerEntity;
        if (player) {
            const vis = player.getComponent('visual');
            if (vis && vis._cesiumEntity) {
                vis._cesiumEntity.show = (_cameraMode !== 'cockpit');
            }
        }

        if (_cameraMode === 'chase') {
            _camHeadingOffset = 0;
            _camPitch = -0.3;
            _camRange = 200;
        }

        _showMessage('Camera: ' + _cameraMode.toUpperCase());
    }

    // --- UI Helpers ---
    let _msgTimeout = null;
    function _showMessage(text) {
        const el = document.getElementById('scenarioMsgOverlay');
        if (!el) return;
        el.textContent = text;
        el.style.opacity = '1';
        if (_msgTimeout) clearTimeout(_msgTimeout);
        _msgTimeout = setTimeout(function() { el.style.opacity = '0'; }, 1500);
    }

    function _togglePanel(id) {
        const el = document.getElementById(id);
        if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
    }

    function _toggleAllPanels() {
        ['scenarioFlightPanel', 'scenarioSystemsPanel', 'scenarioStatusBar'].forEach(function(id) {
            _togglePanel(id);
        });
    }

    // Expose camera update on a global so CesiumEntity can call it
    window._ScenarioCamera = { update: updateCamera };

    ComponentRegistry.register('control', 'player_input', PlayerInput);
})();
