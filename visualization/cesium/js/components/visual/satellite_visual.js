/**
 * SatelliteVisual — Cesium visualization for orbital entities.
 *
 * Renders:
 *   - Point marker at satellite position (with label)
 *   - Full orbit path polyline (computed from ECI state via Kepler)
 *   - Ground track polyline (orbit projected to surface)
 *   - Apoapsis marker with altitude label (green)
 *   - Periapsis marker with altitude label (cyan)
 *
 * Reads from entity.state:
 *   _eci_pos, _eci_vel  — set by orbital_2body physics component
 *   lat, lon, alt        — geodetic position for the point marker
 *   _simTime             — current sim time for GMST computation
 *
 * Config:
 *   type: "satellite"
 *   color: "#ffaa00"          — satellite point + orbit color
 *   pixelSize: 8              — point marker size
 *   orbitPath: true           — draw orbit path (default true)
 *   groundTrack: true         — draw ground track (default true)
 *   apPeMarkers: true         — draw AP/PE markers (default true)
 *   orbitWidth: 1.5           — orbit path line width
 *   groundTrackWidth: 1       — ground track line width
 *
 * Registered as: visual / satellite
 */
(function() {
    'use strict';

    var ORBIT_UPDATE_INTERVAL = 60; // frames between orbit path recomputation

    class SatelliteVisual extends ECS.Component {
        constructor(config) {
            super(config);
            // Cesium entities
            this._pointEntity = null;
            this._orbitPathEntity = null;
            this._groundTrackEntity = null;
            this._apEntity = null;
            this._peEntity = null;
            // Cached orbit data
            this._orbitPositions = [];
            this._groundTrackPositions = [];
            this._apPosition = null;
            this._pePosition = null;
            // Model orientation
            this._modelHeadingOffset = 0;
            this._modelPitchOffset = 0;
            this._modelRollOffset = 0;
            this._cachedOrientation = null;
            // Stagger updates across satellites to avoid frame spikes
            this._updateOffset = Math.floor(Math.random() * ORBIT_UPDATE_INTERVAL);
            this._frameCounter = 0;
            // Base visual properties (stored at init for cyber reset)
            this._baseSize = 8;
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
            var viewer = world.viewer;
            if (!viewer) return;

            var entity = this.entity;
            var state = entity.state;
            var cfg = this.config;
            var self = this;

            // Parse color
            var color;
            try {
                color = cfg.color ? Cesium.Color.fromCssColorString(cfg.color) : Cesium.Color.WHITE;
            } catch (e) {
                color = Cesium.Color.WHITE;
            }
            this._color = color;

            // 1. Point marker + label (+ optional 3D model)
            var pointEntityOpts = {
                name: entity.name,
                position: new Cesium.CallbackProperty(function() {
                    return Cesium.Cartesian3.fromRadians(state.lon, state.lat, state.alt);
                }, false),
                point: {
                    pixelSize: cfg.pixelSize || 8,
                    color: color,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 1
                },
                label: {
                    text: entity.name,
                    font: '11px monospace',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -12),
                    scale: 0.85
                }
            };

            // 3D Model rendering (optional — from Platform Builder model selection)
            if (cfg.model) {
                self._modelHeadingOffset = (cfg.modelHeading || 0) * Math.PI / 180;
                self._modelPitchOffset = (cfg.modelPitch || 0) * Math.PI / 180;
                self._modelRollOffset = (cfg.modelRoll || 0) * Math.PI / 180;

                pointEntityOpts.orientation = new Cesium.CallbackProperty(function() {
                    return self._cachedOrientation || Cesium.Quaternion.IDENTITY;
                }, false);

                pointEntityOpts.model = {
                    uri: cfg.model,
                    minimumPixelSize: 32,
                    maximumScale: (cfg.modelScale || 1.0) * 500,
                    scale: cfg.modelScale || 1.0,
                };

                // Reduce point size when model is present
                pointEntityOpts.point.pixelSize = 4;
            }

            this._pointEntity = viewer.entities.add(pointEntityOpts);
            this._pointEntity._ecsEntityId = entity.id;

            // Store base visual properties for cyber reset
            this._baseSize = cfg.model ? 4 : (cfg.pixelSize || 8);
            this._baseColor = color.clone();
            this._baseOutlineColor = Cesium.Color.WHITE.clone();
            this._baseOutlineWidth = 1;

            // Pre-allocate cyber effect colors (reused every frame)
            this._cyberPurple = Cesium.Color.fromCssColorString('#cc00ff');
            this._cyberRed = Cesium.Color.fromCssColorString('#ff3333');
            this._cyberYellow = Cesium.Color.YELLOW.clone();
            this._cyberMagenta = Cesium.Color.fromCssColorString('#ff44ff');
            this._cyberGray = Cesium.Color.GRAY.clone();
            this._cyberDarkGray = Cesium.Color.DARKGRAY.clone();
            this._cyberOrange = Cesium.Color.ORANGE.clone();

            // 2. Orbit path polyline
            if (cfg.orbitPath !== false) {
                var orbitColor = color.withAlpha(0.5);
                this._orbitPathEntity = viewer.entities.add({
                    name: entity.name + ' Orbit',
                    polyline: {
                        positions: new Cesium.CallbackProperty(function() {
                            return self._orbitPositions;
                        }, false),
                        width: cfg.orbitWidth || 1.5,
                        material: orbitColor
                    }
                });
            }

            // 3. Ground track polyline
            if (cfg.groundTrack !== false) {
                var trackColor = color.withAlpha(0.2);
                this._groundTrackEntity = viewer.entities.add({
                    name: entity.name + ' Track',
                    polyline: {
                        positions: new Cesium.CallbackProperty(function() {
                            return self._groundTrackPositions;
                        }, false),
                        width: cfg.groundTrackWidth || 1,
                        material: trackColor,
                        clampToGround: true
                    }
                });
            }

            // 4. Apoapsis marker
            if (cfg.apPeMarkers !== false) {
                this._apEntity = viewer.entities.add({
                    name: entity.name + ' AP',
                    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
                    show: false,
                    point: {
                        pixelSize: 6,
                        color: Cesium.Color.LIME,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 1
                    },
                    label: {
                        text: 'AP',
                        font: '10px monospace',
                        fillColor: Cesium.Color.LIME,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -10),
                        scale: 0.75
                    }
                });

                // 5. Periapsis marker
                this._peEntity = viewer.entities.add({
                    name: entity.name + ' PE',
                    position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
                    show: false,
                    point: {
                        pixelSize: 6,
                        color: Cesium.Color.fromCssColorString('#00ccff'),
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 1
                    },
                    label: {
                        text: 'PE',
                        font: '10px monospace',
                        fillColor: Cesium.Color.fromCssColorString('#00ccff'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 2,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        pixelOffset: new Cesium.Cartesian2(0, -10),
                        scale: 0.75
                    }
                });
            }

            // Compute orbit immediately if ECI state is available
            if (state._eci_pos && state._eci_vel) {
                this._computeOrbitPath(world);
            }
        }

        update(dt, world) {
            this._frameCounter++;

            // Per-entity visibility controls
            var vizShow = this.entity.state._vizShow !== false;
            if (this._pointEntity) this._pointEntity.show = vizShow;
            if (this._pointEntity && this._pointEntity.label) {
                this._pointEntity.label.show = vizShow && this.entity.state._vizLabels !== false;
            }
            if (this._orbitPathEntity) this._orbitPathEntity.show = vizShow && this.entity.state._vizOrbits !== false;
            if (this._groundTrackEntity) this._groundTrackEntity.show = vizShow && this.entity.state._vizOrbits !== false;

            // Search highlight
            if (this.entity.state._searchHighlight) {
                if (this._pointEntity && this._pointEntity.point) {
                    this._pointEntity.point.pixelSize = (this.config.pixelSize || 8) * 2;
                    this._pointEntity.point.outlineColor = Cesium.Color.GOLD;
                    this._pointEntity.point.outlineWidth = 2;
                }
            } else {
                if (this._pointEntity && this._pointEntity.point) {
                    this._pointEntity.point.pixelSize = this.config.model ? 4 : (this.config.pixelSize || 8);
                    this._pointEntity.point.outlineColor = Cesium.Color.WHITE;
                    this._pointEntity.point.outlineWidth = 1;
                }
            }

            // --- Cyber status visual indicators ---
            if (this._pointEntity && this._pointEntity.point && !this.entity.state._searchHighlight) {
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
                    this._pointEntity.point.pixelSize = Math.max(4, baseSize - 2);
                    this._pointEntity.point.color = this._cyberGray;
                    this._pointEntity.point.outlineColor = this._cyberDarkGray;
                    this._pointEntity.point.outlineWidth = 1;
                    cyberHandled = true;
                } else if (cyState._cyberControlled) {
                    // Fully controlled — purple pulsing
                    var pulse = 0.5 + 0.5 * Math.sin(world.simTime * 4);
                    this._cyberPurple.alpha = pulse;
                    this._pointEntity.point.color = this._cyberPurple;
                    this._pointEntity.point.outlineColor = Cesium.Color.RED;
                    this._pointEntity.point.outlineWidth = 3;
                    this._pointEntity.point.pixelSize = baseSize + 4;
                    cyberHandled = true;
                } else if (cyState._fullControl) {
                    // Full control (legacy flag): fast red pulse
                    var ctrlPulse = Math.sin(Date.now() * 0.008) * 0.5 + 0.5;
                    this._pointEntity.point.outlineColor = Cesium.Color.RED;
                    this._pointEntity.point.outlineWidth = 2 + ctrlPulse * 2;
                    this._pointEntity.point.pixelSize = baseSize + ctrlPulse * 3;
                    cyberHandled = true;
                } else if (cyState._sensorDisabled || cyState._weaponsDisabled || cyState._navigationHijacked) {
                    // Subsystem hack: orange pulsing — individual systems compromised
                    var subPulse = Math.sin(Date.now() * 0.006) * 0.5 + 0.5;
                    this._pointEntity.point.outlineColor = this._cyberOrange;
                    this._pointEntity.point.outlineWidth = 2 + subPulse;
                    this._pointEntity.point.pixelSize = baseSize + subPulse * 2;
                    cyberHandled = true;
                } else if (cyState._cyberExploited) {
                    // Exploited — red flickering
                    var flicker = Math.random() > 0.1 ? 1.0 : 0.3;
                    this._cyberRed.alpha = flicker;
                    this._pointEntity.point.color = this._cyberRed;
                    this._pointEntity.point.outlineColor = this._cyberOrange;
                    this._pointEntity.point.outlineWidth = 2;
                    cyberHandled = true;
                } else if (hasCyberEffect && maxDeg > 0.3) {
                    // Degraded but not exploited — yellow outline
                    this._pointEntity.point.outlineColor = this._cyberYellow;
                    this._pointEntity.point.outlineWidth = 2;
                    cyberHandled = true;
                } else if (cyState._cyberScanning) {
                    // Being scanned — brief yellow flash
                    var scanFlash = Math.sin(world.simTime * 8) > 0.5 ? 1 : 0;
                    if (scanFlash) {
                        this._pointEntity.point.outlineColor = this._cyberYellow;
                        this._pointEntity.point.outlineWidth = 1;
                        cyberHandled = true;
                    }
                }

                // Reset to base state when no cyber effects are active
                if (!cyberHandled) {
                    this._pointEntity.point.pixelSize = baseSize;
                    this._pointEntity.point.color = this._baseColor;
                    this._pointEntity.point.outlineColor = this._baseOutlineColor;
                    this._pointEntity.point.outlineWidth = this._baseOutlineWidth;
                }
            }

            // Update model orientation from ECI velocity (every frame for smooth rotation)
            if (this.config.model) {
                this._updateModelOrientation();
            }

            // Stagger orbit path updates across satellites — skip when orbits are globally off
            if ((this._frameCounter + this._updateOffset) % ORBIT_UPDATE_INTERVAL === 0) {
                if (this.entity.state._vizOrbits !== false) {
                    this._computeOrbitPath(world);
                }
            }
        }

        _updateModelOrientation() {
            var state = this.entity.state;
            var vel = state._eci_vel;
            if (!vel) return;

            var lat = state.lat, lon = state.lon;
            var sinLat = Math.sin(lat), cosLat = Math.cos(lat);
            var sinLon = Math.sin(lon), cosLon = Math.cos(lon);

            // ENU basis vectors at geodetic position
            var eE = [-sinLon, cosLon, 0];
            var eN = [-sinLat * cosLon, -sinLat * sinLon, cosLat];
            var eU = [cosLat * cosLon, cosLat * sinLon, sinLat];

            // Project ECI velocity into ENU
            var vE = vel[0] * eE[0] + vel[1] * eE[1] + vel[2] * eE[2];
            var vN = vel[0] * eN[0] + vel[1] * eN[1] + vel[2] * eN[2];
            var vU = vel[0] * eU[0] + vel[1] * eU[1] + vel[2] * eU[2];

            var heading = Math.atan2(vE, vN);
            var vHoriz = Math.sqrt(vE * vE + vN * vN);
            var pitch = Math.atan2(vU, vHoriz);

            var h = heading + this._modelHeadingOffset;
            var p = pitch + this._modelPitchOffset;
            var r = this._modelRollOffset;

            var pos = Cesium.Cartesian3.fromRadians(state.lon, state.lat, state.alt);
            var hpr = new Cesium.HeadingPitchRoll(h, p, r);
            this._cachedOrientation = Cesium.Transforms.headingPitchRollQuaternion(pos, hpr);
        }

        _computeOrbitPath(world) {
            var state = this.entity.state;
            var pos = state._eci_pos;
            var vel = state._eci_vel;

            if (!pos || !vel) return;
            if (typeof TLEParser === 'undefined') return;

            var simTime = world.simTime || 0;

            // Orbit path polyline
            if (this.config.orbitPath !== false) {
                this._orbitPositions = TLEParser.predictOrbitPath(pos, vel, 360, simTime);

                // Ground track: project orbit to surface
                if (this.config.groundTrack !== false) {
                    var groundTrack = [];
                    for (var i = 0; i < this._orbitPositions.length; i++) {
                        var cart = this._orbitPositions[i];
                        if (!cart) continue;
                        try {
                            var carto = Cesium.Cartographic.fromCartesian(cart);
                            if (carto) {
                                groundTrack.push(
                                    Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0)
                                );
                            }
                        } catch (e) {
                            // Skip invalid points
                        }
                    }
                    this._groundTrackPositions = groundTrack;
                }
            }

            // AP/PE markers
            if (this.config.apPeMarkers !== false) {
                var apPe = TLEParser.computeApPePositions(pos, vel, simTime);

                if (this._apEntity) {
                    if (apPe.ap && apPe.apoapsisAlt != null) {
                        this._apEntity.position = apPe.ap;
                        this._apEntity.label.text = 'AP ' + Math.round(apPe.apoapsisAlt / 1000) + 'km';
                        this._apEntity.show = true;
                    } else {
                        this._apEntity.show = false;
                    }
                }

                if (this._peEntity) {
                    if (apPe.pe && apPe.periapsisAlt != null) {
                        this._peEntity.position = apPe.pe;
                        this._peEntity.label.text = 'PE ' + Math.round(apPe.periapsisAlt / 1000) + 'km';
                        this._peEntity.show = true;
                    } else {
                        this._peEntity.show = false;
                    }
                }
            }
        }

        cleanup(world) {
            if (world.viewer) {
                if (this._pointEntity) world.viewer.entities.remove(this._pointEntity);
                if (this._orbitPathEntity) world.viewer.entities.remove(this._orbitPathEntity);
                if (this._groundTrackEntity) world.viewer.entities.remove(this._groundTrackEntity);
                if (this._apEntity) world.viewer.entities.remove(this._apEntity);
                if (this._peEntity) world.viewer.entities.remove(this._peEntity);
            }
            this._orbitPositions = [];
            this._groundTrackPositions = [];
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'satellite', SatelliteVisual);
})();
