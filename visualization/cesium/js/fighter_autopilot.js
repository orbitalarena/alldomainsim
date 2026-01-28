/**
 * Fighter Autopilot System
 * PID controllers for altitude, heading, speed hold, and waypoint navigation
 */
const FighterAutopilot = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const M_TO_FT = 3.28084;
    const FT_TO_M = 0.3048;
    const NM_TO_M = 1852;

    /**
     * PID Controller
     */
    class PIDController {
        constructor(kp, ki, kd, outMin, outMax) {
            this.kp = kp;
            this.ki = ki;
            this.kd = kd;
            this.outMin = outMin;
            this.outMax = outMax;
            this.integral = 0;
            this.prevError = 0;
            this.firstUpdate = true;
        }

        update(error, dt) {
            if (dt <= 0) return 0;

            // Derivative (skip on first call)
            let derivative = 0;
            if (!this.firstUpdate) {
                derivative = (error - this.prevError) / dt;
            }
            this.firstUpdate = false;
            this.prevError = error;

            // Integral with anti-windup
            this.integral += error * dt;
            const maxIntegral = (this.outMax - this.outMin) / (2 * Math.max(this.ki, 0.001));
            this.integral = Math.max(-maxIntegral, Math.min(maxIntegral, this.integral));

            // PID output
            let output = this.kp * error + this.ki * this.integral + this.kd * derivative;
            return Math.max(this.outMin, Math.min(this.outMax, output));
        }

        reset() {
            this.integral = 0;
            this.prevError = 0;
            this.firstUpdate = true;
        }
    }

    /**
     * Default Edwards AFB patrol waypoints
     */
    const DEFAULT_WAYPOINTS = [
        { name: 'WP1 - Climb',     lat: 35.1 * DEG,  lon: -117.7 * DEG, alt: 7620,  speed: 250 }, // 25000 ft
        { name: 'WP2 - North',     lat: 35.5 * DEG,  lon: -117.5 * DEG, alt: 7620,  speed: 260 },
        { name: 'WP3 - East',      lat: 35.5 * DEG,  lon: -116.8 * DEG, alt: 7620,  speed: 260 },
        { name: 'WP4 - South',     lat: 35.0 * DEG,  lon: -116.8 * DEG, alt: 7620,  speed: 260 },
        { name: 'WP5 - Return',    lat: 35.0 * DEG,  lon: -117.5 * DEG, alt: 7620,  speed: 260 },
        { name: 'WP6 - Approach',  lat: 34.95 * DEG, lon: -117.85 * DEG, alt: 3000, speed: 130 },
    ];

    /**
     * Create autopilot state
     */
    function createAutopilotState() {
        return {
            enabled: false,
            altHold: false,
            hdgHold: false,
            spdHold: false,
            wpNav: false,

            targetAlt: 5000,        // m
            targetHdg: 0,           // rad
            targetSpeed: 200,       // m/s TAS

            waypoints: DEFAULT_WAYPOINTS.map(wp => ({ ...wp })),
            currentWpIndex: 0,
            wpSwitchDist: 2000,     // m - switch to next WP within this distance

            // PID controllers
            altPID: new PIDController(0.005, 0.0005, 0.01, -15 * DEG, 15 * DEG),
            hdgPID: new PIDController(1.5, 0.05, 0.5, -60 * DEG, 60 * DEG),
            spdPID: new PIDController(0.005, 0.001, 0.002, 0.0, 1.0),

            // Vertical speed PID (inner loop for alt hold)
            vsPID: new PIDController(0.02, 0.002, 0.01, -1.0, 1.0),
        };
    }

    /**
     * Toggle autopilot on/off
     */
    function toggle(apState, aircraftState) {
        apState.enabled = !apState.enabled;
        if (apState.enabled) {
            // Capture current state as targets
            apState.targetAlt = aircraftState.alt;
            apState.targetHdg = aircraftState.heading;
            apState.targetSpeed = aircraftState.speed;
            apState.altHold = true;
            apState.hdgHold = true;
            apState.spdHold = true;
            apState.wpNav = false;
            resetPIDs(apState);
        }
    }

    /**
     * Enable waypoint navigation
     */
    function enableWpNav(apState) {
        apState.wpNav = true;
        apState.altHold = true;
        apState.hdgHold = true;
        apState.spdHold = true;
        apState.currentWpIndex = 0;
        updateWpTargets(apState);
    }

    /**
     * Advance to next waypoint
     */
    function nextWaypoint(apState) {
        if (apState.waypoints.length === 0) return;
        apState.currentWpIndex = (apState.currentWpIndex + 1) % apState.waypoints.length;
        updateWpTargets(apState);
    }

    /**
     * Update targets from current waypoint
     */
    function updateWpTargets(apState) {
        const wp = apState.waypoints[apState.currentWpIndex];
        if (!wp) return;
        apState.targetAlt = wp.alt;
        apState.targetSpeed = wp.speed;
        // Heading is computed dynamically toward waypoint
    }

    /**
     * Reset all PID controllers
     */
    function resetPIDs(apState) {
        apState.altPID.reset();
        apState.hdgPID.reset();
        apState.spdPID.reset();
        apState.vsPID.reset();
    }

    /**
     * Update autopilot - returns control commands
     * @param {object} apState - autopilot state
     * @param {object} acState - aircraft state
     * @param {number} dt - time step
     * @returns {object} control commands {pitch, roll, throttleSet}
     */
    function update(apState, acState, dt) {
        const commands = {};

        if (!apState.enabled) return commands;

        // Waypoint navigation - update heading target
        if (apState.wpNav && apState.waypoints.length > 0) {
            const wp = apState.waypoints[apState.currentWpIndex];
            if (wp) {
                // Compute bearing to waypoint
                const brg = FighterSimEngine.bearing(acState.lat, acState.lon,
                                                      wp.lat, wp.lon);
                apState.targetHdg = brg;

                // Check if we've reached the waypoint
                const dist = FighterSimEngine.distance(acState.lat, acState.lon,
                                                        wp.lat, wp.lon);
                if (dist < apState.wpSwitchDist) {
                    nextWaypoint(apState);
                }
            }
        }

        // Altitude hold → pitch command
        if (apState.altHold) {
            const altError = apState.targetAlt - acState.alt;
            // Outer loop: alt error → desired climb angle
            const desiredGamma = apState.altPID.update(altError, dt);
            // Inner loop: gamma error → pitch command
            const gammaError = desiredGamma - acState.gamma;
            commands.pitch = apState.vsPID.update(gammaError, dt);
        }

        // Heading hold → roll command
        if (apState.hdgHold) {
            let hdgError = apState.targetHdg - acState.heading;
            // Normalize to [-π, π]
            while (hdgError > Math.PI) hdgError -= 2 * Math.PI;
            while (hdgError < -Math.PI) hdgError += 2 * Math.PI;
            // Heading error → desired bank angle → roll command
            const desiredRoll = apState.hdgPID.update(hdgError, dt);
            const rollError = desiredRoll - acState.roll;
            commands.roll = FighterSimEngine.clamp(rollError * 2.0, -1, 1);
        }

        // Speed hold → throttle command
        if (apState.spdHold) {
            const spdError = apState.targetSpeed - acState.speed;
            commands.throttleSet = apState.spdPID.update(spdError, dt);
        }

        return commands;
    }

    /**
     * Get current waypoint info for display
     */
    function getWaypointInfo(apState, acState) {
        if (!apState.wpNav || apState.waypoints.length === 0) return null;

        const wp = apState.waypoints[apState.currentWpIndex];
        if (!wp) return null;

        const dist = FighterSimEngine.distance(acState.lat, acState.lon, wp.lat, wp.lon);
        const brg = FighterSimEngine.bearing(acState.lat, acState.lon, wp.lat, wp.lon) * RAD;

        return {
            name: wp.name,
            index: apState.currentWpIndex,
            total: apState.waypoints.length,
            distanceM: dist,
            distanceNm: dist / NM_TO_M,
            bearingDeg: brg,
            targetAltFt: wp.alt * M_TO_FT,
            targetSpeedKt: wp.speed * 1.94384,
        };
    }

    // Public API
    return {
        PIDController,
        DEFAULT_WAYPOINTS,
        createAutopilotState,
        toggle,
        enableWpNav,
        nextWaypoint,
        resetPIDs,
        update,
        getWaypointInfo,
    };
})();
