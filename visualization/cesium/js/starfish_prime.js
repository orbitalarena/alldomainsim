/**
 * Starfish Prime Nuclear Detonation Model
 *
 * Models high-altitude nuclear detonation with artificial radiation belt injection.
 * Default parameters match the historical Starfish Prime test (1.4 MT, Johnston Atoll).
 *
 * Supports configurable detonation altitude, lat/lon, and yield. The injection
 * L-shell is computed from the detonation position via dipole field geometry,
 * producing physically reasonable results from ~300 km to ~6 R_E.
 *
 * Requires VanAllenModel to be loaded first (for geoToGeomagnetic / computeLShell).
 */
const StarfishPrime = (function() {
    'use strict';

    var DEG = Math.PI / 180;
    var R_E = 6371000; // m

    // --- Default Detonation Parameters (Historical Starfish Prime) ---
    var DEFAULT_ALTITUDE = 2000000;   // m (2000 km)
    var DEFAULT_LAT = 16.7;           // degrees N (Johnston Atoll)
    var DEFAULT_LON = -169.5;         // degrees W
    var DEFAULT_YIELD = 1.4e6;        // tons TNT (1.4 MT)

    // Reference peak flux at L~1.3 for 1.4 MT yield (electrons/cm^2/s, E > 0.5 MeV)
    var PHI_PEAK_REF = 1e7;

    // Decay time constants (seconds)
    var TAU_1 = 10 * 86400;           // 10 days — fast atmospheric loss
    var TAU_2 = 90 * 86400;           // 90 days — Coulomb scattering
    var TAU_3 = 365 * 86400;          // 365 days — long-lived residual

    // Decay component fractions
    var F1 = 0.30;
    var F2 = 0.50;
    var F3 = 0.20;

    // Physical limits for stable trapping
    var L_MIN_TRAPPING = 1.05;   // below this, atmosphere scrubs in < 1 orbit
    var L_MAX_TRAPPING = 8.0;    // beyond ~8 R_E, magnetopause — open drift shells
    var ALT_MIN_TRAPPING = 200000; // m — below 200 km, too much atmospheric drag

    // --- State ---
    var detonationTime = null;
    var active = false;
    // Configurable per-detonation
    var detAlt = DEFAULT_ALTITUDE;
    var detLat = DEFAULT_LAT;
    var detLon = DEFAULT_LON;
    var detYield = DEFAULT_YIELD;
    var injectionL = 1.3;        // computed at detonation time
    var peakFlux = PHI_PEAK_REF; // scaled by yield and altitude
    var sigma = 0.15;            // Gaussian spread in L, adjusted by injection L
    var trappingFraction = 1.0;  // fraction of particles that get trapped (0..1)

    // --- Injection L Computation ---

    /**
     * Compute the L-shell and trapping parameters for a detonation at given position.
     * Uses VanAllenModel if available, otherwise falls back to equatorial approximation.
     */
    function computeInjectionParams(altM, latDeg, lonDeg, yieldTons) {
        var r = R_E + altM;
        var latRad = latDeg * DEG;
        var lonRad = lonDeg * DEG;
        var L;

        // Use VanAllenModel for proper geomagnetic coordinates if available
        if (typeof VanAllenModel !== 'undefined' && VanAllenModel.geoToGeomagnetic) {
            var mag = VanAllenModel.geoToGeomagnetic(latRad, lonRad);
            L = VanAllenModel.computeLShell(r, mag.magColat);
        } else {
            // Fallback: approximate L assuming equatorial
            L = r / R_E;
        }

        // Clamp L to physical range
        L = Math.max(1.01, Math.min(L, 15));

        // --- Trapping fraction ---
        // Below 200 km: atmosphere too dense, rapid loss before completing a drift orbit
        // Ramps from 0 at 100 km to 1 at 300 km
        var trapFrac = 1.0;
        if (altM < ALT_MIN_TRAPPING) {
            trapFrac = Math.max(0, (altM - 100000) / (ALT_MIN_TRAPPING - 100000));
        }
        // Beyond magnetopause: open field lines, particles escape
        // Ramps from 1 at L=7 to 0 at L=9
        if (L > 7) {
            trapFrac *= Math.max(0, 1 - (L - 7) / 2);
        }

        // --- Gaussian spread in L ---
        // At low L (inner belt), spread is narrow (~0.15)
        // At high L (outer belt), radial diffusion is faster → wider spread
        var sig = 0.10 + 0.05 * L;
        // Cap spread
        sig = Math.min(sig, 1.5);

        // --- Peak flux scaling ---
        // Scale with yield (sqrt — energy goes as yield, but fraction to electrons ~sqrt)
        var yieldScale = Math.sqrt(yieldTons / 1.4e6);
        // Scale with altitude: higher altitude → more dispersed injection volume
        // Reference is 400 km; flux density drops roughly as (r_ref/r)^2
        var r_ref = R_E + 400000;
        var altScale = (r_ref * r_ref) / (r * r);
        // But higher altitude also means less atmospheric loss during injection
        // so partially compensate above 1000 km
        if (altM > 1000000) {
            altScale *= 1 + 0.3 * Math.log10(altM / 1000000);
        }
        var peak = PHI_PEAK_REF * yieldScale * altScale * trapFrac;

        return {
            L: L,
            sigma: sig,
            peakFlux: peak,
            trappingFraction: trapFrac
        };
    }

    // --- Artificial Belt Injection ---

    /**
     * Spatial profile: L-shell distribution of injected electrons.
     * Centered on dynamically computed injection L.
     * @param {number} L - McIlwain L-shell
     * @returns {number} flux scale factor (0 to 1)
     */
    function spatialProfile(L) {
        if (trappingFraction <= 0) return 0;
        // Reject L far from injection zone (>4 sigma away)
        if (L < L_MIN_TRAPPING || Math.abs(L - injectionL) > 4 * sigma) return 0;
        // Beyond magnetopause
        if (L > L_MAX_TRAPPING) return 0;
        var dL = L - injectionL;
        return Math.exp(-(dL * dL) / (2 * sigma * sigma));
    }

    /**
     * L-dependent effective lifetime modifier.
     * Lower L decays faster (closer to atmosphere).
     * @param {number} L - L-shell
     * @param {number} baseTau - base decay time constant (seconds)
     * @returns {number} effective tau (seconds)
     */
    function effectiveTau(L, baseTau) {
        if (L <= 1.1) return baseTau * 0.5; // very low L: extra fast loss
        // Higher L: slower decay (farther from atmosphere)
        return baseTau * (1 + 3 * (L - 1.1));
    }

    /**
     * Temporal decay: multi-exponential with L-dependent rates.
     * @param {number} t - time since detonation (seconds)
     * @param {number} L - L-shell
     * @returns {number} decay factor (0 to 1)
     */
    function temporalDecay(t, L) {
        if (t < 0) return 0;
        var tau1 = effectiveTau(L, TAU_1);
        var tau2 = effectiveTau(L, TAU_2);
        var tau3 = effectiveTau(L, TAU_3);
        return F1 * Math.exp(-t / tau1) +
               F2 * Math.exp(-t / tau2) +
               F3 * Math.exp(-t / tau3);
    }

    /**
     * Get injected electron flux enhancement at a given L-shell and time.
     * @param {number} L - McIlwain L-shell
     * @param {number} timeSinceDetonation_s - seconds since detonation
     * @returns {{ electron05_enhancement: number, electron1_enhancement: number }}
     */
    function getInjectedFlux(L, timeSinceDetonation_s) {
        if (!active || timeSinceDetonation_s < 0) {
            return { electron05_enhancement: 0, electron1_enhancement: 0 };
        }

        var spatial = spatialProfile(L);
        var temporal = temporalDecay(timeSinceDetonation_s, L);
        var flux05 = peakFlux * spatial * temporal;

        // E > 1 MeV is ~30% of E > 0.5 MeV for fission spectrum
        var flux1 = flux05 * 0.3;

        return {
            electron05_enhancement: flux05,
            electron1_enhancement: flux1
        };
    }

    // --- Ionospheric Scintillation ---

    /**
     * Get S4 scintillation index (0=clear, 1=total disruption).
     * @param {number} timeSinceDetonation_s
     * @returns {number} S4 index
     */
    function getScintillation(timeSinceDetonation_s) {
        if (!active || timeSinceDetonation_s < 0) return 0;
        return Math.exp(-timeSinceDetonation_s / 3600);
    }

    // --- EMP / Aurora (Visual Effects) ---

    /**
     * EMP intensity (0 to 1). Sharp spike, decays in seconds.
     */
    function getEMPIntensity(timeSinceDetonation_s) {
        if (!active || timeSinceDetonation_s < 0) return 0;
        if (timeSinceDetonation_s < 0.001) return 1.0;
        return Math.exp(-timeSinceDetonation_s / 2.0);
    }

    /**
     * Aurora intensity (0 to 1). Peaks ~30s, decays over minutes.
     */
    function getAuroraIntensity(timeSinceDetonation_s) {
        if (!active || timeSinceDetonation_s < 0) return 0;
        var t = timeSinceDetonation_s;
        var rise = 1 - Math.exp(-t / 10);
        var decay = Math.exp(-t / 600);
        return rise * decay;
    }

    // --- State Management ---

    /**
     * Trigger detonation.
     * @param {number} simTime - current simulation time (seconds)
     * @param {object} [options] - optional overrides
     * @param {number} [options.altitude] - detonation altitude in meters
     * @param {number} [options.lat] - latitude in degrees
     * @param {number} [options.lon] - longitude in degrees
     * @param {number} [options.yield] - yield in tons TNT
     */
    function detonate(simTime, options) {
        detonationTime = simTime;
        active = true;

        if (options) {
            detAlt = (options.altitude !== undefined) ? options.altitude : DEFAULT_ALTITUDE;
            detLat = (options.lat !== undefined) ? options.lat : DEFAULT_LAT;
            detLon = (options.lon !== undefined) ? options.lon : DEFAULT_LON;
            detYield = (options.yield !== undefined) ? options.yield : DEFAULT_YIELD;
        } else {
            detAlt = DEFAULT_ALTITUDE;
            detLat = DEFAULT_LAT;
            detLon = DEFAULT_LON;
            detYield = DEFAULT_YIELD;
        }

        var params = computeInjectionParams(detAlt, detLat, detLon, detYield);
        injectionL = params.L;
        sigma = params.sigma;
        peakFlux = params.peakFlux;
        trappingFraction = params.trappingFraction;
    }

    function isActive() {
        return active;
    }

    function getTimeSinceDetonation(simTime) {
        if (!active) return -1;
        return simTime - detonationTime;
    }

    function getDetonationTime() {
        return detonationTime;
    }

    function getDetonationParams() {
        return {
            altitude: detAlt,
            lat: detLat,
            lon: detLon,
            yield: detYield,
            injectionL: injectionL,
            sigma: sigma,
            peakFlux: peakFlux,
            trappingFraction: trappingFraction
        };
    }

    function reset() {
        detonationTime = null;
        active = false;
        detAlt = DEFAULT_ALTITUDE;
        detLat = DEFAULT_LAT;
        detLon = DEFAULT_LON;
        detYield = DEFAULT_YIELD;
        injectionL = 1.3;
        peakFlux = PHI_PEAK_REF;
        sigma = 0.15;
        trappingFraction = 1.0;
    }

    // --- Public API ---
    return {
        // Default constants (for backward compatibility)
        YIELD: DEFAULT_YIELD,
        ALTITUDE: DEFAULT_ALTITUDE,
        LAT: DEFAULT_LAT,
        LON: DEFAULT_LON,

        // Physics
        getInjectedFlux: getInjectedFlux,
        getScintillation: getScintillation,
        getEMPIntensity: getEMPIntensity,
        getAuroraIntensity: getAuroraIntensity,
        computeInjectionParams: computeInjectionParams,

        // State
        detonate: detonate,
        isActive: isActive,
        getTimeSinceDetonation: getTimeSinceDetonation,
        getDetonationTime: getDetonationTime,
        getDetonationParams: getDetonationParams,
        reset: reset
    };
})();
