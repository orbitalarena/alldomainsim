/**
 * ParticleEffects - Cesium particle systems for exhaust, entry heating, and atmosphere
 *
 * Provides factory functions for common visual effects in space simulations:
 *   - Rocket exhaust plumes (throttle-responsive)
 *   - Atmospheric entry heating glow
 *   - Atmospheric scattering shells
 *   - Thruster RCS puffs
 *   - Debris/explosion bursts
 *
 * Depends on: Cesium
 *
 * Usage:
 *   var plume = ParticleEffects.createExhaustPlume(viewer, entity);
 *   ParticleEffects.updateParticlePosition(plume, position, orientation);
 *   ParticleEffects.setEmissionRate(plume, throttle * 200);
 */
var ParticleEffects = (function() {
    'use strict';

    // ─── Create a circular gradient image for particles ────────────────
    // Returns a data URL for use as particle texture
    function createCircleImage(size, colorStops) {
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var gradient = ctx.createRadialGradient(
            size / 2, size / 2, 0,
            size / 2, size / 2, size / 2
        );

        if (colorStops) {
            for (var i = 0; i < colorStops.length; i++) {
                gradient.addColorStop(colorStops[i][0], colorStops[i][1]);
            }
        } else {
            gradient.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
            gradient.addColorStop(0.3, 'rgba(255, 220, 150, 0.8)');
            gradient.addColorStop(0.6, 'rgba(255, 150, 80, 0.4)');
            gradient.addColorStop(1, 'rgba(255, 80, 30, 0.0)');
        }

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        return canvas.toDataURL();
    }

    // ─── Create a soft glow image ──────────────────────────────────────
    function createGlowImage(size, r, g, b) {
        r = r || 255; g = g || 200; b = b || 100;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        var gradient = ctx.createRadialGradient(
            size / 2, size / 2, 0,
            size / 2, size / 2, size / 2
        );
        gradient.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ', 1.0)');
        gradient.addColorStop(0.4, 'rgba(' + r + ',' + g + ',' + b + ', 0.3)');
        gradient.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ', 0.0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        return canvas.toDataURL();
    }

    // Cached default images (created once on first use)
    var _exhaustImage = null;
    var _entryImage = null;
    var _rcsImage = null;

    function getExhaustImage() {
        if (!_exhaustImage) {
            _exhaustImage = createCircleImage(32, [
                [0, 'rgba(255, 255, 255, 1.0)'],
                [0.2, 'rgba(255, 230, 180, 0.9)'],
                [0.5, 'rgba(255, 160, 60, 0.5)'],
                [0.8, 'rgba(255, 80, 20, 0.2)'],
                [1, 'rgba(200, 40, 0, 0.0)']
            ]);
        }
        return _exhaustImage;
    }

    function getEntryImage() {
        if (!_entryImage) {
            _entryImage = createCircleImage(32, [
                [0, 'rgba(255, 240, 200, 1.0)'],
                [0.3, 'rgba(255, 120, 20, 0.7)'],
                [0.6, 'rgba(255, 50, 10, 0.3)'],
                [1, 'rgba(200, 20, 0, 0.0)']
            ]);
        }
        return _entryImage;
    }

    function getRCSImage() {
        if (!_rcsImage) {
            _rcsImage = createCircleImage(16, [
                [0, 'rgba(200, 220, 255, 1.0)'],
                [0.4, 'rgba(180, 200, 255, 0.4)'],
                [1, 'rgba(150, 180, 255, 0.0)']
            ]);
        }
        return _rcsImage;
    }

    // ─── Rocket Exhaust Plume ──────────────────────────────────────────
    // Creates a particle system resembling a rocket engine exhaust
    function createExhaustPlume(viewer, entity, options) {
        options = options || {};

        var startColor = options.startColor ||
            Cesium.Color.fromCssColorString('#FFB74D').withAlpha(0.8);
        var endColor = options.endColor ||
            Cesium.Color.fromCssColorString('#FF5722').withAlpha(0.0);

        var particleSystem = viewer.scene.primitives.add(new Cesium.ParticleSystem({
            image: options.image || getExhaustImage(),
            startColor: startColor,
            endColor: endColor,
            startScale: options.startScale || 2.0,
            endScale: options.endScale || 6.0,
            minimumParticleLife: options.minLife || 0.3,
            maximumParticleLife: options.maxLife || 1.0,
            minimumSpeed: options.minSpeed || 50.0,
            maximumSpeed: options.maxSpeed || 150.0,
            emissionRate: options.emissionRate || 200,
            emitter: new Cesium.BoxEmitter(
                new Cesium.Cartesian3(
                    options.emitterSize || 2,
                    options.emitterSize || 2,
                    options.emitterSize || 2
                )
            ),
            modelMatrix: Cesium.Matrix4.IDENTITY,
            lifetime: 16.0,
            loop: true,
            sizeInMeters: options.sizeInMeters !== false
        }));

        particleSystem._entityRef = entity;
        particleSystem._effectType = 'exhaust';
        return particleSystem;
    }

    // ─── Atmospheric Entry Heating Glow ────────────────────────────────
    // Dense, hot particle cloud around a re-entering body
    function createEntryGlow(viewer, entity, options) {
        options = options || {};

        var startColor = options.startColor ||
            Cesium.Color.fromCssColorString('#FF6F00').withAlpha(0.9);
        var endColor = options.endColor ||
            Cesium.Color.fromCssColorString('#F44336').withAlpha(0.0);

        var particleSystem = viewer.scene.primitives.add(new Cesium.ParticleSystem({
            image: options.image || getEntryImage(),
            startColor: startColor,
            endColor: endColor,
            startScale: options.startScale || 3.0,
            endScale: options.endScale || 10.0,
            minimumParticleLife: options.minLife || 0.1,
            maximumParticleLife: options.maxLife || 0.5,
            minimumSpeed: options.minSpeed || 10.0,
            maximumSpeed: options.maxSpeed || 50.0,
            emissionRate: options.emissionRate || 500,
            emitter: new Cesium.SphereEmitter(options.emitterRadius || 5.0),
            modelMatrix: Cesium.Matrix4.IDENTITY,
            lifetime: 16.0,
            loop: true,
            sizeInMeters: options.sizeInMeters !== false
        }));

        particleSystem._entityRef = entity;
        particleSystem._effectType = 'entry';
        return particleSystem;
    }

    // ─── RCS Thruster Puff ─────────────────────────────────────────────
    // Short-lived, small puffs for attitude control jets
    function createRCSPuff(viewer, entity, options) {
        options = options || {};

        var startColor = options.startColor ||
            Cesium.Color.fromCssColorString('#B0C4DE').withAlpha(0.6);
        var endColor = options.endColor ||
            Cesium.Color.fromCssColorString('#87CEEB').withAlpha(0.0);

        var particleSystem = viewer.scene.primitives.add(new Cesium.ParticleSystem({
            image: options.image || getRCSImage(),
            startColor: startColor,
            endColor: endColor,
            startScale: options.startScale || 0.5,
            endScale: options.endScale || 2.0,
            minimumParticleLife: 0.05,
            maximumParticleLife: 0.2,
            minimumSpeed: 5.0,
            maximumSpeed: 20.0,
            emissionRate: options.emissionRate || 100,
            emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(options.coneAngle || 15)),
            modelMatrix: Cesium.Matrix4.IDENTITY,
            lifetime: 16.0,
            loop: true,
            sizeInMeters: options.sizeInMeters !== false
        }));

        particleSystem._entityRef = entity;
        particleSystem._effectType = 'rcs';
        return particleSystem;
    }

    // ─── Explosion / Debris Burst ──────────────────────────────────────
    // One-shot burst of particles (set loop=false, short lifetime)
    function createExplosion(viewer, position, options) {
        options = options || {};

        var startColor = options.startColor ||
            Cesium.Color.fromCssColorString('#FFD700').withAlpha(1.0);
        var endColor = options.endColor ||
            Cesium.Color.fromCssColorString('#FF4500').withAlpha(0.0);

        var modelMatrix = Cesium.Matrix4.fromTranslation(position);

        var particleSystem = viewer.scene.primitives.add(new Cesium.ParticleSystem({
            image: options.image || getExhaustImage(),
            startColor: startColor,
            endColor: endColor,
            startScale: options.startScale || 1.0,
            endScale: options.endScale || 8.0,
            minimumParticleLife: options.minLife || 0.5,
            maximumParticleLife: options.maxLife || 2.0,
            minimumSpeed: options.minSpeed || 20.0,
            maximumSpeed: options.maxSpeed || 200.0,
            emissionRate: options.emissionRate || 1000,
            emitter: new Cesium.SphereEmitter(options.emitterRadius || 10.0),
            modelMatrix: modelMatrix,
            lifetime: options.burstDuration || 0.5,  // Short burst
            loop: false,
            sizeInMeters: options.sizeInMeters !== false
        }));

        particleSystem._effectType = 'explosion';
        return particleSystem;
    }

    // ─── Atmospheric Scattering Shell ──────────────────────────────────
    // Translucent ellipsoid slightly larger than planet surface
    function createAtmosphericScattering(viewer, options) {
        options = options || {};
        var planetRadius = options.radius || 6371000;
        var atmosphereHeight = options.atmosphereHeight || 100000;
        var color = options.color ||
            Cesium.Color.fromCssColorString('#87CEEB').withAlpha(0.15);
        var totalRadius = planetRadius + atmosphereHeight;

        var entity = viewer.entities.add({
            position: options.position || Cesium.Cartesian3.ZERO,
            ellipsoid: {
                radii: new Cesium.Cartesian3(totalRadius, totalRadius, totalRadius),
                material: new Cesium.ColorMaterialProperty(color),
                outline: false,
                slicePartitions: 64,
                stackPartitions: 64
            }
        });

        entity._effectType = 'atmosphere';
        return entity;
    }

    // ─── Planet Glow (billboard-based) ─────────────────────────────────
    // Adds a glowing billboard behind a planet for visibility at distance
    function createPlanetGlow(viewer, position, options) {
        options = options || {};
        var color = options.color || '#4B7BE5';
        var size = options.size || 32;

        var glowImage = createGlowImage(64,
            parseInt(color.substring(1, 3), 16),
            parseInt(color.substring(3, 5), 16),
            parseInt(color.substring(5, 7), 16)
        );

        return viewer.entities.add({
            position: position,
            billboard: {
                image: glowImage,
                width: size,
                height: size,
                color: Cesium.Color.fromCssColorString(color).withAlpha(0.6),
                scale: options.scale || 1.0
            }
        });
    }

    // ─── Update Particle System Position ───────────────────────────────
    // Moves particle system to follow an entity or arbitrary position
    function updateParticlePosition(particleSystem, position, orientation) {
        if (!particleSystem || particleSystem.isDestroyed()) return;

        var modelMatrix = Cesium.Matrix4.fromTranslationQuaternionRotationScale(
            position,
            orientation || Cesium.Quaternion.IDENTITY,
            new Cesium.Cartesian3(1, 1, 1)
        );
        particleSystem.modelMatrix = modelMatrix;
    }

    // ─── Set Emission Rate ─────────────────────────────────────────────
    // Dynamically adjust emission rate (e.g., proportional to throttle)
    function setEmissionRate(particleSystem, rate) {
        if (!particleSystem || particleSystem.isDestroyed()) return;
        particleSystem.emissionRate = Math.max(0, rate);
    }

    // ─── Show/Hide ─────────────────────────────────────────────────────
    function setVisible(particleSystem, visible) {
        if (!particleSystem || particleSystem.isDestroyed()) return;
        particleSystem.show = visible;
    }

    // ─── Destroy and Clean Up ──────────────────────────────────────────
    function destroy(viewer, particleSystem) {
        if (!particleSystem) return;
        if (particleSystem._effectType === 'atmosphere' || particleSystem._effectType === 'glow') {
            viewer.entities.remove(particleSystem);
        } else {
            if (!particleSystem.isDestroyed()) {
                viewer.scene.primitives.remove(particleSystem);
            }
        }
    }

    // ─── Effect Manager ────────────────────────────────────────────────
    // Tracks multiple effects for bulk update/cleanup
    function EffectManager(viewer) {
        this.viewer = viewer;
        this.effects = [];
    }

    EffectManager.prototype.add = function(effect) {
        this.effects.push(effect);
        return effect;
    };

    EffectManager.prototype.updateAll = function(position, orientation) {
        for (var i = 0; i < this.effects.length; i++) {
            var eff = this.effects[i];
            if (eff._effectType !== 'atmosphere' && eff._effectType !== 'glow') {
                updateParticlePosition(eff, position, orientation);
            }
        }
    };

    EffectManager.prototype.destroyAll = function() {
        for (var i = 0; i < this.effects.length; i++) {
            destroy(this.viewer, this.effects[i]);
        }
        this.effects = [];
    };

    EffectManager.prototype.setAllVisible = function(visible) {
        for (var i = 0; i < this.effects.length; i++) {
            setVisible(this.effects[i], visible);
        }
    };

    // ─── Public API ────────────────────────────────────────────────────
    return {
        // Factory functions
        createExhaustPlume: createExhaustPlume,
        createEntryGlow: createEntryGlow,
        createRCSPuff: createRCSPuff,
        createExplosion: createExplosion,
        createAtmosphericScattering: createAtmosphericScattering,
        createPlanetGlow: createPlanetGlow,

        // Image generation
        createCircleImage: createCircleImage,
        createGlowImage: createGlowImage,

        // Runtime control
        updateParticlePosition: updateParticlePosition,
        setEmissionRate: setEmissionRate,
        setVisible: setVisible,
        destroy: destroy,

        // Manager
        EffectManager: EffectManager
    };
})();
