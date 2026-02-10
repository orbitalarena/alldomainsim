/**
 * CommEngine -- Runtime communications simulation engine.
 *
 * Simulates packet routing, link budgets, jamming, cyber attacks, and
 * network health across multi-domain entities. Called from the live sim
 * tick loop to update link states, route packets, and apply EW effects.
 *
 * Network data model comes from CommDesigner (networks array with members,
 * topology type, and RF config). The engine builds a link graph from the
 * network definitions and maintains per-link state each frame.
 *
 * Public API:
 *   CommEngine.init(networks, world)
 *   CommEngine.tick(dt, world)
 *   CommEngine.sendPacket(packet)
 *   CommEngine.getNetworkStatus()
 *   CommEngine.getLinkStatus(fromId, toId)
 *   CommEngine.getEntityComms(entityId)
 *   CommEngine.addJammer(jammerId, config)
 *   CommEngine.removeJammer(jammerId)
 *   CommEngine.addCyberAttack(attack)
 *   CommEngine.getPacketLog()
 *   CommEngine.getMetrics()
 *   CommEngine.destroy()
 */
(function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------
    var C_LIGHT = 299792458;                       // m/s
    var BOLTZMANN_DBW = -228.6;                    // dBW/Hz/K (Boltzmann constant)
    var THERMAL_NOISE_TEMP_K = 290;                // standard noise temperature
    var PI = Math.PI;
    var LOG10 = Math.log10 || function(x) { return Math.log(x) / Math.LN10; };
    var R_EARTH = (typeof FrameworkConstants !== 'undefined')
        ? FrameworkConstants.R_EARTH : 6371000;

    // Throttle intervals
    var LINK_UPDATE_HZ = 4;                        // link budget recomputation rate
    var ROUTE_UPDATE_HZ = 2;                       // routing recomputation rate
    var TRACK_GEN_INTERVAL_S = 2;                  // auto-track packet generation interval
    var METRIC_WINDOW_S = 30;                      // sliding window for throughput metrics

    // Packet log circular buffer size
    var PACKET_LOG_MAX = 1000;

    // Link quality thresholds (margin in dB)
    var MARGIN_EXCELLENT = 20;
    var MARGIN_GOOD = 10;
    var MARGIN_DEGRADED = 0;

    // Jammer-to-signal threshold for link kill (dB)
    var JS_KILL_THRESHOLD = 0;       // J/S > 0 dB => jammed
    var JS_DEGRADE_THRESHOLD = -6;   // J/S > -6 dB => degraded

    // Cyber attack defaults
    var CYBER_DDOS_BW_FACTOR = 0.05;  // DDoS reduces bandwidth to 5%

    // Quality enum
    var QUALITY = {
        EXCELLENT: 'EXCELLENT',
        GOOD:      'GOOD',
        DEGRADED:  'DEGRADED',
        LOST:      'LOST'
    };

    // Packet drop reasons
    var DROP = {
        NO_ROUTE:      'no_route',
        TTL_EXCEEDED:  'ttl_exceeded',
        LINK_LOST:     'link_lost',
        JAMMED:        'jammed',
        CYBER:         'cyber',
        BANDWIDTH:     'bandwidth',
        EXPIRED:       'expired',
        NODE_DEAD:     'node_dead'
    };

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _initialized = false;
    var _networks = [];                           // network definitions
    var _networkMap = new Map();                   // networkId -> network def
    var _links = new Map();                       // "fromId:toId" -> LinkState
    var _entityNetworks = new Map();              // entityId -> Set<networkId>
    var _entityNodes = new Map();                 // entityId -> NodeState
    var _jammers = new Map();                     // jammerId -> Jammer
    var _cyberAttacks = new Map();                // attackId -> CyberAttack
    var _packets = [];                            // active in-flight packets
    var _packetLog = [];                          // circular buffer of completed packets
    var _packetLogIdx = 0;                        // next write index in circular buffer
    var _packetLogFull = false;                   // has the buffer wrapped?
    var _nextPacketId = 1;
    var _world = null;

    // Throttle accumulators
    var _linkAccum = 0;
    var _routeAccum = 0;
    var _trackGenAccum = 0;

    // Metrics
    var _metrics = {
        totalPacketsSent: 0,
        totalPacketsDelivered: 0,
        totalPacketsDropped: 0,
        totalBytesSent: 0,
        totalBytesDelivered: 0,
        avgLatency_ms: 0,
        packetDeliveryRate: 1.0,
        // Sliding window
        windowPacketsSent: 0,
        windowPacketsDelivered: 0,
        windowBytesDelivered: 0,
        windowLatencySum: 0,
        windowLatencyCount: 0,
        windowStart: 0
    };

    // Scratch Cartesian3 for distance/LOS computations
    var _scratchA = null;
    var _scratchB = null;
    var _scratchMid = null;

    function _ensureScratch() {
        if (!_scratchA && typeof Cesium !== 'undefined') {
            _scratchA = new Cesium.Cartesian3();
            _scratchB = new Cesium.Cartesian3();
            _scratchMid = new Cesium.Cartesian3();
        }
    }

    // -----------------------------------------------------------------------
    // Utility: Geodetic to Cartesian3
    // -----------------------------------------------------------------------

    /**
     * Convert lat (rad), lon (rad), alt (m) to Cesium Cartesian3.
     * Falls back to manual WGS84 if Cesium is not available.
     */
    function geodToCartesian(lat, lon, alt) {
        if (typeof Cesium !== 'undefined') {
            return Cesium.Cartesian3.fromRadians(lon, lat, alt || 0);
        }
        // Manual WGS84 fallback
        var a = 6378137.0;
        var f = 1 / 298.257223563;
        var e2 = 2 * f - f * f;
        var sinLat = Math.sin(lat);
        var cosLat = Math.cos(lat);
        var sinLon = Math.sin(lon);
        var cosLon = Math.cos(lon);
        var N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        var x = (N + alt) * cosLat * cosLon;
        var y = (N + alt) * cosLat * sinLon;
        var z = (N * (1 - e2) + alt) * sinLat;
        return { x: x, y: y, z: z };
    }

    /**
     * Compute distance between two Cartesian3 positions.
     */
    function cartesianDistance(a, b) {
        if (typeof Cesium !== 'undefined' && a instanceof Cesium.Cartesian3) {
            return Cesium.Cartesian3.distance(a, b);
        }
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Compute magnitude of a Cartesian3 vector.
     */
    function cartesianMagnitude(v) {
        if (typeof Cesium !== 'undefined' && v instanceof Cesium.Cartesian3) {
            return Cesium.Cartesian3.magnitude(v);
        }
        return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }

    /**
     * Compute dot product of two Cartesian3 vectors.
     */
    function cartesianDot(a, b) {
        if (typeof Cesium !== 'undefined' && a instanceof Cesium.Cartesian3) {
            return Cesium.Cartesian3.dot(a, b);
        }
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    // -----------------------------------------------------------------------
    // Line-of-sight check
    // -----------------------------------------------------------------------

    /**
     * Check line-of-sight between two ECEF positions.
     * Uses the minimum distance from Earth center to the line segment
     * between the two positions. If this minimum distance is less than
     * R_EARTH, the line passes through Earth and LOS is blocked.
     *
     * For high-accuracy: parametric closest approach to origin on segment.
     */
    function hasLineOfSight(posA, posB) {
        var magA = cartesianMagnitude(posA);
        var magB = cartesianMagnitude(posB);
        if (magA === 0 || magB === 0) return false;

        // Vector from A to B
        var dx = posB.x - posA.x;
        var dy = posB.y - posA.y;
        var dz = posB.z - posA.z;

        // Parametric: P(t) = A + t*(B-A), find t where |P(t)|^2 is minimized
        // d/dt |P(t)|^2 = 0 => t = -dot(A, B-A) / |B-A|^2
        var abDot = posA.x * dx + posA.y * dy + posA.z * dz;
        var abLen2 = dx * dx + dy * dy + dz * dz;

        if (abLen2 < 1e-6) return true; // coincident points

        var t = -abDot / abLen2;

        // Clamp to [0, 1] (the segment)
        if (t < 0) t = 0;
        if (t > 1) t = 1;

        // Point on segment closest to Earth center
        var px = posA.x + t * dx;
        var py = posA.y + t * dy;
        var pz = posA.z + t * dz;

        var minDist = Math.sqrt(px * px + py * py + pz * pz);

        // If the closest approach is below Earth surface, no LOS
        return minDist > R_EARTH;
    }

    // -----------------------------------------------------------------------
    // Link Budget Computation
    // -----------------------------------------------------------------------

    /**
     * Compute free-space path loss in dB.
     * FSPL = 20*log10(d) + 20*log10(f_hz) + 20*log10(4*PI/c)
     */
    function computeFSPL(distance_m, frequency_hz) {
        if (distance_m <= 0 || frequency_hz <= 0) return 0;
        return 20 * LOG10(distance_m)
             + 20 * LOG10(frequency_hz)
             + 20 * LOG10(4 * PI / C_LIGHT);
    }

    /**
     * Compute atmospheric attenuation (simplified).
     * For RF links, rough attenuation based on frequency band.
     * Returns attenuation in dB.
     */
    function computeAtmosAttenuation(linkType, frequency_ghz, distance_m, altFrom_m, altTo_m) {
        if (linkType === 'fiber') return 0;       // fiber has no free-space attenuation
        if (linkType === 'laser') {
            // Laser: high attenuation through atmosphere, near-zero in vacuum
            var avgAlt = (altFrom_m + altTo_m) / 2;
            if (avgAlt > 100000) return 0;         // above atmosphere
            // Rough: 1 dB/km in clear air below 10km, decays with altitude
            var pathKm = distance_m / 1000;
            var altFactor = Math.exp(-avgAlt / 8500);  // scale height ~8.5km
            return Math.min(40, 0.5 * pathKm * altFactor);
        }
        // RF: frequency-dependent
        if (frequency_ghz <= 0) return 0;
        var pathKm = distance_m / 1000;
        var avgAlt = (altFrom_m + altTo_m) / 2;
        // Attenuation only through troposphere (below ~12km)
        var tropoFraction = Math.max(0, 1 - avgAlt / 12000);
        var ratePerKm;
        if (frequency_ghz > 30) {
            ratePerKm = 0.2;         // Ka-band and above
        } else if (frequency_ghz > 10) {
            ratePerKm = 0.05;        // Ku-band
        } else if (frequency_ghz > 1) {
            ratePerKm = 0.01;        // C/X-band
        } else {
            ratePerKm = 0.005;       // L/S-band
        }
        var atten = ratePerKm * pathKm * tropoFraction;
        return Math.min(atten, 30);   // cap at 30 dB
    }

    /**
     * Compute rain fade attenuation in dB.
     * Applicable for frequencies above ~10 GHz.
     * Uses ITU-R P.838 simplified model.
     */
    function computeRainFade(frequency_ghz, distance_m, rain_mm_hr) {
        if (frequency_ghz < 10 || !rain_mm_hr || rain_mm_hr <= 0) return 0;

        // Simplified specific attenuation: gamma_R = k * R^alpha (dB/km)
        // Approximate coefficients for common bands
        var k, alpha;
        if (frequency_ghz < 15) {
            k = 0.01217; alpha = 1.152;       // Ku low
        } else if (frequency_ghz < 25) {
            k = 0.04481; alpha = 1.123;       // Ku/Ka
        } else if (frequency_ghz < 40) {
            k = 0.1165;  alpha = 1.074;       // Ka
        } else {
            k = 0.2051;  alpha = 1.034;       // V-band+
        }

        var specificAtten = k * Math.pow(rain_mm_hr, alpha);  // dB/km
        var effectivePathKm = Math.min(distance_m / 1000, 10); // rain cell size ~10km
        return specificAtten * effectivePathKm;
    }

    /**
     * Compute thermal noise floor in dBW for a given bandwidth.
     * N = k*T*B (watts), in dBW: N_dBW = -228.6 + 10*log10(T) + 10*log10(B_hz)
     */
    function thermalNoiseFloor_dBW(bandwidth_hz) {
        if (bandwidth_hz <= 0) bandwidth_hz = 1e6;
        return BOLTZMANN_DBW + 10 * LOG10(THERMAL_NOISE_TEMP_K) + 10 * LOG10(bandwidth_hz);
    }

    /**
     * Full link budget computation.
     * Returns { margin_db, quality, snir_db, effectiveDataRate_bps,
     *           distance_m, hasLOS, fspl_db, atmosAtten_db, rainFade_db,
     *           rxPower_dbw, noiseFloor_dbw, jamPower_dbw }
     */
    function computeLinkBudget(link, fromPos, toPos, fromAlt, toAlt) {
        var cfg = link.config;
        var dist = cartesianDistance(fromPos, toPos);
        var los = hasLineOfSight(fromPos, toPos);

        var result = {
            distance_m: dist,
            hasLOS: los,
            margin_db: -999,
            quality: QUALITY.LOST,
            snir_db: -999,
            effectiveDataRate_bps: 0,
            fspl_db: 0,
            atmosAtten_db: 0,
            rainFade_db: 0,
            rxPower_dbw: -999,
            noiseFloor_dbw: -999,
            jamPower_dbw: -999
        };

        // Fiber links: immune to jamming, fixed high bandwidth, latency = distance/c
        if (link.linkType === 'fiber') {
            // Fiber only works between ground stations (both < 1km altitude)
            if ((fromAlt || 0) > 1000 || (toAlt || 0) > 1000) {
                result.quality = QUALITY.LOST;
                return result;
            }
            result.hasLOS = true; // Fiber doesn't need LOS
            result.quality = QUALITY.EXCELLENT;
            result.margin_db = 50; // Fiber has huge margin
            result.snir_db = 60;
            result.effectiveDataRate_bps = (cfg.dataRate_mbps || 10000) * 1e6; // 10 Gbps default
            result.jamPower_dbw = -999; // Immune to RF jamming
            result.rxPower_dbw = 0; // Not applicable
            result.noiseFloor_dbw = -200; // Negligible
            link.latency_ms = dist / C_LIGHT * 1000 + 0.5; // propagation + 0.5ms processing
            return result;
        }

        // Laser comm: requires strict LOS, very high bandwidth, narrow beam immune to most jamming
        if (link.linkType === 'laser') {
            // Strict LOS required — no terrain refraction benefit
            if (!los) {
                result.quality = QUALITY.LOST;
                return result;
            }
            // Max range check (laser divergence limits range)
            if (cfg.maxRange_m && dist > cfg.maxRange_m) {
                result.quality = QUALITY.LOST;
                return result;
            }
            // Laser performance degrades with atmospheric thickness (low altitude paths)
            var minAlt = Math.min(fromAlt || 0, toAlt || 0);
            var atmosPenalty = 0;
            if (minAlt < 10000) {
                // Below 10km, atmosphere attenuates laser significantly
                atmosPenalty = (10000 - minAlt) / 10000 * 15; // up to 15 dB attenuation
            }
            result.hasLOS = true;
            result.distance_m = dist;
            result.margin_db = 40 - atmosPenalty; // Laser has good margin in clear sky
            result.snir_db = 50 - atmosPenalty;
            result.atmosAtten_db = atmosPenalty;
            result.jamPower_dbw = -999; // Immune to RF jamming (only dazzlers can jam)
            // Quality based on atmospheric penalty
            if (atmosPenalty < 5) result.quality = QUALITY.EXCELLENT;
            else if (atmosPenalty < 10) result.quality = QUALITY.GOOD;
            else if (atmosPenalty < 15) result.quality = QUALITY.DEGRADED;
            else result.quality = QUALITY.LOST;
            // High bandwidth even through atmosphere
            var laserCapacity = (cfg.dataRate_mbps || 1000) * 1e6;
            result.effectiveDataRate_bps = laserCapacity * Math.max(0.1, 1 - atmosPenalty / 20);
            result.rxPower_dbw = -10 + (cfg.antenna_gain_dbi || 50) - 10 * LOG10(Math.max(dist, 1));
            result.noiseFloor_dbw = -160;
            link.latency_ms = dist / C_LIGHT * 1000 + 0.1; // very low processing delay
            return result;
        }

        // No LOS or beyond max range => LOST
        if (!los || (cfg.maxRange_m && dist > cfg.maxRange_m)) {
            return result;
        }

        var freqGhz = cfg.frequency_ghz || 2.4;
        var freqHz = freqGhz * 1e9;
        var txPower = cfg.power_dbw || 10;
        var txGain = cfg.antenna_gain_dbi || 20;
        var rxSens = cfg.receiver_sensitivity_dbm || -100;
        var bwMbps = cfg.bandwidth_mbps || cfg.dataRate_mbps || 100;
        var bwHz = bwMbps * 1e6;

        // Free-space path loss
        var fspl = computeFSPL(dist, freqHz);
        result.fspl_db = fspl;

        // Atmospheric attenuation
        var atmosAtten = computeAtmosAttenuation(
            cfg.linkType || 'rf', freqGhz, dist, fromAlt || 0, toAlt || 0
        );
        result.atmosAtten_db = atmosAtten;

        // Rain fade (use 0 by default -- no weather system yet)
        var rainFade = 0;
        result.rainFade_db = rainFade;

        // Received power (dBW): Pt + Gt - FSPL - atmos - rain
        // Assume receive antenna gain = 0 dBi (omni) unless specified
        var rxGain = cfg.rx_antenna_gain_dbi || 0;
        var rxPower = txPower + txGain + rxGain - fspl - atmosAtten - rainFade;
        result.rxPower_dbw = rxPower;

        // Thermal noise floor
        var noiseFloor = thermalNoiseFloor_dBW(bwHz);
        result.noiseFloor_dbw = noiseFloor;

        // Jammer noise (computed separately and added here)
        var totalJamPower_dBW = _computeJamNoise(link, fromPos, toPos);
        result.jamPower_dbw = totalJamPower_dBW;

        // Total noise (thermal + jammer) in dBW
        var thermalWatts = Math.pow(10, noiseFloor / 10);
        var jamWatts = (totalJamPower_dBW > -200)
            ? Math.pow(10, totalJamPower_dBW / 10) : 0;
        var totalNoiseWatts = thermalWatts + jamWatts;
        var totalNoise_dBW = 10 * LOG10(totalNoiseWatts);

        // SNIR (signal to noise+interference ratio)
        var snir = rxPower - totalNoise_dBW;
        result.snir_db = snir;

        // Link margin: received power (dBm) vs receiver sensitivity (dBm)
        var rxPower_dBm = rxPower + 30;
        var margin = rxPower_dBm - rxSens;
        result.margin_db = margin;

        // Quality classification
        if (margin > MARGIN_EXCELLENT) {
            result.quality = QUALITY.EXCELLENT;
        } else if (margin > MARGIN_GOOD) {
            result.quality = QUALITY.GOOD;
        } else if (margin > MARGIN_DEGRADED) {
            result.quality = QUALITY.DEGRADED;
        } else {
            result.quality = QUALITY.LOST;
        }

        // Effective data rate: Shannon-ish degradation based on SNIR
        if (result.quality !== QUALITY.LOST) {
            // Rough: nominal rate * min(1, log2(1 + 10^(SNIR/10)) / log2(1 + 10^(20/10)))
            // At SNIR=20dB, full rate. Below that, proportional degradation.
            var snirLinear = Math.pow(10, snir / 10);
            var capacityFactor = Math.log(1 + Math.max(0, snirLinear)) / Math.log(1 + 100);
            capacityFactor = Math.max(0, Math.min(1, capacityFactor));
            result.effectiveDataRate_bps = bwMbps * 1e6 * capacityFactor;
        }

        return result;
    }

    // -----------------------------------------------------------------------
    // Jammer computation helper
    // -----------------------------------------------------------------------

    /**
     * Compute total jammer power arriving at a link in dBW.
     * Sums contributions from all active jammers that affect this link.
     */
    function _computeJamNoise(link, fromPos, toPos) {
        if (_jammers.size === 0) return -999;

        var cfg = link.config;
        var linkFreq = cfg.frequency_ghz || 2.4;
        var linkBw = cfg.bandwidth_mbps || 100;  // MHz as rough bandwidth proxy

        var totalJamWatts = 0;

        _jammers.forEach(function(jammer) {
            if (!jammer.active) return;

            // Check frequency overlap
            if (!_jammerAffectsFrequency(jammer, linkFreq, linkBw / 1000)) return;

            // Get jammer entity position
            var jammerPos = _getEntityCartesian(jammer.entityId);
            if (!jammerPos) return;

            // Direction check: uplink jammer affects receiver, downlink affects transmitter
            var targetPos;
            if (jammer.direction === 'uplink') {
                targetPos = toPos;    // jammer targets the receiver
            } else if (jammer.direction === 'downlink') {
                targetPos = fromPos;  // jammer targets the transmitter
            } else {
                // 'both' -- use closer of the two endpoints
                var distFrom = cartesianDistance(jammerPos, fromPos);
                var distTo = cartesianDistance(jammerPos, toPos);
                targetPos = (distTo < distFrom) ? toPos : fromPos;
            }

            var distToTarget = cartesianDistance(jammerPos, targetPos);

            // Out of range
            if (distToTarget > jammer.range_m) return;

            // Check LOS from jammer to target
            if (!hasLineOfSight(jammerPos, targetPos)) return;

            // Received jammer power at target:
            // J_rx = ERP - FSPL(dist, freq)
            var freqHz = linkFreq * 1e9;
            var fspl = computeFSPL(distToTarget, freqHz);
            var jamRx_dBW = jammer.power_dbw - fspl;

            // Convert to watts and accumulate
            var jamWatts = Math.pow(10, jamRx_dBW / 10);
            totalJamWatts += jamWatts;
        });

        if (totalJamWatts <= 0) return -999;
        return 10 * LOG10(totalJamWatts);
    }

    /**
     * Check if a jammer's frequency range overlaps with a link's frequency.
     */
    function _jammerAffectsFrequency(jammer, linkFreq_ghz, linkBw_ghz) {
        if (jammer.type === 'barrage') {
            // Barrage jammer: affects everything in its bandwidth range
            var jamLow = jammer.targetFreq_ghz - jammer.bandwidth_ghz / 2;
            var jamHigh = jammer.targetFreq_ghz + jammer.bandwidth_ghz / 2;
            var linkLow = linkFreq_ghz - (linkBw_ghz || 0.01) / 2;
            var linkHigh = linkFreq_ghz + (linkBw_ghz || 0.01) / 2;
            return jamHigh >= linkLow && jamLow <= linkHigh;
        }
        if (jammer.type === 'spot') {
            // Spot jammer: very narrow, must match link frequency closely
            var delta = Math.abs(jammer.targetFreq_ghz - linkFreq_ghz);
            return delta < (jammer.bandwidth_ghz || 0.01) / 2 + (linkBw_ghz || 0.01) / 2;
        }
        if (jammer.type === 'sweep') {
            // Sweep jammer: cycles through frequencies, probabilistic hit
            // For simplicity: always affects within its bandwidth range
            var sweepLow = jammer.targetFreq_ghz - jammer.bandwidth_ghz / 2;
            var sweepHigh = jammer.targetFreq_ghz + jammer.bandwidth_ghz / 2;
            return linkFreq_ghz >= sweepLow && linkFreq_ghz <= sweepHigh;
        }
        if (jammer.type === 'noise') {
            // Broadband noise: affects everything within range
            return true;
        }
        return false;
    }

    // -----------------------------------------------------------------------
    // Entity position helper
    // -----------------------------------------------------------------------

    /**
     * Get the Cartesian3 position of an entity from its state.
     * Entity state stores lat/lon in radians, alt in meters.
     */
    function _getEntityCartesian(entityId) {
        if (!_world) return null;
        var entity = _world.getEntity(entityId);
        if (!entity || !entity.active) return null;
        var s = entity.state;
        if (s.lat === undefined || s.lon === undefined) return null;
        return geodToCartesian(s.lat, s.lon, s.alt || 0);
    }

    /**
     * Get altitude of an entity in meters.
     */
    function _getEntityAlt(entityId) {
        if (!_world) return 0;
        var entity = _world.getEntity(entityId);
        if (!entity) return 0;
        return entity.state.alt || 0;
    }

    /**
     * Check if an entity is alive (active in the world).
     */
    function _isEntityAlive(entityId) {
        if (!_world) return false;
        var entity = _world.getEntity(entityId);
        return entity && entity.active;
    }

    // -----------------------------------------------------------------------
    // Link Graph Construction
    // -----------------------------------------------------------------------

    /**
     * Build link key from two entity IDs (always ordered).
     */
    function _linkKey(fromId, toId) {
        return fromId + ':' + toId;
    }

    /**
     * Build bidirectional link key (consistent ordering for deduplication).
     */
    function _bidiLinkKey(idA, idB) {
        return (idA < idB) ? (idA + ':' + idB) : (idB + ':' + idA);
    }

    /**
     * Create a LinkState object.
     */
    function _createLinkState(fromId, toId, networkId, config) {
        return {
            fromId: fromId,
            toId: toId,
            networkId: networkId,
            linkType: config.linkType || 'rf',
            config: config,
            // Runtime state
            quality: QUALITY.LOST,
            margin_db: 0,
            distance_m: 0,
            hasLOS: true,
            throughput_bps: 0,
            latency_ms: config.latency_ms || 5,
            packetLoss: 0,
            utilization: 0,
            jammed: false,
            jamStrength_db: 0,
            cyberCompromised: false,
            alive: true,
            // Budget details (last computation)
            _budget: null,
            // Bandwidth tracking
            _bytesSentThisTick: 0,
            _capacityBps: (config.dataRate_mbps || 100) * 1e6
        };
    }

    /**
     * Build the full link graph from network definitions.
     * Handles mesh, star, multihop, and custom topologies.
     */
    function _buildLinkGraph(networks) {
        _links.clear();
        _entityNetworks.clear();
        _entityNodes.clear();

        for (var n = 0; n < networks.length; n++) {
            var net = networks[n];
            var members = net.members || [];
            var config = net.config || {};
            var netId = net.id || ('net_' + n);

            // Track which entities belong to which networks
            for (var m = 0; m < members.length; m++) {
                var memberId = members[m];
                if (!_entityNetworks.has(memberId)) {
                    _entityNetworks.set(memberId, new Set());
                }
                _entityNetworks.get(memberId).add(netId);

                // Create node state
                if (!_entityNodes.has(memberId)) {
                    _entityNodes.set(memberId, {
                        entityId: memberId,
                        active: true,
                        bricked: false,
                        compromised: false,
                        ddosed: false,
                        mitm: false,
                        networks: new Set()
                    });
                }
                _entityNodes.get(memberId).networks.add(netId);
            }

            // Build links based on topology type
            var type = net.type || 'mesh';
            switch (type) {
                case 'mesh':
                    _buildMeshLinks(members, netId, config);
                    break;
                case 'star':
                    _buildStarLinks(members, net.hub, netId, config);
                    break;
                case 'multihop':
                    _buildMultihopLinks(net.path || members, netId, config);
                    break;
                case 'custom':
                    _buildCustomLinks(net.links || [], netId, config);
                    break;
                default:
                    _buildMeshLinks(members, netId, config);
                    break;
            }
        }
    }

    /**
     * Mesh topology: every member connects to every other member.
     */
    function _buildMeshLinks(members, netId, config) {
        for (var i = 0; i < members.length; i++) {
            for (var j = i + 1; j < members.length; j++) {
                var key = _bidiLinkKey(members[i], members[j]);
                if (!_links.has(key)) {
                    _links.set(key, _createLinkState(members[i], members[j], netId, config));
                }
            }
        }
    }

    /**
     * Star topology: all members connect to the hub only.
     */
    function _buildStarLinks(members, hub, netId, config) {
        if (!hub && members.length > 0) hub = members[0];
        for (var i = 0; i < members.length; i++) {
            if (members[i] === hub) continue;
            var key = _bidiLinkKey(hub, members[i]);
            if (!_links.has(key)) {
                _links.set(key, _createLinkState(hub, members[i], netId, config));
            }
        }
    }

    /**
     * Multihop topology: ordered chain of relay nodes.
     */
    function _buildMultihopLinks(path, netId, config) {
        for (var i = 0; i < path.length - 1; i++) {
            var key = _bidiLinkKey(path[i], path[i + 1]);
            if (!_links.has(key)) {
                _links.set(key, _createLinkState(path[i], path[i + 1], netId, config));
            }
        }
    }

    /**
     * Custom topology: explicit link pairs.
     */
    function _buildCustomLinks(linkDefs, netId, config) {
        for (var i = 0; i < linkDefs.length; i++) {
            var def = linkDefs[i];
            if (!def.from || !def.to) continue;
            var key = _bidiLinkKey(def.from, def.to);
            if (!_links.has(key)) {
                _links.set(key, _createLinkState(def.from, def.to, netId, config));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tick Phase 1: Update Link States
    // -----------------------------------------------------------------------

    /**
     * Recompute link budgets and update link states.
     */
    function _updateLinkStates() {
        _links.forEach(function(link) {
            // Check endpoint liveness
            var fromAlive = _isEntityAlive(link.fromId);
            var toAlive = _isEntityAlive(link.toId);

            // Check if endpoints are bricked by cyber attack
            var fromNode = _entityNodes.get(link.fromId);
            var toNode = _entityNodes.get(link.toId);
            var fromBricked = fromNode && fromNode.bricked;
            var toBricked = toNode && toNode.bricked;

            if (!fromAlive || !toAlive || fromBricked || toBricked) {
                link.alive = false;
                link.quality = QUALITY.LOST;
                link.margin_db = -999;
                link.throughput_bps = 0;
                link.hasLOS = false;
                link.packetLoss = 1.0;
                return;
            }

            link.alive = true;

            // Get positions
            var fromPos = _getEntityCartesian(link.fromId);
            var toPos = _getEntityCartesian(link.toId);
            if (!fromPos || !toPos) {
                link.quality = QUALITY.LOST;
                link.alive = false;
                return;
            }

            var fromAlt = _getEntityAlt(link.fromId);
            var toAlt = _getEntityAlt(link.toId);

            // Compute link budget
            var budget = computeLinkBudget(link, fromPos, toPos, fromAlt, toAlt);
            link._budget = budget;
            link.distance_m = budget.distance_m;
            link.hasLOS = budget.hasLOS;
            link.margin_db = budget.margin_db;

            // Apply jammer effects (fiber and laser links are immune to RF jamming)
            if (link.linkType !== 'fiber' && link.linkType !== 'laser' && budget.jamPower_dbw > -200) {
                var jsRatio = budget.jamPower_dbw - budget.rxPower_dbw;
                link.jamStrength_db = jsRatio;
                if (jsRatio > JS_KILL_THRESHOLD) {
                    link.jammed = true;
                    link.quality = QUALITY.LOST;
                } else if (jsRatio > JS_DEGRADE_THRESHOLD) {
                    link.jammed = true;
                    // Degrade quality by one level
                    if (budget.quality === QUALITY.EXCELLENT) {
                        link.quality = QUALITY.GOOD;
                    } else if (budget.quality === QUALITY.GOOD) {
                        link.quality = QUALITY.DEGRADED;
                    } else {
                        link.quality = budget.quality;
                    }
                } else {
                    link.jammed = false;
                    link.quality = budget.quality;
                }
            } else {
                link.jammed = false;
                link.jamStrength_db = 0;
                link.quality = budget.quality;
            }

            // Apply DDoS effect
            var fromDdos = fromNode && fromNode.ddosed;
            var toDdos = toNode && toNode.ddosed;
            if (fromDdos || toDdos) {
                link.throughput_bps = budget.effectiveDataRate_bps * CYBER_DDOS_BW_FACTOR;
            } else {
                link.throughput_bps = budget.effectiveDataRate_bps;
            }

            // Cyber compromise flag
            var fromComp = fromNode && fromNode.compromised;
            var toComp = toNode && toNode.compromised;
            link.cyberCompromised = !!(fromComp || toComp);

            // Latency: propagation delay + base latency
            var propagationDelay_ms = (link.distance_m / C_LIGHT) * 1000;
            link.latency_ms = propagationDelay_ms + (link.config.latency_ms || 5);

            // Packet loss estimation based on quality
            switch (link.quality) {
                case QUALITY.EXCELLENT: link.packetLoss = 0.001; break;
                case QUALITY.GOOD:      link.packetLoss = 0.01; break;
                case QUALITY.DEGRADED:  link.packetLoss = 0.10; break;
                case QUALITY.LOST:      link.packetLoss = 1.0; break;
            }

            // If jammed, increase packet loss
            if (link.jammed && link.quality !== QUALITY.LOST) {
                link.packetLoss = Math.min(1.0, link.packetLoss + 0.3);
            }

            // Reset per-tick bandwidth counter
            link._bytesSentThisTick = 0;

            // Decay active packet type indicator after 3 seconds
            if (link._activePacketType && link._activePacketTime) {
                var simT = _world ? _world.simTime : 0;
                if (simT - link._activePacketTime > 3.0) {
                    link._activePacketType = null;
                    link._activePacketTime = 0;
                }
            }

            // Utilization: computed at end of tick based on bytes sent
            // (leave current value in place; updated in _updateUtilization)
        });
    }

    // -----------------------------------------------------------------------
    // Tick Phase 2: Routing (Dijkstra)
    // -----------------------------------------------------------------------

    /**
     * Adjacency list for routing, rebuilt when link states change.
     * Map<entityId, [{neighborId, linkKey, cost}]>
     */
    var _adjacency = new Map();

    /**
     * Build adjacency list from current link states.
     * Only includes alive, non-LOST links.
     */
    function _buildAdjacency() {
        _adjacency.clear();

        _links.forEach(function(link, key) {
            if (!link.alive || link.quality === QUALITY.LOST) return;

            // Bidirectional
            _addAdjEdge(link.fromId, link.toId, key, link);
            _addAdjEdge(link.toId, link.fromId, key, link);
        });
    }

    function _addAdjEdge(from, to, linkKey, link) {
        if (!_adjacency.has(from)) {
            _adjacency.set(from, []);
        }
        // Compute edge cost: latency * (1/quality_factor) * (1 + packetLoss) * utilFactor
        var qualityFactor;
        switch (link.quality) {
            case QUALITY.EXCELLENT: qualityFactor = 1.0; break;
            case QUALITY.GOOD:      qualityFactor = 0.8; break;
            case QUALITY.DEGRADED:  qualityFactor = 0.5; break;
            default:                qualityFactor = 0.1; break;
        }
        var utilFactor = 1 + link.utilization * 2; // heavier links cost more
        var cost = link.latency_ms * (1 / qualityFactor) * (1 + link.packetLoss) * utilFactor;

        _adjacency.get(from).push({
            neighborId: to,
            linkKey: linkKey,
            cost: cost
        });
    }

    /**
     * Dijkstra shortest path from source to destination.
     * Returns { path: [entityIds], totalCost, totalLatency_ms } or null if no route.
     */
    function _dijkstra(sourceId, destId) {
        if (sourceId === destId) return { path: [sourceId], totalCost: 0, totalLatency_ms: 0 };

        // Simple priority queue using sorted array (fine for <1000 nodes)
        var dist = {};
        var prev = {};
        var visited = {};
        var queue = [];

        dist[sourceId] = 0;
        queue.push({ id: sourceId, cost: 0 });

        while (queue.length > 0) {
            // Find min cost in queue
            var minIdx = 0;
            for (var qi = 1; qi < queue.length; qi++) {
                if (queue[qi].cost < queue[minIdx].cost) minIdx = qi;
            }
            var current = queue[minIdx];
            queue.splice(minIdx, 1);

            if (visited[current.id]) continue;
            visited[current.id] = true;

            if (current.id === destId) break;

            // Explore neighbors
            var neighbors = _adjacency.get(current.id);
            if (!neighbors) continue;

            for (var ni = 0; ni < neighbors.length; ni++) {
                var edge = neighbors[ni];
                if (visited[edge.neighborId]) continue;

                var newDist = dist[current.id] + edge.cost;
                if (dist[edge.neighborId] === undefined || newDist < dist[edge.neighborId]) {
                    dist[edge.neighborId] = newDist;
                    prev[edge.neighborId] = current.id;
                    queue.push({ id: edge.neighborId, cost: newDist });
                }
            }
        }

        // Reconstruct path
        if (!visited[destId]) return null;

        var path = [];
        var node = destId;
        while (node !== undefined) {
            path.unshift(node);
            node = prev[node];
        }

        // Compute total latency along path
        var totalLatency = 0;
        for (var pi = 0; pi < path.length - 1; pi++) {
            var lk = _bidiLinkKey(path[pi], path[pi + 1]);
            var link = _links.get(lk);
            if (link) {
                totalLatency += link.latency_ms;
            }
        }

        return {
            path: path,
            totalCost: dist[destId],
            totalLatency_ms: totalLatency
        };
    }

    /**
     * Find a command node for a given entity.
     * Prefers entities of type 'ground_station' or 'awacs' or 'command'
     * on the same team. Falls back to any same-team entity with comms.
     */
    function _findCommandNode(entityId) {
        if (!_world) return null;
        var entity = _world.getEntity(entityId);
        if (!entity) return null;
        var team = entity.team;

        var bestId = null;
        var bestPriority = 999;

        _entityNodes.forEach(function(node, nodeId) {
            if (nodeId === entityId) return;
            if (!node.active || node.bricked) return;

            var nodeEntity = _world.getEntity(nodeId);
            if (!nodeEntity || !nodeEntity.active) return;
            if (nodeEntity.team !== team) return;

            // Priority: ground_station=0, awacs=1, command=1, other=2
            var priority = 2;
            var t = nodeEntity.type;
            if (t === 'ground_station' || t === 'ground') priority = 0;
            else if (t === 'awacs' || t === 'command') priority = 1;

            if (priority < bestPriority) {
                bestPriority = priority;
                bestId = nodeId;
            }
        });

        return bestId;
    }

    // -----------------------------------------------------------------------
    // Tick Phase 2b: Route and advance packets
    // -----------------------------------------------------------------------

    /**
     * Process all in-flight packets: route, advance hops, deliver or drop.
     * Packets are sorted by priority (highest first) so high-priority packets
     * get bandwidth allocation before lower priority ones.
     */
    function _processPackets(dt, simTime) {
        // Sort packets by priority (descending) for bandwidth preemption
        _packets.sort(function(a, b) { return (b.priority || 0) - (a.priority || 0); });

        var toRemove = [];

        for (var i = 0; i < _packets.length; i++) {
            var pkt = _packets[i];

            if (pkt.delivered || pkt.dropped) {
                toRemove.push(i);
                continue;
            }

            // Check TTL
            if (pkt.currentHop >= pkt.ttl) {
                _dropPacket(pkt, DROP.TTL_EXCEEDED, simTime);
                toRemove.push(i);
                continue;
            }

            // Check source/dest node health
            if (!_isEntityAlive(pkt.sourceId)) {
                _dropPacket(pkt, DROP.NODE_DEAD, simTime);
                toRemove.push(i);
                continue;
            }
            if (!_isEntityAlive(pkt.destId)) {
                _dropPacket(pkt, DROP.NODE_DEAD, simTime);
                toRemove.push(i);
                continue;
            }

            // Route if no path or path is stale
            if (!pkt.path || pkt.path.length === 0) {
                var route = _dijkstra(pkt.sourceId, pkt.destId);
                if (!route) {
                    _dropPacket(pkt, DROP.NO_ROUTE, simTime);
                    toRemove.push(i);
                    continue;
                }
                pkt.path = route.path;
                pkt.currentHop = 0;
            }

            // Get current position in path
            var currentNodeId = pkt.path[pkt.currentHop];
            var nextHopIdx = pkt.currentHop + 1;

            if (nextHopIdx >= pkt.path.length) {
                // Reached destination
                _deliverPacket(pkt, simTime);
                toRemove.push(i);
                continue;
            }

            var nextNodeId = pkt.path[nextHopIdx];

            // Check link between current and next hop
            var lk = _bidiLinkKey(currentNodeId, nextNodeId);
            var link = _links.get(lk);

            if (!link || !link.alive || link.quality === QUALITY.LOST) {
                // Link is down, try rerouting
                var reroute = _dijkstra(currentNodeId, pkt.destId);
                if (!reroute) {
                    _dropPacket(pkt, DROP.LINK_LOST, simTime);
                    toRemove.push(i);
                    continue;
                }
                pkt.path = reroute.path;
                pkt.currentHop = 0;
                // Will process next tick
                continue;
            }

            // Check if link is jammed
            if (link.jammed && link.quality === QUALITY.LOST) {
                _dropPacket(pkt, DROP.JAMMED, simTime);
                toRemove.push(i);
                continue;
            }

            // Check cyber compromise on next node
            var nextNode = _entityNodes.get(nextNodeId);
            if (nextNode && nextNode.bricked) {
                _dropPacket(pkt, DROP.CYBER, simTime);
                toRemove.push(i);
                continue;
            }

            // Check bandwidth capacity
            var pktBits = pkt.size_bytes * 8;
            var capacityBits = link._capacityBps * Math.max(dt, 0.001);
            var usedBits = link._bytesSentThisTick * 8;
            var remainingBits = capacityBits - usedBits;

            if (pktBits > remainingBits) {
                // Bandwidth exceeded
                if (pkt.priority >= 8) {
                    // High priority (track/targeting): preempt — send anyway
                    // but mark link as saturated for metrics
                    link._saturated = true;
                } else if (pkt.priority >= 5) {
                    // Medium priority: queue for next tick (don't advance hop)
                    continue;
                } else {
                    // Low priority: drop
                    _dropPacket(pkt, DROP.BANDWIDTH, simTime);
                    toRemove.push(i);
                    continue;
                }
            }

            // Apply packet loss probability
            var rand = Math.random();
            if (rand < link.packetLoss) {
                _dropPacket(pkt, link.jammed ? DROP.JAMMED : DROP.LINK_LOST, simTime);
                toRemove.push(i);
                continue;
            }

            // Check if enough time has elapsed for this hop (latency simulation)
            var hopStartTime = pkt._hopStartTime || pkt.createdAt;
            var hopLatency = link.latency_ms / 1000;  // convert to seconds
            if (simTime - hopStartTime < hopLatency) {
                // Still in transit for this hop
                continue;
            }

            // Advance to next hop
            link._bytesSentThisTick += pkt.size_bytes;
            // Track active packet type for visual differentiation
            if (pkt.type === 'targeting' || pkt.type === 'track') {
                link._activePacketType = pkt.type;
                link._activePacketTime = simTime;
            }
            pkt.hops.push({
                from: currentNodeId,
                to: nextNodeId,
                time: simTime,
                latency_ms: link.latency_ms,
                linkQuality: link.quality
            });
            pkt.currentHop = nextHopIdx;
            pkt._hopStartTime = simTime;

            // Check if MITM attack on this node -- attacker can see packet
            if (nextNode && nextNode.mitm) {
                pkt._intercepted = true;
            }

            // Check if we've reached the destination after advancing
            if (pkt.currentHop >= pkt.path.length - 1) {
                _deliverPacket(pkt, simTime);
                toRemove.push(i);
            }
        }

        // Remove completed packets (iterate in reverse to maintain indices)
        for (var r = toRemove.length - 1; r >= 0; r--) {
            _packets.splice(toRemove[r], 1);
        }
    }

    /**
     * Mark a packet as delivered and log it.
     */
    function _deliverPacket(pkt, simTime) {
        pkt.delivered = true;
        pkt.deliveryTime = simTime;

        _metrics.totalPacketsDelivered++;
        _metrics.totalBytesDelivered += pkt.size_bytes;
        _metrics.windowPacketsDelivered++;
        _metrics.windowBytesDelivered += pkt.size_bytes;

        var latency = (simTime - pkt.createdAt) * 1000; // ms
        _metrics.windowLatencySum += latency;
        _metrics.windowLatencyCount++;

        _logPacket(pkt);

        // Deliver data to destination entity
        _applyPacketData(pkt);
    }

    /**
     * Apply delivered packet data to the destination entity state.
     */
    function _applyPacketData(pkt) {
        if (!_world) return;
        var destEntity = _world.getEntity(pkt.destId);
        if (!destEntity) return;

        destEntity.state._commPacketsRecv = (destEntity.state._commPacketsRecv || 0) + 1;

        // Track data: merge into entity's received tracks
        if (pkt.type === 'track' && pkt.data && pkt.data.tracks) {
            if (!destEntity.state._commReceivedTracks) {
                destEntity.state._commReceivedTracks = [];
            }
            var tracks = pkt.data.tracks;
            var latency_s = pkt.deliveryTime - pkt.createdAt;
            for (var t = 0; t < tracks.length; t++) {
                var trk = tracks[t];
                trk._deliveryLatency_s = latency_s;
                trk._hops = pkt.hops ? pkt.hops.length : 0;
                trk._sourceEntityId = pkt.sourceId;
                destEntity.state._commReceivedTracks.push(trk);
            }
            // Trim to last 200 tracks
            if (destEntity.state._commReceivedTracks.length > 200) {
                destEntity.state._commReceivedTracks =
                    destEntity.state._commReceivedTracks.slice(-200);
            }

            // F2T2EA: Command node distributes targeting to weapon nodes
            _distributeTargeting(pkt.destId, tracks, pkt.deliveryTime, latency_s);
        }

        // Targeting data: write to entity's targeting queue for weapon systems
        if (pkt.type === 'targeting' && pkt.data && pkt.data.targets) {
            if (!destEntity.state._commTargets) {
                destEntity.state._commTargets = {};
            }
            var targets = pkt.data.targets;
            var tgtLatency = pkt.deliveryTime - pkt.createdAt;
            for (var tt = 0; tt < targets.length; tt++) {
                var tgt = targets[tt];
                tgt._totalLatency_s = (tgt._deliveryLatency_s || 0) + tgtLatency;
                tgt._hops = (tgt._hops || 0) + (pkt.hops ? pkt.hops.length : 0);
                // Key by targetId, overwrite stale data
                destEntity.state._commTargets[tgt.targetId] = tgt;
            }
            destEntity.state._commTargetsUpdated = pkt.deliveryTime;
        }

        // Command data: could be used to update entity AI/behavior
        if (pkt.type === 'command' && pkt.data) {
            destEntity.state._commLastCommand = pkt.data;
            destEntity.state._commLastCommandTime = pkt.deliveryTime;
        }
    }

    // -------------------------------------------------------------------
    // F2T2EA: Command-to-shooter targeting distribution
    // -------------------------------------------------------------------

    /**
     * When a command node receives track data, it distributes targeting
     * packets to weapon nodes (SAM batteries, fighters with A2A) in the
     * same network(s). This implements the Target→Engage step of F2T2EA.
     *
     * The targeting packet includes extrapolated position based on
     * track velocity and the accumulated comm latency.
     */
    function _distributeTargeting(commandEntityId, tracks, simTime, trackLatency) {
        if (!_world) return;

        var cmdEntity = _world.getEntity(commandEntityId);
        if (!cmdEntity || !cmdEntity.active) return;
        var cmdTeam = cmdEntity.team;

        // Find weapon nodes in the same network(s) as the command node
        var cmdNetworks = _entityNetworks.get(commandEntityId);
        if (!cmdNetworks || cmdNetworks.size === 0) return;

        var weaponNodes = [];
        _entityNodes.forEach(function(node, nodeId) {
            if (nodeId === commandEntityId) return;
            if (!node.active || node.bricked) return;

            var nodeEntity = _world.getEntity(nodeId);
            if (!nodeEntity || !nodeEntity.active) return;
            if (nodeEntity.team !== cmdTeam) return;

            // Check if this entity has weapon components (SAM, A2A, fighter_loadout)
            var hasWeapons = false;
            if (nodeEntity.components) {
                nodeEntity.components.forEach(function(comp) {
                    var cType = comp.config && comp.config.type;
                    if (comp instanceof ECS.Component) {
                        var name = comp.constructor.name || '';
                        if (name === 'SAMBattery' || name === 'A2AMissile' ||
                            name === 'FighterLoadout' || name === 'KineticKill') {
                            hasWeapons = true;
                        }
                    }
                });
            }
            // Also check if entity has weapons in _custom
            if (!hasWeapons && nodeEntity.def && nodeEntity.def._custom) {
                var payloads = nodeEntity.def._custom.payloads;
                if (payloads && (payloads.a2a || payloads.a2g || payloads.sam || payloads.kkv)) {
                    hasWeapons = true;
                }
            }
            // Check component map directly
            if (!hasWeapons && nodeEntity.components) {
                var wTypes = ['sam_battery', 'a2a_missile', 'fighter_loadout', 'kinetic_kill'];
                for (var w = 0; w < wTypes.length; w++) {
                    if (nodeEntity.components.has('weapons/' + wTypes[w])) {
                        hasWeapons = true;
                        break;
                    }
                }
            }

            if (!hasWeapons) return;

            // Check shared network membership
            var nodeNets = _entityNetworks.get(nodeId);
            if (!nodeNets) return;
            var sharedNet = false;
            cmdNetworks.forEach(function(netId) {
                if (nodeNets.has(netId)) sharedNet = true;
            });
            if (!sharedNet) return;

            weaponNodes.push(nodeId);
        });

        if (weaponNodes.length === 0) return;

        // Extrapolate track positions based on latency
        var extrapolatedTracks = [];
        for (var t = 0; t < tracks.length; t++) {
            var trk = tracks[t];
            // Skip friendly tracks
            if (_world) {
                var tgtEntity = _world.getEntity(trk.targetId);
                if (tgtEntity && tgtEntity.team === cmdTeam) continue;
            }

            var extTrk = {
                targetId: trk.targetId,
                targetName: trk.targetName,
                lat: trk.lat,
                lon: trk.lon,
                alt: trk.alt || 0,
                speed: trk.speed || 0,
                heading: trk.heading || 0,
                range_m: trk.range_m,
                bearing_deg: trk.bearing_deg,
                rcs: trk.rcs || 0,
                time: trk.time,
                _deliveryLatency_s: trackLatency,
                _hops: trk._hops || 0,
                _sourceEntityId: trk._sourceEntityId || commandEntityId,
                _commandNodeId: commandEntityId,
                _isCommTrack: true
            };

            // Position extrapolation: advance lat/lon by speed*heading*latency
            if (trackLatency > 0 && trk.speed > 0) {
                var dt = trackLatency;
                var hdg = (trk.heading || 0);
                var spd = trk.speed;
                // Simple flat-earth extrapolation for short latencies
                var dNorth = spd * Math.cos(hdg) * dt;
                var dEast = spd * Math.sin(hdg) * dt;
                var dLat = dNorth / (R_EARTH + (trk.alt || 0));
                var dLon = dEast / ((R_EARTH + (trk.alt || 0)) * Math.cos(trk.lat || 0));
                extTrk.lat += dLat;
                extTrk.lon += dLon;
                // Position uncertainty grows with latency (CEP in meters)
                extTrk._posUncertainty_m = spd * dt * 0.15; // 15% of travel distance
            } else {
                extTrk._posUncertainty_m = 0;
            }

            extrapolatedTracks.push(extTrk);
        }

        if (extrapolatedTracks.length === 0) return;

        // Send targeting packet to each weapon node
        for (var w = 0; w < weaponNodes.length; w++) {
            var weapNodeId = weaponNodes[w];

            var tgtPkt = {
                id: 'pkt_tgt_' + _nextPacketId++,
                type: 'targeting',
                sourceId: commandEntityId,
                destId: weapNodeId,
                size_bytes: 32 + extrapolatedTracks.length * 64,
                priority: 9,  // targeting is highest priority
                ttl: 8,
                createdAt: simTime,
                data: { targets: extrapolatedTracks },
                path: null,
                currentHop: 0,
                delivered: false,
                dropped: false,
                dropReason: null,
                deliveryTime: null,
                hops: [],
                _hopStartTime: simTime
            };

            _packets.push(tgtPkt);
            _metrics.totalPacketsSent++;
            _metrics.totalBytesSent += tgtPkt.size_bytes;
            _metrics.windowPacketsSent++;
        }
    }

    /**
     * Mark a packet as dropped and log it.
     */
    function _dropPacket(pkt, reason, simTime) {
        pkt.dropped = true;
        pkt.dropReason = reason;
        pkt.deliveryTime = simTime;

        _metrics.totalPacketsDropped++;

        _logPacket(pkt);
    }

    /**
     * Log a packet to the circular buffer.
     */
    function _logPacket(pkt) {
        if (_packetLog.length < PACKET_LOG_MAX) {
            _packetLog.push(pkt);
        } else {
            _packetLog[_packetLogIdx] = pkt;
            _packetLogIdx = (_packetLogIdx + 1) % PACKET_LOG_MAX;
            _packetLogFull = true;
        }
    }

    // -----------------------------------------------------------------------
    // Tick Phase 3: Process jammers
    // -----------------------------------------------------------------------

    /**
     * Update jammer effects on links.
     * Jammer power contributions are computed during link budget (Phase 1).
     * This phase handles any jammer-specific state updates.
     */
    function _processJammers(dt) {
        _jammers.forEach(function(jammer) {
            if (!jammer.active) return;

            // Check if jammer entity still exists and is alive
            if (!_isEntityAlive(jammer.entityId)) {
                jammer.active = false;
                return;
            }

            // Sweep jammer: could rotate frequency here
            if (jammer.type === 'sweep') {
                // Rotate target frequency within bandwidth range
                var sweepRate = 0.5; // GHz per second
                jammer._sweepPhase = (jammer._sweepPhase || 0) + sweepRate * dt;
                if (jammer._sweepPhase > 1) jammer._sweepPhase -= 1;
                // Effective target frequency oscillates within bandwidth
                jammer.targetFreq_ghz = jammer._baseFreq
                    + (jammer._sweepPhase - 0.5) * jammer.bandwidth_ghz;
            }
        });
    }

    // -----------------------------------------------------------------------
    // Tick Phase 4: Process cyber attacks
    // -----------------------------------------------------------------------

    /**
     * Advance cyber attack progress and apply effects on completion.
     */
    function _processCyberAttacks(dt, simTime) {
        _cyberAttacks.forEach(function(attack, attackId) {
            if (!attack.active) return;

            // Check if attacker is still alive
            if (!_isEntityAlive(attack.attackerId)) {
                attack.active = false;
                return;
            }

            // Check if there's a network path from attacker to target
            // (cyber attacks need some form of connectivity)
            var route = _dijkstra(attack.attackerId, attack.targetId);
            if (!route && attack.progress < 1) {
                // No connectivity -- attack stalls
                return;
            }

            // Advance progress
            if (attack.progress < 1) {
                attack.progress += dt / attack.duration_s;
                if (attack.progress >= 1) {
                    attack.progress = 1;
                    _applyCyberEffect(attack, simTime);
                }
            }
        });
    }

    /**
     * Apply the effect of a completed cyber attack.
     */
    function _applyCyberEffect(attack, simTime) {
        var targetNode = _entityNodes.get(attack.targetId);
        if (!targetNode) return;

        attack.effect = {
            type: attack.type,
            appliedAt: simTime
        };

        switch (attack.type) {
            case 'brick':
                // Node becomes non-functional, all links through it die
                targetNode.bricked = true;
                targetNode.active = false;
                break;

            case 'mitm':
                // Packets through this node can be intercepted/modified
                targetNode.mitm = true;
                targetNode.compromised = true;
                break;

            case 'inject':
                // Inject false packets into the network
                targetNode.compromised = true;
                _injectFalsePackets(attack, simTime);
                break;

            case 'ddos':
                // Bandwidth on target links reduced dramatically
                targetNode.ddosed = true;
                break;

            case 'exploit':
                // Node compromised, attacker gains routing control
                targetNode.compromised = true;
                break;
        }

        // Update entity state to reflect cyber attack
        if (_world) {
            var entity = _world.getEntity(attack.targetId);
            if (entity) {
                entity.state._commCyber = {
                    type: attack.type,
                    attackerId: attack.attackerId,
                    time: simTime
                };
            }
        }
    }

    /**
     * Inject false track packets from a compromised node.
     */
    function _injectFalsePackets(attack, simTime) {
        // Generate 3 false track packets with bogus positions
        for (var i = 0; i < 3; i++) {
            var falsePkt = {
                id: 'pkt_inject_' + _nextPacketId++,
                type: 'track',
                sourceId: attack.targetId,  // appears to come from compromised node
                destId: _findCommandNode(attack.targetId),
                size_bytes: 256,
                priority: 8,
                ttl: 10,
                createdAt: simTime,
                data: {
                    tracks: [{
                        targetId: 'ghost_' + i,
                        lat: (Math.random() - 0.5) * PI,
                        lon: (Math.random() - 0.5) * 2 * PI,
                        alt: Math.random() * 20000 + 5000,
                        speed: Math.random() * 300 + 100,
                        heading: Math.random() * 360,
                        rcs: Math.random() * 10,
                        time: simTime,
                        _injected: true  // marker for detection
                    }]
                },
                path: null,
                currentHop: 0,
                delivered: false,
                dropped: false,
                dropReason: null,
                deliveryTime: null,
                hops: [],
                _hopStartTime: simTime,
                _injected: true
            };

            if (falsePkt.destId) {
                _packets.push(falsePkt);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tick Phase 5: Auto-generate track packets from sensors
    // -----------------------------------------------------------------------

    /**
     * Entities with radar sensors that detect targets automatically
     * generate track packets to be routed to command nodes.
     */
    function _generateTrackPackets(simTime) {
        if (!_world) return;

        _entityNodes.forEach(function(node, entityId) {
            if (!node.active || node.bricked) return;

            var entity = _world.getEntity(entityId);
            if (!entity || !entity.active) return;

            var detections = entity.state._detections;
            if (!detections || detections.length === 0) return;

            // Find command node to route to
            var cmdNode = _findCommandNode(entityId);
            if (!cmdNode) return;

            // Build track packet
            var tracksData = [];
            for (var d = 0; d < detections.length; d++) {
                var det = detections[d];
                if (!det.detected) continue;

                // Get target entity position for track data
                var targetEntity = _world.getEntity(det.targetId);
                if (!targetEntity) continue;

                tracksData.push({
                    targetId: det.targetId,
                    targetName: det.targetName,
                    lat: targetEntity.state.lat,
                    lon: targetEntity.state.lon,
                    alt: targetEntity.state.alt || 0,
                    speed: targetEntity.state.speed || 0,
                    heading: targetEntity.state.heading || 0,
                    rcs: det.rcs || 0,
                    range_m: det.range_m,
                    bearing_deg: det.bearing_deg,
                    time: simTime
                });
            }

            if (tracksData.length === 0) return;

            // Create packet: 64 bytes base + 48 bytes per track
            var pkt = {
                id: 'pkt_trk_' + _nextPacketId++,
                type: 'track',
                sourceId: entityId,
                destId: cmdNode,
                size_bytes: 64 + tracksData.length * 48,
                priority: 8,      // tracks are high priority
                ttl: 10,
                createdAt: simTime,
                data: { tracks: tracksData },
                path: null,
                currentHop: 0,
                delivered: false,
                dropped: false,
                dropReason: null,
                deliveryTime: null,
                hops: [],
                _hopStartTime: simTime
            };

            _packets.push(pkt);

            _metrics.totalPacketsSent++;
            _metrics.totalBytesSent += pkt.size_bytes;
            _metrics.windowPacketsSent++;

            // Update source entity stats
            entity.state._commPacketsSent = (entity.state._commPacketsSent || 0) + 1;
        });
    }

    // -----------------------------------------------------------------------
    // Tick Phase 6: Network self-healing / rerouting
    // -----------------------------------------------------------------------

    /**
     * Check network health and attempt self-healing.
     * For mesh networks: automatic rerouting (handled by Dijkstra).
     * For star networks: if hub dies, network is down.
     * For multihop: if relay dies, attempt to bridge gap.
     */
    function _networkSelfHeal() {
        for (var n = 0; n < _networks.length; n++) {
            var net = _networks[n];
            var type = net.type || 'mesh';
            var members = net.members || [];

            if (type === 'star') {
                // Check hub health
                var hubId = net.hub || members[0];
                if (hubId) {
                    var hubNode = _entityNodes.get(hubId);
                    if (hubNode && (hubNode.bricked || !_isEntityAlive(hubId))) {
                        // Hub is down -- attempt to promote a daughter to new hub
                        var newHub = null;
                        var bestScore = -1;
                        for (var m = 0; m < members.length; m++) {
                            if (members[m] === hubId) continue;
                            var candidateNode = _entityNodes.get(members[m]);
                            if (!candidateNode || !candidateNode.active || candidateNode.bricked) continue;
                            if (!_isEntityAlive(members[m])) continue;

                            // Score: prefer ground stations, then by number of alive peers
                            var cEntity = _world ? _world.getEntity(members[m]) : null;
                            var score = 0;
                            if (cEntity) {
                                if (cEntity.type === 'ground_station' || cEntity.type === 'ground') score += 100;
                                else if (cEntity.type === 'awacs' || cEntity.type === 'command') score += 50;
                            }
                            // Count alive neighbors
                            for (var mm = 0; mm < members.length; mm++) {
                                if (members[mm] === members[m] || members[mm] === hubId) continue;
                                if (_isEntityAlive(members[mm])) score++;
                            }
                            if (score > bestScore) {
                                bestScore = score;
                                newHub = members[m];
                            }
                        }

                        if (newHub) {
                            // Promote: create links from new hub to all alive daughters
                            net.hub = newHub;
                            net._originalHub = hubId;
                            net._promotedAt = _world ? _world.simTime : 0;

                            for (var pm = 0; pm < members.length; pm++) {
                                var mId = members[pm];
                                if (mId === hubId || mId === newHub) continue;
                                if (!_isEntityAlive(mId)) continue;

                                // Remove old hub link
                                var oldLk = _bidiLinkKey(hubId, mId);
                                var oldLink = _links.get(oldLk);
                                if (oldLink) {
                                    oldLink.alive = false;
                                    oldLink.quality = QUALITY.LOST;
                                }

                                // Create or revive link from new hub
                                var newLk = _bidiLinkKey(newHub, mId);
                                var existingLink = _links.get(newLk);
                                if (existingLink) {
                                    existingLink.alive = true;
                                    existingLink.quality = QUALITY.DEGRADED;
                                } else {
                                    _links.set(newLk, _createLinkState(
                                        newHub, mId, net.id, net.rfConfig || {}
                                    ));
                                }
                            }

                            // Kill old hub links
                            for (var dm = 0; dm < members.length; dm++) {
                                if (members[dm] === hubId) continue;
                                var deadLk = _bidiLinkKey(hubId, members[dm]);
                                var deadLink = _links.get(deadLk);
                                if (deadLink) {
                                    deadLink.alive = false;
                                    deadLink.quality = QUALITY.LOST;
                                }
                            }

                            console.log('[CommEngine] Star network "' + (net.name || net.id) +
                                '": hub promoted from ' + hubId + ' → ' + newHub);
                        } else {
                            // No viable candidate — network is down
                            for (var dm2 = 0; dm2 < members.length; dm2++) {
                                if (members[dm2] === hubId) continue;
                                var lk = _bidiLinkKey(hubId, members[dm2]);
                                var link = _links.get(lk);
                                if (link) {
                                    link.alive = false;
                                    link.quality = QUALITY.LOST;
                                }
                            }
                        }
                    }
                }
            }

            // For all network types: remove links to dead nodes
            for (var mi = 0; mi < members.length; mi++) {
                var memberId = members[mi];
                if (!_isEntityAlive(memberId)) {
                    var memberNode = _entityNodes.get(memberId);
                    if (memberNode) memberNode.active = false;
                }
            }

            // mesh and multihop self-heal via Dijkstra rerouting automatically
        }
    }

    // -----------------------------------------------------------------------
    // Tick Phase 7: Update metrics
    // -----------------------------------------------------------------------

    /**
     * Update link utilization and sliding window metrics.
     */
    function _updateMetrics(dt, simTime) {
        // Update link utilization
        _links.forEach(function(link) {
            if (!link.alive || link._capacityBps <= 0) {
                link.utilization = 0;
                return;
            }
            // Utilization = bytes_sent_this_tick * 8 / (capacity_bps * dt)
            var bitsSent = link._bytesSentThisTick * 8;
            var capacityBits = link._capacityBps * Math.max(dt, 0.001);
            link.utilization = Math.min(1.0, bitsSent / capacityBits);
        });

        // Sliding window reset
        if (simTime - _metrics.windowStart > METRIC_WINDOW_S) {
            // Compute window averages before reset
            if (_metrics.windowLatencyCount > 0) {
                _metrics.avgLatency_ms = _metrics.windowLatencySum / _metrics.windowLatencyCount;
            }
            if (_metrics.windowPacketsSent > 0) {
                _metrics.packetDeliveryRate =
                    _metrics.windowPacketsDelivered / _metrics.windowPacketsSent;
            }

            // Reset window
            _metrics.windowPacketsSent = 0;
            _metrics.windowPacketsDelivered = 0;
            _metrics.windowBytesDelivered = 0;
            _metrics.windowLatencySum = 0;
            _metrics.windowLatencyCount = 0;
            _metrics.windowStart = simTime;
        }
    }

    // -----------------------------------------------------------------------
    // Tick Phase 8: Update entity state
    // -----------------------------------------------------------------------

    /**
     * Write comm state to each entity for HUD/visualization consumption.
     */
    function _updateEntityState(simTime) {
        if (!_world) return;

        _entityNodes.forEach(function(node, entityId) {
            var entity = _world.getEntity(entityId);
            if (!entity) return;

            var s = entity.state;

            // Active comm links for this entity
            var activeLinks = [];
            var totalBw = 0;
            var totalLatency = 0;
            var linkCount = 0;
            var isJammed = false;

            _links.forEach(function(link) {
                if (link.fromId !== entityId && link.toId !== entityId) return;
                if (!link.alive) return;

                var peerId = (link.fromId === entityId) ? link.toId : link.fromId;
                activeLinks.push({
                    peerId: peerId,
                    quality: link.quality,
                    distance_m: link.distance_m,
                    latency_ms: link.latency_ms,
                    throughput_bps: link.throughput_bps,
                    jammed: link.jammed,
                    networkId: link.networkId
                });

                if (link.quality !== QUALITY.LOST) {
                    totalBw += link.throughput_bps;
                    totalLatency += link.latency_ms;
                    linkCount++;
                }

                if (link.jammed) isJammed = true;
            });

            s._commLinks = activeLinks;
            s._commJammed = isJammed || node.bricked;
            s._commBandwidth = totalBw / 1e6;  // Mbps
            s._commLatency = linkCount > 0 ? (totalLatency / linkCount) : 0;
            // _commPacketsSent and _commPacketsRecv are updated incrementally
            if (s._commPacketsSent === undefined) s._commPacketsSent = 0;
            if (s._commPacketsRecv === undefined) s._commPacketsRecv = 0;
            if (s._commPacketsDrop === undefined) s._commPacketsDrop = 0;

            // Network membership
            var nets = _entityNetworks.get(entityId);
            s._commNetworks = nets ? Array.from(nets) : [];

            // Cyber attack state
            if (!s._commCyber && !node.bricked && !node.compromised && !node.ddosed) {
                s._commCyber = null;
            }
        });

        // Count dropped packets per entity (from recent log)
        var dropCounts = {};
        var logLen = _packetLogFull ? PACKET_LOG_MAX : _packetLog.length;
        for (var i = 0; i < logLen; i++) {
            var pkt = _packetLog[i];
            if (!pkt || !pkt.dropped) continue;
            var srcId = pkt.sourceId;
            dropCounts[srcId] = (dropCounts[srcId] || 0) + 1;
        }

        _entityNodes.forEach(function(node, entityId) {
            var entity = _world.getEntity(entityId);
            if (!entity) return;
            entity.state._commPacketsDrop = dropCounts[entityId] || 0;
        });
    }

    // -----------------------------------------------------------------------
    // Packet expiration
    // -----------------------------------------------------------------------

    /**
     * Expire packets that have been in-flight too long (10x their TTL * avg latency).
     */
    function _expireStalePackets(simTime) {
        for (var i = _packets.length - 1; i >= 0; i--) {
            var pkt = _packets[i];
            var maxAge = Math.max(30, pkt.ttl * 2);  // seconds
            if (simTime - pkt.createdAt > maxAge) {
                _dropPacket(pkt, DROP.EXPIRED, simTime);
                _packets.splice(i, 1);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    var CommEngine = {

        /**
         * Initialize the communications engine from scenario network definitions.
         * @param {Array} networks - Array of network definition objects
         * @param {ECS.World} world - The ECS world instance
         */
        init: function(networks, world) {
            _world = world;
            _networks = networks || [];
            _initialized = true;

            // Store networks in map for quick lookup
            _networkMap.clear();
            for (var i = 0; i < _networks.length; i++) {
                var net = _networks[i];
                var netId = net.id || ('net_' + i);
                net.id = netId;
                _networkMap.set(netId, net);
            }

            // Build link graph
            _buildLinkGraph(_networks);

            // Reset state
            _packets = [];
            _packetLog = [];
            _packetLogIdx = 0;
            _packetLogFull = false;
            _nextPacketId = 1;
            _linkAccum = 0;
            _routeAccum = 0;
            _trackGenAccum = 0;

            // Reset metrics
            _metrics = {
                totalPacketsSent: 0,
                totalPacketsDelivered: 0,
                totalPacketsDropped: 0,
                totalBytesSent: 0,
                totalBytesDelivered: 0,
                avgLatency_ms: 0,
                packetDeliveryRate: 1.0,
                windowPacketsSent: 0,
                windowPacketsDelivered: 0,
                windowBytesDelivered: 0,
                windowLatencySum: 0,
                windowLatencyCount: 0,
                windowStart: 0
            };

            _ensureScratch();

            console.log('[CommEngine] Initialized with ' + _networks.length + ' networks, '
                + _links.size + ' links, ' + _entityNodes.size + ' nodes');
        },

        /**
         * Main tick function. Called every simulation frame.
         * Heavy computations are throttled to 2-4 Hz.
         * @param {number} dt - Delta time in seconds
         * @param {ECS.World} world - The ECS world instance
         */
        tick: function(dt, world) {
            if (!_initialized) return;
            _world = world;

            var simTime = world ? world.simTime : 0;

            // Throttle link budget computation (4 Hz)
            _linkAccum += dt;
            var linkInterval = 1 / LINK_UPDATE_HZ;
            if (_linkAccum >= linkInterval) {
                _linkAccum -= linkInterval;
                if (_linkAccum > linkInterval) _linkAccum = 0; // prevent spiral

                // Phase 1: Update link states
                _updateLinkStates();

                // Phase 3: Process jammers (cheap, runs at link rate)
                _processJammers(linkInterval);

                // Phase 4: Cyber attacks
                _processCyberAttacks(linkInterval, simTime);

                // Phase 6: Network self-healing
                _networkSelfHeal();
            }

            // Throttle routing computation (2 Hz)
            _routeAccum += dt;
            var routeInterval = 1 / ROUTE_UPDATE_HZ;
            if (_routeAccum >= routeInterval) {
                _routeAccum -= routeInterval;
                if (_routeAccum > routeInterval) _routeAccum = 0;

                // Rebuild adjacency for routing
                _buildAdjacency();

                // Phase 2: Route and advance packets
                _processPackets(routeInterval, simTime);

                // Expire stale packets
                _expireStalePackets(simTime);
            }

            // Auto-generate track packets (every 2 seconds sim time)
            _trackGenAccum += dt;
            if (_trackGenAccum >= TRACK_GEN_INTERVAL_S) {
                _trackGenAccum -= TRACK_GEN_INTERVAL_S;
                if (_trackGenAccum > TRACK_GEN_INTERVAL_S) _trackGenAccum = 0;

                // Phase 5: Generate track packets from sensors
                _generateTrackPackets(simTime);
            }

            // Phase 7: Update metrics (every tick, cheap)
            _updateMetrics(dt, simTime);

            // Phase 8: Update entity state (every tick, writes to entity.state)
            _updateEntityState(simTime);
        },

        /**
         * Inject a packet into the network for routing.
         * @param {Object} packet - Packet object (see data model)
         * @returns {string} The assigned packet ID
         */
        sendPacket: function(packet) {
            if (!_initialized) return null;

            // Assign ID if not present
            if (!packet.id) {
                packet.id = 'pkt_' + _nextPacketId++;
            }

            // Set defaults
            packet.ttl = packet.ttl || 10;
            packet.priority = packet.priority || 5;
            packet.size_bytes = packet.size_bytes || 256;
            packet.createdAt = packet.createdAt || (_world ? _world.simTime : 0);
            packet.path = packet.path || null;
            packet.currentHop = 0;
            packet.delivered = false;
            packet.dropped = false;
            packet.dropReason = null;
            packet.deliveryTime = null;
            packet.hops = [];
            packet._hopStartTime = packet.createdAt;

            _packets.push(packet);

            _metrics.totalPacketsSent++;
            _metrics.totalBytesSent += packet.size_bytes;
            _metrics.windowPacketsSent++;

            // Update source entity stats
            if (_world && packet.sourceId) {
                var srcEntity = _world.getEntity(packet.sourceId);
                if (srcEntity) {
                    srcEntity.state._commPacketsSent =
                        (srcEntity.state._commPacketsSent || 0) + 1;
                }
            }

            return packet.id;
        },

        /**
         * Get status of all networks and their links.
         * @returns {Array} Array of network status objects
         */
        getNetworkStatus: function() {
            var statuses = [];

            for (var n = 0; n < _networks.length; n++) {
                var net = _networks[n];
                var netId = net.id;
                var members = net.members || [];

                // Gather links for this network
                var netLinks = [];
                var totalLinks = 0;
                var aliveLinks = 0;
                var jammedLinks = 0;
                var avgMargin = 0;
                var marginCount = 0;

                var totalUtilization = 0;
                var compromisedLinks = 0;

                _links.forEach(function(link) {
                    if (link.networkId !== netId) return;
                    totalLinks++;
                    netLinks.push({
                        fromId: link.fromId,
                        toId: link.toId,
                        quality: link.quality,
                        margin_db: link.margin_db,
                        distance_m: link.distance_m,
                        latency_ms: link.latency_ms,
                        throughput_bps: link.throughput_bps,
                        jammed: link.jammed,
                        alive: link.alive,
                        utilization: link.utilization,
                        cyberCompromised: link.cyberCompromised,
                        linkType: link.linkType
                    });
                    if (link.alive && link.quality !== QUALITY.LOST) {
                        aliveLinks++;
                        avgMargin += link.margin_db;
                        marginCount++;
                        totalUtilization += (link.utilization || 0);
                    }
                    if (link.jammed) jammedLinks++;
                    if (link.cyberCompromised) compromisedLinks++;
                });

                // Count active members
                var activeMembers = 0;
                for (var m = 0; m < members.length; m++) {
                    var node = _entityNodes.get(members[m]);
                    if (node && node.active && !node.bricked) activeMembers++;
                }

                // Health as numeric 0-1 for UI compatibility
                var healthNum = totalLinks > 0 ? aliveLinks / totalLinks : 0;
                if (jammedLinks > 0 && healthNum > 0.5) healthNum = Math.max(0.3, healthNum - 0.2);

                statuses.push({
                    id: netId,
                    name: net.name || netId,
                    type: net.type || 'mesh',
                    totalMembers: members.length,
                    activeMembers: activeMembers,
                    totalLinks: totalLinks,
                    activeLinks: aliveLinks,
                    aliveLinks: aliveLinks,
                    jammedLinks: jammedLinks,
                    compromisedLinks: compromisedLinks,
                    avgMargin_db: marginCount > 0 ? avgMargin / marginCount : 0,
                    avgUtilization: aliveLinks > 0 ? totalUtilization / aliveLinks : 0,
                    health: healthNum,
                    healthStatus: aliveLinks === 0 ? 'DOWN'
                        : aliveLinks < totalLinks * 0.5 ? 'DEGRADED'
                        : jammedLinks > 0 ? 'CONTESTED'
                        : 'HEALTHY',
                    links: netLinks
                });
            }

            return statuses;
        },

        /**
         * Get status of a specific link between two entities.
         * @param {string} fromId - Source entity ID
         * @param {string} toId - Destination entity ID
         * @returns {Object|null} Link status or null if not found
         */
        getLinkStatus: function(fromId, toId) {
            var key = _bidiLinkKey(fromId, toId);
            var link = _links.get(key);
            if (!link) return null;

            return {
                fromId: link.fromId,
                toId: link.toId,
                networkId: link.networkId,
                linkType: link.linkType,
                quality: link.quality,
                margin_db: link.margin_db,
                distance_m: link.distance_m,
                hasLOS: link.hasLOS,
                throughput_bps: link.throughput_bps,
                latency_ms: link.latency_ms,
                packetLoss: link.packetLoss,
                utilization: link.utilization,
                jammed: link.jammed,
                jamStrength_db: link.jamStrength_db,
                cyberCompromised: link.cyberCompromised,
                alive: link.alive,
                _activePacketType: link._activePacketType || null
            };
        },

        /**
         * Get all comm info for a specific entity.
         * @param {string} entityId - Entity ID
         * @returns {Object|null} Entity comm info or null
         */
        getEntityComms: function(entityId) {
            var node = _entityNodes.get(entityId);
            if (!node) return null;

            var entity = _world ? _world.getEntity(entityId) : null;
            var links = [];
            var totalBw = 0;
            var avgLatency = 0;
            var linkCount = 0;

            _links.forEach(function(link) {
                if (link.fromId !== entityId && link.toId !== entityId) return;
                var peerId = (link.fromId === entityId) ? link.toId : link.fromId;
                links.push({
                    peerId: peerId,
                    quality: link.quality,
                    margin_db: link.margin_db,
                    distance_m: link.distance_m,
                    latency_ms: link.latency_ms,
                    throughput_bps: link.throughput_bps,
                    jammed: link.jammed,
                    alive: link.alive,
                    utilization: link.utilization,
                    networkId: link.networkId
                });
                if (link.alive && link.quality !== QUALITY.LOST) {
                    totalBw += link.throughput_bps;
                    avgLatency += link.latency_ms;
                    linkCount++;
                }
            });

            // Count in-flight packets from/to this entity
            var packetsInFlight = 0;
            for (var p = 0; p < _packets.length; p++) {
                var pkt = _packets[p];
                if (pkt.sourceId === entityId || pkt.destId === entityId) {
                    packetsInFlight++;
                }
            }

            // Get route to command node
            var cmdRoute = null;
            var cmdNodeId = _findCommandNode(entityId);
            if (cmdNodeId) {
                var route = _dijkstra(entityId, cmdNodeId);
                if (route) {
                    cmdRoute = {
                        destId: cmdNodeId,
                        path: route.path,
                        latency_ms: route.totalLatency_ms,
                        hops: route.path.length - 1
                    };
                }
            }

            return {
                entityId: entityId,
                active: node.active,
                bricked: node.bricked,
                compromised: node.compromised,
                ddosed: node.ddosed,
                mitm: node.mitm,
                networks: Array.from(node.networks),
                links: links,
                totalBandwidth_mbps: totalBw / 1e6,
                avgLatency_ms: linkCount > 0 ? avgLatency / linkCount : 0,
                activeLinks: linkCount,
                packetsInFlight: packetsInFlight,
                packetsSent: entity ? (entity.state._commPacketsSent || 0) : 0,
                packetsReceived: entity ? (entity.state._commPacketsRecv || 0) : 0,
                commandRoute: cmdRoute
            };
        },

        /**
         * Register a jammer entity.
         * @param {string} jammerId - Unique jammer identifier
         * @param {Object} config - Jammer configuration
         */
        addJammer: function(jammerId, config) {
            var jammer = {
                id: jammerId,
                entityId: config.entityId || jammerId,
                type: config.type || 'noise',
                targetFreq_ghz: config.targetFreq_ghz || 12.5,
                bandwidth_ghz: config.bandwidth_ghz || 0.5,
                power_dbw: config.power_dbw || 40,
                range_m: config.range_m || 200000,
                active: config.active !== false,
                direction: config.direction || 'both',
                _baseFreq: config.targetFreq_ghz || 12.5,
                _sweepPhase: 0
            };

            _jammers.set(jammerId, jammer);
            console.log('[CommEngine] Jammer added: ' + jammerId + ' type=' + jammer.type
                + ' freq=' + jammer.targetFreq_ghz + ' GHz power=' + jammer.power_dbw + ' dBW');
        },

        /**
         * Remove a jammer entity.
         * @param {string} jammerId - Jammer identifier to remove
         */
        removeJammer: function(jammerId) {
            _jammers.delete(jammerId);
        },

        /**
         * Register a cyber attack.
         * @param {Object} attack - Cyber attack configuration
         * @returns {string} The attack ID
         */
        addCyberAttack: function(attack) {
            var id = attack.id || ('cyber_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4));
            var cyberAttack = {
                id: id,
                attackerId: attack.attackerId,
                targetId: attack.targetId,
                type: attack.type || 'exploit',
                progress: 0,
                duration_s: attack.duration_s || 30,
                active: true,
                effect: null
            };

            _cyberAttacks.set(id, cyberAttack);
            console.log('[CommEngine] Cyber attack registered: ' + id + ' type=' + cyberAttack.type
                + ' attacker=' + cyberAttack.attackerId + ' target=' + cyberAttack.targetId);
            return id;
        },

        /**
         * Get the recent packet log (circular buffer).
         * @returns {Array} Array of packet objects
         */
        getPacketLog: function() {
            if (!_packetLogFull) return _packetLog.slice();

            // Reconstruct in chronological order from circular buffer
            var result = [];
            for (var i = _packetLogIdx; i < PACKET_LOG_MAX; i++) {
                if (_packetLog[i]) result.push(_packetLog[i]);
            }
            for (var j = 0; j < _packetLogIdx; j++) {
                if (_packetLog[j]) result.push(_packetLog[j]);
            }
            return result;
        },

        /**
         * Get aggregate metrics.
         * @returns {Object} Metrics object with throughput, latency, delivery stats
         */
        getMetrics: function() {
            return {
                totalPacketsSent: _metrics.totalPacketsSent,
                totalPacketsDelivered: _metrics.totalPacketsDelivered,
                totalPacketsDropped: _metrics.totalPacketsDropped,
                totalBytesSent: _metrics.totalBytesSent,
                totalBytesDelivered: _metrics.totalBytesDelivered,
                packetDeliveryRate: _metrics.packetDeliveryRate,
                avgLatency_ms: _metrics.avgLatency_ms,
                packetsInFlight: _packets.length,
                activeLinks: _countActiveLinks(),
                totalLinks: _links.size,
                activeJammers: _countActiveJammers(),
                activeCyberAttacks: _countActiveCyberAttacks(),
                activeNodes: _countActiveNodes(),
                totalNodes: _entityNodes.size,
                // Per-network summaries
                networks: _getNetworkSummaries()
            };
        },

        /**
         * Clean up all state. Call when leaving the sim.
         */
        destroy: function() {
            _initialized = false;
            _networks = [];
            _networkMap.clear();
            _links.clear();
            _entityNetworks.clear();
            _entityNodes.clear();
            _jammers.clear();
            _cyberAttacks.clear();
            _packets = [];
            _packetLog = [];
            _packetLogIdx = 0;
            _packetLogFull = false;
            _adjacency.clear();
            _world = null;

            console.log('[CommEngine] Destroyed');
        },

        // -------------------------------------------------------------------
        // Additional query APIs
        // -------------------------------------------------------------------

        /**
         * Check if the engine is initialized.
         * @returns {boolean}
         */
        isInitialized: function() {
            return _initialized;
        },

        /**
         * Get all networks.
         * @returns {Array} Network definitions
         */
        getNetworks: function() {
            return _networks.slice();
        },

        /**
         * Get a specific network by ID.
         * @param {string} netId - Network ID
         * @returns {Object|null}
         */
        getNetwork: function(netId) {
            return _networkMap.get(netId) || null;
        },

        /**
         * Get all entity IDs in the comm network.
         * @returns {Array<string>}
         */
        getNetworkEntities: function() {
            return Array.from(_entityNodes.keys());
        },

        /**
         * Get all active jammers.
         * @returns {Array}
         */
        getJammers: function() {
            var result = [];
            _jammers.forEach(function(jammer) {
                result.push({
                    id: jammer.id,
                    entityId: jammer.entityId,
                    type: jammer.type,
                    targetFreq_ghz: jammer.targetFreq_ghz,
                    bandwidth_ghz: jammer.bandwidth_ghz,
                    power_dbw: jammer.power_dbw,
                    range_m: jammer.range_m,
                    active: jammer.active,
                    direction: jammer.direction
                });
            });
            return result;
        },

        /**
         * Get all cyber attacks and their progress.
         * @returns {Array}
         */
        getCyberAttacks: function() {
            var result = [];
            _cyberAttacks.forEach(function(attack) {
                result.push({
                    id: attack.id,
                    attackerId: attack.attackerId,
                    targetId: attack.targetId,
                    type: attack.type,
                    progress: attack.progress,
                    duration_s: attack.duration_s,
                    active: attack.active,
                    effect: attack.effect
                });
            });
            return result;
        },

        /**
         * Get targeting status for a weapon entity.
         * Returns comm-delivered targeting data and its quality.
         * @param {string} entityId - The weapon entity ID
         * @returns {Object} Targeting status including track count, avg latency, quality
         */
        getTargetingStatus: function(entityId) {
            if (!_world) return null;
            var entity = _world.getEntity(entityId);
            if (!entity) return null;

            var targets = entity.state._commTargets || {};
            var tgtKeys = Object.keys(targets);
            var commFed = tgtKeys.length > 0;
            var avgLatency = 0;
            var maxLatency = 0;
            var totalHops = 0;
            var freshCount = 0;
            var simTime = _world.simTime || 0;

            for (var i = 0; i < tgtKeys.length; i++) {
                var tgt = targets[tgtKeys[i]];
                var lat = tgt._totalLatency_s || 0;
                avgLatency += lat;
                if (lat > maxLatency) maxLatency = lat;
                totalHops += (tgt._hops || 0);
                // Track is "fresh" if time since creation < 5s
                if (tgt.time && (simTime - tgt.time) < 5) freshCount++;
            }
            if (tgtKeys.length > 0) avgLatency /= tgtKeys.length;

            var quality = 'NONE';
            if (commFed) {
                if (avgLatency < 1.0 && freshCount === tgtKeys.length) quality = 'EXCELLENT';
                else if (avgLatency < 3.0 && freshCount > 0) quality = 'GOOD';
                else if (freshCount > 0) quality = 'DEGRADED';
                else quality = 'STALE';
            }

            return {
                commFed: commFed,
                trackCount: tgtKeys.length,
                freshTracks: freshCount,
                avgLatency_s: avgLatency,
                maxLatency_s: maxLatency,
                avgHops: tgtKeys.length > 0 ? totalHops / tgtKeys.length : 0,
                quality: quality,
                hasOrganic: !!(entity.state._detections && entity.state._detections.length > 0),
                isJammed: !!(entity.state._commJammed),
                commandNode: tgtKeys.length > 0 ? targets[tgtKeys[0]]._commandNodeId : null
            };
        },

        /**
         * Add a network dynamically at runtime.
         * @param {Object} network - Network definition
         */
        addNetwork: function(network) {
            var netId = network.id || ('net_dyn_' + _networks.length);
            network.id = netId;
            _networks.push(network);
            _networkMap.set(netId, network);

            // Build links for the new network
            var members = network.members || [];
            var config = network.config || {};
            var type = network.type || 'mesh';

            // Register new members
            for (var m = 0; m < members.length; m++) {
                var memberId = members[m];
                if (!_entityNetworks.has(memberId)) {
                    _entityNetworks.set(memberId, new Set());
                }
                _entityNetworks.get(memberId).add(netId);

                if (!_entityNodes.has(memberId)) {
                    _entityNodes.set(memberId, {
                        entityId: memberId,
                        active: true,
                        bricked: false,
                        compromised: false,
                        ddosed: false,
                        mitm: false,
                        networks: new Set()
                    });
                }
                _entityNodes.get(memberId).networks.add(netId);
            }

            // Build links
            switch (type) {
                case 'mesh':    _buildMeshLinks(members, netId, config); break;
                case 'star':    _buildStarLinks(members, network.hub, netId, config); break;
                case 'multihop': _buildMultihopLinks(network.path || members, netId, config); break;
                case 'custom':  _buildCustomLinks(network.links || [], netId, config); break;
            }

            console.log('[CommEngine] Network added: ' + netId + ' (' + type + ') with '
                + members.length + ' members');
        },

        /**
         * Remove a network at runtime.
         * @param {string} netId - Network ID to remove
         */
        removeNetwork: function(netId) {
            // Remove links belonging to this network
            var keysToDelete = [];
            _links.forEach(function(link, key) {
                if (link.networkId === netId) {
                    keysToDelete.push(key);
                }
            });
            for (var i = 0; i < keysToDelete.length; i++) {
                _links.delete(keysToDelete[i]);
            }

            // Remove network from entity membership
            _entityNetworks.forEach(function(nets, entityId) {
                nets.delete(netId);
            });
            _entityNodes.forEach(function(node) {
                node.networks.delete(netId);
            });

            // Remove from network list
            _networkMap.delete(netId);
            for (var n = _networks.length - 1; n >= 0; n--) {
                if (_networks[n].id === netId) {
                    _networks.splice(n, 1);
                    break;
                }
            }
        },

        /**
         * Set weather conditions affecting RF propagation.
         * @param {Object} weather - { rain_mm_hr: number }
         */
        setWeather: function(weather) {
            // Store weather for future link budget rain fade computation
            _weather = weather;
        },

        /**
         * Get shortest route between two entities.
         * @param {string} fromId - Source entity ID
         * @param {string} toId - Destination entity ID
         * @returns {Object|null} Route { path, totalCost, totalLatency_ms } or null
         */
        getRoute: function(fromId, toId) {
            _buildAdjacency();
            return _dijkstra(fromId, toId);
        },

        /**
         * Cancel an active cyber attack.
         * @param {string} attackId - Attack ID
         */
        cancelCyberAttack: function(attackId) {
            var attack = _cyberAttacks.get(attackId);
            if (attack) {
                attack.active = false;
                // Reverse effects if attack was completed
                if (attack.effect) {
                    var node = _entityNodes.get(attack.targetId);
                    if (node) {
                        switch (attack.type) {
                            case 'brick':
                                node.bricked = false;
                                node.active = true;
                                break;
                            case 'mitm':
                                node.mitm = false;
                                node.compromised = false;
                                break;
                            case 'ddos':
                                node.ddosed = false;
                                break;
                            case 'exploit':
                            case 'inject':
                                node.compromised = false;
                                break;
                        }
                    }
                    // Clear entity state
                    if (_world) {
                        var entity = _world.getEntity(attack.targetId);
                        if (entity) {
                            entity.state._commCyber = null;
                        }
                    }
                }
                _cyberAttacks.delete(attackId);
            }
        },

        // Expose constants for external use
        QUALITY: QUALITY,
        DROP_REASONS: DROP
    };

    // -----------------------------------------------------------------------
    // Internal helpers for metrics
    // -----------------------------------------------------------------------

    var _weather = null;

    function _countActiveLinks() {
        var count = 0;
        _links.forEach(function(link) {
            if (link.alive && link.quality !== QUALITY.LOST) count++;
        });
        return count;
    }

    function _countActiveJammers() {
        var count = 0;
        _jammers.forEach(function(j) { if (j.active) count++; });
        return count;
    }

    function _countActiveCyberAttacks() {
        var count = 0;
        _cyberAttacks.forEach(function(a) { if (a.active) count++; });
        return count;
    }

    function _countActiveNodes() {
        var count = 0;
        _entityNodes.forEach(function(n) { if (n.active && !n.bricked) count++; });
        return count;
    }

    function _getNetworkSummaries() {
        var summaries = [];
        for (var n = 0; n < _networks.length; n++) {
            var net = _networks[n];
            var netId = net.id;
            var alive = 0;
            var total = 0;
            var jammed = 0;

            _links.forEach(function(link) {
                if (link.networkId !== netId) return;
                total++;
                if (link.alive && link.quality !== QUALITY.LOST) alive++;
                if (link.jammed) jammed++;
            });

            summaries.push({
                id: netId,
                name: net.name || netId,
                type: net.type || 'mesh',
                aliveLinks: alive,
                totalLinks: total,
                jammedLinks: jammed,
                health: alive === 0 ? 'DOWN'
                    : alive < total * 0.5 ? 'DEGRADED'
                    : jammed > 0 ? 'CONTESTED'
                    : 'HEALTHY'
            });
        }
        return summaries;
    }

    // -----------------------------------------------------------------------
    // Expose
    // -----------------------------------------------------------------------
    window.CommEngine = CommEngine;

})();
