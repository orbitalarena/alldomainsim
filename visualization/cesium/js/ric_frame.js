/**
 * RIC Frame Utilities
 *
 * Port of src/targeting/ric_frame.cpp to JavaScript
 * RIC = Radial-Intrack-Crosstrack coordinate frame
 */

class RICFrame {
    /**
     * Compute RIC frame unit vectors from state vector
     * @param {Object} state - {pos: [x,y,z], vel: [x,y,z]} in ECI
     * @returns {Object} {R: [x,y,z], I: [x,y,z], C: [x,y,z]} unit vectors
     */
    static computeFrame(state) {
        const pos = state.pos;
        const vel = state.vel;

        // R = position / |position| (radial outward)
        const r_mag = Math.sqrt(pos[0]*pos[0] + pos[1]*pos[1] + pos[2]*pos[2]);
        const R = [pos[0]/r_mag, pos[1]/r_mag, pos[2]/r_mag];

        // h = r x v (angular momentum)
        const h = [
            pos[1]*vel[2] - pos[2]*vel[1],
            pos[2]*vel[0] - pos[0]*vel[2],
            pos[0]*vel[1] - pos[1]*vel[0]
        ];
        const h_mag = Math.sqrt(h[0]*h[0] + h[1]*h[1] + h[2]*h[2]);

        // C = h / |h| (cross-track, angular momentum direction)
        const C = [h[0]/h_mag, h[1]/h_mag, h[2]/h_mag];

        // I = C x R (in-track, completes right-handed system)
        const I = [
            C[1]*R[2] - C[2]*R[1],
            C[2]*R[0] - C[0]*R[2],
            C[0]*R[1] - C[1]*R[0]
        ];

        return { R, I, C };
    }

    /**
     * Compute relative position of chase w.r.t. target in RIC frame
     * @param {Object} chase - Chase state {pos: [x,y,z], vel: [x,y,z]}
     * @param {Object} target - Target state {pos: [x,y,z], vel: [x,y,z]}
     * @returns {Object} {R: meters, I: meters, C: meters}
     */
    static computeRelativePosition(chase, target) {
        // Vector from target to chase in ECI
        const rel_eci = [
            chase.pos[0] - target.pos[0],
            chase.pos[1] - target.pos[1],
            chase.pos[2] - target.pos[2]
        ];

        // Transform to target's RIC frame
        const frame = this.computeFrame(target);

        return {
            R: rel_eci[0]*frame.R[0] + rel_eci[1]*frame.R[1] + rel_eci[2]*frame.R[2],
            I: rel_eci[0]*frame.I[0] + rel_eci[1]*frame.I[1] + rel_eci[2]*frame.I[2],
            C: rel_eci[0]*frame.C[0] + rel_eci[1]*frame.C[1] + rel_eci[2]*frame.C[2]
        };
    }

    /**
     * Compute relative velocity in rotating RIC frame
     * @param {Object} chase - Chase state
     * @param {Object} target - Target state
     * @param {number} n - Mean motion (rad/s)
     * @returns {Object} {R: m/s, I: m/s, C: m/s}
     */
    static computeRelativeVelocity(chase, target, n) {
        // Relative velocity in ECI
        const rel_vel_eci = [
            chase.vel[0] - target.vel[0],
            chase.vel[1] - target.vel[1],
            chase.vel[2] - target.vel[2]
        ];

        const frame = this.computeFrame(target);

        // Project into RIC (inertial measurement)
        const v_inertial = {
            R: rel_vel_eci[0]*frame.R[0] + rel_vel_eci[1]*frame.R[1] + rel_vel_eci[2]*frame.R[2],
            I: rel_vel_eci[0]*frame.I[0] + rel_vel_eci[1]*frame.I[1] + rel_vel_eci[2]*frame.I[2],
            C: rel_vel_eci[0]*frame.C[0] + rel_vel_eci[1]*frame.C[1] + rel_vel_eci[2]*frame.C[2]
        };

        // Get relative position for frame rotation correction
        const r_ric = this.computeRelativePosition(chase, target);

        // In rotating frame: v_rotating = v_inertial - omega x r
        // omega = (0, 0, n) in RIC, so omega x r = (-n*I, n*R, 0)
        return {
            R: v_inertial.R + n * r_ric.I,
            I: v_inertial.I - n * r_ric.R,
            C: v_inertial.C
        };
    }

    /**
     * Convert RIC vector to ECI
     * @param {Object} vec_ric - {R: number, I: number, C: number}
     * @param {Object} reference - Reference state for frame definition
     * @returns {Array} [x, y, z] in ECI
     */
    static ricToECI(vec_ric, reference) {
        const frame = this.computeFrame(reference);

        return [
            vec_ric.R*frame.R[0] + vec_ric.I*frame.I[0] + vec_ric.C*frame.C[0],
            vec_ric.R*frame.R[1] + vec_ric.I*frame.I[1] + vec_ric.C*frame.C[1],
            vec_ric.R*frame.R[2] + vec_ric.I*frame.I[2] + vec_ric.C*frame.C[2]
        ];
    }

    /**
     * Convert ECI vector to RIC
     * @param {Array} vec_eci - [x, y, z] in ECI
     * @param {Object} reference - Reference state for frame definition
     * @returns {Object} {R: number, I: number, C: number}
     */
    static eciToRIC(vec_eci, reference) {
        const frame = this.computeFrame(reference);

        return {
            R: vec_eci[0]*frame.R[0] + vec_eci[1]*frame.R[1] + vec_eci[2]*frame.R[2],
            I: vec_eci[0]*frame.I[0] + vec_eci[1]*frame.I[1] + vec_eci[2]*frame.I[2],
            C: vec_eci[0]*frame.C[0] + vec_eci[1]*frame.C[1] + vec_eci[2]*frame.C[2]
        };
    }

    /**
     * Compute range between two states
     * @param {Object} chase - Chase state
     * @param {Object} target - Target state
     * @returns {number} Range in meters
     */
    static computeRange(chase, target) {
        const dx = chase.pos[0] - target.pos[0];
        const dy = chase.pos[1] - target.pos[1];
        const dz = chase.pos[2] - target.pos[2];
        return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    /**
     * Compute range rate between two states
     * @param {Object} chase - Chase state
     * @param {Object} target - Target state
     * @returns {number} Range rate in m/s (positive = opening)
     */
    static computeRangeRate(chase, target) {
        const rel_pos = [
            chase.pos[0] - target.pos[0],
            chase.pos[1] - target.pos[1],
            chase.pos[2] - target.pos[2]
        ];

        const rel_vel = [
            chase.vel[0] - target.vel[0],
            chase.vel[1] - target.vel[1],
            chase.vel[2] - target.vel[2]
        ];

        const range = Math.sqrt(rel_pos[0]*rel_pos[0] + rel_pos[1]*rel_pos[1] + rel_pos[2]*rel_pos[2]);
        if (range < 1e-10) return 0.0;

        const dot = rel_pos[0]*rel_vel[0] + rel_pos[1]*rel_vel[1] + rel_pos[2]*rel_vel[2];
        return dot / range;
    }
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RICFrame;
}
