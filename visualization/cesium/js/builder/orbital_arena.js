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

    return {
        generate: generate,
        generateSmall: generateSmall
    };
})();
