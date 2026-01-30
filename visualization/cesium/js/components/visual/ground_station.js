/**
 * GroundStationVisual -- Cesium visualization for ground station entities.
 *
 * Renders:
 *   - Fixed point marker at station geodetic position
 *   - Label with station name (and detection count if radar detections exist)
 *   - Optional sensor coverage ellipse on the globe surface
 *
 * Reads from entity.state:
 *   lat, lon           -- geodetic position in radians
 *   alt                -- altitude in meters (typically 0 for ground)
 *   _detections        -- (optional) array set by radar component; label shows count
 *
 * Config:
 *   type: "ground_station"
 *   color: '#00ff88'              -- point + label color (CSS color string)
 *   pixelSize: 12                 -- point marker size
 *   label: 'GND'                  -- label text
 *   showSensorCone: true          -- whether to draw sensor coverage ellipse
 *   sensorRange_m: 150000         -- semi-axis of coverage ellipse (meters)
 *   sensorColor: 'rgba(0,255,136,0.08)'  -- translucent fill for sensor area
 *   sensorOutlineColor: '#00ff88'         -- outline of sensor ellipse
 *
 * Registered as: visual / ground_station
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Default configuration values
    var DEFAULTS = {
        color: '#00ff88',
        pixelSize: 12,
        label: 'GND',
        showSensorCone: true,
        sensorRange_m: 150000,
        sensorColor: 'rgba(0,255,136,0.08)',
        sensorOutlineColor: '#00ff88'
    };

    class GroundStationVisual extends ECS.Component {
        constructor(config) {
            super(config);
            // Cesium entity references
            this._pointEntity = null;
            this._sensorEntity = null;
            // Cached parsed colors
            this._color = null;
            this._labelText = '';
            this._lastDetectionCount = -1;
        }

        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var entity = this.entity;
            var state = entity.state;
            var cfg = this.config;

            // Resolve config with defaults
            var colorStr = cfg.color || DEFAULTS.color;
            var pixelSize = cfg.pixelSize !== undefined ? cfg.pixelSize : DEFAULTS.pixelSize;
            var labelText = cfg.label !== undefined ? cfg.label : DEFAULTS.label;
            var showSensorCone = cfg.showSensorCone !== undefined ? cfg.showSensorCone : DEFAULTS.showSensorCone;
            var sensorRange = cfg.sensorRange_m !== undefined ? cfg.sensorRange_m : DEFAULTS.sensorRange_m;
            var sensorColorStr = cfg.sensorColor || DEFAULTS.sensorColor;
            var sensorOutlineStr = cfg.sensorOutlineColor || DEFAULTS.sensorOutlineColor;

            // Parse colors
            var color;
            try {
                color = Cesium.Color.fromCssColorString(colorStr);
            } catch (e) {
                color = Cesium.Color.fromCssColorString(DEFAULTS.color);
            }
            this._color = color;
            this._labelText = labelText;

            // Ground station position (fixed)
            var lat = state.lat || 0;
            var lon = state.lon || 0;
            var alt = state.alt || 0;
            var position = Cesium.Cartesian3.fromRadians(lon, lat, alt);

            // --- Point marker + label ---
            var self = this;
            this._pointEntity = viewer.entities.add({
                name: entity.name,
                position: position,
                point: {
                    pixelSize: pixelSize,
                    color: color,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: new Cesium.CallbackProperty(function() {
                        return self._labelText;
                    }, false),
                    font: '12px monospace',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -14),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    scale: 0.9
                }
            });

            // --- Sensor coverage ellipse ---
            if (showSensorCone) {
                var sensorFill;
                try {
                    sensorFill = Cesium.Color.fromCssColorString(sensorColorStr);
                } catch (e) {
                    sensorFill = Cesium.Color.fromCssColorString(DEFAULTS.sensorColor);
                }

                var sensorOutline;
                try {
                    sensorOutline = Cesium.Color.fromCssColorString(sensorOutlineStr);
                } catch (e) {
                    sensorOutline = Cesium.Color.fromCssColorString(DEFAULTS.sensorOutlineColor);
                }

                this._sensorEntity = viewer.entities.add({
                    name: entity.name + ' Sensor',
                    position: position,
                    ellipse: {
                        semiMajorAxis: sensorRange,
                        semiMinorAxis: sensorRange,
                        material: sensorFill,
                        outline: true,
                        outlineColor: sensorOutline,
                        outlineWidth: 1,
                        height: 0,
                        granularity: Cesium.Math.toRadians(2)
                    }
                });
            }
        }

        update(dt, world) {
            // Ground station is fixed -- no position update needed.
            // Check for radar detection count changes and update label.
            var state = this.entity.state;
            var detections = state._detections;
            var count = detections ? detections.length : 0;

            if (count !== this._lastDetectionCount) {
                this._lastDetectionCount = count;
                var baseLbl = this.config.label !== undefined ? this.config.label : DEFAULTS.label;
                if (count > 0) {
                    this._labelText = baseLbl + ' [' + count + ']';
                } else {
                    this._labelText = baseLbl;
                }
            }
        }

        cleanup(world) {
            if (world.viewer) {
                if (this._pointEntity) world.viewer.entities.remove(this._pointEntity);
                if (this._sensorEntity) world.viewer.entities.remove(this._sensorEntity);
            }
            this._pointEntity = null;
            this._sensorEntity = null;
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'ground_station', GroundStationVisual);
})();
