/**
 * Weather & Terrain System
 * Wind layers, cloud/visibility model, turbulence, and Cesium terrain queries.
 * Integrates with the 3-DOF flight physics engine to apply environmental forces.
 */
var WeatherSystem = (function() {
    'use strict';

    var DEG = Math.PI / 180;

    // --------------- State ---------------

    var _viewer = null;
    var _simTime = 0;
    var _gustPhase = 0;
    var _conditions = null;
    var _terrainCache = {};          // key → {alt, time}
    var _terrainCacheMax = 1000;
    var _terrainCacheEvictAge = 60;  // seconds
    var _terrainQueryInterval = 2;   // seconds between periodic re-queries
    var _terrainQueryTimer = 0;

    // --------------- Default conditions ---------------

    var DEFAULT_CONDITIONS = {
        windLayers: [
            { altMin: 0, altMax: 30000, speed: 5, heading: 270 * DEG, gustFactor: 0.15 }
        ],
        clouds: [],
        visibility_km: 50,
        turbulenceLevel: 0,
        precipitation: 'none'
    };

    // --------------- Presets ---------------

    var WEATHER_PRESETS = {
        'clear': {
            windLayers: [
                { altMin: 0, altMax: 30000, speed: 3, heading: 270 * DEG, gustFactor: 0.1 }
            ],
            clouds: [],
            visibility_km: 50,
            turbulenceLevel: 0,
            precipitation: 'none'
        },
        'overcast': {
            windLayers: [
                { altMin: 0, altMax: 3000, speed: 8, heading: 250 * DEG, gustFactor: 0.3 },
                { altMin: 3000, altMax: 12000, speed: 20, heading: 240 * DEG, gustFactor: 0.2 }
            ],
            clouds: [
                { altBase: 1500, altTop: 3000, coverage: 0.9, type: 'stratus' }
            ],
            visibility_km: 5,
            turbulenceLevel: 1,
            precipitation: 'none'
        },
        'stormy': {
            windLayers: [
                { altMin: 0, altMax: 3000, speed: 20, heading: 200 * DEG, gustFactor: 0.5 },
                { altMin: 3000, altMax: 8000, speed: 40, heading: 210 * DEG, gustFactor: 0.4 },
                { altMin: 8000, altMax: 15000, speed: 50, heading: 230 * DEG, gustFactor: 0.2 }
            ],
            clouds: [
                { altBase: 500, altTop: 2000, coverage: 1.0, type: 'stratus' },
                { altBase: 3000, altTop: 10000, coverage: 0.8, type: 'cumulonimbus' }
            ],
            visibility_km: 2,
            turbulenceLevel: 3,
            precipitation: 'rain'
        },
        'high_altitude_clear': {
            windLayers: [
                { altMin: 0, altMax: 5000, speed: 5, heading: 270 * DEG, gustFactor: 0.1 },
                { altMin: 8000, altMax: 14000, speed: 80, heading: 260 * DEG, gustFactor: 0.1 }
            ],
            clouds: [],
            visibility_km: 100,
            turbulenceLevel: 0,
            precipitation: 'none'
        },
        'arctic': {
            windLayers: [
                { altMin: 0, altMax: 5000, speed: 15, heading: 0, gustFactor: 0.4 },
                { altMin: 5000, altMax: 10000, speed: 30, heading: 350 * DEG, gustFactor: 0.3 }
            ],
            clouds: [
                { altBase: 300, altTop: 1500, coverage: 0.6, type: 'stratus' }
            ],
            visibility_km: 3,
            turbulenceLevel: 1,
            precipitation: 'snow'
        }
    };

    // --------------- Initialization ---------------

    function init(viewer, preset) {
        _viewer = viewer || null;
        _simTime = 0;
        _gustPhase = 0;
        _terrainCache = {};
        _terrainQueryTimer = 0;

        if (preset && typeof preset === 'string' && WEATHER_PRESETS[preset]) {
            _conditions = _deepCopy(WEATHER_PRESETS[preset]);
        } else if (preset && typeof preset === 'object') {
            _conditions = _deepCopy(preset);
        } else {
            _conditions = _deepCopy(DEFAULT_CONDITIONS);
        }
    }

    // --------------- Configuration ---------------

    function setConditions(config) {
        if (!config) {
            _conditions = _deepCopy(DEFAULT_CONDITIONS);
            return;
        }
        _conditions = {
            windLayers: config.windLayers ? config.windLayers.slice() : [],
            clouds: config.clouds ? config.clouds.slice() : [],
            visibility_km: (config.visibility_km != null) ? config.visibility_km : 50,
            turbulenceLevel: (config.turbulenceLevel != null) ? config.turbulenceLevel : 0,
            precipitation: config.precipitation || 'none'
        };
        // Sort wind layers by altMin ascending for consistent interpolation
        _conditions.windLayers.sort(function(a, b) { return a.altMin - b.altMin; });
    }

    // --------------- Wind Model ---------------

    /**
     * Get wind at a given altitude.
     * @param {number} alt - Altitude in meters above sea level
     * @returns {{speed_ms: number, heading_rad: number, gust_ms: number}}
     *   heading_rad: meteorological convention (270 DEG = wind FROM west = blowing east)
     */
    function getWind(alt) {
        if (!_conditions || !_conditions.windLayers || _conditions.windLayers.length === 0) {
            return { speed_ms: 0, heading_rad: 0, gust_ms: 0 };
        }

        var layers = _conditions.windLayers;
        var speed = 0;
        var headingX = 0;  // sin component for circular averaging
        var headingY = 0;  // cos component for circular averaging
        var gustFactor = 0;
        var totalWeight = 0;

        // Accumulate contribution from each layer
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var w = _layerWeight(alt, layer);
            if (w > 0) {
                speed += layer.speed * w;
                headingX += Math.sin(layer.heading) * w;
                headingY += Math.cos(layer.heading) * w;
                gustFactor += (layer.gustFactor || 0) * w;
                totalWeight += w;
            }
        }

        if (totalWeight > 0) {
            speed /= totalWeight;
            headingX /= totalWeight;
            headingY /= totalWeight;
            gustFactor /= totalWeight;
        }

        // Surface friction: linear decrease to 0 at ground level
        var lowestAltMin = layers[0].altMin;
        if (alt < lowestAltMin && lowestAltMin > 0) {
            var surfaceFrac = Math.max(0, alt / lowestAltMin);
            speed *= surfaceFrac;
        }

        // Upper atmosphere decay: wind drops to 0 above 30km
        var upperDecayStart = 20000;
        var upperDecayEnd = 30000;
        if (alt > upperDecayStart) {
            var decayFrac = 1.0 - Math.min(1.0, (alt - upperDecayStart) / (upperDecayEnd - upperDecayStart));
            speed *= decayFrac;
        }

        // Compute heading from averaged sin/cos components
        var heading = Math.atan2(headingX, headingY);
        if (heading < 0) heading += 2 * Math.PI;

        // Gust: deterministic sinusoidal variation
        var gust = gustFactor * speed * Math.sin(_gustPhase * 2.7 + alt * 0.001);

        return {
            speed_ms: speed,
            heading_rad: heading,
            gust_ms: gust
        };
    }

    /**
     * Compute blending weight for a wind layer at a given altitude.
     * Returns 1.0 when fully inside the layer, 0.0 when outside,
     * and linear blend in a 500m transition zone on each edge.
     */
    function _layerWeight(alt, layer) {
        var blendZone = 500; // meters of transition at layer edges
        if (alt < layer.altMin - blendZone || alt > layer.altMax + blendZone) {
            return 0;
        }
        var w = 1.0;
        // Fade in at bottom
        if (alt < layer.altMin + blendZone) {
            w = Math.min(w, (alt - (layer.altMin - blendZone)) / (2 * blendZone));
        }
        // Fade out at top
        if (alt > layer.altMax - blendZone) {
            w = Math.min(w, ((layer.altMax + blendZone) - alt) / (2 * blendZone));
        }
        return Math.max(0, Math.min(1, w));
    }

    /**
     * Apply wind effects to a flight state.
     * @param {object} state - Flight state with {alt, speed, heading, gamma, roll}
     *   and optionally {aeroBlend} (0 in vacuum, 1 in atmosphere)
     * @param {number} dt - Time step in seconds
     * @returns {{dSpeed: number, dHeading: number, dGamma: number, dRoll: number}}
     *   Deltas to be applied by the physics engine
     */
    function applyWindToState(state, dt) {
        var result = { dSpeed: 0, dHeading: 0, dGamma: 0, dRoll: 0 };

        if (!_conditions) return result;

        var aeroBlend = (state.aeroBlend != null) ? state.aeroBlend : 1.0;
        if (aeroBlend < 0.01) return result; // No atmospheric effects in vacuum

        var wind = getWind(state.alt);
        if (wind.speed_ms < 0.01 && _conditions.turbulenceLevel === 0) return result;

        // Effective wind speed including gust
        var effectiveSpeed = wind.speed_ms + wind.gust_ms;

        // Wind component along aircraft heading (headwind positive = opposing flight)
        // Meteorological heading is where wind comes FROM, so a 270 DEG wind blows toward east (090).
        // headwind > 0 means wind opposes aircraft motion
        var windAngleDiff = wind.heading_rad - state.heading;
        var headwind = effectiveSpeed * Math.cos(windAngleDiff);
        var crosswind = effectiveSpeed * Math.sin(windAngleDiff);

        // Speed perturbation: headwind reduces groundspeed, tailwind increases
        result.dSpeed = (-headwind * 0.01) * dt * aeroBlend;

        // Heading drift from crosswind
        result.dHeading = (crosswind * 0.001) * dt * aeroBlend;

        // Turbulence perturbations
        var turb = _conditions.turbulenceLevel;
        if (turb > 0) {
            result.dGamma += (Math.random() - 0.5) * turb * 0.5 * dt * aeroBlend;
            result.dRoll += (Math.random() - 0.5) * turb * 1.0 * dt * aeroBlend;
            result.dSpeed += (Math.random() - 0.5) * turb * 2.0 * dt * aeroBlend;
        }

        return result;
    }

    // --------------- Cloud / Visibility Model ---------------

    /**
     * Check if a given altitude is inside a cloud layer.
     * @param {number} alt - Altitude in meters
     * @returns {{inCloud: boolean, coverage: number, type: string}}
     */
    function getCloudLayer(alt) {
        if (!_conditions || !_conditions.clouds) {
            return { inCloud: false, coverage: 0, type: 'clear' };
        }

        for (var i = 0; i < _conditions.clouds.length; i++) {
            var cloud = _conditions.clouds[i];
            if (alt >= cloud.altBase && alt <= cloud.altTop) {
                return {
                    inCloud: true,
                    coverage: cloud.coverage,
                    type: cloud.type || 'stratus'
                };
            }
        }

        return { inCloud: false, coverage: 0, type: 'clear' };
    }

    /**
     * Get effective visibility at a given altitude.
     * @param {number} alt - Altitude in meters
     * @returns {number} Visibility in km, clamped to [0.01, 200]
     */
    function getVisibility(alt) {
        if (!_conditions) return 200;

        // Above 15km: always unlimited
        if (alt > 15000) return 200;

        var vis = _conditions.visibility_km || 50;

        // Cloud obscuration
        var cloud = getCloudLayer(alt);
        if (cloud.inCloud) {
            vis = Math.min(vis, 0.1);
        }

        // Precipitation reduction
        var precip = _conditions.precipitation;
        if (precip === 'rain') {
            vis *= 0.3;
        } else if (precip === 'snow') {
            vis *= 0.2;
        } else if (precip === 'ice') {
            vis *= 0.5;
        }

        // Clamp
        return Math.max(0.01, Math.min(200, vis));
    }

    // --------------- Turbulence ---------------

    /**
     * Get turbulence parameters at given altitude and speed.
     * @param {number} alt - Altitude in meters
     * @param {number} speed - Airspeed in m/s
     * @returns {{intensity: number, gLoad_variation: number}}
     */
    function getTurbulence(alt, speed) {
        if (!_conditions) return { intensity: 0, gLoad_variation: 0 };

        var base = _conditions.turbulenceLevel || 0;

        // Increase near cloud tops: +0.5 if within 500m above a cloud top
        if (_conditions.clouds) {
            for (var i = 0; i < _conditions.clouds.length; i++) {
                var cloud = _conditions.clouds[i];
                var distAboveTop = alt - cloud.altTop;
                if (distAboveTop >= 0 && distAboveTop < 500) {
                    base += 0.5;
                    break; // Only apply once
                }
            }
        }

        // Increase at low altitude with high wind: +0.5 if below 1000m and wind > 10 m/s
        if (alt < 1000) {
            var wind = getWind(alt);
            if (wind.speed_ms > 10) {
                base += 0.5;
            }
        }

        // Decrease above 15km
        if (alt > 15000) {
            var decayFrac = 1.0 - Math.min(1.0, (alt - 15000) / 5000);
            base *= decayFrac;
        }

        // Clamp intensity to [0, 3]
        var intensity = Math.max(0, Math.min(3, base));
        var gLoad = intensity * 0.3;

        return {
            intensity: intensity,
            gLoad_variation: gLoad
        };
    }

    // --------------- Terrain Queries ---------------

    /**
     * Async terrain altitude query via Cesium terrain provider.
     * Results are cached with lat/lon rounded to 0.01 degree.
     * @param {number} lat_rad - Latitude in radians
     * @param {number} lon_rad - Longitude in radians
     * @param {object} [viewer] - Cesium viewer (uses stored reference if omitted)
     * @returns {Promise<number>} Terrain altitude in meters
     */
    function getTerrainAlt(lat_rad, lon_rad, viewer) {
        var v = viewer || _viewer;
        if (!v || !v.terrainProvider) {
            return Promise.resolve(0);
        }

        var key = _terrainKey(lat_rad, lon_rad);
        var cached = _terrainCache[key];
        if (cached && (_simTime - cached.time) < _terrainCacheEvictAge) {
            return Promise.resolve(cached.alt);
        }

        var carto = [new Cesium.Cartographic(lon_rad, lat_rad)];

        return Cesium.sampleTerrainMostDetailed(v.terrainProvider, carto)
            .then(function(results) {
                var alt = (results && results[0] && results[0].height != null)
                    ? results[0].height : 0;
                _terrainCacheSet(key, alt);
                return alt;
            })
            .catch(function() {
                // Terrain query failed (offline mode, no terrain, etc.)
                return 0;
            });
    }

    /**
     * Synchronous terrain altitude from cache.
     * Returns the last known altitude at the nearest cached grid point.
     * @param {number} lat_rad - Latitude in radians
     * @param {number} lon_rad - Longitude in radians
     * @returns {number} Terrain altitude in meters (0 if no cached data)
     */
    function getTerrainAltCached(lat_rad, lon_rad) {
        var key = _terrainKey(lat_rad, lon_rad);
        var cached = _terrainCache[key];
        return (cached) ? cached.alt : 0;
    }

    /**
     * Round lat/lon to 0.01 degree grid and build a cache key.
     */
    function _terrainKey(lat_rad, lon_rad) {
        var latDeg = Math.round(lat_rad / DEG * 100) / 100;
        var lonDeg = Math.round(lon_rad / DEG * 100) / 100;
        return latDeg + ',' + lonDeg;
    }

    /**
     * Store a terrain altitude in the cache, evicting oldest entries if full.
     */
    function _terrainCacheSet(key, alt) {
        // Evict stale entries if cache is at capacity
        var keys = Object.keys(_terrainCache);
        if (keys.length >= _terrainCacheMax) {
            var oldest = null;
            var oldestTime = Infinity;
            for (var i = 0; i < keys.length; i++) {
                var entry = _terrainCache[keys[i]];
                if (entry.time < oldestTime) {
                    oldestTime = entry.time;
                    oldest = keys[i];
                }
            }
            if (oldest) {
                delete _terrainCache[oldest];
            }
        }
        _terrainCache[key] = { alt: alt, time: _simTime };
    }

    /**
     * Evict terrain cache entries older than the eviction age.
     */
    function _evictStaleTerrain() {
        var keys = Object.keys(_terrainCache);
        for (var i = 0; i < keys.length; i++) {
            if ((_simTime - _terrainCache[keys[i]].time) > _terrainCacheEvictAge) {
                delete _terrainCache[keys[i]];
            }
        }
    }

    // --------------- Update ---------------

    /**
     * Per-frame update. Call once per simulation tick.
     * @param {number} dt - Time step in seconds
     * @param {number} simTime - Current simulation time in seconds
     */
    function update(dt, simTime) {
        _simTime = simTime;
        _gustPhase += dt;

        // Periodic terrain cache eviction
        _terrainQueryTimer += dt;
        if (_terrainQueryTimer >= _terrainQueryInterval) {
            _terrainQueryTimer = 0;
            _evictStaleTerrain();
        }
    }

    // --------------- Utilities ---------------

    function _deepCopy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    // --------------- Public API ---------------

    return {
        init: init,
        setConditions: setConditions,
        getWind: getWind,
        getCloudLayer: getCloudLayer,
        getVisibility: getVisibility,
        getTurbulence: getTurbulence,
        getTerrainAlt: getTerrainAlt,
        getTerrainAltCached: getTerrainAltCached,
        applyWindToState: applyWindToState,
        update: update,
        PRESETS: WEATHER_PRESETS
    };
})();
