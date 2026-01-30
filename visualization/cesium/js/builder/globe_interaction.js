/**
 * GlobeInteraction - Cesium globe mouse interaction handler for the Scenario Builder.
 *
 * Handles click-to-select, click-to-place, drag-to-move, right-click context menu,
 * and cursor feedback. All editing interactions are disabled in RUN mode.
 */
const GlobeInteraction = (function() {
    'use strict';

    // -------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------
    var _viewer = null;
    var _handler = null;
    var _mode = 'BUILD';

    // Drag state
    var _dragging = false;
    var _dragEntityId = null;
    var _dragStartPosition = null;

    // Context menu element
    var _contextMenu = null;
    var _contextEntityId = null;

    // -------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------

    /**
     * Install click, move, and context-menu handlers on the Cesium viewer.
     * @param {Cesium.Viewer} viewer
     */
    function init(viewer) {
        _viewer = viewer;
        _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

        // Left click
        _handler.setInputAction(_onLeftClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        // Left down (start drag)
        _handler.setInputAction(_onLeftDown, Cesium.ScreenSpaceEventType.LEFT_DOWN);

        // Mouse move
        _handler.setInputAction(_onMouseMove, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        // Left up (end drag)
        _handler.setInputAction(_onLeftUp, Cesium.ScreenSpaceEventType.LEFT_UP);

        // Right click (context menu)
        _handler.setInputAction(_onRightClick, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // Create context menu element
        _createContextMenu();

        // Hide context menu on any left click or scroll
        document.addEventListener('click', function(e) {
            if (_contextMenu && !_contextMenu.contains(e.target)) {
                _hideContextMenu();
            }
        });

        document.addEventListener('wheel', function() {
            _hideContextMenu();
        });
    }

    /**
     * Set the interaction mode.
     * @param {string} mode  'BUILD' | 'RUN' | 'ANALYZE'
     */
    function setMode(mode) {
        _mode = mode;
        _hideContextMenu();
        _cancelDrag();

        if (mode !== 'BUILD') {
            _viewer.container.style.cursor = 'default';
        }
    }

    // -------------------------------------------------------------------
    // Left Click Handler
    // -------------------------------------------------------------------

    function _onLeftClick(event) {
        if (_mode !== 'BUILD') return;

        // If we just finished a drag, do not treat the mouseup-click as a selection
        if (_dragging) return;

        var position = event.position;
        if (!position) return;

        // Check if placement mode is active
        var template = BuilderApp.getPlacementTemplate();
        if (template) {
            _handlePlacement(position, template);
            return;
        }

        // Otherwise, try to select an entity
        var entityId = _pickBuildEntity(position);
        if (entityId) {
            BuilderApp.selectEntity(entityId);
        } else {
            BuilderApp.deselectEntity();
        }
    }

    // -------------------------------------------------------------------
    // Placement
    // -------------------------------------------------------------------

    /**
     * Handle click-to-place: create an entity at the clicked globe position.
     */
    /**
     * Check if a template represents a satellite (uses orbital physics).
     */
    function _isSatelliteTemplate(template) {
        if (template.type === 'satellite') return true;
        if (template.components && template.components.physics &&
            template.components.physics.type === 'orbital_2body') return true;
        return false;
    }

    function _handlePlacement(screenPosition, template) {
        var cartesian = _pickGlobePosition(screenPosition);
        if (!cartesian) {
            BuilderApp.showMessage('Click on the globe to place entity');
            return;
        }

        var latLon = _cartesianToLatLon(cartesian);

        // Satellite placement: show COE dialog
        if (_isSatelliteTemplate(template) && typeof SatelliteDialog !== 'undefined') {
            // Exit placement mode immediately so cursor resets
            BuilderApp.cancelPlacement();

            SatelliteDialog.show(template, latLon).then(function(coe) {
                var entityDef = {
                    id: (template.type || 'satellite') + '_' + Date.now(),
                    name: template.name || template.type || 'Satellite',
                    type: template.type || 'satellite',
                    team: template.team || 'neutral',
                    initialState: {
                        lat: latLon.lat,
                        lon: latLon.lon,
                        alt: (coe.sma * (1 - coe.ecc)) - 6371000, // periapsis altitude
                        speed: 0,
                        heading: 0,
                        gamma: 0,
                        throttle: 0,
                        engineOn: false,
                        infiniteFuel: true
                    },
                    components: Object.assign({}, template.components || {}, {
                        physics: {
                            type: 'orbital_2body',
                            source: 'elements',
                            sma: coe.sma,
                            eccentricity: coe.ecc,
                            inclination: coe.inc,
                            raan: coe.raan,
                            argPerigee: coe.argPerigee,
                            meanAnomaly: coe.meanAnomaly
                        }
                    })
                };

                var newId = BuilderApp.addEntity(entityDef);
                BuilderApp.selectEntity(newId);
            }).catch(function() {
                // User cancelled — do nothing
            });
            return;
        }

        // Non-satellite placement: direct entity creation
        var entityDef = {
            id: (template.type || 'entity') + '_' + Date.now(),
            name: template.name || template.type || 'Entity',
            type: template.type || 'generic',
            team: template.team || 'neutral',
            initialState: {
                lat: latLon.lat,
                lon: latLon.lon,
                alt: (template.initialState && template.initialState.alt) || latLon.alt || 0,
                speed: (template.initialState && template.initialState.speed) || 0,
                heading: (template.initialState && template.initialState.heading) || 0,
                gamma: (template.initialState && template.initialState.gamma) || 0,
                throttle: (template.initialState && template.initialState.throttle) || 0.6,
                engineOn: template.initialState ? (template.initialState.engineOn !== undefined ? template.initialState.engineOn : true) : true,
                gearDown: template.initialState ? !!template.initialState.gearDown : false,
                infiniteFuel: template.initialState ? (template.initialState.infiniteFuel !== undefined ? template.initialState.infiniteFuel : true) : true
            },
            components: template.components || {}
        };

        // Add the entity
        var newId = BuilderApp.addEntity(entityDef);

        // Auto-select the new entity
        BuilderApp.selectEntity(newId);

        // Exit placement mode (one-shot)
        BuilderApp.cancelPlacement();
    }

    // -------------------------------------------------------------------
    // Drag-to-Move
    // -------------------------------------------------------------------

    function _onLeftDown(event) {
        if (_mode !== 'BUILD') return;

        // Do not start drag in placement mode
        if (BuilderApp.getPlacementTemplate()) return;

        var position = event.position;
        if (!position) return;

        var entityId = _pickBuildEntity(position);
        if (!entityId) return;

        // Start drag
        _dragEntityId = entityId;
        _dragStartPosition = Cesium.Cartesian2.clone(position);
        _dragging = false; // Will become true once mouse actually moves

        // Disable camera controls during drag
        _viewer.scene.screenSpaceCameraController.enableRotate = false;
        _viewer.scene.screenSpaceCameraController.enableTranslate = false;
        _viewer.scene.screenSpaceCameraController.enableZoom = false;
        _viewer.scene.screenSpaceCameraController.enableTilt = false;
        _viewer.scene.screenSpaceCameraController.enableLook = false;
    }

    function _onMouseMove(event) {
        if (_mode !== 'BUILD') return;

        var position = event.endPosition;
        if (!position) return;

        // Handle active drag
        if (_dragEntityId) {
            // Check if mouse has moved enough to count as a drag
            if (!_dragging && _dragStartPosition) {
                var dx = position.x - _dragStartPosition.x;
                var dy = position.y - _dragStartPosition.y;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > 5) {
                    _dragging = true;
                }
            }

            if (_dragging) {
                _handleDragMove(position);
            }
            return;
        }

        // Cursor feedback when not dragging
        _updateCursor(position);
    }

    function _onLeftUp(event) {
        if (_dragEntityId) {
            if (_dragging && event.position) {
                _handleDragEnd(event.position);
            }

            // Re-enable camera controls
            _viewer.scene.screenSpaceCameraController.enableRotate = true;
            _viewer.scene.screenSpaceCameraController.enableTranslate = true;
            _viewer.scene.screenSpaceCameraController.enableZoom = true;
            _viewer.scene.screenSpaceCameraController.enableTilt = true;
            _viewer.scene.screenSpaceCameraController.enableLook = true;

            // Reset drag state after a brief delay to prevent the click handler
            // from treating the mouseup as a selection click
            var wasDragging = _dragging;
            _dragEntityId = null;
            _dragStartPosition = null;

            if (wasDragging) {
                setTimeout(function() {
                    _dragging = false;
                }, 50);
            } else {
                _dragging = false;
            }
        }
    }

    /**
     * Update entity position during drag.
     */
    function _handleDragMove(screenPosition) {
        var cartesian = _pickGlobePosition(screenPosition);
        if (!cartesian) return;

        var latLon = _cartesianToLatLon(cartesian);

        // Update the entity definition in scenario data
        BuilderApp.updateEntityDef(_dragEntityId, {
            initialState: {
                lat: latLon.lat,
                lon: latLon.lon
            }
        });
    }

    /**
     * Finalize entity position after drag.
     */
    function _handleDragEnd(screenPosition) {
        var cartesian = _pickGlobePosition(screenPosition);
        if (!cartesian) return;

        var latLon = _cartesianToLatLon(cartesian);

        BuilderApp.updateEntityDef(_dragEntityId, {
            initialState: {
                lat: latLon.lat,
                lon: latLon.lon
            }
        });

        BuilderApp.showMessage('Entity repositioned');
    }

    /**
     * Cancel any in-progress drag.
     */
    function _cancelDrag() {
        if (_dragEntityId) {
            _viewer.scene.screenSpaceCameraController.enableRotate = true;
            _viewer.scene.screenSpaceCameraController.enableTranslate = true;
            _viewer.scene.screenSpaceCameraController.enableZoom = true;
            _viewer.scene.screenSpaceCameraController.enableTilt = true;
            _viewer.scene.screenSpaceCameraController.enableLook = true;
        }
        _dragging = false;
        _dragEntityId = null;
        _dragStartPosition = null;
    }

    // -------------------------------------------------------------------
    // Context Menu (Right-Click)
    // -------------------------------------------------------------------

    function _onRightClick(event) {
        if (_mode !== 'BUILD') return;

        var position = event.position;
        if (!position) return;

        var entityId = _pickBuildEntity(position);
        if (!entityId) {
            _hideContextMenu();
            return;
        }

        _contextEntityId = entityId;
        BuilderApp.selectEntity(entityId);
        _showContextMenu(position.x, position.y);
    }

    /**
     * Create the context menu DOM element (hidden initially).
     */
    function _createContextMenu() {
        _contextMenu = document.createElement('div');
        _contextMenu.id = 'builderContextMenu';
        _contextMenu.style.cssText =
            'position:absolute; display:none; z-index:300; ' +
            'background:rgba(20,25,20,0.95); border:1px solid #00aa00; ' +
            'border-radius:4px; padding:4px 0; min-width:160px; ' +
            'font-family:monospace; font-size:13px; color:#00ff00; ' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.6);';

        // Menu items
        var items = [
            { label: 'Focus Camera', action: _ctxFocusCamera },
            { label: 'Duplicate', action: _ctxDuplicate },
            { label: 'Delete', action: _ctxDelete }
        ];

        for (var i = 0; i < items.length; i++) {
            var item = document.createElement('div');
            item.textContent = items[i].label;
            item.style.cssText =
                'padding:6px 16px; cursor:pointer; transition:background 0.15s;';

            // Hover effect
            (function(el) {
                el.addEventListener('mouseenter', function() {
                    el.style.background = 'rgba(0,170,0,0.3)';
                });
                el.addEventListener('mouseleave', function() {
                    el.style.background = 'transparent';
                });
            })(item);

            // Click handler
            (function(action) {
                item.addEventListener('click', function(e) {
                    e.stopPropagation();
                    _hideContextMenu();
                    action();
                });
            })(items[i].action);

            _contextMenu.appendChild(item);
        }

        document.body.appendChild(_contextMenu);
    }

    /**
     * Show the context menu at screen coordinates.
     */
    function _showContextMenu(x, y) {
        if (!_contextMenu) return;

        // Position the menu, keeping it within viewport
        var menuWidth = 160;
        var menuHeight = 100;
        var maxX = window.innerWidth - menuWidth - 5;
        var maxY = window.innerHeight - menuHeight - 5;

        _contextMenu.style.left = Math.min(x, maxX) + 'px';
        _contextMenu.style.top = Math.min(y, maxY) + 'px';
        _contextMenu.style.display = 'block';
    }

    /**
     * Hide the context menu.
     */
    function _hideContextMenu() {
        if (_contextMenu) {
            _contextMenu.style.display = 'none';
        }
        _contextEntityId = null;
    }

    // -------------------------------------------------------------------
    // Context Menu Actions
    // -------------------------------------------------------------------

    /**
     * Fly the camera to the selected entity.
     */
    function _ctxFocusCamera() {
        if (!_contextEntityId) return;

        var scenarioData = BuilderApp.getScenarioData();
        var def = _findEntityDef(scenarioData, _contextEntityId);
        if (!def || !def.initialState) return;

        var init = def.initialState;
        var lon = init.lon || 0;
        var lat = init.lat || 0;
        var alt = init.alt || 0;

        var destination = Cesium.Cartesian3.fromDegrees(lon, lat, alt + 50000);
        _viewer.camera.flyTo({
            destination: destination,
            orientation: {
                heading: 0,
                pitch: Cesium.Math.toRadians(-45),
                roll: 0
            },
            duration: 1.5
        });
    }

    /**
     * Duplicate the selected entity with a new ID and slightly offset position.
     */
    function _ctxDuplicate() {
        if (!_contextEntityId) return;

        var scenarioData = BuilderApp.getScenarioData();
        var def = _findEntityDef(scenarioData, _contextEntityId);
        if (!def) return;

        // Deep clone the definition
        var clone = JSON.parse(JSON.stringify(def));

        // Generate new ID
        clone.id = (clone.type || 'entity') + '_' + Date.now();
        clone.name = (clone.name || clone.type || 'Entity') + ' (copy)';

        // Offset position slightly (about 0.01 degrees ~ 1km)
        if (clone.initialState) {
            clone.initialState.lat = (clone.initialState.lat || 0) + 0.01;
            clone.initialState.lon = (clone.initialState.lon || 0) + 0.01;
        }

        var newId = BuilderApp.addEntity(clone);
        BuilderApp.selectEntity(newId);
    }

    /**
     * Delete the selected entity with confirmation.
     */
    function _ctxDelete() {
        if (!_contextEntityId) return;

        var scenarioData = BuilderApp.getScenarioData();
        var def = _findEntityDef(scenarioData, _contextEntityId);
        var name = def ? (def.name || def.id) : _contextEntityId;

        if (confirm('Delete entity "' + name + '"?')) {
            BuilderApp.removeEntity(_contextEntityId);
        }
    }

    // -------------------------------------------------------------------
    // Cursor Feedback
    // -------------------------------------------------------------------

    /**
     * Update the cursor style based on what is under the mouse.
     */
    function _updateCursor(screenPosition) {
        if (!_viewer) return;

        // Placement mode: always crosshair
        if (BuilderApp.getPlacementTemplate()) {
            _viewer.container.style.cursor = 'crosshair';
            return;
        }

        // Check if hovering over an entity
        var entityId = _pickBuildEntity(screenPosition);
        if (entityId) {
            _viewer.container.style.cursor = 'pointer';
        } else {
            _viewer.container.style.cursor = 'default';
        }
    }

    // -------------------------------------------------------------------
    // Picking Helpers
    // -------------------------------------------------------------------

    /**
     * Pick a build-mode entity from a screen position.
     * @param {Cesium.Cartesian2} screenPosition
     * @returns {string|null} entity ID or null
     */
    function _pickBuildEntity(screenPosition) {
        if (!_viewer) return null;

        var picked = _viewer.scene.pick(screenPosition);
        if (Cesium.defined(picked) && picked.id && picked.id._builderId) {
            return picked.id._builderId;
        }
        return null;
    }

    /**
     * Pick a position on the globe from a screen position.
     * Tries scene.pickPosition first (terrain-aware), falls back to ellipsoid pick.
     * @param {Cesium.Cartesian2} screenPosition
     * @returns {Cesium.Cartesian3|null}
     */
    function _pickGlobePosition(screenPosition) {
        if (!_viewer) return null;

        // Try terrain-aware pick first
        if (_viewer.scene.pickPositionSupported) {
            var scenePos = _viewer.scene.pickPosition(screenPosition);
            if (Cesium.defined(scenePos)) {
                return scenePos;
            }
        }

        // Fall back to ellipsoid pick
        var ray = _viewer.camera.getPickRay(screenPosition);
        if (ray) {
            return _viewer.scene.globe.pick(ray, _viewer.scene);
        }

        return null;
    }

    /**
     * Convert a Cesium Cartesian3 position to lat/lon/alt in degrees and meters.
     * @param {Cesium.Cartesian3} cartesian
     * @returns {{ lat: number, lon: number, alt: number }}
     */
    function _cartesianToLatLon(cartesian) {
        var carto = Cesium.Cartographic.fromCartesian(cartesian);
        return {
            lat: Cesium.Math.toDegrees(carto.latitude),
            lon: Cesium.Math.toDegrees(carto.longitude),
            alt: carto.height
        };
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    /**
     * Find an entity definition in scenario data by ID.
     */
    function _findEntityDef(scenarioData, id) {
        if (!scenarioData || !scenarioData.entities) return null;
        var entities = scenarioData.entities;
        for (var i = 0; i < entities.length; i++) {
            if (entities[i].id === id) return entities[i];
        }
        return null;
    }

    // -------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------
    return {
        init: init,
        setMode: setMode
    };
})();
