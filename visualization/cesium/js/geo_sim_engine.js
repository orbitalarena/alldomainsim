/**
 * GEO Simulation Engine
 *
 * Real-time propagation using Clohessy-Wiltshire equations
 * Supports state history, rewind, burn preview, and orientation control
 */

class GeoSimEngine {
    constructor(initialState) {
        // Physical constants
        this.MU = initialState.metadata.earth_mu || 3.986004418e14;
        this.n = initialState.metadata.geo_mean_motion;
        this.geoRadius = initialState.metadata.geo_radius_m;
        this.v_geo = initialState.metadata.geo_velocity_ms || Math.sqrt(this.MU / this.geoRadius);

        // Earth rotation rate (rad/s) for ECI to ECEF conversion
        this.EARTH_OMEGA = 7.2921159e-5;

        // Store initial state for reset
        this.initialState = initialState;

        // Initialize satellite states
        this.chase = {
            pos: [...initialState.chase.position_eci_m],
            vel: [...initialState.chase.velocity_eci_ms],
            name: initialState.chase.name,
            model: initialState.chase.model,
            color: initialState.chase.color
        };

        this.target = {
            pos: [...initialState.target.position_eci_m],
            vel: [...initialState.target.velocity_eci_ms],
            name: initialState.target.name,
            model: initialState.target.model,
            color: initialState.target.color
        };

        // Simulation state
        this.simTime = 0;
        this.fuelRemaining = initialState.burn_budget_ms;
        this.fuelBudget = initialState.burn_budget_ms;

        // Chase orientation: 'nadir', 'target', or 'custom'
        this.chaseOrientation = 'target';
        this.customOrientation = { theta: 0, phi: 0 }; // radians, theta=pitch in R-I plane, phi=yaw toward C

        // State history for rewind (stored at regular intervals)
        this.stateHistory = [];
        this.stateHistoryInterval = 1.0; // seconds between snapshots
        this.lastHistoryTime = 0;
        this.maxHistoryLength = 100000; // ~27 hours at 1s intervals

        // Burn history with time tags
        this.burnHistory = [];

        // Visualization history
        this.chaseECIHistory = [];
        this.chaseECEFHistory = [];
        this.targetECIHistory = [];
        this.targetECEFHistory = [];
        this.relativeTrailHistory = [];

        // Record initial state
        this.saveStateSnapshot();
        this.recordVisualizationState();
    }

    /**
     * Save a state snapshot for rewind capability
     */
    saveStateSnapshot() {
        this.stateHistory.push({
            time: this.simTime,
            chase: {
                pos: [...this.chase.pos],
                vel: [...this.chase.vel]
            },
            target: {
                pos: [...this.target.pos],
                vel: [...this.target.vel]
            },
            fuelRemaining: this.fuelRemaining,
            burnCount: this.burnHistory.length
        });

        // Limit history size
        if (this.stateHistory.length > this.maxHistoryLength) {
            this.stateHistory.shift();
        }

        this.lastHistoryTime = this.simTime;
    }

    /**
     * Record state for visualization trails
     */
    recordVisualizationState() {
        const posECEF_chase = this.eciToECEF(this.chase.pos);
        const posECEF_target = this.eciToECEF(this.target.pos);

        this.chaseECIHistory.push([...this.chase.pos]);
        this.targetECIHistory.push([...this.target.pos]);
        this.chaseECEFHistory.push(posECEF_chase);
        this.targetECEFHistory.push(posECEF_target);

        // Store RIC position for relative trail
        const ric = RICFrame.computeRelativePosition(this.chase, this.target);
        this.relativeTrailHistory.push({
            time: this.simTime,
            R: ric.R,
            I: ric.I,
            C: ric.C
        });

        // Limit visualization history
        const maxVizPoints = 10000;
        if (this.chaseECIHistory.length > maxVizPoints) {
            this.chaseECIHistory.shift();
            this.targetECIHistory.shift();
            this.chaseECEFHistory.shift();
            this.targetECEFHistory.shift();
            this.relativeTrailHistory.shift();
        }
    }

    /**
     * Propagate using RK4 for accurate orbits
     */
    propagateRK4(state, dt) {
        const mu = this.MU;
        const newState = { pos: [...state.pos], vel: [...state.vel] };

        const deriv = (pos, vel) => {
            const r = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
            const r3 = r * r * r;
            return [
                vel[0], vel[1], vel[2],
                -mu * pos[0] / r3,
                -mu * pos[1] / r3,
                -mu * pos[2] / r3
            ];
        };

        const k1 = deriv(state.pos, state.vel);
        const pos2 = state.pos.map((p, i) => p + 0.5 * dt * k1[i]);
        const vel2 = state.vel.map((v, i) => v + 0.5 * dt * k1[i + 3]);
        const k2 = deriv(pos2, vel2);

        const pos3 = state.pos.map((p, i) => p + 0.5 * dt * k2[i]);
        const vel3 = state.vel.map((v, i) => v + 0.5 * dt * k2[i + 3]);
        const k3 = deriv(pos3, vel3);

        const pos4 = state.pos.map((p, i) => p + dt * k3[i]);
        const vel4 = state.vel.map((v, i) => v + dt * k3[i + 3]);
        const k4 = deriv(pos4, vel4);

        newState.pos = state.pos.map((p, i) =>
            p + (dt / 6) * (k1[i] + 2*k2[i] + 2*k3[i] + k4[i])
        );
        newState.vel = state.vel.map((v, i) =>
            v + (dt / 6) * (k1[i+3] + 2*k2[i+3] + 2*k3[i+3] + k4[i+3])
        );

        return newState;
    }

    /**
     * Step the simulation forward
     */
    step(dt) {
        const newChase = this.propagateRK4(this.chase, dt);
        const newTarget = this.propagateRK4(this.target, dt);

        this.chase.pos = newChase.pos;
        this.chase.vel = newChase.vel;
        this.target.pos = newTarget.pos;
        this.target.vel = newTarget.vel;

        this.simTime += dt;

        // Save state snapshot at intervals
        if (this.simTime - this.lastHistoryTime >= this.stateHistoryInterval) {
            this.saveStateSnapshot();
        }
    }

    /**
     * Rewind to a specific time
     * @param {number} targetTime - Time to rewind to
     * @returns {boolean} True if successful
     */
    rewindTo(targetTime) {
        if (targetTime < 0 || targetTime > this.simTime) {
            return false;
        }

        // Find closest snapshot at or before target time
        let snapshotIdx = -1;
        for (let i = this.stateHistory.length - 1; i >= 0; i--) {
            if (this.stateHistory[i].time <= targetTime) {
                snapshotIdx = i;
                break;
            }
        }

        if (snapshotIdx < 0) {
            return false;
        }

        const snapshot = this.stateHistory[snapshotIdx];

        // Restore state
        this.chase.pos = [...snapshot.chase.pos];
        this.chase.vel = [...snapshot.chase.vel];
        this.target.pos = [...snapshot.target.pos];
        this.target.vel = [...snapshot.target.vel];
        this.fuelRemaining = snapshot.fuelRemaining;
        this.simTime = snapshot.time;

        // Remove future state history
        this.stateHistory = this.stateHistory.slice(0, snapshotIdx + 1);

        // Remove burns that happened after this time
        const burnsToKeep = this.burnHistory.filter(b => b.time <= targetTime);
        this.burnHistory = burnsToKeep;

        // Trim visualization history to match
        this.trimVisualizationHistoryTo(targetTime);

        // Propagate forward to exact target time if needed
        const timeDiff = targetTime - this.simTime;
        if (timeDiff > 0.001) {
            this.step(timeDiff);
        }

        this.lastHistoryTime = this.simTime;

        return true;
    }

    /**
     * Trim visualization history to a specific time
     */
    trimVisualizationHistoryTo(targetTime) {
        // Find index based on relative trail timestamps
        let cutIdx = this.relativeTrailHistory.length;
        for (let i = this.relativeTrailHistory.length - 1; i >= 0; i--) {
            if (this.relativeTrailHistory[i].time <= targetTime) {
                cutIdx = i + 1;
                break;
            }
        }

        this.chaseECIHistory = this.chaseECIHistory.slice(0, cutIdx);
        this.targetECIHistory = this.targetECIHistory.slice(0, cutIdx);
        this.chaseECEFHistory = this.chaseECEFHistory.slice(0, cutIdx);
        this.targetECEFHistory = this.targetECEFHistory.slice(0, cutIdx);
        this.relativeTrailHistory = this.relativeTrailHistory.slice(0, cutIdx);
    }

    /**
     * Apply a delta-V burn to chase satellite
     * @param {Object} dv_ric - {R: m/s, I: m/s, C: m/s} in RIC frame
     * @returns {boolean} True if burn was executed
     */
    applyBurn(dv_ric) {
        const dv_mag = Math.sqrt(dv_ric.R**2 + dv_ric.I**2 + dv_ric.C**2);

        if (dv_mag > this.fuelRemaining) {
            console.warn(`Insufficient fuel: need ${dv_mag.toFixed(2)} m/s, have ${this.fuelRemaining.toFixed(2)} m/s`);
            return false;
        }

        // Convert RIC to ECI using target frame
        const dv_eci = RICFrame.ricToECI(dv_ric, this.target);

        // Apply to chase velocity
        this.chase.vel[0] += dv_eci[0];
        this.chase.vel[1] += dv_eci[1];
        this.chase.vel[2] += dv_eci[2];

        // Update fuel
        this.fuelRemaining -= dv_mag;

        // Record burn with time tag
        this.burnHistory.push({
            time: this.simTime,
            dv_ric: { ...dv_ric },
            dv_eci: [...dv_eci],
            dv_mag: dv_mag,
            fuelAfter: this.fuelRemaining
        });

        // Save state snapshot after burn
        this.saveStateSnapshot();

        console.log(`Burn executed at T+${this.simTime.toFixed(1)}s: R=${dv_ric.R.toFixed(2)}, I=${dv_ric.I.toFixed(2)}, C=${dv_ric.C.toFixed(2)} m/s`);

        return true;
    }

    /**
     * Preview a burn - propagate forward to see trajectory
     * @param {Object} dv_ric - Proposed burn {R, I, C} in m/s
     * @param {number} duration - Preview duration in seconds
     * @param {number} stepSize - Time step for preview points
     * @returns {Object} Preview data with trajectories in multiple frames
     */
    previewBurn(dv_ric, duration = 86400, stepSize = 300) {
        // Create copies of current state
        let chase = { pos: [...this.chase.pos], vel: [...this.chase.vel] };
        let target = { pos: [...this.target.pos], vel: [...this.target.vel] };

        // Apply proposed burn to chase copy
        const dv_eci = RICFrame.ricToECI(dv_ric, target);
        chase.vel[0] += dv_eci[0];
        chase.vel[1] += dv_eci[1];
        chase.vel[2] += dv_eci[2];

        const preview = {
            dv_ric: { ...dv_ric },
            dv_mag: Math.sqrt(dv_ric.R**2 + dv_ric.I**2 + dv_ric.C**2),
            startTime: this.simTime,
            duration: duration,
            chase_eci: [],
            chase_ecef: [],
            target_eci: [],
            target_ecef: [],
            ric: [],  // Chase relative to target
            range: []
        };

        let t = 0;
        while (t <= duration) {
            // Record positions
            const theta = (this.simTime + t) * this.EARTH_OMEGA;
            const c = Math.cos(-theta);
            const s = Math.sin(-theta);

            preview.chase_eci.push([...chase.pos]);
            preview.target_eci.push([...target.pos]);

            preview.chase_ecef.push([
                chase.pos[0] * c - chase.pos[1] * s,
                chase.pos[0] * s + chase.pos[1] * c,
                chase.pos[2]
            ]);
            preview.target_ecef.push([
                target.pos[0] * c - target.pos[1] * s,
                target.pos[0] * s + target.pos[1] * c,
                target.pos[2]
            ]);

            // RIC position
            const ric = RICFrame.computeRelativePosition(chase, target);
            preview.ric.push({ time: t, R: ric.R, I: ric.I, C: ric.C });

            // Range
            const range = RICFrame.computeRange(chase, target);
            preview.range.push({ time: t, range: range });

            // Propagate both satellites
            chase = this.propagateRK4(chase, stepSize);
            target = this.propagateRK4(target, stepSize);
            t += stepSize;
        }

        // Find closest approach
        let minRange = Infinity;
        let minRangeTime = 0;
        for (const r of preview.range) {
            if (r.range < minRange) {
                minRange = r.range;
                minRangeTime = r.time;
            }
        }
        preview.closestApproach = { range: minRange, time: minRangeTime };

        return preview;
    }

    /**
     * Preview with NO burn (natural motion)
     */
    previewNoBurn(duration = 86400, stepSize = 300) {
        return this.previewBurn({ R: 0, I: 0, C: 0 }, duration, stepSize);
    }

    /**
     * Convert ECI position to ECEF
     */
    eciToECEF(posECI) {
        const theta = this.simTime * this.EARTH_OMEGA;
        const c = Math.cos(-theta);
        const s = Math.sin(-theta);

        return [
            posECI[0] * c - posECI[1] * s,
            posECI[0] * s + posECI[1] * c,
            posECI[2]
        ];
    }

    /**
     * Get current RIC state
     */
    getRICState() {
        const ric = RICFrame.computeRelativePosition(this.chase, this.target);
        const ricVel = RICFrame.computeRelativeVelocity(this.chase, this.target, this.n);
        const range = RICFrame.computeRange(this.chase, this.target);
        const rangeRate = RICFrame.computeRangeRate(this.chase, this.target);

        return {
            R: ric.R,
            I: ric.I,
            C: ric.C,
            vR: ricVel.R,
            vI: ricVel.I,
            vC: ricVel.C,
            range: range,
            rangeRate: rangeRate
        };
    }

    /**
     * Set chase satellite orientation mode
     * @param {string} mode - 'nadir', 'target', or 'custom'
     * @param {Object} customAngles - {theta, phi} in degrees for custom mode
     */
    setChaseOrientation(mode, customAngles = null) {
        this.chaseOrientation = mode;
        if (mode === 'custom' && customAngles) {
            this.customOrientation.theta = customAngles.theta * Math.PI / 180;
            this.customOrientation.phi = customAngles.phi * Math.PI / 180;
        }
    }

    /**
     * Get chase satellite orientation quaternion
     * Returns direction and up vectors for Cesium
     */
    getChaseOrientationVectors() {
        const chasePos = this.chase.pos;
        const targetPos = this.target.pos;

        // Compute RIC frame for chase
        const frame = RICFrame.computeFrame(this.chase);

        let direction, up;

        switch (this.chaseOrientation) {
            case 'nadir':
                // Point at Earth center (negative radial)
                direction = [-frame.R[0], -frame.R[1], -frame.R[2]];
                // Up is in-track direction
                up = [...frame.I];
                break;

            case 'target':
                // Point at target satellite
                const toTarget = [
                    targetPos[0] - chasePos[0],
                    targetPos[1] - chasePos[1],
                    targetPos[2] - chasePos[2]
                ];
                const mag = Math.sqrt(toTarget[0]**2 + toTarget[1]**2 + toTarget[2]**2);
                direction = [toTarget[0]/mag, toTarget[1]/mag, toTarget[2]/mag];
                // Up is roughly radial
                up = [...frame.R];
                break;

            case 'custom':
                // Custom orientation in RIC frame
                // theta: rotation in R-I plane (pitch), phi: rotation toward C (yaw)
                const ct = Math.cos(this.customOrientation.theta);
                const st = Math.sin(this.customOrientation.theta);
                const cp = Math.cos(this.customOrientation.phi);
                const sp = Math.sin(this.customOrientation.phi);

                // Direction in RIC: start pointing along I (in-track), rotate by theta in R-I, then phi toward C
                const dirRIC = [
                    st * cp,           // R component
                    ct * cp,           // I component
                    sp                 // C component
                ];

                // Convert to ECI
                direction = [
                    dirRIC[0]*frame.R[0] + dirRIC[1]*frame.I[0] + dirRIC[2]*frame.C[0],
                    dirRIC[0]*frame.R[1] + dirRIC[1]*frame.I[1] + dirRIC[2]*frame.C[1],
                    dirRIC[0]*frame.R[2] + dirRIC[1]*frame.I[2] + dirRIC[2]*frame.C[2]
                ];

                // Up is radial
                up = [...frame.R];
                break;

            default:
                direction = [...frame.I];
                up = [...frame.R];
        }

        return { direction, up };
    }

    // ========================================
    // Newton-Raphson Intercept Solver
    // Ported from src/physics/nonlinear_rendezvous.cpp
    // Uses full nonlinear dynamics with STM propagation
    // ========================================

    /**
     * Compute gravitational acceleration
     */
    computeAcceleration(pos) {
        const r = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
        const r3 = r * r * r;
        return [
            -this.MU * pos[0] / r3,
            -this.MU * pos[1] / r3,
            -this.MU * pos[2] / r3
        ];
    }

    /**
     * Compute gravity gradient matrix (3x3) for STM propagation
     */
    computeGravityGradient(pos) {
        const r = Math.sqrt(pos[0]**2 + pos[1]**2 + pos[2]**2);
        const r2 = r * r;
        const r3 = r2 * r;
        const mu = this.MU;

        // G_ij = -mu/r^3 * (delta_ij - 3*r_i*r_j/r^2)
        return [
            [-mu / r3 * (1.0 - 3.0 * pos[0] * pos[0] / r2),
             -mu / r3 * (-3.0 * pos[0] * pos[1] / r2),
             -mu / r3 * (-3.0 * pos[0] * pos[2] / r2)],
            [-mu / r3 * (-3.0 * pos[1] * pos[0] / r2),
             -mu / r3 * (1.0 - 3.0 * pos[1] * pos[1] / r2),
             -mu / r3 * (-3.0 * pos[1] * pos[2] / r2)],
            [-mu / r3 * (-3.0 * pos[2] * pos[0] / r2),
             -mu / r3 * (-3.0 * pos[2] * pos[1] / r2),
             -mu / r3 * (1.0 - 3.0 * pos[2] * pos[2] / r2)]
        ];
    }

    /**
     * Create identity 6x6 STM
     */
    createIdentitySTM() {
        const phi = [];
        for (let i = 0; i < 6; i++) {
            phi[i] = [];
            for (let j = 0; j < 6; j++) {
                phi[i][j] = (i === j) ? 1.0 : 0.0;
            }
        }
        return phi;
    }

    /**
     * RK4 step for state + STM (extended state)
     * Extended state: [x, y, z, vx, vy, vz] + 6x6 STM
     */
    rk4StepExtended(pos, vel, phi, dt) {
        const computeDerivs = (p, v, stm) => {
            const acc = this.computeAcceleration(p);
            const G = this.computeGravityGradient(p);

            // STM derivative: Phi_dot = A * Phi
            // A = [0(3x3), I(3x3)]
            //     [G(3x3), 0(3x3)]
            const phiDot = [];
            for (let i = 0; i < 6; i++) {
                phiDot[i] = [];
                for (let j = 0; j < 6; j++) {
                    let sum = 0;
                    for (let k = 0; k < 6; k++) {
                        // A matrix elements
                        let A_ik = 0;
                        if (i < 3 && k >= 3 && k - 3 === i) A_ik = 1.0;  // Upper right identity
                        if (i >= 3 && k < 3) A_ik = G[i - 3][k];         // Lower left gravity gradient
                        sum += A_ik * stm[k][j];
                    }
                    phiDot[i][j] = sum;
                }
            }

            return { dp: v, dv: acc, dPhi: phiDot };
        };

        const addState = (p, v, stm, dp, dv, dPhi, scale) => {
            const newP = [p[0] + scale * dp[0], p[1] + scale * dp[1], p[2] + scale * dp[2]];
            const newV = [v[0] + scale * dv[0], v[1] + scale * dv[1], v[2] + scale * dv[2]];
            const newPhi = [];
            for (let i = 0; i < 6; i++) {
                newPhi[i] = [];
                for (let j = 0; j < 6; j++) {
                    newPhi[i][j] = stm[i][j] + scale * dPhi[i][j];
                }
            }
            return { p: newP, v: newV, phi: newPhi };
        };

        // RK4 stages
        const k1 = computeDerivs(pos, vel, phi);

        const s2 = addState(pos, vel, phi, k1.dp, k1.dv, k1.dPhi, 0.5 * dt);
        const k2 = computeDerivs(s2.p, s2.v, s2.phi);

        const s3 = addState(pos, vel, phi, k2.dp, k2.dv, k2.dPhi, 0.5 * dt);
        const k3 = computeDerivs(s3.p, s3.v, s3.phi);

        const s4 = addState(pos, vel, phi, k3.dp, k3.dv, k3.dPhi, dt);
        const k4 = computeDerivs(s4.p, s4.v, s4.phi);

        // Combine
        const newPos = [
            pos[0] + dt / 6 * (k1.dp[0] + 2*k2.dp[0] + 2*k3.dp[0] + k4.dp[0]),
            pos[1] + dt / 6 * (k1.dp[1] + 2*k2.dp[1] + 2*k3.dp[1] + k4.dp[1]),
            pos[2] + dt / 6 * (k1.dp[2] + 2*k2.dp[2] + 2*k3.dp[2] + k4.dp[2])
        ];
        const newVel = [
            vel[0] + dt / 6 * (k1.dv[0] + 2*k2.dv[0] + 2*k3.dv[0] + k4.dv[0]),
            vel[1] + dt / 6 * (k1.dv[1] + 2*k2.dv[1] + 2*k3.dv[1] + k4.dv[1]),
            vel[2] + dt / 6 * (k1.dv[2] + 2*k2.dv[2] + 2*k3.dv[2] + k4.dv[2])
        ];
        const newPhi = [];
        for (let i = 0; i < 6; i++) {
            newPhi[i] = [];
            for (let j = 0; j < 6; j++) {
                newPhi[i][j] = phi[i][j] + dt / 6 * (
                    k1.dPhi[i][j] + 2*k2.dPhi[i][j] + 2*k3.dPhi[i][j] + k4.dPhi[i][j]
                );
            }
        }

        return { pos: newPos, vel: newVel, phi: newPhi };
    }

    /**
     * Propagate state with STM for a given time
     */
    propagateWithSTM(pos, vel, totalDt) {
        let phi = this.createIdentitySTM();
        let p = [...pos];
        let v = [...vel];

        const stepSize = 60.0;  // 60 second integration step
        let t = 0;

        while (t < totalDt) {
            const step = Math.min(stepSize, totalDt - t);
            const result = this.rk4StepExtended(p, v, phi, step);
            p = result.pos;
            v = result.vel;
            phi = result.phi;
            t += step;
        }

        return { pos: p, vel: v, phi: phi };
    }

    /**
     * Propagate target satellite (state only, no STM)
     */
    propagateState(pos, vel, totalDt) {
        let p = [...pos];
        let v = [...vel];

        const stepSize = 60.0;
        let t = 0;

        while (t < totalDt) {
            const step = Math.min(stepSize, totalDt - t);
            const result = this.propagateRK4({ pos: p, vel: v }, step);
            p = result.pos;
            v = result.vel;
            t += step;
        }

        return { pos: p, vel: v };
    }

    /**
     * Solve 3x3 linear system using Gaussian elimination with partial pivoting
     */
    solve3x3(A, b) {
        // Make copies
        const M = A.map(row => [...row]);
        const r = [...b];

        // Forward elimination with pivoting
        for (let k = 0; k < 3; k++) {
            // Find pivot
            let maxRow = k;
            let maxVal = Math.abs(M[k][k]);
            for (let i = k + 1; i < 3; i++) {
                if (Math.abs(M[i][k]) > maxVal) {
                    maxVal = Math.abs(M[i][k]);
                    maxRow = i;
                }
            }

            // Swap rows
            [M[k], M[maxRow]] = [M[maxRow], M[k]];
            [r[k], r[maxRow]] = [r[maxRow], r[k]];

            if (Math.abs(M[k][k]) < 1e-14) {
                return null;  // Singular
            }

            // Eliminate
            for (let i = k + 1; i < 3; i++) {
                const factor = M[i][k] / M[k][k];
                for (let j = k; j < 3; j++) {
                    M[i][j] -= factor * M[k][j];
                }
                r[i] -= factor * r[k];
            }
        }

        // Back substitution
        const x = [0, 0, 0];
        for (let i = 2; i >= 0; i--) {
            x[i] = r[i];
            for (let j = i + 1; j < 3; j++) {
                x[i] -= M[i][j] * x[j];
            }
            x[i] /= M[i][i];
        }

        return x;
    }

    /**
     * Generate initial guess for delta-V using simple geometry
     */
    generateInitialGuess(chasePos, chaseVel, targetFinalPos, tof) {
        // Simple initial guess: point velocity change toward target
        const dr = [
            targetFinalPos[0] - chasePos[0],
            targetFinalPos[1] - chasePos[1],
            targetFinalPos[2] - chasePos[2]
        ];
        const dist = Math.sqrt(dr[0]**2 + dr[1]**2 + dr[2]**2);

        // Estimate required velocity change magnitude
        const vCirc = Math.sqrt(this.MU / Math.sqrt(chasePos[0]**2 + chasePos[1]**2 + chasePos[2]**2));
        const dvMag = dist / tof * 0.5;  // Simple estimate

        // Direction: mostly along velocity for in-track, some toward target
        const velMag = Math.sqrt(chaseVel[0]**2 + chaseVel[1]**2 + chaseVel[2]**2);

        return [
            dvMag * dr[0] / dist * 0.3 + dvMag * chaseVel[0] / velMag * 0.1,
            dvMag * dr[1] / dist * 0.3 + dvMag * chaseVel[1] / velMag * 0.1,
            dvMag * dr[2] / dist * 0.3
        ];
    }

    /**
     * Newton-Raphson intercept solver
     * Solves for delta-V to reach target position at time tof
     *
     * @param {Object} targetRIC - Target RIC position {R, I, C} in meters
     * @param {number} tof - Time of flight in seconds
     * @param {Object} options - { matchVelocity: bool, maxIter: int, tol: float }
     */
    solveInterceptBurn(targetRIC, tof, options = {}) {
        const matchVelocity = options.matchVelocity !== false;
        const maxIter = options.maxIter || 50;
        const posTol = options.posTol || 1.0;  // 1 meter
        const velTol = options.velTol || 0.01; // 0.01 m/s

        // Current chase and target ECI states
        const chasePos = [...this.chase.pos];
        const chaseVel = [...this.chase.vel];
        const targetPos = [...this.target.pos];
        const targetVel = [...this.target.vel];

        // Propagate target to final time
        const targetFinal = this.propagateState(targetPos, targetVel, tof);

        // If targetRIC is specified, adjust the final target position
        // targetRIC is in RIC frame of the target at final time
        let finalTargetPos = [...targetFinal.pos];

        if (targetRIC.R !== 0 || targetRIC.I !== 0 || targetRIC.C !== 0) {
            // Compute RIC frame at target final position
            const frame = RICFrame.computeFrame({ pos: targetFinal.pos, vel: targetFinal.vel });

            // Add offset in RIC frame
            finalTargetPos = [
                targetFinal.pos[0] + targetRIC.R * frame.R[0] + targetRIC.I * frame.I[0] + targetRIC.C * frame.C[0],
                targetFinal.pos[1] + targetRIC.R * frame.R[1] + targetRIC.I * frame.I[1] + targetRIC.C * frame.C[1],
                targetFinal.pos[2] + targetRIC.R * frame.R[2] + targetRIC.I * frame.I[2] + targetRIC.C * frame.C[2]
            ];
        }

        // Initial guess for delta-V
        let dv = this.generateInitialGuess(chasePos, chaseVel, finalTargetPos, tof);

        let converged = false;
        let iterations = 0;
        let posErr = Infinity;

        // Newton-Raphson iteration
        for (let iter = 0; iter < maxIter; iter++) {
            iterations = iter + 1;

            // Apply delta-V to chase
            const velPostBurn = [
                chaseVel[0] + dv[0],
                chaseVel[1] + dv[1],
                chaseVel[2] + dv[2]
            ];

            // Propagate with STM
            const result = this.propagateWithSTM(chasePos, velPostBurn, tof);

            // Compute residuals (position error)
            const residuals = [
                result.pos[0] - finalTargetPos[0],
                result.pos[1] - finalTargetPos[1],
                result.pos[2] - finalTargetPos[2]
            ];

            posErr = Math.sqrt(residuals[0]**2 + residuals[1]**2 + residuals[2]**2);

            // Check convergence
            if (posErr < posTol) {
                converged = true;
                break;
            }

            // Extract Jacobian from STM: dr/dv = Phi_rv (rows 0-2, cols 3-5)
            const J = [
                [result.phi[0][3], result.phi[0][4], result.phi[0][5]],
                [result.phi[1][3], result.phi[1][4], result.phi[1][5]],
                [result.phi[2][3], result.phi[2][4], result.phi[2][5]]
            ];

            // Solve J * correction = residuals
            const correction = this.solve3x3(J, residuals);

            if (!correction) {
                return {
                    valid: false,
                    error: `Singular Jacobian at iteration ${iter}`,
                    dv1_ric: null,
                    dv2_ric: null,
                    total_dv: Infinity
                };
            }

            // Line search with backtracking
            let alpha = 1.0;
            for (let ls = 0; ls < 10; ls++) {
                const dvNew = [
                    dv[0] - alpha * correction[0],
                    dv[1] - alpha * correction[1],
                    dv[2] - alpha * correction[2]
                ];

                const velTest = [
                    chaseVel[0] + dvNew[0],
                    chaseVel[1] + dvNew[1],
                    chaseVel[2] + dvNew[2]
                ];

                const resultTest = this.propagateState(chasePos, velTest, tof);
                const resTest = [
                    resultTest.pos[0] - finalTargetPos[0],
                    resultTest.pos[1] - finalTargetPos[1],
                    resultTest.pos[2] - finalTargetPos[2]
                ];

                const errTest = resTest[0]**2 + resTest[1]**2 + resTest[2]**2;
                const errCurr = residuals[0]**2 + residuals[1]**2 + residuals[2]**2;

                if (errTest < errCurr) {
                    dv = dvNew;
                    break;
                }
                alpha *= 0.5;
            }
        }

        if (!converged) {
            return {
                valid: false,
                error: `Did not converge after ${maxIter} iterations (pos err: ${(posErr/1000).toFixed(2)} km)`,
                dv1_ric: null,
                dv2_ric: null,
                total_dv: Infinity,
                iterations: iterations
            };
        }

        // Convert ECI delta-V to RIC
        const dv1_ric = RICFrame.eciToRIC(dv, this.target);
        const dv1_mag = Math.sqrt(dv[0]**2 + dv[1]**2 + dv[2]**2);

        // Compute second burn if matching velocity
        let dv2_ric = { R: 0, I: 0, C: 0 };
        let dv2_mag = 0;

        if (matchVelocity) {
            // Propagate chase with burn 1 to final time
            const velPostBurn = [chaseVel[0] + dv[0], chaseVel[1] + dv[1], chaseVel[2] + dv[2]];
            const chaserFinal = this.propagateState(chasePos, velPostBurn, tof);

            // Second burn = target_velocity - chaser_velocity
            const dv2_eci = [
                targetFinal.vel[0] - chaserFinal.vel[0],
                targetFinal.vel[1] - chaserFinal.vel[1],
                targetFinal.vel[2] - chaserFinal.vel[2]
            ];

            dv2_ric = RICFrame.eciToRIC(dv2_eci, { pos: targetFinal.pos, vel: targetFinal.vel });
            dv2_mag = Math.sqrt(dv2_eci[0]**2 + dv2_eci[1]**2 + dv2_eci[2]**2);
        }

        const total_dv = dv1_mag + dv2_mag;
        const hasFuel = total_dv <= this.fuelRemaining;

        // Get current RIC state for display
        const currentRIC = RICFrame.computeRelativePosition(this.chase, this.target);

        return {
            valid: true,
            converged: true,
            hasFuel: hasFuel,
            dv1_ric: dv1_ric,
            dv1_mag: dv1_mag,
            dv1_eci: dv,
            dv2_ric: dv2_ric,
            dv2_mag: dv2_mag,
            total_dv: total_dv,
            tof: tof,
            targetRIC: { R: targetRIC.R || 0, I: targetRIC.I || 0, C: targetRIC.C || 0 },
            currentRIC: currentRIC,
            iterations: iterations,
            finalPosErr: posErr,
            method: matchVelocity ? 'newton_raphson_2burn' : 'newton_raphson_intercept'
        };
    }

    /**
     * Sweep TOF to find optimal intercept time
     */
    sweepInterceptTOF(targetRIC, tofMin = 3600, tofMax = 86400, steps = 50) {
        const solutions = [];
        let bestSolution = null;
        let bestDV = Infinity;

        for (let i = 0; i <= steps; i++) {
            const tof = tofMin + (tofMax - tofMin) * i / steps;
            const sol = this.solveInterceptBurn(targetRIC, tof, { maxIter: 30 });

            if (sol.valid && sol.total_dv < 500) {
                solutions.push({
                    tof: tof,
                    total_dv: sol.total_dv,
                    dv1_mag: sol.dv1_mag,
                    dv2_mag: sol.dv2_mag,
                    iterations: sol.iterations
                });

                if (sol.total_dv < bestDV) {
                    bestDV = sol.total_dv;
                    bestSolution = sol;
                }
            }
        }

        return {
            best: bestSolution,
            all: solutions
        };
    }

    /**
     * Preview an intercept maneuver
     */
    previewIntercept(targetRIC, tof, stepSize = 60) {
        const solution = this.solveInterceptBurn(targetRIC, tof);

        if (!solution.valid) {
            return {
                valid: false,
                error: solution.error
            };
        }

        // Preview using ECI delta-V
        const dv_ric = solution.dv1_ric;
        const preview = this.previewBurn(dv_ric, tof * 1.2, stepSize);

        return {
            valid: true,
            solution: solution,
            preview: preview,
            targetRIC: targetRIC,
            tof: tof
        };
    }

    /**
     * Get complete state
     */
    getState() {
        const ric = this.getRICState();

        return {
            simTime: this.simTime,
            chase: {
                pos: [...this.chase.pos],
                vel: [...this.chase.vel],
                posECEF: this.eciToECEF(this.chase.pos)
            },
            target: {
                pos: [...this.target.pos],
                vel: [...this.target.vel],
                posECEF: this.eciToECEF(this.target.pos)
            },
            ric: ric,
            fuelRemaining: this.fuelRemaining,
            fuelBudget: this.fuelBudget,
            burnCount: this.burnHistory.length,
            orientation: this.getChaseOrientationVectors()
        };
    }

    /**
     * Reset simulation to initial conditions
     */
    reset() {
        this.chase.pos = [...this.initialState.chase.position_eci_m];
        this.chase.vel = [...this.initialState.chase.velocity_eci_ms];
        this.target.pos = [...this.initialState.target.position_eci_m];
        this.target.vel = [...this.initialState.target.velocity_eci_ms];

        this.simTime = 0;
        this.fuelRemaining = this.initialState.burn_budget_ms;

        this.stateHistory = [];
        this.burnHistory = [];
        this.lastHistoryTime = 0;

        this.chaseECIHistory = [];
        this.chaseECEFHistory = [];
        this.targetECIHistory = [];
        this.targetECEFHistory = [];
        this.relativeTrailHistory = [];

        this.saveStateSnapshot();
        this.recordVisualizationState();
    }

    /**
     * Get burn history
     */
    getBurnHistory() {
        return this.burnHistory.map(b => ({
            time: b.time,
            dv_ric: { ...b.dv_ric },
            dv_mag: b.dv_mag
        }));
    }

    /**
     * Get time range available for rewind
     */
    getRewindRange() {
        if (this.stateHistory.length === 0) {
            return { min: 0, max: 0 };
        }
        return {
            min: this.stateHistory[0].time,
            max: this.stateHistory[this.stateHistory.length - 1].time
        };
    }
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GeoSimEngine;
}
