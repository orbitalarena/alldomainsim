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

    // Weapon name -> max range in meters lookup for A2A loadouts
    var WEAPON_RANGE_TABLE = {
        'aim120':   100000,   // AIM-120 AMRAAM ~100km
        'aim9':     18000,    // AIM-9 Sidewinder ~18km
        'aim7':     70000,    // AIM-7 Sparrow ~70km
        'r77':      110000,   // R-77 ~110km
        'r73':      30000,    // R-73 ~30km
        'r27':      80000,    // R-27 ~80km
        'pl12':     100000,   // PL-12 ~100km
        'pl5':      18000,    // PL-5 ~18km
        'meteor':   150000,   // Meteor ~150km
        'mica':     80000     // MICA ~80km
    };

    class CesiumEntity extends ECS.Component {
        constructor(config) {
            super(config);
            this._cesiumEntity = null;
            this._trailEntity = null;
            this._weaponRangeEntity = null;
            this._weaponRange = 0;
            this._trail = [];
            this._trailCounter = 0;
            this._trailHead = 0;       // circular buffer write index
            this._trailFull = false;    // whether buffer has wrapped
            this._isPlayer = false;
            this._cachedPosition = null; // reuse Cartesian3
            this._cachedAlt = 0;
            // Model orientation offsets (radians)
            this._modelHeadingOffset = 0;
            this._modelPitchOffset = 0;
            this._modelRollOffset = 0;
            // Base visual properties (stored at init for cyber reset)
            this._baseSize = 10;
            this._baseColor = null;
            this._baseOutlineColor = null;
            this._baseOutlineWidth = 1;
            // Cached cyber effect colors (avoid per-frame allocation)
            this._cyberPurple = null;
            this._cyberRed = null;
            this._cyberYellow = null;
            this._cyberMagenta = null;
            this._cyberGray = null;
            this._cyberDarkGray = null;
            this._cyberOrange = null;
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

            // Create Cesium entity with cached CallbackProperty position
            const self = this;
            this._cachedPosition = Cesium.Cartesian3.fromRadians(state.lon, state.lat, state.alt);
            const entityOpts = {
                name: entity.name,
                position: new Cesium.CallbackProperty(function() {
                    return self._cachedPosition;
                }, false),
                point: {
                    pixelSize: cfg.pixelSize || 10,
                    color: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1
                }
            };

            // Label
            if (cfg.label) {
                var labelStr = typeof cfg.label === 'string' ? cfg.label : entity.name;
                entityOpts.label = {
                    text: labelStr,
                    font: '12px monospace',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -12)
                };
            }

            // 3D Model rendering — explicit config, Platform Builder, or auto-resolved via ModelMap
            var modelInfo = null;
            if (cfg.model) {
                modelInfo = {
                    uri: cfg.model,
                    scale: cfg.modelScale || 1.0,
                    headingOffset: (cfg.modelHeading || 0) * Math.PI / 180,
                    pitchOffset: (cfg.modelPitch || 0) * Math.PI / 180,
                    rollOffset: (cfg.modelRoll || 0) * Math.PI / 180
                };
            } else if (typeof ModelMap !== 'undefined') {
                // Auto-resolve from entity definition
                modelInfo = ModelMap.resolve(entity.def || {});
            }

            if (modelInfo) {
                self._modelHeadingOffset = modelInfo.headingOffset || 0;
                self._modelPitchOffset = modelInfo.pitchOffset || 0;
                self._modelRollOffset = modelInfo.rollOffset || 0;

                entityOpts.orientation = new Cesium.CallbackProperty(function() {
                    var h = (state.heading || 0) + self._modelHeadingOffset;
                    var p = (state.gamma || state.pitch || 0) + self._modelPitchOffset;
                    var r = (state.roll || 0) + self._modelRollOffset;
                    var hpr = new Cesium.HeadingPitchRoll(h, p, r);
                    return Cesium.Transforms.headingPitchRollQuaternion(self._cachedPosition, hpr);
                }, false);

                entityOpts.model = {
                    uri: modelInfo.uri,
                    minimumPixelSize: 32,
                    maximumScale: (modelInfo.scale || 1.0) * 500,
                    scale: modelInfo.scale || 1.0,
                };

                // Reduce point size when model is present (point serves as far-distance fallback)
                entityOpts.point.pixelSize = 4;
            }

            this._cesiumEntity = viewer.entities.add(entityOpts);
            this._cesiumEntity._ecsEntityId = entity.id;

            // Store base visual properties for cyber reset
            this._baseSize = modelInfo ? 4 : (cfg.pixelSize || 10);
            this._baseColor = color.clone();
            this._baseOutlineColor = Cesium.Color.BLACK.clone();
            this._baseOutlineWidth = 1;

            // Pre-allocate cyber effect colors (reused every frame)
            this._cyberPurple = Cesium.Color.fromCssColorString('#cc00ff');
            this._cyberRed = Cesium.Color.fromCssColorString('#ff3333');
            this._cyberYellow = Cesium.Color.YELLOW.clone();
            this._cyberMagenta = Cesium.Color.fromCssColorString('#ff44ff');
            this._cyberGray = Cesium.Color.GRAY.clone();
            this._cyberDarkGray = Cesium.Color.DARKGRAY.clone();
            this._cyberOrange = Cesium.Color.ORANGE.clone();

            // Trail
            if (cfg.trail) {
                const trailColor = cfg.trailColor
                    ? Cesium.Color.fromCssColorString(cfg.trailColor)
                    : color.withAlpha(0.6);

                this._trailEntity = viewer.entities.add({
                    name: entity.name + ' Trail',
                    polyline: {
                        positions: new Cesium.CallbackProperty(function() {
                            // Return ordered positions from circular buffer
                            if (!self._trailFull) return self._trail;
                            // Wrap: [head..end] + [0..head-1]
                            var h = self._trailHead;
                            var t = self._trail;
                            return t.slice(h).concat(t.slice(0, h));
                        }, false),
                        width: cfg.trailWidth || 2,
                        material: trailColor
                    }
                });
            }

            // --- Weapon range ring for aircraft with A2A loadouts ---
            var weaponsComp = entity.getComponent('weapons');
            var weaponsCfg = weaponsComp ? weaponsComp.config : null;
            if (weaponsCfg && weaponsCfg.loadout && Array.isArray(weaponsCfg.loadout)) {
                // Find max range across all loadout weapons
                var maxWeaponRange = 0;
                var loadout = weaponsCfg.loadout;
                for (var w = 0; w < loadout.length; w++) {
                    var item = loadout[w];
                    var range = 0;
                    if (typeof item === 'object' && item !== null && item.maxRange) {
                        range = item.maxRange;
                    } else if (typeof item === 'string') {
                        range = WEAPON_RANGE_TABLE[item.toLowerCase()] || 0;
                    }
                    if (range > maxWeaponRange) maxWeaponRange = range;
                }

                if (maxWeaponRange > 0) {
                    this._weaponRange = maxWeaponRange;
                    this._cachedAlt = state.alt;

                    this._weaponRangeEntity = viewer.entities.add({
                        name: entity.name + ' Weapon Range',
                        position: new Cesium.CallbackProperty(function() {
                            return self._cachedPosition;
                        }, false),
                        ellipse: {
                            semiMajorAxis: maxWeaponRange,
                            semiMinorAxis: maxWeaponRange,
                            material: Cesium.Color.CYAN.withAlpha(0.02),
                            outline: true,
                            outlineColor: Cesium.Color.CYAN.withAlpha(0.4),
                            outlineWidth: 1,
                            height: new Cesium.CallbackProperty(function() {
                                return self._cachedAlt;
                            }, false),
                            granularity: Cesium.Math.toRadians(3)
                        }
                    });
                }
            }
        }

        update(dt, world) {
            const state = this.entity.state;

            // Per-entity visibility controls
            var vizShow = this.entity.state._vizShow !== false;
            if (this._cesiumEntity) this._cesiumEntity.show = vizShow;
            if (this._cesiumEntity && this._cesiumEntity.label) {
                this._cesiumEntity.label.show = vizShow && this.entity.state._vizLabels !== false;
            }
            if (this._trailEntity) this._trailEntity.show = vizShow && this.entity.state._vizTrails !== false;

            // Search highlight
            if (this.entity.state._searchHighlight) {
                if (this._cesiumEntity && this._cesiumEntity.point) {
                    this._cesiumEntity.point.pixelSize = (this.config.pixelSize || 10) * 2;
                    this._cesiumEntity.point.outlineColor = Cesium.Color.GOLD;
                    this._cesiumEntity.point.outlineWidth = 2;
                }
            } else {
                if (this._cesiumEntity && this._cesiumEntity.point) {
                    this._cesiumEntity.point.pixelSize = this.config.model ? 4 : (this.config.pixelSize || 10);
                    this._cesiumEntity.point.outlineColor = Cesium.Color.BLACK;
                    this._cesiumEntity.point.outlineWidth = 1;
                }
            }

            // --- Cyber status visual indicators ---
            if (this._cesiumEntity && this._cesiumEntity.point && !this.entity.state._searchHighlight) {
                var cyState = this.entity.state;
                var baseSize = this._baseSize;
                var cyberHandled = false;

                // Check degradation levels
                var cyberDeg = cyState._cyberDegradation;
                var hasCyberEffect = false;
                var maxDeg = 0;
                if (cyberDeg) {
                    maxDeg = Math.max(
                        cyberDeg.sensors || 0, cyberDeg.navigation || 0,
                        cyberDeg.weapons || 0, cyberDeg.comms || 0
                    );
                    if (maxDeg > 0) hasCyberEffect = true;
                }

                if (cyState._cyberDenied || cyState._commBricked) {
                    // Denied/bricked: dim point, gray color
                    this._cesiumEntity.point.pixelSize = Math.max(4, baseSize - 2);
                    this._cesiumEntity.point.color = this._cyberGray;
                    this._cesiumEntity.point.outlineColor = this._cyberDarkGray;
                    this._cesiumEntity.point.outlineWidth = 1;
                    cyberHandled = true;
                } else if (cyState._cyberControlled) {
                    // Fully controlled — purple pulsing
                    var pulse = 0.5 + 0.5 * Math.sin(world.simTime * 4);
                    this._cyberPurple.alpha = pulse;
                    this._cesiumEntity.point.color = this._cyberPurple;
                    this._cesiumEntity.point.outlineColor = Cesium.Color.RED;
                    this._cesiumEntity.point.outlineWidth = 3;
                    this._cesiumEntity.point.pixelSize = baseSize + 4;
                    cyberHandled = true;
                } else if (cyState._fullControl) {
                    // Full control (legacy flag): fast red pulse
                    var ctrlPulse = Math.sin(Date.now() * 0.008) * 0.5 + 0.5;
                    this._cesiumEntity.point.outlineColor = Cesium.Color.RED;
                    this._cesiumEntity.point.outlineWidth = 2 + ctrlPulse * 2;
                    this._cesiumEntity.point.pixelSize = baseSize + ctrlPulse * 3;
                    cyberHandled = true;
                } else if (cyState._sensorDisabled || cyState._weaponsDisabled || cyState._navigationHijacked) {
                    // Subsystem hack: orange pulsing — individual systems compromised
                    var subPulse = Math.sin(Date.now() * 0.006) * 0.5 + 0.5;
                    this._cesiumEntity.point.outlineColor = this._cyberOrange;
                    this._cesiumEntity.point.outlineWidth = 2 + subPulse;
                    this._cesiumEntity.point.pixelSize = baseSize + subPulse * 2;
                    cyberHandled = true;
                } else if (cyState._cyberExploited) {
                    // Exploited — red flickering
                    var flicker = Math.random() > 0.1 ? 1.0 : 0.3;
                    this._cyberRed.alpha = flicker;
                    this._cesiumEntity.point.color = this._cyberRed;
                    this._cesiumEntity.point.outlineColor = this._cyberOrange;
                    this._cesiumEntity.point.outlineWidth = 2;
                    cyberHandled = true;
                } else if (hasCyberEffect && maxDeg > 0.3) {
                    // Degraded but not exploited — yellow outline
                    this._cesiumEntity.point.outlineColor = this._cyberYellow;
                    this._cesiumEntity.point.outlineWidth = 2;
                    cyberHandled = true;
                } else if (cyState._cyberScanning) {
                    // Being scanned — brief yellow flash
                    var scanFlash = Math.sin(world.simTime * 8) > 0.5 ? 1 : 0;
                    if (scanFlash) {
                        this._cesiumEntity.point.outlineColor = this._cyberYellow;
                        this._cesiumEntity.point.outlineWidth = 1;
                        cyberHandled = true;
                    }
                }

                // Reset to base state when no cyber effects are active
                if (!cyberHandled) {
                    this._cesiumEntity.point.pixelSize = baseSize;
                    this._cesiumEntity.point.color = this._baseColor;
                    this._cesiumEntity.point.outlineColor = this._baseOutlineColor;
                    this._cesiumEntity.point.outlineWidth = this._baseOutlineWidth;
                }
            }

            // Update cached position (avoids allocation in CallbackProperty)
            this._cachedPosition = Cesium.Cartesian3.fromRadians(
                state.lon, state.lat, state.alt
            );
            this._cachedAlt = state.alt;

            // Update trail (every ~10 frames via counter)
            if (this.config.trail) {
                this._trailCounter++;
                if (this._trailCounter % 10 === 0) {
                    const pos = Cesium.Cartesian3.fromRadians(
                        state.lon, state.lat, state.alt
                    );
                    const maxLen = this.config.trailLength || 500;

                    if (this._trail.length < maxLen) {
                        // Still filling the buffer
                        this._trail.push(pos);
                    } else {
                        // Circular overwrite — O(1) instead of shift() O(n)
                        this._trail[this._trailHead] = pos;
                        this._trailHead = (this._trailHead + 1) % maxLen;
                        this._trailFull = true;
                    }
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
                if (this._weaponRangeEntity) world.viewer.entities.remove(this._weaponRangeEntity);
            }
            this._weaponRangeEntity = null;
        }
    }

    ComponentRegistry.register('visual', 'point', CesiumEntity);
    // Also register under 'cesium_entity' alias
    ComponentRegistry.register('visual', 'cesium_entity', CesiumEntity);
})();
