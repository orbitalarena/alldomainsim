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
        }

        addEntity(entity) {
            this.entities.set(entity.id, entity);
        }

        removeEntity(id) {
            const entity = this.entities.get(id);
            if (entity) {
                // Cleanup components
                for (const name in entity.components) {
                    entity.components[name].cleanup(this);
                }
                this.entities.delete(id);
            }
        }

        getEntity(id) {
            return this.entities.get(id) || null;
        }

        /** Return array of entities that have ALL listed component names. */
        entitiesWith(/* ...names */) {
            const names = arguments;
            const result = [];
            this.entities.forEach(function(entity) {
                if (!entity.active) return;
                for (let i = 0; i < names.length; i++) {
                    if (!entity.components[names[i]]) return;
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

    return { Entity: Entity, Component: Component, World: World };
})();
