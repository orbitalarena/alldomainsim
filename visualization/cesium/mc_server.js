#!/usr/bin/env node
/**
 * Monte Carlo Bridge Server
 *
 * Accepts scenario JSON via HTTP POST, spawns the C++ mc_engine as a
 * child process, and returns the results. Supports both batch MC mode
 * and single replay generation.
 *
 * Endpoints:
 *   POST /api/mc/batch    - Start N MC iterations, return { jobId } for polling
 *   POST /api/mc/replay   - Start single replay, return { jobId } for polling
 *   POST /api/mc/doe      - Start DOE parameter sweep (multiple arena configs)
 *   GET  /api/mc/jobs/:id - Poll job status/progress/results
 *   GET  /api/mc/status   - Check if mc_engine binary exists and server is ready
 *
 * The browser polls GET /api/mc/jobs/:id every 500ms to get real-time progress
 * from the C++ engine's --progress JSON-Lines output.
 *
 * Usage:
 *   node mc_server.js [port]
 *   # Default port: 8001
 */

'use strict';

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── Configuration ──
const PORT = parseInt(process.argv[2] || '8001', 10);

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MC_ENGINE = path.join(PROJECT_ROOT, 'build', 'bin', 'mc_engine');
const TMP_DIR = os.tmpdir();

// ── Job Store ──
const jobs = new Map();
let jobCounter = 0;

const JOB_CLEANUP_MS = 30 * 60 * 1000; // 30 minutes

// ── Utility ──

function generateJobId() {
    return 'mc_' + (++jobCounter) + '_' + crypto.randomBytes(4).toString('hex');
}

function tempFile(prefix, ext) {
    return path.join(TMP_DIR, prefix + '_' + crypto.randomBytes(6).toString('hex') + ext);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}

function jsonResponse(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

function corsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function engineExists() {
    try {
        fs.accessSync(MC_ENGINE, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// ── Parse stderr JSON-Lines for progress ──

function parseProgressLine(line, job) {
    // Only parse lines that look like JSON objects
    line = line.trim();
    if (!line.startsWith('{')) return;

    try {
        const msg = JSON.parse(line);
        if (msg.type === 'run_complete') {
            job.progress = {
                completed: msg.run,
                total: msg.total,
                pct: Math.round((msg.run / msg.total) * 100)
            };
        } else if (msg.type === 'replay_progress') {
            job.progress = {
                step: msg.step,
                totalSteps: msg.totalSteps,
                simTime: msg.simTime,
                pct: Math.round((msg.step / msg.totalSteps) * 100)
            };
        } else if (msg.type === 'done') {
            job.progress.pct = 100;
            job.progress.elapsed = msg.elapsed;
        }
    } catch {
        // Not valid JSON — skip (e.g. [EVENT] lines)
    }
}

// ── Launch mc_engine as a job ──

function startJob(mode, scenario, opts) {
    const jobId = generateJobId();
    const scenarioFile = tempFile('mc_scenario', '.json');
    const outputFile = tempFile(mode === 'batch' ? 'mc_results' : 'mc_replay', '.json');

    fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));

    const args = ['--scenario', scenarioFile, '--progress', '--output', outputFile];

    if (mode === 'batch') {
        args.push('--runs', String(opts.runs || 100));
        args.push('--seed', String(opts.seed !== undefined ? opts.seed : 42));
        args.push('--max-time', String(opts.maxTime || 600));
        args.push('--dt', String(opts.dt || 0.1));
    } else {
        args.push('--replay');
        args.push('--seed', String(opts.seed !== undefined ? opts.seed : 42));
        args.push('--max-time', String(opts.maxTime || 600));
        args.push('--dt', String(opts.dt || 0.1));
        args.push('--sample-interval', String(opts.sampleInterval || 2));
    }

    const job = {
        id: jobId,
        mode: mode,
        status: 'running',
        progress: { pct: 0 },
        results: null,
        error: null,
        startTime: Date.now(),
        scenarioFile: scenarioFile,
        outputFile: outputFile
    };

    jobs.set(jobId, job);

    const proc = spawn(MC_ENGINE, args, {
        cwd: path.dirname(MC_ENGINE),
        timeout: mode === 'batch' ? 300000 : 60000
    });

    let stderrBuf = '';

    proc.stderr.on('data', chunk => {
        stderrBuf += chunk.toString();
        // Process complete lines
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop(); // Keep incomplete last line in buffer
        for (const line of lines) {
            parseProgressLine(line, job);
        }
    });

    proc.stdout.on('data', () => {});  // Drain stdout

    proc.on('close', (code) => {
        const elapsed = (Date.now() - job.startTime) / 1000;

        // Process any remaining stderr
        if (stderrBuf.trim()) {
            parseProgressLine(stderrBuf, job);
        }

        // Clean up scenario temp file
        try { fs.unlinkSync(scenarioFile); } catch {}

        if (code !== 0) {
            job.status = 'failed';
            job.error = `mc_engine exited with code ${code}`;
            try { fs.unlinkSync(outputFile); } catch {}
            console.log(`[MC] Job ${jobId} failed (code ${code})`);
        } else {
            try {
                const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
                fs.unlinkSync(outputFile);
                data._serverMeta = { elapsed, engine: 'c++', mode: mode };
                if (mode === 'batch') data._serverMeta.runs = opts.runs;
                job.results = data;
                job.status = 'complete';
                job.progress.pct = 100;
                console.log(`[MC] Job ${jobId} complete in ${elapsed.toFixed(2)}s`);
            } catch (e) {
                job.status = 'failed';
                job.error = 'Failed to parse output: ' + e.message;
                try { fs.unlinkSync(outputFile); } catch {}
                console.log(`[MC] Job ${jobId} parse error: ${e.message}`);
            }
        }

        // Schedule cleanup
        setTimeout(() => { jobs.delete(jobId); }, JOB_CLEANUP_MS);
    });

    proc.on('error', (err) => {
        job.status = 'failed';
        job.error = 'Failed to spawn mc_engine: ' + err.message;
        try { fs.unlinkSync(scenarioFile); } catch {}
        setTimeout(() => { jobs.delete(jobId); }, JOB_CLEANUP_MS);
    });

    console.log(`[MC] Job ${jobId} started (${mode}, ${mode === 'batch' ? opts.runs + ' runs' : 'replay'})`);
    return jobId;
}

// ── Orbital Arena Scenario Generator (mirrors browser OrbitalArena.generate) ──

function generateArenaScenario(config) {
    const GEO_SMA = 42164000;
    const GEO_ALT = 35786000;
    const GEO_SPEED = 3075;

    const seed = config.seed !== undefined ? config.seed : (Date.now() & 0x7FFFFFFF);
    let state = seed | 0;
    if (state === 0) state = 1;
    function rand() {
        state |= 0;
        state = state + 0x6D2B79F5 | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // Support smaKm (km from DOE panel) or sma (meters from direct config)
    const smaFromKm = config.smaKm ? config.smaKm * 1000 : null;
    const c = {
        hvaPerSide: config.hvaPerSide || 0,
        defendersPerSide: config.defendersPerSide || 0,
        attackersPerSide: config.attackersPerSide || 0,
        escortsPerSide: config.escortsPerSide || 0,
        sweepsPerSide: config.sweepsPerSide || 0,
        sma: smaFromKm || config.sma || GEO_SMA,
        inc: config.incDeg !== undefined ? config.incDeg : (config.inc || 0.001),
        engRangeKm: config.engRangeKm || 0,
        weaponType: config.weaponType || 'kkv',
        Pk: config.Pk !== undefined ? config.Pk : 0.7,
        maxAccel: config.maxAccel || 50.0,
        sensorRange: config.sensorRange || 1000000,
        defenseRadius: config.defenseRadius || 500000,
        killRange: config.killRange || 50000,
        scanInterval: config.scanInterval || 1.0,
        maxSimTime: config.maxSimTime || 600
    };

    function pad(n) {
        if (n < 10) return '00' + n;
        if (n < 100) return '0' + n;
        return '' + n;
    }

    // Compute altitude and speed from SMA
    const actualAlt = c.sma - 6378000;  // altitude above surface
    const actualSpeed = Math.sqrt(3.986004418e14 / c.sma); // circular orbit speed
    const incRad = c.inc * Math.PI / 180;  // inclination in radians (for entity state)

    function makeEntity(id, name, team, role, ma, assignedHvaId) {
        ma = ((ma % 360) + 360) % 360;
        let lon = ma > 180 ? ma - 360 : ma;

        // If engRangeKm > 0, offset red team by that angular distance from blue team
        // This is handled at the caller level by shifting mean anomalies

        const ent = {
            id, name, type: 'satellite', team,
            initialState: {
                lat: 0, lon, alt: actualAlt, speed: actualSpeed,
                heading: 90, gamma: 0, throttle: 0, engineOn: false,
                gearDown: false, infiniteFuel: true
            },
            components: {
                physics: {
                    type: 'orbital_2body', source: 'elements',
                    sma: c.sma, ecc: 0.0001, inc: c.inc,
                    raan: 0, argPerigee: 0, meanAnomaly: ma
                },
                ai: {
                    type: 'orbital_combat', role,
                    sensorRange: c.sensorRange, defenseRadius: c.defenseRadius,
                    maxAccel: c.maxAccel, killRange: c.killRange, scanInterval: c.scanInterval
                },
                visual: { type: 'cesium_entity' }
            }
        };
        if (assignedHvaId) ent.components.ai.assignedHvaId = assignedHvaId;
        if (role !== 'hva') {
            // Weapon type selection from DOE parameter
            if (c.weaponType === 'a2a') {
                ent.components.weapons = {
                    type: 'a2a_missile', Pk: c.Pk, maxRange: c.killRange, cooldown: 5.0,
                    inventory: 4
                };
            } else if (c.weaponType === 'sam') {
                ent.components.weapons = {
                    type: 'sam_battery', Pk: c.Pk, maxRange: c.killRange, cooldown: 5.0,
                    salvoSize: 2
                };
            } else {
                // Default: KKV
                ent.components.weapons = {
                    type: 'kinetic_kill', Pk: c.Pk, killRange: c.killRange, cooldown: 5.0
                };
            }
        }
        return ent;
    }

    const entities = [];
    const hvaIds = { blue: [], red: [] };

    // Engagement range: angular separation (degrees) between blue and red clusters
    // engRangeKm is the separation distance in km. Convert to angular separation at SMA altitude.
    // arc length = angle(rad) * sma => angle(deg) = (dist_m / sma) * (180/PI)
    let engOffsetDeg = 0;
    if (c.engRangeKm > 0) {
        engOffsetDeg = (c.engRangeKm * 1000 / c.sma) * (180 / Math.PI);
    }

    // Blue entities are centered around 0-180 deg, red entities offset by engOffsetDeg
    // HVAs
    for (let i = 0; i < c.hvaPerSide; i++) {
        const bid = 'blue-hva-' + pad(i + 1);
        const rid = 'red-hva-' + pad(i + 1);
        hvaIds.blue.push(bid);
        hvaIds.red.push(rid);
        const blueMa = rand() * 180;  // blue in 0-180 range
        const redMa = blueMa + 180 + engOffsetDeg + (rand() - 0.5) * 20;  // red opposite + offset
        entities.push(makeEntity(bid, 'Blue-HVA-' + pad(i + 1), 'blue', 'hva', blueMa, null));
        entities.push(makeEntity(rid, 'Red-HVA-' + pad(i + 1), 'red', 'hva', redMa, null));
    }

    // Defenders (near assigned HVA)
    for (let d = 0; d < c.defendersPerSide; d++) {
        const bHva = hvaIds.blue.length > 0 ? hvaIds.blue[d % hvaIds.blue.length] : null;
        const rHva = hvaIds.red.length > 0 ? hvaIds.red[d % hvaIds.red.length] : null;
        const bHvEnt = bHva ? entities.find(e => e.id === bHva) : null;
        const rHvEnt = rHva ? entities.find(e => e.id === rHva) : null;
        const bma = bHvEnt ? bHvEnt.components.physics.meanAnomaly + (rand() - 0.5) * 10 : rand() * 180;
        const rma = rHvEnt ? rHvEnt.components.physics.meanAnomaly + (rand() - 0.5) * 10 :
            rand() * 180 + 180 + engOffsetDeg;
        entities.push(makeEntity('blue-def-' + pad(d + 1), 'Blue-DEF-' + pad(d + 1), 'blue', 'defender', bma, bHva));
        entities.push(makeEntity('red-def-' + pad(d + 1), 'Red-DEF-' + pad(d + 1), 'red', 'defender', rma, rHva));
    }

    // Attackers
    for (let a = 0; a < c.attackersPerSide; a++) {
        const blueMa = rand() * 180;
        const redMa = blueMa + 180 + engOffsetDeg + (rand() - 0.5) * 20;
        entities.push(makeEntity('blue-atk-' + pad(a + 1), 'Blue-ATK-' + pad(a + 1), 'blue', 'attacker', blueMa, null));
        entities.push(makeEntity('red-atk-' + pad(a + 1), 'Red-ATK-' + pad(a + 1), 'red', 'attacker', redMa, null));
    }

    // Escorts
    for (let e = 0; e < c.escortsPerSide; e++) {
        const blueMa = rand() * 180;
        const redMa = blueMa + 180 + engOffsetDeg + (rand() - 0.5) * 20;
        entities.push(makeEntity('blue-esc-' + pad(e + 1), 'Blue-ESC-' + pad(e + 1), 'blue', 'escort', blueMa, null));
        entities.push(makeEntity('red-esc-' + pad(e + 1), 'Red-ESC-' + pad(e + 1), 'red', 'escort', redMa, null));
    }

    // Sweeps
    for (let s = 0; s < c.sweepsPerSide; s++) {
        const blueMa = rand() * 180;
        const redMa = blueMa + 180 + engOffsetDeg + (rand() - 0.5) * 20;
        entities.push(makeEntity('blue-swp-' + pad(s + 1), 'Blue-SWP-' + pad(s + 1), 'blue', 'sweep', blueMa, null));
        entities.push(makeEntity('red-swp-' + pad(s + 1), 'Red-SWP-' + pad(s + 1), 'red', 'sweep', redMa, null));
    }

    return {
        metadata: {
            name: `DOE Arena (seed=${seed})`,
            description: `${entities.length / 2}v${entities.length / 2} GEO combat`,
            version: '2.0'
        },
        environment: { maxTimeWarp: 64 },
        entities,
        events: [],
        camera: { target: hvaIds.blue[0] || entities[0]?.id, range: 500000, pitch: -0.5 }
    };
}

// ── DOE Job Runner — runs permutations sequentially ──

function startDOEJob(permutations, seed, maxTime, arenaConfig) {
    const jobId = generateJobId();
    const total = permutations.length;

    const job = {
        id: jobId,
        mode: 'doe',
        status: 'running',
        progress: { completed: 0, total, pct: 0 },
        results: null,
        error: null,
        startTime: Date.now()
    };

    jobs.set(jobId, job);
    console.log(`[DOE] Job ${jobId} started (${total} permutations)`);

    const permResults = [];

    async function runNext(index) {
        if (job.status !== 'running') return; // cancelled

        if (index >= total) {
            // All permutations complete
            const elapsed = (Date.now() - job.startTime) / 1000;
            job.results = {
                permutations: permResults,
                seed,
                maxTime,
                totalElapsed: elapsed
            };
            job.status = 'complete';
            job.progress = { completed: total, total, pct: 100 };
            console.log(`[DOE] Job ${jobId} complete: ${total} permutations in ${elapsed.toFixed(1)}s`);
            setTimeout(() => { jobs.delete(jobId); }, JOB_CLEANUP_MS);
            return;
        }

        const perm = permutations[index];
        const config = Object.assign({}, arenaConfig || {}, perm, { seed });
        const scenario = generateArenaScenario(config);

        const scenarioFile = tempFile('doe_scenario', '.json');
        const outputFile = tempFile('doe_result', '.json');

        fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));

        const args = [
            '--scenario', scenarioFile,
            '--runs', '1',
            '--seed', String(seed),
            '--max-time', String(maxTime || 600),
            '--dt', '0.1',
            '--output', outputFile
        ];

        const proc = spawn(MC_ENGINE, args, {
            cwd: path.dirname(MC_ENGINE),
            timeout: 120000
        });

        proc.stdout.on('data', () => {});
        proc.stderr.on('data', () => {});

        proc.on('close', (code) => {
            try { fs.unlinkSync(scenarioFile); } catch {}

            let result = null;
            if (code === 0) {
                try {
                    result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
                    fs.unlinkSync(outputFile);
                } catch (e) {
                    console.log(`[DOE] Perm ${index} parse error: ${e.message}`);
                    try { fs.unlinkSync(outputFile); } catch {}
                }
            } else {
                console.log(`[DOE] Perm ${index} failed (code ${code})`);
                try { fs.unlinkSync(outputFile); } catch {}
            }

            var permConfig = {
                    hvaPerSide: perm.hvaPerSide,
                    defendersPerSide: perm.defendersPerSide,
                    attackersPerSide: perm.attackersPerSide,
                    escortsPerSide: perm.escortsPerSide,
                    sweepsPerSide: perm.sweepsPerSide
                };
            // Include advanced DOE parameters if present
            if (perm.smaKm !== undefined) permConfig.smaKm = perm.smaKm;
            if (perm.incDeg !== undefined) permConfig.incDeg = perm.incDeg;
            if (perm.engRangeKm !== undefined) permConfig.engRangeKm = perm.engRangeKm;
            if (perm.weaponType !== undefined) permConfig.weaponType = perm.weaponType;

            permResults.push({
                permId: index,
                config: permConfig,
                results: result
            });

            job.progress = {
                completed: index + 1,
                total,
                pct: Math.round(((index + 1) / total) * 100)
            };

            // Run next permutation
            runNext(index + 1);
        });

        proc.on('error', (err) => {
            console.log(`[DOE] Perm ${index} spawn error: ${err.message}`);
            try { fs.unlinkSync(scenarioFile); } catch {}
            permResults.push({
                permId: index,
                config: perm,
                results: null
            });
            job.progress = {
                completed: index + 1,
                total,
                pct: Math.round(((index + 1) / total) * 100)
            };
            runNext(index + 1);
        });
    }

    // Start the first permutation
    runNext(0);
    return jobId;
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
    corsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        // GET /api/mc/status
        if (req.method === 'GET' && req.url === '/api/mc/status') {
            const exists = engineExists();
            jsonResponse(res, 200, {
                ready: exists,
                engine: MC_ENGINE,
                exists: exists,
                version: 'mc_engine v2.0',
                activeJobs: jobs.size
            });
            return;
        }

        // GET /api/mc/jobs/:id
        const jobMatch = req.method === 'GET' && req.url.match(/^\/api\/mc\/jobs\/([a-zA-Z0-9_]+)$/);
        if (jobMatch) {
            const jobId = jobMatch[1];
            const job = jobs.get(jobId);
            if (!job) {
                jsonResponse(res, 404, { error: 'Job not found: ' + jobId });
                return;
            }

            const response = {
                jobId: job.id,
                mode: job.mode,
                status: job.status,
                progress: job.progress,
                elapsed: (Date.now() - job.startTime) / 1000
            };

            if (job.status === 'complete') {
                response.results = job.results;
            } else if (job.status === 'failed') {
                response.error = job.error;
            }

            jsonResponse(res, 200, response);
            return;
        }

        // POST /api/mc/batch
        if (req.method === 'POST' && req.url === '/api/mc/batch') {
            if (!engineExists()) {
                jsonResponse(res, 503, {
                    error: 'mc_engine not found. Build with: cd build && cmake .. && ninja mc_engine'
                });
                return;
            }

            const body = await readBody(req);
            const payload = JSON.parse(body);

            const scenario = payload.scenario;
            if (!scenario || !scenario.entities) {
                jsonResponse(res, 400, { error: 'Missing scenario.entities' });
                return;
            }

            const opts = {
                runs: payload.runs || 100,
                seed: payload.seed !== undefined ? payload.seed : 42,
                maxTime: payload.maxTime || 600,
                dt: payload.dt || 0.1
            };

            const jobId = startJob('batch', scenario, opts);
            jsonResponse(res, 202, { jobId: jobId, status: 'running' });
            return;
        }

        // POST /api/mc/doe
        if (req.method === 'POST' && req.url === '/api/mc/doe') {
            if (!engineExists()) {
                jsonResponse(res, 503, {
                    error: 'mc_engine not found. Build with: cd build && cmake .. && ninja mc_engine'
                });
                return;
            }

            const body = await readBody(req);
            const payload = JSON.parse(body);

            const permutations = payload.permutations;
            if (!permutations || !Array.isArray(permutations) || permutations.length === 0) {
                jsonResponse(res, 400, { error: 'Missing or empty permutations array' });
                return;
            }

            if (permutations.length > 5000) {
                jsonResponse(res, 400, { error: 'Too many permutations (max 5000)' });
                return;
            }

            const jobId = startDOEJob(
                permutations,
                payload.seed !== undefined ? payload.seed : 42,
                payload.maxTime || 600,
                payload.arenaConfig || {}
            );

            jsonResponse(res, 202, { jobId, status: 'running', totalPermutations: permutations.length });
            return;
        }

        // POST /api/mc/replay
        if (req.method === 'POST' && req.url === '/api/mc/replay') {
            if (!engineExists()) {
                jsonResponse(res, 503, {
                    error: 'mc_engine not found. Build with: cd build && cmake .. && ninja mc_engine'
                });
                return;
            }

            const body = await readBody(req);
            const payload = JSON.parse(body);

            const scenario = payload.scenario;
            if (!scenario || !scenario.entities) {
                jsonResponse(res, 400, { error: 'Missing scenario.entities' });
                return;
            }

            const opts = {
                seed: payload.seed !== undefined ? payload.seed : 42,
                maxTime: payload.maxTime || 600,
                dt: payload.dt || 0.1,
                sampleInterval: payload.sampleInterval || 2
            };

            const jobId = startJob('replay', scenario, opts);
            jsonResponse(res, 202, { jobId: jobId, status: 'running' });
            return;
        }

        jsonResponse(res, 404, { error: 'Not found' });

    } catch (e) {
        console.error('[MC] Error:', e.message);
        jsonResponse(res, 500, { error: e.message });
    }
});

server.listen(PORT, () => {
    const exists = engineExists();
    console.log(`Monte Carlo Bridge Server running on http://localhost:${PORT}`);
    console.log(`  Engine: ${MC_ENGINE}`);
    console.log(`  Status: ${exists ? 'READY' : 'NOT FOUND — build with: cd build && cmake .. && ninja mc_engine'}`);
    console.log('');
    console.log('  POST /api/mc/batch       — Start batch MC (returns jobId)');
    console.log('  POST /api/mc/replay      — Start replay gen (returns jobId)');
    console.log('  POST /api/mc/doe         — Start DOE parameter sweep (returns jobId)');
    console.log('  GET  /api/mc/jobs/:id    — Poll job progress/results');
    console.log('  GET  /api/mc/status      — Check engine availability');
});
