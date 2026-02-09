/**
 * ModelMap — Maps entity types/configs to 3D .glb model files.
 *
 * Provides automatic model assignment for entities based on their physics config,
 * entity type, or explicit model override. Used by CesiumEntity visual component
 * and the live sim engine to render 3D models instead of point markers.
 *
 * Available models in /models/:
 *   f15.glb            — F-15 fighter jet
 *   shuttle.glb        — Space Shuttle
 *   Hubble.glb         — Hubble Space Telescope
 *   webb.glb           — James Webb Space Telescope
 *   satellite_simple.glb — Generic satellite body
 *   airplane.glb       — Generic airplane
 */
const ModelMap = (function() {
    'use strict';

    var MODEL_PATH = 'models/';

    // Aircraft config → model file
    var AIRCRAFT_MODELS = {
        'f16':       'f15.glb',       // F-15 model for F-16 (closest available)
        'f15':       'f15.glb',
        'f22':       'f15.glb',       // Stealth fighter → use F-15 silhouette
        'f35':       'f15.glb',
        'mig29':     'f15.glb',
        'su27':      'f15.glb',
        'su57':      'f15.glb',
        'bomber':    'airplane.glb',
        'b1':        'airplane.glb',
        'awacs':     'airplane.glb',
        'transport': 'airplane.glb',
        'drone_male':'airplane.glb',
        'drone_hale':'airplane.glb',
        'spaceplane':'shuttle.glb'
    };

    // Entity type → model file (fallback when no aircraft config)
    var TYPE_MODELS = {
        'aircraft':   'f15.glb',
        'fighter':    'f15.glb',
        'satellite':  'satellite_simple.glb',
        'spacecraft': 'shuttle.glb',
        'shuttle':    'shuttle.glb',
        'telescope':  'webb.glb',
        'hubble':     'Hubble.glb',
        'webb':       'webb.glb'
    };

    // Model orientation offsets (degrees) — some models need rotation to align
    // heading=0 should point north, model might face +X or +Z in its local frame
    var MODEL_ORIENTATION = {
        'f15.glb':             { heading: 0,   pitch: 0, roll: 0, scale: 20 },
        'shuttle.glb':         { heading: 0,   pitch: 0, roll: 0, scale: 15 },
        'Hubble.glb':          { heading: 0,   pitch: 0, roll: 0, scale: 1 },
        'webb.glb':            { heading: 0,   pitch: 0, roll: 0, scale: 1 },
        'satellite_simple.glb':{ heading: 0,   pitch: 0, roll: 0, scale: 5 },
        'airplane.glb':        { heading: 0,   pitch: 0, roll: 0, scale: 30 }
    };

    /**
     * Resolve the best model for an entity definition.
     * @param {Object} entityDef — Entity definition from scenario JSON
     * @returns {Object|null} {uri, scale, headingOffset, pitchOffset, rollOffset} or null
     */
    function resolve(entityDef) {
        if (!entityDef) return null;

        // 1. Explicit model override from _custom or visual component
        var custom = entityDef._custom || {};
        if (custom.model && custom.model.file) {
            var m = custom.model;
            return {
                uri: MODEL_PATH + m.file,
                scale: m.scale || 1.0,
                headingOffset: (m.heading || 0) * Math.PI / 180,
                pitchOffset: (m.pitch || 0) * Math.PI / 180,
                rollOffset: (m.roll || 0) * Math.PI / 180
            };
        }

        var comp = entityDef.components || {};
        var visCfg = comp.visual || {};
        if (visCfg.model) {
            var orient = MODEL_ORIENTATION[visCfg.model] || {};
            return {
                uri: MODEL_PATH + visCfg.model,
                scale: visCfg.modelScale || orient.scale || 1.0,
                headingOffset: (visCfg.modelHeading || orient.heading || 0) * Math.PI / 180,
                pitchOffset: (visCfg.modelPitch || orient.pitch || 0) * Math.PI / 180,
                rollOffset: (visCfg.modelRoll || orient.roll || 0) * Math.PI / 180
            };
        }

        // 2. Match by aircraft config
        var physCfg = comp.physics || {};
        var aircraftConfig = physCfg.config;
        if (aircraftConfig && AIRCRAFT_MODELS[aircraftConfig]) {
            var file = AIRCRAFT_MODELS[aircraftConfig];
            var o = MODEL_ORIENTATION[file] || {};
            return {
                uri: MODEL_PATH + file,
                scale: o.scale || 1.0,
                headingOffset: (o.heading || 0) * Math.PI / 180,
                pitchOffset: (o.pitch || 0) * Math.PI / 180,
                rollOffset: (o.roll || 0) * Math.PI / 180
            };
        }

        // 3. Match by entity type
        var entityType = entityDef.type || '';
        var entityName = (entityDef.name || '').toLowerCase();
        // Check name for specific satellites
        if (entityName.indexOf('hubble') >= 0) {
            var oh = MODEL_ORIENTATION['Hubble.glb'] || {};
            return { uri: MODEL_PATH + 'Hubble.glb', scale: oh.scale || 1, headingOffset: 0, pitchOffset: 0, rollOffset: 0 };
        }
        if (entityName.indexOf('webb') >= 0 || entityName.indexOf('jwst') >= 0) {
            var ow = MODEL_ORIENTATION['webb.glb'] || {};
            return { uri: MODEL_PATH + 'webb.glb', scale: ow.scale || 1, headingOffset: 0, pitchOffset: 0, rollOffset: 0 };
        }

        if (TYPE_MODELS[entityType]) {
            var tf = TYPE_MODELS[entityType];
            var ot = MODEL_ORIENTATION[tf] || {};
            return {
                uri: MODEL_PATH + tf,
                scale: ot.scale || 1.0,
                headingOffset: (ot.heading || 0) * Math.PI / 180,
                pitchOffset: (ot.pitch || 0) * Math.PI / 180,
                rollOffset: (ot.roll || 0) * Math.PI / 180
            };
        }

        // 4. Orbital entities get generic satellite
        if (physCfg.type === 'orbital_2body') {
            var os = MODEL_ORIENTATION['satellite_simple.glb'] || {};
            return {
                uri: MODEL_PATH + 'satellite_simple.glb',
                scale: os.scale || 5,
                headingOffset: 0, pitchOffset: 0, rollOffset: 0
            };
        }

        return null; // No model — will render as point marker
    }

    /**
     * Get list of all available models with metadata.
     */
    function getAvailableModels() {
        return [
            { file: 'f15.glb',             name: 'F-15 Eagle',         category: 'aircraft' },
            { file: 'shuttle.glb',          name: 'Space Shuttle',      category: 'spacecraft' },
            { file: 'Hubble.glb',           name: 'Hubble Telescope',   category: 'satellite' },
            { file: 'webb.glb',             name: 'JWST',               category: 'satellite' },
            { file: 'satellite_simple.glb', name: 'Generic Satellite',  category: 'satellite' },
            { file: 'airplane.glb',         name: 'Transport Aircraft', category: 'aircraft' }
        ];
    }

    return {
        resolve: resolve,
        getAvailableModels: getAvailableModels,
        AIRCRAFT_MODELS: AIRCRAFT_MODELS,
        TYPE_MODELS: TYPE_MODELS,
        MODEL_ORIENTATION: MODEL_ORIENTATION,
        MODEL_PATH: MODEL_PATH
    };
})();
