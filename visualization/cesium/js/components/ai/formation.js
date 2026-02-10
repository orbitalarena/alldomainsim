/**
 * FormationAI component -- maintains an aircraft in a configurable formation
 * position relative to a leader entity.
 *
 * Writes to entity.state._commands using the same interface as PlayerInput /
 * WaypointPatrol / InterceptAI, so PhysicsSystem / FighterSimEngine processes
 * the commands identically.
 *
 * Config (from scenario JSON):
 *   leaderId    -- id of the leader entity to follow
 *   position    -- formation slot name (see FORMATION_OFFSETS)
 *   spacing     -- base spacing in meters (default 500)
 *   stackOffset -- altitude offset in meters above leader (default 0)
 *
 * Formation positions (relative to leader heading):
 *   right_wing      -- 500m right, 100m back
 *   left_wing       -- 500m left, 100m back
 *   trail           -- directly behind at spacing meters
 *   echelon_right   -- 45 deg right-back
 *   echelon_left    -- 45 deg left-back
 *   finger_four_2   -- classic #2 (right wing)
 *   finger_four_3   -- classic #3 (left wing wide)
 *   finger_four_4   -- classic #4 (trail right)
 *
 * Graceful degradation: if leader is missing or dead, the wingman holds its
 * last known heading and altitude (continues straight and level).
 */
const FormationAI = (function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;
    const RAD = FrameworkConstants.RAD;
    const R_EARTH = FrameworkConstants.R_EARTH;

    // ------------------------------------------------------------------
    // Formation offset definitions
    // Each entry: { bearingOffset (rad from leader heading), distance (m) }
    // bearingOffset is clockwise from leader heading: +90 = right, -90 = left, 180 = behind
    // ------------------------------------------------------------------
    var PI = Math.PI;

    var FORMATION_OFFSETS = {
        // right_wing: 500m right, 100m back  =>  ~atan2(500, 100) ~ 78.7 deg right-back, dist ~510m
        right_wing:    { bearingOffset:  PI / 2,  lateralFrac: 1.0,  trailFrac: 0.2 },
        // left_wing: 500m left, 100m back
        left_wing:     { bearingOffset: -PI / 2,  lateralFrac: 1.0,  trailFrac: 0.2 },
        // trail: directly behind at spacing
        trail:         { bearingOffset:  PI,      lateralFrac: 0.0,  trailFrac: 1.0 },
        // echelon_right: 45 deg right-back
        echelon_right: { bearingOffset:  PI / 4 + PI / 2, lateralFrac: 0.707, trailFrac: 0.707 },
        // echelon_left: 45 deg left-back
        echelon_left:  { bearingOffset: -(PI / 4 + PI / 2), lateralFrac: 0.707, trailFrac: 0.707 },
        // Finger-four formation
        // #2: right wing (same as right_wing)
        finger_four_2: { bearingOffset:  PI / 2,  lateralFrac: 1.0,  trailFrac: 0.2 },
        // #3: left wing wide (1.5x spacing)
        finger_four_3: { bearingOffset: -PI / 2,  lateralFrac: 1.5,  trailFrac: 0.3 },
        // #4: trail right
        finger_four_4: { bearingOffset:  PI * 3 / 4, lateralFrac: 0.707, trailFrac: 0.707 }
    };

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
        while (d > Math.PI)  d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    // ------------------------------------------------------------------
    // Helper: destination point from (lat, lon) along bearing for distance.
    // All args in radians / meters. Returns { lat, lon } in radians.
    // ------------------------------------------------------------------
    function destinationPoint(lat, lon, bearing, distance) {
        var d = distance / R_EARTH;
        var lat2 = Math.asin(
            Math.sin(lat) * Math.cos(d) +
            Math.cos(lat) * Math.sin(d) * Math.cos(bearing)
        );
        var lon2 = lon + Math.atan2(
            Math.sin(bearing) * Math.sin(d) * Math.cos(lat),
            Math.cos(d) - Math.sin(lat) * Math.sin(lat2)
        );
        return { lat: lat2, lon: lon2 };
    }

    // ------------------------------------------------------------------
    // Helper: clamp a number to [min, max].
    // ------------------------------------------------------------------
    function clamp(val, min, max) {
        return val < min ? min : (val > max ? max : val);
    }

    // ------------------------------------------------------------------
    // FormationAI component
    // ------------------------------------------------------------------
    class FormationAIComponent extends ECS.Component {
        constructor(config) {
            super(config);

            this._leaderId    = config.leaderId    || null;
            this._position    = config.position    || 'right_wing';
            this._spacing     = config.spacing     || 500;   // meters
            this._stackOffset = config.stackOffset || 0;     // meters altitude offset

            // Steering gains
            this._Kp_heading  = config.Kp_heading  || 2.0;   // heading proportional gain
            this._Kp_speed    = config.Kp_speed    || 0.1;   // speed correction per meter of distance error
            this._Kp_alt      = config.Kp_alt      || 0.001; // altitude correction gain
            this._maxSpeedCorr = config.maxSpeedCorr || 50;   // max speed correction m/s
            this._maxSpeed    = config.maxSpeed     || 350;   // max aircraft speed for throttle normalization

            // Fallback state when leader is lost
            this._lastLeaderHeading = 0;
            this._lastLeaderAlt     = 5000;
            this._lastLeaderSpeed   = 200;
            this._leaderLost        = false;
        }

        init(world) {
            var state = this.entity.state;
            state._commands = state._commands || {
                pitch: 0, roll: 0, yaw: 0,
                throttleUp: false, throttleDown: false
            };
            state._formationState = 'forming';
            state._formationDist = 0;
            state._formationLeader = this._leaderId;
        }

        update(dt, world) {
            var state = this.entity.state;
            var leader = this._leaderId ? world.getEntity(this._leaderId) : null;

            var cmd = { pitch: 0, roll: 0, yaw: 0, throttleUp: false, throttleDown: false };

            // --- Leader lookup and fallback ---
            var leaderLat, leaderLon, leaderAlt, leaderSpeed, leaderHeading;

            if (leader && leader.active) {
                var ls = leader.state;
                leaderLat     = ls.lat     || 0;
                leaderLon     = ls.lon     || 0;
                leaderAlt     = ls.alt     || 0;
                leaderSpeed   = ls.speed   || 0;
                leaderHeading = ls.heading || 0;

                // Store for fallback
                this._lastLeaderHeading = leaderHeading;
                this._lastLeaderAlt     = leaderAlt;
                this._lastLeaderSpeed   = leaderSpeed;
                this._leaderLost        = false;
                state._formationState   = 'formed';
            } else {
                // Leader not found or dead -- hold last known heading, straight and level
                this._leaderLost      = true;
                state._formationState = 'lost_leader';

                // Fly straight at last known heading/speed/alt
                var myHeading = state.heading || 0;
                var headingError = angleDiff(this._lastLeaderHeading, myHeading);
                cmd.roll = clamp(headingError * this._Kp_heading, -1, 1);

                var altError = this._lastLeaderAlt + this._stackOffset - (state.alt || 0);
                cmd.pitch = clamp(altError * this._Kp_alt, -0.3, 0.3) > 0.05 ? -1 :
                            (clamp(altError * this._Kp_alt, -0.3, 0.3) < -0.05 ? 1 : 0);

                var currentSpeed = state.speed || 0;
                if (currentSpeed < this._lastLeaderSpeed - 5) {
                    cmd.throttleUp = true;
                } else if (currentSpeed > this._lastLeaderSpeed + 5) {
                    cmd.throttleDown = true;
                }

                state._commands = cmd;
                return;
            }

            // --- Compute desired position from formation offset ---
            var offset = FORMATION_OFFSETS[this._position];
            if (!offset) {
                offset = FORMATION_OFFSETS['right_wing']; // fallback
            }

            // Compute the actual bearing from leader's heading + offset geometry.
            // lateral = perpendicular to heading, trail = behind heading
            var lateralDist = offset.lateralFrac * this._spacing;
            var trailDist   = offset.trailFrac * this._spacing;

            // Determine lateral direction (sign from bearingOffset)
            var lateralSign = offset.bearingOffset >= 0 ? 1 : -1;
            // For positions that are purely trail, skip lateral
            if (Math.abs(offset.lateralFrac) < 0.001) lateralSign = 0;

            // Compute the actual offset bearing and distance
            // Trail is behind the leader (heading + PI), lateral is +/- PI/2
            var dx = lateralSign * lateralDist;  // positive = right of leader
            var dy = -trailDist;                 // negative = behind leader

            // Convert (dx, dy) relative to leader heading into a bearing and distance
            var offsetDist = Math.sqrt(dx * dx + dy * dy);
            if (offsetDist < 1) offsetDist = 1; // avoid division by zero

            // Bearing relative to leader heading: atan2(right, forward)
            var offsetBearing = Math.atan2(dx, dy);
            var absoluteBearing = leaderHeading + offsetBearing;

            // Desired position on the globe
            var desired = destinationPoint(leaderLat, leaderLon, absoluteBearing, offsetDist);
            var desiredAlt = leaderAlt + this._stackOffset;

            // --- Compute steering to desired position ---
            var myLat = state.lat || 0;
            var myLon = state.lon || 0;
            var myAlt = state.alt || 0;
            var mySpeed = state.speed || 0;
            var myHeading = state.heading || 0;

            var distToDesired = gcDistance(myLat, myLon, desired.lat, desired.lon);
            var bearingToDesired = gcBearing(myLat, myLon, desired.lat, desired.lon);

            state._formationDist = distToDesired;

            // --- Heading control ---
            var headingError = angleDiff(bearingToDesired, myHeading);

            // When very close (within 50m), reduce heading authority to avoid oscillation
            var headingGain = this._Kp_heading;
            if (distToDesired < 50) {
                headingGain *= distToDesired / 50;
            }

            cmd.roll = clamp(headingError * headingGain, -1, 1);

            // --- Speed control ---
            // Match leader speed + proportional correction for distance error
            var speedCorrection = clamp(distToDesired * this._Kp_speed, -this._maxSpeedCorr, this._maxSpeedCorr);
            var desiredSpeed = leaderSpeed + speedCorrection;

            var speedError = desiredSpeed - mySpeed;
            if (speedError > 5) {
                cmd.throttleUp = true;
            } else if (speedError < -5) {
                cmd.throttleDown = true;
            }

            // --- Altitude control ---
            var altError = desiredAlt - myAlt;
            var pitchCmd = clamp(altError * this._Kp_alt, -0.3, 0.3);
            if (pitchCmd > 0.05) {
                cmd.pitch = -1;  // nose up = climb (pitch input is inverted in flight3dof)
            } else if (pitchCmd < -0.05) {
                cmd.pitch = 1;   // nose down = descend
            }

            state._commands = cmd;
        }

        cleanup(world) {
            if (this.entity && this.entity.state) {
                this.entity.state._formationState = 'idle';
                this.entity.state._commands = {
                    pitch: 0, roll: 0, yaw: 0,
                    throttleUp: false, throttleDown: false
                };
            }
        }

        static editorSchema() {
            return [
                { name: 'leaderId',    type: 'entity', label: 'Leader Entity' },
                { name: 'position',    type: 'select', label: 'Formation Position',
                    options: ['right_wing', 'left_wing', 'trail', 'echelon_right',
                              'echelon_left', 'finger_four_2', 'finger_four_3',
                              'finger_four_4'],
                    default: 'right_wing' },
                { name: 'spacing',     type: 'number', label: 'Spacing (m)',        default: 500 },
                { name: 'stackOffset', type: 'number', label: 'Alt Offset (m)',     default: 0 },
                { name: 'maxSpeed',    type: 'number', label: 'Max Speed (m/s)',    default: 350 }
            ];
        }
    }

    return FormationAIComponent;
})();

// Register with the component registry
ComponentRegistry.register('ai', 'formation', FormationAI);
