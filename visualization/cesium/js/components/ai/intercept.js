/**
 * InterceptAI component — pursuit/intercept AI for multi-domain entities.
 *
 * Modes:
 *   "pursuit" — fly directly at target's current position
 *   "lead"    — fly toward predicted intercept point (target pos + vel * leadTime)
 *   "stern"   — maneuver behind target (6 o'clock) at desiredRange
 *
 * Outputs entity.state._commands (same interface as PlayerInput).
 * State machine: idle -> pursuing -> engaged -> disengaging -> idle
 */
const InterceptAI = (function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;
    const RAD = FrameworkConstants.RAD;
    const R_EARTH = FrameworkConstants.R_EARTH;

    /** Haversine distance (meters) between two lat/lon pairs (radians). */
    function haversineDistance(lat1, lon1, lat2, lon2) {
        const dLat = lat2 - lat1;
        const dLon = lon2 - lon1;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Great-circle initial bearing (radians [0,2PI)) from p1 to p2 (all radians). */
    function greatCircleBearing(lat1, lon1, lat2, lon2) {
        const dLon = lon2 - lon1;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        let brg = Math.atan2(y, x);
        if (brg < 0) brg += 2 * Math.PI;
        return brg;
    }

    /** Shortest signed angle difference (radians), result in [-PI, PI]. */
    function angleDiff(a, b) {
        let d = a - b;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    /** Destination point from start (rad), bearing (rad), distance (m). Returns {lat, lon} rad. */
    function destinationPoint(lat1, lon1, bearing, distance) {
        const angDist = distance / R_EARTH;
        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(angDist) +
            Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearing)
        );
        const lon2 = lon1 + Math.atan2(
            Math.sin(bearing) * Math.sin(angDist) * Math.cos(lat1),
            Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
        );
        return { lat: lat2, lon: lon2 };
    }

    // -------------------------------------------------------------------
    // InterceptAI Component
    // -------------------------------------------------------------------
    class InterceptAIComponent extends ECS.Component {
        constructor(config) {
            super(config);
            this._targetId       = config.targetId        || null;
            this._mode           = config.mode            || 'pursuit';
            this._engageRange    = config.engageRange_m   || 50000;
            this._disengageRange = config.disengageRange_m || 200000;
            this._desiredRange   = config.desiredRange_m  || 500;
            this._turnRate       = (config.turnRate_dps   || 5.0) * DEG;  // rad/s
            this._maxSpeed       = config.maxSpeed        || 300;
            this._minSpeed       = config.minSpeed        || 100;
            this._leadTime       = config.leadTime_s      || 5.0;
        }

        init(world) {
            const state = this.entity.state;
            state._commands = state._commands || {
                pitch: 0, roll: 0, yaw: 0,
                throttleUp: false, throttleDown: false
            };
            state._interceptState = 'idle';
            state._targetRange = 0;
            state._targetBearing = 0;
        }

        update(dt, world) {
            const state = this.entity.state;
            const cmd = { pitch: 0, roll: 0, yaw: 0, throttleUp: false, throttleDown: false };

            // Navigation hijacked by cyber attack — redirect to hijack waypoint or random jink
            if (state._navigationHijacked) {
                if (state._hijackWaypoint) {
                    // Steer toward hijack waypoint instead of intercept target
                    var hjWp = state._hijackWaypoint;
                    var hjBearing = greatCircleBearing(state.lat, state.lon, hjWp.lat, hjWp.lon);
                    var hjHeadingError = angleDiff(hjBearing, state.heading || 0);

                    cmd.roll = Math.max(-1, Math.min(1, hjHeadingError * 2));
                    // Descend to hijack altitude
                    var hjAltErr = (hjWp.alt || 500) - (state.alt || 0);
                    cmd.pitch = Math.max(-0.5, Math.min(0.5, hjAltErr * 0.001));
                    // Slow down to hijack speed
                    var hjSpeed = hjWp.speed || 100;
                    var curSpeed = state.speed || 0;
                    if (curSpeed > hjSpeed * 1.1) cmd.throttleDown = true;
                    else if (curSpeed < hjSpeed * 0.9) cmd.throttleUp = true;
                } else {
                    // No specific waypoint — random jinking (fallback behavior)
                    cmd.roll = (Math.random() - 0.5) * 0.4;
                    cmd.pitch = (Math.random() - 0.5) * 0.1;
                    cmd.throttleUp = Math.random() > 0.5;
                }
                state._commands = cmd;
                state._interceptState = 'hijacked';
                return;
            }

            // Cyber navigation degradation — graduated aim error
            var navDeg = state._cyberDegradation ? (state._cyberDegradation.navigation || 0) : 0;
            var navAimBias = 0;
            if (navDeg > 0 && navDeg < 1) {
                navAimBias = navDeg * 20 * DEG * Math.sin((world.simTime || 0) * 0.15 + (this.entity.id || '').length);
            }

            const target = this._targetId ? world.getEntity(this._targetId) : null;

            // No valid target — go idle
            if (!target || !target.active) {
                state._interceptState = 'idle';
                state._targetRange = 0;
                state._targetBearing = 0;
                state._commands = cmd;
                return;
            }

            const ts = target.state;
            const range = haversineDistance(state.lat, state.lon, ts.lat, ts.lon);
            const bearingToTarget = greatCircleBearing(state.lat, state.lon, ts.lat, ts.lon);
            state._targetRange = range;
            state._targetBearing = bearingToTarget * RAD;

            // State machine transitions
            this._updateStateMachine(state, range);

            if (state._interceptState === 'idle') {
                state._commands = cmd;
                return;
            }

            // Determine aim point based on mode
            let aimLat = ts.lat;
            let aimLon = ts.lon;
            let aimAlt = ts.alt || 0;

            if (this._mode === 'lead') {
                const projDist = (ts.speed || 0) * this._leadTime;
                const projected = destinationPoint(ts.lat, ts.lon, ts.heading || 0, projDist);
                aimLat = projected.lat;
                aimLon = projected.lon;
            } else if (this._mode === 'stern') {
                const sternBearing = (ts.heading || 0) + Math.PI;
                const sternDist = (state._interceptState === 'engaged')
                    ? this._desiredRange
                    : this._desiredRange * 3;
                const sternPt = destinationPoint(ts.lat, ts.lon, sternBearing, sternDist);
                aimLat = sternPt.lat;
                aimLon = sternPt.lon;
            }

            // Heading command (roll to turn)
            const desiredBearing = greatCircleBearing(state.lat, state.lon, aimLat, aimLon);
            const adjustedBearing = desiredBearing + navAimBias;
            const headingError = angleDiff(adjustedBearing, state.heading || 0);
            const maxTurn = this._turnRate * dt;

            if (Math.abs(headingError) > 0.01) {
                cmd.roll = headingError > 0 ? 1 : -1;
                if (Math.abs(headingError) < maxTurn * 2) {
                    cmd.roll = 0;   // close enough, let damping handle it
                }
            }

            // Pitch command (altitude matching)
            const altError = aimAlt - (state.alt || 0);
            if (altError > 50) {
                cmd.pitch = -1;     // nose up
            } else if (altError < -50) {
                cmd.pitch = 1;      // nose down
            }

            // Throttle command
            const currentSpeed = state.speed || 0;
            if (state._interceptState === 'disengaging') {
                cmd.throttleDown = currentSpeed > this._minSpeed;
            } else if (state._interceptState === 'engaged' && this._mode === 'stern') {
                const tgtSpeed = ts.speed || 0;
                if (currentSpeed < tgtSpeed - 10) cmd.throttleUp = true;
                else if (currentSpeed > tgtSpeed + 10) cmd.throttleDown = true;
            } else {
                if (currentSpeed < this._maxSpeed) cmd.throttleUp = true;
                else if (currentSpeed > this._maxSpeed * 1.1) cmd.throttleDown = true;
            }

            state._commands = cmd;
        }

        /** State machine: range-based transitions between intercept states. */
        _updateStateMachine(state, range) {
            switch (state._interceptState) {
                case 'idle':
                    if (range < this._engageRange)
                        state._interceptState = 'pursuing';
                    break;
                case 'pursuing':
                    if (range > this._disengageRange)
                        state._interceptState = 'disengaging';
                    else if (range < this._desiredRange * 2)
                        state._interceptState = 'engaged';
                    break;
                case 'engaged':
                    if (range > this._disengageRange)
                        state._interceptState = 'disengaging';
                    else if (range > this._engageRange)
                        state._interceptState = 'pursuing';
                    break;
                case 'disengaging':
                    if (range < this._engageRange)
                        state._interceptState = 'pursuing';
                    else if (range > this._disengageRange)
                        state._interceptState = 'idle';
                    break;
                default:
                    state._interceptState = 'idle';
                    break;
            }
        }

        cleanup(world) {
            const state = this.entity.state;
            state._interceptState = 'idle';
            state._commands = {
                pitch: 0, roll: 0, yaw: 0,
                throttleUp: false, throttleDown: false
            };
        }

        static editorSchema() {
            return [
                { name: 'targetId',         type: 'entity', label: 'Target Entity' },
                { name: 'mode',             type: 'select', label: 'Intercept Mode',
                    options: ['pursuit', 'lead', 'stern'], default: 'pursuit' },
                { name: 'engageRange_m',    type: 'number', label: 'Engage Range (m)',    default: 50000 },
                { name: 'disengageRange_m', type: 'number', label: 'Disengage Range (m)', default: 200000 },
                { name: 'desiredRange_m',   type: 'number', label: 'Desired Range (m)',   default: 500 },
                { name: 'turnRate_dps',     type: 'number', label: 'Turn Rate (deg/s)',   default: 5.0 },
                { name: 'maxSpeed',         type: 'number', label: 'Max Speed (m/s)',     default: 300 },
                { name: 'minSpeed',         type: 'number', label: 'Min Speed (m/s)',     default: 100 },
                { name: 'leadTime_s',       type: 'number', label: 'Lead Time (s)',       default: 5.0 }
            ];
        }
    }

    return InterceptAIComponent;
})();

ComponentRegistry.register('ai', 'intercept', InterceptAI);
