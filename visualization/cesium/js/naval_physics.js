/**
 * Naval Domain Physics Module
 * Surface ship movement, submarine depth control, sonar detection, torpedo weapons.
 *
 * Adds physics for naval entities that were previously static points at sea level.
 * Surface ships move via throttle/rudder with realistic acceleration and turn rates.
 * Submarines extend ship physics with depth control and submerged speed limits.
 * Sonar uses the passive sonar equation (SL - TL - NL + DI >= DT) with thermocline
 * shadow zones and convergence zone refocusing.
 * Torpedoes use proportional navigation guidance with transit/terminal/hit phases.
 */
const NavalPhysics = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;
    var R_EARTH = 6371000;            // m
    var KTS_TO_MS = 0.5144444;        // 1 knot in m/s
    var PERISCOPE_DEPTH_MIN = 15;     // m
    var PERISCOPE_DEPTH_MAX = 20;     // m
    var TORPEDO_HIT_RADIUS = 50;      // m
    var CONVERGENCE_ZONE_KM = 33;     // km between convergence zones
    var CONVERGENCE_ZONE_HALF_WIDTH = 2; // km half-width of CZ refocus band

    // -----------------------------------------------------------------------
    // Ship Configurations
    // -----------------------------------------------------------------------

    var SHIP_CONFIGS = {
        'cvn_nimitz': {
            name: 'CVN Nimitz',
            displacement_tons: 100000,
            length_m: 332,
            beam_m: 76,
            maxSpeed_kts: 30,
            cruiseSpeed_kts: 20,
            turnRate_dps: 3,
            acceleration_ms2: 0.05,
            deceleration_ms2: 0.02,
            draft_m: 12,
            rcs_m2: 50000,
            sonar: { type: 'hull_mounted', range_km: 30, frequency_hz: 7000 },
            weapons: ['rim-162', 'ciws'],
            helicopters: 4
        },
        'ddg_arleigh_burke': {
            name: 'DDG Arleigh Burke',
            displacement_tons: 9700,
            length_m: 155,
            beam_m: 20,
            maxSpeed_kts: 31,
            cruiseSpeed_kts: 20,
            turnRate_dps: 6,
            acceleration_ms2: 0.1,
            deceleration_ms2: 0.05,
            draft_m: 9.4,
            rcs_m2: 5000,
            sonar: { type: 'hull_mounted', range_km: 40, frequency_hz: 5000 },
            weapons: ['sm-2', 'harpoon', 'asroc', 'mk-46'],
            helicopters: 2
        },
        'ffg_frigate': {
            name: 'FFG Oliver Hazard Perry',
            displacement_tons: 4100,
            length_m: 138,
            beam_m: 14,
            maxSpeed_kts: 29,
            cruiseSpeed_kts: 18,
            turnRate_dps: 8,
            acceleration_ms2: 0.12,
            deceleration_ms2: 0.06,
            draft_m: 7.5,
            rcs_m2: 3000,
            sonar: { type: 'hull_mounted', range_km: 25, frequency_hz: 6000 },
            weapons: ['harpoon', 'mk-46'],
            helicopters: 2
        },
        'lhd_assault': {
            name: 'LHD Wasp',
            displacement_tons: 40500,
            length_m: 253,
            beam_m: 32,
            maxSpeed_kts: 22,
            cruiseSpeed_kts: 15,
            turnRate_dps: 4,
            acceleration_ms2: 0.06,
            deceleration_ms2: 0.03,
            draft_m: 8.1,
            rcs_m2: 30000,
            sonar: null,
            weapons: ['rim-7', 'ciws'],
            helicopters: 30
        },
        'kirov_battlecruiser': {
            name: 'Kirov Battlecruiser',
            displacement_tons: 28000,
            length_m: 252,
            beam_m: 28,
            maxSpeed_kts: 32,
            cruiseSpeed_kts: 18,
            turnRate_dps: 5,
            acceleration_ms2: 0.08,
            deceleration_ms2: 0.04,
            draft_m: 9.1,
            rcs_m2: 20000,
            sonar: { type: 'hull_mounted', range_km: 35, frequency_hz: 5500 },
            weapons: ['p-700', 's-300f', 'torpedo_533'],
            helicopters: 3
        },
        'patrol_boat': {
            name: 'Patrol Boat',
            displacement_tons: 500,
            length_m: 50,
            beam_m: 8,
            maxSpeed_kts: 40,
            cruiseSpeed_kts: 20,
            turnRate_dps: 15,
            acceleration_ms2: 0.3,
            deceleration_ms2: 0.15,
            draft_m: 3,
            rcs_m2: 200,
            sonar: null,
            weapons: ['gun_76mm'],
            helicopters: 0
        }
    };

    // -----------------------------------------------------------------------
    // Submarine Configurations
    // -----------------------------------------------------------------------

    var SUBMARINE_CONFIGS = {
        'ssn_virginia': {
            name: 'SSN Virginia',
            displacement_tons: 7900,
            length_m: 115,
            beam_m: 10,
            maxSpeed_kts_surface: 25,
            maxSpeed_kts_submerged: 34,
            cruiseSpeed_kts: 15,
            maxDepth_m: 490,
            turnRate_dps: 4,
            acceleration_ms2: 0.08,
            deceleration_ms2: 0.04,
            divePitchRate_dps: 2,
            maxDiveRate_ms: 3,
            rcs_surfaced_m2: 200,
            rcs_submerged_m2: 0.001,
            sonar: { type: 'towed_array', range_km: 100, frequency_hz: 1000, towed: true },
            weapons: ['mk-48', 'tomahawk', 'harpoon_sub'],
            torpedoTubes: 4
        },
        'ssn_los_angeles': {
            name: 'SSN Los Angeles',
            displacement_tons: 6900,
            length_m: 110,
            beam_m: 10,
            maxSpeed_kts_surface: 20,
            maxSpeed_kts_submerged: 32,
            cruiseSpeed_kts: 12,
            maxDepth_m: 450,
            turnRate_dps: 3.5,
            acceleration_ms2: 0.07,
            deceleration_ms2: 0.035,
            divePitchRate_dps: 2,
            maxDiveRate_ms: 2.5,
            rcs_surfaced_m2: 180,
            rcs_submerged_m2: 0.001,
            sonar: { type: 'towed_array', range_km: 80, frequency_hz: 1500, towed: true },
            weapons: ['mk-48', 'tomahawk'],
            torpedoTubes: 4
        },
        'kilo_class': {
            name: 'Kilo Class (Project 636)',
            displacement_tons: 3100,
            length_m: 74,
            beam_m: 10,
            maxSpeed_kts_surface: 10,
            maxSpeed_kts_submerged: 20,
            cruiseSpeed_kts: 7,
            maxDepth_m: 300,
            turnRate_dps: 3,
            acceleration_ms2: 0.05,
            deceleration_ms2: 0.03,
            divePitchRate_dps: 1.5,
            maxDiveRate_ms: 2,
            rcs_surfaced_m2: 100,
            rcs_submerged_m2: 0.001,
            sonar: { type: 'hull_mounted', range_km: 40, frequency_hz: 4000 },
            weapons: ['test-71', 'club-s'],
            torpedoTubes: 6
        }
    };

    // -----------------------------------------------------------------------
    // Torpedo Presets
    // -----------------------------------------------------------------------

    var TORPEDO_PRESETS = {
        'mk-48': {
            name: 'Mk 48 ADCAP',
            speed_kts: 55,
            range_km: 38,
            warhead_kg: 295,
            guidance: 'wire+active',
            runDepth_m: 500,
            seekerRange_m: 2000
        },
        'mk-46': {
            name: 'Mk 46',
            speed_kts: 45,
            range_km: 11,
            warhead_kg: 44,
            guidance: 'active',
            runDepth_m: 365,
            seekerRange_m: 1000
        },
        'test-71': {
            name: 'TEST-71',
            speed_kts: 40,
            range_km: 20,
            warhead_kg: 205,
            guidance: 'wire+active',
            runDepth_m: 400,
            seekerRange_m: 1500
        }
    };

    // -----------------------------------------------------------------------
    // Utility functions
    // -----------------------------------------------------------------------

    /**
     * Clamp value between min and max.
     */
    function clamp(val, min, max) {
        return val < min ? min : (val > max ? max : val);
    }

    /**
     * Wrap angle to [0, 2*PI).
     */
    function wrapHeading(h) {
        h = h % (2 * Math.PI);
        if (h < 0) h += 2 * Math.PI;
        return h;
    }

    /**
     * Compute bearing from point A to point B (radians, CW from north).
     * Inputs: lat/lon in radians.
     */
    function bearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brg = Math.atan2(y, x);
        return wrapHeading(brg);
    }

    /**
     * Haversine distance between two lat/lon points (radians). Returns meters.
     */
    function haversine(lat1, lon1, lat2, lon2) {
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R_EARTH * c;
    }

    /**
     * 3D distance including depth difference. lat/lon in radians, depths in meters.
     */
    function distance3D(lat1, lon1, depth1, lat2, lon2, depth2) {
        var surfaceDist = haversine(lat1, lon1, lat2, lon2);
        var dDepth = depth2 - depth1;
        return Math.sqrt(surfaceDist * surfaceDist + dDepth * dDepth);
    }

    // -----------------------------------------------------------------------
    // init — set up default naval state fields
    // -----------------------------------------------------------------------

    /**
     * Initialize naval state fields on an entity state object.
     * Call once before first step/stepSubmarine.
     *
     * @param {object} state - Entity state (lat, lon in radians expected)
     * @param {string} configKey - Key into SHIP_CONFIGS or SUBMARINE_CONFIGS
     * @param {boolean} isSubmarine - true for submarine entities
     * @returns {object} state with naval fields populated
     */
    function init(state, configKey, isSubmarine) {
        state.speed = state.speed || 0;
        state.heading = state.heading || 0;
        state.throttle = state.throttle || 0;
        state.rudder = state.rudder || 0;
        state.alt = isSubmarine ? -(state.depth_m || 0) : 0;

        if (isSubmarine) {
            state.depth_m = state.depth_m || 0;
            state.divePlane = state.divePlane || 0;
        }

        return state;
    }

    // -----------------------------------------------------------------------
    // step — surface ship physics
    // -----------------------------------------------------------------------

    /**
     * Advance a surface ship by dt seconds.
     *
     * @param {object} state - Ship state {lat, lon, alt, speed, heading, throttle, rudder}
     *                         lat/lon in radians, heading in radians (CW from north)
     * @param {object} controls - {throttle: -1..1, rudder: -1..1}
     * @param {number} dt - Time step in seconds
     * @param {object} config - Entry from SHIP_CONFIGS
     * @returns {object} Updated state
     */
    function step(state, controls, dt, config) {
        if (dt <= 0 || !config) return state;

        var maxSpeed = config.maxSpeed_kts * KTS_TO_MS;
        var reverseMax = maxSpeed * 0.3;

        // Apply controls
        var throttle = clamp(controls.throttle !== undefined ? controls.throttle : state.throttle, -1, 1);
        var rudder = clamp(controls.rudder !== undefined ? controls.rudder : state.rudder, -1, 1);
        state.throttle = throttle;
        state.rudder = rudder;

        // --- Speed ---
        // Target speed: positive throttle → forward, negative → reverse
        var targetSpeed;
        if (throttle >= 0) {
            targetSpeed = throttle * maxSpeed;
        } else {
            targetSpeed = throttle * reverseMax;
        }

        // Accelerate or decelerate toward target
        var speedDiff = targetSpeed - state.speed;
        var accel;
        if (Math.abs(speedDiff) < 0.001) {
            // Close enough — snap to target to prevent oscillation
            state.speed = targetSpeed;
        } else if (speedDiff > 0) {
            // Need to speed up (or reduce reverse speed toward zero/forward)
            accel = config.acceleration_ms2;
            state.speed = state.speed + accel * dt;
            if (state.speed > targetSpeed) state.speed = targetSpeed;
        } else {
            // Need to slow down (or increase reverse speed)
            accel = config.deceleration_ms2;
            state.speed = state.speed - accel * dt;
            if (state.speed < targetSpeed) state.speed = targetSpeed;
        }

        // Clamp final speed
        state.speed = clamp(state.speed, -reverseMax, maxSpeed);

        // --- Heading (turn) ---
        // Turn rate scales with speed fraction — no turning at zero speed
        var absSpeed = Math.abs(state.speed);
        if (absSpeed > 0.1) {
            var speedFraction = clamp(absSpeed / maxSpeed, 0, 1);
            var turnRate = config.turnRate_dps * DEG * speedFraction * rudder;
            state.heading = wrapHeading(state.heading + turnRate * dt);
        }

        // --- Position update (great circle) ---
        if (absSpeed > 0.01) {
            var cosH = Math.cos(state.heading);
            var sinH = Math.sin(state.heading);
            var cosLat = Math.cos(state.lat);

            // Prevent division by zero near poles
            if (Math.abs(cosLat) < 1e-10) cosLat = 1e-10;

            var dist = state.speed * dt;
            var dLat = (dist * cosH) / R_EARTH;
            var dLon = (dist * sinH) / (R_EARTH * cosLat);

            state.lat += dLat;
            state.lon += dLon;

            // Clamp latitude to valid range
            state.lat = clamp(state.lat, -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);
        }

        // Surface ships are always at sea level
        state.alt = 0;

        return state;
    }

    // -----------------------------------------------------------------------
    // stepSubmarine — submarine physics (extends ship with depth)
    // -----------------------------------------------------------------------

    /**
     * Advance a submarine by dt seconds.
     *
     * @param {object} state - Sub state {lat, lon, alt, speed, heading, depth_m,
     *                         throttle, rudder, divePlane}
     *                         lat/lon in radians, heading in radians
     * @param {object} controls - {throttle: -1..1, rudder: -1..1, divePlane: -1..1}
     *                            divePlane: -1 = dive, +1 = surface
     * @param {number} dt - Time step in seconds
     * @param {object} config - Entry from SUBMARINE_CONFIGS
     * @returns {object} Updated state
     */
    function stepSubmarine(state, controls, dt, config) {
        if (dt <= 0 || !config) return state;

        // Determine max speed based on depth
        var isSubmerged = state.depth_m > 10;
        var maxSpeedKts = isSubmerged ? config.maxSpeed_kts_submerged : config.maxSpeed_kts_surface;
        var maxSpeed = maxSpeedKts * KTS_TO_MS;
        var reverseMax = maxSpeed * 0.3;

        // Apply controls
        var throttle = clamp(controls.throttle !== undefined ? controls.throttle : state.throttle, -1, 1);
        var rudder = clamp(controls.rudder !== undefined ? controls.rudder : state.rudder, -1, 1);
        var divePlane = clamp(controls.divePlane !== undefined ? controls.divePlane : state.divePlane, -1, 1);
        state.throttle = throttle;
        state.rudder = rudder;
        state.divePlane = divePlane;

        // --- Speed ---
        var targetSpeed;
        if (throttle >= 0) {
            targetSpeed = throttle * maxSpeed;
        } else {
            targetSpeed = throttle * reverseMax;
        }

        var speedDiff = targetSpeed - state.speed;
        if (Math.abs(speedDiff) < 0.001) {
            state.speed = targetSpeed;
        } else if (speedDiff > 0) {
            state.speed = state.speed + config.acceleration_ms2 * dt;
            if (state.speed > targetSpeed) state.speed = targetSpeed;
        } else {
            state.speed = state.speed - config.deceleration_ms2 * dt;
            if (state.speed < targetSpeed) state.speed = targetSpeed;
        }
        state.speed = clamp(state.speed, -reverseMax, maxSpeed);

        // --- Heading (turn) ---
        var absSpeed = Math.abs(state.speed);
        if (absSpeed > 0.1) {
            var speedFraction = clamp(absSpeed / maxSpeed, 0, 1);
            var turnRate = config.turnRate_dps * DEG * speedFraction * rudder;
            state.heading = wrapHeading(state.heading + turnRate * dt);
        }

        // --- Depth control ---
        // divePlane: -1 = dive (increase depth), +1 = surface (decrease depth)
        var targetDiveRate = -divePlane * config.maxDiveRate_ms;  // negative divePlane → positive depth change
        state.depth_m += targetDiveRate * dt;
        state.depth_m = clamp(state.depth_m, 0, config.maxDepth_m);

        // Altitude is negative depth (below sea level)
        state.alt = -state.depth_m;

        // --- Horizontal position update (great circle) ---
        if (absSpeed > 0.01) {
            var cosH = Math.cos(state.heading);
            var sinH = Math.sin(state.heading);
            var cosLat = Math.cos(state.lat);
            if (Math.abs(cosLat) < 1e-10) cosLat = 1e-10;

            var dist = state.speed * dt;
            var dLat = (dist * cosH) / R_EARTH;
            var dLon = (dist * sinH) / (R_EARTH * cosLat);

            state.lat += dLat;
            state.lon += dLon;
            state.lat = clamp(state.lat, -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);
        }

        return state;
    }

    // -----------------------------------------------------------------------
    // SonarModel — passive sonar detection
    // -----------------------------------------------------------------------

    var SonarModel = {

        /**
         * Compute sound absorption coefficient in dB/km for a given frequency.
         * Simplified Thorp's formula.
         *
         * @param {number} freq_hz - Sonar frequency in Hz
         * @returns {number} Absorption in dB/km
         */
        absorptionCoeff: function(freq_hz) {
            var f_khz = freq_hz / 1000;
            // Thorp's equation (simplified for 1-100 kHz range):
            // alpha = 0.11 * f^2 / (1 + f^2) + 44 * f^2 / (4100 + f^2) + 2.75e-4 * f^2 + 0.003
            var f2 = f_khz * f_khz;
            var alpha = 0.11 * f2 / (1 + f2) +
                        44 * f2 / (4100 + f2) +
                        2.75e-4 * f2 + 0.003;
            return alpha;  // dB/km
        },

        /**
         * Compute source level for a target based on its speed and type.
         * Uses dB re 1 uPa @ 1m reference levels consistent with the
         * passive sonar equation. Surface ships radiate 140-170 dB;
         * submarines at creep speed are 90-110 dB.
         *
         * @param {number} speed_kts - Target speed in knots
         * @param {string} type - 'submarine' or 'surface'
         * @returns {number} Source level in dB re 1 uPa @ 1m
         */
        sourceLevel: function(speed_kts, type) {
            if (type === 'submarine' && speed_kts < 5) {
                // Ultra-quiet submarine at creep speed
                return 100;
            }
            // Base noise scales with speed: SL = 120 + 40*log10(speed/5) dB
            // At 20 kts: 120 + 40*log10(4) = 120 + 24.1 = 144 dB
            // At 30 kts: 120 + 40*log10(6) = 120 + 31.1 = 151 dB
            var baseSpeed = Math.max(speed_kts, 1);  // Avoid log(0)
            var sl = 120 + 40 * Math.log10(baseSpeed / 5);
            // Surface ships are inherently noisier (hull noise, cavitation, machinery)
            if (type === 'surface') {
                sl += 15;
            }
            return sl;
        },

        /**
         * Check if a range falls within a convergence zone.
         * Sound refocuses at ~33km, 66km, 99km intervals.
         *
         * @param {number} range_km - Distance in km
         * @returns {boolean} True if range is within a convergence zone
         */
        isConvergenceZone: function(range_km) {
            if (range_km < CONVERGENCE_ZONE_KM - CONVERGENCE_ZONE_HALF_WIDTH) return false;
            // Check each CZ (1st at 33km, 2nd at 66km, 3rd at 99km, etc.)
            var czIndex = Math.round(range_km / CONVERGENCE_ZONE_KM);
            if (czIndex < 1) return false;
            var czCenter = czIndex * CONVERGENCE_ZONE_KM;
            return Math.abs(range_km - czCenter) <= CONVERGENCE_ZONE_HALF_WIDTH;
        },

        /**
         * Run passive sonar detection against a list of targets.
         *
         * @param {{lat:number, lon:number}} listenerPos - Listener lat/lon (radians)
         * @param {number} listenerDepth - Listener depth in meters (0 = surface)
         * @param {object} listenerConfig - Sonar config from ship/sub config
         * @param {Array} targets - [{id, lat, lon, depth_m, speed_kts, type}]
         *                          lat/lon in radians, type: 'submarine'|'surface'
         * @param {object} oceanConditions - {thermoclineDepth_m, surfaceDuct, seaState}
         * @returns {Array} Detection results [{targetId, range_m, bearing_deg, Pd,
         *                  signalExcess, classification}]
         */
        detect: function(listenerPos, listenerDepth, listenerConfig, targets, oceanConditions) {
            if (!listenerConfig) return [];

            var results = [];
            var freq = listenerConfig.frequency_hz || 5000;
            var maxRange = listenerConfig.range_km * 1000;
            var isTowed = listenerConfig.towed === true;

            // Directivity index: towed arrays have better directivity
            var DI = isTowed ? 20 : 12;

            // Processing gain: modern digital signal processing advantage
            var PG = isTowed ? 25 : 15;

            // Ambient noise level: depends on sea state
            var seaState = (oceanConditions && oceanConditions.seaState !== undefined) ?
                           oceanConditions.seaState : 3;
            var NL = 60 + 5 * seaState;

            // Detection threshold
            var DT = 10;

            // Absorption coefficient for this frequency
            var absorption = this.absorptionCoeff(freq);

            // Thermocline depth
            var thermocline = (oceanConditions && oceanConditions.thermoclineDepth_m) || 100;

            for (var i = 0; i < targets.length; i++) {
                var tgt = targets[i];

                // 3D range
                var range_m = distance3D(
                    listenerPos.lat, listenerPos.lon, listenerDepth,
                    tgt.lat, tgt.lon, tgt.depth_m || 0
                );

                // Skip if beyond max sonar range
                if (range_m > maxRange || range_m < 1) continue;

                var range_km = range_m / 1000;

                // Bearing to target (for display)
                var brg = bearing(listenerPos.lat, listenerPos.lon, tgt.lat, tgt.lon);

                // Source level
                var tgtSpeed = tgt.speed_kts || 0;
                var tgtType = tgt.type || 'surface';
                var SL = this.sourceLevel(tgtSpeed, tgtType);

                // Transmission loss: spherical spreading + absorption
                var TL = 20 * Math.log10(Math.max(range_m, 1)) +
                         absorption * range_km;

                // Thermocline effect: if listener and target on opposite sides,
                // sound refracts away creating a shadow zone
                var listenerAboveThermo = listenerDepth < thermocline;
                var targetAboveThermo = (tgt.depth_m || 0) < thermocline;
                if (listenerAboveThermo !== targetAboveThermo) {
                    // Shadow zone: add significant TL penalty
                    var thermoPenalty = 20;

                    // Convergence zones: sound refocuses at periodic intervals
                    if (this.isConvergenceZone(range_km)) {
                        thermoPenalty -= 15;  // CZ refocus reduces penalty
                    }

                    TL += Math.max(thermoPenalty, 0);
                }

                // Surface duct effect: if both near surface and duct exists,
                // cylindrical spreading is more favorable
                if (oceanConditions && oceanConditions.surfaceDuct &&
                    listenerDepth < 50 && (tgt.depth_m || 0) < 50) {
                    // Cylindrical spreading instead of spherical beyond 1km
                    if (range_km > 1) {
                        var sphericalTL = 20 * Math.log10(range_m);
                        var cylindricalTL = 10 * Math.log10(range_m) + 10 * Math.log10(1000);
                        TL -= (sphericalTL - cylindricalTL);  // Reduce TL
                    }
                }

                // Signal excess: passive sonar equation (SE = SL - TL - NL + DI + PG - DT)
                var SE = SL - TL - NL + DI + PG - DT;

                // Detection probability: sigmoid centered on SE=0
                var Pd = 1 / (1 + Math.exp(-SE / 3));

                // Classification: requires good signal excess
                var classification;
                if (SE > 20) {
                    classification = tgtType;  // Correct classification
                } else if (SE > 10) {
                    classification = (tgtType === 'submarine') ? 'submarine' : 'unknown';
                } else {
                    classification = 'unknown';
                }

                // Filter: only report contacts with meaningful Pd
                if (Pd > 0.01) {
                    results.push({
                        targetId: tgt.id,
                        range_m: range_m,
                        bearing_deg: brg * RAD,
                        Pd: Pd,
                        signalExcess: SE,
                        classification: classification
                    });
                }
            }

            return results;
        }
    };

    // -----------------------------------------------------------------------
    // TorpedoModel — torpedo launch and guidance
    // -----------------------------------------------------------------------

    var TorpedoModel = {

        /** Torpedo presets accessible externally */
        PRESETS: TORPEDO_PRESETS,

        /**
         * Launch a torpedo toward a target.
         *
         * @param {{lat:number, lon:number}} launcherPos - Launcher lat/lon (radians)
         * @param {number} launcherDepth - Launcher depth in meters
         * @param {{lat:number, lon:number}} targetPos - Target lat/lon (radians)
         * @param {number} targetDepth - Target depth in meters
         * @param {object|string} torpedoConfig - Config object or preset key
         * @param {number} simTime - Current simulation time (for unique ID)
         * @returns {object} Torpedo tracking object
         */
        launch: function(launcherPos, launcherDepth, targetPos, targetDepth, torpedoConfig, simTime) {
            // Resolve preset key to config object
            if (typeof torpedoConfig === 'string') {
                torpedoConfig = TORPEDO_PRESETS[torpedoConfig];
                if (!torpedoConfig) {
                    console.warn('NavalPhysics: unknown torpedo preset:', torpedoConfig);
                    return null;
                }
            }

            var torpSpeed = torpedoConfig.speed_kts * KTS_TO_MS;
            var maxFuel_s = torpedoConfig.range_km * 1000 / torpSpeed;

            // Initial bearing to target
            var brg = bearing(launcherPos.lat, launcherPos.lon,
                              targetPos.lat, targetPos.lon);

            return {
                id: 'torp_' + (simTime || Date.now()) + '_' + Math.floor(Math.random() * 10000),
                lat: launcherPos.lat,
                lon: launcherPos.lon,
                depth_m: launcherDepth,
                heading: brg,
                speed: torpSpeed,
                fuel_remaining_s: maxFuel_s,
                targetLat: targetPos.lat,
                targetLon: targetPos.lon,
                targetDepth: targetDepth,
                phase: 'transit',
                config: torpedoConfig,
                createdAt: simTime || 0
            };
        },

        /**
         * Update a torpedo's position and guidance for one time step.
         *
         * @param {object} torpedo - Torpedo tracking object from launch()
         * @param {{lat:number, lon:number}} targetCurrentPos - Current target lat/lon (radians)
         * @param {number} targetCurrentDepth - Current target depth in meters
         * @param {number} dt - Time step in seconds
         * @returns {object} Updated torpedo (mutated in place)
         */
        updateTorpedo: function(torpedo, targetCurrentPos, targetCurrentDepth, dt) {
            if (!torpedo || torpedo.phase === 'hit' ||
                torpedo.phase === 'miss' || torpedo.phase === 'expired') {
                return torpedo;
            }

            // Check fuel
            torpedo.fuel_remaining_s -= dt;
            if (torpedo.fuel_remaining_s <= 0) {
                torpedo.phase = 'expired';
                torpedo.speed = 0;
                return torpedo;
            }

            var seekerRange = torpedo.config.seekerRange_m || 1500;

            // Compute range and bearing to current target position
            var range = distance3D(
                torpedo.lat, torpedo.lon, torpedo.depth_m,
                targetCurrentPos.lat, targetCurrentPos.lon, targetCurrentDepth
            );
            var brg = bearing(torpedo.lat, torpedo.lon,
                              targetCurrentPos.lat, targetCurrentPos.lon);

            // --- Phase transitions ---
            if (torpedo.phase === 'transit') {
                // In transit: head toward initial target position
                // Switch to terminal when within seeker range
                if (range <= seekerRange) {
                    torpedo.phase = 'terminal';
                }
            }

            // --- Guidance ---
            if (torpedo.phase === 'terminal') {
                // Terminal homing: proportional navigation toward current target position
                // Adjust heading toward target bearing
                var headingError = brg - torpedo.heading;

                // Normalize to [-PI, PI]
                while (headingError > Math.PI) headingError -= 2 * Math.PI;
                while (headingError < -Math.PI) headingError += 2 * Math.PI;

                // Proportional navigation gain (N = 3 is typical)
                var N = 3;
                var maxTurnRate = 10 * DEG;  // 10 deg/s max torpedo turn
                var turnCmd = clamp(N * headingError, -maxTurnRate, maxTurnRate);
                torpedo.heading = wrapHeading(torpedo.heading + turnCmd * dt);

                // Depth adjustment toward target depth
                var depthError = targetCurrentDepth - torpedo.depth_m;
                var maxDepthRate = torpedo.config.runDepth_m ? 5 : 3;  // m/s
                var depthCmd = clamp(depthError, -maxDepthRate * dt, maxDepthRate * dt);
                torpedo.depth_m += depthCmd;
                torpedo.depth_m = Math.max(torpedo.depth_m, 0);

                // Update target tracking (for next frame)
                torpedo.targetLat = targetCurrentPos.lat;
                torpedo.targetLon = targetCurrentPos.lon;
                torpedo.targetDepth = targetCurrentDepth;
            } else {
                // Transit phase guidance
                // Wire-guided torpedoes receive target updates from the launcher;
                // unguided transit steers toward the initial launch solution.
                var isWireGuided = torpedo.config.guidance &&
                                   torpedo.config.guidance.indexOf('wire') >= 0;
                var steerLat, steerLon, steerDepth;
                if (isWireGuided) {
                    // Wire updates: steer toward current target position
                    steerLat = targetCurrentPos.lat;
                    steerLon = targetCurrentPos.lon;
                    steerDepth = targetCurrentDepth;
                    // Update stored target for continuity if wire breaks
                    torpedo.targetLat = targetCurrentPos.lat;
                    torpedo.targetLon = targetCurrentPos.lon;
                    torpedo.targetDepth = targetCurrentDepth;
                } else {
                    // No wire: steer toward initial launch solution
                    steerLat = torpedo.targetLat;
                    steerLon = torpedo.targetLon;
                    steerDepth = torpedo.targetDepth;
                }

                var transitBrg = bearing(torpedo.lat, torpedo.lon, steerLat, steerLon);
                var transitError = transitBrg - torpedo.heading;
                while (transitError > Math.PI) transitError -= 2 * Math.PI;
                while (transitError < -Math.PI) transitError += 2 * Math.PI;

                var transitMaxTurn = 5 * DEG;  // Gentler turns in transit
                var transitCmd = clamp(transitError * 2, -transitMaxTurn, transitMaxTurn);
                torpedo.heading = wrapHeading(torpedo.heading + transitCmd * dt);

                // Gradual depth adjustment toward target depth in transit
                var transitDepthError = steerDepth - torpedo.depth_m;
                var transitDepthRate = 2;  // m/s, slower in transit
                var transitDepthCmd = clamp(transitDepthError, -transitDepthRate * dt, transitDepthRate * dt);
                torpedo.depth_m += transitDepthCmd;
                torpedo.depth_m = Math.max(torpedo.depth_m, 0);
            }

            // --- Position update ---
            var dist = torpedo.speed * dt;
            var cosH = Math.cos(torpedo.heading);
            var sinH = Math.sin(torpedo.heading);
            var cosLat = Math.cos(torpedo.lat);
            if (Math.abs(cosLat) < 1e-10) cosLat = 1e-10;

            torpedo.lat += (dist * cosH) / R_EARTH;
            torpedo.lon += (dist * sinH) / (R_EARTH * cosLat);
            torpedo.lat = clamp(torpedo.lat, -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);

            // --- Hit check ---
            range = distance3D(
                torpedo.lat, torpedo.lon, torpedo.depth_m,
                targetCurrentPos.lat, targetCurrentPos.lon, targetCurrentDepth
            );
            if (range <= TORPEDO_HIT_RADIUS) {
                torpedo.phase = 'hit';
                torpedo.speed = 0;
            }

            // --- Miss check (passed the target and diverging in terminal) ---
            if (torpedo.phase === 'terminal') {
                var closingSpeed = -((targetCurrentPos.lat - torpedo.lat) * cosH +
                                     (targetCurrentPos.lon - torpedo.lon) * sinH) *
                                    R_EARTH;  // Approximate closing speed
                // If range is increasing and we are past seeker range, declare miss
                // Use a simpler heuristic: if in terminal for too long relative to
                // expected closure time, it's a miss
                if (range > seekerRange * 2 && torpedo.fuel_remaining_s <
                    torpedo.config.range_km * 1000 / torpedo.speed * 0.5) {
                    torpedo.phase = 'miss';
                    torpedo.speed = 0;
                }
            }

            return torpedo;
        }
    };

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    return {
        /** Initialize naval state fields. */
        init: init,

        /** Step surface ship physics. */
        step: step,

        /** Step submarine physics (extends ship with depth). */
        stepSubmarine: stepSubmarine,

        /** Surface ship configurations. */
        SHIP_CONFIGS: SHIP_CONFIGS,

        /** Submarine configurations. */
        SUBMARINE_CONFIGS: SUBMARINE_CONFIGS,

        /** Passive sonar detection model. */
        SonarModel: SonarModel,

        /** Torpedo launch and guidance model. */
        TorpedoModel: TorpedoModel,

        /** Torpedo preset configurations. */
        TORPEDO_PRESETS: TORPEDO_PRESETS,

        /** Unit conversion constants. */
        DEG: DEG,
        RAD: RAD,
        R_EARTH: R_EARTH,
        KTS_TO_MS: KTS_TO_MS,

        /** Utility: haversine distance (lat/lon in radians → meters). */
        haversine: haversine,

        /** Utility: bearing between two points (radians → radians CW from north). */
        bearing: bearing,

        /** Utility: 3D distance including depth (meters). */
        distance3D: distance3D
    };

})();
