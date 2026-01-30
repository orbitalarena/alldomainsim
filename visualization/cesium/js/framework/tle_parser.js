/**
 * TLEParser - Parse Two-Line Element sets and convert to orbital state vectors.
 *
 * Handles standard NORAD TLE format:
 *   Line 0: Satellite Name (optional)
 *   Line 1: 1 NNNNNC NNNNNAAA NNNNN.NNNNNNNN ...
 *   Line 2: 2 NNNNN NNN.NNNN NNN.NNNN NNNNNNN NNN.NNNN NNN.NNNN NN.NNNNNNNN...
 *
 * Outputs classical orbital elements + ECI state vectors for use by
 * the orbital_2body physics component.
 */
const TLEParser = (function() {
    'use strict';

    var MU = 3.986004418e14;       // m^3/s^2 Earth gravitational parameter
    var R_EARTH = 6371000;          // m mean radius
    var TWO_PI = 2 * Math.PI;
    var DEG = Math.PI / 180;
    var RAD = 180 / Math.PI;
    var OMEGA_EARTH = 7.2921159e-5; // rad/s

    // -------------------------------------------------------------------
    // Bulk TLE File Parsing
    // -------------------------------------------------------------------

    /**
     * Parse a text block containing one or more TLE entries.
     * Handles both 2-line (no name) and 3-line (with name) formats.
     *
     * @param {string} text  raw TLE file content
     * @returns {Array<object>} array of parsed satellite objects
     */
    function parse(text) {
        var lines = text.split(/\r?\n/).map(function(l) { return l.trimRight(); })
                        .filter(function(l) { return l.length > 0; });
        var satellites = [];
        var i = 0;

        while (i < lines.length) {
            var line = lines[i];

            // Look for Line 1 (starts with '1 ')
            if (line.length >= 69 && line.charAt(0) === '1' && line.charAt(1) === ' ') {
                // Check if next line is Line 2
                if (i + 1 < lines.length && lines[i + 1].charAt(0) === '2') {
                    // Check if previous line is a name (not a TLE line)
                    var name = '';
                    if (i > 0 && lines[i - 1].charAt(0) !== '1' && lines[i - 1].charAt(0) !== '2') {
                        name = lines[i - 1].trim();
                    }

                    var sat = parseTLE(name, lines[i], lines[i + 1]);
                    if (sat) satellites.push(sat);
                    i += 2;
                    continue;
                }
            }
            i++;
        }

        return satellites;
    }

    // -------------------------------------------------------------------
    // Single TLE Entry Parsing
    // -------------------------------------------------------------------

    /**
     * Parse a single TLE entry (name + line1 + line2).
     *
     * @param {string} name   satellite name (may be empty)
     * @param {string} line1  TLE line 1
     * @param {string} line2  TLE line 2
     * @returns {object|null} parsed satellite data, or null on error
     */
    function parseTLE(name, line1, line2) {
        try {
            // --- Line 1 ---
            var catalogNumber = parseInt(line1.substring(2, 7).trim(), 10);
            var classification = line1.charAt(7);
            var designator = line1.substring(9, 17).trim();
            var epochYear = parseInt(line1.substring(18, 20).trim(), 10);
            var epochDay = parseFloat(line1.substring(20, 32).trim());
            var meanMotionDot = parseFloat(line1.substring(33, 43).trim());
            var bstar = _parseExponent(line1.substring(53, 61).trim());

            // Convert 2-digit year (NORAD convention: 57-99 → 1957-1999, 00-56 → 2000-2056)
            epochYear = epochYear < 57 ? epochYear + 2000 : epochYear + 1900;

            // --- Line 2 ---
            var inclination = parseFloat(line2.substring(8, 16).trim());
            var raan = parseFloat(line2.substring(17, 25).trim());
            var eccentricity = parseFloat('0.' + line2.substring(26, 33).trim());
            var argPerigee = parseFloat(line2.substring(34, 42).trim());
            var meanAnomaly = parseFloat(line2.substring(43, 51).trim());
            var meanMotion = parseFloat(line2.substring(52, 63).trim());
            var revNumber = parseInt(line2.substring(63, 68).trim(), 10) || 0;

            // Validate critical fields
            if (isNaN(inclination) || isNaN(raan) || isNaN(eccentricity) ||
                isNaN(argPerigee) || isNaN(meanAnomaly) || isNaN(meanMotion) ||
                meanMotion <= 0) {
                return null;
            }

            // Derived quantities
            var n_rad = TWO_PI * meanMotion / 86400;                    // rad/s
            var sma = Math.pow(MU / (n_rad * n_rad), 1.0 / 3.0);     // meters
            var altitudeKm = (sma - R_EARTH) / 1000;                   // km
            var period = TWO_PI / n_rad;                                // seconds
            var rPeriapsis = sma * (1 - eccentricity);
            var rApoapsis = sma * (1 + eccentricity);
            var periapsisAltKm = (rPeriapsis - R_EARTH) / 1000;
            var apoapsisAltKm = (rApoapsis - R_EARTH) / 1000;

            return {
                name: name || 'SAT-' + catalogNumber,
                catalogNumber: catalogNumber,
                classification: classification,
                designator: designator,
                epochYear: epochYear,
                epochDay: epochDay,
                meanMotionDot: meanMotionDot,
                bstar: bstar,
                inclination: inclination,       // degrees
                raan: raan,                     // degrees
                eccentricity: eccentricity,
                argPerigee: argPerigee,         // degrees
                meanAnomaly: meanAnomaly,       // degrees
                meanMotion: meanMotion,         // revs/day
                revNumber: revNumber,
                // Derived
                sma: sma,                       // meters
                altitudeKm: altitudeKm,         // km (average)
                period: period,                 // seconds
                periapsisAltKm: periapsisAltKm,
                apoapsisAltKm: apoapsisAltKm,
                // Original lines (for serialization)
                tle_line1: line1,
                tle_line2: line2
            };
        } catch (e) {
            console.warn('[TLEParser] Parse error:', e.message);
            return null;
        }
    }

    // -------------------------------------------------------------------
    // TLE Exponential Notation Parser
    // -------------------------------------------------------------------

    /**
     * Parse TLE Fortran-style exponential notation.
     * Examples: " 12345-6" → 0.12345e-6, "+00000+0" → 0.0
     */
    function _parseExponent(str) {
        if (!str || str.length === 0) return 0;

        // Remove spaces
        str = str.replace(/\s+/g, '');
        if (str.length === 0) return 0;

        // Handle Fortran-style: digits followed by sign and exponent
        // e.g., "12345-6" → "0.12345e-6"
        var match = str.match(/^([+-]?)(\d+)([+-]\d+)$/);
        if (match) {
            var sign = match[1] === '-' ? -1 : 1;
            var mantissa = '0.' + match[2];
            var exp = parseInt(match[3], 10);
            return sign * parseFloat(mantissa) * Math.pow(10, exp);
        }

        // Standard float format
        var val = parseFloat(str);
        return isNaN(val) ? 0 : val;
    }

    // -------------------------------------------------------------------
    // Orbital Elements → ECI State Vector
    // -------------------------------------------------------------------

    /**
     * Convert TLE orbital elements to ECI state vector at epoch.
     *
     * @param {object} sat  parsed TLE satellite object
     * @returns {{ pos: number[], vel: number[] }} ECI position (m) and velocity (m/s)
     */
    function tleToECI(sat) {
        var a = sat.sma;
        var e = sat.eccentricity;
        var inc = sat.inclination * DEG;
        var raanRad = sat.raan * DEG;
        var w = sat.argPerigee * DEG;
        var M0 = sat.meanAnomaly * DEG;

        // Solve Kepler's equation: M = E - e*sin(E) (Newton-Raphson)
        var E = M0;
        for (var iter = 0; iter < 20; iter++) {
            var dE = (E - e * Math.sin(E) - M0) / (1 - e * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-12) break;
        }

        // True anomaly from eccentric anomaly
        var cosE = Math.cos(E);
        var sinE = Math.sin(E);
        var nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);

        // Radius
        var r = a * (1 - e * cosE);

        // Perifocal coordinates
        var xP = r * Math.cos(nu);
        var yP = r * Math.sin(nu);

        // Perifocal velocity
        var p = a * (1 - e * e);
        var coeff = Math.sqrt(MU / p);
        var vxP = -coeff * Math.sin(nu);
        var vyP = coeff * (e + Math.cos(nu));

        // Perifocal → ECI rotation matrix
        var cosW = Math.cos(w), sinW = Math.sin(w);
        var cosI = Math.cos(inc), sinI = Math.sin(inc);
        var cosO = Math.cos(raanRad), sinO = Math.sin(raanRad);

        // P and Q direction vectors
        var Px = cosO * cosW - sinO * sinW * cosI;
        var Py = sinO * cosW + cosO * sinW * cosI;
        var Pz = sinW * sinI;
        var Qx = -cosO * sinW - sinO * cosW * cosI;
        var Qy = -sinO * sinW + cosO * cosW * cosI;
        var Qz = cosW * sinI;

        return {
            pos: [Px * xP + Qx * yP, Py * xP + Qy * yP, Pz * xP + Qz * yP],
            vel: [Px * vxP + Qx * vyP, Py * vxP + Qy * vyP, Pz * vxP + Qz * vyP]
        };
    }

    // -------------------------------------------------------------------
    // ECI → Geodetic Conversion
    // -------------------------------------------------------------------

    /**
     * Convert ECI position to geodetic coordinates (spherical Earth).
     *
     * @param {number[]} posECI  [x, y, z] in ECI (meters)
     * @param {number} gmst     Greenwich Mean Sidereal Time (radians)
     * @returns {{ lat: number, lon: number, alt: number }}
     *          lat/lon in radians, alt in meters
     */
    function eciToGeodetic(posECI, gmst) {
        // ECI → ECEF: rotate by -GMST around Z
        var cosG = Math.cos(-gmst);
        var sinG = Math.sin(-gmst);
        var x = cosG * posECI[0] - sinG * posECI[1];
        var y = sinG * posECI[0] + cosG * posECI[1];
        var z = posECI[2];

        var r = Math.sqrt(x * x + y * y + z * z);
        var lon = Math.atan2(y, x);
        var lat = Math.asin(z / r);
        var alt = r - R_EARTH;

        return { lat: lat, lon: lon, alt: alt };
    }

    /**
     * Convert ECI position to Cesium Cartesian3 via ECEF.
     * Returns null if input contains NaN/Infinity.
     *
     * @param {number[]} posECI  [x, y, z] in ECI (meters)
     * @param {number} gmst     Greenwich Mean Sidereal Time (radians)
     * @returns {Cesium.Cartesian3|null}
     */
    function eciToCesiumCartesian(posECI, gmst) {
        if (!_isOK(posECI[0]) || !_isOK(posECI[1]) || !_isOK(posECI[2])) {
            return null;
        }

        var cosG = Math.cos(-gmst);
        var sinG = Math.sin(-gmst);
        var x = cosG * posECI[0] - sinG * posECI[1];
        var y = sinG * posECI[0] + cosG * posECI[1];
        var z = posECI[2];

        return new Cesium.Cartesian3(x, y, z);
    }

    // -------------------------------------------------------------------
    // Kepler Propagation
    // -------------------------------------------------------------------

    /**
     * Propagate an ECI state vector forward by dt seconds using analytical Kepler.
     *
     * @param {number[]} pos  ECI position [x,y,z] (m)
     * @param {number[]} vel  ECI velocity [vx,vy,vz] (m/s)
     * @param {number} dt     time step (seconds)
     * @returns {{ pos: number[], vel: number[] }} new ECI state
     */
    function propagateKepler(pos, vel, dt) {
        var rMag = _vecMag(pos);
        var vMag = _vecMag(vel);

        if (rMag < 1000 || vMag < 0.1) {
            return { pos: pos.slice(), vel: vel.slice() };
        }

        // Orbital elements
        var h = _vecCross(pos, vel);
        var hMag = _vecMag(h);
        if (hMag < 1e3) {
            // Degenerate: linear propagation
            return {
                pos: [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt],
                vel: vel.slice()
            };
        }

        var energy = 0.5 * vMag * vMag - MU / rMag;
        var sma = -MU / (2 * energy);

        if (!_isOK(sma) || sma <= 0) {
            // Hyperbolic/parabolic: linear propagation
            return {
                pos: [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt],
                vel: vel.slice()
            };
        }

        var rdotv = _vecDot(pos, vel);
        var coeff1 = vMag * vMag - MU / rMag;
        var e_vec = [
            (coeff1 * pos[0] - rdotv * vel[0]) / MU,
            (coeff1 * pos[1] - rdotv * vel[1]) / MU,
            (coeff1 * pos[2] - rdotv * vel[2]) / MU
        ];
        var ecc = _vecMag(e_vec);

        if (ecc >= 1.0) {
            return {
                pos: [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt],
                vel: vel.slice()
            };
        }

        // Node vector
        var n_vec = [-h[1], h[0], 0];
        var nMag = _vecMag(n_vec);

        // Inclination
        var inc = Math.acos(_clamp(h[2] / hMag, -1, 1));

        // RAAN
        var raan = 0;
        if (nMag > 1e-6) {
            raan = Math.acos(_clamp(n_vec[0] / nMag, -1, 1));
            if (n_vec[1] < 0) raan = TWO_PI - raan;
        }

        // Argument of periapsis
        var w = 0;
        if (nMag > 1e-6 && ecc > 1e-6) {
            w = Math.acos(_clamp(_vecDot(n_vec, e_vec) / (nMag * ecc), -1, 1));
            if (e_vec[2] < 0) w = TWO_PI - w;
        }

        // True anomaly
        var trueAnomaly = 0;
        if (ecc > 1e-6) {
            trueAnomaly = Math.acos(_clamp(_vecDot(e_vec, pos) / (ecc * rMag), -1, 1));
            if (rdotv < 0) trueAnomaly = TWO_PI - trueAnomaly;
        }

        // Current eccentric anomaly → mean anomaly
        var cosTA = Math.cos(trueAnomaly);
        var sinTA = Math.sin(trueAnomaly);
        var E0 = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinTA, ecc + cosTA);
        var M0 = E0 - ecc * Math.sin(E0);
        if (M0 < 0) M0 += TWO_PI;

        // Mean motion
        var n_mean = Math.sqrt(MU / (sma * sma * sma));

        // New mean anomaly
        var M = (M0 + n_mean * dt) % TWO_PI;
        if (M < 0) M += TWO_PI;

        // Solve Kepler's equation
        var E = M;
        for (var iter = 0; iter < 20; iter++) {
            var dE = (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-12) break;
        }

        var cosE = Math.cos(E);
        var sinE = Math.sin(E);
        var nu = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinE, cosE - ecc);
        var r_new = sma * (1 - ecc * cosE);

        // Perifocal coordinates
        var xP = r_new * Math.cos(nu);
        var yP = r_new * Math.sin(nu);

        // Perifocal velocity
        var p = sma * (1 - ecc * ecc);
        var vCoeff = Math.sqrt(MU / p);
        var vxP = -vCoeff * Math.sin(nu);
        var vyP = vCoeff * (ecc + Math.cos(nu));

        // Perifocal → ECI rotation
        var cosW = Math.cos(w), sinW = Math.sin(w);
        var cosI = Math.cos(inc), sinI = Math.sin(inc);
        var cosO = Math.cos(raan), sinO = Math.sin(raan);

        var Px = cosO * cosW - sinO * sinW * cosI;
        var Py = sinO * cosW + cosO * sinW * cosI;
        var Pz = sinW * sinI;
        var Qx = -cosO * sinW - sinO * cosW * cosI;
        var Qy = -sinO * sinW + cosO * cosW * cosI;
        var Qz = cosW * sinI;

        return {
            pos: [Px * xP + Qx * yP, Py * xP + Qy * yP, Pz * xP + Qz * yP],
            vel: [Px * vxP + Qx * vyP, Py * vxP + Qy * vyP, Pz * vxP + Qz * vyP]
        };
    }

    // -------------------------------------------------------------------
    // Orbit Path Prediction
    // -------------------------------------------------------------------

    /**
     * Predict a full orbit path as an array of Cesium Cartesian3 positions.
     *
     * @param {number[]} pos      current ECI position (m)
     * @param {number[]} vel      current ECI velocity (m/s)
     * @param {number} numPoints  number of points around the orbit
     * @param {number} simTime    current sim time in seconds (for GMST)
     * @returns {Cesium.Cartesian3[]} orbit path positions in ECEF
     */
    function predictOrbitPath(pos, vel, numPoints, simTime) {
        var rMag = _vecMag(pos);
        var vMag = _vecMag(vel);
        if (rMag < 1000 || vMag < 0.1) return [];

        var energy = 0.5 * vMag * vMag - MU / rMag;
        var sma = -MU / (2 * energy);
        if (!_isOK(sma) || sma <= 0) return [];

        var h = _vecCross(pos, vel);
        var hMag = _vecMag(h);
        if (hMag < 1e3) return [];

        var rdotv = _vecDot(pos, vel);
        var coeff1 = vMag * vMag - MU / rMag;
        var e_vec = [
            (coeff1 * pos[0] - rdotv * vel[0]) / MU,
            (coeff1 * pos[1] - rdotv * vel[1]) / MU,
            (coeff1 * pos[2] - rdotv * vel[2]) / MU
        ];
        var ecc = _vecMag(e_vec);
        if (ecc >= 1.0) return [];

        // Orbital elements
        var inc = Math.acos(_clamp(h[2] / hMag, -1, 1));
        var n_vec = [-h[1], h[0], 0];
        var nMag = _vecMag(n_vec);

        var raan = 0;
        if (nMag > 1e-6) {
            raan = Math.acos(_clamp(n_vec[0] / nMag, -1, 1));
            if (n_vec[1] < 0) raan = TWO_PI - raan;
        }

        var w = 0;
        if (nMag > 1e-6 && ecc > 1e-6) {
            w = Math.acos(_clamp(_vecDot(n_vec, e_vec) / (nMag * ecc), -1, 1));
            if (e_vec[2] < 0) w = TWO_PI - w;
        }

        var trueAnomaly = 0;
        if (ecc > 1e-6) {
            trueAnomaly = Math.acos(_clamp(_vecDot(e_vec, pos) / (ecc * rMag), -1, 1));
            if (rdotv < 0) trueAnomaly = TWO_PI - trueAnomaly;
        }

        // Perifocal → ECI rotation
        var cosW = Math.cos(w), sinW = Math.sin(w);
        var cosI = Math.cos(inc), sinI = Math.sin(inc);
        var cosO = Math.cos(raan), sinO = Math.sin(raan);

        var Px = cosO * cosW - sinO * sinW * cosI;
        var Py = sinO * cosW + cosO * sinW * cosI;
        var Pz = sinW * sinI;
        var Qx = -cosO * sinW - sinO * cosW * cosI;
        var Qy = -sinO * sinW + cosO * cosW * cosI;
        var Qz = cosW * sinI;

        // Current mean anomaly
        var cosTA = Math.cos(trueAnomaly);
        var sinTA = Math.sin(trueAnomaly);
        var E0 = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinTA, ecc + cosTA);
        var M0 = E0 - ecc * Math.sin(E0);
        if (M0 < 0) M0 += TWO_PI;

        var n_mean = Math.sqrt(MU / (sma * sma * sma));
        var period = TWO_PI / n_mean;
        var gmst = OMEGA_EARTH * simTime;

        var positions = [];
        for (var i = 0; i <= numPoints; i++) {
            var frac = i / numPoints;
            var t = frac * period;

            var M = (M0 + n_mean * t) % TWO_PI;
            if (M < 0) M += TWO_PI;

            // Solve Kepler
            var E = M;
            for (var iter = 0; iter < 15; iter++) {
                var dE = (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
                E -= dE;
                if (Math.abs(dE) < 1e-10) break;
            }

            var cE = Math.cos(E);
            var sE = Math.sin(E);
            var nu = Math.atan2(Math.sqrt(1 - ecc * ecc) * sE, cE - ecc);
            var r_mag = sma * (1 - ecc * cE);

            var xP = r_mag * Math.cos(nu);
            var yP = r_mag * Math.sin(nu);

            var x_eci = Px * xP + Qx * yP;
            var y_eci = Py * xP + Qy * yP;
            var z_eci = Pz * xP + Qz * yP;

            // Account for Earth rotation during orbit
            var gmstAtT = gmst + OMEGA_EARTH * t;
            var pt = eciToCesiumCartesian([x_eci, y_eci, z_eci], gmstAtT);
            if (pt) positions.push(pt);
        }

        return positions;
    }

    /**
     * Compute apoapsis and periapsis Cesium positions.
     *
     * @param {number[]} pos       current ECI position
     * @param {number[]} vel       current ECI velocity
     * @param {number} simTime     current sim time (seconds)
     * @returns {{ ap: Cesium.Cartesian3|null, pe: Cesium.Cartesian3|null,
     *             apoapsisAlt: number|null, periapsisAlt: number|null }}
     */
    function computeApPePositions(pos, vel, simTime) {
        var rMag = _vecMag(pos);
        var vMag = _vecMag(vel);
        if (rMag < 1000 || vMag < 0.1) return { ap: null, pe: null, apoapsisAlt: null, periapsisAlt: null };

        var energy = 0.5 * vMag * vMag - MU / rMag;
        var sma = -MU / (2 * energy);
        if (!_isOK(sma) || sma <= 0) return { ap: null, pe: null, apoapsisAlt: null, periapsisAlt: null };

        var h = _vecCross(pos, vel);
        var hMag = _vecMag(h);
        if (hMag < 1e3) return { ap: null, pe: null, apoapsisAlt: null, periapsisAlt: null };

        var rdotv = _vecDot(pos, vel);
        var coeff1 = vMag * vMag - MU / rMag;
        var e_vec = [
            (coeff1 * pos[0] - rdotv * vel[0]) / MU,
            (coeff1 * pos[1] - rdotv * vel[1]) / MU,
            (coeff1 * pos[2] - rdotv * vel[2]) / MU
        ];
        var ecc = _vecMag(e_vec);
        if (ecc >= 1.0) return { ap: null, pe: null, apoapsisAlt: null, periapsisAlt: null };

        var inc = Math.acos(_clamp(h[2] / hMag, -1, 1));
        var n_vec = [-h[1], h[0], 0];
        var nMag = _vecMag(n_vec);

        var raan = 0;
        if (nMag > 1e-6) {
            raan = Math.acos(_clamp(n_vec[0] / nMag, -1, 1));
            if (n_vec[1] < 0) raan = TWO_PI - raan;
        }

        var w = 0;
        if (nMag > 1e-6 && ecc > 1e-6) {
            w = Math.acos(_clamp(_vecDot(n_vec, e_vec) / (nMag * ecc), -1, 1));
            if (e_vec[2] < 0) w = TWO_PI - w;
        }

        var trueAnomaly = 0;
        if (ecc > 1e-6) {
            trueAnomaly = Math.acos(_clamp(_vecDot(e_vec, pos) / (ecc * rMag), -1, 1));
            if (rdotv < 0) trueAnomaly = TWO_PI - trueAnomaly;
        }

        // Rotation matrix
        var cosW = Math.cos(w), sinW = Math.sin(w);
        var cosI = Math.cos(inc), sinI = Math.sin(inc);
        var cosO = Math.cos(raan), sinO = Math.sin(raan);

        var Px = cosO * cosW - sinO * sinW * cosI;
        var Py = sinO * cosW + cosO * sinW * cosI;
        var Pz = sinW * sinI;

        // Periapsis (nu=0)
        var rPe = sma * (1 - ecc);
        var peECI = [Px * rPe, Py * rPe, Pz * rPe];

        // Apoapsis (nu=pi)
        var rAp = sma * (1 + ecc);
        var apECI = [-Px * rAp, -Py * rAp, -Pz * rAp];

        // Time to AP/PE for Earth rotation correction
        var n_mean = Math.sqrt(MU / (sma * sma * sma));
        var cosTA = Math.cos(trueAnomaly);
        var sinTA = Math.sin(trueAnomaly);
        var E0 = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinTA, ecc + cosTA);
        var M0 = E0 - ecc * Math.sin(E0);
        if (M0 < 0) M0 += TWO_PI;

        var period = TWO_PI / n_mean;
        var tPe = (TWO_PI - M0) / n_mean;
        if (tPe > period) tPe -= period;
        var tAp = (Math.PI - M0) / n_mean;
        if (tAp < 0) tAp += period;

        var gmst = OMEGA_EARTH * simTime;

        return {
            ap: eciToCesiumCartesian(apECI, gmst + OMEGA_EARTH * tAp),
            pe: eciToCesiumCartesian(peECI, gmst + OMEGA_EARTH * tPe),
            apoapsisAlt: sma * (1 + ecc) - R_EARTH,
            periapsisAlt: sma * (1 - ecc) - R_EARTH
        };
    }

    // -------------------------------------------------------------------
    // Utility functions
    // -------------------------------------------------------------------

    function _isOK(v) {
        return typeof v === 'number' && isFinite(v);
    }

    function _clamp(v, min, max) {
        return v < min ? min : (v > max ? max : v);
    }

    function _vecMag(v) {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    }

    function _vecDot(a, b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    function _vecCross(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        parse: parse,
        parseTLE: parseTLE,
        tleToECI: tleToECI,
        eciToGeodetic: eciToGeodetic,
        eciToCesiumCartesian: eciToCesiumCartesian,
        propagateKepler: propagateKepler,
        predictOrbitPath: predictOrbitPath,
        computeApPePositions: computeApPePositions,
        // Constants
        MU: MU,
        R_EARTH: R_EARTH,
        OMEGA_EARTH: OMEGA_EARTH
    };
})();
