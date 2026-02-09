/**
 * Electronic Warfare & Signature Modeling System
 *
 * Provides realistic RCS-based radar detection, active jamming, decoy
 * deployment, and passive SIGINT (emitter detection). Designed as a pure
 * computation module with no Cesium dependency -- positions are {lat, lon, alt}
 * objects (radians for lat/lon, meters for alt).
 *
 * Integration:
 *   - Radar component calls getRCS() + computeDetectionPd() each sweep
 *   - Player HUD calls detectEmitters() for SIGINT display
 *   - Weapon system calls deployDecoy() on decoy activation
 *   - Frame loop calls update(dt, simTime) to age decoys
 */
const EWSystem = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------

    var PI  = Math.PI;
    var TWO_PI = 2 * PI;
    var DEG = PI / 180;
    var RAD = 180 / PI;
    var R_EARTH = 6371000;           // m mean radius
    var C_LIGHT = 299792458;         // m/s
    var K_BOLTZMANN = 1.3806e-23;    // J/K

    // Radar defaults
    var DEFAULT_RADAR_POWER   = 10000;   // W
    var DEFAULT_ANTENNA_GAIN  = 35;      // dBi
    var DEFAULT_WAVELENGTH    = 0.03;    // m (X-band, 10 GHz)
    var DEFAULT_NOISE_FLOOR   = -100;    // dBm
    var DEFAULT_PFA           = 1e-6;    // false alarm probability

    // Decoy defaults
    var DECOY_RCS       = 20.0;    // m^2
    var DECOY_LIFETIME  = 30;      // seconds
    var DECOY_MIN_SPEED = 50;      // m/s
    var DECOY_MAX_SPEED = 100;     // m/s

    // Precomputed threshold from Pfa: threshold = -ln(Pfa)
    var DETECTION_THRESHOLD = -Math.log(DEFAULT_PFA); // ~13.8

    // Counter for unique decoy IDs
    var _decoyIdCounter = 0;

    // Active decoy pool
    var _activeDecoys = [];

    // -----------------------------------------------------------------------
    // RCS Database (frontal aspect, m^2)
    // -----------------------------------------------------------------------

    var RCS_DB = {
        // Aircraft
        'f16':        5.0,
        'f15':        25.0,
        'f22':        0.001,
        'f35':        0.005,
        'mig29':      5.0,
        'su27':       15.0,
        'su57':       0.1,
        'bomber':     10.0,
        'b1':         1.0,
        'b2':         0.001,
        'awacs':      50.0,
        'transport':  40.0,
        'drone_male': 0.5,
        'drone_hale': 1.0,
        'mq9':        0.5,
        'spaceplane': 0.1,
        // Missiles
        'aim120':        0.02,
        'aim9':          0.01,
        'sam_missile':   0.05,
        'cruise_missile':0.1,
        // Space
        'satellite_small': 1.0,
        'satellite_large': 10.0,
        'satellite_geo':   5.0,
        // Ships
        'destroyer':           5000,
        'carrier':             50000,
        'frigate':             3000,
        'submarine_surfaced':  200,
        'submarine_submerged': 0.001,
        // Ground
        'sam_battery':    20.0,
        'ground_station': 5.0,
        // Fallback
        'default': 10.0
    };

    // -----------------------------------------------------------------------
    // init / cleanup
    // -----------------------------------------------------------------------

    /**
     * Initialize (or re-initialize) the EW system. Clears all decoy state.
     */
    function init() {
        _activeDecoys = [];
        _decoyIdCounter = 0;
    }

    /**
     * Tear down -- release all decoy references.
     */
    function cleanup() {
        _activeDecoys = [];
    }

    // -----------------------------------------------------------------------
    // RCS lookup with aspect modulation
    // -----------------------------------------------------------------------

    /**
     * Look up radar cross section for an entity.
     *
     * @param {string} entityType   Key into RCS_DB (e.g. 'f16', 'destroyer')
     * @param {string} [config]     Aircraft config name -- tried before entityType
     * @param {number} [aspectAngle=0]  Angle from nose-on in radians:
     *        0 = nose-on, PI/2 = broadside, PI = tail-on
     * @returns {number} RCS in m^2
     */
    function getRCS(entityType, config, aspectAngle) {
        // Resolve base frontal RCS
        var base = RCS_DB['default'];
        if (config && RCS_DB.hasOwnProperty(config)) {
            base = RCS_DB[config];
        } else if (entityType && RCS_DB.hasOwnProperty(entityType)) {
            base = RCS_DB[entityType];
        }

        // Aspect modulation: broadside is ~3x frontal, tail is ~0.5x frontal.
        // Model as raised cosine blend over aspect angle.
        if (typeof aspectAngle === 'number' && isFinite(aspectAngle)) {
            // Normalize to [0, PI]
            var a = Math.abs(aspectAngle) % PI;
            // Modulation curve: 1.0 at nose, 3.0 at broadside, 0.5 at tail
            // Use piecewise linear: nose→broadside (0→PI/2): 1→3
            //                       broadside→tail (PI/2→PI): 3→0.5
            var factor;
            if (a <= PI / 2) {
                factor = 1.0 + (3.0 - 1.0) * (a / (PI / 2));  // 1 → 3
            } else {
                factor = 3.0 + (0.5 - 3.0) * ((a - PI / 2) / (PI / 2)); // 3 → 0.5
            }
            return base * factor;
        }

        return base;
    }

    // -----------------------------------------------------------------------
    // Radar detection probability (radar range equation + Swerling-1)
    // -----------------------------------------------------------------------

    /**
     * Compute detection probability using the radar range equation and
     * Swerling Case 1 fluctuation model.
     *
     * @param {number} [radarPower_w=10000]   Transmit power in watts
     * @param {number} [antennaGain_dBi=35]   Antenna gain in dBi (Tx = Rx)
     * @param {number} range_m                Slant range to target in meters
     * @param {number} rcs_m2                 Target RCS in m^2
     * @param {number} [noiseFloor_dBm=-100]  Receiver noise floor in dBm
     * @param {number} [jammerPower_w=0]      Jammer effective radiated power
     * @returns {number} Detection probability [0, 1]
     */
    function computeDetectionPd(radarPower_w, antennaGain_dBi, range_m, rcs_m2, noiseFloor_dBm, jammerPower_w) {
        // Default parameters
        var Pt   = (typeof radarPower_w === 'number' && isFinite(radarPower_w))
                   ? radarPower_w : DEFAULT_RADAR_POWER;
        var G_dB = (typeof antennaGain_dBi === 'number' && isFinite(antennaGain_dBi))
                   ? antennaGain_dBi : DEFAULT_ANTENNA_GAIN;
        var Nf   = (typeof noiseFloor_dBm === 'number' && isFinite(noiseFloor_dBm))
                   ? noiseFloor_dBm : DEFAULT_NOISE_FLOOR;
        var Pj   = (typeof jammerPower_w === 'number' && isFinite(jammerPower_w))
                   ? jammerPower_w : 0;

        // Validate critical inputs
        if (typeof range_m !== 'number' || !isFinite(range_m) || range_m <= 0) {
            return 0;
        }
        if (typeof rcs_m2 !== 'number' || !isFinite(rcs_m2) || rcs_m2 <= 0) {
            return 0;
        }

        // Antenna gain (linear, same for Tx and Rx)
        var Gt = Math.pow(10, G_dB / 10);
        var Gr = Gt;

        // Wavelength
        var lambda = DEFAULT_WAVELENGTH;

        // Noise power (convert dBm to watts)
        var kTB = Math.pow(10, Nf / 10) / 1000;  // dBm → W

        // Radar range equation: SNR = (Pt * Gt * Gr * lambda^2 * sigma) /
        //                              ((4*PI)^3 * R^4 * kTB)
        var fourPiCubed = Math.pow(4 * PI, 3);
        var R4 = Math.pow(range_m, 4);
        var numerator   = Pt * Gt * Gr * lambda * lambda * rcs_m2;
        var denominator = fourPiCubed * R4 * kTB;

        if (denominator <= 0) {
            return 0;
        }

        var snr = numerator / denominator;

        // Apply jammer noise (self-screening jammer, co-located with target)
        // J/S = Pj * 4*PI * R^2 / (Pt * Gt * sigma)
        if (Pj > 0 && Pt > 0 && rcs_m2 > 0) {
            var js_ratio = (Pj * 4 * PI * range_m * range_m) / (Pt * Gt * rcs_m2);
            snr = snr / (1 + js_ratio);
        }

        // Guard against non-positive SNR
        if (snr <= 0 || !isFinite(snr)) {
            return 0;
        }

        // Swerling Case 1: Pd = exp(-threshold / (1 + SNR))
        var pd = Math.exp(-DETECTION_THRESHOLD / (1 + snr));

        // Clamp
        if (pd < 0) { pd = 0; }
        if (pd > 1) { pd = 1; }
        if (!isFinite(pd)) { pd = 0; }

        return pd;
    }

    // -----------------------------------------------------------------------
    // Jamming query
    // -----------------------------------------------------------------------

    /**
     * Check if an entity has an active jammer and return its parameters.
     *
     * @param {object} entityDef  Entity definition (with optional _custom)
     * @returns {object|null} {active, power_w, range_km} or null
     */
    function applyJamming(entityDef) {
        if (!entityDef) { return null; }

        // Navigate to jammer definition
        var custom = entityDef._custom;
        if (!custom) { return null; }

        // Check both 'payload' (singular) and 'payloads' (plural) paths
        var payload = custom.payload || custom.payloads;
        if (!payload) { return null; }

        var jammer = payload.jammer;
        if (!jammer) { return null; }

        if (!jammer.enabled) {
            return { active: false, power_w: 0, range_km: 0 };
        }

        return {
            active:   true,
            power_w:  jammer.power_w  || 1000,   // default 1 kW ERP
            range_km: jammer.range_km || 100      // default 100 km effective
        };
    }

    // -----------------------------------------------------------------------
    // Decoy deployment and management
    // -----------------------------------------------------------------------

    /**
     * Deploy one or more radar decoys near a position.
     *
     * @param {object} position    {lat, lon, alt} in radians / meters
     * @param {object} velocity    {speed, heading, gamma} parent velocity state
     * @param {string} team        Team identifier (e.g. 'blue', 'red')
     * @param {number} [count=1]   Number of decoys to deploy
     * @param {number} [simTime=0] Current sim time for aging
     * @returns {Array} Array of decoy objects
     */
    function deployDecoy(position, velocity, team, count, simTime) {
        if (!position) { return []; }

        var n = (typeof count === 'number' && count > 0) ? Math.floor(count) : 1;
        var t = (typeof simTime === 'number') ? simTime : 0;
        var deployed = [];

        for (var i = 0; i < n; i++) {
            // Random drift direction and speed
            var driftHeading = Math.random() * TWO_PI;
            var driftSpeed   = DECOY_MIN_SPEED + Math.random() * (DECOY_MAX_SPEED - DECOY_MIN_SPEED);

            // Velocity components (m/s in ENU-ish local frame)
            var vEast  = driftSpeed * Math.sin(driftHeading);
            var vNorth = driftSpeed * Math.cos(driftHeading);

            // Small random altitude offset so decoys spread vertically
            var altOffset = (Math.random() - 0.5) * 200; // +/- 100 m

            var decoy = {
                id:        'decoy_' + (++_decoyIdCounter),
                position:  {
                    lat: position.lat || 0,
                    lon: position.lon || 0,
                    alt: (position.alt || 0) + altOffset
                },
                velocity:  { east: vEast, north: vNorth },
                rcs:       DECOY_RCS,
                team:      team || 'unknown',
                createdAt: t,
                lifetime:  DECOY_LIFETIME
            };

            _activeDecoys.push(decoy);
            deployed.push(decoy);
        }

        return deployed;
    }

    /**
     * Return the array of currently active decoys (live reference).
     * @returns {Array}
     */
    function getDecoys() {
        return _activeDecoys;
    }

    // -----------------------------------------------------------------------
    // Passive SIGINT -- emitter detection
    // -----------------------------------------------------------------------

    /**
     * Compute initial bearing from position 1 to position 2 on a sphere.
     * @param {number} lat1  Radians
     * @param {number} lon1  Radians
     * @param {number} lat2  Radians
     * @param {number} lon2  Radians
     * @returns {number} Bearing in degrees [0, 360)
     */
    function _bearing(lat1, lon1, lat2, lon2) {
        var dlon = lon2 - lon1;
        var y = Math.sin(dlon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
        var brg = Math.atan2(y, x) * RAD;
        return (brg + 360) % 360;
    }

    /**
     * Haversine distance between two geodetic positions.
     * @param {number} lat1  Radians
     * @param {number} lon1  Radians
     * @param {number} alt1  Meters
     * @param {number} lat2  Radians
     * @param {number} lon2  Radians
     * @param {number} alt2  Meters
     * @returns {number} Slant range in meters (great-circle + altitude difference)
     */
    function _slantRange(lat1, lon1, alt1, lat2, lon2, alt2) {
        var dlat = lat2 - lat1;
        var dlon = lon2 - lon1;
        var a = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dlon / 2) * Math.sin(dlon / 2);
        var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        var groundDist = R_EARTH * c;
        var dAlt = (alt2 || 0) - (alt1 || 0);
        return Math.sqrt(groundDist * groundDist + dAlt * dAlt);
    }

    /**
     * Detect entities that are actively emitting (radar or jammer).
     *
     * @param {object} listenerPos       {lat, lon, alt} in radians / meters
     * @param {number} listenerRange_m   Maximum passive detection range in meters
     * @param {Array}  entities          Array of entity objects. Each should have:
     *        - id, state.lat, state.lon, state.alt
     *        - optionally: state._radarActive or component data for radar
     *        - optionally: _custom.payload.jammer.enabled for active jammer
     * @returns {Array} Detected emitters: [{entityId, bearing_deg, range_m,
     *                  type: 'radar'|'jammer', power_est}]
     */
    function detectEmitters(listenerPos, listenerRange_m, entities) {
        if (!listenerPos || !entities || !Array.isArray(entities)) {
            return [];
        }
        if (typeof listenerRange_m !== 'number' || listenerRange_m <= 0) {
            return [];
        }

        var results = [];
        var lLat = listenerPos.lat || 0;
        var lLon = listenerPos.lon || 0;
        var lAlt = listenerPos.alt || 0;

        for (var i = 0; i < entities.length; i++) {
            var ent = entities[i];
            if (!ent) { continue; }

            var st = ent.state || ent;
            var eLat = st.lat;
            var eLon = st.lon;
            var eAlt = st.alt || 0;

            if (typeof eLat !== 'number' || typeof eLon !== 'number') {
                continue;
            }

            // Check if this entity is emitting
            var isRadar  = false;
            var isJammer = false;
            var emitterPower = 0;

            // Radar emission check
            if (st._radarActive === true || st._radarScanAz !== undefined) {
                isRadar = true;
                emitterPower = st._radarPower || DEFAULT_RADAR_POWER;
            }

            // Jammer emission check
            var jamInfo = applyJamming(ent);
            if (jamInfo && jamInfo.active) {
                isJammer = true;
                emitterPower = Math.max(emitterPower, jamInfo.power_w);
            }

            if (!isRadar && !isJammer) {
                continue;
            }

            // Compute range
            var range = _slantRange(lLat, lLon, lAlt, eLat, eLon, eAlt);
            if (range > listenerRange_m) {
                continue;
            }

            // Bearing from listener to emitter
            var brg = _bearing(lLat, lLon, eLat, eLon);

            // Estimated received power (1/R^2 scaled, arbitrary units for display)
            var powerEst = (range > 0) ? emitterPower / (range * range) : 0;

            // Report each emission type separately
            if (isRadar) {
                results.push({
                    entityId:  ent.id || ('unknown_' + i),
                    bearing_deg: brg,
                    range_m:   range,
                    type:      'radar',
                    power_est: powerEst
                });
            }
            if (isJammer) {
                results.push({
                    entityId:  ent.id || ('unknown_' + i),
                    bearing_deg: brg,
                    range_m:   range,
                    type:      'jammer',
                    power_est: powerEst
                });
            }
        }

        return results;
    }

    // -----------------------------------------------------------------------
    // Per-frame update (age decoys, drift positions)
    // -----------------------------------------------------------------------

    /**
     * Update all EW state. Call once per sim frame.
     *
     * @param {number} dt       Time step in seconds
     * @param {number} simTime  Current simulation time in seconds
     */
    function update(dt, simTime) {
        if (!dt || dt <= 0) { return; }

        // Walk decoys backwards so splice doesn't skip entries
        for (var i = _activeDecoys.length - 1; i >= 0; i--) {
            var d = _activeDecoys[i];

            // Check expiry
            var age = simTime - d.createdAt;
            if (age >= d.lifetime) {
                _activeDecoys.splice(i, 1);
                continue;
            }

            // Drift position (small-angle approximation for short distances)
            var cosLat = Math.cos(d.position.lat);
            if (cosLat < 1e-6) { cosLat = 1e-6; } // pole guard

            // Convert east/north velocity to lat/lon rate (radians/s)
            var dLat = (d.velocity.north * dt) / R_EARTH;
            var dLon = (d.velocity.east  * dt) / (R_EARTH * cosLat);

            d.position.lat += dLat;
            d.position.lon += dLon;

            // Decoys lose altitude slowly (simulate drag / gravity)
            d.position.alt -= 2.0 * dt; // 2 m/s descent
            if (d.position.alt < 0) {
                // Hit the ground -- remove
                _activeDecoys.splice(i, 1);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    return {
        init:               init,
        getRCS:             getRCS,
        computeDetectionPd: computeDetectionPd,
        applyJamming:       applyJamming,
        deployDecoy:        deployDecoy,
        detectEmitters:     detectEmitters,
        getDecoys:          getDecoys,
        update:             update,
        cleanup:            cleanup,

        // Expose DB for external inspection / override
        RCS_DB: RCS_DB
    };
})();
