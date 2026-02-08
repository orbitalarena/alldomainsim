/**
 * Fighter Jet Flight Physics Engine
 * 3-DOF point-mass + attitude model for F-16-like aircraft
 * Handles aerodynamics, propulsion, ground operations, and flight phases
 */
const FighterSimEngine = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const G = 9.80665;
    const R_EARTH = 6371000;
    const MU_EARTH = 3.986004418e14;  // m³/s² Earth gravitational parameter

    // Flight phases
    const Phase = {
        PARKED: 'PARKED',
        TAXI: 'TAXI',
        TAKEOFF: 'TAKEOFF',
        FLIGHT: 'FLIGHT',
        APPROACH: 'APPROACH',
        LANDING: 'LANDING',
        LANDED: 'LANDED',
        CRASHED: 'CRASHED'
    };

    // F-16 Fighting Falcon configuration
    const F16_CONFIG = {
        name: 'F-16C Fighting Falcon',
        mass_empty: 8570,        // kg
        mass_loaded: 12000,      // kg (with fuel + weapons)
        fuel_capacity: 3200,     // kg internal
        wing_area: 27.87,        // m²
        wing_span: 9.96,         // m
        aspect_ratio: 3.55,
        cd0: 0.0175,             // zero-lift drag (clean)
        cd0_gear: 0.035,         // with gear down (significant drag rise)
        cd0_flaps: 0.015,        // additional flap drag
        cd0_speedbrake: 0.04,    // speed brake deployed
        oswald: 0.85,            // Oswald efficiency
        cl_max: 1.6,             // max lift coefficient (clean)
        cl_max_flaps: 2.0,       // with flaps
        cl_alpha: 0.08,          // per degree
        thrust_mil: 79000,       // N military power (sea level)
        thrust_ab: 127000,       // N afterburner (sea level)
        tsfc_mil: 0.0234,        // kg/(N·s) specific fuel consumption
        tsfc_ab: 0.0625,         // kg/(N·s) afterburner SFC
        max_g: 9.0,
        min_g: -3.0,
        max_roll_rate: 280 * DEG,  // rad/s
        max_pitch_rate: 30 * DEG,  // rad/s
        max_aoa: 25 * DEG,         // rad
        corner_speed: 180,         // m/s
        service_ceiling: 15240,    // m (50,000 ft)
        v_rotate: 80,             // m/s rotation speed
        v_approach: 75,           // m/s approach speed
        gear_transition_time: 3,  // seconds
        brake_decel: 6.0,         // m/s² ground braking (strong anti-skid)
        ground_friction: 0.03,    // rolling friction coefficient
        idle_thrust_frac: 0.05,   // fraction of mil thrust at idle
        max_mach: 2.05,           // structural Mach limit (overspeed warning)
    };

    // X-37S Spaceplane configuration
    const SPACEPLANE_CONFIG = {
        name: 'X-37S Spaceplane',
        mass_empty: 12000,        // kg
        mass_loaded: 15000,       // kg
        fuel_capacity: Infinity,  // infinite delta-v
        wing_area: 35.0,          // m²
        wing_span: 12.0,          // m
        aspect_ratio: 4.1,

        // Aero (subsonic similar to F-16, modified for hypersonic)
        cd0: 0.018,  cd0_gear: 0.035,  cd0_flaps: 0.015,  cd0_speedbrake: 0.04,
        oswald: 0.80,  cl_max: 1.5,  cl_max_flaps: 1.9,  cl_alpha: 0.07,
        cd0_hypersonic: 0.040,       // higher base drag at Mach 5+
        cl_alpha_hypersonic: 0.03,   // reduced lift slope at hypersonic

        // AIR mode (Mach 0-2): air-breathing turbofan with density lapse
        thrust_mil: 90000,   thrust_ab: 160000,  // N
        tsfc_mil: 0.022,     tsfc_ab: 0.058,

        // HYPERSONIC mode (Mach 2-10): scramjet-like, no density lapse, works everywhere
        thrust_hypersonic: 800000,  // N (flat, no lapse)

        // ROCKET mode (Mach 10+): massive thrust for orbit insertion
        thrust_rocket: 5000000,  // N (5 MN — dramatic kick)

        // Structural
        max_g: 6.0,  min_g: -2.0,
        max_roll_rate: 180 * DEG,  max_pitch_rate: 20 * DEG,
        max_aoa: 30 * DEG,
        service_ceiling: Infinity,

        // Ground ops
        v_rotate: 85,  v_approach: 80,
        corner_speed: 200,
        gear_transition_time: 4,  brake_decel: 6.0,
        ground_friction: 0.03,  idle_thrust_frac: 0.05,

        // Spaceplane flag
        isSpaceplane: true,
    };

    // Edwards AFB runway
    const EDWARDS = {
        lat: 34.9054 * DEG,
        lon: -117.8839 * DEG,
        alt: 702,                 // m MSL (2302 ft)
        heading: 220 * DEG,       // runway 22L
        length: 4600,             // m
        width: 60,                // m
    };

    /**
     * Inverse-square gravity at altitude
     * @param {number} alt - altitude in meters
     * @returns {number} gravitational acceleration in m/s²
     */
    function getGravity(alt) {
        const r = R_EARTH + alt;
        return MU_EARTH / (r * r);
    }

    /**
     * Aero blend factor: smooth transition from full aero to vacuum
     * @param {number} q - dynamic pressure in Pa
     * @returns {number} 0..1 blend factor (1 = full aero, 0 = vacuum)
     */
    function getAeroBlendFactor(q) {
        if (q > 100) return 1.0;     // full aero
        if (q < 1)   return 0.0;     // vacuum
        return Math.log10(q) / 2;    // smooth log-linear blend
    }

    /**
     * Propulsion mode names for cycling
     */
    const PROP_MODES = ['AIR', 'HYPERSONIC', 'ROCKET'];

    /**
     * Determine propulsion mode from player selection.
     * @returns {string} 'AIR', 'HYPERSONIC', or 'ROCKET'
     */
    function getPropulsionMode(state) {
        return state.forcedPropMode || 'AIR';
    }

    /**
     * Create a new aircraft state
     */
    function createAircraftState(options = {}) {
        const runway = options.runway || EDWARDS;
        const airborne = options.airborne !== undefined ? options.airborne : true;

        let state;
        if (airborne) {
            // Start airborne
            state = {
                lat: options.lat || runway.lat,
                lon: options.lon || runway.lon,
                alt: options.alt || 5000,
                speed: options.speed || 200,
                heading: options.heading || runway.heading,
                gamma: 0,                    // flight path angle
                pitch: 0,                    // body pitch
                roll: 0,                     // bank angle
                yaw: 0,                      // sideslip proxy
                throttle: options.throttle !== undefined ? options.throttle : 0.6,
                fuel: options.fuel || F16_CONFIG.fuel_capacity,
                g_load: 1.0,
                alpha: 2 * DEG,
                mach: 0,
                phase: Phase.FLIGHT,
                engineOn: true,
                gearDown: false,
                gearTransition: 0,
                flapsDown: false,
                brakesOn: false,
                maxG_experienced: 1.0,
                yawOffset: 0,          // cosmetic nose yaw offset (vacuum RCS)
            };
        } else {
            // Start on runway
            state = {
                lat: runway.lat,
                lon: runway.lon,
                alt: runway.alt,
                speed: 0,
                heading: runway.heading,
                gamma: 0,
                pitch: 0,
                roll: 0,
                yaw: 0,
                throttle: 0,
                fuel: F16_CONFIG.fuel_capacity,
                g_load: 1.0,
                alpha: 0,
                mach: 0,
                phase: Phase.PARKED,
                engineOn: false,
                gearDown: true,
                gearTransition: 0,
                flapsDown: false,
                brakesOn: true,
                maxG_experienced: 1.0,
            };
        }

        return state;
    }

    /**
     * Compute current mass
     */
    function getMass(state, config) {
        const weaponMass = state.weaponMass || 0;
        const fuelMass = isFinite(state.fuel) ? state.fuel : 0;
        return config.mass_empty + fuelMass + weaponMass;
    }

    /**
     * Compute thrust for current propulsion mode.
     * Handles AIR (density-lapsed), HYPERSONIC (flat), and ROCKET (flat) modes.
     * Mode is driven by state.forcedPropMode (player P-key toggle).
     * Default thrust values provided if config doesn't define them.
     */
    function getThrust(state, config, atm) {
        if (!state.engineOn) return { thrust: 0, sfc: 0, mode: 'OFF' };

        const mode = getPropulsionMode(state);
        state.propulsionMode = mode;

        if (mode === 'TAXI') {
            const taxiThrust = config.thrust_taxi || 10000;  // 10 kN default — ground ops
            return { thrust: state.throttle * taxiThrust, sfc: 0, mode };
        }

        if (mode === 'ROCKET') {
            const rocketThrust = config.thrust_rocket || 5000000;  // 5 MN default
            return { thrust: state.throttle * rocketThrust, sfc: 0, mode };
        }

        if (mode === 'HYPERSONIC') {
            const hyperThrust = config.thrust_hypersonic || 800000;  // 800 kN default
            return { thrust: state.throttle * hyperThrust, sfc: 0, mode };
        }

        // AIR mode: air-breathing with density lapse
        const thrustLapse = Math.pow(atm.density / Atmosphere.SEA_LEVEL_DENSITY, 0.7);
        const abThreshold = 0.85;
        const idleFrac = config.idle_thrust_frac || 0.05;

        let thrust, sfc;
        if (state.throttle > abThreshold) {
            const abFrac = (state.throttle - abThreshold) / (1.0 - abThreshold);
            thrust = config.thrust_mil + abFrac * ((config.thrust_ab || config.thrust_mil) - config.thrust_mil);
            sfc = (config.tsfc_mil || 0) + abFrac * ((config.tsfc_ab || config.tsfc_mil || 0) - (config.tsfc_mil || 0));
        } else if (state.throttle > 0.05) {
            const milFrac = (state.throttle - 0.05) / (abThreshold - 0.05);
            thrust = idleFrac * config.thrust_mil +
                     milFrac * (1.0 - idleFrac) * config.thrust_mil;
            sfc = config.tsfc_mil || 0;
        } else {
            thrust = idleFrac * config.thrust_mil;
            sfc = config.tsfc_mil || 0;
        }

        thrust *= thrustLapse;

        // No fuel = no thrust
        if (state.fuel !== undefined && isFinite(state.fuel) && state.fuel <= 0) {
            thrust = 0;
            sfc = 0;
        }

        return { thrust, sfc, mode };
    }

    /**
     * Compute aerodynamic coefficients
     */
    function getAeroCoeffs(state, config) {
        const cd0_base = state.gearDown ? config.cd0_gear : config.cd0;
        const cd0 = cd0_base
            + (state.flapsDown ? (config.cd0_flaps || 0) : 0)
            + (state.speedBrakeOut ? (config.cd0_speedbrake || 0.04) : 0);
        const cl_max = state.flapsDown ? config.cl_max_flaps : config.cl_max;

        return { cd0, cl_max };
    }

    /**
     * Compute lift coefficient for given AoA
     */
    function getCL(alpha, config, aero) {
        const cl = config.cl_alpha * (alpha * RAD); // cl_alpha is per degree
        return Math.max(-aero.cl_max, Math.min(aero.cl_max, cl));
    }

    /**
     * Compute drag coefficient
     */
    function getCD(cl, config, aero, mach) {
        // CD = CD0 + CL²/(π·e·AR)  (drag polar)
        const cdi = (cl * cl) / (Math.PI * config.oswald * config.aspect_ratio);
        // Wave drag near Mach 1
        let cdwave = 0;
        if (mach > 0.85) {
            const dm = mach - 0.85;
            cdwave = 0.1 * dm * dm; // simple transonic drag rise
        }
        return aero.cd0 + cdi + cdwave;
    }

    /**
     * Main physics step
     * @param {object} state - aircraft state (mutated in place)
     * @param {object} controls - player input commands
     * @param {number} dt - time step in seconds
     * @param {object} config - aircraft configuration
     * @returns {object} updated state
     */
    function step(state, controls, dt, config) {
        config = config || F16_CONFIG;

        if (state.phase === Phase.CRASHED) return state;
        if (dt <= 0) return state;

        // Cap dt to prevent instability
        dt = Math.min(dt, 0.05);

        // Atmosphere at current altitude
        const atm = Atmosphere.getAtmosphere(state.alt);
        state.mach = state.speed / atm.speedOfSound;

        const mass = getMass(state, config);
        const g = getGravity(state.alt);
        const weight = mass * g;
        const qS = atm.dynamicPressure(state.speed) * config.wing_area; // q * S

        // Gear transition
        if (state.gearTransition > 0) {
            state.gearTransition -= dt;
            if (state.gearTransition <= 0) state.gearTransition = 0;
        }

        // Phase-dependent physics
        if (state.phase === Phase.LANDED) {
            stepLanded(state, controls, dt, config, atm, mass);
        } else if (state.phase === Phase.PARKED) {
            stepGround(state, controls, dt, config, atm, mass);
        } else if (state.phase === Phase.TAXI) {
            stepTaxi(state, controls, dt, config, atm, mass);
        } else if (state.phase === Phase.TAKEOFF) {
            stepTakeoff(state, controls, dt, config, atm, mass, weight, qS);
        } else {
            stepFlight(state, controls, dt, config, atm, mass, weight, qS);
        }

        // Fuel consumption (skip if infinite fuel enabled)
        if (!state.infiniteFuel && state.engineOn && state.fuel > 0) {
            const { thrust, sfc } = getThrust(state, config, atm);
            state.fuel -= sfc * thrust * dt;
            state.fuel = Math.max(0, state.fuel);
        }

        // Ground collision check
        const groundAlt = state.groundAlt != null ? state.groundAlt : EDWARDS.alt;
        if (state.phase === Phase.FLIGHT || state.phase === Phase.APPROACH) {
            if (state.alt <= groundAlt) {
                // Check if this is a landing or a crash
                const sinkRate = -state.speed * Math.sin(state.gamma);
                if (state.gearDown && Math.abs(state.roll) < 10 * DEG &&
                    sinkRate < 5 && state.speed < 120) {
                    // Successful landing
                    state.alt = groundAlt;
                    state.gamma = 0;
                    state.pitch = 0;
                    state.roll = 0;
                    state.phase = Phase.LANDED;
                } else {
                    state.phase = Phase.CRASHED;
                }
            }
        }

        // Track max G
        state.maxG_experienced = Math.max(state.maxG_experienced, Math.abs(state.g_load));

        // Clamp position
        state.alt = Math.max(state.phase === Phase.FLIGHT ? 0 : groundAlt, state.alt);

        return state;
    }

    /**
     * Ground (parked) state — stationary or low-speed taxi initiation
     */
    function stepGround(state, controls, dt, config, atm, mass) {
        state.speed = Math.max(0, state.speed);
        state.gamma = 0;
        state.roll = 0;
        state.g_load = 1.0;
        state.alpha = 0;

        // Apply throttle
        applyThrottleControl(state, controls, dt);

        // Ground forces when engine on
        if (state.engineOn && state.throttle > 0.1) {
            const { thrust } = getThrust(state, config, atm);
            const friction = config.ground_friction * mass * G;
            const brakeForce = state.brakesOn ? config.brake_decel * mass : 0;
            const netForce = thrust - friction - brakeForce;
            state.speed += (netForce / mass) * dt;
            state.speed = Math.max(0, state.speed);
        }

        // Apply brakes / idle deceleration
        if (state.brakesOn || state.throttle < 0.1) {
            state.speed = Math.max(0, state.speed - config.brake_decel * dt);
        }

        // Transition to taxi if moving (PARKED only — LANDED uses stepLanded)
        if (state.engineOn && state.speed > 1) {
            state.phase = Phase.TAXI;
        }
    }

    /**
     * Landed rollout — post-touchdown deceleration with aero drag + wheel brakes.
     * Stays in LANDED until stopped, then transitions to PARKED.
     */
    function stepLanded(state, controls, dt, config, atm, mass) {
        state.gamma = 0;
        state.roll = 0;
        state.g_load = 1.0;
        state.alpha = 0;

        // Aerodynamic drag on ground roll (significant at high speed)
        const q = 0.5 * atm.density * state.speed * state.speed;
        const S = config.wing_area;
        const aero = getAeroCoeffs(state, config);
        const cd = aero.cd0;
        const aeroDrag = q * S * cd;

        // Ground friction
        const friction = config.ground_friction * mass * G;

        // Wheel brakes (always active during rollout + manual B for extra)
        const brakeForce = config.brake_decel * mass;

        // Total deceleration
        const totalDecel = (aeroDrag + friction + brakeForce) / mass;
        state.speed = Math.max(0, state.speed - totalDecel * dt);

        // Heading control (nosewheel steering at low speed)
        if (state.speed > 5 && controls.roll) {
            const steerRate = 15 * DEG;
            state.heading += controls.roll * steerRate * dt;
            state.heading = normalizeAngle(state.heading);
        }

        // Update position
        updatePosition(state, dt);

        // Transition to parked when stopped
        if (state.speed < 0.5) {
            state.speed = 0;
            state.phase = Phase.PARKED;
        }

        applyThrottleControl(state, controls, dt);
    }

    /**
     * Taxi phase
     */
    function stepTaxi(state, controls, dt, config, atm, mass) {
        const { thrust } = getThrust(state, config, atm);

        // Ground forces
        const friction = config.ground_friction * mass * G;
        const brakeForce = state.brakesOn ? config.brake_decel * mass : 0;
        const netForce = thrust - friction - brakeForce;

        state.speed += (netForce / mass) * dt;
        state.speed = Math.max(0, state.speed);

        // Heading control via roll input (nosewheel steering)
        const steerRate = 30 * DEG; // max 30 deg/s turn rate on ground
        if (controls.roll) {
            state.heading += controls.roll * steerRate * dt;
        }
        state.heading = normalizeAngle(state.heading);

        // Update position
        updatePosition(state, dt);

        // Transition to takeoff if fast enough
        if (state.speed > 30) {
            state.phase = Phase.TAKEOFF;
        }

        // Back to parked if stopped
        if (state.speed < 0.5 && state.throttle < 0.1) {
            state.phase = Phase.PARKED;
            state.speed = 0;
        }

        state.gamma = 0;
        state.roll = 0;
        state.g_load = 1.0;
        state.alpha = 0;

        applyThrottleControl(state, controls, dt);
    }

    /**
     * Takeoff phase - ground roll until liftoff
     */
    function stepTakeoff(state, controls, dt, config, atm, mass, weight, qS) {
        const { thrust } = getThrust(state, config, atm);
        const aero = getAeroCoeffs(state, config);

        // Ground roll aerodynamics
        const cl = state.speed > config.v_rotate ? 0.8 : 0.1; // rotate at Vr
        const lift = qS * cl;
        const cd = aero.cd0 + cl * cl / (Math.PI * config.oswald * config.aspect_ratio);
        const drag = qS * cd;

        if (lift >= weight) {
            // Liftoff!
            state.phase = Phase.FLIGHT;
            state.gamma = 5 * DEG;
            state.pitch = 8 * DEG;
            state.alpha = 5 * DEG;
            state.gearDown = true; // still down, retract manually
            return;
        }

        // Ground roll
        const friction = config.ground_friction * Math.max(0, weight - lift);
        const netForce = thrust - drag - friction;
        state.speed += (netForce / mass) * dt;
        state.speed = Math.max(0, state.speed);

        // Heading control
        if (controls.roll) {
            state.heading += controls.roll * 15 * DEG * dt;
        }
        state.heading = normalizeAngle(state.heading);

        updatePosition(state, dt);

        state.gamma = 0;
        state.g_load = 1.0;
        state.alpha = state.speed > config.v_rotate ? 5 * DEG : 0;
        state.pitch = state.alpha;

        // Back to taxi if slowed down
        if (state.speed < 20 && state.throttle < 0.3) {
            state.phase = Phase.TAXI;
        }

        applyThrottleControl(state, controls, dt);
    }

    /**
     * Flight phase - full 3-DOF aerodynamics
     * Unified physics model: behavior driven by dynamic pressure and altitude,
     * not vehicle type. All entities get inverse-square gravity, centrifugal
     * term, aero blend, multi-mode thrust, and Kepler vacuum propagation.
     */
    function stepFlight(state, controls, dt, config, atm, mass, weight, qS) {
        // Aero blend from dynamic pressure — drives regime transitions
        const q = atm.dynamicPressure(state.speed);
        const aeroBlend = getAeroBlendFactor(q);

        // Apply control inputs (aeroBlend determines vacuum vs atmospheric behavior)
        applyThrottleControl(state, controls, dt);
        applyFlightControls(state, controls, dt, config, atm, mass, weight, qS, aeroBlend);

        // Inverse-square gravity for all entities
        const g = getGravity(state.alt);
        const W = mass * g;

        // Aerodynamic forces with blend factor
        const aero = getAeroCoeffs(state, config);

        // Hypersonic aero coefficient adjustments (if config defines them)
        let effectiveConfig = config;
        if (config.cd0_hypersonic && state.mach > 5) {
            const hyperBlend = Math.min((state.mach - 5) / 3, 1.0);
            effectiveConfig = Object.assign({}, config, {
                cl_alpha: config.cl_alpha * (1 - hyperBlend) +
                    (config.cl_alpha_hypersonic || config.cl_alpha) * hyperBlend,
            });
            aero.cd0 = aero.cd0 * (1 - hyperBlend) + config.cd0_hypersonic * hyperBlend;
        }

        const cl = getCL(state.alpha, effectiveConfig, aero);
        const cd = getCD(cl, config, aero, state.mach);

        const lift = qS * cl * aeroBlend;
        const drag = qS * cd * aeroBlend;

        // Unified thrust (handles AIR/HYPERSONIC/ROCKET modes)
        const thrust = getThrust(state, config, atm).thrust;

        // Force-free vacuum: analytic Kepler propagation eliminates Euler drift.
        // Controls (roll/alpha/yaw) are already applied above via applyFlightControls.
        // Kepler handles position/velocity propagation; controls update attitude for
        // visual feedback and for when thrust resumes.
        var effectivelyNoThrust = thrust < 1 || !state.engineOn || state.throttle <= 0.001;
        var usedKepler = false;
        if (aeroBlend < 0.01 && effectivelyNoThrust) {
            usedKepler = stepKeplerVacuum(state, controls, dt, config);
        }

        if (!usedKepler) {
            // Equations of motion (Euler integration — used when thrust active or in atmosphere)
            const V = Math.max(state.speed, aeroBlend > 0.5 ? 10 : 1);

            // Thrust decomposition: nose direction relative to velocity vector
            const cosAlpha = Math.cos(state.alpha);
            const sinAlpha = Math.sin(state.alpha);
            const yawOff = state.yawOffset || 0;
            const cosYaw = Math.cos(yawOff);
            const sinYaw = Math.sin(yawOff);

            const thrustPrograde = thrust * cosAlpha * cosYaw;
            const thrustNormal   = thrust * sinAlpha;
            const thrustLateral  = thrust * cosAlpha * sinYaw;

            // dV/dt = (T_prograde - D)/m - g·sin(γ)
            const dV = (thrustPrograde - drag) / mass - g * Math.sin(state.gamma);

            // dγ/dt with centrifugal: V²/(R+alt) sustains orbit at ~7800 m/s,
            // negligible at aircraft speeds (~0.006 m/s² at 200 m/s sea level)
            const centrifugal = V * V / (R_EARTH + state.alt);
            const dGamma = (lift * Math.cos(state.roll) + thrustNormal) / (mass * V)
                         - (g - centrifugal) * Math.cos(state.gamma) / V;

            // dψ/dt with spherical transport rate for correct great-circle tracking
            const cosGamma = Math.cos(state.gamma);
            const dHeading_aero = (Math.abs(cosGamma) > 0.01) ?
                (lift * Math.sin(state.roll) + thrustLateral) / (mass * V * cosGamma) : 0;
            const dHeading_transport = (Math.abs(Math.cos(state.lat)) > 0.001) ?
                V * cosGamma * Math.sin(state.heading) * Math.tan(state.lat) / (R_EARTH + state.alt) : 0;
            const dHeading = dHeading_aero + dHeading_transport;

            // G-load
            state.g_load = W > 0 ? lift / W : 0;

            // Integrate
            state.speed += dV * dt;
            state.speed = aeroBlend > 0.5 ? Math.max(20, state.speed) : Math.max(0, state.speed);

            state.gamma += dGamma * dt;
            state.gamma = aeroBlend < 0.5 ? wrapAngle(state.gamma) : clamp(state.gamma, -80 * DEG, 80 * DEG);

            state.heading += dHeading * dt;
            state.heading = normalizeAngle(state.heading);

            updatePosition(state, dt);
        }

        // Vacuum yaw: RCS repoints the nose without changing velocity vector
        // Applied regardless of Kepler/Euler — always allow nose rotation in vacuum
        if (aeroBlend < 0.5 && controls.yaw) {
            state.yawOffset = (state.yawOffset || 0) + controls.yaw * config.max_pitch_rate * dt;
            state.yawOffset = wrapAngle(state.yawOffset);
        }
        // Decay yaw offset in atmosphere (aero forces realign nose with velocity)
        if (aeroBlend > 0.1 && state.yawOffset) {
            state.yawOffset *= Math.max(0, 1 - aeroBlend * 5 * dt);
            if (Math.abs(state.yawOffset) < 0.001) state.yawOffset = 0;
        }

        state.pitch = state.gamma + state.alpha;

        // Stall check (meaningful only with significant aero)
        if (aeroBlend > 0.3) {
            const stallSpeed = Math.sqrt(2 * W / (atm.density * config.wing_area * aero.cl_max));
            state.isStalling = state.speed < stallSpeed * 0.9;
        } else {
            state.isStalling = false;
        }

        // Overspeed: only meaningful in atmosphere where dynamic pressure creates structural stress
        state.isOverspeed = (aeroBlend > 0.5 && config.max_mach) ? (state.mach > config.max_mach) : false;

        // Always compute orbital telemetry — useful at any altitude
        const orbitalV = Math.sqrt(MU_EARTH / (R_EARTH + state.alt));
        state.orbitalVfrac = state.speed / orbitalV;
        state.dynamicPressure = q;
    }

    /**
     * Apply throttle control input
     */
    function applyThrottleControl(state, controls, dt) {
        if (controls.throttleUp) {
            state.throttle = Math.min(1.0, state.throttle + 0.5 * dt);
        }
        if (controls.throttleDown) {
            state.throttle = Math.max(0.0, state.throttle - 0.5 * dt);
        }
        if (controls.throttleSet !== undefined) {
            state.throttle = clamp(controls.throttleSet, 0, 1);
        }
    }

    /**
     * Apply flight control inputs (pitch, roll, yaw)
     * @param {number} aeroBlend - 0..1 aero blend factor (0 = vacuum, 1 = full aero)
     */
    function applyFlightControls(state, controls, dt, config, atm, mass, weight, qS, aeroBlend) {
        const aero = getAeroCoeffs(state, config);
        const inVacuum = (aeroBlend !== undefined && aeroBlend < 0.5);

        // Roll control — free 360° everywhere, no auto-rollout.
        // Tap arrow keys to set bank angle, hold for continuous roll.
        // Roll stays where you put it (like trim) for sustained G-turns.
        const rollCommand = (controls.roll || 0) * config.max_roll_rate;
        state.roll += rollCommand * dt;
        state.roll = wrapAngle(state.roll);

        // Pitch control → alpha
        // Pitch input changes alpha directly. No auto-trim-back — alpha stays
        // where the pilot puts it. Use T key for auto-trim to zero drift.
        if (controls.pitch) {
            const pitchRate = controls.pitch * config.max_pitch_rate;
            state.alpha += pitchRate * dt;
        }

        // Alpha wrap/clamp and G-limit
        if (inVacuum) {
            state.alpha = wrapAngle(state.alpha);
        } else {
            state.alpha = clamp(state.alpha, -10 * DEG, config.max_aoa);

            // Structural G limit in atmosphere
            const cl_at_alpha = getCL(state.alpha, config, aero);
            const lift_at_alpha = qS * Math.abs(cl_at_alpha);
            const g_commanded = lift_at_alpha / weight;

            if (g_commanded > config.max_g) {
                const cl_limit = config.max_g * weight / Math.max(qS, 1);
                state.alpha = clamp(state.alpha,
                    -cl_limit / config.cl_alpha * DEG,
                    cl_limit / config.cl_alpha * DEG);
            }
        }

        // Yaw control
        if (inVacuum) {
            // In vacuum: yaw directly rotates heading (RCS/reaction wheels)
            // Heading change is applied in stepFlight; just zero the sideslip angle
            state.yaw = 0;
        } else {
            // In atmosphere: small sideslip adjustments with damping
            if (controls.yaw) {
                state.yaw += controls.yaw * 10 * DEG * dt;
                state.yaw = clamp(state.yaw, -5 * DEG, 5 * DEG);
            } else {
                state.yaw *= (1 - 3.0 * dt);
            }
        }
    }

    /**
     * Analytic Kepler propagation for force-free vacuum flight.
     * Replaces Euler integration when aeroBlend ≈ 0 and thrust ≈ 0,
     * eliminating secular drift in orbital elements (inc, ecc, sma).
     *
     * Flow: geodetic → Cartesian → orbital elements → advance mean anomaly
     *       → new Cartesian → geodetic
     *
     * The physics engine uses a non-rotating frame, so geodetic↔Cartesian
     * conversion is direct (no GMST rotation needed).
     */
    function stepKeplerVacuum(state, controls, dt, config) {
        const V = state.speed;
        if (V < 100) return false; // too slow for meaningful orbit

        // --- Geodetic → Cartesian position ---
        const R = R_EARTH + state.alt;
        const cosLat = Math.cos(state.lat);
        const sinLat = Math.sin(state.lat);
        const cosLon = Math.cos(state.lon);
        const sinLon = Math.sin(state.lon);

        const px = R * cosLat * cosLon;
        const py = R * cosLat * sinLon;
        const pz = R * sinLat;

        // --- Velocity: (speed, heading, gamma) → Cartesian via ENU ---
        const cosGamma = Math.cos(state.gamma);
        const sinGamma = Math.sin(state.gamma);
        const cosHdg = Math.cos(state.heading);
        const sinHdg = Math.sin(state.heading);

        const vE = V * cosGamma * sinHdg;
        const vN = V * cosGamma * cosHdg;
        const vU = V * sinGamma;

        // ENU → Cartesian (non-rotating frame)
        const vx = -sinLon * vE + (-sinLat * cosLon) * vN + cosLat * cosLon * vU;
        const vy =  cosLon * vE + (-sinLat * sinLon) * vN + cosLat * sinLon * vU;
        const vz =                  cosLat * vN            + sinLat * vU;

        // --- Compute orbital elements ---
        const rMag = Math.sqrt(px*px + py*py + pz*pz);
        const vMag = Math.sqrt(vx*vx + vy*vy + vz*vz);
        if (rMag < 1000 || vMag < 10) return false;

        // Angular momentum h = r × v
        const hx = py*vz - pz*vy;
        const hy = pz*vx - px*vz;
        const hz = px*vy - py*vx;
        const hMag = Math.sqrt(hx*hx + hy*hy + hz*hz);
        if (hMag < 1e3) return false;

        // Energy → SMA
        const energy = 0.5 * vMag * vMag - MU_EARTH / rMag;
        if (energy >= 0) return false; // escape/parabolic — fall back to Euler

        const sma = -MU_EARTH / (2 * energy);
        if (sma <= 0 || !isFinite(sma)) return false;

        // Eccentricity vector
        const rdotv = px*vx + py*vy + pz*vz;
        const c1 = vMag*vMag - MU_EARTH / rMag;
        const ex = (c1*px - rdotv*vx) / MU_EARTH;
        const ey = (c1*py - rdotv*vy) / MU_EARTH;
        const ez = (c1*pz - rdotv*vz) / MU_EARTH;
        const ecc = Math.sqrt(ex*ex + ey*ey + ez*ez);
        if (ecc >= 0.99) return false; // near-parabolic

        // Inclination
        const inc = Math.acos(clamp(hz / hMag, -1, 1));

        // Node vector n = K × h = (-hy, hx, 0)
        const nx = -hy, ny = hx;
        const nMag = Math.sqrt(nx*nx + ny*ny);

        // RAAN
        let raan = 0;
        if (nMag > 1e-6) {
            raan = Math.acos(clamp(nx / nMag, -1, 1));
            if (ny < 0) raan = 2 * Math.PI - raan;
        }

        // Argument of periapsis
        let argPeri = 0;
        if (nMag > 1e-6 && ecc > 1e-6) {
            argPeri = Math.acos(clamp((nx*ex + ny*ey) / (nMag * ecc), -1, 1));
            if (ez < 0) argPeri = 2 * Math.PI - argPeri;
        }

        // True anomaly
        let trueAnomaly = 0;
        if (ecc > 1e-6) {
            trueAnomaly = Math.acos(clamp((ex*px + ey*py + ez*pz) / (ecc * rMag), -1, 1));
            if (rdotv < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
        } else {
            // Circular orbit: use argument of latitude
            if (nMag > 1e-6) {
                trueAnomaly = Math.acos(clamp((nx*px + ny*py) / (nMag * rMag), -1, 1));
                if (pz < 0) trueAnomaly = 2 * Math.PI - trueAnomaly;
            }
        }

        // --- Advance mean anomaly by dt ---
        const sinTA = Math.sin(trueAnomaly);
        const cosTA = Math.cos(trueAnomaly);
        const E0 = Math.atan2(Math.sqrt(1 - ecc*ecc) * sinTA, ecc + cosTA);
        let M0 = E0 - ecc * Math.sin(E0);
        if (M0 < 0) M0 += 2 * Math.PI;

        const n_mean = Math.sqrt(MU_EARTH / (sma * sma * sma));
        let M = (M0 + n_mean * dt) % (2 * Math.PI);
        if (M < 0) M += 2 * Math.PI;

        // Solve Kepler's equation (Newton-Raphson)
        let E = M;
        for (let iter = 0; iter < 20; iter++) {
            const dE = (E - ecc * Math.sin(E) - M) / (1 - ecc * Math.cos(E));
            E -= dE;
            if (Math.abs(dE) < 1e-12) break;
        }

        const cosE = Math.cos(E);
        const sinE = Math.sin(E);
        const nu = Math.atan2(Math.sqrt(1 - ecc*ecc) * sinE, cosE - ecc);
        const r_new = sma * (1 - ecc * cosE);

        // --- Perifocal → Cartesian ---
        const xP = r_new * Math.cos(nu);
        const yP = r_new * Math.sin(nu);
        const vCoeff = Math.sqrt(MU_EARTH / (sma * (1 - ecc*ecc)));
        const vxP = -vCoeff * Math.sin(nu);
        const vyP = vCoeff * (ecc + Math.cos(nu));

        const cosW = Math.cos(argPeri), sinW = Math.sin(argPeri);
        const cosI = Math.cos(inc), sinI = Math.sin(inc);
        const cosO = Math.cos(raan), sinO = Math.sin(raan);

        const Px = cosO*cosW - sinO*sinW*cosI;
        const Py = sinO*cosW + cosO*sinW*cosI;
        const Pz = sinW*sinI;
        const Qx = -cosO*sinW - sinO*cosW*cosI;
        const Qy = -sinO*sinW + cosO*cosW*cosI;
        const Qz = cosW*sinI;

        const nx2 = Px*xP + Qx*yP;
        const ny2 = Py*xP + Qy*yP;
        const nz2 = Pz*xP + Qz*yP;

        const nvx2 = Px*vxP + Qx*vyP;
        const nvy2 = Py*vxP + Qy*vyP;
        const nvz2 = Pz*vxP + Qz*vyP;

        // --- Cartesian → geodetic ---
        const R2 = Math.sqrt(nx2*nx2 + ny2*ny2 + nz2*nz2);
        const V2 = Math.sqrt(nvx2*nvx2 + nvy2*nvy2 + nvz2*nvz2);
        if (!isFinite(R2) || !isFinite(V2) || R2 < R_EARTH * 0.5) return false;

        const newLat = Math.asin(clamp(nz2 / R2, -1, 1));
        const newLon = Math.atan2(ny2, nx2);
        const newAlt = R2 - R_EARTH;

        // Velocity → ENU at new position
        const cosLat2 = Math.cos(newLat);
        const sinLat2 = Math.sin(newLat);
        const cosLon2 = Math.cos(newLon);
        const sinLon2 = Math.sin(newLon);

        const vE2 = -sinLon2*nvx2 + cosLon2*nvy2;
        const vN2 = -sinLat2*cosLon2*nvx2 - sinLat2*sinLon2*nvy2 + cosLat2*nvz2;
        const vU2 = cosLat2*cosLon2*nvx2 + cosLat2*sinLon2*nvy2 + sinLat2*nvz2;

        const newGamma = Math.asin(clamp(vU2 / V2, -1, 1));
        let newHeading = Math.atan2(vE2, vN2);
        if (newHeading < 0) newHeading += 2 * Math.PI;

        // --- Write back to state ---
        state.lat = newLat;
        state.lon = newLon;
        state.alt = newAlt;
        state.speed = V2;
        state.gamma = newGamma;
        state.heading = newHeading;
        state.pitch = state.gamma + state.alpha;

        // Note: yaw/roll/alpha controls are handled by applyFlightControls()
        // before Kepler runs, and vacuum yaw is applied after in stepFlight().

        return true; // success
    }

    /**
     * Update geodetic position based on speed and flight path
     */
    function updatePosition(state, dt) {
        const V = state.speed;
        const cosGamma = Math.cos(state.gamma);
        const sinGamma = Math.sin(state.gamma);
        const cosHeading = Math.cos(state.heading);
        const sinHeading = Math.sin(state.heading);
        const R = R_EARTH + state.alt;

        // dlat/dt = V·cos(γ)·cos(ψ) / (R + alt)
        state.lat += V * cosGamma * cosHeading / R * dt;

        // dlon/dt = V·cos(γ)·sin(ψ) / ((R + alt)·cos(lat))
        const cosLat = Math.cos(state.lat);
        if (Math.abs(cosLat) > 0.001) {
            state.lon += V * cosGamma * sinHeading / (R * cosLat) * dt;
        }

        // dalt/dt = V·sin(γ)
        state.alt += V * sinGamma * dt;
    }

    /**
     * Normalize angle to [0, 2π)
     */
    function normalizeAngle(a) {
        a = a % (2 * Math.PI);
        if (a < 0) a += 2 * Math.PI;
        return a;
    }

    /**
     * Wrap angle to [-π, π] (for free rotation without clamping)
     */
    function wrapAngle(a) {
        a = a % (2 * Math.PI);
        if (a > Math.PI) a -= 2 * Math.PI;
        if (a < -Math.PI) a += 2 * Math.PI;
        return a;
    }

    /**
     * Clamp value between min and max
     */
    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    /**
     * Compute bearing from point A to point B (great circle)
     */
    function bearing(lat1, lon1, lat2, lon2) {
        const dlon = lon2 - lon1;
        const y = Math.sin(dlon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
        return normalizeAngle(Math.atan2(y, x));
    }

    /**
     * Compute great circle distance between two points (meters)
     */
    function distance(lat1, lon1, lat2, lon2) {
        const dlat = lat2 - lat1;
        const dlon = lon2 - lon1;
        const a = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
                  Math.cos(lat1) * Math.cos(lat2) *
                  Math.sin(dlon / 2) * Math.sin(dlon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R_EARTH * c;
    }

    // Public API
    return {
        Phase,
        F16_CONFIG,
        SPACEPLANE_CONFIG,
        PROP_MODES,
        EDWARDS,
        DEG,
        RAD,
        G,
        R_EARTH,
        MU_EARTH,
        createAircraftState,
        step,
        getMass,
        getThrust,
        getGravity,
        getAeroBlendFactor,
        getPropulsionMode,
        bearing,
        distance,
        normalizeAngle,
        clamp,
    };
})();
