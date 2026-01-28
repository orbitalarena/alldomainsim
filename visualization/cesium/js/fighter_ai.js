/**
 * Fighter AI System
 * AI target drones with patrol and evasive behaviors
 */
const FighterAI = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const G = 9.80665;
    const R_EARTH = 6371000;

    // AI behavior states
    const AIState = {
        PATROL: 'PATROL',
        EVADE: 'EVADE',
        DESTROYED: 'DESTROYED',
    };

    // AI drone configuration (simpler aircraft - like a MiG-29)
    const DRONE_CONFIG = {
        mass: 11000,          // kg
        wing_area: 38,        // m²
        cd0: 0.02,
        cl_max: 1.4,
        aspect_ratio: 3.4,
        oswald: 0.82,
        max_speed: 350,       // m/s
        cruise_speed: 250,    // m/s
        max_g: 7,
        max_roll_rate: 200 * DEG,
        max_pitch_rate: 20 * DEG,
        thrust_max: 80000,    // N
    };

    /**
     * Default patrol patterns for drones
     */
    const PATROL_PATTERNS = [
        // Racetrack east of Edwards
        {
            name: 'BANDIT-1',
            waypoints: [
                { lat: 35.2 * DEG, lon: -117.0 * DEG, alt: 6000 },
                { lat: 35.5 * DEG, lon: -116.5 * DEG, alt: 6000 },
                { lat: 35.2 * DEG, lon: -116.0 * DEG, alt: 6000 },
                { lat: 34.9 * DEG, lon: -116.5 * DEG, alt: 6000 },
            ],
            speed: 230,
        },
        // Higher altitude patrol north
        {
            name: 'BANDIT-2',
            waypoints: [
                { lat: 35.6 * DEG, lon: -117.5 * DEG, alt: 8000 },
                { lat: 35.8 * DEG, lon: -117.0 * DEG, alt: 8000 },
                { lat: 35.6 * DEG, lon: -116.5 * DEG, alt: 8000 },
                { lat: 35.4 * DEG, lon: -117.0 * DEG, alt: 8000 },
            ],
            speed: 260,
        },
    ];

    /**
     * Create an AI drone
     */
    function createDrone(patternIndex) {
        const pattern = PATROL_PATTERNS[patternIndex % PATROL_PATTERNS.length];
        const startWp = pattern.waypoints[0];

        return {
            id: 'drone_' + patternIndex + '_' + Date.now(),
            name: pattern.name,
            config: DRONE_CONFIG,
            patrol: pattern,

            // Position/velocity state
            lat: startWp.lat,
            lon: startWp.lon,
            alt: startWp.alt,
            speed: pattern.speed,
            heading: 0,
            gamma: 0,
            roll: 0,

            // AI state
            aiState: AIState.PATROL,
            currentWpIndex: 0,
            evadeTimer: 0,
            evadeDirection: 1,   // 1 = right break, -1 = left break

            // Tracking
            threatDetected: false,
            threatBearing: 0,
        };
    }

    /**
     * Create all default drones
     */
    function createDrones() {
        return PATROL_PATTERNS.map((_, i) => createDrone(i));
    }

    /**
     * Update a single drone
     */
    function updateDrone(drone, playerState, activeMissiles, dt) {
        if (drone.aiState === AIState.DESTROYED) return;

        // Check for threats (missiles within 10 km)
        let closestMissileDist = Infinity;
        for (const missile of activeMissiles) {
            if (missile.state !== 'FLYING' && missile.state !== 'TERMINAL') continue;
            if (missile.targetId !== drone.id) continue;

            const dist = FighterSimEngine.distance(drone.lat, drone.lon,
                                                    missile.lat, missile.lon);
            const dAlt = missile.alt - drone.alt;
            const slantDist = Math.sqrt(dist * dist + dAlt * dAlt);

            if (slantDist < closestMissileDist) {
                closestMissileDist = slantDist;
                drone.threatBearing = FighterSimEngine.bearing(drone.lat, drone.lon,
                                                                missile.lat, missile.lon);
            }
        }

        // Check for missile hits
        for (const missile of activeMissiles) {
            if (missile.state === 'HIT' && missile.targetId === drone.id) {
                drone.aiState = AIState.DESTROYED;
                return;
            }
        }

        // State transitions
        if (closestMissileDist < 10000 && drone.aiState !== AIState.EVADE) {
            // Threat detected - begin evasion
            drone.aiState = AIState.EVADE;
            drone.evadeTimer = 10; // evade for 10 seconds
            // Break in direction perpendicular to threat
            const relBearing = drone.threatBearing - drone.heading;
            drone.evadeDirection = Math.sin(relBearing) > 0 ? -1 : 1;
            drone.threatDetected = true;
        }

        if (drone.aiState === AIState.EVADE) {
            drone.evadeTimer -= dt;
            if (drone.evadeTimer <= 0 && closestMissileDist > 15000) {
                drone.aiState = AIState.PATROL;
                drone.threatDetected = false;
            }
        }

        // Execute behavior
        if (drone.aiState === AIState.PATROL) {
            updatePatrol(drone, dt);
        } else if (drone.aiState === AIState.EVADE) {
            updateEvade(drone, dt);
        }

        // Physics integration (simplified)
        updateDronePhysics(drone, dt);
    }

    /**
     * Patrol behavior - fly to waypoints
     */
    function updatePatrol(drone, dt) {
        const wp = drone.patrol.waypoints[drone.currentWpIndex];
        if (!wp) return;

        // Compute bearing to waypoint
        const brg = FighterSimEngine.bearing(drone.lat, drone.lon, wp.lat, wp.lon);
        const dist = FighterSimEngine.distance(drone.lat, drone.lon, wp.lat, wp.lon);

        // Turn toward waypoint
        let hdgError = brg - drone.heading;
        while (hdgError > Math.PI) hdgError -= 2 * Math.PI;
        while (hdgError < -Math.PI) hdgError += 2 * Math.PI;

        // Bank to turn
        const desiredRoll = FighterSimEngine.clamp(hdgError * 2, -45 * DEG, 45 * DEG);
        const rollRate = FighterSimEngine.clamp(desiredRoll - drone.roll,
                                                 -drone.config.max_roll_rate * dt,
                                                 drone.config.max_roll_rate * dt);
        drone.roll += rollRate;

        // Altitude control
        const altError = wp.alt - drone.alt;
        drone.gamma = FighterSimEngine.clamp(altError * 0.002, -10 * DEG, 10 * DEG);

        // Speed control
        const spdError = drone.patrol.speed - drone.speed;
        drone.speed += FighterSimEngine.clamp(spdError * 0.5, -20 * dt, 20 * dt);

        // Switch waypoint if close
        if (dist < 2000) {
            drone.currentWpIndex = (drone.currentWpIndex + 1) % drone.patrol.waypoints.length;
        }
    }

    /**
     * Evasive maneuvers - break turn + dive/climb
     */
    function updateEvade(drone, dt) {
        // Hard break turn perpendicular to threat
        const breakRoll = drone.evadeDirection * 70 * DEG;
        const rollRate = FighterSimEngine.clamp(breakRoll - drone.roll,
                                                 -drone.config.max_roll_rate * dt,
                                                 drone.config.max_roll_rate * dt);
        drone.roll += rollRate;

        // Increase speed
        drone.speed = Math.min(drone.config.max_speed, drone.speed + 30 * dt);

        // Altitude changes (jinking)
        const jinkPhase = Math.sin(drone.evadeTimer * 2);
        drone.gamma = jinkPhase * 15 * DEG;

        // After initial break, alternate direction (notching)
        if (drone.evadeTimer < 5) {
            drone.evadeDirection *= -1; // reverse every update is too fast
        }
    }

    /**
     * Update drone flight physics
     */
    function updateDronePhysics(drone, dt) {
        const V = Math.max(drone.speed, 10);
        const atm = Atmosphere.getAtmosphere(drone.alt);
        const mass = drone.config.mass;

        // Turn dynamics from bank angle
        const lift = mass * G / Math.max(Math.cos(drone.roll), 0.1);
        const turnRate = lift * Math.sin(drone.roll) / (mass * V);

        drone.heading += turnRate * dt;
        drone.heading = FighterSimEngine.normalizeAngle(drone.heading);

        // Position update
        const cosGamma = Math.cos(drone.gamma);
        const sinGamma = Math.sin(drone.gamma);
        const R = R_EARTH + drone.alt;

        drone.lat += V * cosGamma * Math.cos(drone.heading) / R * dt;
        const cosLat = Math.cos(drone.lat);
        if (Math.abs(cosLat) > 0.001) {
            drone.lon += V * cosGamma * Math.sin(drone.heading) / (R * cosLat) * dt;
        }
        drone.alt += V * sinGamma * dt;
        drone.alt = Math.max(500, drone.alt); // don't crash into ground
    }

    /**
     * Update all drones
     */
    function updateAll(drones, playerState, activeMissiles, dt) {
        for (const drone of drones) {
            updateDrone(drone, playerState, activeMissiles, dt);
        }
    }

    /**
     * Get target list for weapons system (alive drones only)
     */
    function getTargetList(drones) {
        return drones
            .filter(d => d.aiState !== AIState.DESTROYED)
            .map(d => ({
                id: d.id,
                name: d.name,
                lat: d.lat,
                lon: d.lon,
                alt: d.alt,
                speed: d.speed,
                heading: d.heading,
                gamma: d.gamma,
            }));
    }

    // Public API
    return {
        AIState,
        DRONE_CONFIG,
        PATROL_PATTERNS,
        createDrone,
        createDrones,
        updateDrone,
        updateAll,
        getTargetList,
    };
})();
