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
        cd0_gear: 0.025,         // with gear down
        cd0_flaps: 0.008,        // additional flap drag
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
        brake_decel: 4.0,         // m/s² ground braking
        ground_friction: 0.03,    // rolling friction coefficient
        idle_thrust_frac: 0.05,   // fraction of mil thrust at idle
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
        cd0: 0.018,  cd0_gear: 0.025,  cd0_flaps: 0.008,
        oswald: 0.80,  cl_max: 1.5,  cl_max_flaps: 1.9,  cl_alpha: 0.07,
        cd0_hypersonic: 0.040,       // higher base drag at Mach 5+
        cl_alpha_hypersonic: 0.03,   // reduced lift slope at hypersonic

        // AIR mode (Mach 0-2): air-breathing turbofan with density lapse
        thrust_mil: 90000,   thrust_ab: 160000,  // N
        tsfc_mil: 0.022,     tsfc_ab: 0.058,

        // HYPERSONIC mode (Mach 2-10): scramjet-like, no density lapse, works everywhere
        thrust_hypersonic: 400000,  // N (flat, no lapse)

        // ROCKET mode (Mach 10+): massive thrust for orbit insertion
        thrust_rocket: 2000000,  // N (2 MN — dramatic kick)

        // Structural
        max_g: 6.0,  min_g: -2.0,
        max_roll_rate: 180 * DEG,  max_pitch_rate: 20 * DEG,
        max_aoa: 30 * DEG,
        service_ceiling: Infinity,

        // Ground ops
        v_rotate: 85,  v_approach: 80,
        corner_speed: 200,
        gear_transition_time: 4,  brake_decel: 3.5,
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
     * Determine propulsion mode for spaceplane
     * Uses manual toggle (state.forcedPropMode) — no auto-selection
     * @returns {string} 'AIR', 'HYPERSONIC', or 'ROCKET'
     */
    function getPropulsionMode(state, config, atm) {
        if (!config.isSpaceplane) return 'AIR';

        // Manual mode selection
        if (state.forcedPropMode) return state.forcedPropMode;

        return 'AIR'; // default
    }

    /**
     * Get thrust for spaceplane multi-mode propulsion
     */
    function getSpaceplaneThrust(state, config, atm) {
        if (!state.engineOn) return { thrust: 0, sfc: 0, mode: 'OFF' };

        const mode = getPropulsionMode(state, config, atm);
        state.propulsionMode = mode;

        let thrust;

        if (mode === 'ROCKET') {
            // Rocket: 2 MN constant, no atmospheric lapse. Dramatic kick.
            thrust = state.throttle * config.thrust_rocket;
            return { thrust, sfc: 0, mode };
        }

        if (mode === 'HYPERSONIC') {
            // Hypersonic: 400 kN flat, no density lapse. Works everywhere.
            thrust = state.throttle * config.thrust_hypersonic;
            return { thrust, sfc: 0, mode };
        }

        // AIR mode: air-breathing with density lapse
        const abThreshold = 0.85;
        const thrustLapse = Math.pow(atm.density / Atmosphere.SEA_LEVEL_DENSITY, 0.7);

        if (state.throttle > abThreshold) {
            const abFrac = (state.throttle - abThreshold) / (1.0 - abThreshold);
            thrust = config.thrust_mil + abFrac * (config.thrust_ab - config.thrust_mil);
        } else if (state.throttle > 0.05) {
            const milFrac = (state.throttle - 0.05) / (abThreshold - 0.05);
            thrust = config.idle_thrust_frac * config.thrust_mil +
                     milFrac * (1.0 - config.idle_thrust_frac) * config.thrust_mil;
        } else {
            thrust = config.idle_thrust_frac * config.thrust_mil;
        }

        thrust *= thrustLapse;
        return { thrust, sfc: 0, mode };
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
     * Compute available thrust at altitude
     * Thrust lapse: T = T_sl * (rho/rho_sl)^0.7
     */
    function getThrust(state, config, atm) {
        if (!state.engineOn) return { thrust: 0, sfc: 0 };

        const thrustLapse = Math.pow(atm.density / Atmosphere.SEA_LEVEL_DENSITY, 0.7);
        const abThreshold = 0.85;

        let thrust, sfc;
        if (state.throttle > abThreshold) {
            // Afterburner region: interpolate from mil to full AB
            const abFrac = (state.throttle - abThreshold) / (1.0 - abThreshold);
            thrust = config.thrust_mil + abFrac * (config.thrust_ab - config.thrust_mil);
            sfc = config.tsfc_mil + abFrac * (config.tsfc_ab - config.tsfc_mil);
        } else if (state.throttle > 0.05) {
            // Military power range
            const milFrac = (state.throttle - 0.05) / (abThreshold - 0.05);
            thrust = config.idle_thrust_frac * config.thrust_mil +
                     milFrac * (1.0 - config.idle_thrust_frac) * config.thrust_mil;
            sfc = config.tsfc_mil;
        } else {
            // Idle
            thrust = config.idle_thrust_frac * config.thrust_mil;
            sfc = config.tsfc_mil;
        }

        thrust *= thrustLapse;

        // No fuel = no thrust
        if (state.fuel <= 0) {
            thrust = 0;
            sfc = 0;
        }

        return { thrust, sfc };
    }

    /**
     * Compute aerodynamic coefficients
     */
    function getAeroCoeffs(state, config) {
        const cd0_base = state.gearDown ? config.cd0_gear : config.cd0;
        const cd0 = cd0_base + (state.flapsDown ? config.cd0_flaps : 0);
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
        const g = config.isSpaceplane ? getGravity(state.alt) : G;
        const weight = mass * g;
        const qS = atm.dynamicPressure(state.speed) * config.wing_area; // q * S

        // Gear transition
        if (state.gearTransition > 0) {
            state.gearTransition -= dt;
            if (state.gearTransition <= 0) state.gearTransition = 0;
        }

        // Phase-dependent physics
        if (state.phase === Phase.PARKED || state.phase === Phase.LANDED) {
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
        const groundAlt = EDWARDS.alt; // simplified: flat ground at runway elevation
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
     * Ground (parked/landed) state
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

        // Transition to taxi if moving
        if (state.engineOn && state.speed > 1) {
            state.phase = Phase.TAXI;
        }
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
     * Supports both fighter (constant G, atmosphere-only) and spaceplane
     * (inverse-square gravity, centrifugal term, aero blend, multi-mode thrust)
     */
    function stepFlight(state, controls, dt, config, atm, mass, weight, qS) {
        const isSpaceplane = config.isSpaceplane;

        // Compute aero blend factor early — needed by applyFlightControls
        const q = atm.dynamicPressure(state.speed);
        const aeroBlend = isSpaceplane ? getAeroBlendFactor(q) : 1.0;

        // Apply control inputs (pass aeroBlend for vacuum rotation freedom)
        applyThrottleControl(state, controls, dt);
        applyFlightControls(state, controls, dt, config, atm, mass, weight, qS, aeroBlend);

        // Gravity model
        const g = isSpaceplane ? getGravity(state.alt) : G;
        const W = mass * g;

        // Aerodynamic forces with blend factor for spaceplane
        const aero = getAeroCoeffs(state, config);

        // Hypersonic aero coefficient adjustments for spaceplane
        let effectiveConfig = config;
        if (isSpaceplane && state.mach > 5) {
            // Blend to hypersonic coefficients above Mach 5
            const hyperBlend = Math.min((state.mach - 5) / 3, 1.0); // fully hypersonic by Mach 8
            effectiveConfig = Object.assign({}, config, {
                cl_alpha: config.cl_alpha * (1 - hyperBlend) + config.cl_alpha_hypersonic * hyperBlend,
            });
            aero.cd0 = aero.cd0 * (1 - hyperBlend) + config.cd0_hypersonic * hyperBlend;
        }

        // Compute lift coefficient from current alpha
        const cl = getCL(state.alpha, effectiveConfig, aero);
        const cd = getCD(cl, config, aero, state.mach);

        const lift = qS * cl * aeroBlend;
        const drag = qS * cd * aeroBlend;

        // Thrust
        let thrust;
        if (isSpaceplane) {
            const thrustResult = getSpaceplaneThrust(state, config, atm);
            thrust = thrustResult.thrust;
        } else {
            thrust = getThrust(state, config, atm).thrust;
        }

        // Equations of motion
        const V = Math.max(state.speed, isSpaceplane ? 1 : 10);

        // dV/dt = (T·cos(α) - D)/m - g·sin(γ)
        const dV = (thrust * Math.cos(state.alpha) - drag) / mass - g * Math.sin(state.gamma);

        // dγ/dt with centrifugal acceleration for spaceplane
        let dGamma;
        if (isSpaceplane) {
            // centrifugal = V²/(R_EARTH + alt) — supports orbit when V≈7800 m/s
            const centrifugal = V * V / (R_EARTH + state.alt);
            dGamma = (lift * Math.cos(state.roll)) / (mass * V)
                   - (g - centrifugal) * Math.cos(state.gamma) / V;
        } else {
            dGamma = (lift * Math.cos(state.roll) - W * Math.cos(state.gamma)) / (mass * V);
        }

        // dψ/dt = L·sin(φ) / (m·V·cos(γ))
        const cosGamma = Math.cos(state.gamma);
        const dHeading = (Math.abs(cosGamma) > 0.01) ?
            (lift * Math.sin(state.roll)) / (mass * V * cosGamma) : 0;

        // G-load calculation
        state.g_load = W > 0 ? lift / W : 0;

        // Integrate
        state.speed += dV * dt;

        // Speed floor: no minimum for spaceplane in low-aero regime
        if (isSpaceplane) {
            if (aeroBlend > 0.5) {
                state.speed = Math.max(20, state.speed);
            } else {
                state.speed = Math.max(0, state.speed);
            }
        } else {
            state.speed = Math.max(20, state.speed);
        }

        state.gamma += dGamma * dt;
        // Gamma clamp: removed entirely in vacuum for free rotation
        if (isSpaceplane && aeroBlend < 0.5) {
            state.gamma = wrapAngle(state.gamma);
        } else {
            state.gamma = clamp(state.gamma, -80 * DEG, 80 * DEG);
        }

        state.heading += dHeading * dt;
        // In vacuum, yaw input directly rotates heading (RCS/reaction wheels)
        if (isSpaceplane && aeroBlend < 0.5 && controls.yaw) {
            state.heading += controls.yaw * config.max_pitch_rate * dt;
        }
        state.heading = normalizeAngle(state.heading);

        // Update body pitch to approximately track gamma + alpha
        state.pitch = state.gamma + state.alpha;

        // Update geodetic position
        updatePosition(state, dt);

        // Stall check (only meaningful with significant aero)
        if (aeroBlend > 0.3) {
            const stallSpeed = Math.sqrt(2 * W / (atm.density * config.wing_area * aero.cl_max));
            state.isStalling = state.speed < stallSpeed * 0.9;
        } else {
            state.isStalling = false;
        }

        // Overspeed check: disabled for spaceplane
        state.isOverspeed = isSpaceplane ? false : (state.mach > 2.05);

        // Spaceplane: compute orbital velocity fraction for UI
        if (isSpaceplane) {
            const orbitalV = Math.sqrt(MU_EARTH / (R_EARTH + state.alt));
            state.orbitalVfrac = state.speed / orbitalV;
            state.dynamicPressure = q;
        }
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

        // Roll control
        const rollCommand = (controls.roll || 0) * config.max_roll_rate;
        const rollDiff = rollCommand * dt;
        state.roll += rollDiff;
        // Roll damping when no input (disabled in vacuum — no atmosphere to damp)
        if (!controls.roll && !inVacuum) {
            state.roll *= (1 - 2.0 * dt); // decay toward wings-level
        }
        // Roll clamp: removed in vacuum (full 360° rotation)
        if (inVacuum) {
            // Wrap roll to [-π, π]
            state.roll = wrapAngle(state.roll);
        } else {
            state.roll = clamp(state.roll, -80 * DEG, 80 * DEG);
        }

        // Pitch control → alpha → G-load
        if (controls.pitch) {
            // Pitch input changes alpha
            const pitchRate = controls.pitch * config.max_pitch_rate;
            state.alpha += pitchRate * dt;
        } else if (!inVacuum) {
            // Trim to ~2° AoA for level flight (disabled in vacuum)
            const trimAlpha = 2 * DEG;
            state.alpha += (trimAlpha - state.alpha) * 1.5 * dt;
        }

        if (inVacuum) {
            // In vacuum: no alpha clamp, no G-limit — free body orientation
            // Wrap alpha to [-π, π]
            state.alpha = wrapAngle(state.alpha);
        } else {
            // Clamp alpha and enforce G limits in atmosphere
            state.alpha = clamp(state.alpha, -10 * DEG, config.max_aoa);

            // Available G at current speed
            const cl_at_alpha = getCL(state.alpha, config, aero);
            const lift_at_alpha = qS * Math.abs(cl_at_alpha);
            const g_commanded = lift_at_alpha / weight;

            // Structural G limit
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
        getSpaceplaneThrust,
        bearing,
        distance,
        normalizeAngle,
        clamp,
    };
})();
