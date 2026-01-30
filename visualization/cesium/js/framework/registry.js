/**
 * ComponentRegistry — register and instantiate component classes by category + type.
 * ConfigRegistry   — named preset configs (e.g. "f16", "mig29", "f100") that
 *                    components merge with per-entity overrides from JSON.
 */
const ComponentRegistry = (function() {
    'use strict';

    // category -> typeName -> ComponentClass
    const _components = {};

    // configName -> configObject
    const _configs = {};

    /**
     * Register a component class.
     * @param {string} category  e.g. 'physics', 'control', 'visual'
     * @param {string} typeName  e.g. 'flight3dof', 'player_input', 'point'
     * @param {Function} ComponentClass  constructor extending ECS.Component
     */
    function register(category, typeName, ComponentClass) {
        if (!_components[category]) _components[category] = {};
        _components[category][typeName] = ComponentClass;
    }

    /**
     * Register a named config preset.
     * @param {string} name  e.g. 'f16', 'mig29'
     * @param {object} config
     */
    function registerConfig(name, config) {
        _configs[name] = config;
    }

    /**
     * Look up a config preset by name.
     * @param {string} name
     * @returns {object|null}
     */
    function getConfig(name) {
        return _configs[name] || null;
    }

    /**
     * Create a component instance.
     * @param {string} category
     * @param {string} typeName
     * @param {object} userConfig   per-entity overrides from scenario JSON
     * @returns {ECS.Component}
     */
    function create(category, typeName, userConfig) {
        const cat = _components[category];
        if (!cat) throw new Error('Unknown component category: ' + category);
        const Cls = cat[typeName];
        if (!Cls) throw new Error('Unknown component type: ' + category + '/' + typeName);

        // If userConfig has a 'config' key referencing a named preset, merge it
        let mergedConfig = Object.assign({}, userConfig || {});
        if (mergedConfig.config && typeof mergedConfig.config === 'string') {
            const preset = _configs[mergedConfig.config];
            if (preset) {
                // Preset is the base, user overrides on top
                mergedConfig = Object.assign({}, preset, mergedConfig);
            }
        }

        return new Cls(mergedConfig);
    }

    /**
     * Check if a component type is registered.
     */
    function has(category, typeName) {
        return !!(_components[category] && _components[category][typeName]);
    }

    /**
     * Get all registered component types, grouped by category.
     * @returns {object}  { category: [typeName, ...], ... }
     */
    function getAll() {
        const result = {};
        for (const category in _components) {
            result[category] = Object.keys(_components[category]);
        }
        return result;
    }

    /**
     * Get the editor schema for a component type (if defined).
     * Components can define a static editorSchema() method returning field defs.
     * @param {string} category
     * @param {string} typeName
     * @returns {Array|null}
     */
    function getEditorSchema(category, typeName) {
        const cat = _components[category];
        if (!cat) return null;
        const Cls = cat[typeName];
        if (!Cls) return null;
        if (typeof Cls.editorSchema === 'function') return Cls.editorSchema();
        return null;
    }

    /**
     * Get all registered config preset names.
     * @returns {string[]}
     */
    function getConfigNames() {
        return Object.keys(_configs);
    }

    return {
        register: register,
        registerConfig: registerConfig,
        getConfig: getConfig,
        create: create,
        has: has,
        getAll: getAll,
        getEditorSchema: getEditorSchema,
        getConfigNames: getConfigNames
    };
})();
