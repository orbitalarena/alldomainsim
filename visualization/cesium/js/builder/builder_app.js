/**
 * BuilderApp - Main application controller for the Scenario Builder.
 *
 * Manages three modes: BUILD (edit entities on globe), RUN (simulate),
 * ANALYZE (post-run inspection). In BUILD mode, entities are shown as
 * static Cesium point markers. In RUN mode, the ECS world ticks and
 * physics/visualization systems drive entity motion.
 */
const BuilderApp = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------
    var _viewer = null;
    var _world = null;
    var _mode = 'BUILD';
    var _scenarioData = null;
    var _selectedEntityId = null;
    var _placementTemplate = null;
    var _entityCounter = 0;
    var _buildEntities = new Map();  // id -> { def, cesiumEntity }
    var _tickHandler = null;
    var _toastTimeout = null;
    var _inspectorBound = false;     // whether inspector field events are wired
    var _entityListThrottleTimer = null;
    var _entityListPendingUpdate = false;
    var _disEnabled = false;         // DIS streaming toggle
    var _scenarioName = 'Untitled Scenario';
    var _fpsFrames = [];             // rolling FPS tracker
    var _runHudInterval = null;      // run-mode HUD update interval
    var _autosaveTimer = null;       // autosave interval handle
    var _AUTOSAVE_KEY = 'scenarioBuilder_autosave';
    var _AUTOSAVE_INTERVAL = 60000;  // 60 seconds

    // Team colors for build-mode point markers
    var _teamColors = {
        blue:    Cesium.Color.DODGERBLUE,
        red:     Cesium.Color.RED,
        neutral: Cesium.Color.YELLOW,
        green:   Cesium.Color.LIME
    };

    // Palette subtype -> ObjectPalette template mapping
    var _paletteTemplateMap = {};

    // -------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------

    /**
     * Initialize the Scenario Builder application.
     * @param {string} containerId  DOM id for the Cesium container div
     */
    function init(containerId) {
        // Create Cesium viewer
        _viewer = new Cesium.Viewer(containerId, {
            baseLayerPicker: true,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            navigationHelpButton: false,
            animation: false,
            timeline: false,
            fullscreenButton: false,
            vrButton: false,
            infoBox: false,
            selectionIndicator: false,
            shadows: false,
            shouldAnimate: true
        });

        // Terrain and imagery (offline-aware)
        if (typeof setupTerrain === 'function') {
            setupTerrain(_viewer);
        }
        if (typeof setupImagery === 'function') {
            setupImagery(_viewer);
        }

        // ArcGIS imagery if available (online only)
        if (typeof addArcGISProviders === 'function') {
            addArcGISProviders(_viewer);
        }

        _viewer.scene.globe.enableLighting = true;

        // Recover from model shader compilation failures (Cesium 1.111 + certain .glb files)
        _viewer.scene.renderError.addEventListener(function(scene, error) {
            console.error('[BuilderApp] Cesium render error — removing 3D models:', error);
            var entities = _viewer.entities.values;
            for (var i = 0; i < entities.length; i++) {
                if (entities[i].model) entities[i].model = undefined;
            }
            _viewer.useDefaultRenderLoop = false;
            setTimeout(function() { _viewer.useDefaultRenderLoop = true; }, 100);
            showMessage('3D model rendering failed — using point markers', 5000);
        });

        // Initialize globe interaction
        if (typeof GlobeInteraction !== 'undefined') {
            GlobeInteraction.init(_viewer);
        }

        // Initialize timeline panel
        if (typeof TimelinePanel !== 'undefined') {
            TimelinePanel.init();
        }

        // Initialize analysis overlay
        if (typeof AnalysisOverlay !== 'undefined') {
            AnalysisOverlay.init(_viewer);
        }

        // Initialize run inspector (click-to-inspect in RUN mode)
        if (typeof RunInspector !== 'undefined') {
            RunInspector.init(_viewer);
        }

        // Initialize Monte Carlo panel
        if (typeof MCPanel !== 'undefined') {
            MCPanel.init();
        }

        // Initialize DOE panel
        if (typeof DOEPanel !== 'undefined') {
            DOEPanel.init();
        }

        // Initialize Platform Builder dialog
        if (typeof PlatformBuilder !== 'undefined') {
            PlatformBuilder.init();
        }

        // Initialize Communications Designer
        if (typeof CommDesigner !== 'undefined') {
            CommDesigner.init();
        }

        // Initialize Region Editor
        if (typeof RegionEditor !== 'undefined') {
            RegionEditor.init(_viewer);
        }

        // Build palette template map from ObjectPalette
        _buildPaletteTemplateMap();

        // Create default scenario
        _scenarioData = ScenarioIO.newScenario();

        // Wire up toolbar buttons
        _wireToolbar();

        // Wire up palette click handlers
        _wirePaletteItems();

        // Wire up palette section collapse/expand
        _wirePaletteSections();

        // Wire up inspector field events
        _wireInspectorFields();

        // Wire up panel toggle buttons
        _wirePanelToggles();

        // Wire up delete button
        _wireDeleteButton();

        // Enter BUILD mode
        _enterBuildMode();

        // Update UI to reflect initial state
        _updateModeUI();
        _updateInspectorUI();
        _updateEntityListUI();

        // Initialize entity tree filter bar
        if (typeof EntityTree !== 'undefined') {
            EntityTree.initFilter();
        }

        // Check for autosaved scenario and start autosave timer
        _checkAutosave();
        _startAutosave();

        // Dismiss loading overlay
        _dismissLoadingOverlay();

        // Wire up keyboard shortcuts (time warp, help, etc.)
        _wireKeyboard();

        // Cursor coordinate readout
        _wireCursorCoords();

        // Scenario name editor
        _wireScenarioName();

        // Initialize DIS manager
        if (typeof DISManager !== 'undefined') {
            DISManager.init();
            DISManager.onStatus(function(status) {
                _updateDISIndicator(status);
            });
        }

        console.log('BuilderApp initialized');
    }

    // -------------------------------------------------------------------
    // Public Getters
    // -------------------------------------------------------------------

    function getViewer() {
        return _viewer;
    }

    function getMode() {
        return _mode;
    }

    function getScenarioData() {
        // Sync region data into scenario before returning
        if (_scenarioData && typeof RegionEditor !== 'undefined') {
            _scenarioData.regions = RegionEditor.getRegions();
        }
        return _scenarioData;
    }

    function getSelectedEntityId() {
        return _selectedEntityId;
    }

    // -------------------------------------------------------------------
    // Scenario Data Management
    // -------------------------------------------------------------------

    /**
     * Replace the entire scenario data and rebuild build-mode previews.
     * @param {object} json  parsed scenario JSON
     */
    function setScenarioData(json) {
        // Validate first
        var validation = ScenarioIO.validateScenario(json);
        if (!validation.valid) {
            showMessage('Invalid scenario: ' + validation.errors.join(', '));
            console.error('Scenario validation failed:', validation.errors);
            return;
        }

        _scenarioData = json;
        _selectedEntityId = null;

        // Reset entity counter to avoid ID collisions
        _entityCounter = _computeMaxEntityCounter(json.entities || []);

        // Rebuild previews if in BUILD mode
        if (_mode === 'BUILD') {
            _clearBuildPreviews();
            _rebuildBuildPreviews();
        }

        _updateInspectorUI();
        _doUpdateEntityListUI();  // bypass throttle for full rebuild
        _updatePaletteCount();

        // Update scenario name from loaded data
        _scenarioName = (json.metadata && json.metadata.name) || 'Untitled Scenario';
        var nameDisplay = document.getElementById('scenarioNameDisplay');
        if (nameDisplay) nameDisplay.textContent = _scenarioName;

        // Load regions if present
        if (typeof RegionEditor !== 'undefined' && json.regions) {
            RegionEditor.loadRegions(json.regions);
        }

        showMessage('Scenario loaded: ' + (json.metadata.name || 'Untitled'));
    }

    /**
     * Scan entity IDs to find the highest numeric suffix and set _entityCounter above it.
     */
    function _computeMaxEntityCounter(entities) {
        var max = 0;
        for (var i = 0; i < entities.length; i++) {
            var id = entities[i].id || '';
            var match = id.match(/_(\d+)$/);
            if (match) {
                var num = parseInt(match[1], 10);
                if (num > max) max = num;
            }
        }
        return max + 1;
    }

    // -------------------------------------------------------------------
    // Entity Selection
    // -------------------------------------------------------------------

    /**
     * Select an entity by ID. Updates inspector panel and highlights on globe.
     * @param {string} id
     */
    function selectEntity(id) {
        if (_mode !== 'BUILD') return;

        // Deselect previous
        if (_selectedEntityId && _buildEntities.has(_selectedEntityId)) {
            var prev = _buildEntities.get(_selectedEntityId);
            if (prev.cesiumEntity) {
                _setPointColor(prev.cesiumEntity, prev.def.team || 'neutral');
            }
        }

        _selectedEntityId = id;

        // Highlight selected
        if (id && _buildEntities.has(id)) {
            var entry = _buildEntities.get(id);
            if (entry.cesiumEntity && entry.cesiumEntity.point) {
                entry.cesiumEntity.point.color = Cesium.Color.WHITE;
                entry.cesiumEntity.point.outlineColor = Cesium.Color.CYAN;
                entry.cesiumEntity.point.outlineWidth = 3;
                entry.cesiumEntity.point.pixelSize = 14;
            }
        }

        _updateInspectorUI();
        _updateEntityListUI();
    }

    /**
     * Clear the current selection.
     */
    function deselectEntity() {
        if (_selectedEntityId && _buildEntities.has(_selectedEntityId)) {
            var entry = _buildEntities.get(_selectedEntityId);
            if (entry.cesiumEntity) {
                _setPointColor(entry.cesiumEntity, entry.def.team || 'neutral');
            }
        }
        _selectedEntityId = null;
        _updateInspectorUI();
        _updateEntityListUI();
    }

    // -------------------------------------------------------------------
    // Placement Mode
    // -------------------------------------------------------------------

    /**
     * Enter placement mode with an entity template.
     * The next globe click will place an entity of this type.
     * @param {object} template  entity definition template
     */
    function startPlacement(template) {
        if (_mode !== 'BUILD') return;
        _placementTemplate = template;
        if (_viewer) _viewer.container.style.cursor = 'crosshair';

        // Show placement status
        var statusEl = document.getElementById('placementStatus');
        if (statusEl) {
            statusEl.textContent = 'Click globe to place ' + (template.name || template.type);
            statusEl.style.display = 'block';
        }

        // Highlight the active palette item
        _highlightPaletteItem(template);

        showMessage('Click on globe to place ' + (template.name || template.type));
    }

    /**
     * Cancel placement mode without placing anything.
     */
    function cancelPlacement() {
        _placementTemplate = null;
        if (_viewer) _viewer.container.style.cursor = 'default';

        var statusEl = document.getElementById('placementStatus');
        if (statusEl) statusEl.style.display = 'none';

        // Remove palette highlight
        var items = document.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('selected');
        }
    }

    /**
     * Get the current placement template (used by GlobeInteraction).
     * @returns {object|null}
     */
    function getPlacementTemplate() {
        return _placementTemplate;
    }

    // -------------------------------------------------------------------
    // Entity CRUD
    // -------------------------------------------------------------------

    /**
     * Add an entity to the scenario data and create a build-mode preview.
     * @param {object} entityDef  entity definition
     * @returns {string} the entity id
     */
    function addEntity(entityDef) {
        if (!entityDef.id) {
            entityDef.id = (entityDef.type || 'entity') + '_' + _nextId();
        }

        // Add to scenario data
        _scenarioData.entities.push(entityDef);

        // Create build-mode preview
        if (_mode === 'BUILD') {
            _createBuildPreview(entityDef);
        }

        _updateEntityListUI();
        _updatePaletteCount();
        showMessage('Added: ' + (entityDef.name || entityDef.id));
        return entityDef.id;
    }

    /**
     * Remove an entity from the scenario data and cleanup its preview.
     * @param {string} id
     */
    function removeEntity(id) {
        // Remove from scenario data
        var idx = -1;
        for (var i = 0; i < _scenarioData.entities.length; i++) {
            if (_scenarioData.entities[i].id === id) {
                idx = i;
                break;
            }
        }
        if (idx >= 0) {
            _scenarioData.entities.splice(idx, 1);
        }

        // Cleanup build preview
        if (_buildEntities.has(id)) {
            var entry = _buildEntities.get(id);
            if (entry.cesiumEntity) {
                _viewer.entities.remove(entry.cesiumEntity);
            }
            _buildEntities.delete(id);
        }

        // Clear selection if this was selected
        if (_selectedEntityId === id) {
            _selectedEntityId = null;
        }

        _updateInspectorUI();
        _updateEntityListUI();
        _updatePaletteCount();
        showMessage('Removed entity');
    }

    /**
     * Update fields on an entity definition (merge into scenarioData).
     * @param {string} id
     * @param {object} changes  fields to merge
     */
    function updateEntityDef(id, changes) {
        var def = _findEntityDef(id);
        if (!def) return;

        // Merge top-level fields
        for (var key in changes) {
            if (key === 'initialState' && def.initialState && typeof changes.initialState === 'object') {
                for (var sk in changes.initialState) {
                    def.initialState[sk] = changes.initialState[sk];
                }
            } else if (key === 'components' && def.components && typeof changes.components === 'object') {
                for (var ck in changes.components) {
                    def.components[ck] = changes.components[ck];
                }
            } else {
                def[key] = changes[key];
            }
        }

        // Update build preview position/appearance
        if (_mode === 'BUILD' && _buildEntities.has(id)) {
            var entry = _buildEntities.get(id);
            entry.def = def;
            _updateBuildPreviewPosition(entry);
            if (id !== _selectedEntityId) {
                _setPointColor(entry.cesiumEntity, def.team || 'neutral');
            }
        }

        // Don't re-render inspector during drag (causes flickering)
        // Entity list updates are lightweight enough
        _updateEntityListUI();
    }

    // -------------------------------------------------------------------
    // Mode Switching
    // -------------------------------------------------------------------

    /**
     * Switch between BUILD, RUN, and ANALYZE modes.
     * @param {string} mode  'BUILD' | 'RUN' | 'ANALYZE'
     */
    function switchMode(mode) {
        if (mode === _mode) return;

        var prevMode = _mode;

        // Deactivate analysis overlays when leaving ANALYZE mode
        if (prevMode === 'ANALYZE') {
            if (typeof AnalysisOverlay !== 'undefined') {
                AnalysisOverlay.deactivate();
            }
        }

        if (mode === 'RUN') {
            if (prevMode === 'ANALYZE') {
                // Can't go back to RUN from ANALYZE — reset first
                showMessage('Reset to BUILD first');
                return;
            }
            _enterRunMode();
        } else if (mode === 'BUILD') {
            _exitRunMode();
            // Deactivate analysis if coming from ANALYZE
            if (typeof AnalysisOverlay !== 'undefined') {
                AnalysisOverlay.deactivate();
            }
            _enterBuildMode();
        } else if (mode === 'ANALYZE') {
            if (prevMode === 'RUN') {
                // Pause the sim and stop recording
                if (_world) _world.isPaused = true;
                if (typeof AnalysisOverlay !== 'undefined') {
                    AnalysisOverlay.stopRecording();
                    AnalysisOverlay.activate();
                }
            } else {
                showMessage('Run simulation first before analyzing');
                return;
            }
            _mode = 'ANALYZE';
        }

        _mode = mode;
        if (typeof GlobeInteraction !== 'undefined') {
            GlobeInteraction.setMode(mode);
        }
        _updateModeUI();
        showMessage(mode + ' MODE');
    }

    function _enterBuildMode() {
        _mode = 'BUILD';
        _clearBuildPreviews();
        _rebuildBuildPreviews();
        cancelPlacement();
    }

    function _enterRunMode() {
        _clearBuildPreviews();
        _selectedEntityId = null;
        cancelPlacement();
        _updateInspectorUI();

        try {
            _world = ScenarioLoader.build(_scenarioData, _viewer);
        } catch (e) {
            showMessage('Build failed: ' + e.message);
            console.error('World build error:', e);
            _enterBuildMode();
            return;
        }

        _mode = 'RUN';

        // Hook up timeline panel
        if (typeof TimelinePanel !== 'undefined') {
            TimelinePanel.setWorld(_world);
        }

        // Start analysis recording
        if (typeof AnalysisOverlay !== 'undefined') {
            AnalysisOverlay.startRecording(_world);
        }

        // Reset EventSystem if available
        if (typeof EventSystem !== 'undefined' && typeof EventSystem.reset === 'function') {
            EventSystem.reset();
        }

        var _uiFrameCounter = 0;
        _tickHandler = function() {
            if (_world && _mode === 'RUN') {
                _world.tick();

                // Track FPS
                _fpsFrames.push(Date.now());
                if (_fpsFrames.length > 60) _fpsFrames.shift();

                // Throttle UI updates to ~4 Hz (every 15 frames at 60fps)
                _uiFrameCounter++;
                if (_uiFrameCounter >= 15) {
                    _uiFrameCounter = 0;
                    _updateSimTimeDisplay();
                }

                // Timeline + analysis are internally throttled
                if (typeof TimelinePanel !== 'undefined') {
                    TimelinePanel.update(0.016);
                }
                if (typeof AnalysisOverlay !== 'undefined') {
                    AnalysisOverlay.recordTick(_world);
                }
            }
        };
        _viewer.clock.onTick.addEventListener(_tickHandler);

        // Start DIS streaming if enabled
        if (_disEnabled && typeof DISManager !== 'undefined') {
            DISManager.startStreaming(_world);
        }

        // Start run-mode HUD updates (4 Hz)
        _showRunHUD(true);
        _runHudInterval = setInterval(_updateRunHUD, 250);

        showMessage('Simulation started');
    }

    function _exitRunMode() {
        if (_tickHandler) {
            _viewer.clock.onTick.removeEventListener(_tickHandler);
            _tickHandler = null;
        }

        // Stop DIS streaming
        if (typeof DISManager !== 'undefined') {
            DISManager.stopStreaming();
        }

        // Hide run inspector
        if (typeof RunInspector !== 'undefined') {
            RunInspector.hide();
        }

        // Hide run-mode HUD
        _showRunHUD(false);
        if (_runHudInterval) {
            clearInterval(_runHudInterval);
            _runHudInterval = null;
        }

        // Stop analysis recording
        if (typeof AnalysisOverlay !== 'undefined') {
            AnalysisOverlay.stopRecording();
        }

        // Clear timeline
        if (typeof TimelinePanel !== 'undefined') {
            TimelinePanel.clearWorld();
        }

        if (_world) {
            _world.entities.forEach(function(entity) {
                var vis = entity.getComponent('visual');
                if (vis) vis.cleanup(_world);
            });
            _world = null;
        }

        _viewer.entities.removeAll();
    }

    // -------------------------------------------------------------------
    // Scenario Management
    // -------------------------------------------------------------------

    function newScenario() {
        if (_mode === 'RUN') {
            switchMode('BUILD');
        }

        _scenarioData = ScenarioIO.newScenario();
        _selectedEntityId = null;
        _entityCounter = 0;
        _clearBuildPreviews();
        if (typeof RegionEditor !== 'undefined') {
            RegionEditor.clearAll();
        }
        _updateInspectorUI();
        _updateEntityListUI();
        showMessage('New scenario created');
    }

    // -------------------------------------------------------------------
    // Demo Scenario Loading
    // -------------------------------------------------------------------

    function _loadDemoScenario(scenarioName) {
        if (_mode !== 'BUILD') {
            showMessage('Switch to BUILD mode first');
            return;
        }

        // Programmatic generators (no JSON file needed)
        if (scenarioName === '__orbital_arena_v1' && typeof OrbitalArena !== 'undefined') {
            showMessage('Generating Orbital Arena v1 (1000 entities)...');
            setTimeout(function() {
                try {
                    var json = OrbitalArena.generate();
                    setScenarioData(json);
                } catch (err) {
                    showMessage('Generation failed: ' + err.message);
                    console.error('OAv1 generation error:', err);
                }
            }, 10);
            return;
        }

        if (scenarioName === '__orbital_arena_small' && typeof OrbitalArena !== 'undefined') {
            showMessage('Generating Orbital Arena Small (100 entities, 30° arc)...');
            setTimeout(function() {
                try {
                    var json = OrbitalArena.generateSmall();
                    setScenarioData(json);
                } catch (err) {
                    showMessage('Generation failed: ' + err.message);
                    console.error('OA Small generation error:', err);
                }
            }, 10);
            return;
        }

        if (scenarioName === '__orbital_arena_large' && typeof OrbitalArena !== 'undefined') {
            showMessage('Generating Orbital Arena Large (1700 entities, 4 orbits)...');
            setTimeout(function() {
                try {
                    var json = OrbitalArena.generateLarge();
                    setScenarioData(json);
                } catch (err) {
                    showMessage('Generation failed: ' + err.message);
                    console.error('OA Large generation error:', err);
                }
            }, 10);
            return;
        }

        scenarioName = scenarioName || 'demo_multi_domain';
        showMessage('Loading ' + scenarioName + '...');

        fetch('scenarios/' + scenarioName + '.json')
            .then(function(response) {
                if (!response.ok) throw new Error('Scenario file not found: ' + scenarioName);
                return response.json();
            })
            .then(function(json) {
                setScenarioData(json);
            })
            .catch(function(err) {
                showMessage('Load failed: ' + err.message);
                console.error('Demo load error:', err);
            });
    }

    // -------------------------------------------------------------------
    // Build Mode Preview Management
    // -------------------------------------------------------------------

    function _createBuildPreview(entityDef) {
        var init = entityDef.initialState || {};
        var lat = init.lat || 0;
        var lon = init.lon || 0;
        var alt = init.alt || 0;
        var team = entityDef.team || 'neutral';
        var isSatellite = entityDef.type === 'satellite';
        var color = _teamColors[team] || _teamColors.neutral;

        // Satellite color override from visual component
        if (isSatellite && entityDef.components && entityDef.components.visual && entityDef.components.visual.color) {
            try {
                color = Cesium.Color.fromCssColorString(entityDef.components.visual.color);
            } catch (e) { /* keep default */ }
        }

        // Label text includes altitude for satellites
        var labelText = entityDef.name || entityDef.id;
        if (isSatellite && alt > 1000) {
            labelText += '\n' + Math.round(alt / 1000) + 'km';
        }

        var cesiumEntity = _viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
            point: {
                pixelSize: isSatellite ? 8 : 10,
                color: color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 1,
                heightReference: alt > 100 ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label: {
                text: labelText,
                font: isSatellite ? '11px monospace' : '12px monospace',
                fillColor: isSatellite ? color : Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -18),
                heightReference: alt > 100 ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scale: 0.9
            }
        });

        cesiumEntity._builderId = entityDef.id;

        _buildEntities.set(entityDef.id, {
            def: entityDef,
            cesiumEntity: cesiumEntity
        });
    }

    function _updateBuildPreviewPosition(entry) {
        var init = entry.def.initialState || {};
        var lat = init.lat || 0;
        var lon = init.lon || 0;
        var alt = init.alt || 0;

        if (entry.cesiumEntity) {
            entry.cesiumEntity.position = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
            if (entry.cesiumEntity.label) {
                entry.cesiumEntity.label.text = entry.def.name || entry.def.id;
            }
        }
    }

    function _rebuildBuildPreviews() {
        var entities = _scenarioData.entities || [];
        for (var i = 0; i < entities.length; i++) {
            _createBuildPreview(entities[i]);
        }
    }

    function _clearBuildPreviews() {
        _buildEntities.forEach(function(entry) {
            if (entry.cesiumEntity) {
                _viewer.entities.remove(entry.cesiumEntity);
            }
        });
        _buildEntities.clear();
    }

    function _setPointColor(cesiumEntity, team) {
        if (!cesiumEntity || !cesiumEntity.point) return;
        var color = _teamColors[team] || _teamColors.neutral;
        cesiumEntity.point.color = color;
        cesiumEntity.point.outlineColor = Cesium.Color.WHITE;
        cesiumEntity.point.outlineWidth = 1;
        cesiumEntity.point.pixelSize = 10;
    }

    // -------------------------------------------------------------------
    // ID Generation
    // -------------------------------------------------------------------

    function _nextId() {
        return _entityCounter++;
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _findEntityDef(id) {
        var entities = _scenarioData.entities || [];
        for (var i = 0; i < entities.length; i++) {
            if (entities[i].id === id) return entities[i];
        }
        return null;
    }

    // -------------------------------------------------------------------
    // C++ Replay Generation
    // -------------------------------------------------------------------

    /**
     * Prompt for replay parameters and run the C++ engine.
     * On success, saves replay JSON and opens replay_viewer.html.
     */
    function _promptAndRunCppReplay(scenarioData) {
        _showPrompt('C++ Replay', 'Simulation duration (seconds):', '600').then(function(durationStr) {
            var duration = parseFloat(durationStr);
            if (isNaN(duration) || duration <= 0) {
                showMessage('Invalid duration');
                return;
            }
            return _showPrompt('C++ Replay', 'Random seed:', '42').then(function(seedStr) {
                var seed = parseInt(seedStr, 10);
                if (isNaN(seed) || seed < 0) seed = 42;
                _runCppReplay(scenarioData, duration, seed);
            });
        }).catch(function() { /* cancelled */ });
    }

    function _runCppReplay(scenarioData, duration, seed) {
        showMessage('Starting C++ engine (' + duration + 's, seed ' + seed + ')...', 2000);

        var payload = {
            scenario: scenarioData,
            seed: seed,
            maxTime: duration,
            dt: 0.1,
            sampleInterval: 2
        };

        fetch('/api/mc/replay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(function(resp) {
            if (!resp.ok) {
                return resp.json().then(function(d) {
                    throw new Error(d.error || ('HTTP ' + resp.status));
                });
            }
            return resp.json();
        })
        .then(function(data) {
            if (!data.jobId) throw new Error('No jobId returned');
            _pollReplayJob(data.jobId);
        })
        .catch(function(err) {
            showMessage('C++ replay failed: ' + err.message);
            console.error('C++ replay error:', err);
        });
    }

    function _pollReplayJob(jobId) {
        var pollInterval = setInterval(function() {
            fetch('/api/mc/jobs/' + jobId)
            .then(function(resp) { return resp.json(); })
            .then(function(job) {
                if (job.status === 'running') {
                    var p = job.progress || {};
                    var msg = 'C++ engine: ';
                    if (p.step !== undefined) {
                        msg += 'step ' + p.step + '/' + p.totalSteps +
                               ' (t=' + (p.simTime || 0).toFixed(0) + 's) ' + (p.pct || 0) + '%';
                    } else if (p.pct !== undefined) {
                        msg += p.pct + '%';
                    } else {
                        msg += 'starting...';
                    }
                    showMessage(msg, 1500);
                } else if (job.status === 'complete') {
                    clearInterval(pollInterval);
                    var replayData = job.results;
                    var meta = replayData._serverMeta || {};
                    var elapsed = meta.elapsed ? meta.elapsed.toFixed(2) + 's' : job.elapsed.toFixed(2) + 's';
                    var entityCount = (replayData.entities || []).length;
                    showMessage('C++ replay: ' + entityCount + ' entities in ' + elapsed, 3000);

                    // Save replay to file on server
                    var replayName = _scenarioName || 'untitled';
                    fetch('/api/save_replay', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: replayName, replay: replayData })
                    })
                    .then(function(resp) { return resp.json(); })
                    .then(function(saveResult) {
                        if (saveResult.ok) {
                            showMessage('Replay saved: ' + saveResult.filename, 2000);
                            window.open(saveResult.viewerUrl, '_blank');
                        }
                    })
                    .catch(function(err) {
                        showMessage('Save failed: ' + err.message);
                    });
                } else if (job.status === 'failed') {
                    clearInterval(pollInterval);
                    showMessage('C++ replay failed: ' + (job.error || 'unknown error'));
                }
            })
            .catch(function() {
                clearInterval(pollInterval);
                showMessage('Lost connection to MC server');
            });
        }, 500);
    }

    // -------------------------------------------------------------------
    // Palette Wiring
    // -------------------------------------------------------------------

    /**
     * Build a map from palette subtype to ObjectPalette template.
     */
    function _buildPaletteTemplateMap() {
        if (typeof ObjectPalette === 'undefined') return;
        var templates = ObjectPalette.getTemplates();
        // Map by lowercase name fragment and type
        var subtypeNameMap = {
            // Aircraft — Blue
            'f16': 'F-16C Fighting Falcon',
            'f15': 'F-15E Strike Eagle',
            'f22': 'F-22A Raptor',
            'f35': 'F-35A Lightning II',
            'f18': 'F/A-18E Super Hornet',
            'a10': 'A-10C Thunderbolt II',
            'b2': 'B-2A Spirit',
            'b1b': 'B-1B Lancer',
            'e3_awacs': 'E-3G Sentry AWACS',
            'c130': 'C-130J Super Hercules',
            'mq9': 'MQ-9A Reaper',
            'rq4': 'RQ-4B Global Hawk',
            'spaceplane': 'X-37S Spaceplane',
            // Aircraft — Red
            'mig29': 'MiG-29 Fulcrum',
            'su27': 'Su-27S Flanker',
            'su35': 'Su-35S Flanker-E',
            'su57': 'Su-57 Felon',
            'tu160': 'Tu-160 Blackjack',
            'tu22m': 'Tu-22M3 Backfire',
            'tb2': 'Bayraktar TB2',
            // Spacecraft
            'leo_sat': 'LEO Satellite',
            'gps_sat': 'GPS Satellite',
            'geo_comms': 'GEO Comms Satellite',
            'sat_inspector': 'Satellite Inspector',
            'img_sat': 'Imaging Satellite',
            'sso_weather': 'SSO Weather Sat',
            'molniya_sat': 'Molniya Orbit Sat',
            'kosmos_sat': 'Kosmos Radar Sat',
            'asat': 'Co-Orbital ASAT',
            // Ground — Blue
            'ground_station': 'Ground Station',
            'gps_receiver': 'GPS Receiver',
            'm1a2': 'M1A2 Abrams',
            'hmmwv': 'HMMWV',
            'patriot': 'Patriot Battery',
            'thaad': 'THAAD Battery',
            'avenger': 'Avenger SHORAD',
            'cmd_post': 'Command Post',
            // Ground — Red
            'sam_battery': 'SAM Battery',
            'ew_radar': 'EW Radar',
            't90': 'T-90 Main Battle Tank',
            's400': 'S-400 Triumf',
            'pantsir': 'Pantsir-S1',
            'tor_m2': 'Tor-M2',
            // Naval — Blue
            'cvn_nimitz': 'CVN Nimitz Carrier',
            'ddg_burke': 'DDG Arleigh Burke',
            'ssn_virginia': 'SSN Virginia',
            'ffg_const': 'FFG Constellation',
            'lhd_wasp': 'LHD Wasp',
            // Naval — Red
            'kirov': 'Kirov Battlecruiser',
            'kuznetsov': 'Admiral Kuznetsov',
            'kilo_sub': 'Kilo-class Submarine',
            'slava': 'Slava-class Cruiser'
        };
        for (var subtype in subtypeNameMap) {
            var tpl = ObjectPalette.getTemplateByName(subtypeNameMap[subtype]);
            if (tpl) {
                _paletteTemplateMap[subtype] = tpl;
            }
        }
    }

    /**
     * Wire click events on HTML palette items.
     */
    function _wirePaletteItems() {
        var items = document.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            // Skip custom platform items — they have their own handler from _addToDOMPalette
            if (items[i].hasAttribute('data-custom-id')) continue;

            (function(item) {
                item.addEventListener('click', function() {
                    var subtype = item.getAttribute('data-subtype');
                    var template = _paletteTemplateMap[subtype];
                    if (template) {
                        startPlacement(template);
                    } else {
                        // Fallback: build a minimal template from data attributes
                        var entityType = item.getAttribute('data-entity-type') || 'generic';
                        var team = item.getAttribute('data-team') || 'neutral';
                        var nameEl = item.querySelector('.palette-item-name');
                        var name = nameEl ? nameEl.textContent : entityType;
                        startPlacement({
                            name: name,
                            type: entityType,
                            team: team,
                            defaults: { alt: 0, speed: 0 },
                            components: {
                                visual: { type: 'point', color: '#ffffff', pixelSize: 10 }
                            }
                        });
                    }
                });
            })(items[i]);
        }
    }

    /**
     * Highlight the active palette item.
     */
    function _highlightPaletteItem(template) {
        var items = document.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove('selected');
        }
        // Find the matching item by subtype or name
        if (!template) return;
        for (var j = 0; j < items.length; j++) {
            var nameEl = items[j].querySelector('.palette-item-name');
            if (nameEl && nameEl.textContent === template.name) {
                items[j].classList.add('selected');
                break;
            }
        }
    }

    /**
     * Wire palette section collapse/expand headers.
     */
    function _wirePaletteSections() {
        var headers = document.querySelectorAll('.palette-section-header');
        for (var i = 0; i < headers.length; i++) {
            (function(header) {
                header.addEventListener('click', function() {
                    // Body is next sibling element
                    var bodyEl = header.nextElementSibling;
                    if (bodyEl) {
                        var isOpen = bodyEl.classList.contains('open');
                        bodyEl.classList.toggle('open');
                        header.classList.toggle('open');
                    }
                });
            })(headers[i]);
        }
    }

    // -------------------------------------------------------------------
    // Inspector Wiring
    // -------------------------------------------------------------------

    /**
     * Wire change events on the pre-built HTML inspector form fields.
     * Only called once during init.
     */
    function _wireInspectorFields() {
        if (_inspectorBound) return;
        _inspectorBound = true;

        // Name
        _wireField('inspName', 'input', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { name: val });
        });

        // Team
        _wireField('inspTeam', 'change', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { team: val });
        });

        // Position
        _wireNumericField('inspLat', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { lat: val } });
        });
        _wireNumericField('inspLon', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { lon: val } });
        });
        _wireNumericField('inspAlt', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { alt: val } });
            _validateInspectorFields();
        });

        // State
        _wireNumericField('inspSpeed', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { speed: val } });
            _validateInspectorFields();
        });
        _wireNumericField('inspHeading', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { heading: val } });
        });
        _wireNumericField('inspGamma', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { gamma: val } });
        });

        // Throttle slider
        var throttleEl = document.getElementById('inspThrottle');
        var throttleValEl = document.getElementById('inspThrottleValue');
        if (throttleEl) {
            throttleEl.addEventListener('input', function() {
                var val = parseFloat(throttleEl.value);
                if (throttleValEl) throttleValEl.textContent = Math.round(val * 100) + '%';
                if (_selectedEntityId && !isNaN(val)) {
                    updateEntityDef(_selectedEntityId, { initialState: { throttle: val } });
                }
            });
        }
    }

    function _wireField(id, event, onChange) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener(event, function() {
            onChange(el.value);
        });
    }

    function _wireNumericField(id, onChange) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', function() {
            var val = parseFloat(el.value);
            if (!isNaN(val)) onChange(val);
        });
    }

    // -------------------------------------------------------------------
    // Entity Validation Warnings
    // -------------------------------------------------------------------

    /**
     * Show or hide a validation warning below an inspector field.
     * @param {string} warningId - DOM id of the warning div
     * @param {string|null} message - Warning text, or null to hide
     */
    function _setValidationWarning(warningId, message) {
        var el = document.getElementById(warningId);
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.classList.add('visible');
        } else {
            el.textContent = '';
            el.classList.remove('visible');
        }
    }

    /**
     * Run validation checks on the currently selected entity and show/hide warnings.
     * Warnings are advisory only -- they do not block edits.
     */
    function _validateInspectorFields() {
        if (!_selectedEntityId) {
            _setValidationWarning('inspAltWarning', null);
            _setValidationWarning('inspSpeedWarning', null);
            return;
        }

        var def = _findEntityDef(_selectedEntityId);
        if (!def) return;

        var init = def.initialState || {};
        var entityType = def.type || '';

        // --- Altitude validation ---
        var altVal = init.alt !== undefined ? init.alt : 0;
        var altWarning = null;

        if (entityType === 'aircraft' && altVal > 30000) {
            altWarning = 'Warning: ' + Math.round(altVal/1000) + 'km is above typical aircraft ceiling (~30km). Consider using Spaceplane for high altitudes.';
        } else if (entityType === 'satellite') {
            // Check if using COE (sma-based) or state-based altitude
            var comps = def.components || {};
            var phys = comps.physics || {};
            if (phys.sma) {
                var smaKm = phys.sma / 1000;
                if (smaKm < 6500) {
                    altWarning = 'Warning: SMA ' + smaKm.toFixed(0) + 'km is below Earth surface (6371km). Satellite will crash.';
                }
                if (phys.eccentricity > 0.99) {
                    altWarning = 'Warning: Eccentricity ' + phys.eccentricity.toFixed(4) + ' is near escape velocity. Orbit prediction may be unstable.';
                }
            } else if (altVal < 150000) {
                altWarning = 'Warning: ' + Math.round(altVal/1000) + 'km is very low orbit. Atmospheric drag will decay orbit rapidly below ~200km.';
            }
        } else if (entityType === 'ground' && altVal > 5000) {
            altWarning = 'Warning: ' + altVal + 'm is very high for a ground entity. Most terrain is below 5000m.';
        }
        _setValidationWarning('inspAltWarning', altWarning);

        // --- Speed validation ---
        var speedVal = init.speed !== undefined ? init.speed : 0;
        var speedWarning = null;

        if (speedVal < 0) {
            speedWarning = 'Warning: Speed is negative. Speed should be 0 or positive.';
        } else if (entityType === 'aircraft' && speedVal > 1000) {
            speedWarning = 'Warning: ' + speedVal + ' m/s (' + (speedVal * 3.6).toFixed(0) + ' km/h) exceeds most aircraft limits. Use Spaceplane for hypersonic flight.';
        }
        _setValidationWarning('inspSpeedWarning', speedWarning);
    }

    /**
     * Wire the delete entity button.
     */
    function _wireDeleteButton() {
        var btn = document.getElementById('deleteEntityBtn');
        if (btn) {
            btn.addEventListener('click', function() {
                if (!_selectedEntityId) return;
                var def = _findEntityDef(_selectedEntityId);
                var name = def ? (def.name || def.id) : _selectedEntityId;
                _showConfirm('Delete Entity', 'Delete entity "' + name + '"?', 'Delete', true).then(function(ok) {
                    if (ok) removeEntity(_selectedEntityId);
                });
            });
        }
    }

    // -------------------------------------------------------------------
    // Panel Toggle Wiring
    // -------------------------------------------------------------------

    function _wirePanelToggles() {
        _wireToggle('toggleLeft', 'leftSidebar');
        _wireToggle('toggleRight', 'rightSidebar');
        _wireToggle('toggleBottom', 'bottomPanel');
    }

    function _wireToggle(btnId, panelId) {
        var btn = document.getElementById(btnId);
        var panel = document.getElementById(panelId);
        if (!btn || !panel) return;

        btn.addEventListener('click', function() {
            var isHidden = panel.style.display === 'none';
            panel.style.display = isHidden ? '' : 'none';
            btn.classList.toggle('shifted');
        });
    }

    // -------------------------------------------------------------------
    // Toolbar Wiring
    // -------------------------------------------------------------------

    function _wireToolbar() {
        _bindButton('btnNew', function() {
            newScenario();
        });

        _bindButton('btnOpen', function() {
            ScenarioIO.openFile().then(function(json) {
                setScenarioData(json);
            }).catch(function(err) {
                if (err.message !== 'No file selected') {
                    showMessage('Open failed: ' + err.message);
                }
            });
        });

        _bindButton('btnSave', function() {
            ScenarioIO.saveFile(getScenarioData());
        });

        // Add Platform button
        _bindButton('btnAddPlatform', function() {
            if (typeof PlatformBuilder !== 'undefined') {
                PlatformBuilder.show().then(function(platform) {
                    showMessage('Created platform: ' + platform.name, 3000);
                    // Refresh the palette to show the new custom template
                    if (typeof ObjectPalette !== 'undefined') {
                        ObjectPalette.refresh();
                    }
                }).catch(function(err) {
                    // User cancelled - do nothing
                });
            }
        });

        // Environment settings
        _bindButton('btnEnvironment', function() {
            if (typeof EnvironmentDialog !== 'undefined') {
                var env = _scenarioData ? _scenarioData.environment : {};
                EnvironmentDialog.show(env || {}).then(function(updatedEnv) {
                    if (_scenarioData) _scenarioData.environment = updatedEnv;
                    showMessage('Environment updated', 2000);
                }).catch(function() { /* cancelled */ });
            }
        });

        // Communications network designer
        _bindButton('btnComms', function() {
            if (typeof CommDesigner !== 'undefined') {
                // Gather current entities for the designer
                var entities = [];
                _buildEntities.forEach(function(entry, id) {
                    entities.push(entry.def);
                });
                // Load existing networks if any
                if (_scenarioData && _scenarioData.networks) {
                    CommDesigner.setNetworks(_scenarioData.networks);
                }
                CommDesigner.open(entities);
                // Poll for close to sync networks back into scenario data
                var commPoll = setInterval(function() {
                    var overlay = document.querySelector('.cd-overlay');
                    if (!overlay || overlay.style.display === 'none') {
                        clearInterval(commPoll);
                        if (_scenarioData) {
                            _scenarioData.networks = CommDesigner.getNetworks();
                            showMessage('Networks updated (' + _scenarioData.networks.length + ')', 2000);
                        }
                    }
                }, 500);
            }
        });

        // Region Editor panel toggle and draw tools
        _bindButton('btnRegions', function() {
            var panel = document.getElementById('regionEditorPanel');
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });

        var btnDrawCircle = document.getElementById('btnDrawCircle');
        if (btnDrawCircle) btnDrawCircle.onclick = function() {
            if (typeof RegionEditor === 'undefined') return;
            RegionEditor.startCircleDraw();
            var inst = document.getElementById('drawInstructions');
            if (inst) { inst.style.display = 'block'; inst.textContent = 'Click center, then click edge to set radius.'; }
            var cancelBtn = document.getElementById('btnCancelDraw');
            if (cancelBtn) cancelBtn.style.display = 'inline-block';
            btnDrawCircle.style.borderColor = '#ff8844';
            btnDrawCircle.style.color = '#ff8844';
            var polyBtn = document.getElementById('btnDrawPolygon');
            if (polyBtn) { polyBtn.style.borderColor = '#555'; polyBtn.style.color = '#aaa'; }
        };

        var btnDrawPolygon = document.getElementById('btnDrawPolygon');
        if (btnDrawPolygon) btnDrawPolygon.onclick = function() {
            if (typeof RegionEditor === 'undefined') return;
            RegionEditor.startPolygonDraw();
            var inst = document.getElementById('drawInstructions');
            if (inst) { inst.style.display = 'block'; inst.textContent = 'Click to add vertices. Right-click to finish (min 3 points).'; }
            var cancelBtn = document.getElementById('btnCancelDraw');
            if (cancelBtn) cancelBtn.style.display = 'inline-block';
            btnDrawPolygon.style.borderColor = '#ff8844';
            btnDrawPolygon.style.color = '#ff8844';
            var circleBtn = document.getElementById('btnDrawCircle');
            if (circleBtn) { circleBtn.style.borderColor = '#555'; circleBtn.style.color = '#aaa'; }
        };

        var btnCancelDraw = document.getElementById('btnCancelDraw');
        if (btnCancelDraw) btnCancelDraw.onclick = function() {
            if (typeof RegionEditor !== 'undefined') RegionEditor.cancelDraw();
            _resetRegionDrawUI();
        };

        var btnCloseRegions = document.getElementById('btnCloseRegions');
        if (btnCloseRegions) btnCloseRegions.onclick = function() {
            var panel = document.getElementById('regionEditorPanel');
            if (panel) panel.style.display = 'none';
            if (typeof RegionEditor !== 'undefined') RegionEditor.cancelDraw();
            _resetRegionDrawUI();
        };

        var btnClearRegions = document.getElementById('btnClearRegions');
        if (btnClearRegions) btnClearRegions.onclick = function() {
            if (typeof RegionEditor !== 'undefined') RegionEditor.clearAll();
        };

        // Listen for region events to hide draw instructions
        if (typeof RegionEditor !== 'undefined') {
            RegionEditor.on('regionAdded', function() {
                _resetRegionDrawUI();
            });
        }

        // Validate scenario
        _bindButton('btnValidate', function() {
            if (typeof ScenarioValidator === 'undefined') return;
            var issues = [];
            // Run data-level validation first
            var dataResult = _validateForRun(getScenarioData());
            if (dataResult.errors.length > 0) {
                for (var ei = 0; ei < dataResult.errors.length; ei++) {
                    issues.push({ level: 'error', msg: dataResult.errors[ei], entityId: null });
                }
            }
            if (dataResult.warnings.length > 0) {
                for (var wi = 0; wi < dataResult.warnings.length; wi++) {
                    issues.push({ level: 'warning', msg: dataResult.warnings[wi], entityId: null });
                }
            }
            // Run ECS-level validation if world exists (RUN mode)
            if (_world) {
                var ecsIssues = ScenarioValidator.validate(_world);
                for (var k = 0; k < ecsIssues.length; k++) {
                    issues.push(ecsIssues[k]);
                }
            } else {
                // BUILD mode: try building a temporary headless world for deeper checks
                var scenarioData = getScenarioData();
                if (scenarioData && scenarioData.entities && scenarioData.entities.length > 0) {
                    try {
                        var tempWorld = ScenarioLoader.build(scenarioData, null);
                        tempWorld.headless = true;
                        var ecsIssues2 = ScenarioValidator.validate(tempWorld);
                        for (var m = 0; m < ecsIssues2.length; m++) {
                            issues.push(ecsIssues2[m]);
                        }
                    } catch (buildErr) {
                        issues.push({ level: 'error', msg: 'ECS build failed: ' + buildErr.message, entityId: null });
                    }
                }
            }
            // Deduplicate by message
            var seen = {};
            var deduped = [];
            for (var d = 0; d < issues.length; d++) {
                var key = issues[d].level + ':' + issues[d].msg;
                if (!seen[key]) {
                    seen[key] = true;
                    deduped.push(issues[d]);
                }
            }
            // Sort: errors first, then warnings, then info
            var levelOrder = { error: 0, warning: 1, info: 2 };
            deduped.sort(function(a, b) {
                return (levelOrder[a.level] || 3) - (levelOrder[b.level] || 3);
            });
            _showValidationPanel(deduped);
        });

        // Close validation panel
        var validationCloseBtn = document.getElementById('validationClose');
        if (validationCloseBtn) {
            validationCloseBtn.addEventListener('click', function() {
                var panel = document.getElementById('validationPanel');
                if (panel) panel.style.display = 'none';
            });
        }

        // Export dropdown toggle
        _bindButton('btnExport', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.toggle('open');
        });

        // Close export dropdown on outside click
        document.addEventListener('click', function(e) {
            var dropdown = document.getElementById('btnExport');
            var menu = document.getElementById('exportDropdownMenu');
            if (dropdown && menu && !dropdown.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('open');
            }
        });

        // Export Sim — live ECS physics in viewer
        _bindButton('btnExportSim', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            // Pre-flight validation
            var valResult = _validateForRun(getScenarioData());
            if (!valResult.ok || valResult.warnings.length > 0) {
                _showValidationReport(valResult, 'Export Sim').then(function(proceed) {
                    if (proceed) _doExportSim();
                });
            } else {
                _doExportSim();
            }
        });

        function _doExportSim() {
            ScenarioIO.exportToViewer(getScenarioData())
                .then(function(result) {
                    showMessage('Exported Sim: ' + result.filename, 3000);
                    window.open(result.viewerUrl, '_blank');
                })
                .catch(function(err) {
                    if (err.message !== 'cancelled') {
                        showMessage('Export failed: ' + err.message);
                    }
                });
        }

        // Export Model — headless run → CZML rapid playback
        _bindButton('btnExportModel', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            // Pre-flight validation
            var valResult = _validateForRun(getScenarioData());
            if (!valResult.ok || valResult.warnings.length > 0) {
                _showValidationReport(valResult, 'Export Model').then(function(proceed) {
                    if (proceed) _doExportModel();
                });
            } else {
                _doExportModel();
            }
        });

        function _doExportModel() {
            _showPrompt('Export Model', 'Simulation duration (seconds):', '600').then(function(durationStr) {
                var duration = parseFloat(durationStr);
                if (isNaN(duration) || duration <= 0) {
                    showMessage('Invalid duration');
                    return;
                }

                _showExportProgress('EXPORTING MODEL');

                // Use setTimeout to let progress overlay render
                setTimeout(function() {
                    ScenarioIO.exportModel(getScenarioData(), _viewer, duration, 2, function(pct, label) {
                        _updateExportProgress(pct, label);
                    })
                        .then(function(result) {
                            _hideExportProgress();
                            showMessage('Model exported: ' + result.entityCount + ' entities, ' +
                                        result.duration + 's → ' + result.steps + ' samples', 4000);
                            window.open(result.viewerUrl, '_blank');
                        })
                        .catch(function(err) {
                            _hideExportProgress();
                            if (err.message !== 'cancelled') {
                                showMessage('Model export failed: ' + err.message);
                                console.error('Model export error:', err);
                            }
                        });
                }, 50);
            }).catch(function() { /* cancelled */ });
        }

        // Export C++ Replay — run scenario in C++ engine and open replay viewer
        _bindButton('btnExportCppReplay', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            var scenarioData = getScenarioData();

            // Pre-flight validation
            var valResult = _validateForRun(scenarioData);
            if (!valResult.ok) {
                _showValidationReport(valResult, 'C++ Replay');
                return;
            }

            // Check engine availability first
            showMessage('Checking C++ engine...', 2000);

            fetch('/api/mc/status')
                .then(function(resp) { return resp.json(); })
                .then(function(status) {
                    if (!status.ready) {
                        showMessage('C++ engine not available. Start mc_server: node mc_server.js');
                        return;
                    }
                    _promptAndRunCppReplay(scenarioData);
                })
                .catch(function() {
                    showMessage('MC server not running. Start with: node mc_server.js');
                });
        });

        // Export DIS — binary PDU file
        _bindButton('btnExportDIS', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            if (typeof DISManager === 'undefined') {
                showMessage('DIS module not loaded');
                return;
            }

            _showPrompt('DIS Export', 'Simulation duration (seconds):', '600').then(function(durationStr) {
                var duration = parseFloat(durationStr);
                if (isNaN(duration) || duration <= 0) {
                    showMessage('Invalid duration');
                    return;
                }

                showMessage('Running headless DIS export for ' + duration + 's...', 5000);

                setTimeout(function() {
                    DISManager.exportBatch(getScenarioData(), _viewer, duration)
                        .then(function(result) {
                            showMessage('DIS exported: ' + result.pduCount + ' PDUs, ' +
                                        (result.bytesTotal / 1024).toFixed(1) + ' KB → ' + result.filename, 4000);
                        })
                        .catch(function(err) {
                            if (err.message !== 'Export cancelled') {
                                showMessage('DIS export failed: ' + err.message);
                                console.error('DIS export error:', err);
                            }
                        });
                }, 100);
            }).catch(function() { /* cancelled */ });
        });

        // DIS streaming toggle
        _bindButton('btnDISToggle', function() {
            _disEnabled = !_disEnabled;
            var btn = document.getElementById('btnDISToggle');
            if (btn) {
                btn.textContent = _disEnabled ? 'DIS: ON' : 'DIS: OFF';
                btn.style.borderColor = _disEnabled ? '#00ff00' : '#1a2a44';
                btn.style.color = _disEnabled ? '#00ff00' : '#a0b0c8';
            }

            // If currently running, start/stop streaming
            if (_mode === 'RUN' && _world && typeof DISManager !== 'undefined') {
                if (_disEnabled) {
                    DISManager.startStreaming(_world);
                    showMessage('DIS streaming started');
                } else {
                    DISManager.stopStreaming();
                    showMessage('DIS streaming stopped');
                }
            }
        });

        // Launch Sim — save .sim file and open live sim viewer with splash screen
        _bindButton('btnLaunchSim', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            var scenarioData = getScenarioData();
            if (!scenarioData || !scenarioData.entities || scenarioData.entities.length === 0) {
                showMessage('No entities in scenario');
                return;
            }

            // Save as .sim file, then open live sim viewer (splash screen handles entity selection)
            var name = (scenarioData.metadata && scenarioData.metadata.name) || _scenarioName || 'Untitled';
            showMessage('Saving sim...', 2000);

            fetch('/api/sim/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, scenario: scenarioData })
            })
            .then(function(resp) { return resp.json(); })
            .then(function(result) {
                if (result.error) {
                    showMessage('Save failed: ' + result.error);
                    return;
                }
                // Open live sim viewer — splash screen handles entity selection
                var liveUrl = 'live_sim_viewer.html?sim=' + encodeURIComponent(result.filename);
                window.open(liveUrl, '_blank');
                showMessage('Sim saved: ' + result.filename, 2000);
            })
            .catch(function(err) {
                showMessage('Launch failed: ' + err.message);
            });
        });

        // Launch Observer — same as Launch Sim but with __observer__ player
        _bindButton('btnLaunchObserver', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            var scenarioData = getScenarioData();
            if (!scenarioData || !scenarioData.entities || scenarioData.entities.length === 0) {
                showMessage('No entities in scenario');
                return;
            }

            var name = (scenarioData.metadata && scenarioData.metadata.name) || _scenarioName || 'Untitled';
            showMessage('Saving sim...', 2000);

            fetch('/api/sim/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name, scenario: scenarioData })
            })
            .then(function(resp) { return resp.json(); })
            .then(function(result) {
                if (result.error) {
                    showMessage('Save failed: ' + result.error);
                    return;
                }
                var liveUrl = 'live_sim_viewer.html?sim=' + encodeURIComponent(result.filename) + '&player=__observer__';
                window.open(liveUrl, '_blank');
                showMessage('Observer launched: ' + result.filename, 2000);
            })
            .catch(function(err) {
                showMessage('Launch failed: ' + err.message);
            });
        });

        _bindButton('btnImportTLE', function() {
            ScenarioIO.importTLEFile().catch(function(err) {
                if (err.message !== 'No file selected') {
                    showMessage('TLE import: ' + err.message);
                }
            });
        });

        _bindButton('btnTLECatalog', function() {
            ScenarioIO.importTLECatalog().catch(function(err) {
                showMessage('TLE catalog: ' + err.message);
            });
        });

        // Events editor
        _bindButton('btnEvents', function() {
            if (typeof EventEditor !== 'undefined') {
                EventEditor.show(_scenarioData);
            } else {
                showMessage('Event Editor not loaded');
            }
        });

        // Demo dropdown toggle
        _bindButton('btnLoadDemo', function() {
            var menu = document.getElementById('demoDropdownMenu');
            if (menu) {
                menu.classList.toggle('open');
            }
        });

        // Demo dropdown items
        var demoItems = document.querySelectorAll('.demo-dropdown-item');
        for (var d = 0; d < demoItems.length; d++) {
            (function(item) {
                item.addEventListener('click', function() {
                    var scenarioName = item.getAttribute('data-scenario');
                    _loadDemoScenario(scenarioName);
                    var menu = document.getElementById('demoDropdownMenu');
                    if (menu) menu.classList.remove('open');
                });
            })(demoItems[d]);
        }

        // Close demo dropdown when clicking elsewhere
        document.addEventListener('click', function(e) {
            var menu = document.getElementById('demoDropdownMenu');
            if (menu) {
                var dropdown = menu.parentElement;
                if (dropdown && !dropdown.contains(e.target)) {
                    menu.classList.remove('open');
                }
            }
        });

        _bindButton('btnRun', function() {
            switchMode('RUN');
        });

        _bindButton('btnPause', function() {
            if (_world) {
                _world.isPaused = !_world.isPaused;
                showMessage(_world.isPaused ? 'PAUSED' : 'RESUMED');
                _updateModeUI();
            }
        });

        _bindButton('btnAnalyze', function() {
            switchMode('ANALYZE');
        });

        _bindButton('btnMonteCarlo', function() {
            if (_mode !== 'BUILD') {
                showMessage('Switch to BUILD mode first');
                return;
            }
            if (typeof MCPanel !== 'undefined') {
                MCPanel.show();
            }
        });

        _bindButton('btnDOE', function() {
            if (_mode !== 'BUILD') {
                showMessage('Switch to BUILD mode first');
                return;
            }
            if (typeof DOEPanel !== 'undefined') {
                DOEPanel.show();
            }
        });

        _bindButton('btnReset', function() {
            switchMode('BUILD');
        });
    }

    function _bindButton(id, handler) {
        var el = document.getElementById(id);
        if (el) {
            el.addEventListener('click', handler);
        }
    }

    function _resetRegionDrawUI() {
        var inst = document.getElementById('drawInstructions');
        if (inst) inst.style.display = 'none';
        var cancelBtn = document.getElementById('btnCancelDraw');
        if (cancelBtn) cancelBtn.style.display = 'none';
        var circleBtn = document.getElementById('btnDrawCircle');
        if (circleBtn) { circleBtn.style.borderColor = '#555'; circleBtn.style.color = '#aaa'; }
        var polyBtn = document.getElementById('btnDrawPolygon');
        if (polyBtn) { polyBtn.style.borderColor = '#555'; polyBtn.style.color = '#aaa'; }
    }

    // -------------------------------------------------------------------
    // UI Updates — Mode Indicator
    // -------------------------------------------------------------------

    function _updateModeUI() {
        // Mode badge (HTML id: modeBadge)
        var modeEl = document.getElementById('modeBadge');
        if (modeEl) {
            modeEl.textContent = _mode;
            modeEl.className = _mode.toLowerCase();
        }

        // Enable/disable buttons based on mode
        _setButtonEnabled('btnRun', _mode === 'BUILD');
        _setButtonEnabled('btnPause', _mode === 'RUN');
        _setButtonEnabled('btnAnalyze', _mode === 'RUN');
        _setButtonEnabled('btnReset', _mode === 'RUN' || _mode === 'ANALYZE');
        _setButtonEnabled('btnNew', _mode === 'BUILD');
        _setButtonEnabled('btnOpen', _mode === 'BUILD');
        _setButtonEnabled('btnSave', _mode === 'BUILD');
        _setButtonEnabled('btnExport', _mode === 'BUILD');
        _setButtonEnabled('btnImportTLE', _mode === 'BUILD');
        _setButtonEnabled('btnTLECatalog', _mode === 'BUILD');
        _setButtonEnabled('btnEvents', _mode === 'BUILD');
        _setButtonEnabled('btnMonteCarlo', _mode === 'BUILD');
        _setButtonEnabled('btnDOE', _mode === 'BUILD');
        _setButtonEnabled('btnLoadDemo', _mode === 'BUILD');

        // Update pause button text
        var pauseBtn = document.getElementById('btnPause');
        if (pauseBtn && _world) {
            pauseBtn.textContent = _world.isPaused ? 'Resume' : 'Pause';
        }
    }

    function _setButtonEnabled(id, enabled) {
        var el = document.getElementById(id);
        if (el) {
            el.disabled = !enabled;
            el.style.opacity = enabled ? '1' : '0.4';
        }
    }

    // -------------------------------------------------------------------
    // UI Updates — Sim Time Display
    // -------------------------------------------------------------------

    function _updateSimTimeDisplay() {
        if (!_world) return;
        var simEl = document.getElementById('simTimeDisplay');
        if (simEl) {
            var t = _world.simTime;
            var h = Math.floor(t / 3600);
            var m = Math.floor((t % 3600) / 60);
            var s = Math.floor(t % 60);
            simEl.textContent = _pad2(h) + ':' + _pad2(m) + ':' + _pad2(s);
        }

        var warpEl = document.getElementById('timeWarpDisplay');
        if (warpEl) {
            warpEl.textContent = _world.timeWarp + 'x';
        }
    }

    function _pad2(n) {
        return n < 10 ? '0' + n : '' + n;
    }

    // -------------------------------------------------------------------
    // UI Updates — Property Inspector
    // -------------------------------------------------------------------

    /**
     * Update the property inspector to show the selected entity's data,
     * or show the empty state if nothing is selected.
     */
    function _updateInspectorUI() {
        var emptyEl = document.getElementById('inspectorEmpty');
        var contentEl = document.getElementById('inspectorContent');
        var deleteBar = document.getElementById('inspectorDeleteBar');
        var typeEl = document.getElementById('inspectorEntityType');

        if (!_selectedEntityId) {
            // Show empty state
            if (emptyEl) emptyEl.style.display = 'block';
            if (contentEl) contentEl.style.display = 'none';
            if (deleteBar) deleteBar.style.display = 'none';
            if (typeEl) typeEl.textContent = '';
            return;
        }

        var def = _findEntityDef(_selectedEntityId);
        if (!def) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (contentEl) contentEl.style.display = 'none';
            if (deleteBar) deleteBar.style.display = 'none';
            return;
        }

        // Show content, hide empty
        if (emptyEl) emptyEl.style.display = 'none';
        if (contentEl) contentEl.style.display = 'block';
        if (deleteBar) deleteBar.style.display = 'block';
        if (typeEl) typeEl.textContent = def.type || '';

        var init = def.initialState || {};

        // Populate form fields
        _setFieldValue('inspName', def.name || '');
        _setFieldValue('inspId', def.id || '');
        _setFieldValue('inspType', def.type || '');
        _setSelectValue('inspTeam', def.team || 'neutral');
        _setFieldValue('inspLat', _fmtNum(init.lat, 3));
        _setFieldValue('inspLon', _fmtNum(init.lon, 3));
        _setFieldValue('inspAlt', _fmtNum(init.alt, 0));
        _setFieldValue('inspSpeed', _fmtNum(init.speed, 1));
        _setFieldValue('inspHeading', _fmtNum(init.heading, 1));
        _setFieldValue('inspGamma', _fmtNum(init.gamma, 1));

        // Throttle slider
        var throttle = init.throttle !== undefined ? init.throttle : 0.6;
        var throttleEl = document.getElementById('inspThrottle');
        var throttleValEl = document.getElementById('inspThrottleValue');
        if (throttleEl) throttleEl.value = throttle;
        if (throttleValEl) throttleValEl.textContent = Math.round(throttle * 100) + '%';

        // Component summary
        _renderComponentSummary(def);

        // Run validation warnings
        _validateInspectorFields();
    }

    function _setFieldValue(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value;
    }

    function _setSelectValue(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value;
    }

    function _fmtNum(val, decimals) {
        if (val === undefined || val === null) return '0';
        return Number(val).toFixed(decimals);
    }

    /**
     * Render component summary into #inspectorComponents.
     */
    function _renderComponentSummary(def) {
        var container = document.getElementById('inspectorComponents');
        if (!container) return;
        container.innerHTML = '';

        var comps = def.components || {};
        for (var cat in comps) {
            var spec = comps[cat];
            if (!spec) continue;

            var section = document.createElement('div');
            section.className = 'inspector-section';

            var title = document.createElement('div');
            title.className = 'inspector-section-title';
            title.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
            if (spec.type) {
                title.textContent += ': ' + spec.type;
            }
            if (spec.config && typeof spec.config === 'string') {
                title.textContent += ' (' + spec.config + ')';
            }
            title.style.cursor = 'default';
            section.appendChild(title);

            // COE editor for orbital physics
            if (cat === 'physics' && spec.type === 'orbital_2body' && spec.source === 'elements') {
                _renderCOEEditor(section, def, spec);
            }

            container.appendChild(section);
        }
    }

    /**
     * Render editable COE fields inside a physics component section.
     */
    function _renderCOEEditor(section, def, spec) {
        var R_EARTH_KM = 6371;
        var MU_EARTH = 3.986004418e14;

        var coeFields = [
            { key: 'sma',         label: 'SMA (km)',           val: (spec.sma || 0) / 1000, convert: function(v) { return v * 1000; }, decimals: 1 },
            { key: 'eccentricity',label: 'Eccentricity',       val: spec.eccentricity || 0, convert: null, decimals: 4 },
            { key: 'inclination', label: 'Inclination (\u00B0)', val: spec.inclination || 0, convert: null, decimals: 2 },
            { key: 'raan',        label: 'RAAN (\u00B0)',      val: spec.raan || 0, convert: null, decimals: 2 },
            { key: 'argPerigee',  label: 'Arg Perigee (\u00B0)', val: spec.argPerigee || 0, convert: null, decimals: 2 },
            { key: 'meanAnomaly', label: 'Mean Anom (\u00B0)', val: spec.meanAnomaly || 0, convert: null, decimals: 2 }
        ];

        var grid = document.createElement('div');
        grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:4px 8px; padding:6px 0;';

        for (var i = 0; i < coeFields.length; i++) {
            var f = coeFields[i];

            var lbl = document.createElement('label');
            lbl.textContent = f.label;
            lbl.style.cssText = 'color:#88aa88; font-size:11px; align-self:center;';
            grid.appendChild(lbl);

            var inp = document.createElement('input');
            inp.type = 'number';
            inp.value = f.val.toFixed(f.decimals);
            inp.step = f.decimals > 2 ? 0.001 : 0.1;
            inp.style.cssText = 'background:#1a2a1a; border:1px solid #334433; color:#00ff00; ' +
                'font-family:monospace; font-size:11px; padding:3px 6px; width:100%; box-sizing:border-box;';
            grid.appendChild(inp);

            // Wire change handler
            (function(field, input) {
                input.addEventListener('change', function() {
                    var val = parseFloat(input.value);
                    if (isNaN(val)) return;
                    var storeVal = field.convert ? field.convert(val) : val;
                    var compUpdate = {};
                    compUpdate[field.key] = storeVal;
                    // Merge into the physics component spec
                    var physSpec = def.components.physics;
                    for (var k in compUpdate) {
                        physSpec[k] = compUpdate[k];
                    }
                    // Also update initialState alt to match periapsis
                    if (field.key === 'sma' || field.key === 'eccentricity') {
                        var sma = physSpec.sma || 0;
                        var ecc = physSpec.eccentricity || 0;
                        var periAlt = sma * (1 - ecc) - 6371000;
                        updateEntityDef(def.id, { initialState: { alt: periAlt } });
                    }
                    _updateCOEComputed(section, physSpec);
                });
            })(f, inp);
        }

        section.appendChild(grid);

        // Computed readouts
        var computed = document.createElement('div');
        computed.className = 'coe-computed';
        computed.style.cssText = 'padding:4px 0; font-size:11px; color:#668866;';
        section.appendChild(computed);

        _updateCOEComputed(section, spec);
    }

    /**
     * Update the computed periapsis/apoapsis/period display in a COE editor section.
     */
    function _updateCOEComputed(section, spec) {
        var computed = section.querySelector('.coe-computed');
        if (!computed) return;

        var R_EARTH_KM = 6371;
        var MU_EARTH = 3.986004418e14;
        var sma_km = (spec.sma || 0) / 1000;
        var ecc = spec.eccentricity || 0;

        if (sma_km <= 0 || ecc < 0 || ecc >= 1) {
            computed.textContent = 'Invalid elements';
            return;
        }

        var periAlt = (sma_km * (1 - ecc) - R_EARTH_KM).toFixed(1);
        var apoAlt = (sma_km * (1 + ecc) - R_EARTH_KM).toFixed(1);
        var sma_m = sma_km * 1000;
        var period_s = 2 * Math.PI * Math.sqrt(sma_m * sma_m * sma_m / MU_EARTH);
        var period_min = (period_s / 60).toFixed(1);

        computed.textContent = 'Pe: ' + periAlt + ' km  |  Ap: ' + apoAlt + ' km  |  T: ' + period_min + ' min';
    }

    // -------------------------------------------------------------------
    // UI Updates — Entity Tree
    // -------------------------------------------------------------------

    /**
     * Throttled entity list update — prevents DOM thrashing during drag ops.
     */
    function _updateEntityListUI() {
        if (_entityListThrottleTimer) {
            _entityListPendingUpdate = true;
            return;
        }
        _doUpdateEntityListUI();
        _entityListThrottleTimer = setTimeout(function() {
            _entityListThrottleTimer = null;
            if (_entityListPendingUpdate) {
                _entityListPendingUpdate = false;
                _doUpdateEntityListUI();
            }
        }, 250);
    }

    /**
     * Update the entity tree in the bottom panel (direct, unthrottled).
     */
    function _doUpdateEntityListUI() {
        var tableEl = document.getElementById('entityTreeTable');
        var countEl = document.getElementById('entityCount');
        var emptyEl = document.getElementById('treeEmptyMsg');

        var entities = _scenarioData ? (_scenarioData.entities || []) : [];

        // Update count
        if (countEl) {
            countEl.textContent = entities.length + ' entit' + (entities.length === 1 ? 'y' : 'ies');
        }

        if (!tableEl) return;

        // Clear existing rows (keep the empty message element)
        var rows = tableEl.querySelectorAll('.tree-row');
        for (var r = 0; r < rows.length; r++) {
            rows[r].remove();
        }

        // Show/hide empty message
        if (emptyEl) {
            emptyEl.style.display = entities.length === 0 ? 'block' : 'none';
        }

        // Add entity rows
        for (var i = 0; i < entities.length; i++) {
            var def = entities[i];
            var row = _createEntityRow(def);
            tableEl.appendChild(row);
        }

        // Re-apply entity tree filter (preserves filter across rebuilds)
        if (typeof EntityTree !== 'undefined' && EntityTree.applyFilter) {
            EntityTree.applyFilter();
        }
    }

    /**
     * Create a single entity row for the tree.
     */
    function _createEntityRow(def) {
        var row = document.createElement('div');
        row.className = 'tree-row';
        if (def.id === _selectedEntityId) {
            row.classList.add('selected');
        }
        row.setAttribute('data-entity-id', def.id);

        // Team dot
        var dot = document.createElement('span');
        dot.className = 'tree-team-dot';
        var teamClass = 'team-' + (def.team || 'neutral');
        dot.classList.add(teamClass);
        row.appendChild(dot);

        // Name
        var name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = def.name || def.id;
        row.appendChild(name);

        // Type
        var type = document.createElement('span');
        type.className = 'tree-type';
        type.textContent = def.type || '';
        row.appendChild(type);

        // Position (show alt in km for satellites)
        var pos = document.createElement('span');
        pos.className = 'tree-position';
        var init = def.initialState || {};
        if (def.type === 'satellite' && init.alt > 1000) {
            pos.textContent = Math.round(init.alt / 1000) + 'km';
        } else if (init.lat !== undefined && init.lon !== undefined) {
            pos.textContent = Number(init.lat).toFixed(2) + '\u00B0, ' +
                              Number(init.lon).toFixed(2) + '\u00B0';
        }
        row.appendChild(pos);

        // Click to select
        (function(entityId) {
            row.addEventListener('click', function() {
                selectEntity(entityId);
            });
        })(def.id);

        return row;
    }

    // -------------------------------------------------------------------
    // Loading Overlay
    // -------------------------------------------------------------------

    function _dismissLoadingOverlay() {
        var overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
            setTimeout(function() {
                overlay.style.display = 'none';
            }, 600);
        }
    }

    // -------------------------------------------------------------------
    // Keyboard Shortcuts (time warp, pause, etc.)
    // -------------------------------------------------------------------

    function _wireKeyboard() {
        document.addEventListener('keydown', function(e) {
            // Don't capture keys when typing in input/select fields
            var tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

            // Help dialog — ? key works in any mode
            if (e.key === '?') {
                e.preventDefault();
                _toggleHelpDialog();
                return;
            }

            // Escape closes help dialog or cancels region drawing
            if (e.key === 'Escape') {
                var helpOverlay = document.getElementById('helpDialogOverlay');
                if (helpOverlay && helpOverlay.style.display !== 'none') {
                    helpOverlay.style.display = 'none';
                    return;
                }
                // Cancel region drawing if active
                if (typeof RegionEditor !== 'undefined' && RegionEditor.isDrawing) {
                    RegionEditor.cancelDraw();
                    _resetRegionDrawUI();
                    return;
                }
            }

            // V key for Event Editor in BUILD mode
            if (_mode === 'BUILD' && (e.key === 'v' || e.key === 'V')) {
                e.preventDefault();
                if (typeof EventEditor !== 'undefined') {
                    EventEditor.show(_scenarioData);
                }
                return;
            }

            // Delete key in BUILD mode
            if (_mode === 'BUILD' && (e.key === 'Delete' || e.key === 'Backspace')) {
                if (_selectedEntityId) {
                    var def = _findEntityDef(_selectedEntityId);
                    var eName = def ? (def.name || def.id) : _selectedEntityId;
                    var eid = _selectedEntityId;
                    _showConfirm('Delete Entity', 'Delete entity "' + eName + '"?', 'Delete', true).then(function(ok) {
                        if (ok) removeEntity(eid);
                    });
                }
                return;
            }

            if (_mode === 'RUN' && _world) {
                if (e.key === '=' || e.key === '+') {
                    // Increase time warp
                    e.preventDefault();
                    var maxWarp = _world._maxTimeWarp || 1024;
                    _world.timeWarp = Math.min(_world.timeWarp * 2, maxWarp);
                    showMessage('Time Warp: ' + _world.timeWarp + 'x');
                    _updateSimTimeDisplay();
                } else if (e.key === '-' || e.key === '_') {
                    // Decrease time warp
                    e.preventDefault();
                    _world.timeWarp = Math.max(Math.floor(_world.timeWarp / 2), 1);
                    showMessage('Time Warp: ' + _world.timeWarp + 'x');
                    _updateSimTimeDisplay();
                } else if (e.key === ' ') {
                    // Toggle pause
                    e.preventDefault();
                    _world.isPaused = !_world.isPaused;
                    showMessage(_world.isPaused ? 'PAUSED' : 'RESUMED');
                    _updateModeUI();
                }
            }
        });
    }

    // -------------------------------------------------------------------
    // Cursor Coordinate Readout
    // -------------------------------------------------------------------

    function _wireCursorCoords() {
        var coordsEl = document.getElementById('cursorCoords');
        if (!coordsEl || !_viewer) return;

        var handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
        handler.setInputAction(function(movement) {
            if (_mode !== 'BUILD') {
                coordsEl.style.display = 'none';
                return;
            }

            var cartesian = _viewer.scene.pickPosition(movement.endPosition);
            if (!cartesian) {
                // Try globe pick as fallback
                var ray = _viewer.camera.getPickRay(movement.endPosition);
                cartesian = _viewer.scene.globe.pick(ray, _viewer.scene);
            }

            if (cartesian) {
                var carto = Cesium.Cartographic.fromCartesian(cartesian);
                var latDeg = Cesium.Math.toDegrees(carto.latitude);
                var lonDeg = Cesium.Math.toDegrees(carto.longitude);
                var alt = carto.height;

                var latDir = latDeg >= 0 ? 'N' : 'S';
                var lonDir = lonDeg >= 0 ? 'E' : 'W';

                coordsEl.textContent =
                    Math.abs(latDeg).toFixed(4) + '\u00B0' + latDir + '  ' +
                    Math.abs(lonDeg).toFixed(4) + '\u00B0' + lonDir + '  ' +
                    'ALT: ' + (alt > 1000 ? (alt / 1000).toFixed(1) + 'km' : Math.round(alt) + 'm');
                coordsEl.style.display = 'block';
            } else {
                coordsEl.style.display = 'none';
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    }

    // -------------------------------------------------------------------
    // Scenario Name Editor
    // -------------------------------------------------------------------

    function _wireScenarioName() {
        var nameDisplay = document.getElementById('scenarioNameDisplay');
        var nameInput = document.getElementById('scenarioNameInput');
        if (!nameDisplay || !nameInput) return;

        nameDisplay.addEventListener('click', function() {
            nameDisplay.style.display = 'none';
            nameInput.style.display = 'inline-block';
            nameInput.value = _scenarioName;
            nameInput.focus();
            nameInput.select();
        });

        function commitName() {
            var val = nameInput.value.trim();
            if (val) _scenarioName = val;
            nameDisplay.textContent = _scenarioName;
            nameDisplay.style.display = 'inline-block';
            nameInput.style.display = 'none';

            // Update scenario data metadata
            if (_scenarioData && _scenarioData.metadata) {
                _scenarioData.metadata.name = _scenarioName;
            }
        }

        nameInput.addEventListener('blur', commitName);
        nameInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitName();
            }
            if (e.key === 'Escape') {
                nameDisplay.style.display = 'inline-block';
                nameInput.style.display = 'none';
            }
        });
    }

    function getScenarioName() {
        return _scenarioName;
    }

    // -------------------------------------------------------------------
    // Help Dialog
    // -------------------------------------------------------------------

    function _toggleHelpDialog() {
        var overlay = document.getElementById('helpDialogOverlay');
        if (!overlay) return;

        if (overlay.style.display === 'none' || !overlay.style.display) {
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
        }
    }

    // -------------------------------------------------------------------
    // Run-Mode HUD
    // -------------------------------------------------------------------

    function _showRunHUD(visible) {
        var hud = document.getElementById('runHUD');
        if (hud) hud.style.display = visible ? 'block' : 'none';
    }

    function _updateRunHUD() {
        var hud = document.getElementById('runHUD');
        if (!hud || _mode !== 'RUN') return;

        // FPS calculation
        var now = Date.now();
        while (_fpsFrames.length > 0 && now - _fpsFrames[0] > 1000) {
            _fpsFrames.shift();
        }
        var fps = _fpsFrames.length;

        // Sim time
        var simTime = _world ? _world.simTime : 0;
        var h = Math.floor(simTime / 3600);
        var m = Math.floor((simTime % 3600) / 60);
        var s = Math.floor(simTime % 60);

        // Entity counts
        var totalEntities = 0;
        var activeEntities = 0;
        if (_world) {
            _world.entities.forEach(function(e) {
                totalEntities++;
                if (e.active) activeEntities++;
            });
        }

        // Sensor detections
        var detections = 0;
        if (_world) {
            _world.entities.forEach(function(e) {
                var radar = e.getComponent('sensors');
                if (radar && radar._detectedEntities) {
                    detections += radar._detectedEntities.size || 0;
                }
            });
        }

        // Weapon engagements
        var engagements = 0;
        if (_world) {
            _world.entities.forEach(function(e) {
                var wep = e.getComponent('weapons');
                if (wep && wep._engagements) {
                    engagements += wep._engagements.length || 0;
                }
            });
        }

        // DIS stats
        var disLine = '';
        if (_disEnabled && typeof DISManager !== 'undefined') {
            var disStats = DISManager.getStats();
            disLine = 'DIS ' + disStats.pdusSent + ' PDUs  ' +
                (disStats.bytesTotal / 1024).toFixed(1) + ' KB';
        }

        // Build HUD text
        var lines = [
            'SIM  ' + _pad2(h) + ':' + _pad2(m) + ':' + _pad2(s) + '  ' + (_world ? _world.timeWarp : 1) + 'x',
            'FPS  ' + fps,
            'ENT  ' + activeEntities + '/' + totalEntities,
            'DET  ' + detections,
            'WPN  ' + engagements
        ];
        if (disLine) lines.push(disLine);

        hud.textContent = lines.join('\n');
    }

    // -------------------------------------------------------------------
    // DIS Indicator
    // -------------------------------------------------------------------

    function _updateDISIndicator(status) {
        var dot = document.getElementById('disStatusDot');
        if (!dot) return;

        if (status === 'connected' || status === 'streaming') {
            dot.style.background = '#00ff00';
            dot.title = 'DIS: Streaming';
        } else if (status === 'http-fallback') {
            dot.style.background = '#ffaa00';
            dot.title = 'DIS: HTTP fallback';
        } else if (status === 'error') {
            dot.style.background = '#ff4444';
            dot.title = 'DIS: Error';
        } else {
            dot.style.background = '#444';
            dot.title = 'DIS: Disconnected';
        }
    }

    // -------------------------------------------------------------------
    // Entity Count Badge
    // -------------------------------------------------------------------

    function _updatePaletteCount() {
        var badge = document.getElementById('paletteCountBadge');
        if (badge && _scenarioData) {
            var count = (_scenarioData.entities || []).length;
            badge.textContent = count;
        }
    }

    // -------------------------------------------------------------------
    // Toast Notification
    // -------------------------------------------------------------------

    function showMessage(text, duration) {
        duration = duration || 2000;

        var msgEl = document.getElementById('messageOverlay');
        if (!msgEl) {
            msgEl = document.createElement('div');
            msgEl.id = 'messageOverlay';
            msgEl.style.cssText = 'position:fixed; bottom:200px; left:50%; transform:translateX(-50%); z-index:200; pointer-events:none;';
            document.body.appendChild(msgEl);
        }

        // Create toast element
        var toast = document.createElement('div');
        toast.style.cssText = 'background:rgba(0,0,0,0.85); color:#00ff00; font-family:monospace; ' +
            'font-size:14px; padding:8px 20px; border:1px solid #00aa00; border-radius:4px; ' +
            'opacity:1; transition:opacity 0.5s; margin-top:4px; text-align:center;';
        toast.textContent = text;
        msgEl.appendChild(toast);

        setTimeout(function() {
            toast.style.opacity = '0';
            setTimeout(function() {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 500);
        }, duration);
    }

    // -------------------------------------------------------------------
    // Styled Modal (replaces browser prompt/confirm)
    // -------------------------------------------------------------------

    /**
     * Show a styled prompt modal. Returns a Promise that resolves with
     * the user's input string, or rejects if cancelled.
     * @param {string} title     Modal title
     * @param {string} label     Body text / label for the input
     * @param {string} defaultVal Default value for the input field
     * @returns {Promise<string>}
     */
    function _showPrompt(title, label, defaultVal) {
        return new Promise(function(resolve, reject) {
            var overlay = document.createElement('div');
            overlay.className = 'sb-modal-overlay';

            var html = '<div class="sb-modal">' +
                '<div class="sb-modal-title">' + _escHtml(title) + '</div>' +
                '<div class="sb-modal-body">' + _escHtml(label) + '</div>' +
                '<input class="sb-modal-input" type="text" value="' + _escAttr(defaultVal || '') + '">' +
                '<div class="sb-modal-buttons">' +
                '<button class="sb-modal-btn sb-modal-btn-cancel">Cancel</button>' +
                '<button class="sb-modal-btn sb-modal-btn-ok">OK</button>' +
                '</div></div>';
            overlay.innerHTML = html;
            document.body.appendChild(overlay);

            var input = overlay.querySelector('.sb-modal-input');
            var btnOk = overlay.querySelector('.sb-modal-btn-ok');
            var btnCancel = overlay.querySelector('.sb-modal-btn-cancel');

            function cleanup() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
            function doOk() { var v = input.value; cleanup(); resolve(v); }
            function doCancel() { cleanup(); reject(new Error('cancelled')); }

            btnOk.addEventListener('click', doOk);
            btnCancel.addEventListener('click', doCancel);
            overlay.addEventListener('click', function(e) { if (e.target === overlay) doCancel(); });
            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') { e.preventDefault(); doOk(); }
                if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
            });

            input.focus();
            input.select();
        });
    }

    /**
     * Show a styled confirm modal. Returns a Promise that resolves to true
     * (confirmed) or false (cancelled).
     * @param {string} title   Modal title
     * @param {string} message Body message
     * @param {string} [okLabel]  Label for OK button (default "Delete")
     * @param {boolean} [danger]  If true, OK button is red
     * @returns {Promise<boolean>}
     */
    function _showConfirm(title, message, okLabel, danger) {
        return new Promise(function(resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'sb-modal-overlay';

            var btnClass = danger ? 'sb-modal-btn-danger' : 'sb-modal-btn-ok';
            var html = '<div class="sb-modal">' +
                '<div class="sb-modal-title">' + _escHtml(title) + '</div>' +
                '<div class="sb-modal-body">' + _escHtml(message) + '</div>' +
                '<div class="sb-modal-buttons">' +
                '<button class="sb-modal-btn sb-modal-btn-cancel">Cancel</button>' +
                '<button class="sb-modal-btn ' + btnClass + '">' + _escHtml(okLabel || 'Delete') + '</button>' +
                '</div></div>';
            overlay.innerHTML = html;
            document.body.appendChild(overlay);

            var btnOk = overlay.querySelector('.' + btnClass);
            var btnCancel = overlay.querySelector('.sb-modal-btn-cancel');

            function cleanup() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

            btnOk.addEventListener('click', function() { cleanup(); resolve(true); });
            btnCancel.addEventListener('click', function() { cleanup(); resolve(false); });
            overlay.addEventListener('click', function(e) { if (e.target === overlay) { cleanup(); resolve(false); } });
            document.addEventListener('keydown', function onKey(e) {
                if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(); resolve(false); }
                if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); cleanup(); resolve(true); }
            });
        });
    }

    function _escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function _escAttr(s) { return s.replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

    // -------------------------------------------------------------------
    // Autosave System
    // -------------------------------------------------------------------

    function _startAutosave() {
        if (_autosaveTimer) clearInterval(_autosaveTimer);
        _autosaveTimer = setInterval(function() {
            if (_mode !== 'BUILD') return;
            if (!_scenarioData || !_scenarioData.entities || _scenarioData.entities.length === 0) return;
            try {
                var payload = JSON.stringify({
                    timestamp: Date.now(),
                    scenario: _scenarioData
                });
                localStorage.setItem(_AUTOSAVE_KEY, payload);
            } catch (e) {
                // localStorage full or unavailable — ignore
            }
        }, _AUTOSAVE_INTERVAL);
    }

    function _checkAutosave() {
        try {
            var raw = localStorage.getItem(_AUTOSAVE_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            if (!data.scenario || !data.scenario.entities || data.scenario.entities.length === 0) return;

            var banner = document.getElementById('autosaveBanner');
            var timeEl = document.getElementById('autosaveTime');
            var restoreBtn = document.getElementById('autosaveRestore');
            var dismissBtn = document.getElementById('autosaveDismiss');
            if (!banner) return;

            // Show time
            var age = Date.now() - data.timestamp;
            var ageMin = Math.floor(age / 60000);
            var ageStr;
            if (ageMin < 1) ageStr = 'Just now';
            else if (ageMin < 60) ageStr = ageMin + ' min ago';
            else if (ageMin < 1440) ageStr = Math.floor(ageMin / 60) + 'h ago';
            else ageStr = Math.floor(ageMin / 1440) + 'd ago';

            var entCount = data.scenario.entities.length;
            var scenName = (data.scenario.metadata && data.scenario.metadata.name) || 'Untitled';
            if (timeEl) timeEl.textContent = '"' + scenName + '" — ' + entCount + ' entities — ' + ageStr;

            banner.style.display = 'flex';

            restoreBtn.addEventListener('click', function() {
                banner.style.display = 'none';
                setScenarioData(data.scenario);
                showMessage('Scenario restored from autosave', 3000);
                localStorage.removeItem(_AUTOSAVE_KEY);
            });

            dismissBtn.addEventListener('click', function() {
                banner.style.display = 'none';
                localStorage.removeItem(_AUTOSAVE_KEY);
            });

            // Auto-dismiss after 30 seconds
            setTimeout(function() {
                banner.style.display = 'none';
            }, 30000);
        } catch (e) {
            // Corrupted autosave — remove it
            localStorage.removeItem(_AUTOSAVE_KEY);
        }
    }

    function _clearAutosave() {
        try { localStorage.removeItem(_AUTOSAVE_KEY); } catch (e) { /* ignore */ }
    }

    // -------------------------------------------------------------------
    // Scenario Validation Panel
    // -------------------------------------------------------------------

    function _showValidationPanel(issues) {
        var panel = document.getElementById('validationPanel');
        var results = document.getElementById('validationResults');
        var title = document.getElementById('validationTitle');
        if (!panel || !results) return;

        var errors = issues.filter(function(i) { return i.level === 'error'; }).length;
        var warnings = issues.filter(function(i) { return i.level === 'warning'; }).length;
        var infos = issues.filter(function(i) { return i.level === 'info'; }).length;

        if (title) {
            if (errors > 0) {
                title.textContent = 'VALIDATION: ' + errors + ' ERROR(S)';
                title.style.color = '#ff4444';
            } else if (warnings > 0) {
                title.textContent = 'VALIDATION: ' + warnings + ' WARNING(S)';
                title.style.color = '#ffcc00';
            } else if (infos > 0) {
                title.textContent = 'VALIDATION: ALL CLEAR (' + infos + ' notes)';
                title.style.color = '#00ff88';
            } else {
                title.textContent = 'VALIDATION: PERFECT';
                title.style.color = '#00ff88';
            }
        }

        if (issues.length === 0) {
            results.innerHTML = '<div style="color:#00ff88; padding:16px; text-align:center;">No issues found. Scenario looks good!</div>';
        } else {
            var html = '';
            var levelColors = { error: '#ff4444', warning: '#ffcc00', info: '#4488ff' };
            var levelIcons = { error: '&#x2717;', warning: '&#x26A0;', info: '&#x2139;' };
            for (var i = 0; i < issues.length; i++) {
                var issue = issues[i];
                var color = levelColors[issue.level] || '#aaa';
                var icon = levelIcons[issue.level] || '?';
                html += '<div style="display:flex; align-items:flex-start; gap:8px; padding:6px 8px; margin:3px 0; background:rgba(0,0,0,0.2); border-radius:3px; border-left:3px solid ' + color + ';">';
                html += '<span style="color:' + color + '; font-size:13px; flex-shrink:0;">' + icon + '</span>';
                html += '<div>';
                html += '<span style="color:' + color + '; font-size:11px;">' + _escHtml(issue.level.toUpperCase()) + '</span>';
                html += '<div style="color:#ccc; font-size:11px; margin-top:2px;">' + _escHtml(issue.msg) + '</div>';
                html += '</div>';
                html += '</div>';
            }
            results.innerHTML = html;
        }

        panel.style.display = 'block';
    }

    // -------------------------------------------------------------------
    // Pre-flight Validation
    // -------------------------------------------------------------------

    /**
     * Validate scenario for simulation/export readiness.
     * Returns { ok, errors[], warnings[] }.
     */
    function _validateForRun(scenarioData) {
        var errors = [];
        var warnings = [];

        if (!scenarioData) {
            errors.push('No scenario data');
            return { ok: false, errors: errors, warnings: warnings };
        }

        var entities = scenarioData.entities || [];
        if (entities.length === 0) {
            errors.push('No entities in scenario');
            return { ok: false, errors: errors, warnings: warnings };
        }

        var hasPhysics = false;
        var teamCounts = {};

        for (var i = 0; i < entities.length; i++) {
            var ent = entities[i];
            var label = ent.name || ent.id || ('index ' + i);

            // Check required fields
            if (!ent.id) errors.push('"' + label + '": missing entity id');
            if (!ent.type) errors.push('"' + label + '": missing entity type');

            // Check initialState
            if (!ent.initialState || typeof ent.initialState !== 'object') {
                errors.push('"' + label + '": missing initialState');
            } else {
                var s = ent.initialState;
                if (s.lat === undefined && s.lon === undefined && s.alt === undefined) {
                    errors.push('"' + label + '": no position (lat/lon/alt) set');
                }
                if (typeof s.lat === 'number' && (s.lat < -90 || s.lat > 90)) {
                    errors.push('"' + label + '": latitude out of range [-90, 90]');
                }
                if (typeof s.alt === 'number' && s.alt < 0) {
                    warnings.push('"' + label + '": negative altitude (' + s.alt.toFixed(0) + 'm)');
                }
            }

            // Check physics component
            if (ent.components && ent.components.physics) {
                hasPhysics = true;
                var phys = ent.components.physics;
                if (phys.type === 'orbital_2body' && phys.source === 'tle') {
                    if (!phys.tle_line1 || !phys.tle_line2) {
                        errors.push('"' + label + '": TLE orbital entity missing TLE lines');
                    }
                }
                if (phys.type === 'orbital_2body' && phys.source === 'coe') {
                    if (phys.sma_km !== undefined && phys.sma_km < 6371) {
                        errors.push('"' + label + '": SMA below Earth surface');
                    }
                }
            }

            // Team counts
            var team = ent.team || 'neutral';
            teamCounts[team] = (teamCounts[team] || 0) + 1;
        }

        if (!hasPhysics) {
            warnings.push('No entities have physics components — nothing will move');
        }

        // Combat warnings
        if (teamCounts.blue && teamCounts.red) {
            // good — opposing teams
        } else if (teamCounts.blue && !teamCounts.red) {
            warnings.push('No red team entities — no combat will occur');
        } else if (!teamCounts.blue && teamCounts.red) {
            warnings.push('No blue team entities — no combat will occur');
        }

        return {
            ok: errors.length === 0,
            errors: errors,
            warnings: warnings
        };
    }

    /**
     * Show validation results in a styled modal. Returns Promise<boolean>
     * (true = user proceeds, false = user cancelled).
     * If only warnings (no errors), user can proceed. If errors, blocks.
     */
    function _showValidationReport(result, actionLabel) {
        return new Promise(function(resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'sb-modal-overlay';

            var title = result.ok ? 'VALIDATION PASSED' : 'VALIDATION ISSUES';
            var bodyLines = '';

            if (result.errors.length > 0) {
                for (var i = 0; i < result.errors.length; i++) {
                    bodyLines += '<div class="sb-val-error">&#x2716; ' + _escHtml(result.errors[i]) + '</div>';
                }
            }
            if (result.warnings.length > 0) {
                for (var j = 0; j < result.warnings.length; j++) {
                    bodyLines += '<div class="sb-val-warning">&#x26A0; ' + _escHtml(result.warnings[j]) + '</div>';
                }
            }
            if (result.errors.length === 0 && result.warnings.length === 0) {
                bodyLines = '<div class="sb-val-ok">&#x2714; All checks passed</div>';
            }

            var canProceed = result.errors.length === 0;
            var btnHtml = '<button class="sb-modal-btn sb-modal-btn-cancel">Cancel</button>';
            if (canProceed) {
                btnHtml += '<button class="sb-modal-btn sb-modal-btn-ok">' + _escHtml(actionLabel || 'Proceed') + '</button>';
            }

            var html = '<div class="sb-modal">' +
                '<div class="sb-modal-title">' + title + '</div>' +
                '<div class="sb-validation-list">' + bodyLines + '</div>' +
                '<div class="sb-modal-buttons">' + btnHtml + '</div></div>';
            overlay.innerHTML = html;
            document.body.appendChild(overlay);

            var btnOk = overlay.querySelector('.sb-modal-btn-ok');
            var btnCancel = overlay.querySelector('.sb-modal-btn-cancel');

            function cleanup() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }

            if (btnOk) btnOk.addEventListener('click', function() { cleanup(); resolve(true); });
            btnCancel.addEventListener('click', function() { cleanup(); resolve(false); });
            overlay.addEventListener('click', function(e) { if (e.target === overlay) { cleanup(); resolve(false); } });
        });
    }

    // -------------------------------------------------------------------
    // Export Progress Indicator
    // -------------------------------------------------------------------

    function _showExportProgress(title) {
        var overlay = document.getElementById('exportProgressOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            var titleEl = document.getElementById('exportProgressTitle');
            var bar = document.getElementById('exportProgressBar');
            var label = document.getElementById('exportProgressLabel');
            if (titleEl) titleEl.textContent = title || 'EXPORTING';
            if (bar) bar.style.width = '0%';
            if (label) label.textContent = 'Preparing...';
        }
    }

    function _updateExportProgress(pct, labelText) {
        var bar = document.getElementById('exportProgressBar');
        var label = document.getElementById('exportProgressLabel');
        if (bar) bar.style.width = Math.min(100, pct).toFixed(0) + '%';
        if (label) label.textContent = labelText || (pct.toFixed(0) + '%');
    }

    function _hideExportProgress() {
        var overlay = document.getElementById('exportProgressOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        init: init,
        getViewer: getViewer,
        getMode: getMode,
        getScenarioData: getScenarioData,
        setScenarioData: setScenarioData,
        getSelectedEntityId: getSelectedEntityId,
        selectEntity: selectEntity,
        deselectEntity: deselectEntity,
        startPlacement: startPlacement,
        cancelPlacement: cancelPlacement,
        getPlacementTemplate: getPlacementTemplate,
        addEntity: addEntity,
        removeEntity: removeEntity,
        updateEntityDef: updateEntityDef,
        switchMode: switchMode,
        newScenario: newScenario,
        showMessage: showMessage,
        getScenarioName: getScenarioName,
        showPrompt: _showPrompt,
        showConfirm: _showConfirm,
        validateForRun: _validateForRun
    };
})();
