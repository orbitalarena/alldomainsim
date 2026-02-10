/**
 * StaticGround — minimal physics component for stationary ground entities.
 *
 * Holds position (lat/lon/alt) without any aerodynamics or orbital mechanics.
 * Provides ECI position for Cesium rendering and sensor/comm systems.
 * Allows ground entities (cyber ops centers, command posts, etc.) to pass
 * all physics gate checks and be controllable in the live sim viewer.
 *
 * Config:
 *   type: 'static_ground'
 *
 * Registers as: physics / static_ground
 */
(function() {
    'use strict';

    var R_EARTH = 6371000;
    var OMEGA_EARTH = 7.2921159e-5;

    class StaticGround extends ECS.Component {
        constructor(config) {
            super(config);
            this._eciPos = null;
            this._eciVel = null;
        }

        init(world) {
            var s = this.entity.state;
            // Ensure basic state fields
            if (s.speed === undefined) s.speed = 0;
            if (s.heading === undefined) s.heading = 0;
            if (s.gamma === undefined) s.gamma = 0;
            if (s.phase === undefined) s.phase = 'STATIC';
            if (s.engineOn === undefined) s.engineOn = false;
            if (s.throttle === undefined) s.throttle = 0;
            if (s.groundAlt === undefined) s.groundAlt = s.alt || 0;
            // Compute initial ECI
            this._updateECI(world.simTime || 0);
        }

        update(dt, world) {
            // Static — no position change, just update ECI for rotating Earth
            this._updateECI(world.simTime || 0);
        }

        _updateECI(simTime) {
            var s = this.entity.state;
            var lat = s.lat || 0;
            var lon = s.lon || 0;
            var alt = s.alt || 0;
            var R = R_EARTH + alt;
            var gmst = OMEGA_EARTH * simTime;
            var lonEci = lon + gmst;
            var cosLat = Math.cos(lat);
            var sinLat = Math.sin(lat);
            var cosLon = Math.cos(lonEci);
            var sinLon = Math.sin(lonEci);

            this._eciPos = {
                x: R * cosLat * cosLon,
                y: R * cosLat * sinLon,
                z: R * sinLat
            };
            // Surface velocity from Earth rotation
            var vRot = OMEGA_EARTH * R * cosLat;
            this._eciVel = {
                x: -vRot * sinLon,
                y:  vRot * cosLon,
                z: 0
            };
        }
    }

    ComponentRegistry.register('physics', 'static_ground', StaticGround);
})();
