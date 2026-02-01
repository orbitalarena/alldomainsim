/**
 * DIS Manager — Session management for DIS protocol streaming and export.
 *
 * Provides two modes:
 *   - Streaming: Real-time WebSocket PDU streaming during RUN mode
 *   - Batch Export: Headless simulation run → binary DIS file
 *
 * Uses DISProtocol for binary PDU encoding.
 */
const DISManager = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------
    var _config = {
        exerciseId: 1,
        siteId: 1,
        appId: 1,
        pduRate: 5,                 // Entity State PDU rate in Hz
        multicastGroup: '239.1.2.3',
        multicastPort: 3000,
        wsUrl: null                 // auto-detect from window.location
    };

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _ws = null;
    var _streaming = false;
    var _world = null;
    var _entityIdMap = new Map();    // ECS entity id -> DIS entity id (uint16)
    var _nextDisEntityId = 1;
    var _stats = {
        pdusSent: 0,
        bytesTotal: 0,
        entitiesTracked: 0,
        uptime: 0,
        lastTick: 0
    };
    var _streamInterval = null;
    var _heartbeatInterval = null;
    var _statusCallback = null;     // called with 'connected' | 'disconnected' | 'error'

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /**
     * Initialize the DIS Manager with configuration.
     * @param {object} cfg  Optional configuration overrides
     */
    function init(cfg) {
        if (cfg) {
            for (var k in cfg) {
                if (_config.hasOwnProperty(k)) {
                    _config[k] = cfg[k];
                }
            }
        }
    }

    /**
     * Set status callback for UI indicator updates.
     * @param {function} cb  Called with status string
     */
    function onStatus(cb) {
        _statusCallback = cb;
    }

    function _notifyStatus(status) {
        if (_statusCallback) _statusCallback(status);
    }

    // -----------------------------------------------------------------------
    // Entity ID Management
    // -----------------------------------------------------------------------

    function _getDisEntityId(ecsId) {
        if (_entityIdMap.has(ecsId)) return _entityIdMap.get(ecsId);
        var disId = _nextDisEntityId++;
        _entityIdMap.set(ecsId, disId);
        return disId;
    }

    function _resetEntityIds() {
        _entityIdMap.clear();
        _nextDisEntityId = 1;
    }

    // -----------------------------------------------------------------------
    // WebSocket Connection
    // -----------------------------------------------------------------------

    function _getWsUrl() {
        if (_config.wsUrl) return _config.wsUrl;
        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return protocol + '//' + window.location.host + '/dis';
    }

    function _connectWebSocket() {
        return new Promise(function(resolve, reject) {
            try {
                var url = _getWsUrl();
                _ws = new WebSocket(url);
                _ws.binaryType = 'arraybuffer';

                _ws.onopen = function() {
                    console.log('DIS WebSocket connected:', url);
                    _notifyStatus('connected');
                    resolve();
                };

                _ws.onclose = function() {
                    console.log('DIS WebSocket closed');
                    _notifyStatus('disconnected');
                    _ws = null;
                };

                _ws.onerror = function(e) {
                    console.warn('DIS WebSocket error:', e);
                    _notifyStatus('error');
                    reject(new Error('WebSocket connection failed'));
                };
            } catch (e) {
                // WebSocket not available — fall back to HTTP
                console.warn('WebSocket not available, using HTTP fallback');
                _notifyStatus('http-fallback');
                resolve();
            }
        });
    }

    function _sendPDU(buffer) {
        if (_ws && _ws.readyState === WebSocket.OPEN) {
            _ws.send(buffer);
            _stats.pdusSent++;
            _stats.bytesTotal += buffer.byteLength;
            return true;
        }
        // HTTP fallback — batch and send via POST
        return _sendPDUHttp(buffer);
    }

    var _httpBatch = [];
    var _httpFlushTimer = null;

    function _sendPDUHttp(buffer) {
        _httpBatch.push(buffer);
        _stats.pdusSent++;
        _stats.bytesTotal += buffer.byteLength;

        // Flush every 200ms
        if (!_httpFlushTimer) {
            _httpFlushTimer = setTimeout(function() {
                _flushHttpBatch();
                _httpFlushTimer = null;
            }, 200);
        }
        return true;
    }

    function _flushHttpBatch() {
        if (_httpBatch.length === 0) return;
        var combined = DISProtocol.concatBuffers(_httpBatch);
        _httpBatch = [];

        fetch('/api/dis_poll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: combined
        }).catch(function(e) {
            // Silently fail — DIS streaming is best-effort
        });
    }

    // -----------------------------------------------------------------------
    // Streaming Mode
    // -----------------------------------------------------------------------

    /**
     * Start real-time DIS streaming.
     * Opens WebSocket and begins emitting Entity State PDUs at configured rate.
     * @param {object} world  ECS World instance
     * @returns {Promise}
     */
    function startStreaming(world) {
        if (_streaming) return Promise.resolve();
        _world = world;
        _resetEntityIds();
        _stats.pdusSent = 0;
        _stats.bytesTotal = 0;
        _stats.uptime = 0;
        _stats.lastTick = Date.now();

        _streaming = true;

        return _connectWebSocket().then(function() {
            // Start PDU emission at configured rate
            var intervalMs = Math.round(1000 / _config.pduRate);
            _streamInterval = setInterval(function() {
                _emitEntityStatePDUs();
            }, intervalMs);

            // Heartbeat every 5 seconds (DIS standard)
            _heartbeatInterval = setInterval(function() {
                _emitEntityStatePDUs();
                _stats.uptime = (Date.now() - _stats.lastTick) / 1000;
            }, 5000);

            _notifyStatus('streaming');
        }).catch(function(e) {
            console.warn('DIS streaming start failed:', e);
            _streaming = false;
            _notifyStatus('error');
        });
    }

    /**
     * Stop DIS streaming.
     */
    function stopStreaming() {
        _streaming = false;

        if (_streamInterval) {
            clearInterval(_streamInterval);
            _streamInterval = null;
        }
        if (_heartbeatInterval) {
            clearInterval(_heartbeatInterval);
            _heartbeatInterval = null;
        }
        if (_httpFlushTimer) {
            clearTimeout(_httpFlushTimer);
            _flushHttpBatch();
            _httpFlushTimer = null;
        }
        if (_ws) {
            _ws.close();
            _ws = null;
        }

        _world = null;
        _notifyStatus('disconnected');
    }

    /**
     * Emit Entity State PDUs for all active entities.
     */
    function _emitEntityStatePDUs() {
        if (!_world || !_streaming) return;

        var count = 0;
        _world.entities.forEach(function(entity) {
            if (!entity.active) return;
            var disId = _getDisEntityId(entity.id);
            var buf = DISProtocol.encodeEntityState(
                entity, disId, _config.exerciseId,
                _world.simTime, _config.siteId, _config.appId
            );
            _sendPDU(buf);
            count++;
        });

        _stats.entitiesTracked = count;
    }

    // -----------------------------------------------------------------------
    // Fire/Detonation Event PDUs
    // -----------------------------------------------------------------------

    /**
     * Emit a Fire PDU for a weapon launch event.
     * @param {object} event  { firingEntityId, targetEntityId, munitionType, location, velocity, range }
     */
    function emitFire(event) {
        if (!_streaming) return;

        var opts = {
            firingEntityId: _getDisEntityId(event.firingEntityId || 'unknown'),
            targetEntityId: event.targetEntityId ? _getDisEntityId(event.targetEntityId) : 0,
            munitionId: _nextDisEntityId++,
            munitionType: event.munitionType || 'generic',
            location: event.location || {},
            velocity: event.velocity || 0,
            range: event.range || 0,
            eventId: _stats.pdusSent + 1
        };

        var buf = DISProtocol.encodeFire(
            opts, _config.exerciseId, _world ? _world.simTime : 0,
            _config.siteId, _config.appId
        );
        _sendPDU(buf);
    }

    /**
     * Emit a Detonation PDU for an impact event.
     * @param {object} event  { firingEntityId, targetEntityId, munitionType, location, result }
     */
    function emitDetonation(event) {
        if (!_streaming) return;

        var opts = {
            firingEntityId: _getDisEntityId(event.firingEntityId || 'unknown'),
            targetEntityId: event.targetEntityId ? _getDisEntityId(event.targetEntityId) : 0,
            munitionId: 0,
            munitionType: event.munitionType || 'generic',
            location: event.location || {},
            result: event.result || 1,  // 1 = entity impact
            eventId: _stats.pdusSent + 1
        };

        var buf = DISProtocol.encodeDetonation(
            opts, _config.exerciseId, _world ? _world.simTime : 0,
            _config.siteId, _config.appId
        );
        _sendPDU(buf);
    }

    // -----------------------------------------------------------------------
    // Batch Export
    // -----------------------------------------------------------------------

    /**
     * Run simulation headlessly and collect all PDUs into a binary file.
     * @param {object} scenarioData  Scenario JSON
     * @param {object} viewer        Cesium Viewer (for ScenarioLoader)
     * @param {number} duration      Simulation duration in seconds
     * @param {number} dt            Timestep in seconds (default: 1/pduRate)
     * @returns {Promise<{filename, entityCount, duration, pduCount, bytesTotal}>}
     */
    function exportBatch(scenarioData, viewer, duration, dt) {
        dt = dt || (1 / _config.pduRate);

        return new Promise(function(resolve, reject) {
            try {
                // Build world headlessly
                var world = ScenarioLoader.build(scenarioData, viewer);
                world.isPaused = false;

                var entityIdMap = new Map();
                var nextId = 1;

                function getExportDisId(ecsId) {
                    if (entityIdMap.has(ecsId)) return entityIdMap.get(ecsId);
                    var id = nextId++;
                    entityIdMap.set(ecsId, id);
                    return id;
                }

                var pdus = [];
                var steps = Math.ceil(duration / dt);
                var pduInterval = Math.max(1, Math.round(1 / (_config.pduRate * dt)));

                for (var step = 0; step < steps; step++) {
                    // Advance simulation
                    world.simTime += dt;
                    for (var si = 0; si < world.systems.length; si++) {
                        world.systems[si].fn(dt, world);
                    }

                    // Record Entity State PDUs at configured rate
                    if (step % pduInterval === 0) {
                        world.entities.forEach(function(entity) {
                            if (!entity.active) return;
                            var disId = getExportDisId(entity.id);
                            var buf = DISProtocol.encodeEntityState(
                                entity, disId, _config.exerciseId,
                                world.simTime, _config.siteId, _config.appId
                            );
                            pdus.push(buf);
                        });
                    }
                }

                // Cleanup
                world.entities.forEach(function(entity) {
                    var vis = entity.getComponent('visual');
                    if (vis) vis.cleanup(world);
                });

                if (pdus.length === 0) {
                    reject(new Error('No PDUs generated'));
                    return;
                }

                // Concatenate all PDUs
                var combined = DISProtocol.concatBuffers(pdus);

                // Prompt for name
                var scenarioName = (scenarioData.metadata && scenarioData.metadata.name) || 'untitled';
                var name = prompt('DIS export filename:', scenarioName);
                if (!name) {
                    reject(new Error('Export cancelled'));
                    return;
                }

                // POST to server
                fetch('/api/dis_export', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Filename': name
                    },
                    body: combined
                })
                .then(function(resp) { return resp.json(); })
                .then(function(data) {
                    if (data.error) {
                        reject(new Error(data.error));
                        return;
                    }
                    resolve({
                        filename: data.filename,
                        entityCount: entityIdMap.size,
                        duration: duration,
                        pduCount: pdus.length,
                        bytesTotal: combined.byteLength
                    });
                })
                .catch(reject);

            } catch (e) {
                reject(e);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    function getStats() {
        return {
            pdusSent: _stats.pdusSent,
            entitiesTracked: _stats.entitiesTracked,
            bytesTotal: _stats.bytesTotal,
            uptime: _stats.uptime,
            streaming: _streaming,
            pduRate: _config.pduRate
        };
    }

    function isStreaming() {
        return _streaming;
    }

    function getConfig() {
        return Object.assign({}, _config);
    }

    function setConfig(cfg) {
        for (var k in cfg) {
            if (_config.hasOwnProperty(k)) {
                _config[k] = cfg[k];
            }
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        init: init,
        onStatus: onStatus,
        startStreaming: startStreaming,
        stopStreaming: stopStreaming,
        emitFire: emitFire,
        emitDetonation: emitDetonation,
        exportBatch: exportBatch,
        getStats: getStats,
        isStreaming: isStreaming,
        getConfig: getConfig,
        setConfig: setConfig
    };
})();
