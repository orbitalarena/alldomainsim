/**
 * Spaceplane Maneuver Planner Module
 * Provides maneuver node system: create/edit/delete nodes,
 * predicted orbit computation, and burn execution.
 */
const SpaceplanePlanner = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const MU = 3.986004418e14;
    const R_EARTH = 6371000;
    const OMEGA_EARTH = 7.2921159e-5;

    // Maneuver nodes list
    let nodes = [];
    let selectedNodeIndex = -1;

    // Predicted orbit visualization
    let predictedOrbitPositions = [];

    // DV adjustment rate (m/s per call)
    const DV_STEP = 5;

    /**
     * Create a maneuver node at the current position/time
     * @param {object} state - current aircraft state
     * @param {number} simTime - current simulation time
     */
    function createNode(state, simTime) {
        if (!state || typeof SpaceplaneOrbital === 'undefined') return;

        const eci = SpaceplaneOrbital.geodeticToECI(state, simTime);
        const elems = SpaceplaneOrbital.computeOrbitalElements(eci.pos, eci.vel);

        const node = {
            id: Date.now(),
            simTime: simTime,         // when to execute
            eciPos: eci.pos.slice(),  // ECI position at creation
            eciVel: eci.vel.slice(),  // ECI velocity at creation

            // Delta-V components in orbital frame (prograde, normal, radial)
            dvPrograde: 0,   // m/s along velocity direction
            dvNormal: 0,     // m/s along angular momentum direction
            dvRadial: 0,     // m/s along radial-out direction

            // Derived (computed)
            dv: 0,           // total delta-V magnitude
            burnTime: null,  // estimated burn time
            postAP: null,    // post-burn apoapsis altitude
            postPE: null,    // post-burn periapsis altitude
            timeToNode: 0,   // time until node execution
        };

        nodes.push(node);
        selectedNodeIndex = nodes.length - 1;
        updateNodePrediction();
    }

    /**
     * Delete the currently selected node
     */
    function deleteSelectedNode() {
        if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length) {
            nodes.splice(selectedNodeIndex, 1);
            selectedNodeIndex = nodes.length > 0 ? Math.min(selectedNodeIndex, nodes.length - 1) : -1;
            updateNodePrediction();
        }
    }

    /**
     * Adjust the selected node's delta-V
     * @param {string} direction - 'prograde', 'retrograde', 'normal', 'antinormal',
     *                             'radial_in', 'radial_out', 'increase', 'decrease'
     * @param {number} multiplier - scale factor for adjustment
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
     * @param {number} dt - time adjustment in seconds
     */
    function adjustNodeTime(dt) {
        if (selectedNodeIndex < 0 || selectedNodeIndex >= nodes.length) return;

        const node = nodes[selectedNodeIndex];
        node.simTime += dt;

        // Re-propagate to new time to get updated position/velocity
        // (simplified: we keep the original orbit and re-predict)
        updateNodePrediction();
    }

    /**
     * Execute the selected maneuver node: apply delta-V to the aircraft state
     * @param {object} state - current aircraft state (mutated)
     * @param {number} simTime - current simulation time
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
        const newVel = [
            vel[0] + dvECI[0],
            vel[1] + dvECI[1],
            vel[2] + dvECI[2],
        ];

        // Convert new velocity magnitude back to aircraft state speed
        // This is approximate: we update speed and heading/gamma to match
        const newVMag = SpaceplaneOrbital.vecMag(newVel);
        state.speed = newVMag;

        // Compute new flight path angle from velocity direction relative to local horizon
        const rMag = SpaceplaneOrbital.vecMag(pos);
        const rUnit = SpaceplaneOrbital.vecScale(pos, 1 / rMag);
        const radialV = SpaceplaneOrbital.vecDot(newVel, rUnit);
        const horizontalV = Math.sqrt(newVMag * newVMag - radialV * radialV);

        state.gamma = Math.atan2(radialV, horizontalV);

        // Remove the executed node
        nodes.splice(selectedNodeIndex, 1);
        selectedNodeIndex = nodes.length > 0 ? Math.min(selectedNodeIndex, nodes.length - 1) : -1;
        predictedOrbitPositions = [];
        updateNodePrediction();
    }

    /**
     * Compute orbital reference frame (prograde, normal, radial)
     * @param {number[]} pos - ECI position
     * @param {number[]} vel - ECI velocity
     * @returns {object} { prograde, normal, radial } - unit vectors
     */
    function computeOrbitalFrame(pos, vel) {
        const O = SpaceplaneOrbital;
        const vMag = O.vecMag(vel);
        const rMag = O.vecMag(pos);

        // Prograde: along velocity
        const prograde = vMag > 0 ? O.vecScale(vel, 1 / vMag) : [1, 0, 0];

        // Angular momentum h = r × v → normal direction
        const h = O.vecCross(pos, vel);
        const hMag = O.vecMag(h);
        const normal = hMag > 0 ? O.vecScale(h, 1 / hMag) : [0, 0, 1];

        // Radial out: perpendicular to velocity in orbit plane
        const radial = O.vecCross(prograde, normal);

        return { prograde, normal, radial };
    }

    /**
     * Update the predicted post-burn orbit
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

        // Estimate burn time (assuming constant 500kN thrust, 15000 kg mass)
        const thrust = 500000; // N
        const mass = 15000;    // kg
        node.burnTime = node.dv > 0 ? (node.dv * mass / thrust) : 0;

        // Compute post-burn orbit
        const pos = node.eciPos;
        const vel = node.eciVel;
        const frame = computeOrbitalFrame(pos, vel);

        // Apply delta-V in orbital frame
        const dvECI = [
            frame.prograde[0] * node.dvPrograde + frame.normal[0] * node.dvNormal + frame.radial[0] * node.dvRadial,
            frame.prograde[1] * node.dvPrograde + frame.normal[1] * node.dvNormal + frame.radial[1] * node.dvRadial,
            frame.prograde[2] * node.dvPrograde + frame.normal[2] * node.dvNormal + frame.radial[2] * node.dvRadial,
        ];

        const newVel = [vel[0] + dvECI[0], vel[1] + dvECI[1], vel[2] + dvECI[2]];

        // Compute post-burn elements
        const postElems = SpaceplaneOrbital.computeOrbitalElements(pos, newVel);
        node.postAP = postElems.apoapsisAlt;
        node.postPE = postElems.periapsisAlt;

        // Generate predicted orbit polyline (guard against NaN/pathological orbits)
        if (isFinite(postElems.eccentricity) && postElems.eccentricity < 1.0 &&
            isFinite(postElems.sma) && postElems.sma > 0) {
            const gmst = OMEGA_EARTH * node.simTime;
            predictedOrbitPositions = SpaceplaneOrbital.predictOrbitPath(postElems, 360, gmst);
        } else {
            predictedOrbitPositions = [];
        }
    }

    let plannerUpdateCounter = 0;
    const PLANNER_UPDATE_INTERVAL = 15; // only re-predict every N frames

    /**
     * Main update function called each frame
     */
    function update(state, simTime) {
        // Update time-to-node for selected node
        if (selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length) {
            const node = nodes[selectedNodeIndex];
            node.timeToNode = node.simTime - simTime;

            // Re-compute prediction periodically (not every frame — expensive)
            plannerUpdateCounter++;
            if (plannerUpdateCounter % PLANNER_UPDATE_INTERVAL === 0) {
                if (typeof SpaceplaneOrbital !== 'undefined' && state) {
                    const eci = SpaceplaneOrbital.geodeticToECI(state, simTime);
                    node.eciPos = eci.pos.slice();
                    node.eciVel = eci.vel.slice();
                    updateNodePrediction();
                }
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

    // Public API
    return {
        get predictedOrbitPositions() { return predictedOrbitPositions; },
        get selectedNode() {
            return selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length ?
                nodes[selectedNodeIndex] : null;
        },
        get nodes() { return nodes; },

        createNode,
        deleteSelectedNode,
        adjustNodeDV,
        adjustNodeTime,
        executeNode,
        update,
        reset,
        computeOrbitalFrame,
    };
})();
