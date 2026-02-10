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
            this._ringEntities = [];
            // Cached parsed colors
            this._color = null;
            this._labelText = '';
            this._lastDetectionCount = -1;
            // Base appearance for cyber reset
            this._baseColor = null;
            this._baseOutlineColor = Cesium.Color.WHITE;
            this._basePixelSize = 12;
            this._baseSensorFill = null;
            this._baseSensorOutline = null;
            this._baseRingColors = [];    // { outlineColor, fillAlpha } per ring entity
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
            var labelText = typeof cfg.label === 'string' ? cfg.label :
                           cfg.label === true ? entity.name :
                           cfg.label !== undefined ? String(cfg.label) : DEFAULTS.label;
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
            this._baseColor = color.clone();
            this._baseOutlineColor = Cesium.Color.WHITE.clone();
            this._basePixelSize = pixelSize;
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
                    outlineWidth: 2
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
                    scale: 0.9
                }
            });
            this._pointEntity._ecsEntityId = entity.id;

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
                this._baseSensorFill = sensorFill.clone();
                this._baseSensorOutline = sensorOutline.clone();
            }

            // --- Weapon engagement zone rings (SAM batteries) ---
            var weaponsComp = entity.getComponent('weapons');
            if (weaponsComp) {
                var weaponConfig = weaponsComp.config || {};
                var maxRange = weaponConfig.maxRange_m || 150000;
                var minRange = weaponConfig.minRange_m || 5000;
                var optRange = 0.6 * maxRange;

                // Helper: format range as km string
                function fmtKm(meters) {
                    return Math.round(meters / 1000) + 'km';
                }

                // Helper: compute label position at north edge of ring
                function ringLabelPosition(baseLat, baseLon, baseAlt, range_m) {
                    var angularOffset = range_m / R_EARTH; // radians
                    return Cesium.Cartesian3.fromRadians(baseLon, baseLat + angularOffset, baseAlt);
                }

                // 1) Min Range Ring — yellow, thin outline, no fill
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Min Range',
                    position: position,
                    ellipse: {
                        semiMajorAxis: minRange,
                        semiMinorAxis: minRange,
                        material: Cesium.Color.TRANSPARENT,
                        outline: true,
                        outlineColor: Cesium.Color.YELLOW,
                        outlineWidth: 1,
                        height: 0,
                        granularity: Cesium.Math.toRadians(2)
                    }
                }));

                // Min range label
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Min Range Label',
                    position: ringLabelPosition(lat, lon, alt, minRange),
                    label: {
                        text: 'MIN ' + fmtKm(minRange),
                        font: '10px monospace',
                        fillColor: Cesium.Color.YELLOW,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        pixelOffset: new Cesium.Cartesian2(4, 0),
                        scale: 0.85
                    }
                }));

                // 2) Optimal Range Ring — green, very faint fill
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Opt Range',
                    position: position,
                    ellipse: {
                        semiMajorAxis: optRange,
                        semiMinorAxis: optRange,
                        material: Cesium.Color.fromCssColorString('#00ff44').withAlpha(0.03),
                        outline: true,
                        outlineColor: Cesium.Color.fromCssColorString('#00ff44'),
                        outlineWidth: 1,
                        height: 0,
                        granularity: Cesium.Math.toRadians(2)
                    }
                }));

                // Optimal range label
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Opt Range Label',
                    position: ringLabelPosition(lat, lon, alt, optRange),
                    label: {
                        text: 'OPT ' + fmtKm(optRange),
                        font: '10px monospace',
                        fillColor: Cesium.Color.fromCssColorString('#00ff44'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        pixelOffset: new Cesium.Cartesian2(4, 0),
                        scale: 0.85
                    }
                }));

                // 3) Max Range Ring — red, very faint fill
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Max Range',
                    position: position,
                    ellipse: {
                        semiMajorAxis: maxRange,
                        semiMinorAxis: maxRange,
                        material: Cesium.Color.RED.withAlpha(0.03),
                        outline: true,
                        outlineColor: Cesium.Color.RED,
                        outlineWidth: 1,
                        height: 0,
                        granularity: Cesium.Math.toRadians(2)
                    }
                }));

                // Max range label
                this._ringEntities.push(viewer.entities.add({
                    name: entity.name + ' Max Range Label',
                    position: ringLabelPosition(lat, lon, alt, maxRange),
                    label: {
                        text: 'MAX ' + fmtKm(maxRange),
                        font: '10px monospace',
                        fillColor: Cesium.Color.RED,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                        pixelOffset: new Cesium.Cartesian2(4, 0),
                        scale: 0.85
                    }
                }));

                // Cache ring base colors for cyber reset
                // Ring entities order: [minRing, minLabel, optRing, optLabel, maxRing, maxLabel]
                var ringOutlineColors = [
                    Cesium.Color.YELLOW.clone(),                         // min ring
                    null,                                                 // min label (no ellipse)
                    Cesium.Color.fromCssColorString('#00ff44').clone(),   // opt ring
                    null,                                                 // opt label
                    Cesium.Color.RED.clone(),                            // max ring
                    null                                                  // max label
                ];
                this._baseRingColors = ringOutlineColors;
            }
        }

        update(dt, world) {
            var state = this.entity.state;

            // Per-entity visibility controls
            var vizShow = state._vizShow !== false;
            if (this._pointEntity) this._pointEntity.show = vizShow;
            if (this._pointEntity && this._pointEntity.label) {
                this._pointEntity.label.show = vizShow && state._vizLabels !== false;
            }
            if (this._sensorEntity) this._sensorEntity.show = vizShow && state._vizSensors !== false;
            for (var r = 0; r < this._ringEntities.length; r++) {
                this._ringEntities[r].show = vizShow && state._vizSensors !== false;
            }

            // Check for radar detection count changes and update label.
            var detections = state._detections;
            var count = detections ? detections.length : 0;

            if (count !== this._lastDetectionCount) {
                this._lastDetectionCount = count;
                var baseLbl = typeof this.config.label === 'string' ? this.config.label :
                    this.config.label === true ? this.entity.name :
                    this.config.label !== undefined ? String(this.config.label) : DEFAULTS.label;
                if (count > 0) {
                    this._labelText = baseLbl + ' [' + count + ']';
                } else {
                    this._labelText = baseLbl;
                }
            }

            // --- Cyber status visual indicators ---
            var hasCyberState = state._cyberDenied || state._commBricked ||
                state._cyberControlled || state._cyberExploited || state._cyberScanning;
            var degradation = state._cyberDegradation || {};

            // (a) Point marker cyber visuals
            if (this._pointEntity && this._pointEntity.point) {
                var baseSize = this._basePixelSize;

                if (state._cyberDenied || state._commBricked) {
                    // Denied/bricked: dim point, gray color
                    this._pointEntity.point.pixelSize = Math.max(4, baseSize - 2);
                    this._pointEntity.point.color = Cesium.Color.GRAY;
                    this._pointEntity.point.outlineColor = Cesium.Color.DARKGRAY;
                    this._pointEntity.point.outlineWidth = 1;
                } else if (state._cyberControlled) {
                    // Controlled: red pulsing outline
                    var pulse = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
                    this._pointEntity.point.outlineColor = Cesium.Color.RED;
                    this._pointEntity.point.outlineWidth = 2 + pulse;
                    this._pointEntity.point.pixelSize = baseSize + pulse * 2;
                } else if (state._cyberExploited) {
                    // Exploited: magenta outline
                    this._pointEntity.point.outlineColor = Cesium.Color.fromCssColorString('#ff44ff');
                    this._pointEntity.point.outlineWidth = 2;
                } else if (state._cyberScanning) {
                    // Scanning: sinusoidal pixel size pulse
                    var scanPulse = Math.sin(Date.now() * 0.008) * 0.5 + 0.5;
                    this._pointEntity.point.pixelSize = baseSize + scanPulse * 4;
                    this._pointEntity.point.outlineColor = Cesium.Color.YELLOW;
                    this._pointEntity.point.outlineWidth = 1 + scanPulse;
                } else {
                    // (b) No cyber state: reset point to base appearance
                    this._pointEntity.point.pixelSize = baseSize;
                    if (this._baseColor) {
                        this._pointEntity.point.color = this._baseColor;
                    }
                    this._pointEntity.point.outlineColor = this._baseOutlineColor;
                    this._pointEntity.point.outlineWidth = 2;
                }
            }

            // (c) Sensor ellipse cyber response
            if (this._sensorEntity && this._sensorEntity.ellipse) {
                if (state._sensorDisabled) {
                    // Sensors fully disabled: hide sensor coverage
                    this._sensorEntity.show = false;
                } else if (degradation.sensors > 0.3) {
                    // Sensor degradation > 30%: dim the ellipse proportionally
                    this._sensorEntity.show = vizShow && state._vizSensors !== false;
                    var sensorDeg = Math.min(degradation.sensors, 1.0);
                    if (this._baseSensorFill) {
                        var dimmedAlpha = this._baseSensorFill.alpha * (1.0 - sensorDeg * 0.8);
                        this._sensorEntity.ellipse.material = this._baseSensorFill.withAlpha(dimmedAlpha);
                    }
                    if (this._baseSensorOutline) {
                        var outAlpha = this._baseSensorOutline.alpha * (1.0 - sensorDeg * 0.7);
                        this._sensorEntity.ellipse.outlineColor = this._baseSensorOutline.withAlpha(Math.max(0.1, outAlpha));
                    }
                } else if (!hasCyberState && (degradation.sensors === undefined || degradation.sensors === 0)) {
                    // No degradation: restore original appearance
                    this._sensorEntity.show = vizShow && state._vizSensors !== false;
                    if (this._baseSensorFill) {
                        this._sensorEntity.ellipse.material = this._baseSensorFill;
                    }
                    if (this._baseSensorOutline) {
                        this._sensorEntity.ellipse.outlineColor = this._baseSensorOutline;
                    }
                }
            }

            // (d) Weapon ring cyber response
            if (this._ringEntities.length > 0) {
                if (state._weaponsDisabled) {
                    // Weapons fully disabled: hide all ring entities
                    for (var w = 0; w < this._ringEntities.length; w++) {
                        this._ringEntities[w].show = false;
                    }
                } else if (degradation.weapons > 0) {
                    // Weapon degradation: dim ring outlines proportionally
                    var weapDeg = Math.min(degradation.weapons, 1.0);
                    for (var w2 = 0; w2 < this._ringEntities.length; w2++) {
                        this._ringEntities[w2].show = vizShow && state._vizSensors !== false;
                        var ringEnt = this._ringEntities[w2];
                        if (ringEnt.ellipse && this._baseRingColors[w2]) {
                            var baseRC = this._baseRingColors[w2];
                            var dimAlpha = Math.max(0.15, 1.0 - weapDeg * 0.8);
                            ringEnt.ellipse.outlineColor = baseRC.withAlpha(dimAlpha);
                        }
                    }
                } else if (!hasCyberState) {
                    // No degradation: restore ring visibility and colors
                    for (var w3 = 0; w3 < this._ringEntities.length; w3++) {
                        this._ringEntities[w3].show = vizShow && state._vizSensors !== false;
                        var ringEnt2 = this._ringEntities[w3];
                        if (ringEnt2.ellipse && this._baseRingColors[w3]) {
                            ringEnt2.ellipse.outlineColor = this._baseRingColors[w3];
                        }
                    }
                }
            }
        }

        cleanup(world) {
            if (world.viewer) {
                if (this._pointEntity) world.viewer.entities.remove(this._pointEntity);
                if (this._sensorEntity) world.viewer.entities.remove(this._sensorEntity);
                for (var i = 0; i < this._ringEntities.length; i++) {
                    world.viewer.entities.remove(this._ringEntities[i]);
                }
            }
            this._pointEntity = null;
            this._sensorEntity = null;
            this._ringEntities = [];
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'ground_station', GroundStationVisual);
})();
