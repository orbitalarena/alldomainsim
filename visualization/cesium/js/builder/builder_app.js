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

        Cesium.createWorldTerrainAsync().then(function(terrain) {
            _viewer.terrainProvider = terrain;
        }).catch(function(e) {
            console.warn('World terrain unavailable:', e);
        });

        // ArcGIS imagery if available
        if (typeof addArcGISProviders === 'function') {
            addArcGISProviders(_viewer);
        }

        _viewer.scene.globe.enableLighting = true;

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
        });

        // State
        _wireNumericField('inspSpeed', function(val) {
            if (_selectedEntityId) updateEntityDef(_selectedEntityId, { initialState: { speed: val } });
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
                if (confirm('Delete entity "' + name + '"?')) {
                    removeEntity(_selectedEntityId);
                }
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

            ScenarioIO.exportToViewer(getScenarioData())
                .then(function(result) {
                    showMessage('Exported Sim: ' + result.filename, 3000);
                    window.open(result.viewerUrl, '_blank');
                })
                .catch(function(err) {
                    if (err.message !== 'Export cancelled') {
                        showMessage('Export failed: ' + err.message);
                    }
                });
        });

        // Export Model — headless run → CZML rapid playback
        _bindButton('btnExportModel', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            var durationStr = prompt('Simulation duration (seconds):', '600');
            if (!durationStr) return;
            var duration = parseFloat(durationStr);
            if (isNaN(duration) || duration <= 0) {
                showMessage('Invalid duration');
                return;
            }

            showMessage('Running headless sim for ' + duration + 's...', 5000);

            // Use setTimeout to allow message to display before blocking run
            setTimeout(function() {
                ScenarioIO.exportModel(getScenarioData(), _viewer, duration, 2)
                    .then(function(result) {
                        showMessage('Model exported: ' + result.entityCount + ' entities, ' +
                                    result.duration + 's → ' + result.steps + ' samples', 4000);
                        window.open(result.viewerUrl, '_blank');
                    })
                    .catch(function(err) {
                        if (err.message !== 'Export cancelled') {
                            showMessage('Model export failed: ' + err.message);
                            console.error('Model export error:', err);
                        }
                    });
            }, 100);
        });

        // Export DIS — binary PDU file
        _bindButton('btnExportDIS', function() {
            var menu = document.getElementById('exportDropdownMenu');
            if (menu) menu.classList.remove('open');

            if (typeof DISManager === 'undefined') {
                showMessage('DIS module not loaded');
                return;
            }

            var durationStr = prompt('Simulation duration (seconds):', '600');
            if (!durationStr) return;
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

        _bindButton('btnImportTLE', function() {
            ScenarioIO.importTLEFile().catch(function(err) {
                if (err.message !== 'No file selected') {
                    showMessage('TLE import: ' + err.message);
                }
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
        _setButtonEnabled('btnEvents', _mode === 'BUILD');
        _setButtonEnabled('btnMonteCarlo', _mode === 'BUILD');
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

            // Escape closes help dialog
            if (e.key === 'Escape') {
                var helpOverlay = document.getElementById('helpDialogOverlay');
                if (helpOverlay && helpOverlay.style.display !== 'none') {
                    helpOverlay.style.display = 'none';
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
                    var name = def ? (def.name || def.id) : _selectedEntityId;
                    if (confirm('Delete entity "' + name + '"?')) {
                        removeEntity(_selectedEntityId);
                    }
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
        getScenarioName: getScenarioName
    };
})();
