/**
 * MCRunner — Monte Carlo batch simulation runner.
 *
 * Runs N headless simulations of a scenario with different RNG seeds,
 * collecting engagement logs and entity survival data for statistical analysis.
 *
 * Each run builds a fresh headless World (no Cesium viewer), sets a
 * deterministic seed (baseSeed + runIndex), and ticks the simulation
 * in chunked steps to avoid blocking the browser event loop.
 *
 * Usage:
 *   var results = await MCRunner.start({
 *       scenarioData: parsedJSON,
 *       numRuns: 100,
 *       baseSeed: 42,
 *       maxSimTime: 600,
 *       onProgress: function(completed, total, pct) { ... },
 *       onComplete: function(results) { ... }
 *   });
 *
 *   MCRunner.cancel();       // abort in-progress batch
 *   MCRunner.isRunning();    // true if batch is active
 *   MCRunner.getResults();   // most recent results array
 */
var MCRunner = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------
    var HEADLESS_DT = 0.1;          // sim time step (100ms fixed dt)
    var STEPS_PER_CHUNK = 200;      // steps before yielding to browser
    var YIELD_DELAY_MS = 0;         // setTimeout delay between chunks (0 = next microtask)
    var YIELD_BETWEEN_RUNS_MS = 4;  // delay between runs for progress bar updates

    // -------------------------------------------------------------------
    // Private State
    // -------------------------------------------------------------------
    var _running = false;
    var _cancelled = false;
    var _results = [];

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------

    /**
     * Run a batch of N headless simulations.
     * @param {object} config
     * @param {object}   config.scenarioData  - parsed scenario JSON
     * @param {number}   config.numRuns       - number of MC iterations (default 100)
     * @param {number}   config.baseSeed      - base RNG seed (default 42)
     * @param {number}   config.maxSimTime    - max sim seconds per run (default 600)
     * @param {function} config.onProgress    - callback(completed, total, pct)
     * @param {function} config.onComplete    - callback(results)
     * @returns {Promise<Array>} resolves with results array
     */
    function start(config) {
        if (_running) {
            return Promise.reject(new Error('MCRunner: batch already in progress'));
        }

        var scenarioData = config.scenarioData;
        var numRuns = config.numRuns || 100;
        var baseSeed = config.baseSeed !== undefined ? config.baseSeed : 42;
        var maxSimTime = config.maxSimTime || 600;
        var onProgress = config.onProgress || function() {};
        var onComplete = config.onComplete || function() {};

        _running = true;
        _cancelled = false;
        _results = [];

        return new Promise(function(resolve, reject) {
            _runBatch(scenarioData, numRuns, baseSeed, maxSimTime, onProgress, onComplete, resolve, reject);
        });
    }

    /**
     * Cancel an in-progress batch. The promise will reject.
     */
    function cancel() {
        if (_running) {
            _cancelled = true;
        }
    }

    /**
     * @returns {boolean} true if a batch is currently running
     */
    function isRunning() {
        return _running;
    }

    /**
     * @returns {Array} most recent results array (empty if none)
     */
    function getResults() {
        return _results;
    }

    // -------------------------------------------------------------------
    // Batch Execution
    // -------------------------------------------------------------------

    /**
     * Run all MC iterations sequentially, yielding between runs.
     */
    function _runBatch(scenarioData, numRuns, baseSeed, maxSimTime, onProgress, onComplete, resolve, reject) {
        var results = [];
        var currentRun = 0;

        function nextRun() {
            // Check cancellation
            if (_cancelled) {
                _running = false;
                _cancelled = false;
                reject(new Error('MCRunner: batch cancelled'));
                return;
            }

            // Check completion
            if (currentRun >= numRuns) {
                _results = results;
                _running = false;
                onComplete(results);
                resolve(results);
                return;
            }

            var runIndex = currentRun;
            var seed = baseSeed + runIndex;

            _runSingleAsync(scenarioData, runIndex, seed, maxSimTime, function(result) {
                // onDone callback
                results.push(result);
                currentRun++;

                // Report progress
                var pct = Math.round((currentRun / numRuns) * 100);
                onProgress(currentRun, numRuns, pct);

                // Yield before next run so the browser can repaint progress
                setTimeout(nextRun, YIELD_BETWEEN_RUNS_MS);
            }, function() {
                // isCancelled check
                return _cancelled;
            });
        }

        // Start first run
        nextRun();
    }

    // -------------------------------------------------------------------
    // Single Headless Run
    // -------------------------------------------------------------------

    /**
     * Execute one headless simulation run asynchronously (chunked ticking).
     * @param {object}   scenarioData - parsed scenario JSON
     * @param {number}   runIndex     - index of this run (0-based)
     * @param {number}   seed         - RNG seed for this run
     * @param {number}   maxSimTime   - max sim seconds
     * @param {function} onDone       - callback(result)
     * @param {function} isCancelled  - returns true if batch was cancelled
     */
    function _runSingleAsync(scenarioData, runIndex, seed, maxSimTime, onDone, isCancelled) {
        var world = null;
        var engLog = [];
        var prevStates = {};  // deduplication map for engagement events
        var error = null;

        // 1. Build headless world
        try {
            world = ScenarioLoader.build(scenarioData, null);
        } catch (e) {
            console.warn('[MCRunner] Run ' + runIndex + ' build failed: ' + e.message);
            onDone({
                runIndex: runIndex,
                seed: seed,
                engagementLog: [],
                entitySurvival: {},
                simTimeFinal: 0,
                error: 'Build failed: ' + e.message
            });
            return;
        }

        // 2. Set deterministic RNG
        world.rng = new SimRNG(seed);

        // 3. Reset EventSystem firing state
        if (typeof EventSystem !== 'undefined' && EventSystem.reset) {
            EventSystem.reset();
        }

        // 4. Run chunked tick loop
        var totalSteps = Math.ceil(maxSimTime / HEADLESS_DT);
        var stepsDone = 0;

        function doChunk() {
            // Check cancellation
            if (isCancelled()) {
                return;  // batch-level cancel handles the rejection
            }

            try {
                var chunkEnd = Math.min(stepsDone + STEPS_PER_CHUNK, totalSteps);

                while (stepsDone < chunkEnd) {
                    // Advance sim time
                    world.simTime += HEADLESS_DT;

                    // Run all systems in order
                    for (var i = 0; i < world.systems.length; i++) {
                        world.systems[i].fn(HEADLESS_DT, world);
                    }

                    // Watch for engagement results
                    _watchEngagements(world, world.simTime, engLog, prevStates);

                    stepsDone++;

                    // Check early termination
                    if (_allCombatResolved(world)) {
                        stepsDone = totalSteps;  // break out of both loops
                        break;
                    }
                }
            } catch (e) {
                console.warn('[MCRunner] Run ' + runIndex + ' tick error at t=' +
                    world.simTime.toFixed(1) + ': ' + e.message);
                error = 'Tick error at t=' + world.simTime.toFixed(1) + ': ' + e.message;
                stepsDone = totalSteps;  // force completion
            }

            // Check if done
            if (stepsDone >= totalSteps) {
                // Collect results
                var survival = _collectSurvival(world);
                onDone({
                    runIndex: runIndex,
                    seed: seed,
                    engagementLog: engLog,
                    entitySurvival: survival,
                    simTimeFinal: world.simTime,
                    error: error
                });
                return;
            }

            // Yield to browser, then continue
            setTimeout(doChunk, YIELD_DELAY_MS);
        }

        // Start the first chunk
        doChunk();
    }

    // -------------------------------------------------------------------
    // Engagement Watching
    // -------------------------------------------------------------------

    /**
     * Monitor entity state for engagement results (KILL/MISS) and
     * state transitions (LAUNCH events).
     *
     * Simplified port of AnalysisOverlay._watchEngagements adapted for
     * headless MC runs. Uses a deduplication map (prevStates) keyed by
     * a composite string to ensure each engagement event is logged only once.
     *
     * @param {object} world      - the ECS World
     * @param {number} simTime    - current simulation time
     * @param {Array}  engLog     - engagement log array to push events to
     * @param {object} prevStates - deduplication state, persists across ticks
     */
    function _watchEngagements(world, simTime, engLog, prevStates) {
        world.entities.forEach(function(entity) {
            if (!entity.active && !entity.state._destroyed) return;

            var s = entity.state;
            var id = entity.id;

            // ---------------------------------------------------------------
            // SAM engagements (_samState / _engagements / _samEngagementResult)
            // ---------------------------------------------------------------
            if (s._samState !== undefined) {
                var samPrevKey = 'sam_state_' + id;
                var samPrevState = prevStates[samPrevKey] || 'IDLE';
                var samCurrentState = s._samState;

                // Detect LAUNCH: transition to ENGAGE (or ENGAGING)
                if ((samCurrentState === 'ENGAGE' || samCurrentState === 'ENGAGING') &&
                    samPrevState !== 'ENGAGE' && samPrevState !== 'ENGAGING') {
                    var launchKey = 'sam_launch_' + id + '_' + simTime.toFixed(1);
                    if (!prevStates[launchKey]) {
                        var targetId = s._samTargetId || 'unknown';
                        var targetEntity = world.getEntity(targetId);
                        var targetName = targetEntity ? targetEntity.name : targetId;

                        engLog.push({
                            time: simTime,
                            sourceId: id,
                            sourceName: entity.name,
                            sourceTeam: entity.team,
                            targetId: targetId,
                            targetName: targetName,
                            result: 'LAUNCH',
                            weaponType: 'SAM'
                        });
                        prevStates[launchKey] = true;
                    }
                }

                prevStates[samPrevKey] = samCurrentState;

                // Detect KILL/MISS from _engagements array
                if (s._engagements) {
                    for (var ei = 0; ei < s._engagements.length; ei++) {
                        var eng = s._engagements[ei];
                        if (eng.result === 'KILL' || eng.result === 'MISS') {
                            var dedupKey = id + '_' + eng.targetId + '_' + eng.result + '_' + (eng.time !== undefined ? eng.time.toFixed(1) : ei);
                            if (!prevStates[dedupKey]) {
                                var tgtEntity = world.getEntity(eng.targetId);
                                var tgtName = tgtEntity ? tgtEntity.name : (eng.targetId || 'unknown');
                                engLog.push({
                                    time: simTime,
                                    sourceId: id,
                                    sourceName: entity.name,
                                    sourceTeam: entity.team,
                                    targetId: eng.targetId,
                                    targetName: tgtName,
                                    result: eng.result,
                                    weaponType: 'SAM'
                                });
                                prevStates[dedupKey] = true;
                            }
                        }
                    }
                }

                // Also check _samEngagementResult (single-shot result field)
                if (s._samEngagementResult && s._samEngagementResult !== 'PENDING') {
                    var resultKey = 'sam_result_' + id + '_' + simTime.toFixed(1) + '_' + s._samEngagementResult;
                    if (!prevStates[resultKey]) {
                        var samTargetId = s._samTargetId || 'unknown';
                        var samTgtEntity = world.getEntity(samTargetId);
                        var samTgtName = samTgtEntity ? samTgtEntity.name : samTargetId;
                        engLog.push({
                            time: simTime,
                            sourceId: id,
                            sourceName: entity.name,
                            sourceTeam: entity.team,
                            targetId: samTargetId,
                            targetName: samTgtName,
                            result: s._samEngagementResult,
                            weaponType: 'SAM'
                        });
                        prevStates[resultKey] = true;
                    }
                }
            }

            // ---------------------------------------------------------------
            // A2A engagements (_a2aState / _a2aEngagements)
            // ---------------------------------------------------------------
            if (s._a2aState !== undefined) {
                var a2aPrevKey = 'a2a_state_' + id;
                var a2aPrevState = prevStates[a2aPrevKey] || 'SEARCHING';
                var a2aCurrentState = s._a2aState;

                // Detect LAUNCH: transition to ENGAGING
                if (a2aCurrentState === 'ENGAGING' && a2aPrevState !== 'ENGAGING') {
                    var a2aEngagements = s._a2aEngagements || [];
                    for (var ai = 0; ai < a2aEngagements.length; ai++) {
                        var a2aEng = a2aEngagements[ai];
                        if (a2aEng.state === 'GUIDE' || a2aEng.state === 'FIRE') {
                            var a2aLaunchKey = 'a2a_launch_' + id + '_' + a2aEng.targetId + '_' + simTime.toFixed(1);
                            if (!prevStates[a2aLaunchKey]) {
                                var a2aTarget = world.getEntity(a2aEng.targetId);
                                var a2aTargetName = a2aTarget ? a2aTarget.name : (a2aEng.targetId || 'unknown');
                                engLog.push({
                                    time: simTime,
                                    sourceId: id,
                                    sourceName: entity.name,
                                    sourceTeam: entity.team,
                                    targetId: a2aEng.targetId,
                                    targetName: a2aTargetName,
                                    result: 'LAUNCH',
                                    weaponType: a2aEng.weaponType || 'A2A'
                                });
                                prevStates[a2aLaunchKey] = true;
                            }
                        }
                    }
                }

                prevStates[a2aPrevKey] = a2aCurrentState;
            }

            // Check A2A engagement results (always, regardless of state transitions)
            if (s._a2aEngagements) {
                for (var ri = 0; ri < s._a2aEngagements.length; ri++) {
                    var a2aResult = s._a2aEngagements[ri];
                    if (a2aResult.result === 'KILL' || a2aResult.result === 'MISS') {
                        var a2aDedupKey = id + '_' + a2aResult.targetId + '_' + a2aResult.result + '_' + (a2aResult.time !== undefined ? a2aResult.time.toFixed(1) : ri);
                        if (!prevStates[a2aDedupKey]) {
                            var a2aResTarget = world.getEntity(a2aResult.targetId);
                            var a2aResTgtName = a2aResTarget ? a2aResTarget.name : (a2aResult.targetId || 'unknown');
                            engLog.push({
                                time: simTime,
                                sourceId: id,
                                sourceName: entity.name,
                                sourceTeam: entity.team,
                                targetId: a2aResult.targetId,
                                targetName: a2aResTgtName,
                                result: a2aResult.result,
                                weaponType: a2aResult.weaponType || 'A2A'
                            });
                            prevStates[a2aDedupKey] = true;
                        }
                    }
                }
            }

            // ---------------------------------------------------------------
            // Kinetic Kill engagements (_kkEngagements)
            // ---------------------------------------------------------------
            if (s._kkEngagements) {
                for (var ki = 0; ki < s._kkEngagements.length; ki++) {
                    var kkEng = s._kkEngagements[ki];
                    if (kkEng.result === 'KILL' || kkEng.result === 'MISS' || kkEng.result === 'LAUNCH') {
                        var kkDedupKey = 'kk_' + id + '_' + kkEng.targetId + '_' + kkEng.result + '_' + (kkEng.time !== undefined ? kkEng.time.toFixed(1) : ki);
                        if (!prevStates[kkDedupKey]) {
                            engLog.push({
                                time: kkEng.time || simTime,
                                sourceId: id,
                                sourceName: entity.name,
                                sourceTeam: entity.team,
                                targetId: kkEng.targetId,
                                targetName: kkEng.targetName || kkEng.targetId,
                                result: kkEng.result,
                                weaponType: 'KKV'
                            });
                            prevStates[kkDedupKey] = true;
                        }
                    }
                }
            }
        });
    }

    // -------------------------------------------------------------------
    // Early Termination
    // -------------------------------------------------------------------

    /**
     * Check if all combat has been resolved.
     * Returns true if all aircraft on any one team are destroyed,
     * meaning the fight is already decided.
     *
     * @param {object} world - the ECS World
     * @returns {boolean}
     */
    function _allCombatResolved(world) {
        var blueAlive = 0;
        var redAlive = 0;
        var blueTotal = 0;
        var redTotal = 0;

        // Orbital combat counters
        var blueHvaAlive = 0, redHvaAlive = 0;
        var blueCombatAlive = 0, redCombatAlive = 0;
        var hasSatCombat = false;

        world.entities.forEach(function(entity) {
            var alive = entity.active && !entity.state._destroyed;

            // Check for orbital combat roles
            var role = entity.state._orbCombatRole;
            if (role) {
                hasSatCombat = true;
                if (role === 'hva') {
                    if (entity.team === 'blue' && alive) blueHvaAlive++;
                    else if (entity.team === 'red' && alive) redHvaAlive++;
                } else {
                    if (entity.team === 'blue' && alive) blueCombatAlive++;
                    else if (entity.team === 'red' && alive) redCombatAlive++;
                }
            }

            // Original aircraft check
            if (entity.type === 'aircraft') {
                if (entity.team === 'blue') {
                    blueTotal++;
                    if (alive) blueAlive++;
                } else if (entity.team === 'red') {
                    redTotal++;
                    if (alive) redAlive++;
                }
            }
        });

        // Satellite combat: terminate if all HVAs on one side destroyed,
        // OR all combat units on one side destroyed (no more threats)
        if (hasSatCombat) {
            if (blueHvaAlive === 0 || redHvaAlive === 0) return true;
            if (blueCombatAlive === 0 && redCombatAlive === 0) return true;
        }

        // Aircraft combat (original logic)
        if (blueTotal > 0 && redTotal > 0) {
            if (blueAlive === 0 || redAlive === 0) return true;
        }

        return false;
    }

    // -------------------------------------------------------------------
    // Survival Collection
    // -------------------------------------------------------------------

    /**
     * Collect survival data for all entities in the world.
     *
     * @param {object} world - the ECS World
     * @returns {object} map of entityId -> { name, team, type, alive, destroyed }
     */
    function _collectSurvival(world) {
        var survival = {};

        world.entities.forEach(function(entity) {
            survival[entity.id] = {
                name: entity.name,
                team: entity.team,
                type: entity.type,
                role: entity.state._orbCombatRole || null,
                alive: entity.active && !entity.state._destroyed,
                destroyed: !entity.active || entity.state._destroyed === true
            };
        });

        return survival;
    }

    // -------------------------------------------------------------------
    // Module Export
    // -------------------------------------------------------------------
    return {
        start: start,
        cancel: cancel,
        isRunning: isRunning,
        getResults: getResults
    };

})();
