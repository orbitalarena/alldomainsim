/**
 * Gamepad Input Module
 *
 * Provides analog gamepad/joystick input for fighter and spaceplane sims.
 * Uses the browser Gamepad API — no dependencies.
 *
 * Usage:
 *   GamepadInput.init();
 *   // In your sim loop:
 *   const gp = GamepadInput.poll();
 *   if (gp.connected) {
 *       controls = GamepadInput.merge(keyboardControls, gp);
 *   }
 */
const GamepadInput = (function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════
    // Configuration
    // ═══════════════════════════════════════════════════════════

    const DEFAULT_MAPPING = {
        // Axes (standard gamepad layout)
        pitchAxis:    1,   // Left stick Y → pitch
        rollAxis:     0,   // Left stick X → roll
        yawAxis:      2,   // Right stick X → yaw
        throttleAxis: 3,   // Right stick Y → throttle adjust

        // Axis options
        pitchInvert:    true,   // Stick forward = nose down (flight convention)
        rollInvert:     false,
        yawInvert:      false,
        throttleInvert: true,   // Stick forward = more throttle

        // Sensitivity (multiplier for raw axis value)
        pitchSensitivity:    1.0,
        rollSensitivity:     1.0,
        yawSensitivity:      0.7,
        throttleSensitivity: 0.5,

        // Deadzone (ignore inputs below this magnitude)
        deadzone: 0.12,

        // Buttons (standard gamepad: A=0, B=1, X=2, Y=3, LB=4, RB=5, LT=6, RT=7)
        buttons: {
            fire:           0,   // A → fire weapon
            engine:         2,   // X → toggle engine
            gear:           3,   // Y → toggle gear
            weaponNext:     5,   // RB → next weapon
            weaponPrev:     4,   // LB → prev weapon
            camera:         1,   // B → cycle camera
            pause:          9,   // Start → pause
            propulsionMode: 8,   // Back/Select → cycle propulsion
            timeWarpUp:     5,   // RB + modifier for time warp
            timeWarpDown:   4,   // LB + modifier for time warp
            maneuverNode:   3,   // Y (in planner mode) → create node
            executeNode:    0,   // A (in planner mode) → execute node
        }
    };

    // ═══════════════════════════════════════════════════════════
    // State
    // ═══════════════════════════════════════════════════════════

    let _mapping = Object.assign({}, DEFAULT_MAPPING);
    let _connected = false;
    let _gamepadIndex = -1;
    let _prevButtons = {};   // Previous frame button states for edge detection
    let _justPressed = {};   // Buttons that just became pressed this frame

    // ═══════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════

    function init(customMapping) {
        if (customMapping) {
            Object.assign(_mapping, customMapping);
            if (customMapping.buttons) {
                _mapping.buttons = Object.assign({}, DEFAULT_MAPPING.buttons, customMapping.buttons);
            }
        }

        window.addEventListener('gamepadconnected', function(e) {
            console.log('[GamepadInput] Gamepad connected:', e.gamepad.id,
                        '(' + e.gamepad.buttons.length + ' buttons,' +
                        e.gamepad.axes.length + ' axes)');
            _gamepadIndex = e.gamepad.index;
            _connected = true;
        });

        window.addEventListener('gamepaddisconnected', function(e) {
            console.log('[GamepadInput] Gamepad disconnected:', e.gamepad.id);
            if (e.gamepad.index === _gamepadIndex) {
                _connected = false;
                _gamepadIndex = -1;
            }
        });

        // Check if a gamepad is already connected (page refresh with gamepad plugged in)
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < gamepads.length; i++) {
            if (gamepads[i]) {
                _gamepadIndex = gamepads[i].index;
                _connected = true;
                console.log('[GamepadInput] Found existing gamepad:', gamepads[i].id);
                break;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Polling
    // ═══════════════════════════════════════════════════════════

    function applyDeadzone(value, deadzone) {
        if (Math.abs(value) < deadzone) return 0.0;
        // Rescale so that output starts from 0 after deadzone
        const sign = value > 0 ? 1 : -1;
        return sign * (Math.abs(value) - deadzone) / (1.0 - deadzone);
    }

    function poll() {
        const result = {
            connected: false,
            pitch: 0,
            roll: 0,
            yaw: 0,
            throttleAdjust: 0,
            buttons: {},
            justPressed: {}
        };

        if (!_connected || _gamepadIndex < 0) return result;

        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[_gamepadIndex];
        if (!gp) return result;

        result.connected = true;

        // Read axes with deadzone and sensitivity
        const dz = _mapping.deadzone;

        let rawPitch = gp.axes[_mapping.pitchAxis] || 0;
        let rawRoll  = gp.axes[_mapping.rollAxis]  || 0;
        let rawYaw   = gp.axes[_mapping.yawAxis]   || 0;
        let rawThrottle = gp.axes[_mapping.throttleAxis] || 0;

        if (_mapping.pitchInvert)    rawPitch    = -rawPitch;
        if (_mapping.rollInvert)     rawRoll     = -rawRoll;
        if (_mapping.yawInvert)      rawYaw      = -rawYaw;
        if (_mapping.throttleInvert) rawThrottle = -rawThrottle;

        result.pitch          = applyDeadzone(rawPitch, dz) * _mapping.pitchSensitivity;
        result.roll           = applyDeadzone(rawRoll, dz)  * _mapping.rollSensitivity;
        result.yaw            = applyDeadzone(rawYaw, dz)   * _mapping.yawSensitivity;
        result.throttleAdjust = applyDeadzone(rawThrottle, dz) * _mapping.throttleSensitivity;

        // Read buttons with edge detection
        _justPressed = {};
        for (const [name, index] of Object.entries(_mapping.buttons)) {
            const pressed = gp.buttons[index] ? gp.buttons[index].pressed : false;
            result.buttons[name] = pressed;

            // Edge detection: just pressed this frame (was not pressed last frame)
            const wasPressed = _prevButtons[name] || false;
            _justPressed[name] = pressed && !wasPressed;
            result.justPressed[name] = _justPressed[name];

            _prevButtons[name] = pressed;
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════
    // Merge with keyboard controls
    // ═══════════════════════════════════════════════════════════

    /**
     * Merge keyboard and gamepad controls.
     * Gamepad analog values override keyboard binary values when the
     * gamepad input has magnitude (prevents gamepad at rest from
     * zeroing out keyboard inputs).
     *
     * @param {Object} kb  - Keyboard controls {pitch, roll, yaw, throttle, ...}
     * @param {Object} gp  - Gamepad poll result
     * @return {Object} Merged controls
     */
    function merge(kb, gp) {
        if (!gp || !gp.connected) return kb;

        const merged = Object.assign({}, kb);

        // Analog axes: gamepad overrides keyboard when gamepad has input
        if (Math.abs(gp.pitch) > 0.01) {
            merged.pitch = gp.pitch;
        }
        if (Math.abs(gp.roll) > 0.01) {
            merged.roll = gp.roll;
        }
        if (Math.abs(gp.yaw) > 0.01) {
            merged.yaw = gp.yaw;
        }
        if (Math.abs(gp.throttleAdjust) > 0.01) {
            merged.throttleAdjust = (merged.throttleAdjust || 0) + gp.throttleAdjust;
        }

        return merged;
    }

    // ═══════════════════════════════════════════════════════════
    // Status
    // ═══════════════════════════════════════════════════════════

    function isConnected() {
        return _connected;
    }

    function getGamepadName() {
        if (!_connected || _gamepadIndex < 0) return null;
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[_gamepadIndex];
        return gp ? gp.id : null;
    }

    // ═══════════════════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════════════════

    return {
        init: init,
        poll: poll,
        merge: merge,
        isConnected: isConnected,
        getGamepadName: getGamepadName,
        DEFAULT_MAPPING: DEFAULT_MAPPING
    };

})();
