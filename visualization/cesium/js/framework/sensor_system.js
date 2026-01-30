const SensorSystem = (function() {
    'use strict';

    function update(dt, world) {
        var entities = world.entitiesWith('sensors');
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var sensor = e.getComponent('sensors');
            if (sensor && sensor.enabled) {
                sensor.update(dt, world);
            }
        }
    }

    return { update: update };
})();
