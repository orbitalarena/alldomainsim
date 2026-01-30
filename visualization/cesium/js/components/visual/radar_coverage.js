/**
 * RadarCoverageVisual -- Cesium visualization for radar coverage area.
 *
 * Renders:
 *   - Coverage area ellipse (omnidirectional) or sector polygon (directional)
 *   - Optional animated scan line rotating around the entity center
 *
 * Reads from entity.state:
 *   lat, lon              -- geodetic position in radians
 *   alt                   -- altitude in meters (typically 0 for ground)
 *   _radarScanAz          -- (optional) current scan azimuth in radians,
 *                            set by a radar system; drives scan line rotation
 *
 * Config:
 *   type: "radar_coverage"
 *   range_m: 150000                   -- coverage radius in meters
 *   fillColor: 'rgba(255,50,50,0.06)' -- translucent fill
 *   outlineColor: '#ff4444'           -- outline color
 *   outlineWidth: 1                   -- outline width
 *   sectors: 1                        -- number of sectors (1 = omni circle)
 *   fov_deg: 360                      -- field of view in degrees
 *   showScanLine: true                -- animated scan line
 *
 * Registered as: visual / radar_coverage
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Default configuration values
    var DEFAULTS = {
        range_m: 150000,
        fillColor: 'rgba(255,50,50,0.06)',
        outlineColor: '#ff4444',
        outlineWidth: 1,
        sectors: 1,
        fov_deg: 360,
        showScanLine: true
    };

    /**
     * Compute a destination point on the globe given a start lat/lon (radians),
     * bearing (radians from north), and surface distance (meters).
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
     * centerLat/centerLon in radians, startBearing/endBearing in radians (from north CW),
     * range in meters, numSegments arc points.
     */
    function buildSectorPositions(centerLat, centerLon, startBearing, endBearing, range_m, numSegments) {
        var positions = [];
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

    class RadarCoverageVisual extends ECS.Component {
        constructor(config) {
            super(config);
            // Cesium entity references
            this._coverageEntity = null;
            this._scanLineEntity = null;
            // Scan line state
            this._scanPositions = [];
            this._lastScanAz = null;
        }

        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var entity = this.entity;
            var state = entity.state;
            var cfg = this.config;

            // Resolve config with defaults
            var range_m = cfg.range_m !== undefined ? cfg.range_m : DEFAULTS.range_m;
            var fillColorStr = cfg.fillColor || DEFAULTS.fillColor;
            var outlineColorStr = cfg.outlineColor || DEFAULTS.outlineColor;
            var outlineWidth = cfg.outlineWidth !== undefined ? cfg.outlineWidth : DEFAULTS.outlineWidth;
            var fov_deg = cfg.fov_deg !== undefined ? cfg.fov_deg : DEFAULTS.fov_deg;
            var showScanLine = cfg.showScanLine !== undefined ? cfg.showScanLine : DEFAULTS.showScanLine;

            // Parse colors
            var fillColor;
            try {
                fillColor = Cesium.Color.fromCssColorString(fillColorStr);
            } catch (e) {
                fillColor = Cesium.Color.fromCssColorString(DEFAULTS.fillColor);
            }

            var outlineColor;
            try {
                outlineColor = Cesium.Color.fromCssColorString(outlineColorStr);
            } catch (e) {
                outlineColor = Cesium.Color.fromCssColorString(DEFAULTS.outlineColor);
            }

            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var position = Cesium.Cartesian3.fromRadians(lon, lat, 0);

            // --- Coverage area ---
            if (fov_deg >= 360) {
                // Omnidirectional: full circle ellipse
                this._coverageEntity = viewer.entities.add({
                    name: entity.name + ' Radar',
                    position: position,
                    ellipse: {
                        semiMajorAxis: range_m,
                        semiMinorAxis: range_m,
                        material: fillColor,
                        outline: true,
                        outlineColor: outlineColor,
                        outlineWidth: outlineWidth,
                        height: 0,
                        granularity: Cesium.Math.toRadians(2)
                    }
                });
            } else {
                // Directional: sector polygon
                // Center the FOV on north (bearing 0); entity heading can shift this
                var halfFov = (fov_deg * DEG) / 2;
                var startBearing = -halfFov;
                var endBearing = halfFov;
                var sectorPositions = buildSectorPositions(lat, lon, startBearing, endBearing, range_m, 48);

                this._coverageEntity = viewer.entities.add({
                    name: entity.name + ' Radar',
                    polygon: {
                        hierarchy: new Cesium.PolygonHierarchy(sectorPositions),
                        material: fillColor,
                        outline: true,
                        outlineColor: outlineColor,
                        outlineWidth: outlineWidth,
                        height: 0
                    }
                });
            }

            // --- Scan line ---
            if (showScanLine) {
                var self = this;
                // Initial scan line pointing north
                var initDest = destinationPoint(lat, lon, 0, range_m);
                this._scanPositions = [
                    Cesium.Cartesian3.fromRadians(lon, lat, 100),
                    Cesium.Cartesian3.fromRadians(initDest.lon, initDest.lat, 100)
                ];

                var scanColor;
                try {
                    scanColor = outlineColor.withAlpha(0.6);
                } catch (e) {
                    scanColor = Cesium.Color.RED.withAlpha(0.6);
                }

                this._scanLineEntity = viewer.entities.add({
                    name: entity.name + ' Scan',
                    polyline: {
                        positions: new Cesium.CallbackProperty(function() {
                            return self._scanPositions;
                        }, false),
                        width: 1.5,
                        material: scanColor
                    }
                });
            }
        }

        update(dt, world) {
            var state = this.entity.state;
            var cfg = this.config;
            var showScanLine = cfg.showScanLine !== undefined ? cfg.showScanLine : DEFAULTS.showScanLine;

            if (!showScanLine || !this._scanLineEntity) return;

            // Update scan line azimuth from entity state (set by radar system)
            var scanAz = state._radarScanAz;
            if (scanAz === undefined || scanAz === null) return;
            if (scanAz === this._lastScanAz) return;

            this._lastScanAz = scanAz;

            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var range_m = cfg.range_m !== undefined ? cfg.range_m : DEFAULTS.range_m;

            var dest = destinationPoint(lat, lon, scanAz, range_m);
            this._scanPositions = [
                Cesium.Cartesian3.fromRadians(lon, lat, 100),
                Cesium.Cartesian3.fromRadians(dest.lon, dest.lat, 100)
            ];
        }

        cleanup(world) {
            if (world.viewer) {
                if (this._coverageEntity) world.viewer.entities.remove(this._coverageEntity);
                if (this._scanLineEntity) world.viewer.entities.remove(this._scanLineEntity);
            }
            this._coverageEntity = null;
            this._scanLineEntity = null;
            this._scanPositions = [];
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'radar_coverage', RadarCoverageVisual);
})();
