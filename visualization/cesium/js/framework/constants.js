/**
 * Shared constants for the scenario framework.
 * Avoids duplication across components.
 */
const FrameworkConstants = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const G = 9.80665;
    const R_EARTH = 6371000;                // m mean radius
    const MU_EARTH = 3.986004418e14;        // m^3/s^2
    const OMEGA_EARTH = 7.2921159e-5;       // rad/s
    const MPS_TO_KNOTS = 1.94384;
    const M_TO_FT = 3.28084;
    const NM_TO_M = 1852;

    return {
        DEG, RAD, G, R_EARTH, MU_EARTH, OMEGA_EARTH,
        MPS_TO_KNOTS, M_TO_FT, NM_TO_M
    };
})();
