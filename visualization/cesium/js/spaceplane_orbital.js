/**
 * Spaceplane Orbital Mechanics Module
 * Provides geodetic→ECI conversion, orbital element computation,
 * Kepler orbit prediction, and flight regime detection.
 */
const SpaceplaneOrbital = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const MU = 3.986004418e14;      // m³/s² Earth gravitational parameter
    const R_EARTH = 6371000;         // m mean radius
    const R_EQ = 6378137;            // m WGS84 equatorial radius
    const OMEGA_EARTH = 7.2921159e-5; // rad/s Earth rotation rate
    const KARMAN = 80000;            // m (use 80km as practical Karman line)

    // Shared state for Cesium visualization
    let currentOrbitPositions = [];
    let eciOrbitPositions = [];
    let apoapsisPosition = null;
    let periapsisPosition = null;
    let ascNodePosition = null;
    let descNodePosition = null;
    let orbitalElements = null;
    let flightRegime = 'ATMOSPHERIC';
    let _numRevs = 1;

    // Update throttle (avoid recomputing every frame)
    let updateCounter = 0;
    const UPDATE_INTERVAL = 15; // update orbit every N frames (reduced to avoid perf issues)

    /**
     * Convert geodetic (lat, lon, alt) + velocity (speed, heading, gamma)
     * to Earth-Centered Inertial (ECI) state vector
     *
     * @param {object} state - aircraft state with lat, lon (radians), alt (m),
     *                         speed, heading, gamma (radians)
     * @param {number} simTime - simulation time in seconds (for GMST)
     * @returns {object} { pos: [x,y,z], vel: [vx,vy,vz] } in ECI frame (m, m/s)
     */
    function geodeticToECI(state, simTime) {
        const lat = state.lat;
        const lon = state.lon;
        const alt = state.alt;
        const V = state.speed;
        const hdg = state.heading;
        const gamma = state.gamma;

        // GMST: Greenwich Mean Sidereal Time angle
        const gmst = OMEGA_EARTH * simTime;

        // 1. Geodetic → ECEF position (spherical approximation)
        const R = R_EARTH + alt;
        const cosLat = Math.cos(lat);
        const sinLat = Math.sin(lat);
        const cosLon = Math.cos(lon);
        const sinLon = Math.sin(lon);

        const x_ecef = R * cosLat * cosLon;
        const y_ecef = R * cosLat * sinLon;
        const z_ecef = R * sinLat;

        // 2. Velocity in ENU frame
        const cosGamma = Math.cos(gamma);
        const sinGamma = Math.sin(gamma);
        const cosHdg = Math.cos(hdg);
        const sinHdg = Math.sin(hdg);

        // ENU: East, North, Up
        const vE = V * cosGamma * sinHdg;
        const vN = V * cosGamma * cosHdg;
        const vU = V * sinGamma;

        // 3. ENU → ECEF velocity rotation
        // East unit vector in ECEF:  (-sinLon, cosLon, 0)
        // North unit vector in ECEF: (-sinLat*cosLon, -sinLat*sinLon, cosLat)
        // Up unit vector in ECEF:    (cosLat*cosLon, cosLat*sinLon, sinLat)
        const vx_ecef = -sinLon * vE + (-sinLat * cosLon) * vN + cosLat * cosLon * vU;
        const vy_ecef =  cosLon * vE + (-sinLat * sinLon) * vN + cosLat * sinLon * vU;
        const vz_ecef =                  cosLat * vN            + sinLat * vU;

        // 4. Earth rotation velocity correction
        // The physics engine (fighter_sim_engine.js) uses non-rotating Earth equations:
        //   centrifugal = V²/R  →  circular orbit when V = sqrt(μ/R)
        // So state.speed is already the INERTIAL speed. Adding ω×r would double-count
        // Earth rotation, inflating ECI velocity by ~494 m/s at the equator and causing
        // SMA to oscillate wildly (±1000km) as latitude changes during orbit.
        // Do NOT add ω×r — the velocity is already inertial in this physics model.
        const vx_ecef_inertial = vx_ecef;
        const vy_ecef_inertial = vy_ecef;
        const vz_ecef_inertial = vz_ecef;

        // 5. ECEF → ECI rotation by GMST (rotate about Z by gmst)
        const cosG = Math.cos(gmst);
        const sinG = Math.sin(gmst);

        const x_eci = cosG * x_ecef - sinG * y_ecef;
        const y_eci = sinG * x_ecef + cosG * y_ecef;
        const z_eci = z_ecef;

        const vx_eci = cosG * vx_ecef_inertial - sinG * vy_ecef_inertial;
        const vy_eci = sinG * vx_ecef_inertial + cosG * vy_ecef_inertial;
        const vz_eci = vz_ecef_inertial;

        return {
            pos: [x_eci, y_eci, z_eci],
            vel: [vx_eci, vy_eci, vz_eci]
        };
    }

    /**
     * Check if a value is finite and not NaN
     */
    function isOK(v) {
        return typeof v === 'number' && isFinite(v);
    }

    /**
     * Convert ECI position to Cesium Cartesian3 via ECEF
     * @param {number[]} posECI - [x, y, z] in ECI
     * @param {number} gmst - GMST angle in radians
     * @returns {Cesium.Cartesian3|null} null if input contains NaN/Infinity
     */
    function eciToCesiumCartesian(posECI, gmst) {
        // Guard against NaN/Infinity
        if (!isOK(posECI[0]) || !isOK(posECI[1]) || !isOK(posECI[2])) {
            return null;
        }

        const cosG = Math.cos(-gmst); // reverse rotation
        const sinG = Math.sin(-gmst);

        // ECI → ECEF
        const x_ecef = cosG * posECI[0] - sinG * posECI[1];
        const y_ecef = sinG * posECI[0] + cosG * posECI[1];
        const z_ecef = posECI[2];

        // ECEF → Cesium Cartesian3 (Cesium uses ECEF internally)
        return new Cesium.Cartesian3(x_ecef, y_ecef, z_ecef);
    }

    /**
     * Compute classical orbital elements from ECI state vector
     * @param {number[]} r - position vector [x, y, z] (m)
     * @param {number[]} v - velocity vector [vx, vy, vz] (m/s)
     * @returns {object} orbital elements
     */
    function computeOrbitalElements(r, v) {
        const rMag = vecMag(r);
        const vMag = vecMag(v);

        // Guard: bail if position or velocity is degenerate
        if (!isOK(rMag) || rMag < 1000 || !isOK(vMag) || vMag < 0.1) {
            return { sma: null, eccentricity: 2, inclination: 0, raan: 0,
                     argPeriapsis: 0, trueAnomaly: 0, energy: 0, angularMomentum: 0,
                     periapsisAlt: null, apoapsisAlt: null, period: null,
                     timeToApoapsis: null, timeToPeriapsis: null,
                     timeToAscendingNode: null, timeToDescendingNode: null,
                     timeToTA90: null, timeToTA270: null,
                     _r: r, _v: v, _e_vec: [0,0,0], _h: [0,0,1] };
        }

        // Angular momentum h = r × v
        const h = vecCross(r, v);
        const hMag = vecMag(h);

        // Guard: near-zero angular momentum (radial trajectory)
        if (hMag < 1e3) {
            return { sma: null, eccentricity: 2, inclination: 0, raan: 0,
                     argPeriapsis: 0, trueAnomaly: 0, energy: 0.5*vMag*vMag - MU/rMag,
                     angularMomentum: hMag,
                     periapsisAlt: null, apoapsisAlt: null, period: null,
                     timeToApoapsis: null, timeToPeriapsis: null,
                     timeToAscendingNode: null, timeToDescendingNode: null,
                     timeToTA90: null, timeToTA270: null,
                     _r: r, _v: v, _e_vec: [0,0,0], _h: h };
        }

        // Node vector n = K × h (K = [0,0,1])
        const n = [-h[1], h[0], 0];
        const nMag = vecMag(n);

        // Specific energy
        const energy = 0.5 * vMag * vMag - MU / rMag;

        // Eccentricity vector: e = ((v²-μ/r)·r - (r·v)·v) / μ
        const rdotv = vecDot(r, v);
        const coeff1 = vMag * vMag - MU / rMag;
        const e_vec = [
            (coeff1 * r[0] - rdotv * v[0]) / MU,
            (coeff1 * r[1] - rdotv * v[1]) / MU,
            (coeff1 * r[2] - rdotv * v[2]) / MU,
        ];
        const ecc = vecMag(e_vec);

        // Semi-major axis
        let sma;
        if (Math.abs(ecc - 1.0) > 1e-6) {
            sma = -MU / (2 * energy);
        } else {
            sma = Infinity; // parabolic
        }

        // Inclination
        const inc = Math.acos(FighterSimEngine.clamp(h[2] / hMag, -1, 1));

        // RAAN (Right Ascension of Ascending Node)
        let raan = 0;
        if (nMag > 1e-6) {
            raan = Math.acos(FighterSimEngine.clamp(n[0] / nMag, -1, 1));
            if (n[1] < 0) raan = 2 * Math.PI - raan;
        }

        // Argument of periapsis
        let argPeri = 0;
        if (nMag > 1e-6 && ecc > 1e-6) {
            argPeri = Math.acos(FighterSimEngine.clamp(vecDot(n, e_vec) / (nMag * ecc), -1, 1));
            if (e_vec[2] < 0) argPeri = 2 * Math.PI - argPeri;
        }

        // True anomaly
        let trueAnomaly = 0;
        if (ecc > 1e-6) {
            trueAnomaly = Math.acos(FighterSimEngine.clamp(vecDot(e_vec, r) / (ecc * rMag), -1, 1));
            if (rdotv < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
        }

        // Derived quantities
        let periapsisAlt = null, apoapsisAlt = null, period = null;
        if (ecc < 1.0 && sma > 0) {
            periapsisAlt = sma * (1 - ecc) - R_EARTH;
            apoapsisAlt = sma * (1 + ecc) - R_EARTH;
            period = 2 * Math.PI * Math.sqrt(sma * sma * sma / MU);
        } else if (ecc >= 1.0) {
            // Hyperbolic or parabolic: only periapsis
            if (sma !== Infinity) {
                periapsisAlt = Math.abs(sma) * (ecc - 1) - R_EARTH;
            }
        }

        // Time to apoapsis/periapsis
        let timeToApoapsis = null, timeToPeriapsis = null;
        let timeToAscendingNode = null, timeToDescendingNode = null;
        let timeToTA90 = null, timeToTA270 = null;
        if (ecc < 1.0 && sma > 0 && period > 0) {
            // Mean motion
            const n_mean = Math.sqrt(MU / (sma * sma * sma));
            var TWO_PI = 2 * Math.PI;
            var sqrt1me2 = Math.sqrt(1 - ecc * ecc);

            // Eccentric anomaly from true anomaly
            const cosTA = Math.cos(trueAnomaly);
            const E = Math.atan2(
                sqrt1me2 * Math.sin(trueAnomaly),
                ecc + cosTA
            );

            // Mean anomaly
            let M = E - ecc * Math.sin(E);
            if (M < 0) M += TWO_PI;

            // Time to periapsis (M = 0)
            timeToPeriapsis = (TWO_PI - M) / n_mean;
            if (timeToPeriapsis > period) timeToPeriapsis -= period;

            // Time to apoapsis (M = π)
            timeToApoapsis = (Math.PI - M) / n_mean;
            if (timeToApoapsis < 0) timeToApoapsis += period;

            // Time to ν=90° and ν=270° (mid-orbit quadrature points)
            // These work for any eccentricity < 1 including circular (e=0)
            var nu90 = Math.PI / 2;
            var e90 = Math.atan2(sqrt1me2 * Math.sin(nu90), ecc + Math.cos(nu90));
            var m90 = e90 - ecc * Math.sin(e90);
            if (m90 < 0) m90 += TWO_PI;
            timeToTA90 = ((m90 - M) % TWO_PI + TWO_PI) % TWO_PI / n_mean;

            var nu270 = 3 * Math.PI / 2;
            var e270 = Math.atan2(sqrt1me2 * Math.sin(nu270), ecc + Math.cos(nu270));
            var m270 = e270 - ecc * Math.sin(e270);
            if (m270 < 0) m270 += TWO_PI;
            timeToTA270 = ((m270 - M) % TWO_PI + TWO_PI) % TWO_PI / n_mean;

            // Time to ascending/descending node (only for inclined orbits)
            if (inc > 0.01) {
                // Ascending node: argument of latitude = 0 → true anomaly = -argPeri
                var nuAsc = (-argPeri % TWO_PI + TWO_PI) % TWO_PI;
                var eAsc = Math.atan2(sqrt1me2 * Math.sin(nuAsc), ecc + Math.cos(nuAsc));
                var mAsc = eAsc - ecc * Math.sin(eAsc);
                if (mAsc < 0) mAsc += TWO_PI;
                timeToAscendingNode = ((mAsc - M) % TWO_PI + TWO_PI) % TWO_PI / n_mean;

                // Descending node: argument of latitude = π → true anomaly = π - argPeri
                var nuDesc = ((Math.PI - argPeri) % TWO_PI + TWO_PI) % TWO_PI;
                var eDesc = Math.atan2(sqrt1me2 * Math.sin(nuDesc), ecc + Math.cos(nuDesc));
                var mDesc = eDesc - ecc * Math.sin(eDesc);
                if (mDesc < 0) mDesc += TWO_PI;
                timeToDescendingNode = ((mDesc - M) % TWO_PI + TWO_PI) % TWO_PI / n_mean;
            }
        }

        return {
            sma,
            eccentricity: ecc,
            inclination: inc,
            raan,
            argPeriapsis: argPeri,
            trueAnomaly,
            energy,
            angularMomentum: hMag,
            periapsisAlt,
            apoapsisAlt,
            period,
            timeToApoapsis,
            timeToPeriapsis,
            timeToAscendingNode,
            timeToDescendingNode,
            timeToTA90,
            timeToTA270,
            // Keep ECI state for propagation
            _r: r,
            _v: v,
            _e_vec: e_vec,
            _h: h,
        };
    }

    /**
     * Detect flight regime based on orbital elements and physical altitude
     * @param {object} elems - orbital elements
     * @param {number} [altitude] - current physical altitude in meters (fallback)
     * @returns {string} 'ATMOSPHERIC', 'SUBORBITAL', 'ORBIT', or 'ESCAPE'
     */
    function detectFlightRegime(elems, altitude) {
        if (elems.energy >= 0) return 'ESCAPE';
        if (elems.periapsisAlt != null && elems.periapsisAlt > KARMAN) return 'ORBIT';
        if (elems.apoapsisAlt != null && elems.apoapsisAlt > KARMAN) return 'SUBORBITAL';
        // Fallback: if physically above the Karman line, at least suborbital
        if (altitude != null && altitude > KARMAN) return 'SUBORBITAL';
        return 'ATMOSPHERIC';
    }

    /**
     * Predict orbit path using Kepler propagation
     * Returns array of ECI positions for one orbit
     *
     * @param {object} elems - orbital elements (from computeOrbitalElements)
     * @param {number} numPoints - number of points to generate
     * @param {number} gmst - current GMST for ECI→ECEF conversion
     * @returns {Cesium.Cartesian3[]} positions in ECEF for Cesium
     */
    function predictOrbitPath(elems, numPoints, gmst, numRevs) {
        if (!elems || !isOK(elems.eccentricity) || !isOK(elems.sma)) {
            return [];
        }
        if (elems.eccentricity >= 0.99 || elems.sma <= 0 || elems.energy >= 0) {
            return [];
        }
        // Skip only truly pathological orbits (periapsis near center of Earth)
        // Allow suborbital arcs where periapsis is underground but orbit is valid
        const rPeriapsis = elems.sma * (1 - elems.eccentricity);
        if (rPeriapsis < R_EARTH * 0.05) {
            return [];
        }

        const a = elems.sma;
        const e = elems.eccentricity;
        const inc = elems.inclination;
        const raan = elems.raan;
        const w = elems.argPeriapsis;
        const n_mean = Math.sqrt(MU / (a * a * a));

        // Current mean anomaly
        const cosTA = Math.cos(elems.trueAnomaly);
        const sinTA = Math.sin(elems.trueAnomaly);
        const E0 = Math.atan2(Math.sqrt(1 - e * e) * sinTA, e + cosTA);
        let M0 = E0 - e * Math.sin(E0);
        if (M0 < 0) M0 += 2 * Math.PI;

        const period = elems.period || 2 * Math.PI / n_mean;
        // Sanity: reject orbits with period > 30 days (near-escape, would create huge arrays)
        if (!isFinite(period) || period > 2592000) return [];
        const positions = [];

        numRevs = numRevs || 1;
        const totalTime = period * numRevs;
        const totalPoints = Math.min(numPoints * numRevs, 3600);

        // Perifocal → ECI rotation matrix components
        const cosW = Math.cos(w);
        const sinW = Math.sin(w);
        const cosI = Math.cos(inc);
        const sinI = Math.sin(inc);
        const cosO = Math.cos(raan);
        const sinO = Math.sin(raan);

        // Rotation matrix columns (perifocal P,Q → ECI)
        const Px = cosO * cosW - sinO * sinW * cosI;
        const Py = sinO * cosW + cosO * sinW * cosI;
        const Pz = sinW * sinI;
        const Qx = -cosO * sinW - sinO * cosW * cosI;
        const Qy = -sinO * sinW + cosO * cosW * cosI;
        const Qz = cosW * sinI;

        for (let i = 0; i <= totalPoints; i++) {
            const frac = i / totalPoints;
            const t = frac * totalTime;

            // Mean anomaly at this time
            let M = M0 + n_mean * t;
            M = M % (2 * Math.PI);
            if (M < 0) M += 2 * Math.PI;

            // Solve Kepler's equation: M = E - e*sin(E) (Newton-Raphson)
            let E = M;
            for (let iter = 0; iter < 15; iter++) {
                const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
                E -= dE;
                if (Math.abs(dE) < 1e-10) break;
            }

            // True anomaly from E
            const cosE = Math.cos(E);
            const sinE = Math.sin(E);
            const nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);

            // Radius
            const r_mag = a * (1 - e * cosE);

            // Perifocal coordinates
            const xP = r_mag * Math.cos(nu);
            const yP = r_mag * Math.sin(nu);

            // ECI coordinates
            const x_eci = Px * xP + Qx * yP;
            const y_eci = Py * xP + Qy * yP;
            const z_eci = Pz * xP + Qz * yP;

            // ECI → ECEF (rotate by negative GMST accounting for Earth rotation during orbit)
            const gmstAtT = gmst + OMEGA_EARTH * t;
            const pt = eciToCesiumCartesian([x_eci, y_eci, z_eci], gmstAtT);
            if (pt) positions.push(pt);
        }

        return positions;
    }

    /**
     * Predict orbit path in ECI frame (inertial, no Earth rotation).
     * Uses fixed GMST for all points — shows true orbital ellipse shape.
     * Multi-rev support: numRevs orbits worth of points.
     */
    function predictOrbitPathECI(elems, numPoints, gmst, numRevs) {
        if (!elems || !isOK(elems.eccentricity) || !isOK(elems.sma)) return [];
        if (elems.eccentricity >= 0.99 || elems.sma <= 0 || elems.energy >= 0) return [];
        const rPeriapsis = elems.sma * (1 - elems.eccentricity);
        if (rPeriapsis < R_EARTH * 0.05) return [];

        const a = elems.sma;
        const e = elems.eccentricity;
        const inc = elems.inclination;
        const raan = elems.raan;
        const w = elems.argPeriapsis;
        const n_mean = Math.sqrt(MU / (a * a * a));

        const cosTA = Math.cos(elems.trueAnomaly);
        const sinTA = Math.sin(elems.trueAnomaly);
        const E0 = Math.atan2(Math.sqrt(1 - e * e) * sinTA, e + cosTA);
        let M0 = E0 - e * Math.sin(E0);
        if (M0 < 0) M0 += 2 * Math.PI;

        const period = elems.period || 2 * Math.PI / n_mean;
        if (!isFinite(period) || period > 2592000) return [];

        numRevs = numRevs || 1;
        // ECI only needs 1 rev of points (it's the same ellipse repeated)
        // but we still generate the full set for consistency
        const totalPoints = Math.min(numPoints, 360);
        const positions = [];

        const cosW = Math.cos(w), sinW = Math.sin(w);
        const cosI = Math.cos(inc), sinI = Math.sin(inc);
        const cosO = Math.cos(raan), sinO = Math.sin(raan);
        const Px = cosO * cosW - sinO * sinW * cosI;
        const Py = sinO * cosW + cosO * sinW * cosI;
        const Pz = sinW * sinI;
        const Qx = -cosO * sinW - sinO * cosW * cosI;
        const Qy = -sinO * sinW + cosO * cosW * cosI;
        const Qz = cosW * sinI;

        for (let i = 0; i <= totalPoints; i++) {
            const frac = i / totalPoints;
            const t = frac * period; // just 1 rev — ECI ellipse repeats

            let M = M0 + n_mean * t;
            M = M % (2 * Math.PI);
            if (M < 0) M += 2 * Math.PI;

            let E = M;
            for (let iter = 0; iter < 15; iter++) {
                const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
                E -= dE;
                if (Math.abs(dE) < 1e-10) break;
            }

            const cosE = Math.cos(E), sinE = Math.sin(E);
            const nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);
            const r_mag = a * (1 - e * cosE);
            const xP = r_mag * Math.cos(nu);
            const yP = r_mag * Math.sin(nu);

            const x_eci = Px * xP + Qx * yP;
            const y_eci = Py * xP + Qy * yP;
            const z_eci = Pz * xP + Qz * yP;

            // Fixed GMST: ECI orbit shape displayed at current Earth orientation
            const pt = eciToCesiumCartesian([x_eci, y_eci, z_eci], gmst);
            if (pt) positions.push(pt);
        }

        return positions;
    }

    /**
     * Compute apoapsis and periapsis positions in ECEF for markers
     */
    function computeApPePositions(elems, gmst) {
        if (!elems || !isOK(elems.eccentricity) || !isOK(elems.sma) ||
            elems.eccentricity >= 1.0 || elems.sma <= 0) {
            return { ap: null, pe: null, an: null, dn: null };
        }
        // Skip only truly pathological orbits
        const rPeCheck = elems.sma * (1 - elems.eccentricity);
        if (rPeCheck < R_EARTH * 0.05) {
            return { ap: null, pe: null, an: null, dn: null };
        }

        const a = elems.sma;
        const e = elems.eccentricity;
        const inc = elems.inclination;
        const raan = elems.raan;
        const w = elems.argPeriapsis;

        const cosW = Math.cos(w);
        const sinW = Math.sin(w);
        const cosI = Math.cos(inc);
        const sinI = Math.sin(inc);
        const cosO = Math.cos(raan);
        const sinO = Math.sin(raan);

        const Px = cosO * cosW - sinO * sinW * cosI;
        const Py = sinO * cosW + cosO * sinW * cosI;
        const Pz = sinW * sinI;
        const Qx = -cosO * sinW - sinO * cosW * cosI;
        const Qy = -sinO * sinW + cosO * cosW * cosI;
        const Qz = cosW * sinI;

        // Periapsis: nu = 0, r = a(1-e)
        const rPe = a * (1 - e);
        const peECI = [Px * rPe, Py * rPe, Pz * rPe];

        // Apoapsis: nu = π, r = a(1+e)
        const rAp = a * (1 + e);
        const apECI = [-Px * rAp, -Py * rAp, -Pz * rAp];

        // For time to ap/pe, compute GMST at those times
        const n_mean = Math.sqrt(MU / (a * a * a));
        const cosTA = Math.cos(elems.trueAnomaly);
        const sinTA = Math.sin(elems.trueAnomaly);
        const E0 = Math.atan2(Math.sqrt(1 - e * e) * sinTA, e + cosTA);
        let M0 = E0 - e * Math.sin(E0);
        if (M0 < 0) M0 += 2 * Math.PI;

        const tPe = elems.timeToPeriapsis || 0;
        const tAp = elems.timeToApoapsis || 0;

        const gmstPe = gmst + OMEGA_EARTH * tPe;
        const gmstAp = gmst + OMEGA_EARTH * tAp;

        // Ascending/descending node positions (only for inclined orbits)
        var anPos = null, dnPos = null;
        if (inc > 0.01) {
            var TWO_PI = 2 * Math.PI;

            // Ascending node: argument of latitude = 0 → true anomaly = -argPeri
            var nuAsc = ((-w) % TWO_PI + TWO_PI) % TWO_PI;
            var rAsc = a * (1 - e * e) / (1 + e * Math.cos(nuAsc));
            var xPasc = rAsc * Math.cos(nuAsc);
            var yPasc = rAsc * Math.sin(nuAsc);
            var anECI = [Px * xPasc + Qx * yPasc, Py * xPasc + Qy * yPasc, Pz * xPasc + Qz * yPasc];
            var tAN = elems.timeToAscendingNode || 0;
            anPos = eciToCesiumCartesian(anECI, gmst + OMEGA_EARTH * tAN);

            // Descending node: argument of latitude = π → true anomaly = π - argPeri
            var nuDesc = ((Math.PI - w) % TWO_PI + TWO_PI) % TWO_PI;
            var rDesc = a * (1 - e * e) / (1 + e * Math.cos(nuDesc));
            var xPdesc = rDesc * Math.cos(nuDesc);
            var yPdesc = rDesc * Math.sin(nuDesc);
            var dnECI = [Px * xPdesc + Qx * yPdesc, Py * xPdesc + Qy * yPdesc, Pz * xPdesc + Qz * yPdesc];
            var tDN = elems.timeToDescendingNode || 0;
            dnPos = eciToCesiumCartesian(dnECI, gmst + OMEGA_EARTH * tDN);
        }

        return {
            ap: eciToCesiumCartesian(apECI, gmstAp),
            pe: eciToCesiumCartesian(peECI, gmstPe),
            an: anPos,
            dn: dnPos,
        };
    }

    /**
     * Propagate an ECI state vector forward by dt seconds using Kepler prediction
     * Returns new ECI state {pos, vel}
     */
    function propagateKepler(pos, vel, dt) {
        const elems = computeOrbitalElements(pos, vel);
        if (elems.eccentricity >= 1.0 || elems.sma <= 0) {
            // Hyperbolic/parabolic: just do linear for now
            return {
                pos: [pos[0] + vel[0] * dt, pos[1] + vel[1] * dt, pos[2] + vel[2] * dt],
                vel: [vel[0], vel[1], vel[2]]
            };
        }

        const a = elems.sma;
        const e = elems.eccentricity;
        const n_mean = Math.sqrt(MU / (a * a * a));

        // Current eccentric anomaly
        const cosTA = Math.cos(elems.trueAnomaly);
        const sinTA = Math.sin(elems.trueAnomaly);
        const E0 = Math.atan2(Math.sqrt(1 - e * e) * sinTA, e + cosTA);
        let M0 = E0 - e * Math.sin(E0);
        if (M0 < 0) M0 += 2 * Math.PI;

        // New mean anomaly
        let M = (M0 + n_mean * dt) % (2 * Math.PI);
        if (M < 0) M += 2 * Math.PI;

        // Solve Kepler
        let E = M;
        for (let iter = 0; iter < 15; iter++) {
            const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-10) break;
        }

        const cosE = Math.cos(E);
        const sinE = Math.sin(E);
        const nu = Math.atan2(Math.sqrt(1 - e * e) * sinE, cosE - e);
        const r_mag = a * (1 - e * cosE);

        // Perifocal coordinates
        const xP = r_mag * Math.cos(nu);
        const yP = r_mag * Math.sin(nu);

        // Perifocal velocity
        const coeff = Math.sqrt(MU / (a * (1 - e * e)));
        const vxP = -coeff * Math.sin(nu);
        const vyP = coeff * (e + Math.cos(nu));

        // Perifocal → ECI rotation
        const inc = elems.inclination;
        const raan = elems.raan;
        const w = elems.argPeriapsis;
        const cosW = Math.cos(w), sinW = Math.sin(w);
        const cosI = Math.cos(inc), sinI = Math.sin(inc);
        const cosO = Math.cos(raan), sinO = Math.sin(raan);

        const Px = cosO * cosW - sinO * sinW * cosI;
        const Py = sinO * cosW + cosO * sinW * cosI;
        const Pz = sinW * sinI;
        const Qx = -cosO * sinW - sinO * cosW * cosI;
        const Qy = -sinO * sinW + cosO * cosW * cosI;
        const Qz = cosW * sinI;

        return {
            pos: [Px * xP + Qx * yP, Py * xP + Qy * yP, Pz * xP + Qz * yP],
            vel: [Px * vxP + Qx * vyP, Py * vxP + Qy * vyP, Pz * vxP + Qz * vyP]
        };
    }

    /**
     * Main update function - called each frame from main loop
     */
    function update(state, simTime) {
        if (!state) return;

        updateCounter++;

        // Convert state to ECI
        const eci = geodeticToECI(state, simTime);

        // Compute orbital elements
        orbitalElements = computeOrbitalElements(eci.pos, eci.vel);

        // Detect flight regime (guard against NaN elements)
        if (!isOK(orbitalElements.eccentricity)) {
            // Truly degenerate — eccentricity is NaN or non-numeric
            flightRegime = state.alt > KARMAN ? 'SUBORBITAL' : 'ATMOSPHERIC';
            currentOrbitPositions = [];
            eciOrbitPositions = [];
            apoapsisPosition = null;
            periapsisPosition = null;
            ascNodePosition = null;
            descNodePosition = null;
            return;
        }
        if (!isOK(orbitalElements.sma)) {
            // sma is Infinity (parabolic) or null (degenerate) — use energy + altitude
            if (orbitalElements.energy >= 0) {
                flightRegime = 'ESCAPE';
            } else if (state.alt > KARMAN) {
                flightRegime = 'SUBORBITAL';
            } else {
                flightRegime = 'ATMOSPHERIC';
            }
            currentOrbitPositions = [];
            eciOrbitPositions = [];
            apoapsisPosition = null;
            periapsisPosition = null;
            ascNodePosition = null;
            descNodePosition = null;
            return;
        }
        flightRegime = detectFlightRegime(orbitalElements, state.alt);

        // Escape trajectory — clear orbit display immediately
        if (flightRegime === 'ESCAPE') {
            currentOrbitPositions = [];
            eciOrbitPositions = [];
            apoapsisPosition = null;
            periapsisPosition = null;
            ascNodePosition = null;
            descNodePosition = null;
            return;
        }

        // Update orbit visualization (less frequently)
        // Show orbit path when not purely atmospheric, OR when trajectory has
        // significant apoapsis (ascending ballistic arc with apoapsis > 30km)
        const showOrbitViz = flightRegime !== 'ATMOSPHERIC' ||
            (orbitalElements.apoapsisAlt != null && orbitalElements.apoapsisAlt > 30000);
        if (updateCounter % UPDATE_INTERVAL === 0 && showOrbitViz) {
            const gmst = OMEGA_EARTH * simTime;

            // Predict orbit paths (ECEF with multi-rev, ECI inertial)
            currentOrbitPositions = predictOrbitPath(orbitalElements, 360, gmst, _numRevs);
            eciOrbitPositions = predictOrbitPathECI(orbitalElements, 360, gmst, _numRevs);

            // Compute AP/PE/AN/DN positions
            const apPe = computeApPePositions(orbitalElements, gmst);
            apoapsisPosition = apPe.ap;
            periapsisPosition = apPe.pe;
            ascNodePosition = apPe.an;
            descNodePosition = apPe.dn;
        }

        // Clear orbit display when fully atmospheric with no significant trajectory
        if (!showOrbitViz) {
            currentOrbitPositions = [];
            eciOrbitPositions = [];
            apoapsisPosition = null;
            periapsisPosition = null;
            ascNodePosition = null;
            descNodePosition = null;
        }
    }

    /**
     * Reset all state
     */
    function reset() {
        currentOrbitPositions = [];
        eciOrbitPositions = [];
        apoapsisPosition = null;
        periapsisPosition = null;
        ascNodePosition = null;
        descNodePosition = null;
        orbitalElements = null;
        flightRegime = 'ATMOSPHERIC';
        updateCounter = 0;
        _numRevs = 1;
    }

    // ---- Vector math utilities ----
    function vecMag(v) {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    }

    function vecDot(a, b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    function vecCross(a, b) {
        return [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]
        ];
    }

    function vecScale(v, s) {
        return [v[0] * s, v[1] * s, v[2] * s];
    }

    function vecAdd(a, b) {
        return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    }

    function vecSub(a, b) {
        return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    }

    function vecNorm(v) {
        const m = vecMag(v);
        return m > 0 ? [v[0] / m, v[1] / m, v[2] / m] : [0, 0, 0];
    }

    // Public API
    return {
        // State (readable by viewer)
        get currentOrbitPositions() { return currentOrbitPositions; },
        get eciOrbitPositions() { return eciOrbitPositions; },
        get apoapsisPosition() { return apoapsisPosition; },
        get periapsisPosition() { return periapsisPosition; },
        get ascNodePosition() { return ascNodePosition; },
        get descNodePosition() { return descNodePosition; },
        get orbitalElements() { return orbitalElements; },
        get flightRegime() { return flightRegime; },

        // Functions
        update,
        reset,
        setNumRevs: function(n) { _numRevs = Math.max(1, Math.min(20, n)); },
        geodeticToECI,
        eciToCesiumCartesian,
        computeOrbitalElements,
        detectFlightRegime,
        predictOrbitPath,
        predictOrbitPathECI,
        propagateKepler,

        // Vector utilities
        vecMag, vecDot, vecCross, vecScale, vecAdd, vecSub, vecNorm,

        // Constants
        MU, R_EARTH, OMEGA_EARTH, KARMAN,
    };
})();
