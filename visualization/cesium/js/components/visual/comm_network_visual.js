/**
 * CommNetworkVisual component — renders communication links between entities
 * as Cesium polylines with directional pulse animation.
 *
 * Visualizes the comm network state for an entity by drawing lines to each
 * entity it has an active communication link with. Links are color-coded by
 * state (active, jammed, cyber-compromised) and direction (uplink/downlink).
 * Animated pulses flow along the link to indicate data direction.
 *
 * Reads from entity.state:
 *   _commLinks      — array of {targetId, quality, jammed, direction}
 *   _commJammed     — boolean, true if entity is currently jammed
 *   _commNetworks   — array of network IDs this entity belongs to
 *   _commCyber      — active cyber attack info or null
 *   _vizShow        — master visibility toggle
 *   _vizSensors     — sensor overlay visibility toggle
 *   _searchHighlight — search highlight flag
 *
 * Config (from scenario JSON):
 *   type: "comm_network"
 *   showLinks: true          — whether to show link lines
 *   showLabels: true         — show data rate labels at midpoints
 *   pulseAnimation: true     — enable pulse animation on links
 *   networkFilter: null      — null = show all, or array of network IDs to show
 *
 * Integrates with CommEngine (if loaded) for link quality data.
 * Gracefully degrades when CommEngine is not available.
 *
 * Registers as: visual/comm_network
 */
(function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // --- Constants ---
    var MAX_LINK_LINES = 200;       // max pooled polyline entities
    var MAX_LABELS = 50;            // max pooled label entities
    var MAX_PULSE_DOTS = 200;       // max pooled pulse point entities
    var UPDATE_HZ = 4;             // link visual update rate
    var LABEL_HZ = 2;             // label update rate
    var UPDATE_INTERVAL = 1.0 / UPDATE_HZ;
    var LABEL_INTERVAL = 1.0 / LABEL_HZ;
    var TWO_PI = 2 * Math.PI;

    // --- Link colors ---
    var COLOR_UPLINK_ACTIVE     = Cesium.Color.fromCssColorString('#00ff88');
    var COLOR_DOWNLINK_ACTIVE   = Cesium.Color.fromCssColorString('#4488ff');
    var COLOR_UPLINK_JAMMED     = Cesium.Color.fromCssColorString('#ff4444');
    var COLOR_DOWNLINK_JAMMED   = Cesium.Color.fromCssColorString('#ff2244');
    var COLOR_CYBER_COMPROMISED = Cesium.Color.fromCssColorString('#ffcc00');
    var COLOR_TARGETING         = Cesium.Color.fromCssColorString('#ff44ff'); // magenta for targeting data
    var COLOR_TRACK             = Cesium.Color.fromCssColorString('#44aaff'); // bright blue for track data
    var COLOR_FIBER             = Cesium.Color.fromCssColorString('#88ffff'); // cyan for fiber links
    var COLOR_PULSE_UP          = Cesium.Color.fromCssColorString('#88ffcc');
    var COLOR_PULSE_DOWN        = Cesium.Color.fromCssColorString('#88bbff');
    var COLOR_PULSE_JAMMED      = Cesium.Color.fromCssColorString('#ff8888');
    var COLOR_PULSE_CYBER       = Cesium.Color.fromCssColorString('#ffee44');
    var COLOR_PULSE_TARGETING   = Cesium.Color.fromCssColorString('#ff88ff');
    var COLOR_PULSE_TRACK       = Cesium.Color.fromCssColorString('#88ccff');

    // Reusable scratch Cartesian3 for interpolation
    var scratchLerp = new Cesium.Cartesian3();

    /**
     * Convert geodetic (radians) to Cesium Cartesian3.
     */
    function geodToCartesian(lat, lon, alt) {
        return Cesium.Cartesian3.fromRadians(lon, lat, alt);
    }

    /**
     * Compute midpoint between two Cartesian3 positions.
     */
    function midpoint(a, b) {
        return new Cesium.Cartesian3(
            (a.x + b.x) * 0.5,
            (a.y + b.y) * 0.5,
            (a.z + b.z) * 0.5
        );
    }

    /**
     * Format throughput in human-readable form.
     */
    function formatThroughput(bps) {
        if (bps === undefined || bps === null || isNaN(bps)) return '-- bps';
        if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' Gbps';
        if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mbps';
        if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' kbps';
        return Math.round(bps) + ' bps';
    }

    /**
     * Determine link color based on state.
     * @param {object} link — {targetId, quality, jammed, direction, cyberCompromised}
     * @returns {Cesium.Color}
     */
    function getLinkColor(link) {
        if (link.cyberCompromised) return COLOR_CYBER_COMPROMISED;
        if (link.jammed) {
            return link.direction === 'downlink' ? COLOR_DOWNLINK_JAMMED : COLOR_UPLINK_JAMMED;
        }
        // F2T2EA packet type colors
        if (link._activePacketType === 'targeting') return COLOR_TARGETING;
        if (link._activePacketType === 'track') return COLOR_TRACK;
        // Physical link types
        if (link._linkType === 'fiber') return COLOR_FIBER;
        if (link._linkType === 'laser') return Cesium.Color.fromCssColorString('#ffaa00');
        return link.direction === 'downlink' ? COLOR_DOWNLINK_ACTIVE : COLOR_UPLINK_ACTIVE;
    }

    /**
     * Get pulse dot color based on link state.
     */
    function getPulseColor(link) {
        if (link.cyberCompromised) return COLOR_PULSE_CYBER;
        if (link.jammed) return COLOR_PULSE_JAMMED;
        if (link._activePacketType === 'targeting') return COLOR_PULSE_TARGETING;
        if (link._activePacketType === 'track') return COLOR_PULSE_TRACK;
        return link.direction === 'downlink' ? COLOR_PULSE_DOWN : COLOR_PULSE_UP;
    }

    /**
     * Compute animated alpha for a link line using sine wave.
     * @param {number} simTime — current simulation time
     * @param {number} linkIndex — index for phase offset
     * @param {boolean} cyberCompromised — faster pulse for cyber attacks
     * @returns {number} alpha in [0.3, 1.0]
     */
    function computeLinkAlpha(simTime, linkIndex, cyberCompromised) {
        var speed = cyberCompromised ? 6.0 : 2.0;
        var phase = (simTime * speed + linkIndex * 0.5) % TWO_PI;
        return 0.3 + 0.7 * Math.abs(Math.sin(phase));
    }

    /**
     * Compute pulse dot position along a link (lerp between endpoints).
     * @param {Cesium.Cartesian3} from — source position
     * @param {Cesium.Cartesian3} to — destination position
     * @param {number} simTime — current time
     * @param {number} linkIndex — phase offset
     * @param {string} direction — 'uplink' or 'downlink'
     * @returns {Cesium.Cartesian3}
     */
    function computePulsePosition(from, to, simTime, linkIndex, direction) {
        // Pulse travels along the link over a 2-second cycle
        var cycleDuration = 2.0;
        var t = ((simTime + linkIndex * 0.3) % cycleDuration) / cycleDuration;
        // Reverse direction for downlink (pulse flows from target to source)
        if (direction === 'downlink') t = 1.0 - t;
        Cesium.Cartesian3.lerp(from, to, t, scratchLerp);
        return Cesium.Cartesian3.clone(scratchLerp);
    }

    // -----------------------------------------------------------------------
    // CommNetworkVisual Component
    // -----------------------------------------------------------------------
    class CommNetworkVisual extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._showLinks = config.showLinks !== false;
            this._showLabels = config.showLabels !== false;
            this._pulseAnimation = config.pulseAnimation !== false;
            this._networkFilter = config.networkFilter || null;

            // Entity pools
            this._linePool = [];         // Cesium polyline entities
            this._labelPool = [];        // Cesium label entities
            this._pulsePool = [];        // Cesium point entities (pulse dots)

            // Active counts
            this._activeLines = 0;
            this._activeLabels = 0;
            this._activePulses = 0;

            // Throttle timers
            this._updateAccum = 0;
            this._labelAccum = 0;

            // Cached positions for pulse dots (avoid per-frame allocation)
            this._cachedPulsePositions = [];

            // Cached link data from last update
            this._cachedLinks = [];
            this._cachedEndpoints = [];  // [{from: Cartesian3, to: Cartesian3}]
        }

        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var entity = this.entity;

            // --- Create polyline pool ---
            for (var i = 0; i < MAX_LINK_LINES; i++) {
                var lineEntity = viewer.entities.add({
                    name: entity.name + '_commLine_' + i,
                    polyline: {
                        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
                        width: 1.5,
                        material: COLOR_UPLINK_ACTIVE.withAlpha(0.5)
                    },
                    show: false
                });
                this._linePool.push(lineEntity);
            }

            // --- Create label pool ---
            if (this._showLabels) {
                for (var j = 0; j < MAX_LABELS; j++) {
                    var labelEntity = viewer.entities.add({
                        name: entity.name + '_commLabel_' + j,
                        position: Cesium.Cartesian3.ZERO,
                        label: {
                            text: '',
                            font: '10px monospace',
                            fillColor: Cesium.Color.WHITE,
                            outlineColor: Cesium.Color.BLACK,
                            outlineWidth: 2,
                            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                            pixelOffset: new Cesium.Cartesian2(0, -4),
                            scale: 0.8,
                            showBackground: true,
                            backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
                            backgroundPadding: new Cesium.Cartesian2(4, 2),
                            disableDepthTestDistance: Number.POSITIVE_INFINITY
                        },
                        show: false
                    });
                    this._labelPool.push(labelEntity);
                }
            }

            // --- Create pulse dot pool ---
            if (this._pulseAnimation) {
                for (var k = 0; k < MAX_PULSE_DOTS; k++) {
                    var cachedPos = new Cesium.Cartesian3();
                    this._cachedPulsePositions.push(cachedPos);

                    var self = this;
                    var pulseEntity = viewer.entities.add({
                        name: entity.name + '_commPulse_' + k,
                        position: new Cesium.CallbackProperty(
                            (function(idx) {
                                return function() {
                                    return self._cachedPulsePositions[idx];
                                };
                            })(k),
                            false
                        ),
                        point: {
                            pixelSize: 4,
                            color: COLOR_PULSE_UP,
                            outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
                            outlineWidth: 1,
                            disableDepthTestDistance: Number.POSITIVE_INFINITY
                        },
                        show: false
                    });
                    this._pulsePool.push(pulseEntity);
                }
            }

            // Initialize state outputs if not set
            if (!entity.state._commLinks) entity.state._commLinks = [];
            if (entity.state._commJammed === undefined) entity.state._commJammed = false;
            if (!entity.state._commNetworks) entity.state._commNetworks = [];
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;

            var state = entity.state;

            // Check visibility flags
            var vizShow = state._vizShow !== false;
            var vizSensors = state._vizSensors !== false;
            var visible = vizShow && vizSensors && this._showLinks;

            if (!visible) {
                this._hideAll();
                return;
            }

            // Throttle link geometry updates to UPDATE_HZ
            this._updateAccum += dt;
            var updateLinks = false;
            if (this._updateAccum >= UPDATE_INTERVAL) {
                this._updateAccum = 0;
                updateLinks = true;
            }

            // Throttle label updates to LABEL_HZ
            this._labelAccum += dt;
            var updateLabels = false;
            if (this._labelAccum >= LABEL_INTERVAL) {
                this._labelAccum = 0;
                updateLabels = true;
            }

            // Read comm links from entity state
            var commLinks = state._commLinks || [];

            // Apply network filter if configured
            var filteredLinks = commLinks;
            if (this._networkFilter && this._networkFilter.length > 0) {
                var networks = state._commNetworks || [];
                var hasMatchingNetwork = false;
                for (var n = 0; n < this._networkFilter.length; n++) {
                    if (networks.indexOf(this._networkFilter[n]) >= 0) {
                        hasMatchingNetwork = true;
                        break;
                    }
                }
                if (!hasMatchingNetwork) {
                    this._hideAll();
                    return;
                }
            }

            // Enrich link data from CommEngine if available
            var enrichedLinks = this._enrichLinks(filteredLinks, entity.id);

            if (updateLinks) {
                this._updateLinkLines(enrichedLinks, world);
                this._cachedLinks = enrichedLinks;
            }

            if (updateLabels && this._showLabels) {
                this._updateLabels(this._cachedLinks, world);
            }

            // Pulse animation runs every frame for smooth motion
            if (this._pulseAnimation) {
                this._updatePulses(this._cachedLinks, world);
            }
        }

        /**
         * Enrich link data with CommEngine quality/jammed/throughput info.
         * Falls back to raw state data if CommEngine is not loaded.
         */
        _enrichLinks(links, entityId) {
            var enriched = [];

            for (var i = 0; i < links.length; i++) {
                var link = links[i];
                var targetId = link.targetId;
                if (!targetId) continue;

                var enrichedLink = {
                    targetId: targetId,
                    quality: link.quality !== undefined ? link.quality : 1.0,
                    jammed: !!link.jammed,
                    direction: link.direction || 'uplink',
                    cyberCompromised: false,
                    throughput_bps: link.throughput_bps || 0,
                    alive: link.alive !== false,
                    priority: link.priority || 'normal',
                    _activePacketType: null,
                    _linkType: link.linkType || 'rf'
                };

                // Enrich from CommEngine
                if (typeof CommEngine !== 'undefined') {
                    try {
                        var status = CommEngine.getLinkStatus(entityId, targetId);
                        if (status) {
                            enrichedLink.quality = status.quality !== undefined ? status.quality : enrichedLink.quality;
                            enrichedLink.jammed = !!status.jammed;
                            enrichedLink.cyberCompromised = !!status.cyberCompromised;
                            enrichedLink.throughput_bps = status.throughput_bps || enrichedLink.throughput_bps;
                            enrichedLink.alive = status.alive !== false;
                            if (status.linkType) enrichedLink._linkType = status.linkType;
                            if (status._activePacketType) enrichedLink._activePacketType = status._activePacketType;
                        }
                    } catch (e) {
                        // CommEngine error — use raw state data
                    }
                }

                // Check entity-level cyber compromise
                if (this.entity.state._commCyber) {
                    enrichedLink.cyberCompromised = true;
                }

                // Only include alive links
                if (enrichedLink.alive) {
                    enriched.push(enrichedLink);
                }
            }

            return enriched;
        }

        /**
         * Update polyline pool with current link geometry and colors.
         * Only draws lines where this entity's ID < target ID to avoid duplicates.
         */
        _updateLinkLines(links, world) {
            var viewer = world.viewer;
            if (!viewer) return;

            var state = this.entity.state;
            var myPos = geodToCartesian(state.lat, state.lon, state.alt || 0);
            var entityId = this.entity.id;
            var highlighted = !!state._searchHighlight;

            var lineIdx = 0;
            this._cachedEndpoints = [];

            for (var i = 0; i < links.length; i++) {
                if (lineIdx >= MAX_LINK_LINES) break;

                var link = links[i];
                var targetId = link.targetId;

                // De-duplicate: only draw if our ID < target ID
                if (entityId >= targetId) continue;

                var target = world.getEntity(targetId);
                if (!target || !target.active) continue;

                var tgtState = target.state;
                if (tgtState.lat === undefined || tgtState.lon === undefined) continue;

                var tgtPos = geodToCartesian(tgtState.lat, tgtState.lon, tgtState.alt || 0);

                // Determine color
                var baseColor = getLinkColor(link);
                var alpha = this._pulseAnimation
                    ? computeLinkAlpha(world.simTime, i, link.cyberCompromised)
                    : (link.quality !== undefined ? 0.3 + 0.5 * link.quality : 0.6);
                var lineColor = baseColor.withAlpha(alpha);

                // Line width: thicker for priority links, packet types, or search highlights
                var width = 1.5;
                if (link._activePacketType === 'targeting') width = 3.0;
                else if (link._activePacketType === 'track') width = 2.5;
                else if (link._linkType === 'fiber') width = 2.0;
                if (link.priority === 'high' || link.priority === 'critical') width = Math.max(width, 2.5);
                if (highlighted) width = Math.max(width, 3.0);

                // Update pooled line entity
                var lineEntity = this._linePool[lineIdx];
                lineEntity.polyline.positions = [myPos, tgtPos];
                lineEntity.polyline.width = width;
                lineEntity.polyline.material = lineColor;
                lineEntity.show = true;

                // Cache endpoints for pulse and label use
                this._cachedEndpoints.push({
                    from: myPos,
                    to: tgtPos,
                    link: link
                });

                lineIdx++;
            }

            // Hide unused lines
            for (var j = lineIdx; j < this._activeLines; j++) {
                this._linePool[j].show = false;
            }
            // Also hide any lines beyond previous count (safety)
            for (var k = this._activeLines; k < lineIdx; k++) {
                // Already shown above
            }
            this._activeLines = lineIdx;

            // Hide excess from previous frame
            for (var m = lineIdx; m < this._linePool.length; m++) {
                if (this._linePool[m].show) this._linePool[m].show = false;
            }
        }

        /**
         * Update midpoint labels with throughput or status text.
         */
        _updateLabels(links, world) {
            if (!this._showLabels) return;

            var entityId = this.entity.id;
            var labelIdx = 0;

            for (var i = 0; i < this._cachedEndpoints.length; i++) {
                if (labelIdx >= MAX_LABELS) break;

                var endpoint = this._cachedEndpoints[i];
                var link = endpoint.link;

                // Compute midpoint
                var mid = midpoint(endpoint.from, endpoint.to);

                // Determine label text and color
                var text = '';
                var fillColor = Cesium.Color.WHITE;

                if (link.cyberCompromised) {
                    text = 'COMPROMISED';
                    fillColor = COLOR_CYBER_COMPROMISED;
                } else if (link.jammed) {
                    text = 'JAMMED';
                    fillColor = COLOR_UPLINK_JAMMED;
                } else if (link.throughput_bps > 0) {
                    text = formatThroughput(link.throughput_bps);
                    fillColor = getLinkColor(link);
                } else {
                    // Quality indicator
                    var q = link.quality !== undefined ? link.quality : 1.0;
                    text = 'Q:' + (q * 100).toFixed(0) + '%';
                    fillColor = getLinkColor(link);
                }

                var labelEntity = this._labelPool[labelIdx];
                labelEntity.position = mid;
                labelEntity.label.text = text;
                labelEntity.label.fillColor = fillColor;
                labelEntity.show = true;
                labelIdx++;
            }

            // Hide unused labels
            for (var j = labelIdx; j < this._labelPool.length; j++) {
                if (this._labelPool[j].show) this._labelPool[j].show = false;
            }
            this._activeLabels = labelIdx;
        }

        /**
         * Update pulse dot positions along link lines (runs every frame).
         */
        _updatePulses(links, world) {
            if (!this._pulseAnimation) return;

            var pulseIdx = 0;

            for (var i = 0; i < this._cachedEndpoints.length; i++) {
                if (pulseIdx >= MAX_PULSE_DOTS) break;

                var endpoint = this._cachedEndpoints[i];
                var link = endpoint.link;

                // Compute pulse position along the link
                var pulsePos = computePulsePosition(
                    endpoint.from, endpoint.to,
                    world.simTime, i,
                    link.direction || 'uplink'
                );

                // Update cached position for CallbackProperty
                Cesium.Cartesian3.clone(pulsePos, this._cachedPulsePositions[pulseIdx]);

                // Update pulse dot color
                var pulseEntity = this._pulsePool[pulseIdx];
                var pulseColor = getPulseColor(link);
                pulseEntity.point.color = pulseColor;
                pulseEntity.point.pixelSize = link.cyberCompromised ? 5 : 4;
                pulseEntity.show = true;

                pulseIdx++;

                // For bidirectional links, add a second pulse going the other way
                if (link.direction === 'both' && pulseIdx < MAX_PULSE_DOTS) {
                    var reversePulsePos = computePulsePosition(
                        endpoint.from, endpoint.to,
                        world.simTime, i,
                        'downlink'
                    );

                    Cesium.Cartesian3.clone(reversePulsePos, this._cachedPulsePositions[pulseIdx]);

                    var reversePulseEntity = this._pulsePool[pulseIdx];
                    reversePulseEntity.point.color = COLOR_PULSE_DOWN;
                    reversePulseEntity.point.pixelSize = 4;
                    reversePulseEntity.show = true;

                    pulseIdx++;
                }
            }

            // Hide unused pulse dots
            for (var j = pulseIdx; j < this._pulsePool.length; j++) {
                if (this._pulsePool[j].show) this._pulsePool[j].show = false;
            }
            this._activePulses = pulseIdx;
        }

        /**
         * Hide all visual elements (lines, labels, pulses).
         */
        _hideAll() {
            for (var i = 0; i < this._linePool.length; i++) {
                if (this._linePool[i].show) this._linePool[i].show = false;
            }
            for (var j = 0; j < this._labelPool.length; j++) {
                if (this._labelPool[j].show) this._labelPool[j].show = false;
            }
            for (var k = 0; k < this._pulsePool.length; k++) {
                if (this._pulsePool[k].show) this._pulsePool[k].show = false;
            }
            this._activeLines = 0;
            this._activeLabels = 0;
            this._activePulses = 0;
        }

        /**
         * Remove all Cesium entities created by this component.
         */
        cleanup(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            for (var i = 0; i < this._linePool.length; i++) {
                viewer.entities.remove(this._linePool[i]);
            }
            for (var j = 0; j < this._labelPool.length; j++) {
                viewer.entities.remove(this._labelPool[j]);
            }
            for (var k = 0; k < this._pulsePool.length; k++) {
                viewer.entities.remove(this._pulsePool[k]);
            }

            this._linePool = [];
            this._labelPool = [];
            this._pulsePool = [];
            this._cachedPulsePositions = [];
            this._cachedEndpoints = [];
            this._cachedLinks = [];
            this._activeLines = 0;
            this._activeLabels = 0;
            this._activePulses = 0;
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { key: 'showLinks',      label: 'Show Links',       type: 'boolean', default: true },
                { key: 'showLabels',      label: 'Show Labels',      type: 'boolean', default: true },
                { key: 'pulseAnimation',  label: 'Pulse Animation',  type: 'boolean', default: true },
                { key: 'networkFilter',   label: 'Network Filter',   type: 'text',    default: '' }
            ];
        }
    }

    // Register with framework
    ComponentRegistry.register('visual', 'comm_network', CommNetworkVisual);
})();
