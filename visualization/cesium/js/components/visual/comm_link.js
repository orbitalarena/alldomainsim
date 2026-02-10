/**
 * CommLink -- Cesium visualization for communications links between entities.
 *
 * Draws polylines between entities that can communicate, colored and styled
 * by link quality computed from a simplified RF link budget model.
 *
 * Config (from scenario JSON entity definition):
 *   type: "comm_link"
 *   frequency_ghz: 2.4          -- carrier frequency in GHz
 *   power_dbw: 10               -- transmit power in dBW
 *   antenna_gain_dbi: 20        -- transmit antenna gain in dBi
 *   maxRange_m: 500000          -- maximum communication range in meters
 *   dataRate_mbps: 100          -- nominal data rate in Mbps
 *   targets: ["id1", "id2"]     -- explicit target entity IDs (optional)
 *   receiver_sensitivity_dbm: -100  -- receiver sensitivity threshold in dBm
 *
 * If no targets specified, auto-links to same-team entities within range
 * that also have a comm_link visual component.
 *
 * Link Quality Levels:
 *   EXCELLENT (margin > 20 dB) -- green, 2px solid
 *   GOOD      (10-20 dB)       -- yellow, 1.5px dashed
 *   DEGRADED  (0-10 dB)        -- orange, 1px dashed
 *   LOST      (margin < 0 dB)  -- red flash then hidden
 *
 * Line-of-sight: rough check via angle between position vectors (< 160 deg).
 *
 * Registered as: visual / comm_link
 */
(function() {
    'use strict';

    var R_EARTH = FrameworkConstants.R_EARTH;
    var C_LIGHT = 299792458; // m/s

    // Link quality enum
    var QUALITY = {
        EXCELLENT: 'EXCELLENT',
        GOOD:      'GOOD',
        DEGRADED:  'DEGRADED',
        LOST:      'LOST'
    };

    // Default configuration values
    var DEFAULTS = {
        frequency_ghz: 2.4,
        power_dbw: 10,
        antenna_gain_dbi: 20,
        maxRange_m: 500000,
        dataRate_mbps: 100,
        receiver_sensitivity_dbm: -100,
        targets: null
    };

    // Pre-computed colors for link quality levels
    var QUALITY_COLORS = {};
    // These are initialized lazily on first init to ensure Cesium is loaded

    var _colorsInitialized = false;
    function ensureColors() {
        if (_colorsInitialized) return;
        QUALITY_COLORS[QUALITY.EXCELLENT] = Cesium.Color.fromCssColorString('#00ff44');
        QUALITY_COLORS[QUALITY.GOOD]      = Cesium.Color.fromCssColorString('#ffee00');
        QUALITY_COLORS[QUALITY.DEGRADED]  = Cesium.Color.fromCssColorString('#ff8800');
        QUALITY_COLORS[QUALITY.LOST]      = Cesium.Color.fromCssColorString('#ff2200');
        _colorsInitialized = true;
    }

    // Pre-created dash material properties (cached for reuse)
    var _materialsInitialized = false;
    var DASH_MATERIALS = {};
    function ensureMaterials() {
        if (_materialsInitialized) return;
        ensureColors();
        // Solid materials for EXCELLENT
        DASH_MATERIALS[QUALITY.EXCELLENT] = QUALITY_COLORS[QUALITY.EXCELLENT];
        // Dashed materials for GOOD, DEGRADED, LOST
        DASH_MATERIALS[QUALITY.GOOD] = new Cesium.PolylineDashMaterialProperty({
            color: QUALITY_COLORS[QUALITY.GOOD],
            dashLength: 16
        });
        DASH_MATERIALS[QUALITY.DEGRADED] = new Cesium.PolylineDashMaterialProperty({
            color: QUALITY_COLORS[QUALITY.DEGRADED],
            dashLength: 8
        });
        DASH_MATERIALS[QUALITY.LOST] = new Cesium.PolylineDashMaterialProperty({
            color: QUALITY_COLORS[QUALITY.LOST],
            dashLength: 6
        });
        _materialsInitialized = true;
    }

    // Width by quality level
    var QUALITY_WIDTHS = {};
    QUALITY_WIDTHS[QUALITY.EXCELLENT] = 2;
    QUALITY_WIDTHS[QUALITY.GOOD]      = 1.5;
    QUALITY_WIDTHS[QUALITY.DEGRADED]  = 1;
    QUALITY_WIDTHS[QUALITY.LOST]      = 1;

    /**
     * Compute free-space path loss in dB.
     * FSPL = 20*log10(d) + 20*log10(f) + 20*log10(4*pi/c)
     * where d = distance in meters, f = frequency in Hz.
     */
    function computeFSPL(distance_m, frequency_hz) {
        if (distance_m <= 0) return 0;
        var fspl = 20 * Math.log10(distance_m)
                 + 20 * Math.log10(frequency_hz)
                 + 20 * Math.log10(4 * Math.PI / C_LIGHT);
        return fspl;
    }

    /**
     * Check rough line-of-sight between two ECEF/Cartesian3 positions.
     * If the angle between the position vectors from Earth center exceeds
     * 160 degrees, the line likely passes through Earth.
     */
    function hasLineOfSight(posA, posB) {
        // Compute angle between position vectors from Earth center
        var dot = Cesium.Cartesian3.dot(posA, posB);
        var magA = Cesium.Cartesian3.magnitude(posA);
        var magB = Cesium.Cartesian3.magnitude(posB);
        if (magA === 0 || magB === 0) return false;
        var cosAngle = dot / (magA * magB);
        // Clamp for floating point
        cosAngle = Math.max(-1, Math.min(1, cosAngle));
        var angleDeg = Math.acos(cosAngle) * (180 / Math.PI);
        return angleDeg < 160;
    }

    /**
     * Compute distance between two Cartesian3 positions.
     */
    function distance3D(posA, posB) {
        return Cesium.Cartesian3.distance(posA, posB);
    }

    // Scratch Cartesian3 for midpoint computation
    var _scratchMidpoint = new Cesium.Cartesian3();

    /**
     * Compute midpoint between two Cartesian3 positions.
     */
    function midpoint(posA, posB) {
        Cesium.Cartesian3.midpoint(posA, posB, _scratchMidpoint);
        return Cesium.Cartesian3.clone(_scratchMidpoint);
    }

    // -----------------------------------------------------------------------
    // CommLink Component
    // -----------------------------------------------------------------------

    class CommLink extends ECS.Component {
        constructor(config) {
            super(config);
            // Resolved config values
            this._frequency_ghz = 0;
            this._frequency_hz = 0;
            this._power_dbw = 0;
            this._antenna_gain_dbi = 0;
            this._maxRange_m = 0;
            this._dataRate_mbps = 0;
            this._receiver_sensitivity_dbm = 0;
            this._explicitTargets = null;

            // Link state per target entity
            // Array of { targetId, targetEntity, cesiumLine, cesiumLabel,
            //            quality, positions, lastQuality, lostTimer }
            this._links = [];

            // Frame counter for 2Hz throttle
            this._frameCount = 0;

            // Auto-link discovery done flag
            this._autoLinksDiscovered = false;
        }

        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            ensureColors();
            ensureMaterials();

            var cfg = this.config;

            // Resolve config with defaults
            this._frequency_ghz = cfg.frequency_ghz !== undefined ? cfg.frequency_ghz : DEFAULTS.frequency_ghz;
            this._frequency_hz = this._frequency_ghz * 1e9;
            this._power_dbw = cfg.power_dbw !== undefined ? cfg.power_dbw : DEFAULTS.power_dbw;
            this._antenna_gain_dbi = cfg.antenna_gain_dbi !== undefined ? cfg.antenna_gain_dbi : DEFAULTS.antenna_gain_dbi;
            this._maxRange_m = cfg.maxRange_m !== undefined ? cfg.maxRange_m : DEFAULTS.maxRange_m;
            this._dataRate_mbps = cfg.dataRate_mbps !== undefined ? cfg.dataRate_mbps : DEFAULTS.dataRate_mbps;
            this._receiver_sensitivity_dbm = cfg.receiver_sensitivity_dbm !== undefined
                ? cfg.receiver_sensitivity_dbm : DEFAULTS.receiver_sensitivity_dbm;

            // Parse target list
            this._explicitTargets = cfg.targets && cfg.targets.length > 0 ? cfg.targets : null;

            if (this._explicitTargets) {
                // Create links to explicit targets
                for (var i = 0; i < this._explicitTargets.length; i++) {
                    var targetId = this._explicitTargets[i];
                    var targetEntity = world.getEntity(targetId);
                    if (targetEntity) {
                        this._createLink(world, targetEntity);
                    }
                }
            }
            // Auto-link discovery is deferred to first update() so all entities are initialized
        }

        /**
         * Create a Cesium polyline + label for a link to a target entity.
         */
        _createLink(world, targetEntity) {
            var viewer = world.viewer;
            if (!viewer) return;

            var self = this;
            var entity = this.entity;

            // Check for duplicate link
            for (var d = 0; d < this._links.length; d++) {
                if (this._links[d].targetId === targetEntity.id) return;
            }

            // Initial positions (will be updated every tick)
            var srcState = entity.state;
            var tgtState = targetEntity.state;
            var srcPos = Cesium.Cartesian3.fromRadians(
                srcState.lon || 0, srcState.lat || 0, srcState.alt || 0
            );
            var tgtPos = Cesium.Cartesian3.fromRadians(
                tgtState.lon || 0, tgtState.lat || 0, tgtState.alt || 0
            );

            var linkData = {
                targetId: targetEntity.id,
                targetEntity: targetEntity,
                cesiumLine: null,
                cesiumLabel: null,
                quality: QUALITY.LOST,
                lastQuality: null,
                positions: [srcPos, tgtPos],
                midpointPos: midpoint(srcPos, tgtPos),
                lostTimer: 0,
                visible: true
            };

            // Polyline entity
            linkData.cesiumLine = viewer.entities.add({
                name: entity.name + ' -> ' + targetEntity.name + ' Comm',
                polyline: {
                    positions: new Cesium.CallbackProperty(function() {
                        return linkData.positions;
                    }, false),
                    width: 2,
                    material: QUALITY_COLORS[QUALITY.EXCELLENT]
                }
            });

            // Midpoint label entity
            linkData.cesiumLabel = viewer.entities.add({
                name: entity.name + ' -> ' + targetEntity.name + ' Link Info',
                position: new Cesium.CallbackProperty(function() {
                    return linkData.midpointPos;
                }, false),
                label: {
                    text: new Cesium.CallbackProperty(function() {
                        if (linkData.quality === QUALITY.LOST) {
                            return 'LINK LOST';
                        }
                        return self._dataRate_mbps + ' Mbps';
                    }, false),
                    font: '10px monospace',
                    fillColor: new Cesium.CallbackProperty(function() {
                        return QUALITY_COLORS[linkData.quality] || QUALITY_COLORS[QUALITY.LOST];
                    }, false),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    pixelOffset: new Cesium.Cartesian2(0, -10),
                    scale: 0.8,
                    showBackground: true,
                    backgroundColor: Cesium.Color.BLACK.withAlpha(0.5)
                }
            });

            this._links.push(linkData);
        }

        /**
         * Discover auto-link targets: same-team entities within range that have
         * a comm_link visual component. Only runs once.
         */
        _discoverAutoLinks(world) {
            if (this._autoLinksDiscovered) return;
            this._autoLinksDiscovered = true;

            if (this._explicitTargets) return; // explicit mode, skip auto-discovery

            var entity = this.entity;
            var myTeam = entity.team;

            // Iterate all entities in the world
            var self = this;
            world.entities.forEach(function(other) {
                if (other.id === entity.id) return;
                if (!other.active) return;

                // Same team check
                if (other.team !== myTeam) return;

                // Check if other entity has a comm_link visual component
                var otherVisual = other.getComponent('visual');
                if (!otherVisual) return;
                var otherCfg = otherVisual.config;
                if (!otherCfg || otherCfg.type !== 'comm_link') return;

                // Avoid duplicate links: only create if our ID < other ID
                // (the other entity will also try to create links)
                if (entity.id > other.id) return;

                self._createLink(world, other);
            });
        }

        update(dt, world) {
            // Discover auto-links on first update (all entities are initialized by now)
            if (!this._autoLinksDiscovered) {
                this._discoverAutoLinks(world);
            }

            // Throttle link quality computation to ~2Hz (every 30 frames at 60fps)
            this._frameCount++;
            var doCompute = (this._frameCount % 30 === 0);

            var entity = this.entity;
            var state = entity.state;

            // Visibility controls
            var vizShow = state._vizShow !== false;
            var vizSensors = state._vizSensors !== false;
            var showLinks = vizShow && vizSensors;

            for (var i = 0; i < this._links.length; i++) {
                var link = this._links[i];
                var target = link.targetEntity;

                // Check if target entity is still active
                if (!target || !target.active) {
                    if (link.cesiumLine) link.cesiumLine.show = false;
                    if (link.cesiumLabel) link.cesiumLabel.show = false;
                    continue;
                }

                var tgtState = target.state;

                // Update positions every frame (cheap Cartesian3 creation)
                var srcPos = Cesium.Cartesian3.fromRadians(
                    state.lon || 0, state.lat || 0, state.alt || 0
                );
                var tgtPos = Cesium.Cartesian3.fromRadians(
                    tgtState.lon || 0, tgtState.lat || 0, tgtState.alt || 0
                );
                link.positions[0] = srcPos;
                link.positions[1] = tgtPos;
                link.midpointPos = midpoint(srcPos, tgtPos);

                if (doCompute) {
                    // Compute distance
                    var dist = distance3D(srcPos, tgtPos);

                    // Line-of-sight check
                    var los = hasLineOfSight(srcPos, tgtPos);

                    // Compute link quality
                    var quality;
                    if (!los || dist > this._maxRange_m) {
                        quality = QUALITY.LOST;
                    } else {
                        // Free-space path loss
                        var fspl = computeFSPL(dist, this._frequency_hz);

                        // Received power (dBW): Pt + Gt + Gr - FSPL
                        // Gr assumed 0 dBi
                        var pr_dbw = this._power_dbw + this._antenna_gain_dbi + 0 - fspl;

                        // Convert to dBm for comparison with receiver sensitivity
                        var pr_dbm = pr_dbw + 30;

                        // Link margin
                        var margin = pr_dbm - this._receiver_sensitivity_dbm;

                        if (margin > 20) {
                            quality = QUALITY.EXCELLENT;
                        } else if (margin > 10) {
                            quality = QUALITY.GOOD;
                        } else if (margin > 0) {
                            quality = QUALITY.DEGRADED;
                        } else {
                            quality = QUALITY.LOST;
                        }
                    }

                    link.quality = quality;

                    // Update visual style when quality changes
                    if (quality !== link.lastQuality) {
                        link.lastQuality = quality;

                        if (link.cesiumLine && link.cesiumLine.polyline) {
                            link.cesiumLine.polyline.material = DASH_MATERIALS[quality];
                            link.cesiumLine.polyline.width = QUALITY_WIDTHS[quality];
                        }

                        // Reset lost timer on transition to LOST
                        if (quality === QUALITY.LOST) {
                            link.lostTimer = 0;
                        }
                    }

                    // LOST links: flash red briefly then hide
                    if (quality === QUALITY.LOST) {
                        link.lostTimer += 0.5; // ~0.5s per 2Hz tick
                        if (link.lostTimer > 2.0) {
                            link.visible = false;
                        } else {
                            link.visible = true;
                        }
                    } else {
                        link.visible = true;
                        link.lostTimer = 0;
                    }
                }

                // Apply visibility
                var finalShow = showLinks && link.visible;
                if (link.cesiumLine) link.cesiumLine.show = finalShow;
                if (link.cesiumLabel) link.cesiumLabel.show = finalShow;
            }
        }

        cleanup(world) {
            if (world.viewer) {
                for (var i = 0; i < this._links.length; i++) {
                    var link = this._links[i];
                    if (link.cesiumLine) world.viewer.entities.remove(link.cesiumLine);
                    if (link.cesiumLabel) world.viewer.entities.remove(link.cesiumLabel);
                }
            }
            this._links = [];
        }
    }

    // Register component
    ComponentRegistry.register('visual', 'comm_link', CommLink);
})();
