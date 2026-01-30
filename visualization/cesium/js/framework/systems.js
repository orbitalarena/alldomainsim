/**
 * Built-in systems for the scenario framework.
 * Each system is a function(dt, world) that operates on entities with specific components.
 *
 * System update order:
 *  1. ControlSystem       — read keyboard/AI decisions -> command object
 *  2. PhysicsSystem       — integrate EOM with sub-stepping
 *  3. VisualizationSystem — update Cesium entity positions/trails
 *  4. HUDSystem           — render HUD canvas overlay
 *  5. UISystem            — update DOM status panels
 */
const Systems = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // 1. ControlSystem
    //    Calls each entity's control component to produce a commands object
    //    stored at entity.state._commands.
    // -------------------------------------------------------------------
    function ControlSystem(dt, world) {
        const entities = world.entitiesWith('control');
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            const ctrl = e.getComponent('control');
            if (ctrl.enabled) {
                ctrl.update(dt, world);
                // control component writes to entity.state._commands
            }
        }
    }

    // -------------------------------------------------------------------
    // 2. PhysicsSystem
    //    Sub-steps the physics at max 0.05s per step for stability.
    //    Delegates to each entity's physics component.
    // -------------------------------------------------------------------
    function PhysicsSystem(dt, world) {
        const entities = world.entitiesWith('physics');
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            const phys = e.getComponent('physics');
            if (!phys.enabled) continue;

            // Sub-stepping: max 0.05s per physics tick (matches FighterSimEngine)
            const maxStep = 0.05;
            let remaining = dt;
            const maxSubSteps = 500;
            let steps = 0;
            while (remaining > 0 && steps < maxSubSteps) {
                const subDt = Math.min(remaining, maxStep);
                phys.update(subDt, world);
                remaining -= subDt;
                steps++;
            }
        }
    }

    // -------------------------------------------------------------------
    // 3. VisualizationSystem
    //    Updates Cesium entities (position, orientation, trails, labels).
    // -------------------------------------------------------------------
    function VisualizationSystem(dt, world) {
        const entities = world.entitiesWith('visual');
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            const vis = e.getComponent('visual');
            if (vis.enabled) {
                vis.update(dt, world);
            }
        }
    }

    // -------------------------------------------------------------------
    // 4. HUDSystem
    //    Renders canvas HUD overlay for the player entity (if any).
    // -------------------------------------------------------------------
    function HUDSystem(dt, world) {
        const entities = world.entitiesWith('hud');
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            const hud = e.getComponent('hud');
            if (hud.enabled) {
                hud.update(dt, world);
            }
        }
    }

    // -------------------------------------------------------------------
    // 5. UISystem
    //    Updates DOM panels (flight data, systems status, time display).
    // -------------------------------------------------------------------
    function UISystem(dt, world) {
        // Update status bar time
        const simTimeEl = document.getElementById('scenarioSimTime');
        if (simTimeEl) {
            const mins = Math.floor(world.simTime / 60);
            const secs = Math.floor(world.simTime % 60);
            simTimeEl.textContent = mins + ':' + secs.toString().padStart(2, '0');
        }

        const timeWarpEl = document.getElementById('scenarioTimeWarp');
        if (timeWarpEl) {
            timeWarpEl.textContent = world.timeWarp + 'x';
        }

        const pauseEl = document.getElementById('scenarioPauseStatus');
        if (pauseEl) {
            pauseEl.textContent = world.isPaused ? 'PAUSED' : 'RUNNING';
        }

        // Update flight data panel for player entity
        const player = world.getEntity('player') || world._playerEntity;
        if (!player) return;

        const s = player.state;
        const RAD = FrameworkConstants.RAD;
        const M_TO_FT = FrameworkConstants.M_TO_FT;
        const MPS_TO_KNOTS = FrameworkConstants.MPS_TO_KNOTS;

        _setText('scenarioIAS', Math.round((s.speed || 0) * MPS_TO_KNOTS) + ' KT');
        _setText('scenarioMach', (s.mach || 0).toFixed(2));
        _setText('scenarioAlt', Math.round((s.alt || 0) * M_TO_FT) + ' FT');
        _setText('scenarioHdg',
            Math.round(((s.heading || 0) * RAD + 360) % 360).toString().padStart(3, '0') + '\u00B0');
        _setText('scenarioG', (s.g_load || 1).toFixed(1));
        _setText('scenarioThrottle', Math.round((s.throttle || 0) * 100) + '%');
        _setText('scenarioPhase', s.phase || '---');
    }

    function _setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    /**
     * Register all default systems on a World in the correct order.
     */
    function registerDefaults(world) {
        world.addSystem('control', ControlSystem);
        world.addSystem('physics', PhysicsSystem);
        world.addSystem('visualization', VisualizationSystem);
        world.addSystem('hud', HUDSystem);
        world.addSystem('ui', UISystem);
    }

    return {
        ControlSystem: ControlSystem,
        PhysicsSystem: PhysicsSystem,
        VisualizationSystem: VisualizationSystem,
        HUDSystem: HUDSystem,
        UISystem: UISystem,
        registerDefaults: registerDefaults
    };
})();
