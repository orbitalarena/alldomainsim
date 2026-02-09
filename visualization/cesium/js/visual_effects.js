/**
 * SimEffects - Lightweight visual effects for Cesium flight/space simulator.
 *
 * Renders explosions, engine exhaust, reentry glow, missile trails, and sonic
 * boom rings using billboards, polylines, and ellipsoids. No ParticleSystem
 * usage -- all effects are budget-friendly for 60fps with many entities.
 *
 * API:
 *   SimEffects.init(viewer)
 *   SimEffects.update(dt, entities)
 *   SimEffects.spawnExplosion(position, size, color)
 *   SimEffects.spawnMissileTrail(startPos, endPos, duration, color)
 *   SimEffects.setEngineExhaust(entityId, position, direction, throttle, mode)
 *   SimEffects.setReentryGlow(entityId, position, intensity)
 *   SimEffects.cleanup()
 *
 * Depends on: Cesium
 */
const SimEffects = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------
    var MAX_EXPLOSIONS = 10;
    var MAX_TRAILS = 20;
    var EXPLOSION_TOTAL_DURATION = 2.0;   // seconds
    var EXPLOSION_EXPAND_DURATION = 0.5;
    var EXPLOSION_FADE_DURATION = 1.5;
    var FLASH_DURATION = 0.3;
    var DEBRIS_COUNT_MIN = 8;
    var DEBRIS_COUNT_MAX = 12;
    var DEBRIS_SPEED_MIN = 200;   // m/s
    var DEBRIS_SPEED_MAX = 1000;
    var DEBRIS_FADE_MIN = 2.0;    // seconds
    var DEBRIS_FADE_MAX = 3.0;
    var TRAIL_PERSIST_DURATION = 3.0; // seconds after arrival
    var SONIC_BOOM_DURATION = 1.0;
    var SONIC_BOOM_MAX_RADIUS = 2000; // meters

    var SIZE_TABLE = {
        small:  200,
        medium: 500,
        large:  5000
    };

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _viewer = null;
    var _billboardCollection = null;

    // Pre-generated canvas textures (created once at init)
    var _texAirExhaust = null;
    var _texRocketExhaust = null;
    var _texHypersonicExhaust = null;
    var _texIonExhaust = null;
    var _texReentry = null;
    var _texExplosionFlash = null;

    // Active effect pools
    var _explosions = [];     // {elapsed, duration, sphere, flash, debris[], entities[]}
    var _trails = [];         // {elapsed, duration, persist, entity, arrived}
    var _exhaustMap = {};     // entityId -> {billboard, mode}
    var _reentryMap = {};     // entityId -> {billboard}
    var _sonicBooms = [];     // {elapsed, entity, position}

    // Mach state tracking for sonic boom detection
    var _prevMach = {};       // entityId -> previous mach number

    // Scratch vectors (avoid per-frame allocation)
    var _scratchCartesian = new Cesium.Cartesian3();
    var _scratchOffset = new Cesium.Cartesian3();

    // -----------------------------------------------------------------------
    // Texture generation (offscreen canvas, created once)
    // -----------------------------------------------------------------------

    /**
     * Create a radial gradient texture on an offscreen canvas.
     * @param {number} size - Canvas width/height in pixels
     * @param {Array} stops - [[offset, cssColor], ...]
     * @returns {HTMLCanvasElement}
     */
    function _createGradientTexture(size, stops) {
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var half = size / 2;
        var grad = ctx.createRadialGradient(half, half, 0, half, half, half);
        for (var i = 0; i < stops.length; i++) {
            grad.addColorStop(stops[i][0], stops[i][1]);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        return canvas;
    }

    function _initTextures() {
        // AIR exhaust: white center -> blue-white -> transparent
        _texAirExhaust = _createGradientTexture(64, [
            [0.0, 'rgba(255, 255, 255, 1.0)'],
            [0.2, 'rgba(200, 220, 255, 0.9)'],
            [0.5, 'rgba(140, 180, 255, 0.5)'],
            [0.8, 'rgba(100, 150, 255, 0.2)'],
            [1.0, 'rgba(80, 120, 255, 0.0)']
        ]);

        // ROCKET exhaust: white -> yellow -> orange -> transparent
        _texRocketExhaust = _createGradientTexture(64, [
            [0.0, 'rgba(255, 255, 255, 1.0)'],
            [0.15, 'rgba(255, 240, 180, 0.95)'],
            [0.4, 'rgba(255, 200, 80, 0.7)'],
            [0.7, 'rgba(255, 140, 40, 0.3)'],
            [1.0, 'rgba(255, 80, 10, 0.0)']
        ]);

        // HYPERSONIC exhaust: white -> blue-white with slight purple
        _texHypersonicExhaust = _createGradientTexture(64, [
            [0.0, 'rgba(255, 255, 255, 1.0)'],
            [0.2, 'rgba(220, 210, 255, 0.9)'],
            [0.5, 'rgba(160, 150, 255, 0.5)'],
            [0.8, 'rgba(130, 110, 220, 0.2)'],
            [1.0, 'rgba(100, 80, 200, 0.0)']
        ]);

        // ION exhaust: faint blue glow
        _texIonExhaust = _createGradientTexture(32, [
            [0.0, 'rgba(150, 200, 255, 0.8)'],
            [0.3, 'rgba(120, 180, 255, 0.4)'],
            [0.7, 'rgba(80, 140, 255, 0.15)'],
            [1.0, 'rgba(60, 120, 255, 0.0)']
        ]);

        // Reentry glow: orange-red
        _texReentry = _createGradientTexture(64, [
            [0.0, 'rgba(255, 200, 100, 1.0)'],
            [0.25, 'rgba(255, 150, 50, 0.8)'],
            [0.5, 'rgba(255, 80, 20, 0.5)'],
            [0.8, 'rgba(200, 40, 10, 0.2)'],
            [1.0, 'rgba(150, 20, 5, 0.0)']
        ]);

        // Explosion flash: bright white center -> orange
        _texExplosionFlash = _createGradientTexture(64, [
            [0.0, 'rgba(255, 255, 255, 1.0)'],
            [0.2, 'rgba(255, 255, 200, 0.9)'],
            [0.5, 'rgba(255, 200, 80, 0.6)'],
            [0.8, 'rgba(255, 140, 40, 0.2)'],
            [1.0, 'rgba(255, 80, 10, 0.0)']
        ]);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Return a random float in [min, max).
     */
    function _randRange(min, max) {
        return min + Math.random() * (max - min);
    }

    /**
     * Return a random unit vector as Cesium.Cartesian3.
     */
    function _randomDirection() {
        var theta = Math.random() * Math.PI * 2;
        var phi = Math.acos(2 * Math.random() - 1);
        var sp = Math.sin(phi);
        return new Cesium.Cartesian3(
            sp * Math.cos(theta),
            sp * Math.sin(theta),
            Math.cos(phi)
        );
    }

    /**
     * Linearly interpolate between two Cartesian3 positions.
     */
    function _lerpPosition(a, b, t) {
        return new Cesium.Cartesian3(
            a.x + (b.x - a.x) * t,
            a.y + (b.y - a.y) * t,
            a.z + (b.z - a.z) * t
        );
    }

    /**
     * Clamp value to [min, max].
     */
    function _clamp(v, min, max) {
        return v < min ? min : (v > max ? max : v);
    }

    /**
     * Get texture for a propulsion mode.
     */
    function _getExhaustTexture(mode) {
        switch (mode) {
            case 'ROCKET':     return _texRocketExhaust;
            case 'HYPERSONIC': return _texHypersonicExhaust;
            case 'ION':        return _texIonExhaust;
            case 'RCS':        return _texIonExhaust; // similar faint glow
            case 'AIR':
            default:           return _texAirExhaust;
        }
    }

    /**
     * Get billboard pixel size range for a propulsion mode.
     * Returns [minPx, maxPx] -- actual size lerps with throttle.
     */
    function _getExhaustSizeRange(mode) {
        switch (mode) {
            case 'ROCKET':     return [20, 80];
            case 'HYPERSONIC': return [10, 40];
            case 'ION':        return [5, 15];
            case 'RCS':        return [5, 12];
            case 'AIR':
            default:           return [10, 40];
        }
    }

    // -----------------------------------------------------------------------
    // init
    // -----------------------------------------------------------------------

    /**
     * Initialize the effects system. Must be called once with the Cesium viewer.
     * @param {Cesium.Viewer} viewer
     */
    function init(viewer) {
        _viewer = viewer;
        _initTextures();

        // Single BillboardCollection for all billboard-based effects
        _billboardCollection = viewer.scene.primitives.add(
            new Cesium.BillboardCollection({ scene: viewer.scene })
        );

        // Clear state
        _explosions = [];
        _trails = [];
        _exhaustMap = {};
        _reentryMap = {};
        _sonicBooms = [];
        _prevMach = {};
    }

    // -----------------------------------------------------------------------
    // spawnExplosion
    // -----------------------------------------------------------------------

    /**
     * Spawn an explosion effect at a world position.
     * @param {Cesium.Cartesian3} position - World position of the explosion
     * @param {string} size - 'small', 'medium', or 'large'
     * @param {string} [color] - 'conventional' (default) or 'nuclear'
     */
    function spawnExplosion(position, size, color) {
        if (!_viewer) return;

        // Enforce max concurrent explosions
        while (_explosions.length >= MAX_EXPLOSIONS) {
            _removeExplosion(_explosions[0]);
            _explosions.shift();
        }

        var maxRadius = SIZE_TABLE[size] || SIZE_TABLE.medium;
        var isNuclear = (color === 'nuclear');

        // Sphere color
        var sphereColor = isNuclear
            ? Cesium.Color.fromCssColorString('#c0d8ff')   // white-blue
            : Cesium.Color.fromCssColorString('#ff8c00');   // orange-yellow

        // Create expanding translucent sphere (EllipsoidGraphics)
        var explosionData = {
            elapsed: 0,
            duration: EXPLOSION_TOTAL_DURATION,
            maxRadius: maxRadius,
            isNuclear: isNuclear,
            position: Cesium.Cartesian3.clone(position),
            currentRadius: 0.1,
            currentAlpha: 0.8,
            sphere: null,
            flash: null,
            debris: [],
            entities: []
        };

        // Expanding sphere entity
        var sphereEntity = _viewer.entities.add({
            position: position,
            ellipsoid: {
                radii: new Cesium.CallbackProperty(function() {
                    var r = explosionData.currentRadius;
                    return new Cesium.Cartesian3(r, r, r);
                }, false),
                material: new Cesium.ColorMaterialProperty(
                    new Cesium.CallbackProperty(function() {
                        return sphereColor.withAlpha(explosionData.currentAlpha);
                    }, false)
                ),
                slicePartitions: 16,
                stackPartitions: 16
            }
        });
        explosionData.sphere = sphereEntity;
        explosionData.entities.push(sphereEntity);

        // Center flash billboard
        var flashBillboard = _billboardCollection.add({
            position: position,
            image: _texExplosionFlash,
            width: maxRadius * 0.4,
            height: maxRadius * 0.4,
            color: Cesium.Color.WHITE,
            scale: 1.0,
            sizeInMeters: true,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
        explosionData.flash = flashBillboard;

        // Debris particles
        var debrisCount = DEBRIS_COUNT_MIN +
            Math.floor(Math.random() * (DEBRIS_COUNT_MAX - DEBRIS_COUNT_MIN + 1));

        for (var i = 0; i < debrisCount; i++) {
            var dir = _randomDirection();
            var speed = _randRange(DEBRIS_SPEED_MIN, DEBRIS_SPEED_MAX);
            var lifetime = _randRange(DEBRIS_FADE_MIN, DEBRIS_FADE_MAX);

            // End position: start + dir * speed * lifetime
            var endPos = new Cesium.Cartesian3(
                position.x + dir.x * speed * lifetime,
                position.y + dir.y * speed * lifetime,
                position.z + dir.z * speed * lifetime
            );

            // Use SampledPositionProperty with 2 keyframes for smooth interpolation
            var startTime = _viewer.clock.currentTime;
            var endTime = Cesium.JulianDate.addSeconds(startTime, lifetime, new Cesium.JulianDate());

            var sampledPos = new Cesium.SampledPositionProperty();
            sampledPos.addSample(startTime, Cesium.Cartesian3.clone(position));
            sampledPos.addSample(endTime, endPos);

            var debrisEntity = _viewer.entities.add({
                position: sampledPos,
                point: {
                    pixelSize: isNuclear ? 4 : 3,
                    color: isNuclear
                        ? Cesium.Color.fromCssColorString('#aaccff')
                        : Cesium.Color.fromCssColorString('#ffaa33'),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                }
            });

            explosionData.debris.push({
                entity: debrisEntity,
                lifetime: lifetime,
                elapsed: 0
            });
            explosionData.entities.push(debrisEntity);
        }

        _explosions.push(explosionData);
    }

    /**
     * Remove all Cesium entities/billboards associated with an explosion.
     */
    function _removeExplosion(exp) {
        // Remove sphere and debris entities
        for (var i = 0; i < exp.entities.length; i++) {
            _viewer.entities.remove(exp.entities[i]);
        }
        // Remove flash billboard
        if (exp.flash) {
            _billboardCollection.remove(exp.flash);
        }
    }

    /**
     * Advance explosion timers and update visuals.
     */
    function _updateExplosions(dt) {
        var i = _explosions.length;
        while (i--) {
            var exp = _explosions[i];
            exp.elapsed += dt;

            if (exp.elapsed >= exp.duration) {
                _removeExplosion(exp);
                _explosions.splice(i, 1);
                continue;
            }

            // Sphere expansion: 0 -> maxRadius over EXPLOSION_EXPAND_DURATION
            var expandT = _clamp(exp.elapsed / EXPLOSION_EXPAND_DURATION, 0, 1);
            // Ease-out for natural deceleration
            var easedExpand = 1 - (1 - expandT) * (1 - expandT);
            exp.currentRadius = Math.max(0.1, easedExpand * exp.maxRadius);

            // Sphere fade: full opacity during expand, then fade over EXPLOSION_FADE_DURATION
            if (exp.elapsed <= EXPLOSION_EXPAND_DURATION) {
                exp.currentAlpha = 0.8;
            } else {
                var fadeT = (exp.elapsed - EXPLOSION_EXPAND_DURATION) / EXPLOSION_FADE_DURATION;
                exp.currentAlpha = Math.max(0, 0.8 * (1 - fadeT));
            }

            // Flash: white -> orange over FLASH_DURATION, then disappear
            if (exp.flash) {
                if (exp.elapsed < FLASH_DURATION) {
                    var flashT = exp.elapsed / FLASH_DURATION;
                    // Interpolate white -> orange
                    var r = 1.0;
                    var g = 1.0 - flashT * 0.35;  // 1.0 -> 0.65
                    var b = 1.0 - flashT * 0.8;   // 1.0 -> 0.2
                    var a = 1.0 - flashT * 0.3;    // 1.0 -> 0.7
                    exp.flash.color = new Cesium.Color(r, g, b, a);
                    exp.flash.scale = 1.0 + flashT * 0.5;
                } else {
                    // Hide flash after FLASH_DURATION
                    exp.flash.color = Cesium.Color.TRANSPARENT;
                }
            }

            // Debris: fade individual particles based on their own lifetime
            for (var d = 0; d < exp.debris.length; d++) {
                var debris = exp.debris[d];
                debris.elapsed += dt;
                var debrisT = _clamp(debris.elapsed / debris.lifetime, 0, 1);
                // Fade point alpha
                var debrisAlpha = Math.max(0, 1 - debrisT);
                if (debris.entity.point) {
                    var baseColor = exp.isNuclear
                        ? Cesium.Color.fromCssColorString('#aaccff')
                        : Cesium.Color.fromCssColorString('#ffaa33');
                    debris.entity.point.color = baseColor.withAlpha(debrisAlpha);
                }
                // Shrink size toward end
                if (debris.entity.point && debrisT > 0.7) {
                    var shrink = 1 - (debrisT - 0.7) / 0.3;
                    var baseSize = exp.isNuclear ? 4 : 3;
                    debris.entity.point.pixelSize = Math.max(1, baseSize * shrink);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // spawnMissileTrail
    // -----------------------------------------------------------------------

    /**
     * Spawn an animated missile trail from start to end position.
     * @param {Cesium.Cartesian3} startPos
     * @param {Cesium.Cartesian3} endPos
     * @param {number} duration - Flight time in seconds
     * @param {string} [color] - 'cyan' (default/blue team) or 'orange' (red team)
     */
    function spawnMissileTrail(startPos, endPos, duration, color) {
        if (!_viewer) return;

        // Enforce max concurrent trails
        while (_trails.length >= MAX_TRAILS) {
            _removeTrail(_trails[0]);
            _trails.shift();
        }

        duration = duration || 3.0;
        var isOrange = (color === 'orange');
        var trailColor = isOrange
            ? Cesium.Color.fromCssColorString('#ff8800')
            : Cesium.Color.fromCssColorString('#00ddff');

        var trailData = {
            elapsed: 0,
            duration: duration,
            persistTime: TRAIL_PERSIST_DURATION,
            arrived: false,
            startPos: Cesium.Cartesian3.clone(startPos),
            endPos: Cesium.Cartesian3.clone(endPos),
            currentTip: Cesium.Cartesian3.clone(startPos),
            entity: null
        };

        // Create polyline entity with CallbackProperty for growing trail
        var polyEntity = _viewer.entities.add({
            polyline: {
                positions: new Cesium.CallbackProperty(function() {
                    return [trailData.startPos, trailData.currentTip];
                }, false),
                width: 2,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.25,
                    color: trailColor
                })
            }
        });

        trailData.entity = polyEntity;
        _trails.push(trailData);
    }

    /**
     * Remove a trail's Cesium entity.
     */
    function _removeTrail(trail) {
        if (trail.entity) {
            _viewer.entities.remove(trail.entity);
            trail.entity = null;
        }
    }

    /**
     * Advance trail animations.
     */
    function _updateTrails(dt) {
        var i = _trails.length;
        while (i--) {
            var trail = _trails[i];
            trail.elapsed += dt;

            if (!trail.arrived) {
                // Growing phase: interpolate tip toward endPos
                var t = _clamp(trail.elapsed / trail.duration, 0, 1);
                trail.currentTip = _lerpPosition(trail.startPos, trail.endPos, t);

                if (t >= 1.0) {
                    trail.arrived = true;
                    trail.elapsed = 0; // reset for persist countdown
                }
            } else {
                // Persist phase: wait, then remove
                if (trail.elapsed >= trail.persistTime) {
                    _removeTrail(trail);
                    _trails.splice(i, 1);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // setEngineExhaust
    // -----------------------------------------------------------------------

    /**
     * Create or update engine exhaust effect for an entity.
     * @param {string} entityId
     * @param {Cesium.Cartesian3} position - Entity position (ECEF)
     * @param {Cesium.Cartesian3} direction - Velocity unit vector (or forward direction)
     * @param {number} throttle - 0 to 1
     * @param {string} mode - 'AIR', 'ROCKET', 'HYPERSONIC', 'ION', 'RCS'
     */
    function setEngineExhaust(entityId, position, direction, throttle, mode) {
        if (!_viewer || !_billboardCollection) return;

        mode = mode || 'AIR';
        throttle = _clamp(throttle, 0, 1);

        // Compute offset position: ~20m behind entity along velocity vector
        var offsetDist = -20;
        if (direction && Cesium.Cartesian3.magnitudeSquared(direction) > 0.001) {
            var normDir = Cesium.Cartesian3.normalize(direction, _scratchOffset);
            Cesium.Cartesian3.multiplyByScalar(normDir, offsetDist, _scratchOffset);
            Cesium.Cartesian3.add(position, _scratchOffset, _scratchCartesian);
        } else {
            Cesium.Cartesian3.clone(position, _scratchCartesian);
        }

        var entry = _exhaustMap[entityId];

        if (!entry) {
            // Create new billboard for this entity
            var bb = _billboardCollection.add({
                position: Cesium.Cartesian3.clone(_scratchCartesian),
                image: _getExhaustTexture(mode),
                width: 20,
                height: 20,
                color: Cesium.Color.WHITE.withAlpha(throttle),
                sizeInMeters: true,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });

            entry = { billboard: bb, mode: mode };
            _exhaustMap[entityId] = entry;
        }

        var bb = entry.billboard;

        // Update position
        bb.position = Cesium.Cartesian3.clone(_scratchCartesian);

        // Switch texture if mode changed
        if (entry.mode !== mode) {
            bb.image = _getExhaustTexture(mode);
            entry.mode = mode;
        }

        // Scale size with throttle
        var sizeRange = _getExhaustSizeRange(mode);
        var px = sizeRange[0] + throttle * (sizeRange[1] - sizeRange[0]);
        bb.width = px;
        bb.height = px;

        // Opacity tracks throttle
        bb.color = Cesium.Color.WHITE.withAlpha(throttle);
    }

    /**
     * Update all active exhaust effects from entity state array.
     */
    function _updateExhaust(entities) {
        // Mark which IDs are still active
        var activeIds = {};

        for (var i = 0; i < entities.length; i++) {
            var ent = entities[i];
            if (!ent.engineOn || ent.throttle <= 0) {
                // Engine off: hide exhaust if it exists
                var entry = _exhaustMap[ent.id];
                if (entry) {
                    entry.billboard.color = Cesium.Color.TRANSPARENT;
                }
                activeIds[ent.id] = true;
                continue;
            }

            // Build velocity direction vector from entity state
            var dir = ent.velocity || null;
            var throttle = ent.throttle || 0;
            var mode = ent.propulsionMode || 'AIR';

            setEngineExhaust(ent.id, ent.position, dir, throttle, mode);
            activeIds[ent.id] = true;
        }

        // Remove exhaust for entities that no longer exist
        var toRemove = [];
        for (var id in _exhaustMap) {
            if (!activeIds[id]) {
                toRemove.push(id);
            }
        }
        for (var r = 0; r < toRemove.length; r++) {
            var removeId = toRemove[r];
            _billboardCollection.remove(_exhaustMap[removeId].billboard);
            delete _exhaustMap[removeId];
        }
    }

    // -----------------------------------------------------------------------
    // setReentryGlow
    // -----------------------------------------------------------------------

    /**
     * Create or update reentry glow effect for an entity.
     * @param {string} entityId
     * @param {Cesium.Cartesian3} position
     * @param {number} intensity - 0 to 1
     */
    function setReentryGlow(entityId, position, intensity) {
        if (!_viewer || !_billboardCollection) return;

        intensity = _clamp(intensity, 0, 1);

        var entry = _reentryMap[entityId];

        if (!entry) {
            // Create reentry glow billboard
            var bb = _billboardCollection.add({
                position: Cesium.Cartesian3.clone(position),
                image: _texReentry,
                width: 50,
                height: 50,
                color: Cesium.Color.WHITE.withAlpha(0),
                sizeInMeters: true,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
            entry = { billboard: bb };
            _reentryMap[entityId] = entry;
        }

        var bb = entry.billboard;
        bb.position = Cesium.Cartesian3.clone(position);

        if (intensity < 0.01) {
            bb.color = Cesium.Color.TRANSPARENT;
        } else {
            var px = 50 + intensity * 100;
            bb.width = px;
            bb.height = px;
            bb.color = Cesium.Color.WHITE.withAlpha(intensity * 0.7);
        }
    }

    /**
     * Evaluate reentry conditions and update glow for all entities.
     */
    function _updateReentry(entities) {
        var activeIds = {};

        for (var i = 0; i < entities.length; i++) {
            var ent = entities[i];
            var alt = ent.alt || 0;
            var speed = ent.speed || 0;
            var aeroBlend = ent.aeroBlend;
            var dynamicPressure = ent.dynamicPressure || 0;

            // Reentry condition: high altitude, high speed, some aero interaction
            if (alt > 40000 && speed > 2000 && aeroBlend > 0.01) {
                var intensity = _clamp(dynamicPressure / 50000, 0, 1);
                setReentryGlow(ent.id, ent.position, intensity);
            } else {
                // Turn off if exists
                var entry = _reentryMap[ent.id];
                if (entry) {
                    entry.billboard.color = Cesium.Color.TRANSPARENT;
                }
            }
            activeIds[ent.id] = true;
        }

        // Cleanup orphans
        var toRemove = [];
        for (var id in _reentryMap) {
            if (!activeIds[id]) {
                toRemove.push(id);
            }
        }
        for (var r = 0; r < toRemove.length; r++) {
            var removeId = toRemove[r];
            _billboardCollection.remove(_reentryMap[removeId].billboard);
            delete _reentryMap[removeId];
        }
    }

    // -----------------------------------------------------------------------
    // Sonic boom ring
    // -----------------------------------------------------------------------

    /**
     * Spawn a sonic boom ring when an entity crosses Mach 1.
     */
    function _spawnSonicBoom(position) {
        if (!_viewer) return;

        var boomData = {
            elapsed: 0,
            duration: SONIC_BOOM_DURATION,
            position: Cesium.Cartesian3.clone(position),
            currentRadius: 0.1,
            currentAlpha: 0.3,
            entity: null
        };

        var ringEntity = _viewer.entities.add({
            position: position,
            ellipse: {
                semiMajorAxis: new Cesium.CallbackProperty(function() {
                    return boomData.currentRadius;
                }, false),
                semiMinorAxis: new Cesium.CallbackProperty(function() {
                    return boomData.currentRadius;
                }, false),
                material: new Cesium.ColorMaterialProperty(
                    new Cesium.CallbackProperty(function() {
                        return Cesium.Color.fromCssColorString('#d0e8ff').withAlpha(boomData.currentAlpha);
                    }, false)
                ),
                outline: true,
                outlineColor: new Cesium.CallbackProperty(function() {
                    return Cesium.Color.WHITE.withAlpha(boomData.currentAlpha * 1.5);
                }, false),
                outlineWidth: 1,
                height: 0, // ground-clamped; will appear at entity altitude via position
                granularity: Cesium.Math.toRadians(5)
            }
        });

        boomData.entity = ringEntity;
        _sonicBooms.push(boomData);
    }

    /**
     * Detect Mach transitions and spawn sonic boom rings.
     */
    function _checkSonicBooms(entities) {
        for (var i = 0; i < entities.length; i++) {
            var ent = entities[i];
            var mach = ent.mach || 0;
            var prevMach = _prevMach[ent.id] || 0;

            // Crossing Mach 1 upward (subsonic -> supersonic)
            if (prevMach < 1.0 && mach >= 1.0 && ent.alt < 30000) {
                _spawnSonicBoom(ent.position);
            }

            _prevMach[ent.id] = mach;
        }
    }

    /**
     * Update active sonic boom rings.
     */
    function _updateSonicBooms(dt) {
        var i = _sonicBooms.length;
        while (i--) {
            var boom = _sonicBooms[i];
            boom.elapsed += dt;

            if (boom.elapsed >= boom.duration) {
                _viewer.entities.remove(boom.entity);
                _sonicBooms.splice(i, 1);
                continue;
            }

            var t = boom.elapsed / boom.duration;
            // Ease-out expansion
            var easedT = 1 - (1 - t) * (1 - t);
            boom.currentRadius = Math.max(0.1, easedT * SONIC_BOOM_MAX_RADIUS);
            boom.currentAlpha = Math.max(0, 0.3 * (1 - t));
        }
    }

    // -----------------------------------------------------------------------
    // update (main frame tick)
    // -----------------------------------------------------------------------

    /**
     * Update all visual effects. Call once per frame.
     * @param {number} dt - Delta time in seconds
     * @param {Array} entities - Array of entity state objects:
     *   {id, position, velocity, throttle, engineOn, speed, alt, mach,
     *    dynamicPressure, aeroBlend, propulsionMode}
     */
    function update(dt, entities) {
        if (!_viewer) return;

        // Cap dt to prevent jumps during tab-away or time warp
        dt = Math.min(dt, 0.1);

        // Timed effects
        _updateExplosions(dt);
        _updateTrails(dt);
        _updateSonicBooms(dt);

        // Per-entity persistent effects
        if (entities && entities.length > 0) {
            _updateExhaust(entities);
            _updateReentry(entities);
            _checkSonicBooms(entities);
        }
    }

    // -----------------------------------------------------------------------
    // cleanup
    // -----------------------------------------------------------------------

    /**
     * Remove all active effects and release resources.
     */
    function cleanup() {
        if (!_viewer) return;

        // Remove all explosions
        for (var i = 0; i < _explosions.length; i++) {
            _removeExplosion(_explosions[i]);
        }
        _explosions = [];

        // Remove all trails
        for (var i = 0; i < _trails.length; i++) {
            _removeTrail(_trails[i]);
        }
        _trails = [];

        // Remove all sonic booms
        for (var i = 0; i < _sonicBooms.length; i++) {
            if (_sonicBooms[i].entity) {
                _viewer.entities.remove(_sonicBooms[i].entity);
            }
        }
        _sonicBooms = [];

        // Remove exhaust billboards
        for (var id in _exhaustMap) {
            _billboardCollection.remove(_exhaustMap[id].billboard);
        }
        _exhaustMap = {};

        // Remove reentry billboards
        for (var id in _reentryMap) {
            _billboardCollection.remove(_reentryMap[id].billboard);
        }
        _reentryMap = {};

        // Remove the billboard collection primitive
        if (_billboardCollection) {
            _viewer.scene.primitives.remove(_billboardCollection);
            _billboardCollection = null;
        }

        _prevMach = {};
        _viewer = null;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    return {
        init: init,
        update: update,
        spawnExplosion: spawnExplosion,
        spawnMissileTrail: spawnMissileTrail,
        setEngineExhaust: setEngineExhaust,
        setReentryGlow: setReentryGlow,
        cleanup: cleanup
    };

})();
