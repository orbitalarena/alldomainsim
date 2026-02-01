#!/usr/bin/env node
/**
 * Monte Carlo Bridge Server
 *
 * Accepts scenario JSON via HTTP POST, spawns the C++ mc_engine as a
 * child process, and returns the results. Supports both batch MC mode
 * and single replay generation.
 *
 * Endpoints:
 *   POST /api/mc/batch    - Run N MC iterations, return aggregated results
 *   POST /api/mc/replay   - Generate a single replay JSON
 *   GET  /api/mc/status   - Check if mc_engine binary exists and server is ready
 *
 * Usage:
 *   node mc_server.js [port]
 *   # Default port: 8001
 *
 * The Scenario Builder's MCPanel can POST to this server instead of
 * running slow JS Monte Carlo simulations in the browser.
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

// Locate mc_engine binary relative to this file
// This file is at: visualization/cesium/mc_server.js
// Binary is at:    build/bin/mc_engine
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MC_ENGINE = path.join(PROJECT_ROOT, 'build', 'bin', 'mc_engine');
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const TMP_DIR = os.tmpdir();

// Track active jobs
const activeJobs = new Map();
let jobCounter = 0;

// ── Utility ──

function generateId() {
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

// ── Verify mc_engine exists ──
function engineExists() {
    try {
        fs.accessSync(MC_ENGINE, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// ── Run mc_engine as child process ──

/**
 * Run a batch MC simulation.
 * @param {object} scenario - Scenario JSON object
 * @param {object} opts - { runs, seed, maxTime, dt, verbose }
 * @returns {Promise<object>} - Parsed results JSON
 */
function runBatchMC(scenario, opts) {
    return new Promise((resolve, reject) => {
        const scenarioFile = tempFile('mc_scenario', '.json');
        const outputFile = tempFile('mc_results', '.json');

        // Write scenario to temp file
        fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));

        const args = [
            '--scenario', scenarioFile,
            '--runs', String(opts.runs || 100),
            '--seed', String(opts.seed || 42),
            '--max-time', String(opts.maxTime || 600),
            '--dt', String(opts.dt || 0.1),
            '--output', outputFile
        ];

        if (opts.verbose) args.push('--verbose');

        const startTime = Date.now();
        const proc = spawn(MC_ENGINE, args, {
            cwd: path.dirname(MC_ENGINE),
            timeout: 300000 // 5 minute timeout
        });

        let stderr = '';
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        proc.stdout.on('data', chunk => { stderr += chunk.toString(); }); // mc_engine logs to stdout

        proc.on('close', (code) => {
            const elapsed = (Date.now() - startTime) / 1000;

            // Clean up scenario temp file
            try { fs.unlinkSync(scenarioFile); } catch {}

            if (code !== 0) {
                try { fs.unlinkSync(outputFile); } catch {}
                reject(new Error(`mc_engine exited with code ${code}: ${stderr.slice(0, 500)}`));
                return;
            }

            // Read results
            try {
                const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
                fs.unlinkSync(outputFile);
                data._serverMeta = { elapsed, engine: 'c++', runs: opts.runs };
                resolve(data);
            } catch (e) {
                try { fs.unlinkSync(outputFile); } catch {}
                reject(new Error('Failed to parse mc_engine output: ' + e.message));
            }
        });

        proc.on('error', (err) => {
            try { fs.unlinkSync(scenarioFile); } catch {}
            reject(new Error('Failed to spawn mc_engine: ' + err.message));
        });
    });
}

/**
 * Generate a single replay.
 * @param {object} scenario - Scenario JSON object
 * @param {object} opts - { seed, maxTime, dt, sampleInterval }
 * @returns {Promise<object>} - Parsed replay JSON
 */
function runReplay(scenario, opts) {
    return new Promise((resolve, reject) => {
        const scenarioFile = tempFile('mc_scenario', '.json');
        const outputFile = tempFile('mc_replay', '.json');

        fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));

        const args = [
            '--replay',
            '--scenario', scenarioFile,
            '--seed', String(opts.seed || 42),
            '--max-time', String(opts.maxTime || 600),
            '--dt', String(opts.dt || 0.1),
            '--sample-interval', String(opts.sampleInterval || 2),
            '--output', outputFile
        ];

        if (opts.verbose) args.push('--verbose');

        const startTime = Date.now();
        const proc = spawn(MC_ENGINE, args, {
            cwd: path.dirname(MC_ENGINE),
            timeout: 60000
        });

        let stderr = '';
        proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
        proc.stdout.on('data', chunk => { stderr += chunk.toString(); });

        proc.on('close', (code) => {
            const elapsed = (Date.now() - startTime) / 1000;
            try { fs.unlinkSync(scenarioFile); } catch {}

            if (code !== 0) {
                try { fs.unlinkSync(outputFile); } catch {}
                reject(new Error(`mc_engine exited with code ${code}: ${stderr.slice(0, 500)}`));
                return;
            }

            try {
                const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
                fs.unlinkSync(outputFile);
                data._serverMeta = { elapsed, engine: 'c++' };
                resolve(data);
            } catch (e) {
                try { fs.unlinkSync(outputFile); } catch {}
                reject(new Error('Failed to parse replay output: ' + e.message));
            }
        });

        proc.on('error', (err) => {
            try { fs.unlinkSync(scenarioFile); } catch {}
            reject(new Error('Failed to spawn mc_engine: ' + err.message));
        });
    });
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
    corsHeaders(res);

    // Handle CORS preflight
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
                version: 'mc_engine v1.0'
            });
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
                dt: payload.dt || 0.1,
                verbose: payload.verbose || false
            };

            console.log(`[MC] Batch: ${opts.runs} runs, seed=${opts.seed}, maxTime=${opts.maxTime}s`);

            const results = await runBatchMC(scenario, opts);
            console.log(`[MC] Batch complete in ${results._serverMeta.elapsed.toFixed(2)}s`);
            jsonResponse(res, 200, results);
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
                sampleInterval: payload.sampleInterval || 2,
                verbose: payload.verbose || false
            };

            console.log(`[MC] Replay: seed=${opts.seed}, maxTime=${opts.maxTime}s`);

            const replay = await runReplay(scenario, opts);
            console.log(`[MC] Replay complete in ${replay._serverMeta.elapsed.toFixed(2)}s`);
            jsonResponse(res, 200, replay);
            return;
        }

        // 404
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
    console.log('  POST /api/mc/batch   — Run N MC iterations');
    console.log('  POST /api/mc/replay  — Generate single replay');
    console.log('  GET  /api/mc/status  — Check engine availability');
});
