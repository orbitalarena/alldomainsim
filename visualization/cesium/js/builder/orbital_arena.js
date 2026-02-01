/**
 * OrbitalArena — programmatic scenario generator for GEO space combat.
 *
 * Generates a 1000-entity (default) scenario with two sides at GEO altitude.
 * Each side has HVAs (passive targets), Defenders, Attackers, Escorts, and Sweeps.
 * All combat units are kinetic kill vehicles (mutual destruction on impact).
 *
 * Uses a seeded PRNG (mulberry32) so each seed produces a different but
 * reproducible arrangement. Pass config.seed to control placement.
 *
 * Usage:
 *   var json = OrbitalArena.generate();              // random seed
 *   var json = OrbitalArena.generate({ seed: 7 });   // reproducible
 */
var OrbitalArena = (function() {
    'use strict';

    var GEO_SMA = 42164000;
    var GEO_ALT = 35786000;
    var GEO_SPEED = 3075;

    // -------------------------------------------------------------------
    // Seeded PRNG (mulberry32) — same algorithm as SimRNG
    // -------------------------------------------------------------------
    function _mulberry32(seed) {
        var state = seed | 0;
        if (state === 0) state = 1;
        return function() {
            state |= 0;
            state = state + 0x6D2B79F5 | 0;
            var t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // -------------------------------------------------------------------
    // Generate scenario
    // -------------------------------------------------------------------
    function generate(config) {
        config = config || {};

        // Seed: use provided seed, or derive from current time
        var seed = config.seed !== undefined ? config.seed : (Date.now() & 0x7FFFFFFF);
        var rand = _mulberry32(seed);

        var arcSpread = config.arcSpread || 360;   // degrees of GEO arc (360 = full belt)
        var arcCenter = config.arcCenter || 0;      // center longitude of arc

        var c = {
            hvaPerSide: config.hvaPerSide || 100,
            defendersPerSide: config.defendersPerSide || 100,
            attackersPerSide: config.attackersPerSide || 150,
            escortsPerSide: config.escortsPerSide || 100,
            sweepsPerSide: config.sweepsPerSide || 50,
            sma: config.sma || GEO_SMA,
            Pk: config.Pk !== undefined ? config.Pk : 0.7,
            maxAccel: config.maxAccel || 50.0,
            sensorRange: config.sensorRange || 1000000,
            defenseRadius: config.defenseRadius || 500000,
            killRange: config.killRange || 50000,
            scanInterval: config.scanInterval || 1.0,
            maxSimTime: config.maxSimTime || 600
        };

        // Helper: random mean anomaly within the configured arc
        function randMA() {
            return arcCenter + (rand() - 0.5) * arcSpread;
        }

        var entities = [];
        var blueHvaIds = [];
        var redHvaIds = [];

        // ---------------------------------------------------------------
        // HVAs — spread across full 360° belt, interleaved blue/red
        // ---------------------------------------------------------------
        for (var i = 0; i < c.hvaPerSide; i++) {
            // Blue HVAs: random positions around full 360°
            var blueMA = randMA();
            var blueId = 'blue-hva-' + _pad(i + 1);
            blueHvaIds.push(blueId);
            entities.push(_makeEntity(blueId, 'Blue-HVA-' + _pad(i + 1), 'blue', 'hva', c, blueMA, null));

            // Red HVAs: random positions around full 360°
            var redMA = randMA();
            var redId = 'red-hva-' + _pad(i + 1);
            redHvaIds.push(redId);
            entities.push(_makeEntity(redId, 'Red-HVA-' + _pad(i + 1), 'red', 'hva', c, redMA, null));
        }

        // ---------------------------------------------------------------
        // Defenders — placed near their assigned HVA (within ~5° offset)
        // ---------------------------------------------------------------
        for (var d = 0; d < c.defendersPerSide; d++) {
            var blueHva = blueHvaIds[d % blueHvaIds.length];
            // Find the HVA's meanAnomaly from the entity we already created
            var blueHvaDef = _findEntity(entities, blueHva);
            var blueHvaMA = blueHvaDef ? blueHvaDef.components.physics.meanAnomaly : randMA();
            var blueDefMA = blueHvaMA + (rand() - 0.5) * 10;  // ±5° of HVA
            entities.push(_makeEntity('blue-def-' + _pad(d + 1), 'Blue-DEF-' + _pad(d + 1), 'blue', 'defender', c, blueDefMA, blueHva));

            var redHva = redHvaIds[d % redHvaIds.length];
            var redHvaDef = _findEntity(entities, redHva);
            var redHvaMA = redHvaDef ? redHvaDef.components.physics.meanAnomaly : randMA();
            var redDefMA = redHvaMA + (rand() - 0.5) * 10;
            entities.push(_makeEntity('red-def-' + _pad(d + 1), 'Red-DEF-' + _pad(d + 1), 'red', 'defender', c, redDefMA, redHva));
        }

        // ---------------------------------------------------------------
        // Attackers — random across full belt
        // ---------------------------------------------------------------
        for (var a = 0; a < c.attackersPerSide; a++) {
            var blueAtkMA = randMA();
            entities.push(_makeEntity('blue-atk-' + _pad(a + 1), 'Blue-ATK-' + _pad(a + 1), 'blue', 'attacker', c, blueAtkMA, null));

            var redAtkMA = randMA();
            entities.push(_makeEntity('red-atk-' + _pad(a + 1), 'Red-ATK-' + _pad(a + 1), 'red', 'attacker', c, redAtkMA, null));
        }

        // ---------------------------------------------------------------
        // Escorts — random across full belt
        // ---------------------------------------------------------------
        for (var e = 0; e < c.escortsPerSide; e++) {
            var blueEscMA = randMA();
            entities.push(_makeEntity('blue-esc-' + _pad(e + 1), 'Blue-ESC-' + _pad(e + 1), 'blue', 'escort', c, blueEscMA, null));

            var redEscMA = randMA();
            entities.push(_makeEntity('red-esc-' + _pad(e + 1), 'Red-ESC-' + _pad(e + 1), 'red', 'escort', c, redEscMA, null));
        }

        // ---------------------------------------------------------------
        // Sweeps — random across full belt
        // ---------------------------------------------------------------
        for (var s = 0; s < c.sweepsPerSide; s++) {
            var blueSwpMA = randMA();
            entities.push(_makeEntity('blue-swp-' + _pad(s + 1), 'Blue-SWP-' + _pad(s + 1), 'blue', 'sweep', c, blueSwpMA, null));

            var redSwpMA = randMA();
            entities.push(_makeEntity('red-swp-' + _pad(s + 1), 'Red-SWP-' + _pad(s + 1), 'red', 'sweep', c, redSwpMA, null));
        }

        return {
            metadata: {
                name: 'Orbital Arena v1 (seed=' + seed + ')',
                description: (c.hvaPerSide + c.defendersPerSide + c.attackersPerSide + c.escortsPerSide + c.sweepsPerSide) +
                    'v' + (c.hvaPerSide + c.defendersPerSide + c.attackersPerSide + c.escortsPerSide + c.sweepsPerSide) +
                    ' GEO kinetic kill space combat. ' +
                    'Each side: ' + c.hvaPerSide + ' HVAs, ' +
                    c.defendersPerSide + ' Defenders, ' +
                    c.attackersPerSide + ' Attackers, ' +
                    c.escortsPerSide + ' Escorts, ' +
                    c.sweepsPerSide + ' Sweeps. Seed=' + seed,
                version: '2.0'
            },
            environment: {
                maxTimeWarp: 64
            },
            entities: entities,
            events: [],
            camera: {
                target: 'blue-hva-001',
                range: 500000,
                pitch: -0.5
            }
        };
    }

    // -------------------------------------------------------------------
    // Entity builder
    // -------------------------------------------------------------------
    function _makeEntity(id, name, team, role, c, meanAnomaly, assignedHvaId) {
        // Normalize meanAnomaly to [0, 360)
        var ma = ((meanAnomaly % 360) + 360) % 360;

        // For equatorial circular GEO orbits at simTime=0 (GMST=0),
        // longitude ≈ meanAnomaly. Set initialState.lon so BUILD mode
        // preview shows entities at the correct positions on the globe.
        var lon = ma;
        if (lon > 180) lon -= 360;  // normalize to [-180, 180] for Cesium

        var def = {
            id: id,
            name: name,
            type: 'satellite',
            team: team,
            initialState: {
                lat: 0,
                lon: lon,
                alt: GEO_ALT,
                speed: GEO_SPEED,
                heading: 90,
                gamma: 0,
                throttle: 0,
                engineOn: false,
                gearDown: false,
                infiniteFuel: true
            },
            components: {
                physics: {
                    type: 'orbital_2body',
                    source: 'elements',
                    sma: c.sma,
                    ecc: 0.0001,
                    inc: 0.001,
                    raan: 0,
                    argPerigee: 0,
                    meanAnomaly: ma
                },
                visual: {
                    type: 'cesium_entity'
                }
            }
        };

        // All entities get AI (HVAs need _orbCombatRole for MC early-termination).
        // Only combat units get weapons.
        def.components.ai = {
            type: 'orbital_combat',
            role: role,
            sensorRange: c.sensorRange,
            defenseRadius: c.defenseRadius,
            maxAccel: c.maxAccel,
            killRange: c.killRange,
            scanInterval: c.scanInterval
        };
        if (assignedHvaId) {
            def.components.ai.assignedHvaId = assignedHvaId;
        }
        if (role !== 'hva') {
            def.components.weapons = {
                type: 'kinetic_kill',
                Pk: c.Pk,
                killRange: c.killRange,
                cooldown: 5.0
            };
        }

        return def;
    }

    function _findEntity(entities, id) {
        for (var i = 0; i < entities.length; i++) {
            if (entities[i].id === id) return entities[i];
        }
        return null;
    }

    function _pad(n) {
        if (n < 10) return '00' + n;
        if (n < 100) return '0' + n;
        return '' + n;
    }

    // -------------------------------------------------------------------
    // Small variant — 50v50 in a tight 30° arc for guaranteed engagements
    // -------------------------------------------------------------------
    function generateSmall(config) {
        config = config || {};

        return generate({
            seed: config.seed,
            hvaPerSide: config.hvaPerSide || 10,
            defendersPerSide: config.defendersPerSide || 10,
            attackersPerSide: config.attackersPerSide || 15,
            escortsPerSide: config.escortsPerSide || 10,
            sweepsPerSide: config.sweepsPerSide || 5,
            arcSpread: config.arcSpread || 30,
            arcCenter: config.arcCenter || 0,
            sma: config.sma || GEO_SMA,
            Pk: config.Pk !== undefined ? config.Pk : 0.7,
            maxAccel: config.maxAccel || 50.0,
            sensorRange: config.sensorRange || 1000000,
            defenseRadius: config.defenseRadius || 500000,
            killRange: config.killRange || 50000,
            scanInterval: config.scanInterval || 1.0,
            maxSimTime: config.maxSimTime || 300
        });
    }

    // -------------------------------------------------------------------
    // Large variant — 850v850 across 4 orbital regimes
    // 1. LEO Sun-Synch: ~700km, inc=98.2° (nearly polar), full 360°
    // 2. GTO: perigee ~250km, apogee ~35,800km, inc=28.5°, full 360°
    // 3. GEO: ~42,164km circular equatorial, full 360°
    // 4. Lunar: ~200km above Moon surface, ring around Moon's position
    // -------------------------------------------------------------------

    /**
     * Convert true anomaly to mean anomaly for eccentric orbits.
     * Prevents visual clustering at apogee when e is large.
     */
    function _trueToMeanAnomaly(nuDeg, ecc) {
        var nu = nuDeg * Math.PI / 180;
        var E = 2 * Math.atan2(
            Math.sqrt(1 - ecc) * Math.sin(nu / 2),
            Math.sqrt(1 + ecc) * Math.cos(nu / 2)
        );
        var M = E - ecc * Math.sin(E);
        return ((M * 180 / Math.PI) % 360 + 360) % 360;
    }

    function generateLarge(config) {
        config = config || {};
        var seed = config.seed !== undefined ? config.seed : (Date.now() & 0x7FFFFFFF);
        var rand = _mulberry32(seed);

        var R_EARTH = 6371000;
        var R_MOON = 1737400;
        var MOON_DIST = 384400000;

        var ROLE_DEFS = [
            { role: 'hva', fraction: 0.2, hasWeapons: false },
            { role: 'defender', fraction: 0.2, hasWeapons: true, needsHva: true },
            { role: 'attacker', fraction: 0.3, hasWeapons: true },
            { role: 'escort', fraction: 0.2, hasWeapons: true, needsHva: true },
            { role: 'sweep', fraction: 0.1, hasWeapons: true }
        ];

        // Orbit definitions (non-lunar handled uniformly)
        var KEPLERIAN_ORBITS = [
            {
                label: 'LEO-SSO', sma: 7078000, ecc: 0.001, inc: 98.2, raan: 90, argPerigee: 0,
                perSide: 100, useTA: false,
                sensorRange: 500000, defenseRadius: 250000,
                killRange: 30000, maxAccel: 40.0, Pk: 0.65, cooldown: 4.0
            },
            {
                label: 'GTO', sma: 24400000, ecc: 0.7285, inc: 28.5, raan: 180, argPerigee: 178,
                perSide: 200, useTA: true,  // distribute by true anomaly
                sensorRange: 1200000, defenseRadius: 600000,
                killRange: 60000, maxAccel: 45.0, Pk: 0.6, cooldown: 6.0
            },
            {
                label: 'GEO', sma: 42164000, ecc: 0.0001, inc: 0.001, raan: 0, argPerigee: 0,
                perSide: 500, useTA: false,
                sensorRange: 1000000, defenseRadius: 500000,
                killRange: 50000, maxAccel: 50.0, Pk: 0.7, cooldown: 5.0
            }
        ];

        var entities = [];

        // ---- Generate Keplerian orbit entities (LEO, GTO, GEO) ----
        for (var oi = 0; oi < KEPLERIAN_ORBITS.length; oi++) {
            var orb = KEPLERIAN_ORBITS[oi];
            var hvaIds = { blue: [], red: [] };

            for (var ri = 0; ri < ROLE_DEFS.length; ri++) {
                var rd = ROLE_DEFS[ri];
                var perRole = Math.round(orb.perSide * rd.fraction);

                for (var ti = 0; ti < 2; ti++) {
                    var team = ti === 0 ? 'blue' : 'red';
                    for (var i = 0; i < perRole; i++) {
                        var idx = i + 1;
                        var id = team + '-' + orb.label.toLowerCase() + '-' + rd.role + '-' + _pad(idx);
                        var nm = team.charAt(0).toUpperCase() + team.slice(1) + '-' +
                            orb.label + '-' + rd.role.charAt(0).toUpperCase() + rd.role.slice(1) + '-' + _pad(idx);

                        var ma;
                        if (orb.useTA) {
                            // Uniform true anomaly → convert to mean anomaly
                            var trueAnom = rand() * 360;
                            ma = _trueToMeanAnomaly(trueAnom, orb.ecc);
                        } else {
                            ma = rand() * 360;
                        }

                        var lon = ma > 180 ? ma - 360 : ma;
                        var ent = {
                            id: id, name: nm, type: 'satellite', team: team,
                            initialState: {
                                lat: 0, lon: lon, alt: (orb.sma - R_EARTH),
                                speed: 0, heading: 90, gamma: 0,
                                throttle: 0, engineOn: false, gearDown: false, infiniteFuel: true
                            },
                            components: {
                                physics: {
                                    type: 'orbital_2body', source: 'elements',
                                    sma: orb.sma, ecc: orb.ecc, inc: orb.inc,
                                    raan: orb.raan, argPerigee: orb.argPerigee,
                                    meanAnomaly: Math.round(ma * 10000) / 10000
                                },
                                ai: {
                                    type: 'orbital_combat', role: rd.role,
                                    sensorRange: orb.sensorRange, defenseRadius: orb.defenseRadius,
                                    maxAccel: orb.maxAccel, killRange: orb.killRange, scanInterval: 1.0
                                },
                                visual: { type: 'cesium_entity' }
                            }
                        };
                        if (rd.role === 'hva') hvaIds[team].push(id);
                        if (rd.needsHva && hvaIds[team].length > 0) {
                            ent.components.ai.assignedHvaId = hvaIds[team][i % hvaIds[team].length];
                        }
                        if (rd.hasWeapons) {
                            ent.components.weapons = {
                                type: 'kinetic_kill', Pk: orb.Pk,
                                killRange: orb.killRange, cooldown: orb.cooldown
                            };
                        }
                        entities.push(ent);
                    }
                }
            }
        }

        // ---- Generate Lunar orbit entities (ring around Moon) ----
        // Moon approximate ECI position at t=0 (simplified)
        var moonTheta = 45 * Math.PI / 180;  // 45° from vernal equinox
        var moonInc = 5.14 * Math.PI / 180;
        var moonX = MOON_DIST * Math.cos(moonTheta);
        var moonY = MOON_DIST * Math.sin(moonTheta) * Math.cos(moonInc);
        var moonZ = MOON_DIST * Math.sin(moonTheta) * Math.sin(moonInc);

        var lunarOrbitR = R_MOON + 200000;  // 200km above surface
        var lunarPerSide = 50;
        var lunarHvaIds = { blue: [], red: [] };

        for (var lri = 0; lri < ROLE_DEFS.length; lri++) {
            var lrd = ROLE_DEFS[lri];
            var lPerRole = Math.round(lunarPerSide * lrd.fraction);

            for (var lti = 0; lti < 2; lti++) {
                var lteam = lti === 0 ? 'blue' : 'red';
                for (var li = 0; li < lPerRole; li++) {
                    var lidx = li + 1;
                    var lid = lteam + '-lunar-' + lrd.role + '-' + _pad(lidx);
                    var lnm = lteam.charAt(0).toUpperCase() + lteam.slice(1) + '-LUNAR-' +
                        lrd.role.charAt(0).toUpperCase() + lrd.role.slice(1) + '-' + _pad(lidx);

                    // Random angle in selenocentric orbit
                    var angle = rand() * 360 * Math.PI / 180;
                    var orbInc = 15 * Math.PI / 180;  // 15° lunar orbit inclination
                    var dx = lunarOrbitR * Math.cos(angle);
                    var dy = lunarOrbitR * Math.sin(angle) * Math.cos(orbInc);
                    var dz = lunarOrbitR * Math.sin(angle) * Math.sin(orbInc);

                    var gx = moonX + dx;
                    var gy = moonY + dy;
                    var gz = moonZ + dz;

                    // Geocentric distance → use as SMA for Kepler propagator
                    var gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
                    var glon = Math.atan2(gy, gx) * 180 / Math.PI;
                    var glat = Math.asin(gz / gr) * 180 / Math.PI;

                    // Mean anomaly from geocentric longitude relative to RAAN
                    var lunarRaan = 45;  // aligned with Moon position
                    var lma = ((glon - lunarRaan + 360) % 360);

                    var lent = {
                        id: lid, name: lnm, type: 'satellite', team: lteam,
                        initialState: {
                            lat: glat, lon: glon, alt: gr - R_EARTH,
                            speed: 0, heading: 90, gamma: 0,
                            throttle: 0, engineOn: false, gearDown: false, infiniteFuel: true
                        },
                        components: {
                            physics: {
                                type: 'orbital_2body', source: 'elements',
                                sma: Math.round(gr), ecc: 0.001, inc: 23.4,
                                raan: lunarRaan, argPerigee: 0,
                                meanAnomaly: Math.round(lma * 10000) / 10000
                            },
                            ai: {
                                type: 'orbital_combat', role: lrd.role,
                                sensorRange: 2000000, defenseRadius: 1000000,
                                maxAccel: 60.0, killRange: 100000, scanInterval: 1.0
                            },
                            visual: { type: 'cesium_entity' }
                        }
                    };
                    if (lrd.role === 'hva') lunarHvaIds[lteam].push(lid);
                    if (lrd.needsHva && lunarHvaIds[lteam].length > 0) {
                        lent.components.ai.assignedHvaId = lunarHvaIds[lteam][li % lunarHvaIds[lteam].length];
                    }
                    if (lrd.hasWeapons) {
                        lent.components.weapons = {
                            type: 'kinetic_kill', Pk: 0.75, killRange: 100000, cooldown: 8.0
                        };
                    }
                    entities.push(lent);
                }
            }
        }

        var perSide = entities.length / 2;
        return {
            metadata: {
                name: 'Orbital Arena Large (seed=' + seed + ')',
                description: perSide + 'v' + perSide +
                    ' multi-regime orbital combat: GEO (500v500), Sun-synch LEO (100v100), ' +
                    'GTO (200v200), Lunar orbit (50v50). Seed=' + seed,
                version: '2.0'
            },
            environment: { maxTimeWarp: 64 },
            entities: entities,
            events: [],
            camera: { target: 'blue-geo-hva-001', range: 500000, pitch: -0.5 }
        };
    }

    return {
        generate: generate,
        generateSmall: generateSmall,
        generateLarge: generateLarge
    };
})();
