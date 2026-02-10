/**
 * SensorFootprintVisual — Renders sensor collection volumes as Cesium primitives.
 * Registered as 'visual/sensor_footprint'.
 *
 * Supports: radar (sector), optical/ir (ground ellipse), sar (swath rect),
 *           sigint (range ring), lidar (small cone).
 *
 * Config: { sensors: { radar: {enabled, maxRange_m, fov_deg}, optical: {enabled, fov_deg}, ... } }
 * Or reads from entity._custom.sensors / entity.getComponent('sensors').
 *
 * Visibility controlled by entity.state._vizSensors (from per-entity viz controls).
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Update throttle: every 30 frames (~2Hz at 60fps)
    var UPDATE_EVERY = 30;

    // Default sensor configurations (used when sensor is enabled but missing fields)
    var SENSOR_DEFAULTS = {
        radar:   { maxRange_m: 150000, fov_deg: 120 },
        optical: { maxRange_m: 50000,  fov_deg: 15 },
        ir:      { maxRange_m: 40000,  fov_deg: 20 },
        sar:     { maxRange_m: 100000, fov_deg: 30, swath_km: 40 },
        sigint:  { maxRange_m: 300000 },
        lidar:   { maxRange_m: 10000,  fov_deg: 5 }
    };

    // Colors per sensor type
    var SENSOR_COLORS = {
        radar:   'rgba(255,80,80,0.12)',
        optical: 'rgba(0,255,0,0.10)',
        ir:      'rgba(255,160,0,0.10)',
        sar:     'rgba(0,200,255,0.10)',
        sigint:  'rgba(180,0,255,0.08)',
        lidar:   'rgba(0,255,255,0.12)'
    };

    /**
     * Compute a destination point on the globe given a start lat/lon (radians),
     * bearing (radians from north CW), and surface distance (meters).
     * Returns { lat, lon } in radians.
     */
    function destinationPoint(latRad, lonRad, bearing, distance_m) {
        var angDist = distance_m / R_EARTH;
        var sinLat = Math.sin(latRad);
        var cosLat = Math.cos(latRad);
        var sinAng = Math.sin(angDist);
        var cosAng = Math.cos(angDist);

        var lat2 = Math.asin(sinLat * cosAng + cosLat * sinAng * Math.cos(bearing));
        var lon2 = lonRad + Math.atan2(
            Math.sin(bearing) * sinAng * cosLat,
            cosAng - sinLat * Math.sin(lat2)
        );
        return { lat: lat2, lon: lon2 };
    }

    /**
     * Build a sector polygon (pie slice) as an array of Cartesian3.
     * centerLat/centerLon in radians, heading in radians (from north CW),
     * fov_deg in degrees, range in meters.
     */
    function buildSectorPositions(centerLat, centerLon, heading, fov_deg, range_m) {
        var positions = [];
        var halfFov = (fov_deg * DEG) / 2;
        var startBearing = heading - halfFov;
        var endBearing = heading + halfFov;
        var numSegments = Math.max(12, Math.round(fov_deg / 3));

        // Center point
        positions.push(Cesium.Cartesian3.fromRadians(centerLon, centerLat, 0));

        // Arc from startBearing to endBearing
        var step = (endBearing - startBearing) / numSegments;
        for (var i = 0; i <= numSegments; i++) {
            var az = startBearing + step * i;
            var dest = destinationPoint(centerLat, centerLon, az, range_m);
            positions.push(Cesium.Cartesian3.fromRadians(dest.lon, dest.lat, 0));
        }

        // Close back to center
        positions.push(Cesium.Cartesian3.fromRadians(centerLon, centerLat, 0));
        return positions;
    }

    /**
     * Build a rectangular swath polygon along heading direction.
     * centerLat/centerLon in radians, heading in radians,
     * swath_km = cross-track width, length = along-track (2x swath ahead).
     */
    function buildSwathPositions(centerLat, centerLon, heading, swath_km) {
        var halfWidth = (swath_km * 1000) / 2;   // meters
        var length = swath_km * 2000;              // 2x swath ahead, meters

        // Four corners relative to entity position:
        // Forward-left, forward-right, aft-right, aft-left
        var leftBearing = heading - Math.PI / 2;
        var rightBearing = heading + Math.PI / 2;

        // Forward corners
        var fwd = destinationPoint(centerLat, centerLon, heading, length);
        var fwdL = destinationPoint(fwd.lat, fwd.lon, leftBearing, halfWidth);
        var fwdR = destinationPoint(fwd.lat, fwd.lon, rightBearing, halfWidth);

        // Aft corners (at entity position)
        var aftL = destinationPoint(centerLat, centerLon, leftBearing, halfWidth);
        var aftR = destinationPoint(centerLat, centerLon, rightBearing, halfWidth);

        return [
            Cesium.Cartesian3.fromRadians(aftL.lon, aftL.lat, 0),
            Cesium.Cartesian3.fromRadians(fwdL.lon, fwdL.lat, 0),
            Cesium.Cartesian3.fromRadians(fwdR.lon, fwdR.lat, 0),
            Cesium.Cartesian3.fromRadians(aftR.lon, aftR.lat, 0)
        ];
    }

    /**
     * Resolve sensor definitions from various sources on the entity.
     * Returns an object: { radar: {...}, optical: {...}, ... } with only enabled sensors.
     */
    function resolveSensors(entity, config) {
        var sensors = {};

        // Source 1: explicit config.sensors
        if (config.sensors) {
            var cfgSensors = config.sensors;
            for (var type in cfgSensors) {
                if (cfgSensors.hasOwnProperty(type) && cfgSensors[type] && cfgSensors[type].enabled !== false) {
                    sensors[type] = Object.assign({}, SENSOR_DEFAULTS[type] || {}, cfgSensors[type]);
                }
            }
            return sensors;
        }

        // Source 2: entity._custom.sensors (from Platform Builder)
        if (entity._custom && entity._custom.sensors) {
            var customSensors = entity._custom.sensors;
            for (var type2 in customSensors) {
                if (customSensors.hasOwnProperty(type2) && customSensors[type2] && customSensors[type2].enabled !== false) {
                    sensors[type2] = Object.assign({}, SENSOR_DEFAULTS[type2] || {}, customSensors[type2]);
                }
            }
            if (Object.keys(sensors).length > 0) return sensors;
        }

        // Source 3: entity sensor component
        var sensorComp = entity.getComponent('sensors');
        if (sensorComp) {
            var sensorCfg = sensorComp.config || {};
            // The sensor component may be a single radar sensor or have a type field
            var sType = sensorCfg.type || 'radar';
            sensors[sType] = Object.assign({}, SENSOR_DEFAULTS[sType] || {}, {
                maxRange_m: sensorCfg.maxRange_m || sensorCfg.range_m,
                fov_deg: sensorCfg.fov_deg
            });
        }

        return sensors;
    }

    // -----------------------------------------------------------------------
    // SensorFootprintVisual Component
    // -----------------------------------------------------------------------
    class SensorFootprintVisual extends ECS.Component {
        constructor(config) {
            super(config);
            this._footprints = [];      // { type, cesiumEntity, sensorDef }
            this._frameCounter = 0;
            this._updateOffset = Math.floor(Math.random() * UPDATE_EVERY); // stagger updates
            this._sensors = null;       // resolved sensor definitions
            this._lastLat = null;
            this._lastLon = null;
            this._lastHeading = null;
            this._lastAlt = null;
        }

        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var entity = this.entity;
            var state = entity.state;
            var cfg = this.config;

            // Resolve which sensors this entity has
            this._sensors = resolveSensors(entity, cfg);

            if (Object.keys(this._sensors).length === 0) return;

            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var alt = state.alt || 0;
            var heading = state.heading || 0;

            this._lastLat = lat;
            this._lastLon = lon;
            this._lastHeading = heading;
            this._lastAlt = alt;

            // Create footprint primitives for each sensor
            for (var sType in this._sensors) {
                if (!this._sensors.hasOwnProperty(sType)) continue;
                var sDef = this._sensors[sType];
                var footprint = this._createFootprint(viewer, entity, sType, sDef, lat, lon, alt, heading);
                if (footprint) {
                    this._footprints.push(footprint);
                }
            }
        }

        /**
         * Create a Cesium entity for a specific sensor type.
         * Returns { type, cesiumEntity, sensorDef } or null.
         */
        _createFootprint(viewer, entity, sType, sDef, lat, lon, alt, heading) {
            var color;
            try {
                color = Cesium.Color.fromCssColorString(SENSOR_COLORS[sType] || 'rgba(255,255,255,0.10)');
            } catch (e) {
                color = Cesium.Color.WHITE.withAlpha(0.1);
            }

            var outlineColor = color.withAlpha(Math.min(color.alpha * 4, 0.5));
            var cesiumEntity = null;
            var self = this;

            switch (sType) {
                case 'radar': {
                    // Sector polygon on ground centered on heading
                    var range_m = sDef.maxRange_m || SENSOR_DEFAULTS.radar.maxRange_m;
                    var fov_deg = sDef.fov_deg || SENSOR_DEFAULTS.radar.fov_deg;
                    var positions = buildSectorPositions(lat, lon, heading, fov_deg, range_m);

                    cesiumEntity = viewer.entities.add({
                        name: entity.name + ' Radar Footprint',
                        polygon: {
                            hierarchy: new Cesium.CallbackProperty(function() {
                                var fp = self._getFootprintByType('radar');
                                return fp ? fp._hierarchy : new Cesium.PolygonHierarchy(positions);
                            }, false),
                            material: color,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0
                        }
                    });

                    // Store the hierarchy for callback updates
                    var record = { type: sType, cesiumEntity: cesiumEntity, sensorDef: sDef };
                    record._hierarchy = new Cesium.PolygonHierarchy(positions);
                    return record;
                }

                case 'optical':
                case 'ir': {
                    // Ellipse at sub-satellite/sub-aircraft point
                    // Radius = alt * tan(fov/2)
                    var fovDeg = sDef.fov_deg || SENSOR_DEFAULTS[sType].fov_deg;
                    var halfFovRad = (fovDeg / 2) * DEG;
                    var radius = Math.max(100, alt * Math.tan(halfFovRad));

                    cesiumEntity = viewer.entities.add({
                        name: entity.name + ' ' + sType.toUpperCase() + ' Footprint',
                        position: new Cesium.CallbackProperty(function() {
                            // Sub-satellite point at ground level
                            var st = self.entity.state;
                            return Cesium.Cartesian3.fromRadians(st.lon || 0, st.lat || 0, 0);
                        }, false),
                        ellipse: {
                            semiMajorAxis: new Cesium.CallbackProperty(function() {
                                var st = self.entity.state;
                                var a = st.alt || 1000;
                                return Math.max(100, a * Math.tan(halfFovRad));
                            }, false),
                            semiMinorAxis: new Cesium.CallbackProperty(function() {
                                var st = self.entity.state;
                                var a = st.alt || 1000;
                                return Math.max(100, a * Math.tan(halfFovRad));
                            }, false),
                            material: color,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0,
                            granularity: Cesium.Math.toRadians(3)
                        }
                    });

                    return { type: sType, cesiumEntity: cesiumEntity, sensorDef: sDef };
                }

                case 'sar': {
                    // Rectangular swath polygon along heading
                    var swath_km = sDef.swath_km || SENSOR_DEFAULTS.sar.swath_km;
                    var swathPositions = buildSwathPositions(lat, lon, heading, swath_km);

                    cesiumEntity = viewer.entities.add({
                        name: entity.name + ' SAR Swath',
                        polygon: {
                            hierarchy: new Cesium.CallbackProperty(function() {
                                var fp = self._getFootprintByType('sar');
                                return fp ? fp._hierarchy : new Cesium.PolygonHierarchy(swathPositions);
                            }, false),
                            material: color,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0
                        }
                    });

                    var sarRecord = { type: sType, cesiumEntity: cesiumEntity, sensorDef: sDef };
                    sarRecord._hierarchy = new Cesium.PolygonHierarchy(swathPositions);
                    return sarRecord;
                }

                case 'sigint': {
                    // Circular range ring
                    var sigintRange = sDef.maxRange_m || SENSOR_DEFAULTS.sigint.maxRange_m;

                    cesiumEntity = viewer.entities.add({
                        name: entity.name + ' SIGINT Range',
                        position: new Cesium.CallbackProperty(function() {
                            var st = self.entity.state;
                            return Cesium.Cartesian3.fromRadians(st.lon || 0, st.lat || 0, 0);
                        }, false),
                        ellipse: {
                            semiMajorAxis: sigintRange,
                            semiMinorAxis: sigintRange,
                            material: color,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0,
                            granularity: Cesium.Math.toRadians(3)
                        }
                    });

                    return { type: sType, cesiumEntity: cesiumEntity, sensorDef: sDef };
                }

                case 'lidar': {
                    // Small ellipse: radius = min(maxRange, alt * tan(fov/2))
                    var lidarRange = sDef.maxRange_m || SENSOR_DEFAULTS.lidar.maxRange_m;
                    var lidarFov = sDef.fov_deg || SENSOR_DEFAULTS.lidar.fov_deg;
                    var lidarHalfFov = (lidarFov / 2) * DEG;

                    cesiumEntity = viewer.entities.add({
                        name: entity.name + ' LIDAR Footprint',
                        position: new Cesium.CallbackProperty(function() {
                            var st = self.entity.state;
                            return Cesium.Cartesian3.fromRadians(st.lon || 0, st.lat || 0, 0);
                        }, false),
                        ellipse: {
                            semiMajorAxis: new Cesium.CallbackProperty(function() {
                                var st = self.entity.state;
                                var a = st.alt || 1000;
                                return Math.max(50, Math.min(lidarRange, a * Math.tan(lidarHalfFov)));
                            }, false),
                            semiMinorAxis: new Cesium.CallbackProperty(function() {
                                var st = self.entity.state;
                                var a = st.alt || 1000;
                                return Math.max(50, Math.min(lidarRange, a * Math.tan(lidarHalfFov)));
                            }, false),
                            material: color,
                            outline: true,
                            outlineColor: outlineColor,
                            outlineWidth: 1,
                            height: 0,
                            granularity: Cesium.Math.toRadians(5)
                        }
                    });

                    return { type: sType, cesiumEntity: cesiumEntity, sensorDef: sDef };
                }

                default:
                    return null;
            }
        }

        /**
         * Find a footprint record by sensor type.
         */
        _getFootprintByType(type) {
            for (var i = 0; i < this._footprints.length; i++) {
                if (this._footprints[i].type === type) return this._footprints[i];
            }
            return null;
        }

        update(dt, world) {
            if (this._footprints.length === 0) return;

            this._frameCounter++;

            // Throttle to ~2Hz (every 30 frames at 60fps)
            if ((this._frameCounter + this._updateOffset) % UPDATE_EVERY !== 0) return;

            var entity = this.entity;
            var state = entity.state;

            // Check visibility toggles (both entity show and sensor show)
            var visible = state._vizShow !== false && state._vizSensors !== false;

            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var alt = state.alt || 0;
            var heading = state.heading || 0;

            // Update show state and positions for polygon-based footprints
            for (var i = 0; i < this._footprints.length; i++) {
                var fp = this._footprints[i];
                var ce = fp.cesiumEntity;

                // Toggle visibility
                if (ce.show !== visible) {
                    ce.show = visible;
                }

                if (!visible) continue;

                // For polygon-based sensors (radar, sar), recompute vertices
                // when the entity has moved or changed heading
                if (fp.type === 'radar' || fp.type === 'sar') {
                    var moved = (lat !== this._lastLat || lon !== this._lastLon ||
                                 heading !== this._lastHeading);
                    if (moved) {
                        if (fp.type === 'radar') {
                            var range_m = fp.sensorDef.maxRange_m || SENSOR_DEFAULTS.radar.maxRange_m;
                            var fov_deg = fp.sensorDef.fov_deg || SENSOR_DEFAULTS.radar.fov_deg;
                            var newPositions = buildSectorPositions(lat, lon, heading, fov_deg, range_m);
                            fp._hierarchy = new Cesium.PolygonHierarchy(newPositions);
                        } else if (fp.type === 'sar') {
                            var swath_km = fp.sensorDef.swath_km || SENSOR_DEFAULTS.sar.swath_km;
                            var newSwathPositions = buildSwathPositions(lat, lon, heading, swath_km);
                            fp._hierarchy = new Cesium.PolygonHierarchy(newSwathPositions);
                        }
                    }
                }
                // Ellipse-based sensors (optical, ir, sigint, lidar) use CallbackProperty
                // for position and radius — they auto-update from entity.state
            }

            // Cache last state for movement detection
            this._lastLat = lat;
            this._lastLon = lon;
            this._lastHeading = heading;
            this._lastAlt = alt;
        }

        cleanup(world) {
            if (world.viewer) {
                for (var i = 0; i < this._footprints.length; i++) {
                    var ce = this._footprints[i].cesiumEntity;
                    if (ce) world.viewer.entities.remove(ce);
                }
            }
            this._footprints = [];
            this._sensors = null;
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'sensor_footprint', SensorFootprintVisual);
})();
