/**
 * Fighter Weapons System
 * AIM-120 AMRAAM and AIM-9 Sidewinder missiles with PN guidance
 * Targeting and launch zone computation
 */
const FighterWeapons = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const G = 9.80665;
    const R_EARTH = 6371000;

    // Missile configurations
    const MISSILE_CONFIGS = {
        'AIM-120': {
            name: 'AIM-120 AMRAAM',
            shortName: 'AIM-120',
            mass: 152,           // kg
            motor_thrust: 11000, // N
            motor_burn_time: 8,  // s
            drag_cd: 0.3,
            ref_area: 0.04,      // m² (body cross-section)
            max_g: 40,
            nav_gain: 3.5,       // PN navigation constant
            seeker_fov: 60 * DEG,// total cone angle
            max_range: 100000,   // m (100 km)
            min_range: 1000,     // m
            max_speed: 1360,     // m/s (~Mach 4)
            kill_radius: 20,     // m (proximity fuse)
            max_flight_time: 60, // s
            launch_speed_min: 150, // m/s min launch speed
        },
        'AIM-9': {
            name: 'AIM-9X Sidewinder',
            shortName: 'AIM-9',
            mass: 85,            // kg
            motor_thrust: 8000,  // N
            motor_burn_time: 3,  // s
            drag_cd: 0.35,
            ref_area: 0.03,      // m²
            max_g: 50,
            nav_gain: 3.0,       // PN navigation constant
            seeker_fov: 40 * DEG,
            max_range: 18000,    // m (18 km)
            min_range: 300,      // m
            max_speed: 850,      // m/s (~Mach 2.5)
            kill_radius: 10,     // m
            max_flight_time: 30, // s
            launch_speed_min: 100, // m/s
        },
    };

    // Default loadout
    const DEFAULT_LOADOUT = {
        'AIM-120': 4,
        'AIM-9': 2,
    };

    /**
     * Create weapons system state
     */
    function createWeaponsState() {
        return {
            selectedWeapon: 'AIM-120',
            inventory: { ...DEFAULT_LOADOUT },
            activeMissiles: [],
            targets: [],
            lockedTargetIndex: -1,
            inRange: false,
        };
    }

    /**
     * Get remaining count of selected weapon
     */
    function getCount(state, weaponName) {
        return state.inventory[weaponName || state.selectedWeapon] || 0;
    }

    /**
     * Select weapon type
     */
    function selectWeapon(state, weaponName) {
        if (MISSILE_CONFIGS[weaponName]) {
            state.selectedWeapon = weaponName;
        }
    }

    /**
     * Cycle target lock
     */
    function cycleTarget(state) {
        if (state.targets.length === 0) {
            state.lockedTargetIndex = -1;
            return;
        }
        state.lockedTargetIndex = (state.lockedTargetIndex + 1) % state.targets.length;
    }

    /**
     * Get locked target info
     */
    function getLockedTarget(state) {
        if (state.lockedTargetIndex < 0 || state.lockedTargetIndex >= state.targets.length) {
            return null;
        }
        return state.targets[state.lockedTargetIndex];
    }

    /**
     * Check if target is in launch envelope
     */
    function checkLaunchEnvelope(state, acState) {
        const target = getLockedTarget(state);
        if (!target) {
            state.inRange = false;
            return false;
        }

        const config = MISSILE_CONFIGS[state.selectedWeapon];
        if (!config) {
            state.inRange = false;
            return false;
        }

        const range = FighterSimEngine.distance(acState.lat, acState.lon,
                                                 target.lat, target.lon);
        const dAlt = target.alt - acState.alt;
        const slantRange = Math.sqrt(range * range + dAlt * dAlt);

        // Check range limits
        const inRange = slantRange >= config.min_range &&
                       slantRange <= config.max_range &&
                       acState.speed >= config.launch_speed_min;

        // Check seeker FOV
        const brg = FighterSimEngine.bearing(acState.lat, acState.lon,
                                              target.lat, target.lon);
        let relBearing = brg - acState.heading;
        while (relBearing > Math.PI) relBearing -= 2 * Math.PI;
        while (relBearing < -Math.PI) relBearing += 2 * Math.PI;
        const inFov = Math.abs(relBearing) < config.seeker_fov / 2;

        state.inRange = inRange && inFov;
        return state.inRange;
    }

    /**
     * Fire selected weapon
     * @returns {object|null} missile state or null if can't fire
     */
    function fire(state, acState) {
        const config = MISSILE_CONFIGS[state.selectedWeapon];
        if (!config) return null;
        if (getCount(state) <= 0) return null;

        const target = getLockedTarget(state);
        if (!target) return null;

        if (!checkLaunchEnvelope(state, acState)) return null;

        // Decrement inventory (skip if infinite)
        if (!state.infiniteWeapons) {
            state.inventory[state.selectedWeapon]--;
        }

        // Create missile state
        const missile = {
            id: Date.now() + Math.random(),
            type: state.selectedWeapon,
            config: config,
            lat: acState.lat,
            lon: acState.lon,
            alt: acState.alt,
            speed: acState.speed + 50, // initial boost
            heading: acState.heading,
            gamma: acState.gamma,
            mass: config.mass,
            burnTime: config.motor_burn_time,
            flightTime: 0,
            targetId: target.id,
            state: 'FLYING',    // FLYING, TERMINAL, HIT, MISS
            trail: [],          // position history for visualization
            prevLosAngleH: null, // for PN guidance LOS rate
            prevLosAngleV: null,
        };

        state.activeMissiles.push(missile);
        return missile;
    }

    /**
     * Update all active missiles
     * @param {object} weaponsState
     * @param {number} dt - time step
     */
    function updateMissiles(weaponsState, dt) {
        for (let i = weaponsState.activeMissiles.length - 1; i >= 0; i--) {
            const missile = weaponsState.activeMissiles[i];
            if (missile.state !== 'FLYING' && missile.state !== 'TERMINAL') {
                // Remove completed missiles after a delay (keep for trail viz)
                missile.removeTimer = (missile.removeTimer || 3) - dt;
                if (missile.removeTimer <= 0) {
                    weaponsState.activeMissiles.splice(i, 1);
                }
                continue;
            }

            stepMissile(missile, weaponsState.targets, dt);
        }
    }

    /**
     * Step missile physics + guidance
     */
    function stepMissile(missile, targets, dt) {
        const cfg = missile.config;
        missile.flightTime += dt;

        // Find target
        const target = targets.find(t => t.id === missile.targetId);
        if (!target) {
            missile.state = 'MISS';
            return;
        }

        // Atmosphere
        const atm = Atmosphere.getAtmosphere(missile.alt);
        const qS = 0.5 * atm.density * missile.speed * missile.speed * cfg.ref_area;

        // Thrust (during burn)
        let thrust = 0;
        if (missile.burnTime > 0) {
            thrust = cfg.motor_thrust;
            missile.burnTime -= dt;
        }

        // Drag
        const drag = qS * cfg.drag_cd;

        // --- Proportional Navigation Guidance ---
        // Compute LOS angles to target
        const range = FighterSimEngine.distance(missile.lat, missile.lon,
                                                 target.lat, target.lon);
        const dAlt = target.alt - missile.alt;
        const slantRange = Math.sqrt(range * range + dAlt * dAlt);

        const losAngleH = FighterSimEngine.bearing(missile.lat, missile.lon,
                                                    target.lat, target.lon);
        const losAngleV = Math.atan2(dAlt, Math.max(range, 1));

        // LOS rate
        let losRateH = 0, losRateV = 0;
        if (missile.prevLosAngleH !== null && dt > 0) {
            losRateH = angleDiff(losAngleH, missile.prevLosAngleH) / dt;
            losRateV = (losAngleV - missile.prevLosAngleV) / dt;
        }
        missile.prevLosAngleH = losAngleH;
        missile.prevLosAngleV = losAngleV;

        // Closing velocity
        const closingVel = missile.speed; // simplified

        // PN acceleration commands
        const N = cfg.nav_gain;
        const acmdH = N * closingVel * losRateH; // lateral accel
        const acmdV = N * closingVel * losRateV; // vertical accel

        // Convert to heading and gamma rates (limited by max G)
        const maxAccel = cfg.max_g * G;
        const accH = FighterSimEngine.clamp(acmdH, -maxAccel, maxAccel);
        const accV = FighterSimEngine.clamp(acmdV, -maxAccel, maxAccel);

        const V = Math.max(missile.speed, 10);
        const dHeading = accH / V;
        const dGamma = accV / V;

        // Equations of motion
        const dV = (thrust - drag) / missile.mass - G * Math.sin(missile.gamma);

        // Integrate
        missile.speed += dV * dt;
        missile.speed = Math.max(50, Math.min(cfg.max_speed, missile.speed));

        missile.heading += dHeading * dt;
        missile.heading = FighterSimEngine.normalizeAngle(missile.heading);

        missile.gamma += dGamma * dt;
        missile.gamma = FighterSimEngine.clamp(missile.gamma, -80 * DEG, 80 * DEG);

        // Update position
        const cosGamma = Math.cos(missile.gamma);
        const sinGamma = Math.sin(missile.gamma);
        const R = R_EARTH + missile.alt;

        missile.lat += V * cosGamma * Math.cos(missile.heading) / R * dt;
        missile.lon += V * cosGamma * Math.sin(missile.heading) / (R * Math.cos(missile.lat)) * dt;
        missile.alt += V * sinGamma * dt;

        // Store trail
        if (missile.trail.length === 0 || missile.flightTime % 0.5 < dt) {
            missile.trail.push({
                lat: missile.lat,
                lon: missile.lon,
                alt: missile.alt,
            });
            // Limit trail length
            if (missile.trail.length > 200) missile.trail.shift();
        }

        // --- Hit/Miss detection ---
        // Proximity fuse
        if (slantRange < cfg.kill_radius) {
            missile.state = 'HIT';
            return;
        }

        // Terminal phase (close range)
        if (slantRange < 1000) {
            missile.state = 'TERMINAL';
        }

        // Miss conditions
        if (missile.flightTime > cfg.max_flight_time) {
            missile.state = 'MISS';
            return;
        }
        if (missile.alt < 0) {
            missile.state = 'MISS';
            return;
        }
        if (missile.speed < 80 && missile.burnTime <= 0) {
            missile.state = 'MISS';
            return;
        }
        // Range diverging after close approach
        if (missile.state === 'TERMINAL' && slantRange > 500) {
            missile.state = 'MISS';
            return;
        }
    }

    /**
     * Compute shortest angle difference
     */
    function angleDiff(a, b) {
        let d = a - b;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
    }

    /**
     * Compute closure rate between shooter and target
     */
    function closureRate(acState, target) {
        // Simplified: component of relative velocity along LOS
        const brg = FighterSimEngine.bearing(acState.lat, acState.lon,
                                              target.lat, target.lon);
        const vShooterLos = acState.speed * Math.cos(brg - acState.heading);
        const vTargetLos = target.speed * Math.cos(brg - target.heading);
        return vShooterLos - vTargetLos; // positive = closing
    }

    // Public API
    return {
        MISSILE_CONFIGS,
        DEFAULT_LOADOUT,
        createWeaponsState,
        getCount,
        selectWeapon,
        cycleTarget,
        getLockedTarget,
        checkLaunchEnvelope,
        fire,
        updateMissiles,
        closureRate,
    };
})();
