/**
 * CesiumEntity component — renders an entity on the Cesium globe.
 *
 * Supports:
 *   - Point marker with configurable color/size
 *   - Position trail (polyline)
 *   - Label
 *   - Camera tracking (delegates to PlayerInput.updateCamera for player entity)
 *
 * Uses Cesium CallbackProperty for zero-allocation position updates (no
 * entity.position = ... per frame, just returns current state in callback).
 *
 * Config (from scenario JSON):
 *   type: "point"                  — point marker (default)
 *   color: "#4488ff"               — CSS hex color
 *   pixelSize: 10                  — point size in pixels
 *   trail: true                    — draw position trail
 *   trailColor: "#44aaff"          — trail color (defaults to entity color at 60% alpha)
 *   trailLength: 500               — max trail points
 *   label: "EAGLE 1"              — text label above entity
 */
(function() {
    'use strict';

    class CesiumEntity extends ECS.Component {
        constructor(config) {
            super(config);
            this._cesiumEntity = null;
            this._trailEntity = null;
            this._trail = [];
            this._trailCounter = 0;
            this._isPlayer = false;
        }

        init(world) {
            const viewer = world.viewer;
            if (!viewer) return;

            const entity = this.entity;
            const state = entity.state;
            const cfg = this.config;

            // Parse color
            const color = cfg.color ? Cesium.Color.fromCssColorString(cfg.color) : Cesium.Color.LIME;

            // Determine if this is the player entity (for camera tracking)
            this._isPlayer = (entity === world._playerEntity);

            // Create Cesium entity with CallbackProperty position
            const entityOpts = {
                name: entity.name,
                position: new Cesium.CallbackProperty(function() {
                    return Cesium.Cartesian3.fromRadians(state.lon, state.lat, state.alt);
                }, false),
                point: {
                    pixelSize: cfg.pixelSize || 10,
                    color: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            };

            // Label
            if (cfg.label) {
                entityOpts.label = {
                    text: cfg.label,
                    font: '12px monospace',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -12),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                };
            }

            this._cesiumEntity = viewer.entities.add(entityOpts);

            // Trail
            if (cfg.trail) {
                const trailColor = cfg.trailColor
                    ? Cesium.Color.fromCssColorString(cfg.trailColor)
                    : color.withAlpha(0.6);
                const self = this;

                this._trailEntity = viewer.entities.add({
                    name: entity.name + ' Trail',
                    polyline: {
                        positions: new Cesium.CallbackProperty(function() {
                            return self._trail;
                        }, false),
                        width: cfg.trailWidth || 2,
                        material: trailColor
                    }
                });
            }
        }

        update(dt, world) {
            const state = this.entity.state;

            // Update trail (every ~10 frames via counter)
            if (this.config.trail) {
                this._trailCounter++;
                if (this._trailCounter % 10 === 0) {
                    this._trail.push(Cesium.Cartesian3.fromRadians(
                        state.lon, state.lat, state.alt
                    ));
                    const maxLen = this.config.trailLength || 500;
                    if (this._trail.length > maxLen) this._trail.shift();
                }
            }

            // Camera tracking (only for player entity)
            if (this._isPlayer && window._ScenarioCamera) {
                window._ScenarioCamera.update(world);
            }
        }

        cleanup(world) {
            if (world.viewer) {
                if (this._cesiumEntity) world.viewer.entities.remove(this._cesiumEntity);
                if (this._trailEntity) world.viewer.entities.remove(this._trailEntity);
            }
        }
    }

    ComponentRegistry.register('visual', 'point', CesiumEntity);
    // Also register under 'cesium_entity' alias
    ComponentRegistry.register('visual', 'cesium_entity', CesiumEntity);
})();
