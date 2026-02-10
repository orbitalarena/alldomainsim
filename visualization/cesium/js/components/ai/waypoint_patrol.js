/**
 * WaypointPatrol AI component — flies an entity along a sequence of waypoints.
 *
 * Writes to entity.state._commands using the same interface as PlayerInput,
 * so PhysicsSystem / FighterSimEngine processes the commands identically.
 *
 * Config:
 *   waypoints       — array of { lat, lon, alt, speed } (lat/lon in DEGREES)
 *   loopMode        — 'cycle' | 'once' | 'pingpong'  (default 'cycle')
 *   turnRate_dps    — max heading change deg/s         (default 3.0)
 *   climbRate_mps   — max altitude change m/s          (default 30.0)
 *   speedChangeRate — max speed change m/s/s           (default 20.0)
 *   arrivalRadius_m — distance to consider "arrived"   (default 1000)
 *   altTolerance_m  — altitude band for "arrived"      (default 200)
 */
const WaypointPatrol = (function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;
    const RAD = FrameworkConstants.RAD;
    const R_EARTH = FrameworkConstants.R_EARTH;

    // ------------------------------------------------------------------
    // Helper: great-circle bearing from (lat1, lon1) to (lat2, lon2)
    // All arguments and return value in RADIANS.
    // Returns bearing in [0, 2*PI).
    // ------------------------------------------------------------------
    function gcBearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brg = Math.atan2(y, x);
        if (brg < 0) brg += 2 * Math.PI;
        return brg;
    }

    // ------------------------------------------------------------------
    // Helper: great-circle distance (Haversine) in meters.
    // Arguments in RADIANS.
    // ------------------------------------------------------------------
    function gcDistance(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R_EARTH * c;
    }

    // ------------------------------------------------------------------
    // Helper: shortest signed angle difference, result in [-PI, PI].
    // ------------------------------------------------------------------
    function angleDiff(target, current) {
        var d = target - current;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    // ------------------------------------------------------------------
    // WaypointPatrol component
    // ------------------------------------------------------------------
    class WaypointPatrol extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._waypoints = config.waypoints || [];
            this._loopMode = config.loopMode || 'cycle';
            this._turnRate = (config.turnRate_dps !== undefined ? config.turnRate_dps : 3.0) * DEG;
            this._climbRate = config.climbRate_mps !== undefined ? config.climbRate_mps : 30.0;
            this._speedChangeRate = config.speedChangeRate !== undefined ? config.speedChangeRate : 20.0;
            this._arrivalRadius = config.arrivalRadius_m !== undefined ? config.arrivalRadius_m : 1000;
            this._altTolerance = config.altTolerance_m !== undefined ? config.altTolerance_m : 200;

            // Runtime state
            this._index = 0;
            this._direction = 1;       // +1 forward, -1 reverse (for pingpong)
            this._finished = false;     // true when 'once' mode completes
            this._converted = false;    // waypoints converted to radians
        }

        init(world) {
            // Convert waypoint lat/lon from degrees to radians on first use
            this._convertWaypoints();
        }

        /**
         * Convert waypoint lat/lon from degrees (config format) to radians
         * (internal format matching entity.state).
         */
        _convertWaypoints() {
            if (this._converted) return;
            this._converted = true;
            for (var i = 0; i < this._waypoints.length; i++) {
                var wp = this._waypoints[i];
                wp._latRad = wp.lat * DEG;
                wp._lonRad = wp.lon * DEG;
            }
        }

        /**
         * Advance to the next waypoint, respecting loopMode.
         * Returns false if no further waypoint is available (once mode done).
         */
        _advanceWaypoint() {
            var count = this._waypoints.length;
            if (count === 0) return false;

            if (this._loopMode === 'cycle') {
                this._index = (this._index + 1) % count;
                return true;

            } else if (this._loopMode === 'once') {
                if (this._index < count - 1) {
                    this._index++;
                    return true;
                }
                this._finished = true;
                return false;

            } else if (this._loopMode === 'pingpong') {
                var next = this._index + this._direction;
                if (next >= count) {
                    this._direction = -1;
                    next = this._index + this._direction;
                } else if (next < 0) {
                    this._direction = 1;
                    next = this._index + this._direction;
                }
                this._index = Math.max(0, Math.min(count - 1, next));
                return true;
            }

            return false;
        }

        update(dt, world) {
            var waypoints = this._waypoints;
            if (waypoints.length === 0 || this._finished) return;
            if (!this._converted) this._convertWaypoints();

            var state = this.entity.state;

            // Navigation hijacked by cyber attack — redirect to hijack waypoint or random jink
            if (state._navigationHijacked) {
                var hijackCmd = state._commands || {};
                if (state._hijackWaypoint) {
                    // Steer toward hijack waypoint using same nav logic as normal waypoints
                    var hjWp = state._hijackWaypoint;
                    var hjDist = gcDistance(lat, lon, hjWp.lat, hjWp.lon);
                    var hjBearing = gcBearing(lat, lon, hjWp.lat, hjWp.lon);
                    var hjBearingDelta = hjBearing - heading;
                    // Normalize to [-PI, PI]
                    while (hjBearingDelta > Math.PI) hjBearingDelta -= 2 * Math.PI;
                    while (hjBearingDelta < -Math.PI) hjBearingDelta += 2 * Math.PI;

                    hijackCmd.roll = Math.max(-1, Math.min(1, hjBearingDelta * 2));
                    // Descend to hijack altitude
                    var hjAltError = (hjWp.alt || 500) - alt;
                    hijackCmd.pitch = Math.max(-0.5, Math.min(0.5, hjAltError * 0.001));
                    // Slow down to hijack speed
                    hijackCmd.throttleUp = false;
                    hijackCmd.throttleDown = false;
                    if (hjWp.speed && speed > hjWp.speed * 1.1) hijackCmd.throttleDown = true;
                    else if (hjWp.speed && speed < hjWp.speed * 0.9) hijackCmd.throttleUp = true;
                } else {
                    // No specific waypoint — random jinking (fallback behavior)
                    hijackCmd.roll = (Math.random() - 0.5) * 0.3;
                    hijackCmd.pitch = (Math.random() - 0.5) * 0.1;
                    hijackCmd.throttleUp = Math.random() > 0.7;
                    hijackCmd.throttleDown = Math.random() > 0.7;
                }
                state._commands = hijackCmd;
                return;
            }

            // Cyber navigation degradation — graduated heading/position error
            var navDeg = state._cyberDegradation ? (state._cyberDegradation.navigation || 0) : 0;
            var navHeadingBias = 0;
            var navDistBias = 0;
            if (navDeg > 0 && navDeg < 1) {
                // Heading error: up to +/-30deg at full degradation, slowly drifting bias
                navHeadingBias = navDeg * 30 * DEG * Math.sin((world.simTime || 0) * 0.1 + this.entity.id.length);
                // Distance perception error: up to 20% at full degradation
                navDistBias = navDeg * 0.2;
            }

            var wp = waypoints[this._index];

            // Current entity state (lat/lon/heading in radians, alt in m, speed in m/s)
            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var alt = state.alt || 0;
            var speed = state.speed || 0;
            var heading = state.heading || 0;

            // --- Distance and bearing to waypoint ---
            var dist = gcDistance(lat, lon, wp._latRad, wp._lonRad);
            dist *= (1 + navDistBias);
            var bearing = gcBearing(lat, lon, wp._latRad, wp._lonRad);
            bearing += navHeadingBias;
            var altError = wp.alt - alt;

            // Write diagnostic state
            state._waypointIndex = this._index;
            state._waypointDist = dist;

            // --- Check arrival ---
            var withinRadius = dist < this._arrivalRadius;
            var withinAlt = Math.abs(altError) < this._altTolerance;

            if (withinRadius && withinAlt) {
                if (!this._advanceWaypoint()) {
                    // No more waypoints — hold current state, zero commands
                    state._commands = {
                        pitch: 0, roll: 0,
                        throttleUp: false, throttleDown: false,
                        yaw: 0
                    };
                    return;
                }
                // Re-read new waypoint
                wp = waypoints[this._index];
                dist = gcDistance(lat, lon, wp._latRad, wp._lonRad);
                dist *= (1 + navDistBias);
                bearing = gcBearing(lat, lon, wp._latRad, wp._lonRad);
                bearing += navHeadingBias;
                altError = wp.alt - alt;
            }

            // --- Generate commands ---
            var commands = {
                pitch: 0,
                roll: 0,
                throttleUp: false,
                throttleDown: false,
                yaw: 0
            };

            // Heading control
            var headingError = angleDiff(bearing, heading);
            var headingErrorDeg = headingError * RAD;

            if (Math.abs(headingErrorDeg) > 5.0) {
                // Turn toward waypoint — choose shortest direction
                commands.roll = (headingError > 0) ? 1 : -1;
            }

            // Altitude control
            if (altError > this._altTolerance) {
                commands.pitch = 1;   // climb
            } else if (altError < -this._altTolerance) {
                commands.pitch = -1;  // descend
            }

            // Speed control
            var desiredSpeed = wp.speed !== undefined ? wp.speed : speed;
            var speedError = desiredSpeed - speed;
            if (speedError > this._speedChangeRate * dt) {
                commands.throttleUp = true;
            } else if (speedError < -this._speedChangeRate * dt) {
                commands.throttleDown = true;
            }

            state._commands = commands;
        }

        cleanup(world) {
            // Clear commands so entity doesn't continue turning after removal
            if (this.entity && this.entity.state) {
                this.entity.state._commands = null;
            }
        }
    }

    return WaypointPatrol;
})();

// Register with the component registry
ComponentRegistry.register('ai', 'waypoint_patrol', WaypointPatrol);
