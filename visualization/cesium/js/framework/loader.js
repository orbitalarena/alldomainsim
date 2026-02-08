/**
 * ScenarioLoader — parse a scenario JSON file and build a World
 * with entities, components (from ComponentRegistry), systems, and environment.
 */
const ScenarioLoader = (function() {
    'use strict';

    const DEG = FrameworkConstants.DEG;

    /**
     * Load a scenario JSON file and return a fully-initialised World.
     * @param {string} url           path to scenario JSON
     * @param {Cesium.Viewer} viewer  Cesium viewer instance
     * @returns {Promise<ECS.World>}
     */
    async function load(url, viewer) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to load scenario: ' + url + ' (' + response.status + ')');
        const json = await response.json();
        return build(json, viewer);
    }

    /**
     * Build a World from a parsed scenario object.
     * @param {object} scenario   parsed JSON
     * @param {Cesium.Viewer} viewer
     * @returns {ECS.World}
     */
    function build(scenario, viewer) {
        const world = new ECS.World();
        world.viewer = viewer;
        world.headless = !viewer;
        world.scenarioMeta = scenario.metadata || {};

        // Environment
        world.environment = scenario.environment || {};
        if (world.environment.maxTimeWarp) {
            world._maxTimeWarp = world.environment.maxTimeWarp;
        }

        // Camera config
        world.camera = scenario.camera || {};

        // Events (stored for future EventSystem)
        world.events = scenario.events || [];

        // Create entities
        const entities = scenario.entities || [];
        for (let i = 0; i < entities.length; i++) {
            const def = entities[i];
            const entity = _buildEntity(def);
            world.addEntity(entity);

            // Track player entity for UI system
            const ctrl = def.components && def.components.control;
            if (ctrl && ctrl.type === 'player_input') {
                world._playerEntity = entity;
            }
        }

        // Register systems (headless mode omits visual/HUD/UI)
        if (world.headless) {
            Systems.registerHeadless(world);
        } else {
            Systems.registerDefaults(world);
        }

        // Init all components
        world.initAll();

        // Setup initial camera (skip in headless mode)
        if (!world.headless) {
            _setupCamera(world);
        }

        return world;
    }

    /**
     * Build an Entity from a scenario entity definition.
     */
    function _buildEntity(def) {
        // Build initial state from JSON (lat/lon in degrees -> radians)
        const init = def.initialState || {};
        const state = {
            lat: (init.lat != null ? init.lat : 0) * DEG,
            lon: (init.lon != null ? init.lon : 0) * DEG,
            alt: init.alt != null ? init.alt : 0,
            speed: init.speed != null ? init.speed : 0,
            heading: (init.heading != null ? init.heading : 0) * DEG,
            gamma: (init.gamma != null ? init.gamma : 0) * DEG,
            pitch: 0,
            roll: 0,
            yaw: 0,
            throttle: init.throttle !== undefined ? init.throttle : 0.6,
            alpha: 2 * DEG,
            mach: 0,
            g_load: 1.0,
            phase: init.phase || (init.speed > 0 ? 'FLIGHT' : 'PARKED'),
            engineOn: init.engineOn !== undefined ? init.engineOn : true,
            gearDown: init.gearDown !== undefined ? init.gearDown : false,
            gearTransition: 0,
            flapsDown: init.flapsDown !== undefined ? init.flapsDown : false,
            brakesOn: init.brakesOn !== undefined ? init.brakesOn : false,
            maxG_experienced: 1.0,
            yawOffset: 0,
            fuel: init.fuel !== undefined ? init.fuel : Infinity,
            infiniteFuel: init.infiniteFuel !== undefined ? init.infiniteFuel : true,
            _commands: {}               // filled by control system
        };

        // Merge any extra state properties from JSON
        if (init.extra) {
            Object.assign(state, init.extra);
        }

        const entity = new ECS.Entity({
            id: def.id,
            name: def.name || def.id,
            type: def.type || 'generic',
            team: def.team || 'neutral',
            state: state
        });

        // Preserve original definition for runtime access (propulsion modes, _custom, etc.)
        entity.def = def;

        // Attach components from JSON
        const comps = def.components || {};
        for (const category in comps) {
            const spec = comps[category];
            if (!spec || spec === null) continue;

            // Sensors/weapons can be arrays — for Phase 1 we just take the first
            if (Array.isArray(spec)) {
                // Arrays are for future multi-component support; skip for now
                continue;
            }

            const typeName = spec.type;
            if (!typeName) continue;

            if (!ComponentRegistry.has(category, typeName)) {
                console.warn('Unknown component: ' + category + '/' + typeName +
                             ' on entity ' + def.id + ' — skipping');
                continue;
            }

            const component = ComponentRegistry.create(category, typeName, spec);
            entity.addComponent(category, component);
        }

        return entity;
    }

    /**
     * Setup Cesium camera from scenario camera config.
     */
    function _setupCamera(world) {
        const cam = world.camera;
        if (!cam || !cam.target) return;

        const target = world.getEntity(cam.target);
        if (!target) return;

        const s = target.state;
        const pos = Cesium.Cartesian3.fromRadians(s.lon, s.lat, s.alt);
        const range = cam.range || 200;

        world.viewer.camera.lookAt(
            pos,
            new Cesium.HeadingPitchRange(s.heading, cam.pitch || -0.3, range)
        );
    }

    /**
     * Build a single entity from a definition (exposed for builder use).
     */
    function buildEntity(def) {
        return _buildEntity(def);
    }

    return { load: load, build: build, buildEntity: buildEntity };
})();
