/**
 * WeaponSystem — processes all entities that have a 'weapons' component.
 * Delegates update logic to each weapon component's own update method.
 */
const WeaponSystem = (function() {
    'use strict';

    function update(dt, world) {
        var entities = world.entitiesWith('weapons');
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var weap = e.getComponent('weapons');
            if (weap && weap.enabled) {
                weap.update(dt, world);
            }
        }
    }

    return { update: update };
})();
