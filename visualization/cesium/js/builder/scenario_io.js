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
    function exportToViewer(scenarioData) {
        if (!scenarioData) {
            return Promise.reject(new Error('No scenario data'));
        }

        var defaultName = (scenarioData.metadata && scenarioData.metadata.name) || 'Untitled Scenario';
        var name = prompt('Export scenario as:', defaultName);
        if (!name) {
            return Promise.reject(new Error('Export cancelled'));
        }

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
    function exportModel(scenarioData, viewer, duration, sampleHz) {
        if (!scenarioData) return Promise.reject(new Error('No scenario data'));

        var defaultName = (scenarioData.metadata && scenarioData.metadata.name) || 'Untitled';
        var name = prompt('Export model as:', defaultName);
        if (!name) return Promise.reject(new Error('Export cancelled'));

        duration = duration || 600;   // default 10 min
        sampleHz = sampleHz || 2;

        if (scenarioData.metadata) scenarioData.metadata.name = name;

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

                // Run headlessly
                var tickDt = dt;
                for (var step = 0; step <= steps; step++) {
                    var simTime = step * dt;
                    world.simTime = simTime;

                    // Run physics systems only (skip visual/HUD/UI)
                    for (var s = 0; s < world.systems.length; s++) {
                        var sys = world.systems[s];
                        // Only run physics-relevant systems
                        if (sys.name === 'ai' || sys.name === 'control' ||
                            sys.name === 'physics' || sys.name === 'sensor' ||
                            sys.name === 'weapon' || sys.name === 'event') {
                            sys.fn(tickDt, world);
                        }
                    }

                    // Sample all entity positions
                    world.entities.forEach(function(entity) {
                        if (!entity.active) return;
                        var s = entity.state;
                        if (s.lat === undefined || s.lon === undefined) return;

                        var track = tracks[entity.id];
                        if (!track) return;

                        // CZML cartographicDegrees format: time, lon, lat, alt
                        track.positions.push(
                            simTime,
                            (s.lon !== undefined ? s.lon : 0) * (180 / Math.PI),  // rad → deg
                            (s.lat !== undefined ? s.lat : 0) * (180 / Math.PI),  // rad → deg
                            s.alt || 0
                        );
                    });
                }

                // Clean up world
                world.entities.forEach(function(entity) {
                    for (var cn in entity.components) {
                        entity.components[cn].cleanup(world);
                    }
                });

                // Build CZML document
                var czml = _buildCZML(name, epoch, duration, tracks);
                var czmlStr = JSON.stringify(czml, null, 2);

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
        validateScenario: validateScenario,
        sanitizeFilename: sanitizeFilename
    };
})();
