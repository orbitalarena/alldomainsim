/**
 * SolarSystemEngine - JS port of Meeus planet positions for real-time browser rendering
 *
 * Computes heliocentric positions for all 8 planets using Standish (1992) mean orbital
 * elements. Positions are in J2000 equatorial coordinates (meters). Includes Kepler
 * equation solver, Julian date utilities, and orbit path generation.
 *
 * Usage:
 *   var pos = SolarSystemEngine.getPlanetPositionHCI('EARTH', jd);
 *   var vel = SolarSystemEngine.getPlanetVelocityHCI('MARS', jd);
 *   var path = SolarSystemEngine.getOrbitPath('VENUS', jd, 360);
 *   var jd = SolarSystemEngine.calendarToJD(2026, 7, 15);
 */
var SolarSystemEngine = (function() {
    'use strict';

    // ─── Planet Physical Data ──────────────────────────────────────────
    var PLANETS = {
        MERCURY: { name: 'Mercury', mu: 2.2032e13,  radius: 2439700,  color: '#B5B5B5', sma_au: 0.387 },
        VENUS:   { name: 'Venus',   mu: 3.24859e14, radius: 6051800,  color: '#E8CDA0', sma_au: 0.723 },
        EARTH:   { name: 'Earth',   mu: 3.986e14,   radius: 6371000,  color: '#4B7BE5', sma_au: 1.000 },
        MARS:    { name: 'Mars',    mu: 4.282837e13, radius: 3396200,  color: '#C1440E', sma_au: 1.524 },
        JUPITER: { name: 'Jupiter', mu: 1.267e17,   radius: 71492000, color: '#C88B3A', sma_au: 5.203 },
        SATURN:  { name: 'Saturn',  mu: 3.794e16,   radius: 60268000, color: '#EAD6A6', sma_au: 9.537 },
        URANUS:  { name: 'Uranus',  mu: 5.794e15,   radius: 25559000, color: '#ACE5EE', sma_au: 19.19 },
        NEPTUNE: { name: 'Neptune', mu: 6.836e15,   radius: 24764000, color: '#5B5EA6', sma_au: 30.07 }
    };

    // ─── Constants ─────────────────────────────────────────────────────
    var AU = 149597870700;            // meters per astronomical unit
    var MU_SUN = 1.32712440018e20;    // m^3/s^2 solar gravitational parameter
    var J2000_EPOCH = 2451545.0;      // Julian date of J2000.0
    var DEG_TO_RAD = Math.PI / 180;
    var RAD_TO_DEG = 180 / Math.PI;
    var TWO_PI = 2 * Math.PI;
    var OBLIQUITY_J2000 = 23.43928 * DEG_TO_RAD;  // Mean obliquity of ecliptic at J2000

    // ─── Standish (1992) Mean Orbital Elements ─────────────────────────
    // [a0(AU), da/century, e0, de, i0(deg), di, L0(deg), dL,
    //  long_peri0(deg), dlp, long_node0(deg), dln]
    // All angular rates per Julian century from J2000.0
    var ELEMENTS = {
        MERCURY: {
            a0: 0.38709927,  da: 0.00000037,
            e0: 0.20563593,  de: 0.00001906,
            i0: 7.00497902,  di: -0.00594749,
            L0: 252.25032350, dL: 149472.67411175,
            lp0: 77.45779628,  dlp: 0.16047689,
            ln0: 48.33076593,  dln: -0.12534081
        },
        VENUS: {
            a0: 0.72333566,  da: 0.00000390,
            e0: 0.00677672,  de: -0.00004107,
            i0: 3.39467605,  di: -0.00078890,
            L0: 181.97909950, dL: 58517.81538729,
            lp0: 131.60246718, dlp: 0.00268329,
            ln0: 76.67984255,  dln: -0.27769418
        },
        EARTH: {
            a0: 1.00000261,  da: 0.00000562,
            e0: 0.01671123,  de: -0.00004392,
            i0: -0.00001531, di: -0.01294668,
            L0: 100.46457166, dL: 35999.37244981,
            lp0: 102.93768193, dlp: 0.32327364,
            ln0: 0.0,          dln: 0.0
        },
        MARS: {
            a0: 1.52371034,  da: 0.00001847,
            e0: 0.09339410,  de: 0.00007882,
            i0: 1.84969142,  di: -0.00813131,
            L0: -4.55343205, dL: 19140.30268499,
            lp0: -23.94362959, dlp: 0.44441088,
            ln0: 49.55953891,   dln: -0.29257343
        },
        JUPITER: {
            a0: 5.20288700,  da: -0.00011607,
            e0: 0.04838624,  de: -0.00013253,
            i0: 1.30439695,  di: -0.00183714,
            L0: 34.39644051, dL: 3034.74612775,
            lp0: 14.72847983, dlp: 0.21252668,
            ln0: 100.47390909, dln: 0.20469106
        },
        SATURN: {
            a0: 9.53667594,  da: -0.00125060,
            e0: 0.05386179,  de: -0.00050991,
            i0: 2.48599187,  di: 0.00193609,
            L0: 49.95424423, dL: 1222.49362201,
            lp0: 92.59887831, dlp: -0.41897216,
            ln0: 113.66242448, dln: -0.28867794
        },
        URANUS: {
            a0: 19.18916464, da: -0.00196176,
            e0: 0.04725744,  de: -0.00004397,
            i0: 0.77263783,  di: -0.00242939,
            L0: 313.23810451, dL: 428.48202785,
            lp0: 170.95427630, dlp: 0.40805281,
            ln0: 74.01692503,   dln: 0.04240589
        },
        NEPTUNE: {
            a0: 30.06992276, da: 0.00026291,
            e0: 0.00859048,  de: 0.00005105,
            i0: 1.77004347,  di: 0.00035372,
            L0: -55.12002969, dL: 218.45945325,
            lp0: 44.96476227,  dlp: -0.32241464,
            ln0: 131.78422574, dln: -0.00508664
        }
    };

    // ─── Planet display order for iteration ────────────────────────────
    var PLANET_KEYS = ['MERCURY', 'VENUS', 'EARTH', 'MARS', 'JUPITER', 'SATURN', 'URANUS', 'NEPTUNE'];

    // ─── Kepler Equation Solver ────────────────────────────────────────
    // Newton-Raphson iteration: E - e*sin(E) = M
    function solveKepler(M, e, tol) {
        tol = tol || 1e-12;
        var E = M;  // Initial guess
        for (var i = 0; i < 50; i++) {
            var dE = (M - E + e * Math.sin(E)) / (1.0 - e * Math.cos(E));
            E += dE;
            if (Math.abs(dE) < tol) break;
        }
        return E;
    }

    // ─── Normalize angle to [-PI, PI] ──────────────────────────────────
    function normalizeAngle(angle) {
        angle = angle % TWO_PI;
        if (angle > Math.PI) angle -= TWO_PI;
        if (angle < -Math.PI) angle += TWO_PI;
        return angle;
    }

    // ─── Planet Heliocentric Position (J2000 Equatorial, meters) ──────
    // Returns {x, y, z} in meters, heliocentric J2000 equatorial frame
    function getPlanetPositionHCI(planetKey, jd) {
        var elem = ELEMENTS[planetKey];
        if (!elem) return { x: 0, y: 0, z: 0 };

        // Centuries from J2000.0
        var T = (jd - J2000_EPOCH) / 36525.0;

        // Compute osculating elements at epoch
        var a  = (elem.a0 + elem.da * T) * AU;   // semi-major axis (meters)
        var e  = elem.e0 + elem.de * T;           // eccentricity
        var I  = (elem.i0 + elem.di * T) * DEG_TO_RAD;   // inclination (rad)
        var L  = (elem.L0 + elem.dL * T) * DEG_TO_RAD;   // mean longitude (rad)
        var lp = (elem.lp0 + elem.dlp * T) * DEG_TO_RAD; // longitude of perihelion (rad)
        var ln = (elem.ln0 + elem.dln * T) * DEG_TO_RAD;  // longitude of ascending node (rad)

        // Derived angles
        var omega = lp - ln;   // argument of perihelion
        var M = normalizeAngle(L - lp);  // mean anomaly, normalized

        // Solve Kepler's equation for eccentric anomaly
        var E = solveKepler(M, e);

        // True anomaly from eccentric anomaly
        var nu = 2 * Math.atan2(
            Math.sqrt(1 + e) * Math.sin(E / 2),
            Math.sqrt(1 - e) * Math.cos(E / 2)
        );

        // Heliocentric distance
        var r = a * (1 - e * Math.cos(E));

        // Position in the orbital plane (perifocal frame)
        var x_orb = r * Math.cos(nu);
        var y_orb = r * Math.sin(nu);

        // Rotation to ecliptic coordinates
        var cos_o = Math.cos(omega), sin_o = Math.sin(omega);
        var cos_I = Math.cos(I),     sin_I = Math.sin(I);
        var cos_n = Math.cos(ln),    sin_n = Math.sin(ln);

        var x_ecl = (cos_n * cos_o - sin_n * sin_o * cos_I) * x_orb +
                    (-cos_n * sin_o - sin_n * cos_o * cos_I) * y_orb;
        var y_ecl = (sin_n * cos_o + cos_n * sin_o * cos_I) * x_orb +
                    (-sin_n * sin_o + cos_n * cos_o * cos_I) * y_orb;
        var z_ecl = (sin_o * sin_I) * x_orb + (cos_o * sin_I) * y_orb;

        // Rotate from ecliptic to J2000 equatorial (obliquity rotation about X)
        var cos_eps = Math.cos(OBLIQUITY_J2000);
        var sin_eps = Math.sin(OBLIQUITY_J2000);

        return {
            x: x_ecl,
            y: y_ecl * cos_eps - z_ecl * sin_eps,
            z: y_ecl * sin_eps + z_ecl * cos_eps
        };
    }

    // ─── Planet Heliocentric Velocity (J2000 Equatorial, m/s) ─────────
    // Central difference with 10-second step for numerical velocity
    function getPlanetVelocityHCI(planetKey, jd) {
        var dt = 10.0 / 86400.0;  // 10 seconds in Julian days
        var p1 = getPlanetPositionHCI(planetKey, jd - dt);
        var p2 = getPlanetPositionHCI(planetKey, jd + dt);
        var inv2dt = 1.0 / (2 * dt * 86400.0);  // Convert back to seconds
        return {
            x: (p2.x - p1.x) * inv2dt,
            y: (p2.y - p1.y) * inv2dt,
            z: (p2.z - p1.z) * inv2dt
        };
    }

    // ─── Full Orbit Path (array of {x,y,z} positions) ─────────────────
    // Generates numPoints positions over one orbital period
    function getOrbitPath(planetKey, jd, numPoints) {
        numPoints = numPoints || 360;
        var elem = ELEMENTS[planetKey];
        if (!elem) return [];

        // Compute orbital period from current semi-major axis
        var T = (jd - J2000_EPOCH) / 36525.0;
        var a_au = elem.a0 + elem.da * T;
        var period_days = 365.25 * Math.pow(a_au, 1.5);  // Kepler's third law (P^2 = a^3)

        var points = [];
        for (var i = 0; i <= numPoints; i++) {
            var t = jd + (i / numPoints) * period_days;
            var pos = getPlanetPositionHCI(planetKey, t);
            // Guard against NaN
            if (isFinite(pos.x) && isFinite(pos.y) && isFinite(pos.z)) {
                points.push(pos);
            }
        }
        return points;
    }

    // ─── Inner Planet Orbit Paths Only ─────────────────────────────────
    // Returns paths for Mercury through Mars (faster for inner solar system views)
    function getInnerOrbitPaths(jd, numPoints) {
        numPoints = numPoints || 360;
        var paths = {};
        var innerPlanets = ['MERCURY', 'VENUS', 'EARTH', 'MARS'];
        for (var i = 0; i < innerPlanets.length; i++) {
            paths[innerPlanets[i]] = getOrbitPath(innerPlanets[i], jd, numPoints);
        }
        return paths;
    }

    // ─── All Planet Positions at a Given Epoch ─────────────────────────
    function getAllPositions(jd) {
        var positions = {};
        for (var i = 0; i < PLANET_KEYS.length; i++) {
            positions[PLANET_KEYS[i]] = getPlanetPositionHCI(PLANET_KEYS[i], jd);
        }
        return positions;
    }

    // ─── Transfer Orbit Geometry ───────────────────────────────────────
    // Compute a simple conic transfer arc between two position vectors
    // Uses the vis-viva equation; returns velocity vectors at departure and arrival
    function lambertSimple(r1, r2, tof_seconds, mu) {
        mu = mu || MU_SUN;

        var r1_mag = Math.sqrt(r1.x * r1.x + r1.y * r1.y + r1.z * r1.z);
        var r2_mag = Math.sqrt(r2.x * r2.x + r2.y * r2.y + r2.z * r2.z);

        // Angle between position vectors
        var cos_dnu = (r1.x * r2.x + r1.y * r2.y + r1.z * r2.z) / (r1_mag * r2_mag);
        cos_dnu = Math.max(-1, Math.min(1, cos_dnu));
        var dnu = Math.acos(cos_dnu);

        // Cross product to determine transfer direction
        var cross_z = r1.x * r2.y - r1.y * r2.x;
        if (cross_z < 0) dnu = TWO_PI - dnu;

        // Approximate semi-major axis using chord geometry
        var k = r1_mag * r2_mag * (1 - cos_dnu);
        var l = r1_mag + r2_mag;
        var m = r1_mag * r2_mag * (1 + cos_dnu);

        // Iterative solution (simplified for visualization purposes)
        var a = (l / 2 + Math.sqrt(k)) / 2;  // Initial estimate

        // Vis-viva for departure velocity magnitude
        var v1_mag = Math.sqrt(mu * (2 / r1_mag - 1 / a));

        return {
            sma: a,
            v1_mag: v1_mag,
            delta_nu: dnu * RAD_TO_DEG
        };
    }

    // ─── Departure C3 (specific energy) ────────────────────────────────
    // C3 = V_inf^2 where V_inf = |V_transfer - V_planet| at departure
    function computeC3(planetKey, jd_departure, v_transfer) {
        var v_planet = getPlanetVelocityHCI(planetKey, jd_departure);
        var dvx = v_transfer.x - v_planet.x;
        var dvy = v_transfer.y - v_planet.y;
        var dvz = v_transfer.z - v_planet.z;
        return (dvx * dvx + dvy * dvy + dvz * dvz) / 1e6;  // km^2/s^2
    }

    // ─── Julian Date Conversions ───────────────────────────────────────

    // Calendar date to Julian Date (Meeus algorithm)
    function calendarToJD(year, month, day) {
        if (month <= 2) {
            year--;
            month += 12;
        }
        var A = Math.floor(year / 100);
        var B = 2 - A + Math.floor(A / 4);
        return Math.floor(365.25 * (year + 4716)) +
               Math.floor(30.6001 * (month + 1)) + day + B - 1524.5;
    }

    // Julian Date to calendar date
    function jdToCalendar(jd) {
        var Z = Math.floor(jd + 0.5);
        var F = jd + 0.5 - Z;
        var A;
        if (Z < 2299161) {
            A = Z;
        } else {
            var alpha = Math.floor((Z - 1867216.25) / 36524.25);
            A = Z + 1 + alpha - Math.floor(alpha / 4);
        }
        var B = A + 1524;
        var C = Math.floor((B - 122.1) / 365.25);
        var D = Math.floor(365.25 * C);
        var E = Math.floor((B - D) / 30.6001);
        var day = B - D - Math.floor(30.6001 * E) + F;
        var month = (E < 14) ? E - 1 : E - 13;
        var year = (month > 2) ? C - 4716 : C - 4715;
        return { year: year, month: month, day: day };
    }

    // Julian Date to ISO date string "YYYY-MM-DD"
    function jdToDateString(jd) {
        var d = jdToCalendar(jd);
        var dd = Math.floor(d.day);
        var mm = d.month;
        return d.year + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
    }

    // JavaScript Date object to Julian Date
    function dateToJD(date) {
        return calendarToJD(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            date.getUTCDate() + date.getUTCHours() / 24 +
                date.getUTCMinutes() / 1440 + date.getUTCSeconds() / 86400
        );
    }

    // Julian Date to JavaScript Date object
    function jdToDate(jd) {
        var cal = jdToCalendar(jd);
        var day_frac = cal.day - Math.floor(cal.day);
        var hours = day_frac * 24;
        var mins = (hours - Math.floor(hours)) * 60;
        var secs = (mins - Math.floor(mins)) * 60;
        return new Date(Date.UTC(
            cal.year, cal.month - 1, Math.floor(cal.day),
            Math.floor(hours), Math.floor(mins), Math.floor(secs)
        ));
    }

    // ─── Vector Utilities ──────────────────────────────────────────────
    function vecMag(v) {
        return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }

    function vecSub(a, b) {
        return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    }

    function vecAdd(a, b) {
        return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
    }

    function vecScale(v, s) {
        return { x: v.x * s, y: v.y * s, z: v.z * s };
    }

    function vecDot(a, b) {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    function vecCross(a, b) {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        };
    }

    // ─── Public API ────────────────────────────────────────────────────
    return {
        // Data
        PLANETS: PLANETS,
        ELEMENTS: ELEMENTS,
        PLANET_KEYS: PLANET_KEYS,

        // Constants
        AU: AU,
        MU_SUN: MU_SUN,
        J2000_EPOCH: J2000_EPOCH,
        DEG_TO_RAD: DEG_TO_RAD,
        RAD_TO_DEG: RAD_TO_DEG,
        OBLIQUITY_J2000: OBLIQUITY_J2000,

        // Position/velocity
        getPlanetPositionHCI: getPlanetPositionHCI,
        getPlanetVelocityHCI: getPlanetVelocityHCI,
        getOrbitPath: getOrbitPath,
        getInnerOrbitPaths: getInnerOrbitPaths,
        getAllPositions: getAllPositions,

        // Transfer
        lambertSimple: lambertSimple,
        computeC3: computeC3,

        // Time
        calendarToJD: calendarToJD,
        jdToCalendar: jdToCalendar,
        jdToDateString: jdToDateString,
        dateToJD: dateToJD,
        jdToDate: jdToDate,

        // Math
        solveKepler: solveKepler,
        normalizeAngle: normalizeAngle,
        vecMag: vecMag,
        vecSub: vecSub,
        vecAdd: vecAdd,
        vecScale: vecScale,
        vecDot: vecDot,
        vecCross: vecCross
    };
})();
