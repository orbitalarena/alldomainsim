/**
 * ScenarioIO - Scenario save, load, export, and validation.
 *
 * Handles file picker dialogs, JSON serialization, download triggers,
 * and basic structural validation for scenario JSON files.
 */
const ScenarioIO = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // Default Scenario Template
    // -------------------------------------------------------------------

    /**
     * Return a fresh default empty scenario JSON object.
     * @returns {object}
     */
    function newScenario() {
        return {
            metadata: {
                name: 'Untitled Scenario',
                description: '',
                version: '2.0',
                author: 'Builder'
            },
            environment: {
                atmosphere: 'us_standard_1976',
                gravity: 'earth',
                gravityMu: 3.986004418e14,
                maxTimeWarp: 64,
                magneticField: null,
                ionosphere: null,
                radiationBelt: null
            },
            entities: [],
            networks: [],
            events: [],
            camera: {
                mode: 'free',
                range: 5000000
            }
        };
    }

    // -------------------------------------------------------------------
    // File Open
    // -------------------------------------------------------------------

    /**
     * Open a file picker dialog, read a JSON scenario file, parse and return it.
     * @returns {Promise<object>} resolves with parsed scenario JSON
     */
    function openFile() {
        return _openFileDialog('.json').then(function(text) {
            var json;
            try {
                json = JSON.parse(text);
            } catch (e) {
                throw new Error('Invalid JSON: ' + e.message);
            }

            // Validate the parsed JSON
            var validation = validateScenario(json);
            if (!validation.valid) {
                throw new Error('Invalid scenario file: ' + validation.errors.join('; '));
            }

            return json;
        });
    }

    // -------------------------------------------------------------------
    // File Save
    // -------------------------------------------------------------------

    /**
     * Serialize scenario data to JSON and trigger a download.
     * @param {object} scenarioData  the scenario JSON object
     */
    function saveFile(scenarioData) {
        if (!scenarioData) {
            console.warn('ScenarioIO.saveFile: no data to save');
            return;
        }

        var name = 'untitled_scenario';
        if (scenarioData.metadata && scenarioData.metadata.name) {
            name = sanitizeFilename(scenarioData.metadata.name);
        }

        var jsonStr = JSON.stringify(scenarioData, null, 2);
        _downloadFile(jsonStr, name + '.json', 'application/json');
    }

    // -------------------------------------------------------------------
    // Generic JSON Export
    // -------------------------------------------------------------------

    /**
     * Download any data as a JSON file.
     * @param {object} data      the object to serialize
     * @param {string} filename  desired filename (without extension)
     */
    function exportJSON(data, filename) {
        var jsonStr = JSON.stringify(data, null, 2);
        var safeName = sanitizeFilename(filename || 'export');
        _downloadFile(jsonStr, safeName + '.json', 'application/json');
    }

    // -------------------------------------------------------------------
    // TLE Import
    // -------------------------------------------------------------------

    /**
     * Open a file picker for TLE data files, parse them, and create
     * satellite entities in the current scenario.
     * @returns {Promise<number>} resolves with number of satellites imported
     */
    function importTLEFile() {
        if (typeof TLEParser === 'undefined') {
            return Promise.reject(new Error('TLE parser not loaded'));
        }

        return _openFileDialog('.tle,.txt').then(function(text) {
            var satellites = TLEParser.parse(text);
            if (satellites.length === 0) {
                throw new Error('No valid TLE entries found in file');
            }

            var count = 0;
            for (var i = 0; i < satellites.length; i++) {
                var entityDef = _tleToEntityDef(satellites[i]);
                if (entityDef && typeof BuilderApp !== 'undefined') {
                    BuilderApp.addEntity(entityDef);
                    count++;
                }
            }

            if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                BuilderApp.showMessage('Imported ' + count + ' satellite' + (count !== 1 ? 's' : '') + ' from TLE', 3000);
            }

            return count;
        });
    }

    /**
     * Convert a parsed TLE satellite object to an entity definition.
     * @param {object} sat  parsed TLE satellite from TLEParser
     * @returns {object} entity definition for the scenario
     */
    function _tleToEntityDef(sat) {
        var RAD = 180 / Math.PI;

        // Compute initial geodetic position from TLE
        var eci = TLEParser.tleToECI(sat);
        var geo = TLEParser.eciToGeodetic(eci.pos, 0); // GMST=0 for initial placement
        var vMag = Math.sqrt(eci.vel[0] * eci.vel[0] + eci.vel[1] * eci.vel[1] + eci.vel[2] * eci.vel[2]);

        return {
            id: 'sat_' + sat.catalogNumber,
            name: sat.name,
            type: 'satellite',
            team: 'neutral',
            initialState: {
                lat: geo.lat * RAD,
                lon: geo.lon * RAD,
                alt: Math.max(0, geo.alt),
                speed: vMag,
                heading: 0,
                gamma: 0
            },
            components: {
                physics: {
                    type: 'orbital_2body',
                    source: 'tle',
                    tle_line1: sat.tle_line1,
                    tle_line2: sat.tle_line2
                },
                visual: {
                    type: 'satellite',
                    color: _satColorFromAlt(sat.altitudeKm),
                    pixelSize: 8,
                    orbitPath: true,
                    groundTrack: true,
                    apPeMarkers: true
                }
            }
        };
    }

    /**
     * Assign satellite color based on orbit altitude.
     */
    function _satColorFromAlt(altKm) {
        if (altKm < 2000)  return '#ffaa00';    // LEO: amber
        if (altKm < 25000) return '#ffcc44';    // MEO: gold
        if (altKm < 40000) return '#ff88ff';    // GEO: magenta
        return '#ff4488';                        // HEO+: red-pink
    }

    // -------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------

    /**
     * Perform basic structural validation on a scenario JSON object.
     * @param {object} data  the parsed scenario object
     * @returns {{ valid: boolean, errors: string[] }}
     */
    function validateScenario(data) {
        var errors = [];

        if (!data || typeof data !== 'object') {
            errors.push('Scenario data is not an object');
            return { valid: false, errors: errors };
        }

        // Metadata check
        if (!data.metadata || typeof data.metadata !== 'object') {
            errors.push('Missing or invalid metadata object');
        }

        // Entities check
        if (!Array.isArray(data.entities)) {
            errors.push('Missing or invalid entities array');
        } else {
            var seenIds = {};
            for (var i = 0; i < data.entities.length; i++) {
                var entity = data.entities[i];

                if (!entity || typeof entity !== 'object') {
                    errors.push('Entity at index ' + i + ' is not an object');
                    continue;
                }

                // Required fields
                if (!entity.id || typeof entity.id !== 'string') {
                    errors.push('Entity at index ' + i + ' missing valid id');
                }

                if (!entity.type || typeof entity.type !== 'string') {
                    errors.push('Entity "' + (entity.id || 'index ' + i) + '" missing valid type');
                }

                if (!entity.initialState || typeof entity.initialState !== 'object') {
                    errors.push('Entity "' + (entity.id || 'index ' + i) + '" missing initialState object');
                }

                // Duplicate ID check
                if (entity.id) {
                    if (seenIds[entity.id]) {
                        errors.push('Duplicate entity id: "' + entity.id + '"');
                    }
                    seenIds[entity.id] = true;
                }

                // Validate initialState numeric fields if present
                if (entity.initialState && typeof entity.initialState === 'object') {
                    _validateNumericField(entity.initialState, 'lat', entity.id, errors);
                    _validateNumericField(entity.initialState, 'lon', entity.id, errors);
                    _validateNumericField(entity.initialState, 'alt', entity.id, errors);
                    _validateNumericField(entity.initialState, 'speed', entity.id, errors);
                    _validateNumericField(entity.initialState, 'heading', entity.id, errors);
                    _validateNumericField(entity.initialState, 'gamma', entity.id, errors);
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors: errors
        };
    }

    /**
     * Check that a field, if present, is a valid finite number.
     */
    function _validateNumericField(obj, field, entityId, errors) {
        if (obj[field] !== undefined && obj[field] !== null) {
            if (typeof obj[field] !== 'number' || !isFinite(obj[field])) {
                errors.push('Entity "' + entityId + '": ' + field + ' is not a finite number');
            }
        }
    }

    // -------------------------------------------------------------------
    // Export to Viewer (server-side write)
    // -------------------------------------------------------------------

    /**
     * Export scenario to the scenarios/ directory via the custom server.
     * Prompts the user for a name, POSTs to /api/export, and opens the viewer.
     * @param {object} scenarioData
     * @returns {Promise<string>} resolves with the viewer URL
     */
    function exportToViewer(scenarioData, exportName) {
        if (!scenarioData) {
            return Promise.reject(new Error('No scenario data'));
        }

        // If name provided by caller, use it directly; otherwise prompt
        var namePromise;
        if (exportName) {
            namePromise = Promise.resolve(exportName);
        } else if (typeof BuilderApp !== 'undefined' && BuilderApp.showPrompt) {
            var defaultName = (scenarioData.metadata && scenarioData.metadata.name) || 'Untitled Scenario';
            namePromise = BuilderApp.showPrompt('Export Sim', 'Export scenario as:', defaultName);
        } else {
            var defaultName2 = (scenarioData.metadata && scenarioData.metadata.name) || 'Untitled Scenario';
            var name2 = prompt('Export scenario as:', defaultName2);
            if (!name2) return Promise.reject(new Error('cancelled'));
            namePromise = Promise.resolve(name2);
        }

        return namePromise.then(function(name) {
            if (!name) return Promise.reject(new Error('cancelled'));

            // Update metadata name to match
            if (scenarioData.metadata) {
                scenarioData.metadata.name = name;
            }

            return fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, scenario: scenarioData })
            }).then(function(response) {
                return response.json();
            }).then(function(result) {
                if (result.error) {
                    throw new Error(result.error);
                }
                return result;
            });
        });
    }

    // -------------------------------------------------------------------
    // Model Export (headless run → CZML for native Cesium playback)
    // -------------------------------------------------------------------

    /**
     * Run the scenario headlessly at max speed, record all entity positions,
     * then export as CZML and a lightweight viewer HTML.
     * @param {object} scenarioData   the scenario JSON
     * @param {Cesium.Viewer} viewer  current viewer (for world build)
     * @param {number} duration       sim seconds to run
     * @param {number} sampleHz       position samples per second (default 2)
     * @returns {Promise<object>}     resolves with { filename, viewerUrl }
     */
    function exportModel(scenarioData, viewer, duration, sampleHz, onProgress) {
        if (!scenarioData) return Promise.reject(new Error('No scenario data'));

        // Name prompt now handled by caller (BuilderApp modal)
        var name = (scenarioData.metadata && scenarioData.metadata.name) || 'Untitled';

        duration = duration || 600;   // default 10 min
        sampleHz = sampleHz || 2;

        return new Promise(function(resolve, reject) {
            try {
                // Build the ECS world headlessly (Cesium entities won't render without tick)
                var world = ScenarioLoader.build(scenarioData, viewer);

                var dt = 1.0 / sampleHz;
                var steps = Math.ceil(duration / dt);

                // Epoch: current time
                var epoch = new Date().toISOString();

                // Collect entity tracks: id -> { name, team, type, positions: [t, lon, lat, alt, ...] }
                var tracks = {};
                world.entities.forEach(function(entity) {
                    tracks[entity.id] = {
                        name: entity.name,
                        team: entity.team,
                        type: entity.type,
                        positions: []
                    };
                });

                // Run headlessly with chunked progress
                var tickDt = dt;
                var step = 0;
                var CHUNK = 50;  // steps per chunk (yield to UI)

                function runChunk() {
                    var end = Math.min(step + CHUNK, steps);
                    for (; step <= end; step++) {
                        var simTime = step * dt;
                        world.simTime = simTime;

                        // Run physics systems only (skip visual/HUD/UI)
                        for (var s = 0; s < world.systems.length; s++) {
                            var sys = world.systems[s];
                            if (sys.name === 'ai' || sys.name === 'control' ||
                                sys.name === 'physics' || sys.name === 'sensor' ||
                                sys.name === 'weapon' || sys.name === 'event') {
                                sys.fn(tickDt, world);
                            }
                        }

                        // Sample all entity positions
                        world.entities.forEach(function(entity) {
                            if (!entity.active) return;
                            var es = entity.state;
                            if (es.lat === undefined || es.lon === undefined) return;

                            var track = tracks[entity.id];
                            if (!track) return;

                            track.positions.push(
                                simTime,
                                (es.lon !== undefined ? es.lon : 0) * (180 / Math.PI),
                                (es.lat !== undefined ? es.lat : 0) * (180 / Math.PI),
                                es.alt || 0
                            );
                        });
                    }

                    // Report progress
                    var pct = Math.min(100, (step / steps) * 100);
                    if (typeof onProgress === 'function') {
                        onProgress(pct, 'Simulating... ' + (step * dt).toFixed(0) + 's / ' + duration + 's');
                    }

                    if (step <= steps) {
                        setTimeout(runChunk, 0);
                    } else {
                        finishExport();
                    }
                }

                function finishExport() {
                    if (typeof onProgress === 'function') {
                        onProgress(100, 'Building CZML...');
                    }

                    // Clean up world
                    world.entities.forEach(function(entity) {
                        for (var cn in entity.components) {
                            entity.components[cn].cleanup(world);
                        }
                    });

                    // Build CZML document
                    var czml = _buildCZML(name, epoch, duration, tracks);

                    // POST to server
                    var safeName = sanitizeFilename(name);
                    fetch('/api/export', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: safeName + '_model',
                            scenario: { _czml: true, data: czml }
                        })
                    }).then(function(resp) {
                        return resp.json();
                    }).then(function() {
                        // Also save the raw CZML as its own file
                        return fetch('/api/export', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                name: safeName + '_czml',
                                scenario: czml
                            })
                        });
                    }).then(function(resp) {
                        return resp.json();
                    }).then(function(result) {
                        resolve({
                            filename: safeName + '_czml.json',
                            viewerUrl: 'model_viewer.html?czml=scenarios/' + safeName + '_czml.json',
                            entityCount: Object.keys(tracks).length,
                            duration: duration,
                            steps: steps
                        });
                    }).catch(reject);
                }

                // Start the chunked sim
                runChunk();

            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * Build a CZML document from recorded entity tracks.
     */
    function _buildCZML(name, epoch, duration, tracks) {
        var teamColors = {
            blue:    { rgba: [68, 136, 255, 255] },
            red:     { rgba: [255, 68, 68, 255] },
            neutral: { rgba: [255, 255, 100, 255] },
            green:   { rgba: [68, 255, 68, 255] }
        };

        var czml = [
            {
                id: 'document',
                name: name + ' (Model Playback)',
                version: '1.0',
                clock: {
                    interval: epoch + '/' + _addSeconds(epoch, duration),
                    currentTime: epoch,
                    multiplier: 10,
                    range: 'LOOP_STOP',
                    step: 'SYSTEM_CLOCK_MULTIPLIER'
                }
            }
        ];

        for (var id in tracks) {
            var track = tracks[id];
            if (track.positions.length < 4) continue;  // need at least 1 sample

            var color = teamColors[track.team] || teamColors.neutral;
            var isSat = track.type === 'satellite';

            var packet = {
                id: id,
                name: track.name,
                availability: epoch + '/' + _addSeconds(epoch, duration),
                position: {
                    epoch: epoch,
                    cartographicDegrees: track.positions,
                    interpolationAlgorithm: 'LAGRANGE',
                    interpolationDegree: 1
                },
                point: {
                    pixelSize: isSat ? 6 : 10,
                    color: color,
                    outlineColor: { rgba: [0, 0, 0, 255] },
                    outlineWidth: 1
                },
                label: {
                    text: track.name,
                    font: '11px monospace',
                    fillColor: color,
                    outlineColor: { rgba: [0, 0, 0, 255] },
                    outlineWidth: 2,
                    style: 'FILL_AND_OUTLINE',
                    verticalOrigin: 'BOTTOM',
                    pixelOffset: { cartesian2: [0, -12] }
                },
                path: {
                    leadTime: 0,
                    trailTime: isSat ? 5400 : 300,
                    width: 1,
                    material: {
                        solidColor: {
                            color: {
                                rgba: [color.rgba[0], color.rgba[1], color.rgba[2], 140]
                            }
                        }
                    }
                }
            };

            czml.push(packet);
        }

        return czml;
    }

    /**
     * Add seconds to an ISO 8601 date string.
     */
    function _addSeconds(isoStr, seconds) {
        var d = new Date(isoStr);
        d.setSeconds(d.getSeconds() + seconds);
        return d.toISOString();
    }

    // -------------------------------------------------------------------
    // Filename Sanitization
    // -------------------------------------------------------------------

    /**
     * Replace non-alphanumeric characters (except hyphens and underscores) with underscores.
     * @param {string} name
     * @returns {string}
     */
    function sanitizeFilename(name) {
        if (!name || typeof name !== 'string') return 'untitled';
        return name.replace(/[^a-zA-Z0-9_\-]/g, '_')
                   .replace(/_+/g, '_')
                   .replace(/^_|_$/g, '')
                   .toLowerCase() || 'untitled';
    }

    // -------------------------------------------------------------------
    // File Dialog Helper
    // -------------------------------------------------------------------

    /**
     * Open a native file picker dialog and return the file contents as text.
     * @param {string} accept  file type filter (e.g. '.json', '.tle,.txt')
     * @returns {Promise<string>} resolves with file text content
     */
    function _openFileDialog(accept) {
        return new Promise(function(resolve, reject) {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = accept;
            input.style.display = 'none';

            input.onchange = function(e) {
                var file = e.target.files[0];
                if (!file) {
                    _cleanup();
                    reject(new Error('No file selected'));
                    return;
                }

                var reader = new FileReader();
                reader.onload = function(evt) {
                    _cleanup();
                    resolve(evt.target.result);
                };
                reader.onerror = function() {
                    _cleanup();
                    reject(new Error('File read failed'));
                };
                reader.readAsText(file);
            };

            // Some browsers require the input to be in the DOM
            document.body.appendChild(input);

            function _cleanup() {
                if (input.parentNode) {
                    input.parentNode.removeChild(input);
                }
            }

            input.click();
        });
    }

    // -------------------------------------------------------------------
    // Download Helper
    // -------------------------------------------------------------------

    /**
     * Trigger a file download in the browser.
     * @param {string} content   file content
     * @param {string} filename  desired filename
     * @param {string} mimeType  MIME type
     */
    function _downloadFile(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType || 'text/plain' });
        var url = URL.createObjectURL(blob);

        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();

        // Cleanup after a brief delay to ensure download starts
        setTimeout(function() {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // -------------------------------------------------------------------
    // TLE Catalog Import (from serve.py API)
    // -------------------------------------------------------------------
    function importTLECatalog() {
        // Create constellation picker modal
        return new Promise(function(resolve, reject) {
            var modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000;' +
                'background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;';

            var panel = document.createElement('div');
            panel.style.cssText = 'background:#1a1a2e;border:1px solid #44cc88;border-radius:8px;' +
                'padding:20px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;color:#eee;font-family:monospace;';
            panel.innerHTML = '<h3 style="color:#44cc88;margin:0 0 12px">IMPORT TLE CATALOG</h3>' +
                '<div id="tleBuilderList" style="margin-bottom:12px">Loading catalog...</div>' +
                '<div style="display:flex;gap:8px">' +
                '<button id="tleBuilderAll" style="flex:1;padding:6px;background:#335;color:#4af;border:1px solid #4af;border-radius:3px;cursor:pointer;font-family:monospace">ALL</button>' +
                '<button id="tleBuilderNone" style="flex:1;padding:6px;background:#335;color:#4af;border:1px solid #4af;border-radius:3px;cursor:pointer;font-family:monospace">NONE</button>' +
                '<button id="tleBuilderImport" style="flex:1;padding:6px;background:#244;color:#4c8;border:1px solid #4c8;border-radius:3px;cursor:pointer;font-family:monospace;font-weight:bold">IMPORT</button>' +
                '<button id="tleBuilderCancel" style="flex:1;padding:6px;background:#333;color:#aaa;border:1px solid #666;border-radius:3px;cursor:pointer;font-family:monospace">CANCEL</button></div>';
            modal.appendChild(panel);
            document.body.appendChild(modal);

            fetch('/api/tle/catalog')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    var list = document.getElementById('tleBuilderList');
                    var constellations = data.constellations || [];
                    var html = '';
                    for (var i = 0; i < constellations.length; i++) {
                        var c = constellations[i];
                        var preselected = ['GPS', 'IRIDIUM', 'GALILEO'].indexOf(c.name) >= 0;
                        html += '<label style="display:block;padding:3px 0;cursor:pointer">' +
                            '<input type="checkbox" class="tle-builder-check" data-name="' + c.name + '"' +
                            (preselected ? ' checked' : '') + '> ' + c.name +
                            ' <span style="color:#666">(' + c.count + ')</span></label>';
                    }
                    list.innerHTML = html;
                })
                .catch(function(err) {
                    document.getElementById('tleBuilderList').innerHTML =
                        '<span style="color:#f44">' + err.message + '</span>';
                });

            document.getElementById('tleBuilderAll').onclick = function() {
                modal.querySelectorAll('.tle-builder-check').forEach(function(cb) { cb.checked = true; });
            };
            document.getElementById('tleBuilderNone').onclick = function() {
                modal.querySelectorAll('.tle-builder-check').forEach(function(cb) { cb.checked = false; });
            };
            document.getElementById('tleBuilderCancel').onclick = function() {
                document.body.removeChild(modal);
                resolve(0);
            };
            document.getElementById('tleBuilderImport').onclick = function() {
                var checks = modal.querySelectorAll('.tle-builder-check:checked');
                var names = [];
                checks.forEach(function(cb) { names.push(cb.getAttribute('data-name')); });
                if (names.length === 0) return;

                document.getElementById('tleBuilderImport').textContent = 'Loading...';
                document.getElementById('tleBuilderImport').disabled = true;

                var promises = names.map(function(name) {
                    return fetch('/api/tle/constellation/' + encodeURIComponent(name))
                        .then(function(r) { return r.json(); });
                });

                Promise.all(promises).then(function(results) {
                    var count = 0;
                    for (var i = 0; i < results.length; i++) {
                        var constData = results[i];
                        var sats = constData.satellites || [];
                        // For large constellations (>500), use smaller viz settings
                        var isLarge = sats.length > 500;
                        for (var j = 0; j < sats.length; j++) {
                            var sat = sats[j];
                            var entityDef = {
                                id: 'tle_' + sat.norad,
                                name: sat.name,
                                type: 'satellite',
                                team: 'neutral',
                                vizCategory: constData.name,
                                initialState: {},
                                components: {
                                    physics: {
                                        type: 'orbital_2body',
                                        source: 'tle',
                                        tle_line1: sat.line1,
                                        tle_line2: sat.line2
                                    },
                                    visual: {
                                        type: 'satellite',
                                        pixelSize: isLarge ? 3 : 6,
                                        orbitPath: !isLarge,
                                        groundTrack: false,
                                        apPeMarkers: false
                                    }
                                }
                            };
                            if (typeof BuilderApp !== 'undefined') {
                                BuilderApp.addEntity(entityDef);
                                count++;
                            }
                        }
                    }
                    document.body.removeChild(modal);
                    if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
                        BuilderApp.showMessage('Imported ' + count + ' satellites from ' + names.length + ' constellation(s)', 3000);
                    }
                    resolve(count);
                }).catch(function(err) {
                    document.body.removeChild(modal);
                    reject(err);
                });
            };
        });
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        newScenario: newScenario,
        openFile: openFile,
        saveFile: saveFile,
        exportJSON: exportJSON,
        exportToViewer: exportToViewer,
        exportModel: exportModel,
        importTLEFile: importTLEFile,
        importTLECatalog: importTLECatalog,
        validateScenario: validateScenario,
        sanitizeFilename: sanitizeFilename
    };
})();
