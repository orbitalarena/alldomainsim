/**
 * FighterLoadout weapon component — stores A2A/A2G weapon loadout for aircraft.
 *
 * This is a passive data component that makes the weapons config (loadout array)
 * available to other components (e.g. visual range rings, HUD weapon display).
 * Actual weapon firing/guidance logic is deferred to a future phase.
 *
 * Config:
 *   loadout   — array of weapon names or objects, e.g. ["aim120", "aim9", "mk84"]
 *
 * Registers as: weapons/fighter_loadout
 */
(function() {
    'use strict';

    class FighterLoadout extends ECS.Component {
        constructor(config) {
            super(config);
            this._loadout = config.loadout || [];
        }

        init(world) {
            // Expose loadout on entity state for HUD/UI access
            this.entity.state._loadout = this._loadout;
        }

        update(dt, world) {
            // Passive component — no per-frame logic yet
        }

        cleanup(world) {
            // Nothing to clean up
        }
    }

    ComponentRegistry.register('weapons', 'fighter_loadout', FighterLoadout);
})();
