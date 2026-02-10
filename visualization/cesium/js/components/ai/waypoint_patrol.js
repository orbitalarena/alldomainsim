/**
 * WaypointPatrol AI component — flies an entity along a sequence of waypoints.
 *
 * Writes to entity.state._commands using the same interface as PlayerInput,
 * so PhysicsSystem / FighterSimEngine processes the commands identically.
 *
 * Config:
 *   waypoints       — array of { lat, lon, alt, speed, name?,
 *                       loiterDuration_s?, loiterRadius_m? }  (lat/lon in DEGREES)
 *   loopMode        — 'cycle' | 'once' | 'pingpong' | 'rtb'  (default 'cycle')
 *   turnRate_dps    — max heading change deg/s                (default 3.0)
 *   climbRate_mps   — max altitude change m/s                 (default 30.0)
 *   speedChangeRate — max speed change m/s/s                  (default 20.0)
 *   arrivalRadius_m — distance to consider "arrived"          (default 1000)
 *   altTolerance_m  — altitude band for "arrived"             (default 200)
 *
 * Phase tracking (state._aiPhase):
 *   'TRANSIT'  — flying toward next waypoint
 *   'LOITER'   — orbiting at a waypoint (loiterDuration_s)
 *   'RTB'      — returning to first waypoint (loopMode 'rtb')
 *   'COMPLETE' — all waypoints visited, holding position
 *
 * Waypoint progress (on entity.state):
 *   _waypointIndex  — current waypoint index
 *   _waypointTotal  — total number of waypoints
 *   _waypointName   — current waypoint name (from waypoint.name, or 'WP N')
 *   _waypointDist   — distance to current waypoint target (m)
 */
const WaypointPatrol = (function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;
    const RAD = FrameworkConstants.RAD;
    const R_EARTH = FrameworkConstants.R_EARTH;

    var DEFAULT_LOITER_RADIUS = 5000; // meters

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
            this._direction = 1;        // +1 forward, -1 reverse (for pingpong)
            this._finished = false;      // true when terminal mode completes
            this._converted = false;     // waypoints converted to radians
            this._phase = 'TRANSIT';     // TRANSIT | LOITER | RTB | COMPLETE

            // Loiter state
            this._loiterElapsed = 0;     // seconds spent loitering at current wp
            this._loiterActive = false;  // currently in a loiter orbit

            // RTB state
            this._rtbActive = false;     // currently returning to base
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
         * Returns false if no further waypoint is available (terminal).
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
                this._phase = 'COMPLETE';
                return false;

            } else if (this._loopMode === 'rtb') {
                if (this._index < count - 1) {
                    this._index++;
                    return true;
                }
                // Reached last waypoint — begin RTB to first waypoint
                if (!this._rtbActive) {
                    this._rtbActive = true;
                    this._phase = 'RTB';
                    return true; // RTB target is waypoints[0], handled in update
                }
                // RTB arrival is checked in update(); if we get here, RTB is done
                this._finished = true;
                this._phase = 'COMPLETE';
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

        /**
         * Compute smooth altitude and speed transition rates.
         * Given current state and target waypoint, returns adjusted alt/speed
         * deltas that will arrive at target values when reaching the waypoint.
         *
         * @param {number} dist   — distance to target waypoint (m)
         * @param {number} alt    — current altitude (m)
         * @param {number} speed  — current speed (m/s)
         * @param {object} wp     — target waypoint { alt, speed }
         * @param {number} dt     — time step (s)
         * @returns {{ altCmd: number, spdCmd: number, desiredSpeed: number }}
         *   altCmd: -1/0/+1 pitch command
         *   spdCmd: 'up'/'down'/null throttle hint
         *   desiredSpeed: target speed for this frame
         */
        _computeTransitions(dist, alt, speed, wp, dt) {
            var result = { altCmd: 0, spdCmd: null, desiredSpeed: speed };

            // --- Altitude transition ---
            var wpAlt = wp.alt;
            var altError = wpAlt - alt;

            if (Math.abs(altError) > this._altTolerance) {
                // Estimate time to arrival based on distance and speed
                var tta = (speed > 1) ? (dist / speed) : 9999;
                // Clamp minimum TTA to avoid division extremes
                tta = Math.max(tta, 5);

                // Required climb/descent rate to arrive at target altitude
                var requiredRate = altError / tta; // m/s

                // Clamp to configured max climb rate
                var clampedRate = Math.max(-this._climbRate, Math.min(this._climbRate, requiredRate));

                // If close enough that the rate would be tiny, just command directly
                if (dist < this._arrivalRadius * 3) {
                    // Near waypoint: direct command
                    if (altError > this._altTolerance) {
                        result.altCmd = 1;
                    } else if (altError < -this._altTolerance) {
                        result.altCmd = -1;
                    }
                } else {
                    // Proportional pitch: scale command by how much of climbRate we need
                    var pitchFraction = clampedRate / this._climbRate;
                    // Quantize to -1/0/+1 with a deadband
                    if (pitchFraction > 0.1) {
                        result.altCmd = 1;
                    } else if (pitchFraction < -0.1) {
                        result.altCmd = -1;
                    }
                }
            }

            // --- Speed transition ---
            var desiredSpeed = wp.speed !== undefined ? wp.speed : speed;
            result.desiredSpeed = desiredSpeed;
            var speedError = desiredSpeed - speed;

            if (Math.abs(speedError) > this._speedChangeRate * dt) {
                result.spdCmd = speedError > 0 ? 'up' : 'down';
            }

            return result;
        }

        /**
         * Generate loiter orbit commands. Flies a circular pattern centered
         * on the loiter waypoint at the given radius.
         *
         * @param {number} lat       — current lat (rad)
         * @param {number} lon       — current lon (rad)
         * @param {number} alt       — current alt (m)
         * @param {number} speed     — current speed (m/s)
         * @param {number} heading   — current heading (rad)
         * @param {object} wp        — loiter center waypoint
         * @param {number} radius    — loiter radius (m)
         * @param {number} dt        — time step
         * @returns {object} commands { pitch, roll, throttleUp, throttleDown, yaw }
         */
        _loiterCommands(lat, lon, alt, speed, heading, wp, radius, dt) {
            var commands = {
                pitch: 0, roll: 0,
                throttleUp: false, throttleDown: false,
                yaw: 0
            };

            // Distance from entity to loiter center
            var distToCenter = gcDistance(lat, lon, wp._latRad, wp._lonRad);
            // Bearing from entity to loiter center
            var bearingToCenter = gcBearing(lat, lon, wp._latRad, wp._lonRad);

            // Compute desired heading: tangent to circle (clockwise orbit).
            // Tangent heading = bearing to center + 90 degrees (right turn orbit).
            var tangentHeading = bearingToCenter + Math.PI / 2;
            if (tangentHeading >= 2 * Math.PI) tangentHeading -= 2 * Math.PI;

            // If too far from center, bias heading inward to correct back to radius
            var radiusError = distToCenter - radius;
            var correctionAngle = 0;
            if (Math.abs(radiusError) > radius * 0.1) {
                // Proportional correction: up to 45 degrees inward/outward
                correctionAngle = Math.max(-Math.PI / 4, Math.min(Math.PI / 4,
                    radiusError / radius * (Math.PI / 4)));
                // Negative correction = turn away from center (too close)
                // Positive correction = turn toward center (too far)
            }

            var desiredHeading = tangentHeading - correctionAngle;
            if (desiredHeading < 0) desiredHeading += 2 * Math.PI;
            if (desiredHeading >= 2 * Math.PI) desiredHeading -= 2 * Math.PI;

            // Heading control
            var headingError = angleDiff(desiredHeading, heading);
            if (Math.abs(headingError) > 2 * DEG) {
                commands.roll = (headingError > 0) ? 1 : -1;
            }

            // Altitude control — maintain waypoint altitude
            var altError = wp.alt - alt;
            if (altError > this._altTolerance) {
                commands.pitch = 1;
            } else if (altError < -this._altTolerance) {
                commands.pitch = -1;
            }

            // Speed control — maintain waypoint speed
            var desiredSpeed = wp.speed !== undefined ? wp.speed : speed;
            var speedError = desiredSpeed - speed;
            if (speedError > this._speedChangeRate * dt) {
                commands.throttleUp = true;
            } else if (speedError < -this._speedChangeRate * dt) {
                commands.throttleDown = true;
            }

            return commands;
        }

        update(dt, world) {
            var waypoints = this._waypoints;
            if (waypoints.length === 0 || this._finished) {
                // Update state for HUD even when finished
                if (this.entity && this.entity.state) {
                    this.entity.state._aiPhase = this._phase;
                    this.entity.state._waypointTotal = waypoints.length;
                }
                return;
            }
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
                state._aiPhase = 'TRANSIT'; // hijack overrides phase display
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

            // Current entity state (lat/lon/heading in radians, alt in m, speed in m/s)
            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var alt = state.alt || 0;
            var speed = state.speed || 0;
            var heading = state.heading || 0;

            // --- Write waypoint progress state for HUD ---
            state._waypointTotal = waypoints.length;
            state._aiPhase = this._phase;

            // --- Handle RTB mode: navigate to first waypoint ---
            if (this._rtbActive) {
                var rtbWp = waypoints[0];
                var rtbDist = gcDistance(lat, lon, rtbWp._latRad, rtbWp._lonRad);
                rtbDist *= (1 + navDistBias);
                var rtbBearing = gcBearing(lat, lon, rtbWp._latRad, rtbWp._lonRad);
                rtbBearing += navHeadingBias;

                state._waypointIndex = 0;
                state._waypointName = rtbWp.name || 'HOME';
                state._waypointDist = rtbDist;
                state._aiPhase = 'RTB';

                // Check RTB arrival
                var rtbAltError = rtbWp.alt - alt;
                if (rtbDist < this._arrivalRadius && Math.abs(rtbAltError) < this._altTolerance) {
                    // Arrived back at base
                    this._finished = true;
                    this._phase = 'COMPLETE';
                    state._aiPhase = 'COMPLETE';
                    state._commands = {
                        pitch: 0, roll: 0,
                        throttleUp: false, throttleDown: false,
                        yaw: 0
                    };
                    return;
                }

                // Generate RTB navigation commands with smooth transitions
                var rtbCommands = {
                    pitch: 0, roll: 0,
                    throttleUp: false, throttleDown: false,
                    yaw: 0
                };

                // Heading control
                var rtbHeadErr = angleDiff(rtbBearing, heading);
                if (Math.abs(rtbHeadErr * RAD) > 5.0) {
                    rtbCommands.roll = (rtbHeadErr > 0) ? 1 : -1;
                }

                // Smooth altitude/speed transitions toward home waypoint
                var rtbTrans = this._computeTransitions(rtbDist, alt, speed, rtbWp, dt);
                rtbCommands.pitch = rtbTrans.altCmd;
                if (rtbTrans.spdCmd === 'up') rtbCommands.throttleUp = true;
                else if (rtbTrans.spdCmd === 'down') rtbCommands.throttleDown = true;

                state._commands = rtbCommands;
                return;
            }

            var wp = waypoints[this._index];

            // --- Update waypoint progress state ---
            state._waypointIndex = this._index;
            state._waypointName = wp.name || ('WP ' + (this._index + 1));

            // --- Handle loiter mode ---
            if (this._loiterActive) {
                this._phase = 'LOITER';
                state._aiPhase = 'LOITER';

                this._loiterElapsed += dt;
                var loiterDuration = wp.loiterDuration_s || 0;

                // Check if loiter is complete
                if (this._loiterElapsed >= loiterDuration) {
                    this._loiterActive = false;
                    this._loiterElapsed = 0;
                    this._phase = 'TRANSIT';

                    // Advance to next waypoint
                    if (!this._advanceWaypoint()) {
                        state._commands = {
                            pitch: 0, roll: 0,
                            throttleUp: false, throttleDown: false,
                            yaw: 0
                        };
                        state._aiPhase = this._phase;
                        return;
                    }
                    // Re-read new waypoint and fall through to transit logic
                    wp = waypoints[this._index];
                    state._waypointIndex = this._index;
                    state._waypointName = wp.name || ('WP ' + (this._index + 1));
                } else {
                    // Continue loitering — fly circle pattern
                    var loiterRadius = wp.loiterRadius_m || DEFAULT_LOITER_RADIUS;
                    var dist = gcDistance(lat, lon, wp._latRad, wp._lonRad);
                    state._waypointDist = dist;
                    state._commands = this._loiterCommands(
                        lat, lon, alt, speed, heading, wp, loiterRadius, dt
                    );
                    return;
                }
            }

            // --- TRANSIT phase: navigate to current waypoint ---
            this._phase = 'TRANSIT';
            state._aiPhase = 'TRANSIT';

            // --- Distance and bearing to waypoint ---
            var dist = gcDistance(lat, lon, wp._latRad, wp._lonRad);
            dist *= (1 + navDistBias);
            var bearing = gcBearing(lat, lon, wp._latRad, wp._lonRad);
            bearing += navHeadingBias;
            var altError = wp.alt - alt;

            // Write diagnostic state
            state._waypointDist = dist;

            // --- Check arrival ---
            var withinRadius = dist < this._arrivalRadius;
            var withinAlt = Math.abs(altError) < this._altTolerance;

            if (withinRadius && withinAlt) {
                // Check if this waypoint has a loiter duration
                if (wp.loiterDuration_s && wp.loiterDuration_s > 0 && !this._loiterActive) {
                    this._loiterActive = true;
                    this._loiterElapsed = 0;
                    this._phase = 'LOITER';
                    state._aiPhase = 'LOITER';

                    // Begin loiter orbit
                    var loiterRadius = wp.loiterRadius_m || DEFAULT_LOITER_RADIUS;
                    state._commands = this._loiterCommands(
                        lat, lon, alt, speed, heading, wp, loiterRadius, dt
                    );
                    return;
                }

                // No loiter — advance to next waypoint
                if (!this._advanceWaypoint()) {
                    // No more waypoints — hold current state, zero commands
                    state._commands = {
                        pitch: 0, roll: 0,
                        throttleUp: false, throttleDown: false,
                        yaw: 0
                    };
                    state._aiPhase = this._phase;
                    return;
                }
                // Re-read new waypoint
                wp = waypoints[this._index];
                state._waypointIndex = this._index;
                state._waypointName = wp.name || ('WP ' + (this._index + 1));
                dist = gcDistance(lat, lon, wp._latRad, wp._lonRad);
                dist *= (1 + navDistBias);
                bearing = gcBearing(lat, lon, wp._latRad, wp._lonRad);
                bearing += navHeadingBias;
                altError = wp.alt - alt;
                state._waypointDist = dist;
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

            // Smooth altitude and speed transitions
            var trans = this._computeTransitions(dist, alt, speed, wp, dt);
            commands.pitch = trans.altCmd;
            if (trans.spdCmd === 'up') commands.throttleUp = true;
            else if (trans.spdCmd === 'down') commands.throttleDown = true;

            state._commands = commands;
        }

        cleanup(world) {
            // Clear commands so entity doesn't continue turning after removal
            if (this.entity && this.entity.state) {
                this.entity.state._commands = null;
                this.entity.state._aiPhase = null;
                this.entity.state._waypointIndex = null;
                this.entity.state._waypointTotal = null;
                this.entity.state._waypointName = null;
                this.entity.state._waypointDist = null;
            }
        }
    }

    return WaypointPatrol;
})();

// Register with the component registry
ComponentRegistry.register('ai', 'waypoint_patrol', WaypointPatrol);
