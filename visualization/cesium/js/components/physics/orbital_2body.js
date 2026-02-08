/**
 * Orbital2Body — Keplerian 2-body orbital propagation physics component.
 *
 * Propagates satellites using analytical Kepler equation solving.
 * Supports initialization from:
 *   - TLE data (source: 'tle', tle_line1, tle_line2)
 *   - Geodetic state (source: 'state', uses entity lat/lon/alt/speed/heading/gamma)
 *   - Classical elements (source: 'elements', sma, ecc, inc, raan, argPerigee, meanAnomaly)
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
                this._initFromState(state, simTime);
            }

            // Compute initial orbital elements
            this._computeOrbitalElements();

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

            // Analytical Kepler propagation
            var result = TLEParser.propagateKepler(this._eciPos, this._eciVel, propagateDt);
            this._eciPos = result.pos;
            this._eciVel = result.vel;

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
        // Initialization methods
        // ---------------------------------------------------------------

        _initFromTLE(state, cfg, simTime) {
            var sat = TLEParser.parseTLE(this.entity.name, cfg.tle_line1, cfg.tle_line2);
            if (!sat) {
                console.warn('[Orbital2Body] Failed to parse TLE for ' + this.entity.id);
                this._initFromState(state, simTime);
                return;
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
            var sma = cfg.sma || (R_EARTH + (state.alt || 400000));
            var ecc = cfg.eccentricity != null ? cfg.eccentricity : 0.001;
            var n_rad = Math.sqrt(MU / (sma * sma * sma));
            var meanMotion = n_rad * 86400 / TWO_PI;

            var synthSat = {
                sma: sma,
                eccentricity: ecc,
                inclination: cfg.inclination != null ? cfg.inclination : 51.6,
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
