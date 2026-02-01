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

const JOB_CLEANUP_MS = 5 * 60 * 1000; // 5 minutes

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
    console.log('  GET  /api/mc/jobs/:id    — Poll job progress/results');
    console.log('  GET  /api/mc/status      — Check engine availability');
});
