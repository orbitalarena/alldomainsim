/**
 * Burn Manager
 *
 * Manages scheduled burns, fuel tracking, and burn execution
 */

class BurnManager {
    constructor(fuelBudget) {
        this.fuelBudget = fuelBudget;
        this.fuelRemaining = fuelBudget;
        this.pendingBurns = [];
        this.executedBurns = [];
    }

    /**
     * Schedule a burn for later execution
     * @param {number} time - Simulation time to execute burn (seconds)
     * @param {Object} dv_ric - {R, I, C} delta-V in m/s
     * @returns {Object} Scheduled burn object
     */
    scheduleBurn(time, dv_ric) {
        const dv_mag = Math.sqrt(dv_ric.R**2 + dv_ric.I**2 + dv_ric.C**2);

        const burn = {
            id: Date.now(),
            scheduledTime: time,
            dv_ric: { ...dv_ric },
            dv_mag: dv_mag,
            status: 'pending'
        };

        this.pendingBurns.push(burn);
        this.pendingBurns.sort((a, b) => a.scheduledTime - b.scheduledTime);

        return burn;
    }

    /**
     * Cancel a pending burn
     * @param {number} burnId - ID of burn to cancel
     * @returns {boolean} True if burn was cancelled
     */
    cancelBurn(burnId) {
        const idx = this.pendingBurns.findIndex(b => b.id === burnId);
        if (idx >= 0) {
            this.pendingBurns.splice(idx, 1);
            return true;
        }
        return false;
    }

    /**
     * Check for burns to execute at current time
     * @param {number} currentTime - Current simulation time
     * @returns {Array} Burns to execute
     */
    getBurnsToExecute(currentTime) {
        const toExecute = [];

        while (this.pendingBurns.length > 0 &&
               this.pendingBurns[0].scheduledTime <= currentTime) {
            const burn = this.pendingBurns.shift();
            burn.executedTime = currentTime;
            burn.status = 'executing';
            toExecute.push(burn);
        }

        return toExecute;
    }

    /**
     * Record a burn as executed
     * @param {Object} burn - Burn that was executed
     * @param {boolean} success - Whether burn succeeded
     */
    recordExecution(burn, success) {
        if (success) {
            this.fuelRemaining -= burn.dv_mag;
            burn.status = 'completed';
            burn.fuelAfter = this.fuelRemaining;
        } else {
            burn.status = 'failed';
        }
        this.executedBurns.push(burn);
    }

    /**
     * Check if a burn is within fuel budget
     * @param {Object} dv_ric - {R, I, C} delta-V in m/s
     * @returns {boolean}
     */
    canExecuteBurn(dv_ric) {
        const dv_mag = Math.sqrt(dv_ric.R**2 + dv_ric.I**2 + dv_ric.C**2);
        return dv_mag <= this.fuelRemaining;
    }

    /**
     * Get total delta-V used
     * @returns {number} Delta-V used in m/s
     */
    getDeltaVUsed() {
        return this.fuelBudget - this.fuelRemaining;
    }

    /**
     * Get fuel status
     * @returns {Object}
     */
    getFuelStatus() {
        return {
            budget: this.fuelBudget,
            remaining: this.fuelRemaining,
            used: this.fuelBudget - this.fuelRemaining,
            percentRemaining: (this.fuelRemaining / this.fuelBudget) * 100
        };
    }

    /**
     * Calculate CW targeting solution for intercept
     * Uses the closed-form CW solution for radial burn targeting
     * @param {Object} r0_ric - Current relative position {R, I, C}
     * @param {number} tof - Time of flight in seconds
     * @param {number} n - Mean motion (rad/s)
     * @returns {Object} {dv1_ric, dv2_ric, total_dv, valid}
     */
    static calculateCWIntercept(r0_ric, tof, n) {
        const nT = n * tof;
        const c = Math.cos(nT);
        const s = Math.sin(nT);

        // For single radial burn targeting to zero in-track at time T:
        // I(T) = 6*(s - nT)*R0 + I0 + (2*(c-1)/n)*dvR
        // Setting I(T) = 0 and solving for dvR:
        const denom = 2 * (c - 1);

        if (Math.abs(denom) < 1e-10) {
            return { valid: false, reason: 'Near-singular at full period' };
        }

        const dvR = -n * (r0_ric.I + 6 * (s - nT) * r0_ric.R) / denom;

        // Predict position at T
        const R_at_T = (4 - 3*c) * r0_ric.R + (s/n) * dvR;
        const I_at_T = 6*(s - nT)*r0_ric.R + r0_ric.I + (2*(c-1)/n)*dvR;

        return {
            valid: true,
            dv1_ric: { R: dvR, I: 0, C: 0 },
            dv2_ric: { R: 0, I: 0, C: 0 },
            total_dv: Math.abs(dvR),
            predicted_R: R_at_T,
            predicted_I: I_at_T
        };
    }

    /**
     * Calculate simple radial formula for half-period transfers
     * Rule of thumb: 13.1 m/s radial = 1 degree over 12 hours at GEO
     * @param {Object} r0_ric - Current relative position {R, I, C}
     * @param {number} n - Mean motion (rad/s)
     * @returns {Object} {dv_ric, total_dv}
     */
    static calculateSimpleRadial(r0_ric, n) {
        // At half period: I(T) = I0 - 4*dvR/n
        // For I(T) = 0: dvR = I0 * n / 4
        const dvR = r0_ric.I * n / 4;

        return {
            valid: true,
            dv_ric: { R: dvR, I: 0, C: 0 },
            total_dv: Math.abs(dvR),
            formula: 'dvR = I0 * n / 4'
        };
    }

    /**
     * Calculate phasing maneuver for longer transfers
     * @param {Object} r0_ric - Current relative position {R, I, C}
     * @param {number} tof - Time of flight in seconds
     * @param {number} n - Mean motion (rad/s)
     * @param {number} v_circ - Circular orbit velocity (m/s)
     * @param {number} radius - Orbital radius (m)
     * @returns {Object} {dv1_ric, dv2_ric, total_dv}
     */
    static calculatePhasing(r0_ric, tof, n, v_circ, radius) {
        // In-track separation in radians
        const delta_theta = Math.abs(r0_ric.I) / radius;

        // Phasing formula: dv_total = v * |delta_theta| / (3 * TOF * n)
        const dv_total = v_circ * delta_theta / (3 * tof * n);

        // Direction: if chase behind (I0 < 0), need to speed up
        const sign = (r0_ric.I < 0) ? -1 : 1;

        return {
            valid: true,
            dv1_ric: { R: 0, I: sign * dv_total / 2, C: 0 },
            dv2_ric: { R: 0, I: -sign * dv_total / 2, C: 0 },
            total_dv: dv_total,
            delta_theta_deg: delta_theta * 180 / Math.PI
        };
    }

    /**
     * Reset fuel to initial budget
     */
    reset() {
        this.fuelRemaining = this.fuelBudget;
        this.pendingBurns = [];
        this.executedBurns = [];
    }

    /**
     * Get summary of all burns
     * @returns {Object}
     */
    getBurnSummary() {
        const totalExecuted = this.executedBurns.reduce((sum, b) => sum + b.dv_mag, 0);
        const totalPending = this.pendingBurns.reduce((sum, b) => sum + b.dv_mag, 0);

        return {
            executed: this.executedBurns.length,
            pending: this.pendingBurns.length,
            totalDvExecuted: totalExecuted,
            totalDvPending: totalPending,
            fuelRemaining: this.fuelRemaining
        };
    }
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BurnManager;
}
