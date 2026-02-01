/**
 * Entity-Component-System core for the scenario framework.
 *
 * Entity  — id, name, type, team, flat mutable state, component map
 * Component — base class with init/update/cleanup lifecycle
 * World — container holding entities, systems, sim clock, Cesium viewer ref
 */
const ECS = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Entity
    // -----------------------------------------------------------------------
    class Entity {
        /**
         * @param {object} opts
         * @param {string} opts.id
         * @param {string} opts.name
         * @param {string} opts.type    e.g. 'aircraft', 'satellite', 'ground'
         * @param {string} opts.team    e.g. 'blue', 'red', 'neutral'
         * @param {object} opts.state   flat mutable object (lat, lon, alt, speed, heading, gamma, ...)
         */
        constructor(opts) {
            this.id = opts.id;
            this.name = opts.name || opts.id;
            this.type = opts.type || 'generic';
            this.team = opts.team || 'neutral';
            this.state = opts.state || {};
            this.components = {};           // name -> Component instance
            this.active = true;
        }

        /** Attach a component under a given name. */
        addComponent(name, component) {
            component.entity = this;
            this.components[name] = component;
        }

        /** Get component by name. */
        getComponent(name) {
            return this.components[name] || null;
        }

        /** Check if entity has all listed component names. */
        hasComponents(/* ...names */) {
            for (let i = 0; i < arguments.length; i++) {
                if (!this.components[arguments[i]]) return false;
            }
            return true;
        }
    }

    // -----------------------------------------------------------------------
    // Component (base class)
    // -----------------------------------------------------------------------
    class Component {
        constructor(config) {
            this.config = config || {};
            this.entity = null;             // set by Entity.addComponent
            this.enabled = true;
        }

        /** Called once after all entities/components are created. */
        init(world) {}

        /** Called every simulation tick. */
        update(dt, world) {}

        /** Called when entity is removed. */
        cleanup(world) {}
    }

    // -----------------------------------------------------------------------
    // World
    // -----------------------------------------------------------------------
    class World {
        constructor() {
            this.entities = new Map();      // id -> Entity
            this.systems = [];              // ordered list of { name, fn(dt, world) }
            this.simTime = 0;               // elapsed sim seconds
            this.wallTime = 0;              // elapsed wall seconds
            this.timeWarp = 1;
            this.isPaused = false;
            this.viewer = null;             // Cesium.Viewer
            this.environment = {};          // atmosphere model name, gravity model, etc.
            this.events = [];               // event definitions (for future EventSystem)
            this.camera = {};               // camera config from scenario JSON
            this._lastTickTime = null;
            this._componentIndex = {};      // componentName -> Set<entityId>
            this.rng = null;                // SimRNG instance (set by loader or MC runner)
            this.headless = false;          // true when running without Cesium viewer
        }

        addEntity(entity) {
            this.entities.set(entity.id, entity);
            // Index components for fast entitiesWith() lookups
            for (var name in entity.components) {
                if (!this._componentIndex[name]) {
                    this._componentIndex[name] = new Set();
                }
                this._componentIndex[name].add(entity.id);
            }
        }

        removeEntity(id) {
            const entity = this.entities.get(id);
            if (entity) {
                // Cleanup components and remove from index
                for (const name in entity.components) {
                    entity.components[name].cleanup(this);
                    if (this._componentIndex[name]) {
                        this._componentIndex[name].delete(id);
                    }
                }
                this.entities.delete(id);
            }
        }

        getEntity(id) {
            return this.entities.get(id) || null;
        }

        /** Return array of entities that have ALL listed component names. */
        entitiesWith(/* ...names */) {
            var names = arguments;
            if (names.length === 0) return [];

            // Find the smallest index set for fast intersection
            var smallest = null;
            var smallestSize = Infinity;
            for (var i = 0; i < names.length; i++) {
                var set = this._componentIndex[names[i]];
                if (!set || set.size === 0) return [];
                if (set.size < smallestSize) {
                    smallest = set;
                    smallestSize = set.size;
                }
            }

            // Iterate smallest set, verify all components present
            var result = [];
            var self = this;
            smallest.forEach(function(id) {
                var entity = self.entities.get(id);
                if (!entity || !entity.active) return;
                for (var j = 0; j < names.length; j++) {
                    if (!entity.components[names[j]]) return;
                }
                result.push(entity);
            });
            return result;
        }

        /** Add a named system function. Systems run in insertion order. */
        addSystem(name, fn) {
            this.systems.push({ name: name, fn: fn });
        }

        /** Initialize all components (call after all entities added). */
        initAll() {
            const self = this;
            this.entities.forEach(function(entity) {
                for (const name in entity.components) {
                    entity.components[name].init(self);
                }
            });
        }

        /**
         * Advance the simulation by one wall-clock tick.
         * Called from the render loop (Cesium onTick or requestAnimationFrame).
         */
        tick() {
            if (this.isPaused) {
                this._lastTickTime = null;
                return;
            }

            const now = Date.now();
            if (this._lastTickTime === null) {
                this._lastTickTime = now;
                return;
            }

            let realDt = (now - this._lastTickTime) / 1000;
            this._lastTickTime = now;
            realDt = Math.min(realDt, 0.1);         // cap wall dt

            const dt = realDt * this.timeWarp;
            this.simTime += dt;
            this.wallTime += realDt;

            // Run systems in order
            for (let i = 0; i < this.systems.length; i++) {
                this.systems[i].fn(dt, this);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Serialization helpers (for builder save/load)
    // -----------------------------------------------------------------------

    /**
     * Serialize an entity to a plain object matching the scenario JSON schema.
     * @param {Entity} entity
     * @returns {object} scenario-compatible entity definition
     */
    function serializeEntity(entity) {
        const RAD = 180 / Math.PI;
        const s = entity.state;
        const def = {
            id: entity.id,
            name: entity.name,
            type: entity.type,
            team: entity.team,
            initialState: {
                lat: (s.lat || 0) * RAD,
                lon: (s.lon || 0) * RAD,
                alt: s.alt || 0,
                speed: s.speed || 0,
                heading: (s.heading || 0) * RAD,
                gamma: (s.gamma || 0) * RAD,
                throttle: s.throttle !== undefined ? s.throttle : 0.6,
                engineOn: s.engineOn !== undefined ? s.engineOn : true,
                gearDown: !!s.gearDown,
                infiniteFuel: s.infiniteFuel !== undefined ? s.infiniteFuel : true
            },
            components: {}
        };

        // Serialize component specs (store the original config used to create them)
        for (const category in entity.components) {
            const comp = entity.components[category];
            if (comp && comp.config) {
                def.components[category] = Object.assign({}, comp.config);
            }
        }

        // Preserve TLE data if present
        if (s.tle_line1) def.initialState.tle_line1 = s.tle_line1;
        if (s.tle_line2) def.initialState.tle_line2 = s.tle_line2;

        return def;
    }

    /**
     * Serialize the entire world to a scenario JSON object.
     * @param {World} world
     * @returns {object} full scenario JSON
     */
    function serializeWorld(world) {
        const entities = [];
        world.entities.forEach(function(entity) {
            entities.push(serializeEntity(entity));
        });

        return {
            metadata: world.scenarioMeta || {
                name: 'Untitled Scenario',
                description: '',
                version: '2.0'
            },
            environment: world.environment || {},
            entities: entities,
            events: world.events || [],
            camera: world.camera || {}
        };
    }

    return {
        Entity: Entity,
        Component: Component,
        World: World,
        serializeEntity: serializeEntity,
        serializeWorld: serializeWorld
    };
})();
