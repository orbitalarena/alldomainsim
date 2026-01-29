/**
 * Van Allen Radiation Belt Physics Model
 *
 * Analytical trapped particle flux model inspired by AP-8/AE-8.
 * Provides coordinate transforms, dipole magnetic field, flux lookup,
 * dose rate computation, Kepler orbit propagation, and field line tracing.
 */
const VanAllenModel = (function() {
    'use strict';

    // --- Constants ---
    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const MU_EARTH = 3.986004418e14;      // m^3/s^2
    const R_EARTH = 6371000;               // m mean radius
    const OMEGA_EARTH = 7.2921159e-5;      // rad/s Earth rotation rate
    const DIPOLE_MOMENT = 7.94e15;         // T*m^3 Earth magnetic dipole moment
    const DIPOLE_TILT = 11.5 * DEG;        // rad tilt from rotation axis
    const DIPOLE_POLE_LAT = 80.0 * DEG;    // rad geomagnetic north pole latitude
    const DIPOLE_POLE_LON = -71.6 * DEG;   // rad geomagnetic north pole longitude

    // Precompute dipole pole direction in geographic frame (unit vector)
    const poleCosLat = Math.cos(DIPOLE_POLE_LAT);
    const poleSinLat = Math.sin(DIPOLE_POLE_LAT);
    const poleCosLon = Math.cos(DIPOLE_POLE_LON);
    const poleSinLon = Math.sin(DIPOLE_POLE_LON);
    // Geomagnetic pole in geographic Cartesian
    const poleX = poleCosLat * poleCosLon;
    const poleY = poleCosLat * poleSinLon;
    const poleZ = poleSinLat;

    // --- Coordinate Transforms ---

    /**
     * Convert geographic (lat, lon) to geomagnetic coordinates.
     * Uses rotation into dipole-aligned frame.
     * @param {number} lat - geographic latitude (radians)
     * @param {number} lon - geographic longitude (radians)
     * @returns {{ magColat: number, magLon: number }} magnetic colatitude and longitude (radians)
     */
    function geoToGeomagnetic(lat, lon) {
        // Geographic position unit vector
        const cosLat = Math.cos(lat);
        const sinLat = Math.sin(lat);
        const cosLon = Math.cos(lon);
        const sinLon = Math.sin(lon);
        const gx = cosLat * cosLon;
        const gy = cosLat * sinLon;
        const gz = sinLat;

        // Magnetic colatitude: angle from dipole axis
        // cos(colat) = dot(pos_hat, pole_hat)
        const cosColat = gx * poleX + gy * poleY + gz * poleZ;
        const magColat = Math.acos(Math.max(-1, Math.min(1, cosColat)));

        // Magnetic longitude: project onto plane perpendicular to dipole axis
        // Use cross-product based approach for azimuthal angle
        // Reference direction: geographic Z cross dipole axis, normalized
        const refX = poleZ * 0 - 0 * poleY;  // simplified: Z cross pole
        const refY = 0 * poleX - poleZ * 0;   // but Z = (0,0,1)
        const refZ_raw = 0;
        // Actually: Z x pole = (0*poleZ - 1*poleY, 1*poleX - 0*poleZ, 0*poleY - 0*poleX)
        const eRefX = -poleY;
        const eRefY = poleX;
        const eRefZ = 0;
        const eRefMag = Math.sqrt(eRefX * eRefX + eRefY * eRefY + eRefZ * eRefZ);

        if (eRefMag < 1e-10) {
            return { magColat: magColat, magLon: 0 };
        }
        const e1x = eRefX / eRefMag;
        const e1y = eRefY / eRefMag;
        const e1z = eRefZ / eRefMag;

        // e2 = pole x e1
        const e2x = poleY * e1z - poleZ * e1y;
        const e2y = poleZ * e1x - poleX * e1z;
        const e2z = poleX * e1y - poleY * e1x;

        // Project position onto e1, e2
        const proj1 = gx * e1x + gy * e1y + gz * e1z;
        const proj2 = gx * e2x + gy * e2y + gz * e2z;
        const magLon = Math.atan2(proj2, proj1);

        return { magColat: magColat, magLon: magLon };
    }

    /**
     * ECI position to geographic (lat, lon, alt).
     * @param {number[]} pos - [x, y, z] ECI position in meters
     * @param {number} simTime - simulation time in seconds (for GMST)
     * @returns {{ lat: number, lon: number, alt: number }} radians, radians, meters
     */
    function eciToGeographic(pos, simTime) {
        const x = pos[0], y = pos[1], z = pos[2];
        const r = Math.sqrt(x * x + y * y + z * z);
        const alt = r - R_EARTH;
        const lat = Math.asin(z / r);

        // GMST rotation
        const gmst = OMEGA_EARTH * simTime;
        const lonECI = Math.atan2(y, x);
        let lon = lonECI - gmst;
        // Normalize to [-pi, pi]
        lon = ((lon + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

        return { lat: lat, lon: lon, alt: alt };
    }

    /**
     * Compute McIlwain L-shell parameter.
     * L = r / (R_E * sin^2(theta_m))
     * @param {number} r - radial distance from Earth center (meters)
     * @param {number} magColat - magnetic colatitude (radians)
     * @returns {number} L-shell parameter (Earth radii)
     */
    function computeLShell(r, magColat) {
        const sinColat = Math.sin(magColat);
        const sin2 = sinColat * sinColat;
        // Guard against poles where sin^2 -> 0
        if (sin2 < 0.01) return 1000; // effectively infinite L (polar region)
        return (r / R_EARTH) / sin2;
    }

    /**
     * Compute dipole magnetic field magnitude.
     * |B| = (M/r^3) * sqrt(1 + 3*cos^2(theta_m))
     * @param {number} r - radial distance (meters)
     * @param {number} magColat - magnetic colatitude (radians)
     * @returns {number} |B| in Tesla
     */
    function computeB(r, magColat) {
        const cosColat = Math.cos(magColat);
        const r3 = r * r * r;
        return (DIPOLE_MOMENT / r3) * Math.sqrt(1 + 3 * cosColat * cosColat);
    }

    /**
     * Compute equatorial B at a given L-shell.
     * B0 = M / (L * R_E)^3
     * @param {number} L - L-shell parameter
     * @returns {number} B0 in Tesla
     */
    function computeB0(L) {
        const Lr = L * R_EARTH;
        return DIPOLE_MOMENT / (Lr * Lr * Lr);
    }

    // --- Trapped Particle Flux Model (AP-8/AE-8 Inspired) ---

    /**
     * Proton flux E > 10 MeV at equator, particles/cm^2/s
     * Peaks at L=1.8
     */
    function protonFlux10(L) {
        if (L > 3.5 || L < 1.0) return 0;
        const lnRatio = Math.log(L / 1.8);
        return 1e5 * Math.exp(-(lnRatio * lnRatio) / (2 * 0.15 * 0.15));
    }

    /**
     * Proton flux E > 100 MeV at equator, particles/cm^2/s
     * Peaks at L=1.5
     */
    function protonFlux100(L) {
        if (L > 3.5 || L < 1.0) return 0;
        const lnRatio = Math.log(L / 1.5);
        return 1e3 * Math.exp(-(lnRatio * lnRatio) / (2 * 0.10 * 0.10));
    }

    /**
     * Electron flux E > 0.5 MeV at equator, particles/cm^2/s
     * Inner belt peak L=1.4, outer belt peak L=4.5
     */
    function electronFlux05(L) {
        if (L < 1.0) return 0;
        const inner = 5e4 * Math.exp(-((L - 1.4) * (L - 1.4)) / (2 * 0.2 * 0.2));
        const outer = (L > 1.5) ? 1e7 * Math.exp(-((L - 4.5) * (L - 4.5)) / (2 * 1.0 * 1.0)) : 0;
        return inner + outer;
    }

    /**
     * Electron flux E > 1 MeV at equator, particles/cm^2/s
     */
    function electronFlux1(L) {
        if (L < 1.0) return 0;
        const inner = 5e3 * Math.exp(-((L - 1.4) * (L - 1.4)) / (2 * 0.2 * 0.2));
        const outer = (L > 1.5) ? 1e6 * Math.exp(-((L - 4.5) * (L - 4.5)) / (2 * 0.8 * 0.8)) : 0;
        return inner + outer;
    }

    /**
     * Get total radiation flux at a given position.
     * @param {number} r_m - radial distance from Earth center (meters)
     * @param {number} lat_rad - geographic latitude (radians)
     * @param {number} lon_rad - geographic longitude (radians)
     * @param {number} simTime - simulation time (seconds)
     * @returns {{ proton10, proton100, electron05, electron1, L, B, B_B0, doseRate }}
     */
    function getFlux(r_m, lat_rad, lon_rad, simTime) {
        const mag = geoToGeomagnetic(lat_rad, lon_rad);
        const L = computeLShell(r_m, mag.magColat);
        const B = computeB(r_m, mag.magColat);
        const B0 = computeB0(L);
        const B_B0 = (B0 > 0) ? B / B0 : 1;

        // Equatorial flux values
        let p10 = protonFlux10(L);
        let p100 = protonFlux100(L);
        let e05 = electronFlux05(L);
        let e1 = electronFlux1(L);

        // Off-equatorial correction: flux decreases away from equator
        // Phi(L,B) = Phi_eq(L) * (B0/B)^n
        if (B_B0 > 1) {
            const invBratio = 1.0 / B_B0; // B0/B < 1 off equator
            const protonCorr = Math.pow(invBratio, 1.5);
            const electronCorr = Math.pow(invBratio, 2.0);
            p10 *= protonCorr;
            p100 *= protonCorr;
            e05 *= electronCorr;
            e1 *= electronCorr;
        }

        // Dose rate calculation (rad(Si)/s)
        const doseProton = p10 * 2.0e-9;
        const doseElectron = e05 * 3.0e-10;
        const doseRate = doseProton + doseElectron;

        return {
            proton10: p10,
            proton100: p100,
            electron05: e05,
            electron1: e1,
            L: L,
            B: B,
            B_B0: B_B0,
            doseRate: doseRate
        };
    }

    /**
     * Get flux at given L-shell and B/B0 ratio (for cross-section rendering).
     * Faster than getFlux since it skips coordinate transforms.
     */
    function getFluxAtLB(L, B_B0) {
        let p10 = protonFlux10(L);
        let p100 = protonFlux100(L);
        let e05 = electronFlux05(L);
        let e1 = electronFlux1(L);

        if (B_B0 > 1) {
            const invBratio = 1.0 / B_B0;
            p10 *= Math.pow(invBratio, 1.5);
            p100 *= Math.pow(invBratio, 1.5);
            e05 *= Math.pow(invBratio, 2.0);
            e1 *= Math.pow(invBratio, 2.0);
        }

        return {
            proton10: p10,
            proton100: p100,
            electron05: e05,
            electron1: e1,
            total: p10 + e05
        };
    }

    // --- Kepler Orbit Propagation ---

    /**
     * Create an orbit from classical elements.
     * @param {number} a - semi-major axis (meters)
     * @param {number} e - eccentricity
     * @param {number} i - inclination (degrees)
     * @param {number} raan - right ascension of ascending node (degrees)
     * @param {number} argp - argument of perigee (degrees)
     * @param {number} M0 - mean anomaly at epoch (degrees)
     * @returns {object} orbit object
     */
    function createOrbit(a, e, i, raan, argp, M0) {
        const n = Math.sqrt(MU_EARTH / (a * a * a)); // mean motion (rad/s)
        return {
            a: a,
            e: e,
            i: i * DEG,
            raan: raan * DEG,
            argp: argp * DEG,
            M0: M0 * DEG,
            n: n,
            period: 2 * Math.PI / n
        };
    }

    /**
     * Solve Kepler's equation M = E - e*sin(E) via Newton-Raphson.
     * @param {number} M - mean anomaly (radians)
     * @param {number} e - eccentricity
     * @returns {number} eccentric anomaly E (radians)
     */
    function solveKepler(M, e) {
        // Normalize M to [0, 2pi]
        M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        let E = M; // initial guess
        for (let iter = 0; iter < 30; iter++) {
            const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-12) break;
        }
        return E;
    }

    /**
     * Propagate orbit to get ECI position and velocity at time t.
     * @param {object} orbit - orbit object from createOrbit
     * @param {number} t - time since epoch (seconds)
     * @returns {{ pos: number[], vel: number[] }} ECI position (m) and velocity (m/s)
     */
    function propagateOrbit(orbit, t) {
        const M = orbit.M0 + orbit.n * t;
        const E = solveKepler(M, orbit.e);

        // True anomaly
        const sinE = Math.sin(E);
        const cosE = Math.cos(E);
        const sqrt1me2 = Math.sqrt(1 - orbit.e * orbit.e);
        const nu = Math.atan2(sqrt1me2 * sinE, cosE - orbit.e);

        // Distance
        const r = orbit.a * (1 - orbit.e * cosE);

        // Position in perifocal frame
        const cosNu = Math.cos(nu);
        const sinNu = Math.sin(nu);
        const px = r * cosNu;
        const py = r * sinNu;

        // Velocity in perifocal frame
        const h = Math.sqrt(MU_EARTH * orbit.a * (1 - orbit.e * orbit.e));
        const vx = -MU_EARTH / h * sinNu;
        const vy = MU_EARTH / h * (orbit.e + cosNu);

        // Rotation matrix: perifocal -> ECI
        const cosO = Math.cos(orbit.raan);
        const sinO = Math.sin(orbit.raan);
        const cosI = Math.cos(orbit.i);
        const sinI = Math.sin(orbit.i);
        const cosW = Math.cos(orbit.argp);
        const sinW = Math.sin(orbit.argp);

        // Column vectors of rotation matrix
        const r11 = cosO * cosW - sinO * sinW * cosI;
        const r12 = -cosO * sinW - sinO * cosW * cosI;
        const r21 = sinO * cosW + cosO * sinW * cosI;
        const r22 = -sinO * sinW + cosO * cosW * cosI;
        const r31 = sinW * sinI;
        const r32 = cosW * sinI;

        return {
            pos: [
                r11 * px + r12 * py,
                r21 * px + r22 * py,
                r31 * px + r32 * py
            ],
            vel: [
                r11 * vx + r12 * vy,
                r21 * vx + r22 * vy,
                r31 * vx + r32 * vy
            ]
        };
    }

    /**
     * Generate full orbit path as array of ECI positions.
     * @param {object} orbit - orbit object
     * @param {number} numPoints - number of points (default 360)
     * @returns {number[][]} array of [x,y,z] ECI positions
     */
    function getOrbitPath(orbit, numPoints) {
        numPoints = numPoints || 360;
        const positions = [];
        const dt = orbit.period / numPoints;
        for (let k = 0; k < numPoints; k++) {
            const state = propagateOrbit(orbit, k * dt);
            positions.push(state.pos);
        }
        return positions;
    }

    // --- Magnetic Field Lines ---

    /**
     * Trace a dipole field line for a given L-shell in the geomagnetic meridional plane.
     * @param {number} L - L-shell parameter
     * @param {number} numPoints - points along the line (default 100)
     * @returns {{ r: number, magLat: number }[]} array of (r, magnetic_latitude) pairs
     */
    function traceFieldLine(L, numPoints) {
        numPoints = numPoints || 100;
        const points = [];
        const maxLat = 75 * DEG;
        for (let k = 0; k < numPoints; k++) {
            const magLat = -maxLat + (2 * maxLat) * k / (numPoints - 1);
            const cosLat = Math.cos(magLat);
            const r = L * R_EARTH * cosLat * cosLat;
            // Skip if below Earth surface
            if (r >= R_EARTH) {
                points.push({ r: r, magLat: magLat });
            }
        }
        return points;
    }

    /**
     * Generate 3D field line positions in ECI for Cesium visualization.
     * Rotates field line from magnetic meridional plane to geographic frame,
     * then from ECEF to ECI at simTime.
     * @param {number} L - L-shell
     * @param {number} geoLon - geographic longitude for this field line (radians)
     * @param {number} simTime - simulation time (seconds)
     * @returns {number[][]} array of [x,y,z] ECI positions
     */
    function fieldLineToECI(L, geoLon, simTime) {
        const points = traceFieldLine(L, 80);
        const gmst = OMEGA_EARTH * simTime;
        const result = [];

        for (let k = 0; k < points.length; k++) {
            const r = points[k].r;
            const magLat = points[k].magLat;
            // Magnetic colatitude
            const magColat = Math.PI / 2 - magLat;

            // Position in geomagnetic spherical:
            // the field line lies in a meridional plane at some mag longitude.
            // We map magnetic coords back to geographic approximately:
            // For visualization, we use the given geographic longitude
            // and derive geographic latitude from the magnetic latitude + tilt offset.
            // Simplified: geographic lat ≈ magLat + tilt * cos(geoLon - poleLon)
            const geoLat = magLat + DIPOLE_TILT * Math.cos(geoLon - DIPOLE_POLE_LON);
            const clampedLat = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, geoLat));

            // ECEF position
            const cosLat = Math.cos(clampedLat);
            const sinLat = Math.sin(clampedLat);
            const cosLon = Math.cos(geoLon);
            const sinLon = Math.sin(geoLon);

            const xe = r * cosLat * cosLon;
            const ye = r * cosLat * sinLon;
            const ze = r * sinLat;

            // ECEF → ECI via GMST
            const cosG = Math.cos(gmst);
            const sinG = Math.sin(gmst);
            result.push([
                xe * cosG - ye * sinG,
                xe * sinG + ye * cosG,
                ze
            ]);
        }
        return result;
    }

    /**
     * Generate field lines for multiple L-shells and longitudes.
     * @param {number[]} L_values - array of L-shell values
     * @param {number} numLongitudes - number of longitude planes (default 12)
     * @param {number} simTime - simulation time
     * @returns {{ L: number, lon: number, positions: number[][] }[]}
     */
    function generateFieldLines(L_values, numLongitudes, simTime) {
        numLongitudes = numLongitudes || 12;
        const lines = [];
        for (let li = 0; li < L_values.length; li++) {
            for (let lk = 0; lk < numLongitudes; lk++) {
                const lon = (2 * Math.PI * lk) / numLongitudes;
                const positions = fieldLineToECI(L_values[li], lon, simTime);
                if (positions.length > 2) {
                    lines.push({
                        L: L_values[li],
                        lon: lon,
                        positions: positions
                    });
                }
            }
        }
        return lines;
    }

    /**
     * ECI position to ECEF (for Cesium Cartesian3).
     * @param {number[]} eci - [x,y,z] ECI position
     * @param {number} simTime - simulation time
     * @returns {number[]} [x,y,z] ECEF position
     */
    function eciToECEF(eci, simTime) {
        const gmst = OMEGA_EARTH * simTime;
        const cosG = Math.cos(gmst);
        const sinG = Math.sin(gmst);
        return [
            eci[0] * cosG + eci[1] * sinG,
            -eci[0] * sinG + eci[1] * cosG,
            eci[2]
        ];
    }

    // --- Public API ---
    return {
        // Constants
        MU_EARTH: MU_EARTH,
        R_EARTH: R_EARTH,
        OMEGA_EARTH: OMEGA_EARTH,
        DEG: DEG,
        RAD: RAD,

        // Coordinate transforms
        geoToGeomagnetic: geoToGeomagnetic,
        eciToGeographic: eciToGeographic,
        eciToECEF: eciToECEF,
        computeLShell: computeLShell,
        computeB: computeB,
        computeB0: computeB0,

        // Flux model
        getFlux: getFlux,
        getFluxAtLB: getFluxAtLB,

        // Orbit propagation
        createOrbit: createOrbit,
        propagateOrbit: propagateOrbit,
        getOrbitPath: getOrbitPath,

        // Field lines
        traceFieldLine: traceFieldLine,
        fieldLineToECI: fieldLineToECI,
        generateFieldLines: generateFieldLines
    };
})();
