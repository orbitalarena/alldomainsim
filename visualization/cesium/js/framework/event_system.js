const EventSystem = (function() {
    'use strict';

    // Track which events have already fired
    var firedEvents = new Set();

    /**
     * Reset all fired event tracking. Call when loading a new scenario.
     */
    function reset() {
        firedEvents.clear();
    }

    /**
     * Main update loop — evaluate all event definitions and fire actions.
     * @param {number} dt - Delta time in seconds
     * @param {object} world - The world/ECS context
     */
    function update(dt, world) {
        var events = world.events;
        if (!events || events.length === 0) {
            return;
        }

        for (var i = 0; i < events.length; i++) {
            var evt = events[i];

            // Skip events that have already fired (if once=true, which is the default)
            var once = evt.once !== undefined ? evt.once : true;
            if (once && firedEvents.has(evt.id)) {
                continue;
            }

            // Evaluate trigger condition
            if (evaluateTrigger(evt.trigger, world)) {
                executeAction(evt.action, world);
                firedEvents.add(evt.id);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Trigger evaluation
    // -----------------------------------------------------------------------

    /**
     * Evaluate a trigger condition against the current world state.
     * @param {object} trigger - The trigger definition from scenario JSON
     * @param {object} world - The world/ECS context
     * @returns {boolean} true if the trigger condition is met
     */
    function evaluateTrigger(trigger, world) {
        if (!trigger || !trigger.type) {
            return false;
        }

        switch (trigger.type) {
            case 'proximity':
                return evaluateProximity(trigger, world);
            case 'time':
                return evaluateTime(trigger, world);
            case 'detection':
                return evaluateDetection(trigger, world);
            case 'state_change':
                return evaluateStateChange(trigger, world);
            default:
                console.warn('[EventSystem] Unknown trigger type: ' + trigger.type);
                return false;
        }
    }

    /**
     * Proximity trigger: fire when distance between two entities < range_m.
     * Uses Cesium Cartesian3 distance from geodetic lat/lon/alt (radians/meters).
     */
    function evaluateProximity(trigger, world) {
        var entityA = world.getEntity(trigger.entityA);
        var entityB = world.getEntity(trigger.entityB);
        if (!entityA || !entityB) {
            return false;
        }

        var sA = entityA.state;
        var sB = entityB.state;
        if (sA.lat === undefined || sB.lat === undefined) {
            return false;
        }

        var posA = Cesium.Cartesian3.fromRadians(sA.lon || 0, sA.lat || 0, sA.alt || 0);
        var posB = Cesium.Cartesian3.fromRadians(sB.lon || 0, sB.lat || 0, sB.alt || 0);
        var dist = Cesium.Cartesian3.distance(posA, posB);

        return dist < trigger.range_m;
    }

    /**
     * Time trigger: fire when simulation time reaches or exceeds simTime_s.
     */
    function evaluateTime(trigger, world) {
        if (trigger.simTime_s === undefined) {
            return false;
        }
        return world.simTime >= trigger.simTime_s;
    }

    /**
     * Detection trigger: fire when sensorEntity's _detections includes targetEntity.
     * Detections are stored on entity.state._detections as array of { targetId, detected }.
     */
    function evaluateDetection(trigger, world) {
        var sensorEntity = world.getEntity(trigger.sensorEntity);
        var targetEntity = world.getEntity(trigger.targetEntity);
        if (!sensorEntity || !targetEntity) {
            return false;
        }

        var detections = sensorEntity.state._detections;
        if (!detections || detections.length === 0) {
            return false;
        }

        // Check if the target entity ID is in the detections list
        for (var i = 0; i < detections.length; i++) {
            if (detections[i].targetId === targetEntity.id && detections[i].detected) {
                return true;
            }
        }

        return false;
    }

    /**
     * State change trigger: fire when entity.state[field] === value.
     */
    function evaluateStateChange(trigger, world) {
        var entity = world.getEntity(trigger.entity);
        if (!entity || !entity.state) {
            return false;
        }

        return entity.state[trigger.field] === trigger.value;
    }

    // -----------------------------------------------------------------------
    // Action execution
    // -----------------------------------------------------------------------

    /**
     * Execute an action when its trigger fires.
     * @param {object} action - The action definition from scenario JSON
     * @param {object} world - The world/ECS context
     */
    function executeAction(action, world) {
        if (!action || !action.type) {
            return;
        }

        switch (action.type) {
            case 'set_state':
                executeSetState(action, world);
                break;
            case 'spawn_entity':
                executeSpawnEntity(action, world);
                break;
            case 'message':
                executeMessage(action, world);
                break;
            case 'change_rules':
                executeChangeRules(action, world);
                break;
            default:
                console.warn('[EventSystem] Unknown action type: ' + action.type);
                break;
        }
    }

    /**
     * Set a field on an entity's state.
     */
    function executeSetState(action, world) {
        var entity = world.getEntity(action.entity);
        if (!entity) {
            console.warn('[EventSystem] set_state: entity not found: ' + action.entity);
            return;
        }
        if (!entity.state) {
            entity.state = {};
        }
        entity.state[action.field] = action.value;
    }

    /**
     * Spawn a new entity into the world.
     */
    function executeSpawnEntity(action, world) {
        if (typeof world.spawnEntity === 'function') {
            world.spawnEntity(action);
        } else {
            console.warn('[EventSystem] spawn_entity: world.spawnEntity not available');
        }
    }

    /**
     * Display a message via BuilderApp if available.
     */
    function executeMessage(action, world) {
        if (typeof BuilderApp !== 'undefined' && typeof BuilderApp.showMessage === 'function') {
            BuilderApp.showMessage(action.text);
        } else {
            console.log('[EventSystem] Message: ' + action.text);
        }
    }

    /**
     * Change engagement rules on an entity.
     */
    function executeChangeRules(action, world) {
        var entity = world.getEntity(action.entity);
        if (!entity) {
            console.warn('[EventSystem] change_rules: entity not found: ' + action.entity);
            return;
        }
        if (!entity.state) {
            entity.state = {};
        }
        entity.state.engagementRules = action.value;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    return {
        update: update,
        reset: reset
    };
})();
