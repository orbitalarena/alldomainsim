const SensorSystem = (function() {
    'use strict';

    function update(dt, world) {
        var entities = world.entitiesWith('sensors');
        for (var i = 0; i < entities.length; i++) {
            var e = entities[i];
            var sensor = e.getComponent('sensors');
            if (!sensor || !sensor.enabled) continue;

            var state = e.state;

            // Cyber attack: sensors completely disabled
            if (state._sensorDisabled) {
                state._detections = [];
                continue;
            }

            // Pass degradation level to sensor components
            var deg = state._cyberDegradation;
            state._sensorDegLevel = deg ? (deg.sensors || 0) : 0;

            sensor.update(dt, world);
        }
    }

    return { update: update };
})();
