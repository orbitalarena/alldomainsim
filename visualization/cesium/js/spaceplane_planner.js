/**
 * Spaceplane Maneuver Planner Module
 * Provides maneuver node system: create/edit/delete nodes,
 * predicted orbit computation, burn time estimation, and burn execution.
 *
 * Enhanced: click-on-orbit node creation, real engine burn times,
 * per-component DV setting from dialog, auto-execute helpers.
 */
const SpaceplanePlanner = (function() {
    'use strict';

    const MU = 3.986004418e14;
    const R_EARTH = 6371000;
    const OMEGA_EARTH = 7.2921159e-5;

    // Maneuver nodes list
    let nodes = [];
    let selectedNodeIndex = -1;

    // Predicted orbit visualization
    let predictedOrbitPositions = [];

    // Engine params (set by LiveSimEngine from actual config)
    let _engineThrust = 500000;   // N — fallback
    let _engineMass = 15000;      // kg — fallback
    let _engineLabel = 'DEFAULT';

    // DV adjustment rate (m/s per call) — kept for legacy keyboard control
    const DV_STEP = 5;

    /**
     * Set engine parameters for burn time calculation.
     * Called by LiveSimEngine when dialog opens or propulsion mode changes.
     */
    function setEngineParams(thrust, mass, label) {
        _engineThrust = thrust || 500000;
        _engineMass = mass || 15000;
        _engineLabel = label || 'DEFAULT';
        // Re-compute burn time for current node if any
        if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length) {
            updateNodePrediction();
        }
    }

    /**
     * Create a maneuver node at the current position/time
     */
    function createNode(state, simTime) {
        if (!state || typeof SpaceplaneOrbital === 'undefined') return null;

        const eci = SpaceplaneOrbital.geodeticToECI(state, simTime);

        const node = _makeNode(simTime, eci.pos.slice(), eci.vel.slice());
        nodes.push(node);
        selectedNodeIndex = nodes.length - 1;
        updateNodePrediction();
        return node;
    }

    /**
     * Create a maneuver node at a future point on the orbit.
     * @param {object} state - current aircraft state
     * @param {number} simTime - current simulation time
     * @param {number} dt - time offset from now (seconds into the future)
     * @returns {object|null} the new node, or null on failure
     */
    function createNodeAtTime(state, simTime, dt) {
        if (!state || typeof SpaceplaneOrbital === 'undefined') return null;

        const eci = SpaceplaneOrbital.geodeticToECI(state, simTime);
        if (!eci || !eci.pos || !eci.vel) return null;

        // Propagate to future time on the orbit
        var futureECI;
        if (dt > 0.1) {
            futureECI = SpaceplaneOrbital.propagateKepler(eci.pos, eci.vel, dt);
            if (!futureECI || !futureECI.pos || !futureECI.vel) return null;
        } else {
            futureECI = { pos: eci.pos.slice(), vel: eci.vel.slice() };
        }

        const node = _makeNode(simTime + dt, futureECI.pos.slice(), futureECI.vel.slice());
        nodes.push(node);
        selectedNodeIndex = nodes.length - 1;
        updateNodePrediction();
        return node;
    }

    /**
     * Internal: create a bare node object
     */
    function _makeNode(simTime, eciPos, eciVel) {
        return {
            id: Date.now(),
            simTime: simTime,
            eciPos: eciPos,
            eciVel: eciVel,

            // Delta-V components in orbital frame
            dvPrograde: 0,
            dvNormal: 0,
            dvRadial: 0,

            // Derived (computed by updateNodePrediction)
            dv: 0,
            burnTime: 0,
            engineLabel: _engineLabel,
            postAP: null,
            postPE: null,
            timeToNode: 0,

            // Marker entity reference (managed by LiveSimEngine)
            _marker: null,
        };
    }

    /**
     * Set delta-V components directly (from dialog inputs)
     */
    function setNodeDV(prograde, normal, radial) {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) return;
        var node = nodes[selectedNodeIndex];
        node.dvPrograde = prograde || 0;
        node.dvNormal = normal || 0;
        node.dvRadial = radial || 0;
        updateNodePrediction();
    }

    /**
     * Delete the currently selected node
     */
    function deleteSelectedNode() {
        if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length) {
            var node = nodes[selectedNodeIndex];
            // Clean up marker entity if present
            if (node._marker && node._marker._viewer) {
                try { node._marker._viewer.entities.remove(node._marker); } catch(e) {}
            }
            nodes.splice(selectedNodeIndex, 1);
            selectedNodeIndex = nodes.length > 0 ? Math.min(selectedNodeIndex, nodes.length - 1) : -1;
            updateNodePrediction();
        }
    }

    /**
     * Delete a specific node by reference
     */
    function deleteNode(node) {
        var idx = nodes.indexOf(node);
        if (idx >= 0) {
            if (node._marker && node._marker._viewer) {
                try { node._marker._viewer.entities.remove(node._marker); } catch(e) {}
            }
            nodes.splice(idx, 1);
            if (selectedNodeIndex >= nodes.length) {
                selectedNodeIndex = nodes.length > 0 ? nodes.length - 1 : -1;
            }
            updateNodePrediction();
        }
    }

    /**
     * Adjust the selected node's delta-V by keyboard step
     */
    function adjustNodeDV(direction, multiplier) {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) return;

        const node = nodes[selectedNodeIndex];
        const step = DV_STEP * (multiplier || 1);

        switch (direction) {
            case 'prograde':    node.dvPrograde += step; break;
            case 'retrograde':  node.dvPrograde -= step; break;
            case 'normal':      node.dvNormal += step; break;
            case 'antinormal':  node.dvNormal -= step; break;
            case 'radial_in':   node.dvRadial -= step; break;
            case 'radial_out':  node.dvRadial += step; break;
            case 'increase':    node.dvPrograde += step; break;
            case 'decrease':    node.dvPrograde -= step; break;
        }

        updateNodePrediction();
    }

    /**
     * Adjust the selected node's execution time
     */
    function adjustNodeTime(dt) {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) return;
        nodes[selectedNodeIndex].simTime += dt;
        updateNodePrediction();
    }

    /**
     * Execute the selected maneuver node: apply delta-V impulse to the aircraft state
     */
    function executeNode(state, simTime) {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) return;
        if (!state || typeof SpaceplaneOrbital === 'undefined') return;

        const node = nodes[selectedNodeIndex];

        // Convert current state to ECI
        const eci = SpaceplaneOrbital.geodeticToECI(state, simTime);
        const pos = eci.pos;
        const vel = eci.vel;

        // Compute orbital frame at current position
        const frame = computeOrbitalFrame(pos, vel);

        // Compute delta-V in ECI
        const dvECI = [
            frame.prograde[0] * node.dvPrograde + frame.normal[0] * node.dvNormal + frame.radial[0] * node.dvRadial,
            frame.prograde[1] * node.dvPrograde + frame.normal[1] * node.dvNormal + frame.radial[1] * node.dvRadial,
            frame.prograde[2] * node.dvPrograde + frame.normal[2] * node.dvNormal + frame.radial[2] * node.dvRadial,
        ];

        // Apply delta-V to velocity
        const newVel = [vel[0] + dvECI[0], vel[1] + dvECI[1], vel[2] + dvECI[2]];

        const newVMag = SpaceplaneOrbital.vecMag(newVel);
        state.speed = newVMag;

        // Compute new flight path angle
        const rMag = SpaceplaneOrbital.vecMag(pos);
        const rUnit = SpaceplaneOrbital.vecScale(pos, 1 / rMag);
        const radialV = SpaceplaneOrbital.vecDot(newVel, rUnit);
        const horizontalV = Math.sqrt(newVMag * newVMag - radialV * radialV);
        state.gamma = Math.atan2(radialV, horizontalV);

        // Remove the executed node
        if (node._marker && node._marker._viewer) {
            try { node._marker._viewer.entities.remove(node._marker); } catch(e) {}
        }
        nodes.splice(selectedNodeIndex, 1);
        selectedNodeIndex = nodes.length > 0 ? Math.min(selectedNodeIndex, nodes.length - 1) : -1;
        predictedOrbitPositions = [];
        updateNodePrediction();
    }

    /**
     * Compute the burn direction vector in ECI for a given node.
     * Used by auto-execute to orient the spacecraft.
     * Returns normalized ECI vector, or null if dv is zero.
     */
    function getBurnDirectionECI(node) {
        if (!node || node.dv < 0.01) return null;
        var frame = computeOrbitalFrame(node.eciPos, node.eciVel);
        var dvECI = [
            frame.prograde[0] * node.dvPrograde + frame.normal[0] * node.dvNormal + frame.radial[0] * node.dvRadial,
            frame.prograde[1] * node.dvPrograde + frame.normal[1] * node.dvNormal + frame.radial[1] * node.dvRadial,
            frame.prograde[2] * node.dvPrograde + frame.normal[2] * node.dvNormal + frame.radial[2] * node.dvRadial,
        ];
        var mag = SpaceplaneOrbital.vecMag(dvECI);
        if (mag < 0.01) return null;
        return SpaceplaneOrbital.vecScale(dvECI, 1 / mag);
    }

    /**
     * Compute orbital reference frame (prograde, normal, radial)
     */
    function computeOrbitalFrame(pos, vel) {
        const O = SpaceplaneOrbital;
        const vMag = O.vecMag(vel);

        const prograde = vMag > 0 ? O.vecScale(vel, 1 / vMag) : [1, 0, 0];

        const h = O.vecCross(pos, vel);
        const hMag = O.vecMag(h);
        const normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];

        const radial = O.vecCross(prograde, normal);

        return { prograde, normal, radial };
    }

    /**
     * Update the predicted post-burn orbit for the selected node
     */
    function updateNodePrediction() {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) {
            predictedOrbitPositions = [];
            return;
        }

        const node = nodes[selectedNodeIndex];

        // Compute total dV
        node.dv = Math.sqrt(
            node.dvPrograde * node.dvPrograde +
            node.dvNormal * node.dvNormal +
            node.dvRadial * node.dvRadial
        );

        // Burn time from actual engine params
        node.burnTime = node.dv > 0 ? (node.dv * _engineMass / _engineThrust) : 0;
        node.engineLabel = _engineLabel;

        // Compute post-burn orbit
        const pos = node.eciPos;
        const vel = node.eciVel;
        const frame = computeOrbitalFrame(pos, vel);

        const dvECI = [
            frame.prograde[0] * node.dvPrograde + frame.normal[0] * node.dvNormal + frame.radial[0] * node.dvRadial,
            frame.prograde[1] * node.dvPrograde + frame.normal[1] * node.dvNormal + frame.radial[1] * node.dvRadial,
            frame.prograde[2] * node.dvPrograde + frame.normal[2] * node.dvNormal + frame.radial[2] * node.dvRadial,
        ];

        const newVel = [vel[0] + dvECI[0], vel[1] + dvECI[1], vel[2] + dvECI[2]];

        const postElems = SpaceplaneOrbital.computeOrbitalElements(pos, newVel);
        node.postAP = postElems.apoapsisAlt;
        node.postPE = postElems.periapsisAlt;

        // Generate predicted orbit polyline
        if (isFinite(postElems.eccentricity) && postElems.eccentricity < 1.0 &&
            isFinite(postElems.sma) && postElems.sma > 0) {
            const gmst = OMEGA_EARTH * node.simTime;
            predictedOrbitPositions = SpaceplaneOrbital.predictOrbitPath(postElems, 360, gmst);
        } else {
            predictedOrbitPositions = [];
        }
    }

    let plannerUpdateCounter = 0;
    const PLANNER_UPDATE_INTERVAL = 15;

    /**
     * Main update function called each frame
     */
    function update(state, simTime) {
        // Update time-to-node for all nodes
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].timeToNode = nodes[i].simTime - simTime;
        }

        // Re-compute prediction for selected node periodically
        if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length) {
            plannerUpdateCounter++;
            if (plannerUpdateCounter % PLANNER_UPDATE_INTERVAL === 0) {
                updateNodePrediction();
            }
        }
    }

    /**
     * Reset all state
     */
    function reset() {
        nodes = [];
        selectedNodeIndex = -1;
        predictedOrbitPositions = [];
    }

    // -----------------------------------------------------------------------
    // Hohmann Transfer Solver
    // -----------------------------------------------------------------------
    /**
     * Compute a two-impulse Hohmann-like transfer.
     * Uses the actual current radius and velocity (via vis-viva) rather than
     * assuming a circular orbit, so it works well from elliptical orbits too.
     * @param {number} currentSMA - current semi-major axis in meters
     * @param {number} targetAltKm - target circular orbit altitude in km
     * @param {number} currentRadius - actual current orbital radius in meters (optional, defaults to SMA)
     * @returns {{dv1, dv2, transferTime, a_transfer, valid}}
     */
    function computeHohmann(currentSMA, targetAltKm, currentRadius) {
        var r1 = currentRadius || currentSMA; // use actual radius at burn point
        var r2 = R_EARTH + targetAltKm * 1000;
        if (r1 <= 0 || r2 <= 0 || !isFinite(r1) || !isFinite(r2)) {
            return { dv1: 0, dv2: 0, transferTime: 0, a_transfer: 0, valid: false };
        }
        // Transfer ellipse from current radius to target radius
        var a_t = (r1 + r2) / 2;
        // Current velocity from vis-viva with actual SMA (handles elliptical orbits)
        var v_current = Math.sqrt(MU * (2 / r1 - 1 / currentSMA));
        // Required velocity for transfer ellipse at r1
        var v_transfer1 = Math.sqrt(MU * (2 / r1 - 1 / a_t));
        var dv1 = v_transfer1 - v_current;
        // At arrival (r2): circularize
        var v_circ2 = Math.sqrt(MU / r2);
        var v_transfer2 = Math.sqrt(MU * (2 / r2 - 1 / a_t));
        var dv2 = v_circ2 - v_transfer2;
        var transferTime = Math.PI * Math.sqrt(a_t * a_t * a_t / MU);
        return { dv1: dv1, dv2: dv2, transferTime: transferTime, a_transfer: a_t, valid: true };
    }

    // -----------------------------------------------------------------------
    // Lambert Solver (Universal Variable formulation)
    // -----------------------------------------------------------------------
    function _stumpffC(z) {
        if (Math.abs(z) < 1e-6) return 0.5 - z / 24.0 + z * z / 720.0;
        if (z > 0) return (1.0 - Math.cos(Math.sqrt(z))) / z;
        return (Math.cosh(Math.sqrt(-z)) - 1.0) / (-z);
    }

    function _stumpffS(z) {
        if (Math.abs(z) < 1e-6) return 1.0 / 6.0 - z / 120.0 + z * z / 5040.0;
        if (z > 0) {
            var sq = Math.sqrt(z);
            return (sq - Math.sin(sq)) / (z * sq);
        }
        var sq = Math.sqrt(-z);
        return (Math.sinh(sq) - sq) / (-z * sq);
    }

    /**
     * Solve Lambert's problem using universal variable formulation.
     * @param {number[]} r1 - departure position ECI [x,y,z] meters
     * @param {number[]} r2 - arrival position ECI [x,y,z] meters
     * @param {number} tof - time of flight in seconds
     * @param {boolean} shortWay - true for prograde/short transfer (<180 deg)
     * @returns {{v1: number[], v2: number[], valid: boolean}}
     */
    function solveLambert(r1, r2, tof, shortWay, mu_override) {
        var _mu = mu_override || MU;
        var O = SpaceplaneOrbital;
        var r1_mag = O.vecMag(r1);
        var r2_mag = O.vecMag(r2);

        if (r1_mag < 1e-6 || r2_mag < 1e-6 || tof <= 0) {
            return { v1: [0,0,0], v2: [0,0,0], valid: false };
        }

        var cos_theta = O.vecDot(r1, r2) / (r1_mag * r2_mag);
        cos_theta = Math.max(-1, Math.min(1, cos_theta));

        // Cross product z-component determines transfer direction
        var cz = r1[0] * r2[1] - r1[1] * r2[0];
        var theta;
        if (shortWay) {
            theta = (cz >= 0) ? Math.acos(cos_theta) : 2 * Math.PI - Math.acos(cos_theta);
        } else {
            theta = (cz < 0) ? Math.acos(cos_theta) : 2 * Math.PI - Math.acos(cos_theta);
        }

        var sin_theta = Math.sin(theta);
        var A = sin_theta * Math.sqrt(r1_mag * r2_mag / (1 - cos_theta));

        if (Math.abs(A) < 1e-14 * Math.sqrt(r1_mag * r2_mag)) {
            return { v1: [0,0,0], v2: [0,0,0], valid: false };
        }

        // y(z) function
        function y_func(z) {
            var Cz = _stumpffC(z);
            var Sz = _stumpffS(z);
            var sqrtCz = Math.sqrt(Math.abs(Cz));
            if (sqrtCz < 1e-30) return r1_mag + r2_mag;
            return r1_mag + r2_mag + A * (z * Sz - 1.0) / sqrtCz;
        }

        // tof(z) function
        function tof_func(z) {
            var Cz = _stumpffC(z);
            var Sz = _stumpffS(z);
            var y = y_func(z);
            if (y < 0 || Cz <= 0) return -1;
            var x = Math.sqrt(y / Cz);
            return (x * x * x * Sz + A * Math.sqrt(y)) / Math.sqrt(_mu);
        }

        // Newton-Raphson + bisection on z
        var z = 0.0;
        var z_low = -4 * Math.PI * Math.PI;
        var z_high = 4 * Math.PI * Math.PI * 4;

        // Ensure y > 0 at lower bound
        while (y_func(z_low) < 0 && z_low < z_high) {
            z_low += 0.1;
        }

        for (var iter = 0; iter < 200; iter++) {
            var y = y_func(z);
            if (y < 0) {
                z = (z + z_high) * 0.5;
                continue;
            }
            var Cz = _stumpffC(z);
            if (Cz <= 0) {
                z = (z + z_high) * 0.5;
                continue;
            }
            var x = Math.sqrt(y / Cz);
            var Sz = _stumpffS(z);
            var t_z = (x * x * x * Sz + A * Math.sqrt(y)) / Math.sqrt(_mu);

            var residual = t_z - tof;
            if (Math.abs(residual) < 1e-6) break;

            // Finite-difference derivative
            var dz = Math.max(1e-4, Math.abs(z) * 1e-6);
            var t_z2 = tof_func(z + dz);
            var dtdz = (t_z2 > 0) ? (t_z2 - t_z) / dz : 0;

            if (Math.abs(dtdz) > 1e-30) {
                var z_new = z - residual / dtdz;
                z_new = Math.max(z_low, Math.min(z_high, z_new));
                z = z_new;
            } else {
                if (residual > 0) z_high = z;
                else z_low = z;
                z = (z_low + z_high) * 0.5;
            }
        }

        // Final f, g, gdot
        var yf = y_func(z);
        if (yf < 0) return { v1: [0,0,0], v2: [0,0,0], valid: false };

        var f = 1.0 - yf / r1_mag;
        var g_dot = 1.0 - yf / r2_mag;
        var g = A * Math.sqrt(yf / _mu);

        if (Math.abs(g) < 1e-30) return { v1: [0,0,0], v2: [0,0,0], valid: false };

        // v1 = (r2 - f*r1) / g,  v2 = (gdot*r2 - r1) / g
        var v1 = [(r2[0] - f*r1[0])/g, (r2[1] - f*r1[1])/g, (r2[2] - f*r1[2])/g];
        var v2 = [(g_dot*r2[0] - r1[0])/g, (g_dot*r2[1] - r1[1])/g, (g_dot*r2[2] - r1[2])/g];

        return { v1: v1, v2: v2, valid: true };
    }

    /**
     * Compute intercept delta-V to reach a target entity.
     * @param {object} playerState - player flight state
     * @param {object} targetState - target entity state (must have _eci_pos, _eci_vel)
     * @param {number} simTime - current sim time
     * @param {number} tofSeconds - time of flight
     * @param {{r:number, i:number, c:number}} ricOffset - optional RIC offset in meters
     * @returns {{dvPro, dvNrm, dvRad, dvTotal, v1ECI, valid}}
     */
    function computeIntercept(playerState, targetState, simTime, tofSeconds, ricOffset) {
        var O = SpaceplaneOrbital;
        if (!playerState || !targetState) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        // Player ECI
        var playerECI = O.geodeticToECI(playerState, simTime);
        if (!playerECI || !playerECI.pos || !playerECI.vel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        // Target current ECI
        var tPos = targetState._eci_pos;
        var tVel = targetState._eci_vel;
        if (!tPos || !tVel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        // Propagate target to arrival time
        var tArrival = O.propagateKepler(tPos, tVel, tofSeconds);
        if (!tArrival || !tArrival.pos || !tArrival.vel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        var arrivalPos = tArrival.pos.slice();

        // Apply RIC offset if provided
        if (ricOffset && (ricOffset.r || ricOffset.i || ricOffset.c)) {
            var rMag = O.vecMag(tArrival.pos);
            var rHat = O.vecScale(tArrival.pos, 1 / rMag); // Radial
            var hVec = O.vecCross(tArrival.pos, tArrival.vel);
            var hMag = O.vecMag(hVec);
            var cHat = hMag > 0 ? O.vecScale(hVec, 1 / hMag) : [0, 0, 1]; // Cross-track
            var iHat = O.vecCross(cHat, rHat); // In-track

            arrivalPos[0] += rHat[0] * (ricOffset.r || 0) + iHat[0] * (ricOffset.i || 0) + cHat[0] * (ricOffset.c || 0);
            arrivalPos[1] += rHat[1] * (ricOffset.r || 0) + iHat[1] * (ricOffset.i || 0) + cHat[1] * (ricOffset.c || 0);
            arrivalPos[2] += rHat[2] * (ricOffset.r || 0) + iHat[2] * (ricOffset.i || 0) + cHat[2] * (ricOffset.c || 0);
        }

        // Solve Lambert
        var lambert = solveLambert(playerECI.pos, arrivalPos, tofSeconds, true);
        if (!lambert.valid) {
            // Try long-way
            lambert = solveLambert(playerECI.pos, arrivalPos, tofSeconds, false);
        }
        if (!lambert.valid) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        // Delta-V in ECI = lambert v1 - current velocity
        var dvECI = O.vecSub(lambert.v1, playerECI.vel);
        var dvTotal = O.vecMag(dvECI);

        // Project onto orbital frame
        var frame = computeOrbitalFrame(playerECI.pos, playerECI.vel);
        var dvPro = O.vecDot(dvECI, frame.prograde);
        var dvNrm = O.vecDot(dvECI, frame.normal);
        var dvRad = O.vecDot(dvECI, frame.radial);

        return { dvPro: dvPro, dvNrm: dvNrm, dvRad: dvRad, dvTotal: dvTotal, v1ECI: lambert.v1, valid: true };
    }

    // -----------------------------------------------------------------------
    // NMC (Natural Motion Circumnavigation) Solver
    // -----------------------------------------------------------------------
    /**
     * Compute delta-V for NMC entry around a target entity.
     * CW relative motion: x = -b*cos(nt+phi), y = 2b*sin(nt+phi), z = 0
     * @param {object} playerState - player flight state
     * @param {object} targetState - target entity state (must have _eci_pos, _eci_vel)
     * @param {number} simTime - current sim time
     * @param {number} semiMinorKm - semi-minor axis in km
     * @param {number} phaseAngleDeg - phase angle in degrees
     * @returns {{dvPro, dvNrm, dvRad, dvTotal, period, valid}}
     */
    function computeNMC(playerState, targetState, simTime, semiMinorKm, phaseAngleDeg) {
        var O = SpaceplaneOrbital;
        if (!playerState || !targetState) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, period: 0, valid: false };
        }

        // Player ECI
        var playerECI = O.geodeticToECI(playerState, simTime);
        if (!playerECI || !playerECI.pos || !playerECI.vel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, period: 0, valid: false };
        }

        // Target ECI
        var tPos = targetState._eci_pos;
        var tVel = targetState._eci_vel;
        if (!tPos || !tVel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, period: 0, valid: false };
        }

        // Target orbital parameters
        var rTgt = O.vecMag(tPos);
        var n = Math.sqrt(MU / (rTgt * rTgt * rTgt)); // target mean motion
        var period = 2 * Math.PI / n;

        // RIC frame at target
        var rHat = O.vecScale(tPos, 1 / rTgt); // Radial (R)
        var hVec = O.vecCross(tPos, tVel);
        var hMag = O.vecMag(hVec);
        var cHat = hMag > 0 ? O.vecScale(hVec, 1 / hMag) : [0, 0, 1]; // Cross-track (C)
        var iHat = O.vecCross(cHat, rHat); // In-track (I)

        // Current relative position and velocity in RIC
        var relPos = O.vecSub(playerECI.pos, tPos);
        var relVel = O.vecSub(playerECI.vel, tVel);

        var x_cur = O.vecDot(relPos, rHat);
        var y_cur = O.vecDot(relPos, iHat);
        // var z_cur = O.vecDot(relPos, cHat); // not used for coplanar NMC

        var xdot_cur = O.vecDot(relVel, rHat);
        var ydot_cur = O.vecDot(relVel, iHat);
        // var zdot_cur = O.vecDot(relVel, cHat); // not used

        // NMC required state
        var b = semiMinorKm * 1000; // meters
        var phi = phaseAngleDeg * Math.PI / 180;

        var x_req = -b * Math.cos(phi);
        var y_req = 2 * b * Math.sin(phi);
        var xdot_req = b * n * Math.sin(phi);
        var ydot_req = 2 * b * n * Math.cos(phi);

        // Delta position in RIC (to reposition to NMC entry point)
        // For now, just compute the velocity change needed at current position
        // The NMC constraint is: ydot = -2*n*x to maintain the ellipse
        // Simplification: compute dv to enter NMC from current relative state
        var dvR = xdot_req - xdot_cur;
        var dvI = ydot_req - ydot_cur;
        var dvC = 0; // coplanar

        // Transform RIC delta-V back to ECI
        var dvECI = [
            rHat[0] * dvR + iHat[0] * dvI + cHat[0] * dvC,
            rHat[1] * dvR + iHat[1] * dvI + cHat[1] * dvC,
            rHat[2] * dvR + iHat[2] * dvI + cHat[2] * dvC,
        ];

        var dvTotal = O.vecMag(dvECI);

        // Project onto player's orbital frame
        var frame = computeOrbitalFrame(playerECI.pos, playerECI.vel);
        var dvPro = O.vecDot(dvECI, frame.prograde);
        var dvNrm = O.vecDot(dvECI, frame.normal);
        var dvRad = O.vecDot(dvECI, frame.radial);

        return {
            dvPro: dvPro, dvNrm: dvNrm, dvRad: dvRad, dvTotal: dvTotal,
            period: period, semiMinor: semiMinorKm, semiMajor: semiMinorKm * 2,
            valid: true
        };
    }

    // -----------------------------------------------------------------------
    // Lagrange Point Solver
    // -----------------------------------------------------------------------

    // Simple ephemeris constants
    var _OBLIQUITY = 23.4393 * Math.PI / 180; // ecliptic obliquity
    var _MOON_DIST = 384400000;    // m
    var _MOON_PERIOD = 27.321661 * 86400; // s
    var _MOON_INC = 5.145 * Math.PI / 180; // to ecliptic
    var _AU = 149597870700;        // m
    var _YEAR = 365.25 * 86400;    // s
    var _MU_MOON = 4.9028695e12;   // m³/s² (Moon)
    var _MU_SUN = 1.32712440018e20; // m³/s² (Sun)
    var _MU_EARTH = MU;

    /**
     * Approximate Moon position in ECI at simTime.
     * Circular orbit, inclined to equatorial plane.
     */
    function moonPositionECI(simTime) {
        // Moon mean longitude (approximate, ref epoch simTime=0)
        var n_moon = TWO_PI / _MOON_PERIOD;
        var L = n_moon * simTime; // mean longitude from ref

        // Moon orbit in ecliptic: circular at _MOON_DIST
        var x_ecl = _MOON_DIST * Math.cos(L);
        var y_ecl = _MOON_DIST * Math.sin(L) * Math.cos(_MOON_INC);
        var z_ecl = _MOON_DIST * Math.sin(L) * Math.sin(_MOON_INC);

        // Rotate ecliptic → equatorial (around X by obliquity)
        var cosO = Math.cos(_OBLIQUITY), sinO = Math.sin(_OBLIQUITY);
        return [
            x_ecl,
            y_ecl * cosO - z_ecl * sinO,
            y_ecl * sinO + z_ecl * cosO
        ];
    }

    /**
     * Approximate Sun position in ECI at simTime.
     * Earth orbits Sun, so Sun appears to orbit Earth.
     */
    function sunPositionECI(simTime) {
        var n_sun = TWO_PI / _YEAR;
        var L = n_sun * simTime + Math.PI; // Sun is opposite Earth's position

        // Sun in ecliptic plane at 1 AU
        var x_ecl = _AU * Math.cos(L);
        var y_ecl = _AU * Math.sin(L);
        var z_ecl = 0;

        var cosO = Math.cos(_OBLIQUITY), sinO = Math.sin(_OBLIQUITY);
        return [
            x_ecl,
            y_ecl * cosO - z_ecl * sinO,
            y_ecl * sinO + z_ecl * cosO
        ];
    }

    /**
     * Compute Lagrange point position in ECI.
     * @param {string} system - 'earth-moon' or 'earth-sun'
     * @param {number} lNumber - 1 through 5
     * @param {number} simTime - current sim time
     * @returns {{pos: number[], dist: number, name: string}}
     */
    function lagrangePointECI(system, lNumber, simTime) {
        var O = SpaceplaneOrbital;
        var secondaryPos, mu_ratio, d;

        if (system === 'earth-moon') {
            secondaryPos = moonPositionECI(simTime);
            // mu = M_secondary / (M_primary + M_secondary)
            mu_ratio = _MU_MOON / (_MU_EARTH + _MU_MOON); // ~0.01215
        } else {
            secondaryPos = sunPositionECI(simTime);
            // For Earth-Sun: Earth is the secondary, Sun is primary
            // But we want L-points relative to Earth, so:
            // mu = M_earth / (M_sun + M_earth)
            mu_ratio = _MU_EARTH / (_MU_SUN + _MU_EARTH); // ~3e-6
        }

        d = O.vecMag(secondaryPos);
        var uDir = O.vecScale(secondaryPos, 1 / d); // unit vector Earth → secondary

        // Orbit normal for L4/L5 rotation
        // For Earth-Moon: approximately ecliptic normal rotated to equatorial
        // Use cross product of secondary position with its velocity direction
        // Approximate velocity as perpendicular to position in the orbital plane
        var cosO = Math.cos(_OBLIQUITY), sinO = Math.sin(_OBLIQUITY);
        var orbitNormal = [0, -sinO, cosO]; // ecliptic normal in equatorial frame

        var alpha = Math.pow(mu_ratio / 3, 1.0 / 3.0); // Hill sphere ratio
        var pos;

        switch (lNumber) {
            case 1: // Between primary and secondary
                if (system === 'earth-sun') {
                    // L1 is sunward of Earth: toward Sun at distance d*alpha
                    pos = O.vecScale(uDir, d * alpha);
                } else {
                    // L1 between Earth and Moon
                    pos = O.vecScale(uDir, d * (1 - alpha));
                }
                break;
            case 2: // Beyond secondary
                if (system === 'earth-sun') {
                    // L2 is anti-sunward of Earth
                    pos = O.vecScale(uDir, -d * alpha);
                } else {
                    // L2 beyond Moon
                    pos = O.vecScale(uDir, d * (1 + alpha));
                }
                break;
            case 3: // Opposite side
                if (system === 'earth-sun') {
                    // L3 is behind Sun from Earth (opposite side of Sun)
                    pos = O.vecScale(uDir, d + d); // approximately 2 AU toward Sun
                } else {
                    // L3 opposite Moon from Earth
                    pos = O.vecScale(uDir, -d * (1 + 7 * mu_ratio / 12));
                }
                break;
            case 4: // 60° ahead (leading)
            {
                var cos60 = 0.5, sin60 = Math.sqrt(3) / 2;
                // Rotate secondaryPos by +60° around orbit normal
                var lateral = O.vecCross(orbitNormal, uDir);
                pos = O.vecAdd(O.vecScale(uDir, d * cos60), O.vecScale(lateral, d * sin60));
                break;
            }
            case 5: // 60° behind (trailing)
            {
                var cos60b = 0.5, sin60b = Math.sqrt(3) / 2;
                var lateralB = O.vecCross(orbitNormal, uDir);
                pos = O.vecAdd(O.vecScale(uDir, d * cos60b), O.vecScale(lateralB, -d * sin60b));
                break;
            }
            default:
                return { pos: [0, 0, 0], dist: 0, name: 'Unknown' };
        }

        var names = {
            'earth-moon': ['', 'EM-L1', 'EM-L2', 'EM-L3', 'EM-L4', 'EM-L5'],
            'earth-sun':  ['', 'SE-L1', 'SE-L2', 'SE-L3', 'SE-L4', 'SE-L5']
        };

        return {
            pos: pos,
            dist: O.vecMag(pos),
            name: (names[system] || [])[lNumber] || 'L' + lNumber
        };
    }

    /**
     * Compute Lambert transfer to a Lagrange point.
     * @param {object} playerState - player flight state
     * @param {string} system - 'earth-moon' or 'earth-sun'
     * @param {number} lNumber - 1 through 5
     * @param {number} simTime - current sim time
     * @param {number} tofDays - time of flight in days
     * @returns {{dvPro, dvNrm, dvRad, dvTotal, targetPos, targetDist, targetName, valid}}
     */
    function computeLagrangeTransfer(playerState, system, lNumber, simTime, tofDays) {
        var O = SpaceplaneOrbital;
        if (!playerState) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        var playerECI = O.geodeticToECI(playerState, simTime);
        if (!playerECI || !playerECI.pos || !playerECI.vel) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        var tofSeconds = tofDays * 86400;

        // Get Lagrange point position at arrival time
        var lp = lagrangePointECI(system, lNumber, simTime + tofSeconds);
        if (!lp.pos || lp.dist < 1000) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false };
        }

        // Solve Lambert
        var lambert = solveLambert(playerECI.pos, lp.pos, tofSeconds, true);
        if (!lambert.valid) {
            lambert = solveLambert(playerECI.pos, lp.pos, tofSeconds, false);
        }
        if (!lambert.valid) {
            return { dvPro: 0, dvNrm: 0, dvRad: 0, dvTotal: 0, valid: false,
                     targetPos: lp.pos, targetDist: lp.dist, targetName: lp.name };
        }

        // Delta-V in ECI
        var dvECI = O.vecSub(lambert.v1, playerECI.vel);
        var dvTotal = O.vecMag(dvECI);

        // Project onto orbital frame
        var frame = computeOrbitalFrame(playerECI.pos, playerECI.vel);
        var dvPro = O.vecDot(dvECI, frame.prograde);
        var dvNrm = O.vecDot(dvECI, frame.normal);
        var dvRad = O.vecDot(dvECI, frame.radial);

        return {
            dvPro: dvPro, dvNrm: dvNrm, dvRad: dvRad, dvTotal: dvTotal,
            targetPos: lp.pos, targetDist: lp.dist, targetName: lp.name,
            valid: true
        };
    }

    // -----------------------------------------------------------------------
    // Inclination Change Solver
    // -----------------------------------------------------------------------
    /**
     * Compute a pure plane-change burn to reach a target inclination.
     * Places the burn at the nearest ascending or descending node.
     * @param {object} playerState - current player state
     * @param {number} simTime - current sim time
     * @param {number} targetIncDeg - target inclination in degrees
     * @returns {object} {dvNrm, dvTotal, nodeTimeDt, nodeName, currentIncDeg, targetIncDeg, valid}
     */
    function computeInclinationChange(playerState, simTime, targetIncDeg) {
        var O = SpaceplaneOrbital;
        if (!O || !playerState) return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        var eci = O.geodeticToECI(playerState, simTime);
        if (!eci || !eci.pos || !eci.vel) return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        var elems = O.computeOrbitalElements(eci.pos, eci.vel);
        if (!elems || elems.eccentricity >= 1.0 || elems.sma <= 0)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        var currentInc = elems.inclination; // radians
        var targetInc = targetIncDeg * Math.PI / 180;
        var deltaInc = targetInc - currentInc; // signed

        if (Math.abs(deltaInc) < 1e-6)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, nodeName: 'none',
                     currentIncDeg: currentInc * 180 / Math.PI, targetIncDeg: targetIncDeg, valid: true };

        // DV = 2 * v * sin(|Δi|/2) at the node
        var tAN = elems.timeToAscendingNode;
        var tDN = elems.timeToDescendingNode;

        // Pick the node
        // At AN: negative normal decreases inc, positive normal increases inc
        // At DN: positive normal decreases inc, negative normal increases inc
        var useDt, nodeName, signMult;
        if (tAN != null && tDN != null) {
            // Both available — pick closest
            if (tAN <= tDN) {
                useDt = tAN;
                nodeName = 'AN';
                signMult = 1;
            } else {
                useDt = tDN;
                nodeName = 'DN';
                signMult = -1;
            }
        } else if (tAN != null) {
            useDt = tAN; nodeName = 'AN'; signMult = 1;
        } else if (tDN != null) {
            useDt = tDN; nodeName = 'DN'; signMult = -1;
        } else {
            // Equatorial orbit — no well-defined nodes, burn now
            useDt = 0; nodeName = 'NOW'; signMult = 1;
        }

        // Propagate to burn point to get speed there
        var burnECI = useDt > 1 ? O.propagateKepler(eci.pos, eci.vel, useDt) :
            { pos: eci.pos.slice(), vel: eci.vel.slice() };
        var vAtNode = O.vecMag(burnECI.vel);

        var dvMag = 2 * vAtNode * Math.sin(Math.abs(deltaInc) / 2);

        // Check if DV would exceed escape velocity at the burn point
        var rAtNode = O.vecMag(burnECI.pos);
        var vEscape = Math.sqrt(2 * MU / rAtNode);
        var vPostBurn = Math.sqrt(vAtNode * vAtNode + dvMag * dvMag); // normal DV ⊥ velocity
        var wouldEscape = vPostBurn >= vEscape;

        // Normal direction: sign depends on node and desired direction
        var dvNrm = signMult * (deltaInc > 0 ? dvMag : -dvMag);

        return {
            dvNrm: dvNrm,
            dvTotal: dvMag,
            nodeTimeDt: useDt,
            nodeName: nodeName,
            currentIncDeg: currentInc * 180 / Math.PI,
            targetIncDeg: targetIncDeg,
            wouldEscape: wouldEscape,
            valid: true
        };
    }

    // -----------------------------------------------------------------------
    // Plane Match Solver
    // -----------------------------------------------------------------------
    /**
     * Compute a plane-change burn to match a target entity's orbital plane.
     * @param {object} playerState - current player state
     * @param {object} targetState - target entity state (with _eci_pos, _eci_vel)
     * @param {number} simTime - current sim time
     * @returns {object} {dvNrm, dvTotal, nodeTimeDt, deltaIncDeg, targetName, valid}
     */
    function computePlaneMatch(playerState, targetState, simTime) {
        var O = SpaceplaneOrbital;
        if (!O || !playerState || !targetState)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        // Player ECI state
        var eci = O.geodeticToECI(playerState, simTime);
        if (!eci || !eci.pos || !eci.vel)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        // Target ECI state
        var tPos = targetState._eci_pos;
        var tVel = targetState._eci_vel;
        if (!tPos || !tVel)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        // Compute angular momentum vectors (orbital plane normals)
        var h1 = O.vecCross(eci.pos, eci.vel);
        var h2 = O.vecCross(tPos, tVel);
        var h1Mag = O.vecMag(h1);
        var h2Mag = O.vecMag(h2);
        if (h1Mag < 1e-6 || h2Mag < 1e-6)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        var h1Hat = O.vecScale(h1, 1 / h1Mag);
        var h2Hat = O.vecScale(h2, 1 / h2Mag);

        // Angle between orbital planes
        var cosAngle = Math.max(-1, Math.min(1, O.vecDot(h1Hat, h2Hat)));
        var deltaInc = Math.acos(cosAngle);

        if (deltaInc < 1e-6)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, deltaIncDeg: 0, valid: true };

        // Line of intersection between the two planes: L = h1 × h2
        var lineOfNodes = O.vecCross(h1, h2);
        var lonMag = O.vecMag(lineOfNodes);
        if (lonMag < 1e-6)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };
        var lonHat = O.vecScale(lineOfNodes, 1 / lonMag);

        // Find when the player crosses this line of nodes
        // Scan orbit in small true anomaly steps to find position closest to line of nodes
        var playerElems = O.computeOrbitalElements(eci.pos, eci.vel);
        if (!playerElems || playerElems.eccentricity >= 1.0 || playerElems.sma <= 0)
            return { dvNrm: 0, dvTotal: 0, nodeTimeDt: 0, valid: false };

        var period = playerElems.period || 5400;
        var bestDt = 0;
        var bestDot = -2;
        var nSteps = 72; // every 5° of orbit
        for (var i = 0; i < nSteps; i++) {
            var tStep = (i / nSteps) * period;
            var futECI = O.propagateKepler(eci.pos, eci.vel, tStep);
            if (!futECI || !futECI.pos) continue;
            var rMag = O.vecMag(futECI.pos);
            if (rMag < 1e-6) continue;
            var rHat = O.vecScale(futECI.pos, 1 / rMag);
            var dot = Math.abs(O.vecDot(rHat, lonHat));
            if (dot > bestDot) {
                bestDot = dot;
                bestDt = tStep;
            }
        }

        // Refine with finer scan around best
        var low = Math.max(0, bestDt - period / nSteps);
        var high = bestDt + period / nSteps;
        for (var j = 0; j < 20; j++) {
            var dtStep = (high - low) / 10;
            var bestLocal = -2, bestLocalDt = low;
            for (var k = 0; k <= 10; k++) {
                var t = low + k * dtStep;
                var fECI = O.propagateKepler(eci.pos, eci.vel, t);
                if (!fECI || !fECI.pos) continue;
                var rm = O.vecMag(fECI.pos);
                if (rm < 1e-6) continue;
                var rh = O.vecScale(fECI.pos, 1 / rm);
                var d = Math.abs(O.vecDot(rh, lonHat));
                if (d > bestLocal) { bestLocal = d; bestLocalDt = t; }
            }
            low = bestLocalDt - dtStep;
            high = bestLocalDt + dtStep;
            bestDt = bestLocalDt;
        }

        // Compute velocity at that point and the required DV
        var burnECI = bestDt > 1 ? O.propagateKepler(eci.pos, eci.vel, bestDt) :
            { pos: eci.pos.slice(), vel: eci.vel.slice() };
        var vAtNode = O.vecMag(burnECI.vel);
        var dvMag = 2 * vAtNode * Math.sin(deltaInc / 2);

        // Check if DV would exceed escape velocity
        var rAtNode = O.vecMag(burnECI.pos);
        var vEscape = Math.sqrt(2 * MU / rAtNode);
        var vPostBurn = Math.sqrt(vAtNode * vAtNode + dvMag * dvMag);
        var wouldEscape = vPostBurn >= vEscape;

        // Determine normal direction: rotate velocity into target plane
        // The DV direction is perpendicular to velocity, in the direction from h1 toward h2
        var hCross = O.vecCross(h1Hat, h2Hat);
        var hCrossMag = O.vecMag(hCross);
        // Normal component relative to player's orbital frame at burn point
        var frame = computeOrbitalFrame(burnECI.pos, burnECI.vel);
        // The plane change DV is along (h2 - h1) projected onto normal direction
        var hDiff = O.vecSub(h2Hat, h1Hat);
        var dvNrm = O.vecDot(hDiff, frame.normal) > 0 ? dvMag : -dvMag;

        return {
            dvNrm: dvNrm,
            dvTotal: dvMag,
            nodeTimeDt: bestDt,
            wouldEscape: wouldEscape,
            deltaIncDeg: deltaInc * 180 / Math.PI,
            valid: true
        };
    }

    // -----------------------------------------------------------------------
    // Planetary Transfer Solver
    // -----------------------------------------------------------------------
    // Reference epoch: simTime=0 maps to 2026-01-01 00:00 UTC
    var _JD_SIM_EPOCH = 2460676.5; // JD of 2026-01-01 00:00 UTC

    /**
     * Compute departure DV for a planetary transfer using patched conics.
     * @param {object} playerState - current player state
     * @param {number} simTime - current sim time (seconds)
     * @param {string} targetPlanet - planet key (e.g., 'MARS', 'VENUS')
     * @param {number} tofDays - time of flight in days
     * @returns {object} {dvDepart, dvPro, dvNrm, dvRad, c3, vInfMag, tofDays, targetName, valid}
     */
    function computePlanetaryTransfer(playerState, simTime, targetPlanet, tofDays) {
        var O = SpaceplaneOrbital;
        if (!O || !playerState || typeof SolarSystemEngine === 'undefined')
            return { dvDepart: 0, c3: 0, vInfMag: 0, valid: false };

        var SSE = SolarSystemEngine;
        var MU_SUN = 1.32712440018e20;
        var MU_EARTH = 3.986004418e14;

        // Convert sim time to Julian date
        var jdDepart = _JD_SIM_EPOCH + simTime / 86400;
        var jdArrive = jdDepart + tofDays;

        // Earth position/velocity at departure (heliocentric, J2000 equatorial)
        var rEarth = SSE.getPlanetPositionHCI('EARTH', jdDepart);
        var vEarth = SSE.getPlanetVelocityHCI('EARTH', jdDepart);
        if (!rEarth || !vEarth)
            return { dvDepart: 0, c3: 0, vInfMag: 0, valid: false };

        // Target planet position at arrival
        var rTarget = SSE.getPlanetPositionHCI(targetPlanet, jdArrive);
        if (!rTarget)
            return { dvDepart: 0, c3: 0, vInfMag: 0, valid: false };

        // Solve heliocentric Lambert problem using our full universal variable solver
        var tofSec = tofDays * 86400;
        var r1Arr = [rEarth.x, rEarth.y, rEarth.z];
        var r2Arr = [rTarget.x, rTarget.y, rTarget.z];
        var lambert = solveLambert(r1Arr, r2Arr, tofSec, true, MU_SUN);
        if (!lambert || !lambert.valid) {
            // Try long way
            lambert = solveLambert(r1Arr, r2Arr, tofSec, false, MU_SUN);
        }
        if (!lambert || !lambert.valid)
            return { dvDepart: 0, c3: 0, vInfMag: 0, valid: false,
                     targetName: SSE.PLANETS[targetPlanet] ? SSE.PLANETS[targetPlanet].name : targetPlanet };

        // Departure V-infinity (heliocentric)
        var vInf = [
            lambert.v1[0] - vEarth.x,
            lambert.v1[1] - vEarth.y,
            lambert.v1[2] - vEarth.z
        ];
        var vInfMag = O.vecMag(vInf);
        var c3 = vInfMag * vInfMag;

        // Player's current orbit
        var eci = O.geodeticToECI(playerState, simTime);
        if (!eci || !eci.pos || !eci.vel)
            return { dvDepart: 0, c3: c3, vInfMag: vInfMag, valid: false };

        var rOrbit = O.vecMag(eci.pos);
        var vOrbit = O.vecMag(eci.vel);

        // Departure DV from current orbit via Oberth effect
        // v_depart = sqrt(v_inf^2 + 2*mu_earth/r) — hyperbolic velocity at current radius
        // dv = v_depart - v_orbit
        var vHyperb = Math.sqrt(c3 + 2 * MU_EARTH / rOrbit);
        var dvDepart = vHyperb - vOrbit;

        // Project V-infinity onto player's orbital frame for burn direction
        var frame = computeOrbitalFrame(eci.pos, eci.vel);
        var dvPro = O.vecDot(vInf, frame.prograde);
        var dvNrm = O.vecDot(vInf, frame.normal);
        var dvRad = O.vecDot(vInf, frame.radial);
        // Normalize to match actual departure DV magnitude
        var vInfProj = Math.sqrt(dvPro * dvPro + dvNrm * dvNrm + dvRad * dvRad);
        if (vInfProj > 1) {
            var scale = dvDepart / vInfProj;
            dvPro *= scale;
            dvNrm *= scale;
            dvRad *= scale;
        } else {
            dvPro = dvDepart; dvNrm = 0; dvRad = 0;
        }

        var planetName = SSE.PLANETS[targetPlanet] ? SSE.PLANETS[targetPlanet].name : targetPlanet;

        return {
            dvDepart: dvDepart,
            dvPro: dvPro,
            dvNrm: dvNrm,
            dvRad: dvRad,
            c3: c3,
            vInfMag: vInfMag,
            tofDays: tofDays,
            targetName: planetName,
            departureJD: jdDepart,
            arrivalJD: jdArrive,
            valid: true
        };
    }

    /**
     * Compute default Hohmann transfer TOF to a planet (days).
     */
    function defaultPlanetaryTOF(targetPlanet) {
        if (typeof SolarSystemEngine === 'undefined') return 200;
        var SSE = SolarSystemEngine;
        var MU_SUN = 1.32712440018e20;
        var AU = 149597870700;
        var aEarth = 1.0 * AU;
        var aTarget = (SSE.PLANETS[targetPlanet] ? SSE.PLANETS[targetPlanet].sma_au : 1.5) * AU;
        var aTransfer = (aEarth + aTarget) / 2;
        var tofSec = Math.PI * Math.sqrt(aTransfer * aTransfer * aTransfer / MU_SUN);
        return Math.round(tofSec / 86400);
    }

    // Public API
    return {
        get predictedOrbitPositions() { return predictedOrbitPositions; },
        get selectedNode() {
            return selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length ?
                nodes[selectedNodeIndex] : null;
        },
        get nodes() { return nodes; },
        get engineLabel() { return _engineLabel; },
        get engineThrust() { return _engineThrust; },

        createNode,
        createNodeAtTime,
        setNodeDV,
        setEngineParams,
        deleteSelectedNode,
        deleteNode,
        adjustNodeDV,
        adjustNodeTime,
        executeNode,
        getBurnDirectionECI,
        update,
        reset,
        computeOrbitalFrame,
        updateNodePrediction,
        computeHohmann,
        solveLambert,
        computeIntercept,
        computeNMC,
        lagrangePointECI,
        computeLagrangeTransfer,
        moonPositionECI,
        sunPositionECI,
        computeInclinationChange,
        computePlaneMatch,
        computePlanetaryTransfer,
        defaultPlanetaryTOF,
    };
})();
