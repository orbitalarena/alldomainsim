/**
 * RadarSensor component — scanning radar that detects entities on opposing teams.
 *
 * Simulates a rotating search radar with configurable range, field of view,
 * scan rate, and detection probability. Writes detection results to
 * entity.state._detections each sweep interval.
 *
 * Config (from scenario JSON, all optional):
 *   maxRange_m:            150000   — maximum detection range in meters
 *   fov_deg:               120      — azimuth field of view in degrees
 *   minElevation_deg:      2        — minimum elevation above horizon
 *   scanRate_dps:          60       — scan rate in degrees per second
 *   detectionProbability:  0.85     — probability of detecting a valid target
 *   updateInterval:        0.5      — seconds between detection sweeps
 *   team:                  (entity) — inherited; detects entities on other teams
 *
 * State outputs (written to entity.state):
 *   _detections:   Array of { targetId, targetName, range_m, bearing_deg,
 *                              elevation_deg, detected }
 *   _radarScanAz:  Current scan azimuth in degrees (0-360)
 *
 * Visual elements (Cesium):
 *   Dashed polylines from this entity to each detected target. Green for
 *   friendly detection, red for hostile. Uses a pool of up to 20 line
 *   entities to avoid per-frame allocation.
 *
 * Registers as: sensors/radar
 */
const RadarSensor = (function() {
    'use strict';

    var DEG = FrameworkConstants.DEG;
    var RAD = FrameworkConstants.RAD;
    var R_EARTH = FrameworkConstants.R_EARTH;

    // Maximum number of pooled Cesium polyline entities for detection lines
    var MAX_DETECTION_LINES = 20;

    // -----------------------------------------------------------------------
    // Utility: geodetic distance, bearing, and elevation
    // -----------------------------------------------------------------------

    /**
     * Convert geodetic coordinates (lat/lon in radians, alt in meters) to
     * Cesium Cartesian3. Uses Cesium's WGS84 ellipsoid internally.
     * @param {number} lat  Latitude in radians
     * @param {number} lon  Longitude in radians
     * @param {number} alt  Altitude in meters
     * @returns {Cesium.Cartesian3}
     */
    function geodToCartesian(lat, lon, alt) {
        return Cesium.Cartesian3.fromRadians(lon, lat, alt);
    }

    /**
     * Compute straight-line range between two geodetic positions.
     * Uses Cartesian3 distance for accuracy across all altitude regimes.
     * @param {number} lat1  Radians
     * @param {number} lon1  Radians
     * @param {number} alt1  Meters
     * @param {number} lat2  Radians
     * @param {number} lon2  Radians
     * @param {number} alt2  Meters
     * @returns {number} Range in meters
     */
    function computeRange(lat1, lon1, alt1, lat2, lon2, alt2) {
        var c1 = geodToCartesian(lat1, lon1, alt1);
        var c2 = geodToCartesian(lat2, lon2, alt2);
        return Cesium.Cartesian3.distance(c1, c2);
    }

    /**
     * Compute initial bearing from position 1 to position 2 using the
     * forward azimuth formula on a sphere.
     * @param {number} lat1  Radians
     * @param {number} lon1  Radians
     * @param {number} lat2  Radians
     * @param {number} lon2  Radians
     * @returns {number} Bearing in degrees [0, 360)
     */
    function computeBearing(lat1, lon1, lat2, lon2) {
        var dLon = lon2 - lon1;
        var y = Math.sin(dLon) * Math.cos(lat2);
        var x = Math.cos(lat1) * Math.sin(lat2) -
                Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        var brng = Math.atan2(y, x) * RAD;
        return (brng + 360) % 360;
    }

    /**
     * Compute elevation angle from position 1 looking toward position 2.
     * Uses the arc distance along the surface and the altitude difference
     * to derive a geometric elevation angle.
     * @param {number} lat1  Radians
     * @param {number} lon1  Radians
     * @param {number} alt1  Meters
     * @param {number} lat2  Radians
     * @param {number} lon2  Radians
     * @param {number} alt2  Meters
     * @returns {number} Elevation angle in degrees (positive = above horizon)
     */
    function computeElevation(lat1, lon1, alt1, lat2, lon2, alt2) {
        // Central angle via haversine
        var dLat = lat2 - lat1;
        var dLon = lon2 - lon1;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1) * Math.cos(lat2) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        var centralAngle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        // Surface arc distance at observer altitude
        var surfDist = (R_EARTH + alt1) * centralAngle;

        // Altitude difference
        var dAlt = alt2 - alt1;

        // Elevation angle: atan2(vertical, horizontal)
        if (surfDist < 1) {
            // Targets nearly colocated — elevation is purely vertical
            return dAlt >= 0 ? 90 : -90;
        }
        return Math.atan2(dAlt, surfDist) * RAD;
    }

    // -----------------------------------------------------------------------
    // RadarSensor Component
    // -----------------------------------------------------------------------

    class RadarSensor extends ECS.Component {
        constructor(config) {
            super(config);

            // Merge defaults into config
            var c = this.config;
            this._maxRange    = c.maxRange_m           !== undefined ? c.maxRange_m           : 150000;
            this._fov         = c.fov_deg              !== undefined ? c.fov_deg              : 120;
            this._minElev     = c.minElevation_deg     !== undefined ? c.minElevation_deg     : 2;
            this._scanRate    = c.scanRate_dps         !== undefined ? c.scanRate_dps         : 60;
            this._pDetect     = c.detectionProbability !== undefined ? c.detectionProbability : 0.85;
            this._interval    = c.updateInterval       !== undefined ? c.updateInterval       : 0.5;

            // Internal timing
            this._accumDt = 0;
            this._scanAz  = 0;   // current scan azimuth in degrees

            // Cesium visual pool
            this._linePool    = [];   // array of Cesium.Entity (polylines)
            this._activeLines = 0;    // how many lines are currently visible

            // Cached materials (created in init)
            this._matRed     = null;
            this._matBlue    = null;
            this._matNeutral = null;
        }

        /**
         * Initialize Cesium detection line pool.
         * Each pooled entity is a dashed polyline, initially hidden.
         */
        init(world) {
            var viewer = world.viewer;
            if (!viewer) return;

            // Initialize state outputs
            this.entity.state._detections  = [];
            this.entity.state._radarScanAz = 0;

            // Pre-create reusable dash materials (avoid per-sweep allocation)
            this._matRed = new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.RED.withAlpha(0.7),
                dashLength: 12.0
            });
            this._matBlue = new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.LIME.withAlpha(0.7),
                dashLength: 12.0
            });
            this._matNeutral = new Cesium.PolylineDashMaterialProperty({
                color: Cesium.Color.YELLOW.withAlpha(0.7),
                dashLength: 12.0
            });

            // Create polyline pool
            for (var i = 0; i < MAX_DETECTION_LINES; i++) {
                var lineEntity = viewer.entities.add({
                    name: this.entity.name + '_radarLine_' + i,
                    polyline: {
                        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
                        width: 1.5,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.LIME,
                            dashLength: 12.0
                        })
                    },
                    show: false
                });
                this._linePool.push(lineEntity);
            }
        }

        /**
         * Main update loop. Accumulates dt and processes a radar sweep
         * at the configured update interval.
         * @param {number} dt   Sim-time delta in seconds
         * @param {ECS.World} world
         */
        update(dt, world) {
            this._accumDt += dt;

            // Advance scan azimuth continuously (visual feedback even between sweeps)
            this._scanAz = (this._scanAz + this._scanRate * dt) % 360;
            this.entity.state._radarScanAz = this._scanAz;

            // Only run full detection logic at the update interval
            if (this._accumDt < this._interval) return;

            var elapsed = this._accumDt;
            this._accumDt = 0;

            // Own entity position
            var state = this.entity.state;
            var ownLat = state.lat;
            var ownLon = state.lon;
            var ownAlt = state.alt || 0;
            var ownTeam = this.entity.team;

            // Validate own position
            if (ownLat === undefined || ownLon === undefined) return;

            // Half FOV for bearing check
            var halfFov = this._fov / 2;

            // Scan center: the azimuth at the middle of the current sweep arc.
            // Over the elapsed interval the radar swept scanRate * elapsed degrees.
            // We treat the center of the swept arc as the scan center.
            var sweepArc = this._scanRate * elapsed;
            var scanCenter = (this._scanAz - sweepArc / 2 + 360) % 360;

            // Effective angular coverage: FOV + sweep arc (targets within FOV
            // at any point during the sweep interval)
            var effectiveHalfCoverage = halfFov + sweepArc / 2;
            // Clamp to 180 to avoid wrap-around ambiguity
            if (effectiveHalfCoverage > 180) effectiveHalfCoverage = 180;

            var detections = [];

            // Iterate all entities in the world
            var self = this;
            world.entities.forEach(function(target) {
                // Skip self, inactive, or same-team entities
                if (target.id === self.entity.id) return;
                if (!target.active) return;
                if (target.team === ownTeam) return;

                var ts = target.state;
                if (ts.lat === undefined || ts.lon === undefined) return;

                var tLat = ts.lat;
                var tLon = ts.lon;
                var tAlt = ts.alt || 0;

                // Skip ground-to-ground (both below 100m — radar can't see surface clutter)
                if (ownAlt < 100 && tAlt < 100) return;

                // Range check (fast reject)
                var range = computeRange(ownLat, ownLon, ownAlt, tLat, tLon, tAlt);
                if (range > self._maxRange) return;

                // Bearing from own entity to target
                var bearing = computeBearing(ownLat, ownLon, tLat, tLon);

                // Elevation angle
                var elevation = computeElevation(ownLat, ownLon, ownAlt, tLat, tLon, tAlt);

                // Check minimum elevation (targets below radar horizon)
                if (elevation < self._minElev) return;

                // Check if bearing is within the effective scan coverage
                var bearingDelta = bearing - scanCenter;
                // Normalize to [-180, 180]
                if (bearingDelta > 180) bearingDelta -= 360;
                if (bearingDelta < -180) bearingDelta += 360;
                if (Math.abs(bearingDelta) > effectiveHalfCoverage) return;

                // Apply detection probability (seeded RNG for MC determinism)
                var rng = world.rng;
                var detected = rng ? rng.bernoulli(self._pDetect) : (Math.random() < self._pDetect);

                detections.push({
                    targetId:      target.id,
                    targetName:    target.name,
                    range_m:       range,
                    bearing_deg:   bearing,
                    elevation_deg: elevation,
                    detected:      detected
                });
            });

            // Write detections to entity state
            self.entity.state._detections = detections;

            // Update Cesium detection lines
            self._updateVisuals(world, detections);
        }

        /**
         * Update the Cesium polyline pool to show detection lines.
         * Lines are drawn from this entity to each detected (detected===true) target.
         * @param {ECS.World} world
         * @param {Array} detections
         */
        _updateVisuals(world, detections) {
            var viewer = world.viewer;
            if (!viewer) return;

            var state = this.entity.state;
            var ownPos = geodToCartesian(state.lat, state.lon, state.alt || 0);
            var lineIdx = 0;

            for (var i = 0; i < detections.length; i++) {
                var det = detections[i];
                if (!det.detected) continue;
                if (lineIdx >= MAX_DETECTION_LINES) break;

                // Look up the target entity for its position
                var target = world.getEntity(det.targetId);
                if (!target) continue;

                var ts = target.state;
                var tgtPos = geodToCartesian(ts.lat, ts.lon, ts.alt || 0);

                // Use cached materials (avoid per-sweep allocation)
                var lineMat = (target.team === 'red') ? this._matRed
                            : (target.team === 'blue') ? this._matBlue
                            : this._matNeutral;

                var line = this._linePool[lineIdx];
                line.polyline.positions = [ownPos, tgtPos];
                line.polyline.material = lineMat;
                line.show = true;
                lineIdx++;
            }

            // Hide remaining pooled lines
            for (var j = lineIdx; j < this._linePool.length; j++) {
                this._linePool[j].show = false;
            }

            this._activeLines = lineIdx;
        }

        /**
         * Remove all Cesium entities created by this component.
         * @param {ECS.World} world
         */
        cleanup(world) {
            if (world.viewer) {
                for (var i = 0; i < this._linePool.length; i++) {
                    world.viewer.entities.remove(this._linePool[i]);
                }
            }
            this._linePool = [];
            this._activeLines = 0;
        }

        /**
         * Editor schema for the scenario builder UI.
         * Returns field definitions for each configurable parameter.
         * @returns {Array}
         */
        static editorSchema() {
            return [
                { key: 'maxRange_m',           label: 'Max Range (m)',       type: 'number', default: 150000, min: 1000,  max: 500000 },
                { key: 'fov_deg',              label: 'FOV (deg)',           type: 'number', default: 120,    min: 10,    max: 360 },
                { key: 'minElevation_deg',     label: 'Min Elevation (deg)', type: 'number', default: 2,      min: -10,   max: 45 },
                { key: 'scanRate_dps',         label: 'Scan Rate (deg/s)',   type: 'number', default: 60,     min: 1,     max: 360 },
                { key: 'detectionProbability', label: 'Detect Probability',  type: 'number', default: 0.85,   min: 0,     max: 1, step: 0.01 },
                { key: 'updateInterval',       label: 'Update Interval (s)', type: 'number', default: 0.5,    min: 0.1,   max: 5, step: 0.1 }
            ];
        }
    }

    return RadarSensor;
})();

// Register with the component registry
ComponentRegistry.register('sensors', 'radar', RadarSensor);
