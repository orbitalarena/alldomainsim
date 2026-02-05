/**
 * SensorViewMode — Single-viewer camera switching for optical sensor view.
 *
 * Since Cesium viewers can't share models, we use a single viewer approach:
 * - S key saves current camera state, switches to nadir view locked to entity
 * - Apply post-processing effects (B&W, noise, night overlay)
 * - S key again restores previous camera state
 *
 * The entity model IS the synthetic camera view (looking down from platform).
 */
const SensorViewMode = (function() {
    'use strict';

    let _active = false;
    let _savedCameraState = null;
    let _targetEntity = null;
    let _noiseCanvas = null;
    let _noiseCtx = null;
    let _noiseAnimFrame = null;
    let _updateInterval = null;
    let _hudOverlay = null;

    /**
     * Toggle sensor view mode.
     * @param {ECS.World} world - The ECS world
     * @param {ECS.Entity} entity - The entity with optical sensor
     */
    function toggle(world, entity) {
        if (_active) {
            _deactivate(world);
        } else {
            _activate(world, entity);
        }
    }

    function isActive() {
        return _active;
    }

    function _activate(world, entity) {
        const viewer = world.viewer;
        if (!viewer) return;

        _active = true;
        _targetEntity = entity;

        // Save current camera state
        _savedCameraState = {
            position: Cesium.Cartesian3.clone(viewer.camera.position),
            direction: Cesium.Cartesian3.clone(viewer.camera.direction),
            up: Cesium.Cartesian3.clone(viewer.camera.up),
            heading: viewer.camera.heading,
            pitch: viewer.camera.pitch,
            roll: viewer.camera.roll
        };

        // Apply visual effects
        _applyEffects(viewer);

        // Create HUD overlay
        _createHUD(entity);

        // Start camera tracking
        _startCameraTracking(world);

        _showMessage('SENSOR VIEW ON');
    }

    function _deactivate(world) {
        const viewer = world.viewer;

        _active = false;
        _targetEntity = null;

        // Stop camera tracking
        if (_updateInterval) {
            clearInterval(_updateInterval);
            _updateInterval = null;
        }

        // Stop noise animation
        if (_noiseAnimFrame) {
            cancelAnimationFrame(_noiseAnimFrame);
            _noiseAnimFrame = null;
        }

        // Remove effects
        _removeEffects(viewer);

        // Remove HUD
        if (_hudOverlay) {
            _hudOverlay.remove();
            _hudOverlay = null;
        }

        // Restore camera state
        if (_savedCameraState && viewer) {
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            viewer.camera.position = _savedCameraState.position;
            viewer.camera.direction = _savedCameraState.direction;
            viewer.camera.up = _savedCameraState.up;
        }

        _savedCameraState = null;
        _showMessage('SENSOR VIEW OFF');
    }

    function _applyEffects(viewer) {
        const container = document.getElementById('cesiumContainer');
        if (!container) return;

        // B&W filter via CSS
        container.classList.add('sensor-view-active');
        container.style.filter = 'grayscale(1) contrast(1.2)';

        // Create noise overlay canvas
        _createNoiseOverlay(container);

        // Start noise animation
        _startNoiseAnimation();
    }

    function _removeEffects(viewer) {
        const container = document.getElementById('cesiumContainer');
        if (!container) return;

        container.classList.remove('sensor-view-active');
        container.style.filter = '';

        // Remove noise canvas
        if (_noiseCanvas && _noiseCanvas.parentNode) {
            _noiseCanvas.parentNode.removeChild(_noiseCanvas);
        }
        _noiseCanvas = null;
        _noiseCtx = null;
    }

    function _createNoiseOverlay(container) {
        _noiseCanvas = document.createElement('canvas');
        _noiseCanvas.id = 'sensorNoiseOverlay';
        _noiseCanvas.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            mix-blend-mode: overlay;
            opacity: 0.15;
            z-index: 50;
        `;
        _noiseCanvas.width = 256;
        _noiseCanvas.height = 256;
        _noiseCtx = _noiseCanvas.getContext('2d');
        container.appendChild(_noiseCanvas);
    }

    function _startNoiseAnimation() {
        function animateNoise() {
            if (!_noiseCtx || !_active) return;

            const w = _noiseCanvas.width;
            const h = _noiseCanvas.height;
            const imageData = _noiseCtx.createImageData(w, h);
            const data = imageData.data;

            for (let i = 0; i < data.length; i += 4) {
                const v = Math.random() * 255;
                data[i] = v;
                data[i + 1] = v;
                data[i + 2] = v;
                data[i + 3] = 255;
            }

            _noiseCtx.putImageData(imageData, 0, 0);
            _noiseAnimFrame = requestAnimationFrame(animateNoise);
        }

        animateNoise();
    }

    function _createHUD(entity) {
        _hudOverlay = document.createElement('div');
        _hudOverlay.id = 'sensorHUD';
        _hudOverlay.style.cssText = `
            position: absolute;
            top: 10px;
            left: 10px;
            background: rgba(0, 20, 0, 0.8);
            border: 1px solid #0f0;
            color: #0f0;
            font-family: 'Courier New', monospace;
            font-size: 11px;
            padding: 10px;
            z-index: 100;
            min-width: 180px;
        `;
        _hudOverlay.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px;border-bottom:1px solid #0a0;padding-bottom:4px;">SENSOR VIEW</div>
            <div id="sensorHUD-alt">ALT: ---</div>
            <div id="sensorHUD-fov">FOV: ---</div>
            <div id="sensorHUD-gsd">GSD: ---</div>
            <div id="sensorHUD-illum">ILLUM: ---</div>
            <div style="margin-top:6px;color:#080;font-size:10px;">[S] to exit</div>
        `;

        const container = document.getElementById('cesiumContainer');
        if (container) {
            container.appendChild(_hudOverlay);
        }
    }

    function _updateHUD(entity) {
        if (!_hudOverlay) return;

        const state = entity.state;
        const alt = state.alt || 0;

        // Get sensor config
        let fov = 30;
        let gsd = 1.0;
        if (entity.def && entity.def._custom && entity.def._custom.sensors && entity.def._custom.sensors.optical) {
            fov = entity.def._custom.sensors.optical.fov_deg || 30;
            gsd = entity.def._custom.sensors.optical.gsd_m || 1.0;
        }
        if (entity.def && entity.def.components && entity.def.components.optical) {
            fov = entity.def.components.optical.fov_deg || 30;
            gsd = entity.def.components.optical.gsd_m || 1.0;
        }

        // Compute ground swath from altitude and FOV
        const swath_m = 2 * alt * Math.tan(fov * Math.PI / 180 / 2);
        const computed_gsd = swath_m / 2048; // Assume 2048 pixel sensor

        // Simple illumination estimate (time-based)
        const now = new Date();
        const hour = now.getUTCHours();
        const illum = (hour >= 6 && hour < 18) ? 'DAYLIGHT' : 'NIGHT';

        const altEl = document.getElementById('sensorHUD-alt');
        const fovEl = document.getElementById('sensorHUD-fov');
        const gsdEl = document.getElementById('sensorHUD-gsd');
        const illumEl = document.getElementById('sensorHUD-illum');

        if (altEl) altEl.textContent = `ALT: ${(alt/1000).toFixed(1)} km`;
        if (fovEl) fovEl.textContent = `FOV: ${fov.toFixed(1)}°`;
        if (gsdEl) gsdEl.textContent = `GSD: ${computed_gsd.toFixed(2)} m`;
        if (illumEl) {
            illumEl.textContent = `ILLUM: ${illum}`;
            illumEl.style.color = illum === 'DAYLIGHT' ? '#0f0' : '#f80';
        }
    }

    function _startCameraTracking(world) {
        const viewer = world.viewer;

        _updateInterval = setInterval(function() {
            if (!_active || !_targetEntity) return;

            const state = _targetEntity.state;
            if (!state) return;

            // Update HUD
            _updateHUD(_targetEntity);

            // Position camera at entity, looking nadir (straight down)
            const pos = Cesium.Cartesian3.fromRadians(state.lon, state.lat, state.alt);

            // Get local up vector (nadir is opposite)
            const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(pos);
            const up = new Cesium.Cartesian3();
            Cesium.Matrix4.multiplyByPointAsVector(enuTransform, Cesium.Cartesian3.UNIT_Z, up);

            // Direction is nadir (towards Earth center)
            const direction = Cesium.Cartesian3.negate(up, new Cesium.Cartesian3());
            Cesium.Cartesian3.normalize(direction, direction);

            // Right vector (East in ENU)
            const right = new Cesium.Cartesian3();
            Cesium.Matrix4.multiplyByPointAsVector(enuTransform, Cesium.Cartesian3.UNIT_X, right);

            // Up for camera is North
            const cameraUp = new Cesium.Cartesian3();
            Cesium.Matrix4.multiplyByPointAsVector(enuTransform, Cesium.Cartesian3.UNIT_Y, cameraUp);

            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
            viewer.camera.position = pos;
            viewer.camera.direction = direction;
            viewer.camera.up = cameraUp;
            viewer.camera.right = right;

        }, 50); // 20 Hz update
    }

    // --- UI Helpers ---
    function _showMessage(text) {
        const el = document.getElementById('scenarioMsgOverlay');
        if (!el) {
            // Fallback for non-scenario-viewer contexts
            console.log('[SensorViewMode]', text);
            return;
        }
        el.textContent = text;
        el.style.opacity = '1';
        setTimeout(function() { el.style.opacity = '0'; }, 1500);
    }

    return {
        toggle: toggle,
        isActive: isActive,
        activate: _activate,
        deactivate: _deactivate
    };
})();
