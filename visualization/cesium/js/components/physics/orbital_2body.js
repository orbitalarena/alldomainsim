/**
 * Orbital2Body — Keplerian 2-body orbital propagation physics component
 * with optional J2 oblateness secular perturbations.
 *
 * Propagates satellites using analytical Kepler equation solving.
 * When J2 is enabled (default), applies secular drift to RAAN and argument
 * of perigee per Brouwer theory, plus J2-corrected mean motion.
 *
 * Supports initialization from:
 *   - TLE data (source: 'tle', tle_line1, tle_line2)
 *   - Geodetic state (source: 'state', uses entity lat/lon/alt/speed/heading/gamma)
 *   - Classical elements (source: 'elements', sma, ecc, inc, raan, argPerigee, meanAnomaly)
 *
 * Config options:
 *   - j2: boolean (default true) — enable J2 secular perturbations on RAAN/argPe/M
 *
 * J2 secular effects:
 *   - RAAN regression: ~-7 deg/day for ISS-like orbit (400km, 51.6deg)
 *   - Arg of perigee advance: ~+3.5 deg/day for ISS-like orbit
 *   - Sun-synchronous orbits (inc ~98deg) maintain constant RAAN-to-Sun angle
 *
 * Updates entity state: lat, lon, alt (geodetic, radians), speed,
 * and stores ECI state in _eci_pos, _eci_vel, _orbital for visual component.
 *
 * Registered as: physics / orbital_2body
 */
(function() {
    'use strict';

    var MU = 3.986004418e14;
    var R_EARTH = 6371000;
    var R_EQ = 6378137;            // Earth equatorial radius (m) for J2
    var J2 = 1.08263e-3;           // Earth J2 oblateness coefficient
    var OMEGA_EARTH = 7.2921159e-5;
    var DEG = Math.PI / 180;
    var TWO_PI = 2 * Math.PI;

    class Orbital2Body extends ECS.Component {
        constructor(config) {
            super(config);
            this._eciPos = null;
            this._eciVel = null;
            this._orbitalElements = null;
            this._updateCounter = 0;
            this._pendingDt = 0;
            // J2 secular perturbation: ON by default, disable with "j2": false in config
            this._useJ2 = (config.j2 !== false);
            // Osculating elements for J2 propagation (set during init)
            this._oscElements = null;
        }

        init(world) {
            var entity = this.entity;
            var state = entity.state;
            var cfg = this.config;
            var simTime = world.simTime || 0;

            if (cfg.source === 'tle' && cfg.tle_line1 && cfg.tle_line2) {
                // ---- Initialize from TLE data ----
                this._initFromTLE(state, cfg, simTime);
            } else if (cfg.source === 'elements') {
                // ---- Initialize from classical orbital elements ----
                this._initFromElements(state, cfg, simTime);
            } else {
                // ---- Initialize from geodetic state (default) ----
                console.warn('[Orbital2Body] ' + entity.id + ': fallback to _initFromState' +
                    ' (source=' + cfg.source + ', tle_line1=' + !!cfg.tle_line1 + ')');
                this._initFromState(state, simTime);
            }

            // Compute initial orbital elements
            this._computeOrbitalElements();

            // Extract osculating elements for J2 propagation
            if (this._useJ2) {
                this._oscElements = this._extractElements(this._eciPos, this._eciVel);
            }

            // Store in entity state for visual component
            state._eci_pos = this._eciPos;
            state._eci_vel = this._eciVel;
            state._orbital = this._orbitalElements;
            state._simTime = simTime;
        }

        update(dt, world) {
            if (!this._eciPos || !this._eciVel) return;

            var state = this.entity.state;

            // Accumulate sub-step dt for a single analytical propagation
            // The PhysicsSystem sub-steps at 0.05s, but Kepler is analytical
            // so we batch sub-steps for better accuracy
            this._pendingDt += dt;

            // Propagate when we've accumulated enough (or at least once per frame)
            // Sub-steps from PhysicsSystem are 0.05s; accumulate until > 0.04s
            if (this._pendingDt < 0.04) return;

            var propagateDt = this._pendingDt;
            this._pendingDt = 0;

            // Analytical propagation: J2 secular perturbations or pure Kepler
            if (this._useJ2 && this._oscElements) {
                var result = this._stepKeplerJ2(propagateDt);
                this._eciPos = result.pos;
                this._eciVel = result.vel;
            } else {
                var result = TLEParser.propagateKepler(this._eciPos, this._eciVel, propagateDt);
                this._eciPos = result.pos;
                this._eciVel = result.vel;
            }

            // ECI → geodetic
            var gmst = OMEGA_EARTH * world.simTime;
            var geo = TLEParser.eciToGeodetic(this._eciPos, gmst);

            state.lat = geo.lat;
            state.lon = geo.lon;
            state.alt = geo.alt;

            // Update speed from velocity magnitude
            var v = this._eciVel;
            state.speed = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

            // Update orbital elements periodically (every ~30 physics sub-steps)
            this._updateCounter++;
            if (this._updateCounter % 30 === 0) {
                this._computeOrbitalElements();
            }

            // Share with visual component
            state._eci_pos = this._eciPos;
            state._eci_vel = this._eciVel;
            state._orbital = this._orbitalElements;
            state._simTime = world.simTime;
        }

        // ---------------------------------------------------------------
        // J2 Secular Perturbation Propagation
        // ---------------------------------------------------------------

        /**
         * Extract classical orbital elements from ECI state vector.
         * Returns null for degenerate/hyperbolic orbits.
         *
         * @param {number[]} pos  ECI position [x,y,z] (m)
         * @param {number[]} vel  ECI velocity [vx,vy,vz] (m/s)
         * @returns {object|null} { sma, ecc, inc, raan, argPe, M, n } (all radians)
         */
        _extractElements(pos, vel) {
            var rMag = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
            var vMag = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);

            if (rMag < 1000 || vMag < 0.1) return null;

            var energy = 0.5 * vMag * vMag - MU / rMag;
            var sma = -MU / (2 * energy);

            if (!isFinite(sma) || sma <= 0) return null;

            // Angular momentum
            var hx = pos[1] * vel[2] - pos[2] * vel[1];
            var hy = pos[2] * vel[0] - pos[0] * vel[2];
            var hz = pos[0] * vel[1] - pos[1] * vel[0];
            var hMag = Math.sqrt(hx * hx + hy * hy + hz * hz);

            if (hMag < 1e3) return null;

            // Eccentricity vector
            var rdotv = pos[0] * vel[0] + pos[1] * vel[1] + pos[2] * vel[2];
            var c1 = vMag * vMag - MU / rMag;
            var ex = (c1 * pos[0] - rdotv * vel[0]) / MU;
            var ey = (c1 * pos[1] - rdotv * vel[1]) / MU;
            var ez = (c1 * pos[2] - rdotv * vel[2]) / MU;
            var ecc = Math.sqrt(ex * ex + ey * ey + ez * ez);

            if (ecc >= 1.0) return null;

            // Inclination
            var cosI = Math.min(1, Math.max(-1, hz / hMag));
            var inc = Math.acos(cosI);

            // Node vector
            var nx = -hy;
            var ny = hx;
            var nMag = Math.sqrt(nx * nx + ny * ny);

            // RAAN
            var raan = 0;
            if (nMag > 1e-6) {
                raan = Math.acos(Math.min(1, Math.max(-1, nx / nMag)));
                if (ny < 0) raan = TWO_PI - raan;
            }

            // Argument of perigee
            var argPe = 0;
            if (nMag > 1e-6 && ecc > 1e-6) {
                var ndotE = (nx * ex + ny * ey) / (nMag * ecc);
                argPe = Math.acos(Math.min(1, Math.max(-1, ndotE)));
                if (ez < 0) argPe = TWO_PI - argPe;
            }

            // True anomaly
            var trueAnom = 0;
            if (ecc > 1e-6) {
                var edotR = (ex * pos[0] + ey * pos[1] + ez * pos[2]) / (ecc * rMag);
                trueAnom = Math.acos(Math.min(1, Math.max(-1, edotR)));
                if (rdotv < 0) trueAnom = TWO_PI - trueAnom;
            }

            // Eccentric anomaly and mean anomaly
            var cosTA = Math.cos(trueAnom);
            var sinTA = Math.sin(trueAnom);
            var E0 = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinTA, ecc + cosTA);
            var M = E0 - ecc * Math.sin(E0);
            if (M < 0) M += TWO_PI;

            // Mean motion
            var n = Math.sqrt(MU / (sma * sma * sma));

            return {
                sma: sma,
                ecc: ecc,
                inc: inc,
                raan: raan,
                argPe: argPe,
                M: M,
                n: n
            };
        }

        /**
         * Propagate one timestep using Kepler + J2 secular perturbations.
         *
         * J2 secular rates (Brouwer theory):
         *   dRaan/dt  = -1.5 * n * J2 * (R_eq/p)^2 * cos(i)
         *   dArgPe/dt =  1.5 * n * J2 * (R_eq/p)^2 * (2 - 2.5*sin^2(i))
         *   dM/dt     =  n * (1 + 1.5*J2*(R_eq/a)^2 * (1 - 1.5*sin^2(i)) / (1-e^2)^1.5)
         *
         * Where p = a*(1-e^2) is the semi-latus rectum.
         *
         * @param {number} dt  timestep in seconds
         * @returns {{ pos: number[], vel: number[] }} new ECI state
         */
        _stepKeplerJ2(dt) {
            var el = this._oscElements;

            var sma = el.sma;
            var ecc = el.ecc;
            var inc = el.inc;
            var n = el.n;

            // Semi-latus rectum
            var p = sma * (1 - ecc * ecc);

            // Guard: p must be positive and finite
            if (!isFinite(p) || p < 1000) {
                // Fall back to pure Kepler
                var fb = TLEParser.propagateKepler(this._eciPos, this._eciVel, dt);
                return fb;
            }

            var sinI = Math.sin(inc);
            var cosI = Math.cos(inc);
            var sin2I = sinI * sinI;

            // J2 geometric factor: (R_eq / p)^2
            var rp2 = (R_EQ / p) * (R_EQ / p);

            // Secular drift rates (rad/s)
            var dRaan_dt  = -1.5 * n * J2 * rp2 * cosI;
            var dArgPe_dt =  1.5 * n * J2 * rp2 * (2.0 - 2.5 * sin2I);

            // J2-corrected mean motion for mean anomaly advance
            var oneMinusE2_32 = Math.pow(1 - ecc * ecc, 1.5);
            var n_j2 = n * (1.0 + 1.5 * J2 * (R_EQ / sma) * (R_EQ / sma) *
                            (1.0 - 1.5 * sin2I) / oneMinusE2_32);

            // Advance elements
            el.raan  = (el.raan  + dRaan_dt  * dt) % TWO_PI;
            el.argPe = (el.argPe + dArgPe_dt * dt) % TWO_PI;
            el.M     = (el.M     + n_j2      * dt) % TWO_PI;

            // Normalize to [0, 2*PI)
            if (el.raan < 0)  el.raan += TWO_PI;
            if (el.argPe < 0) el.argPe += TWO_PI;
            if (el.M < 0)     el.M += TWO_PI;

            // Solve Kepler's equation: M = E - e*sin(E)
            var M = el.M;
            var E = M;
            for (var iter = 0; iter < 20; iter++) {
                var dE = (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
                E -= dE;
                if (Math.abs(dE) < 1e-12) break;
            }

            // True anomaly
            var cosE = Math.cos(E);
            var sinE = Math.sin(E);
            var nu = Math.atan2(Math.sqrt(1 - ecc * ecc) * sinE, cosE - ecc);

            // Radius
            var r = sma * (1 - ecc * cosE);

            // Perifocal coordinates
            var xP = r * Math.cos(nu);
            var yP = r * Math.sin(nu);

            // Perifocal velocity
            var vCoeff = Math.sqrt(MU / p);
            var vxP = -vCoeff * Math.sin(nu);
            var vyP = vCoeff * (ecc + Math.cos(nu));

            // Perifocal → ECI rotation using current (drifted) RAAN and argPe
            var w = el.argPe;
            var raan = el.raan;

            var cosW = Math.cos(w),  sinW = Math.sin(w);
            var cosIn = Math.cos(inc), sinIn = Math.sin(inc);
            var cosO = Math.cos(raan), sinO = Math.sin(raan);

            var Px = cosO * cosW - sinO * sinW * cosIn;
            var Py = sinO * cosW + cosO * sinW * cosIn;
            var Pz = sinW * sinIn;
            var Qx = -cosO * sinW - sinO * cosW * cosIn;
            var Qy = -sinO * sinW + cosO * cosW * cosIn;
            var Qz = cosW * sinIn;

            return {
                pos: [Px * xP + Qx * yP, Py * xP + Qy * yP, Pz * xP + Qz * yP],
                vel: [Px * vxP + Qx * vyP, Py * vxP + Qy * vyP, Pz * vxP + Qz * vyP]
            };
        }

        // ---------------------------------------------------------------
        // Initialization methods
        // ---------------------------------------------------------------

        _initFromTLE(state, cfg, simTime) {
            var sat = TLEParser.parseTLE(this.entity.name, cfg.tle_line1, cfg.tle_line2);
            if (!sat) {
                console.warn('[Orbital2Body] Failed to parse TLE for ' + this.entity.id);
                this._initFromState(state, simTime);
                return;
            }

            // Advance mean anomaly from TLE epoch to sim epoch
            if (sat.epochYear && sat.epochDay && typeof TLEParser.tleEpochToJD === 'function') {
                var tleJD = TLEParser.tleEpochToJD(sat.epochYear, sat.epochDay);
                var simEpochJD = (this.entity._world && this.entity._world.simEpochJD) || 2440587.5 + Date.now() / 86400000;
                var dtSec = (simEpochJD - tleJD) * 86400;
                if (Math.abs(dtSec) > 1) {
                    var n_rad = Math.sqrt(MU / (sat.sma * sat.sma * sat.sma)); // rad/s
                    var dM_deg = (n_rad * dtSec) * (180 / Math.PI);
                    sat.meanAnomaly = ((sat.meanAnomaly + dM_deg) % 360 + 360) % 360;
                }
            }

            var eci = TLEParser.tleToECI(sat);
            this._eciPos = eci.pos;
            this._eciVel = eci.vel;

            // Set geodetic state
            var gmst = OMEGA_EARTH * simTime;
            var geo = TLEParser.eciToGeodetic(eci.pos, gmst);
            state.lat = geo.lat;
            state.lon = geo.lon;
            state.alt = geo.alt;
            state.speed = Math.sqrt(eci.vel[0] * eci.vel[0] + eci.vel[1] * eci.vel[1] + eci.vel[2] * eci.vel[2]);
        }

        _initFromElements(state, cfg, simTime) {
            // Build a synthetic TLE-like object from classical elements
            // Accept both short (ecc, inc) and long (eccentricity, inclination) field names
            var sma = cfg.sma || (R_EARTH + (state.alt || 400000));
            var ecc = cfg.eccentricity != null ? cfg.eccentricity :
                      cfg.ecc != null ? cfg.ecc : 0.001;
            var inc = cfg.inclination != null ? cfg.inclination :
                      cfg.inc != null ? cfg.inc : 51.6;
            var n_rad = Math.sqrt(MU / (sma * sma * sma));
            var meanMotion = n_rad * 86400 / TWO_PI;

            var synthSat = {
                sma: sma,
                eccentricity: ecc,
                inclination: inc,
                raan: cfg.raan != null ? cfg.raan : 0,
                argPerigee: cfg.argPerigee != null ? cfg.argPerigee : 0,
                meanAnomaly: cfg.meanAnomaly != null ? cfg.meanAnomaly : 0,
                meanMotion: meanMotion
            };

            var eci = TLEParser.tleToECI(synthSat);
            this._eciPos = eci.pos;
            this._eciVel = eci.vel;

            var gmst = OMEGA_EARTH * simTime;
            var geo = TLEParser.eciToGeodetic(eci.pos, gmst);
            state.lat = geo.lat;
            state.lon = geo.lon;
            state.alt = geo.alt;
            state.speed = Math.sqrt(eci.vel[0] * eci.vel[0] + eci.vel[1] * eci.vel[1] + eci.vel[2] * eci.vel[2]);
        }

        _initFromState(state, simTime) {
            // Convert geodetic state to ECI
            // Note: state.speed is already inertial in the non-rotating Earth frame
            // used by the 3-DOF physics engine. Do NOT add ω×r Earth rotation.
            var lat = state.lat != null ? state.lat : 0;
            var lon = state.lon != null ? state.lon : 0;
            var alt = state.alt != null ? state.alt : 400000;
            var V = state.speed != null ? state.speed : 7670;
            var hdg = state.heading != null ? state.heading : 0;
            var gamma = state.gamma != null ? state.gamma : 0;
            var gmst = OMEGA_EARTH * simTime;

            var R = R_EARTH + alt;
            var cosLat = Math.cos(lat);
            var sinLat = Math.sin(lat);
            var cosLon = Math.cos(lon);
            var sinLon = Math.sin(lon);

            // Position (ECEF)
            var x_ecef = R * cosLat * cosLon;
            var y_ecef = R * cosLat * sinLon;
            var z_ecef = R * sinLat;

            // Velocity ENU → ECEF
            var cosGamma = Math.cos(gamma);
            var sinGamma = Math.sin(gamma);
            var cosHdg = Math.cos(hdg);
            var sinHdg = Math.sin(hdg);

            var vE = V * cosGamma * sinHdg;
            var vN = V * cosGamma * cosHdg;
            var vU = V * sinGamma;

            var vx_ecef = -sinLon * vE + (-sinLat * cosLon) * vN + cosLat * cosLon * vU;
            var vy_ecef = cosLon * vE + (-sinLat * sinLon) * vN + cosLat * sinLon * vU;
            var vz_ecef = cosLat * vN + sinLat * vU;

            // ECEF → ECI (no ω×r — non-rotating frame, speed is already inertial)
            var cosG = Math.cos(gmst);
            var sinG = Math.sin(gmst);

            this._eciPos = [
                cosG * x_ecef - sinG * y_ecef,
                sinG * x_ecef + cosG * y_ecef,
                z_ecef
            ];
            this._eciVel = [
                cosG * vx_ecef - sinG * vy_ecef,
                sinG * vx_ecef + cosG * vy_ecef,
                vz_ecef
            ];
        }

        _computeOrbitalElements() {
            if (!this._eciPos || !this._eciVel) return;

            var pos = this._eciPos;
            var vel = this._eciVel;
            var rMag = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
            var vMag = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);

            if (rMag < 1000 || vMag < 0.1) {
                this._orbitalElements = null;
                return;
            }

            var energy = 0.5 * vMag * vMag - MU / rMag;
            var sma = -MU / (2 * energy);

            // Angular momentum
            var h = [
                pos[1] * vel[2] - pos[2] * vel[1],
                pos[2] * vel[0] - pos[0] * vel[2],
                pos[0] * vel[1] - pos[1] * vel[0]
            ];
            var hMag = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);

            // Eccentricity
            var rdotv = pos[0] * vel[0] + pos[1] * vel[1] + pos[2] * vel[2];
            var coeff1 = vMag * vMag - MU / rMag;
            var e_vec = [
                (coeff1 * pos[0] - rdotv * vel[0]) / MU,
                (coeff1 * pos[1] - rdotv * vel[1]) / MU,
                (coeff1 * pos[2] - rdotv * vel[2]) / MU
            ];
            var ecc = Math.sqrt(e_vec[0] * e_vec[0] + e_vec[1] * e_vec[1] + e_vec[2] * e_vec[2]);

            // Inclination
            var inc = hMag > 1e-6 ? Math.acos(Math.min(1, Math.max(-1, h[2] / hMag))) : 0;

            // Period
            var period = null;
            if (sma > 0 && ecc < 1.0) {
                period = TWO_PI * Math.sqrt(sma * sma * sma / MU);
            }

            this._orbitalElements = {
                sma: sma,
                eccentricity: ecc,
                inclination: inc,
                energy: energy,
                angularMomentum: hMag,
                periapsisAlt: sma > 0 ? sma * (1 - ecc) - R_EARTH : null,
                apoapsisAlt: sma > 0 ? sma * (1 + ecc) - R_EARTH : null,
                period: period
            };
        }
    }

    // Register component
    ComponentRegistry.register('physics', 'orbital_2body', Orbital2Body);
})();
