/**
 * IADS Engine — Integrated Air Defense System simulation
 * Radar model, aircraft propagation, SAM missile with PN guidance,
 * and F2T2EA kill chain state machine.
 */
const IadsEngine = (function() {
    'use strict';

    const DEG = Math.PI / 180;
    const RAD = 180 / Math.PI;
    const G = 9.80665;
    const R_EARTH = 6371000;
    const NM_TO_M = 1852;

    // ─── Geographic Layout (Baja Mexico) ─────────────────────────

    const POSITIONS = {
        ew_radar: { lat: 32.2, lon: -117.5, alt: 50 },
        ttr:      { lat: 31.7, lon: -117.3, alt: 200 },
        sam:      { lat: 32.0, lon: -117.6, alt: 150 },
        c2:       { lat: 31.8, lon: -117.35, alt: 100 },
        satcom:   { lat: 0.0,  lon: -117.5, alt: 35786000 },
        aircraft: { lat: 32.5, lon: -118.2, alt: 8000 },
    };

    // ─── Radar Configurations ────────────────────────────────────

    const RADAR_CONFIGS = {
        EW: {
            id: 'ew_radar',
            name: 'EW/ATC Radar',
            type: 'EW',
            maxRange_nm: 200,
            scanRate_deg_s: 36,      // 10s revolution
            beamwidth_deg: 3,
            updateRate_s: 10,
            trackAccuracy_m: 1000,
        },
        TTR: {
            id: 'ttr',
            name: 'Target Track Radar',
            type: 'TTR',
            maxRange_nm: 100,
            scanRate_deg_s: 90,      // slew rate to target
            beamwidth_deg: 1.5,
            updateRate_s: 2,
            trackAccuracy_m: 100,
        },
        FCR: {
            id: 'fcr',
            name: 'Fire Control Radar',
            type: 'FCR',
            maxRange_nm: 80,         // S-300 engagement radar range
            scanRate_deg_s: 120,     // fast slew
            beamwidth_deg: 0.5,
            updateRate_s: 0.5,
            trackAccuracy_m: 10,
        },
    };

    // ─── SAM Configuration ───────────────────────────────────────

    const SAM_CONFIG = {
        name: 'SA-20',
        mass: 1800,
        motor_thrust: 200000,       // dual-pulse solid motor
        motor_burn_time: 15,        // s
        drag_cd: 0.3,
        ref_area: 0.18,
        max_g: 30,
        nav_gain: 4.0,
        max_speed: 2000,
        kill_radius: 50,
        max_flight_time: 90,
        magazine_size: 6,           // total missiles available at site
        salvo_size: 2,              // initial shoot-shoot count
    };

    // ─── F2T2EA Phases ───────────────────────────────────────────

    const PHASES = ['IDLE', 'FIND', 'FIX', 'TRACK', 'TARGET', 'ENGAGE', 'ASSESS', 'COMPLETE'];

    const PHASE_COLORS = {
        IDLE:     '#333333',
        FIND:     '#00ccff',
        FIX:      '#44ff88',
        TRACK:    '#ffcc00',
        TARGET:   '#ff8844',
        ENGAGE:   '#ff2222',
        ASSESS:   '#ff44ff',
        COMPLETE: '#888888',
    };

    // ─── Utility Functions ───────────────────────────────────────

    function toRad(deg) { return deg * DEG; }
    function toDeg(rad) { return rad * RAD; }

    /** Great-circle distance in meters (lat/lon in degrees) */
    function distance(lat1, lon1, lat2, lon2) {
        const la1 = toRad(lat1), la2 = toRad(lat2);
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(la1) * Math.cos(la2) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Bearing from A to B in degrees [0, 360) (lat/lon in degrees) */
    function bearing(lat1, lon1, lat2, lon2) {
        const la1 = toRad(lat1), la2 = toRad(lat2);
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(la2);
        const x = Math.cos(la1) * Math.sin(la2) -
                  Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    /** Gaussian noise with given RMS */
    function gaussianNoise(rms) {
        // Box-Muller transform
        const u1 = Math.random();
        const u2 = Math.random();
        return rms * Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
    }

    /** Simple exponential atmosphere density */
    function atmosphereDensity(alt) {
        if (alt < 0) return 1.225;
        return 1.225 * Math.exp(-alt / 8500);
    }

    /** Normalize angle to [0, 360) */
    function normAz(az) {
        return ((az % 360) + 360) % 360;
    }

    /** Shortest angular difference (signed, degrees) */
    function angleDiffDeg(a, b) {
        let d = a - b;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        return d;
    }

    // ─── Scenario Creation ───────────────────────────────────────

    function createRadar(type) {
        const cfg = RADAR_CONFIGS[type];
        const pos = type === 'FCR' ? POSITIONS.sam : POSITIONS[cfg.id];
        return {
            id: cfg.id,
            name: cfg.name,
            type: cfg.type,
            lat: pos.lat,
            lon: pos.lon,
            alt: pos.alt,
            maxRange_nm: cfg.maxRange_nm,
            scanRate_deg_s: cfg.scanRate_deg_s,
            beamwidth_deg: cfg.beamwidth_deg,
            updateRate_s: cfg.updateRate_s,
            trackAccuracy_m: cfg.trackAccuracy_m,
            state: 'SCANNING',
            currentAz: 0,
            trackFile: null,
            lastDetectTime: -999,
            lastReportTime: -999,
            detectionCount: 0,
            assigned: false,
        };
    }

    function createAircraft() {
        const p = POSITIONS.aircraft;
        return {
            lat: p.lat,
            lon: p.lon,
            alt: p.alt,
            speed: 250,          // m/s (~485 kts)
            heading: 140,        // degrees, SE toward Baja
            id: 'BOGEY-1',
            destroyed: false,
        };
    }

    function createEngagement() {
        return {
            phase: 'IDLE',
            phaseStartTime: 0,
            phaseHistory: [],
            trackConfidence: 0,
            ttrUpdateCount: 0,
            weaponsFree: false,
            // Multi-missile SSLS state
            samLaunched: false,
            missiles: [],               // array of active SAM objects
            missilesFired: 0,
            missilesRemaining: SAM_CONFIG.magazine_size,
            assessResult: null,
            assessTime: null,
            c2EvalDoneTime: null,
        };
    }

    function createScenario() {
        return {
            simTime: 0,
            ewRadar: createRadar('EW'),
            ttr: createRadar('TTR'),
            fcr: createRadar('FCR'),
            aircraft: createAircraft(),
            engagement: createEngagement(),
            c2: {
                id: 'c2',
                name: 'C2 Center',
                lat: POSITIONS.c2.lat,
                lon: POSITIONS.c2.lon,
                alt: POSITIONS.c2.alt,
                state: 'MONITORING',
            },
            satcom: {
                id: 'satcom',
                name: 'SATCOM-1',
                lat: POSITIONS.satcom.lat,
                lon: POSITIONS.satcom.lon,
                alt: POSITIONS.satcom.alt,
            },
            events: [],  // log of engagement events
        };
    }

    // ─── Radar Logic ─────────────────────────────────────────────

    function updateRadarScan(radar, target, dt) {
        if (radar.type === 'EW') {
            // EW: continuous azimuth sweep
            radar.currentAz = normAz(radar.currentAz + radar.scanRate_deg_s * dt);
        } else {
            // TTR/FCR: slew toward target bearing when assigned
            if (radar.assigned && target && !target.destroyed) {
                const tgtBrg = bearing(radar.lat, radar.lon, target.lat, target.lon);
                const diff = angleDiffDeg(tgtBrg, radar.currentAz);
                const maxSlew = radar.scanRate_deg_s * dt;
                if (Math.abs(diff) <= maxSlew) {
                    radar.currentAz = tgtBrg;
                } else {
                    radar.currentAz = normAz(radar.currentAz + Math.sign(diff) * maxSlew);
                }
            }
        }
    }

    /**
     * Check if radar detects target this tick.
     * Returns detection report or null.
     */
    function checkDetection(radar, target, simTime) {
        if (!target || target.destroyed) return null;

        const range_m = distance(radar.lat, radar.lon, target.lat, target.lon);
        const range_nm = range_m / NM_TO_M;

        // Range check
        if (range_nm > radar.maxRange_nm) return null;

        const tgtBearing = bearing(radar.lat, radar.lon, target.lat, target.lon);

        if (radar.type === 'EW') {
            // Scanning: detect only when beam sweeps across target
            const azDiff = Math.abs(angleDiffDeg(radar.currentAz, tgtBearing));
            if (azDiff > radar.beamwidth_deg / 2) return null;

            // Rate limit to updateRate_s
            if (simTime - radar.lastReportTime < radar.updateRate_s - 0.5) return null;
        } else {
            // TTR/FCR: detect if assigned and pointing at target
            if (!radar.assigned) return null;
            const azDiff = Math.abs(angleDiffDeg(radar.currentAz, tgtBearing));
            if (azDiff > radar.beamwidth_deg * 2) return null;

            // Rate limit
            if (simTime - radar.lastReportTime < radar.updateRate_s - 0.05) return null;
        }

        // Detection successful
        radar.lastDetectTime = simTime;
        radar.lastReportTime = simTime;
        radar.detectionCount++;

        // Generate report with noise
        const acc = radar.trackAccuracy_m;
        const noiseLat = gaussianNoise(acc) / R_EARTH * RAD;
        const noiseLon = gaussianNoise(acc) / (R_EARTH * Math.cos(toRad(target.lat))) * RAD;

        return {
            radarId: radar.id,
            radarType: radar.type,
            time: simTime,
            targetId: target.id,
            measuredLat: target.lat + noiseLat,
            measuredLon: target.lon + noiseLon,
            measuredAlt: target.alt + gaussianNoise(acc),
            trueLat: target.lat,
            trueLon: target.lon,
            trueAlt: target.alt,
            range_nm: range_nm,
            bearing_deg: tgtBearing,
            speed: target.speed,
            heading: target.heading,
        };
    }

    // ─── Aircraft Propagation ────────────────────────────────────

    function updateAircraft(ac, dt) {
        if (ac.destroyed) return;

        // Straight-line geodetic propagation (heading in degrees)
        const hdgRad = toRad(ac.heading);
        const R = R_EARTH + ac.alt;
        const latRad = toRad(ac.lat);

        // dLat, dLon in degrees
        const dLat = (ac.speed * Math.cos(hdgRad) / R) * RAD * dt;
        const dLon = (ac.speed * Math.sin(hdgRad) / (R * Math.cos(latRad))) * RAD * dt;

        ac.lat += dLat;
        ac.lon += dLon;
    }

    // ─── SAM Missile ─────────────────────────────────────────────

    function launchSAM(launcher, target, missileId) {
        const brg = toRad(bearing(launcher.lat, launcher.lon, target.lat, target.lon));
        return {
            id: missileId || 'SAM-1',
            lat: launcher.lat,
            lon: launcher.lon,
            alt: launcher.alt,
            speed: 50,                      // initial launch speed
            heading: brg * RAD,             // degrees
            gamma: 60,                      // steep initial climb (degrees)
            mass: SAM_CONFIG.mass,
            burnTime: SAM_CONFIG.motor_burn_time,
            flightTime: 0,
            state: 'FLYING',
            config: SAM_CONFIG,
            prevLosAngleH: null,
            prevLosAngleV: null,
            trail: [],
            interceptLat: null,
            interceptLon: null,
            interceptAlt: null,
        };
    }

    /**
     * Launch a salvo of missiles (shoot-shoot or follow-up shoot).
     * Returns array of launched missile objects.
     */
    function launchSalvo(eng, target, count) {
        const launcher = POSITIONS.sam;
        const launched = [];
        for (let i = 0; i < count; i++) {
            if (eng.missilesRemaining <= 0) break;
            eng.missilesFired++;
            eng.missilesRemaining--;
            const msl = launchSAM(launcher, target, 'SAM-' + eng.missilesFired);
            eng.missiles.push(msl);
            launched.push(msl);
        }
        eng.samLaunched = true;
        return launched;
    }

    function stepSAM(sam, target, dt) {
        if (sam.state !== 'FLYING' && sam.state !== 'TERMINAL') return;
        if (!target || target.destroyed) { sam.state = 'MISS'; return; }

        const cfg = sam.config;
        sam.flightTime += dt;

        // Atmosphere for drag
        const rho = atmosphereDensity(sam.alt);
        const qS = 0.5 * rho * sam.speed * sam.speed * cfg.ref_area;

        // Thrust
        let thrust = 0;
        if (sam.burnTime > 0) {
            thrust = cfg.motor_thrust;
            sam.burnTime -= dt;
        }

        // Drag
        const drag = qS * cfg.drag_cd;

        // --- Proportional Navigation Guidance ---
        const range_m = distance(sam.lat, sam.lon, target.lat, target.lon);
        const dAlt = target.alt - sam.alt;
        const slantRange = Math.sqrt(range_m * range_m + dAlt * dAlt);

        const losAngleH = toRad(bearing(sam.lat, sam.lon, target.lat, target.lon));
        const losAngleV = Math.atan2(dAlt, Math.max(range_m, 1));

        // LOS rate via finite difference
        let losRateH = 0, losRateV = 0;
        if (sam.prevLosAngleH !== null && dt > 0) {
            let dH = losAngleH - sam.prevLosAngleH;
            while (dH > Math.PI) dH -= 2 * Math.PI;
            while (dH < -Math.PI) dH += 2 * Math.PI;
            losRateH = dH / dt;
            losRateV = (losAngleV - sam.prevLosAngleV) / dt;
        }
        sam.prevLosAngleH = losAngleH;
        sam.prevLosAngleV = losAngleV;

        // PN acceleration commands
        const N = cfg.nav_gain;
        const closingVel = sam.speed;
        const acmdH = N * closingVel * losRateH;
        const acmdV = N * closingVel * losRateV;

        const maxAccel = cfg.max_g * G;
        const accH = Math.max(-maxAccel, Math.min(maxAccel, acmdH));
        const accV = Math.max(-maxAccel, Math.min(maxAccel, acmdV));

        const V = Math.max(sam.speed, 10);
        const dHeading = (accH / V) * RAD;  // deg/s
        const dGamma = (accV / V) * RAD;

        // Equations of motion
        const gammaRad = toRad(sam.gamma);
        const dV = (thrust - drag) / sam.mass - G * Math.sin(gammaRad);

        // Integrate
        sam.speed += dV * dt;
        sam.speed = Math.max(50, Math.min(cfg.max_speed, sam.speed));

        sam.heading = normAz(sam.heading + dHeading * dt);
        sam.gamma += dGamma * dt;
        sam.gamma = Math.max(-80, Math.min(80, sam.gamma));

        // Update position
        const hdgRad = toRad(sam.heading);
        const gRad = toRad(sam.gamma);
        const cosG = Math.cos(gRad);
        const sinG = Math.sin(gRad);
        const R = R_EARTH + sam.alt;
        const latRad = toRad(sam.lat);

        sam.lat += (V * cosG * Math.cos(hdgRad) / R) * RAD * dt;
        sam.lon += (V * cosG * Math.sin(hdgRad) / (R * Math.cos(latRad))) * RAD * dt;
        sam.alt += V * sinG * dt;

        // Trail
        if (sam.trail.length === 0 || sam.flightTime % 0.3 < dt) {
            sam.trail.push({ lat: sam.lat, lon: sam.lon, alt: sam.alt });
            if (sam.trail.length > 300) sam.trail.shift();
        }

        // --- Hit/Miss Detection ---
        if (slantRange < cfg.kill_radius) {
            sam.state = 'HIT';
            sam.interceptLat = target.lat;
            sam.interceptLon = target.lon;
            sam.interceptAlt = target.alt;
            return;
        }

        if (slantRange < 1000) {
            sam.state = 'TERMINAL';
        }

        // Miss conditions
        if (sam.flightTime > cfg.max_flight_time) {
            sam.state = 'MISS';
            sam.interceptLat = sam.lat;
            sam.interceptLon = sam.lon;
            sam.interceptAlt = sam.alt;
            return;
        }
        if (sam.alt < 0) {
            sam.state = 'MISS';
            return;
        }
        if (sam.speed < 80 && sam.burnTime <= 0) {
            sam.state = 'MISS';
            return;
        }
        // Range diverging after terminal
        if (sam.state === 'TERMINAL' && slantRange > 500) {
            sam.state = 'MISS';
            sam.interceptLat = sam.lat;
            sam.interceptLon = sam.lon;
            sam.interceptAlt = sam.alt;
            return;
        }
    }

    // ─── Public API ──────────────────────────────────────────────

    return {
        POSITIONS,
        RADAR_CONFIGS,
        SAM_CONFIG,
        PHASES,
        PHASE_COLORS,
        NM_TO_M,
        DEG,
        RAD,
        R_EARTH,
        G,
        createScenario,
        createRadar,
        createAircraft,
        createEngagement,
        updateRadarScan,
        checkDetection,
        updateAircraft,
        launchSAM,
        launchSalvo,
        stepSAM,
        distance,
        bearing,
        normAz,
        angleDiffDeg,
        atmosphereDensity,
    };
})();
