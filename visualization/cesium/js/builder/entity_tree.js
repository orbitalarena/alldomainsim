/**
 * EntityTree - Bottom panel scrollable entity list for the Scenario Builder.
 * Shows all entities with team color, name, type, and position summary.
 * Supports selection, keyboard navigation, and delete.
 */
var EntityTree = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _container = null;
    var _selectedId = null;
    var _listEl = null;     // scrollable list div
    var _footerEl = null;   // stats footer

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Format latitude/longitude to 2 decimal degrees with hemisphere. */
    function _fmtLatLon(lat, lon) {
        if (lat === undefined || lon === undefined) return '--';
        var latStr = Math.abs(lat).toFixed(2) + '\u00B0' + (lat >= 0 ? 'N' : 'S');
        var lonStr = Math.abs(lon).toFixed(2) + '\u00B0' + (lon >= 0 ? 'E' : 'W');
        return latStr + ', ' + lonStr;
    }

    /** Resolve team name to a display color. */
    function _teamColor(team) {
        if (team === 'blue') return '#4488ff';
        if (team === 'red') return '#ff4444';
        return '#888888';
    }

    /** Get the ordered entity list from BuilderApp. */
    function _getEntities() {
        if (typeof BuilderApp === 'undefined') return [];
        var data = BuilderApp.getScenarioData();
        return (data && data.entities) ? data.entities : [];
    }

    /** Find the index of the selected entity in the entity list. */
    function _selectedIndex(entities) {
        if (!_selectedId) return -1;
        for (var i = 0; i < entities.length; i++) {
            if (entities[i].id === _selectedId) return i;
        }
        return -1;
    }

    /** Fly camera to an entity's initial position. */
    function _flyToEntity(def, closeZoom) {
        if (typeof BuilderApp === 'undefined') return;
        var viewer = BuilderApp.getViewer();
        if (!viewer) return;
        var state = def.initialState || {};
        var lat = state.lat;
        var lon = state.lon;
        if (lat === undefined || lon === undefined) return;

        var alt = state.alt || 0;
        var range = closeZoom ? Math.max(alt * 2, 5000) : Math.max(alt * 5, 50000);

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt + range),
            orientation: {
                heading: 0,
                pitch: Cesium.Math.toRadians(-60),
                roll: 0
            },
            duration: 1.0
        });
    }

    // -----------------------------------------------------------------------
    // Row creation
    // -----------------------------------------------------------------------

    function _createRow(def) {
        var row = document.createElement('div');
        row.className = 'entity-tree-row';
        row.setAttribute('data-entity-id', def.id);
        if (def.id === _selectedId) {
            row.classList.add('entity-tree-row-selected');
        }

        // Team dot
        var dot = document.createElement('span');
        dot.className = 'entity-tree-dot';
        dot.style.background = _teamColor(def.team);
        row.appendChild(dot);

        // Name
        var name = document.createElement('span');
        name.className = 'entity-tree-name';
        name.textContent = def.name || def.id;
        row.appendChild(name);

        // Type
        var type = document.createElement('span');
        type.className = 'entity-tree-type';
        type.textContent = def.type || '';
        row.appendChild(type);

        // Position
        var pos = document.createElement('span');
        pos.className = 'entity-tree-pos';
        var state = def.initialState || {};
        pos.textContent = _fmtLatLon(state.lat, state.lon);
        row.appendChild(pos);

        // Click to select
        row.addEventListener('click', function() {
            _selectedId = def.id;
            _highlightSelected();
            if (typeof BuilderApp !== 'undefined') {
                BuilderApp.selectEntity(def.id);
            }
            _flyToEntity(def, false);
        });

        // Double-click to zoom close
        row.addEventListener('dblclick', function() {
            _flyToEntity(def, true);
        });

        return row;
    }

    // -----------------------------------------------------------------------
    // Highlight / keyboard
    // -----------------------------------------------------------------------

    /** Apply selected highlight to the correct row. */
    function _highlightSelected() {
        if (!_listEl) return;
        var rows = _listEl.querySelectorAll('.entity-tree-row');
        for (var i = 0; i < rows.length; i++) {
            var id = rows[i].getAttribute('data-entity-id');
            if (id === _selectedId) {
                rows[i].classList.add('entity-tree-row-selected');
                // Scroll into view if needed
                rows[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                rows[i].classList.remove('entity-tree-row-selected');
            }
        }
    }

    /** Handle keyboard events for navigation and delete. */
    function _onKeyDown(e) {
        // Only handle keys when the tree container or its children are focused
        if (!_container || !_container.contains(document.activeElement) && document.activeElement !== _container) {
            return;
        }

        var entities = _getEntities();
        if (entities.length === 0) return;

        var idx = _selectedIndex(entities);

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            var nextIdx = idx < entities.length - 1 ? idx + 1 : 0;
            _selectedId = entities[nextIdx].id;
            _highlightSelected();
            if (typeof BuilderApp !== 'undefined') {
                BuilderApp.selectEntity(_selectedId);
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            var prevIdx = idx > 0 ? idx - 1 : entities.length - 1;
            _selectedId = entities[prevIdx].id;
            _highlightSelected();
            if (typeof BuilderApp !== 'undefined') {
                BuilderApp.selectEntity(_selectedId);
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (_selectedId && typeof BuilderApp !== 'undefined') {
                // Check we are in BUILD mode
                if (BuilderApp.getMode && BuilderApp.getMode() !== 'BUILD') return;
                e.preventDefault();
                var removeId = _selectedId;
                // Select next entity before removing
                if (entities.length > 1) {
                    var nextAfterDelete = idx < entities.length - 1 ? idx + 1 : idx - 1;
                    _selectedId = entities[nextAfterDelete].id;
                } else {
                    _selectedId = null;
                }
                BuilderApp.removeEntity(removeId);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Stats footer
    // -----------------------------------------------------------------------

    function _updateFooter(entities) {
        if (!_footerEl) return;
        var total = entities.length;
        var aircraft = 0, satellites = 0, ground = 0;
        for (var i = 0; i < entities.length; i++) {
            var t = entities[i].type;
            if (t === 'aircraft') aircraft++;
            else if (t === 'satellite') satellites++;
            else if (t === 'ground') ground++;
        }
        var parts = [];
        if (aircraft > 0) parts.push(aircraft + ' aircraft');
        if (satellites > 0) parts.push(satellites + ' satellite' + (satellites > 1 ? 's' : ''));
        if (ground > 0) parts.push(ground + ' ground');

        _footerEl.textContent = total + ' entit' + (total === 1 ? 'y' : 'ies');
        if (parts.length > 0) {
            _footerEl.textContent += ' | ' + parts.join(', ');
        }
    }

    // -----------------------------------------------------------------------
    // Main render
    // -----------------------------------------------------------------------

    function _render() {
        if (!_container) return;
        _container.innerHTML = '';

        // Header row
        var header = document.createElement('div');
        header.className = 'entity-tree-header';

        var hDot = document.createElement('span');
        hDot.className = 'entity-tree-dot-header';
        hDot.textContent = '';
        header.appendChild(hDot);

        var hName = document.createElement('span');
        hName.className = 'entity-tree-col-header entity-tree-name';
        hName.textContent = 'Entity';
        header.appendChild(hName);

        var hType = document.createElement('span');
        hType.className = 'entity-tree-col-header entity-tree-type';
        hType.textContent = 'Type';
        header.appendChild(hType);

        var hPos = document.createElement('span');
        hPos.className = 'entity-tree-col-header entity-tree-pos';
        hPos.textContent = 'Position';
        header.appendChild(hPos);

        _container.appendChild(header);

        // Scrollable list
        _listEl = document.createElement('div');
        _listEl.className = 'entity-tree-list';

        var entities = _getEntities();
        for (var i = 0; i < entities.length; i++) {
            _listEl.appendChild(_createRow(entities[i]));
        }

        if (entities.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'entity-tree-empty';
            empty.textContent = 'No entities in scenario. Use the Object Palette to add entities.';
            _listEl.appendChild(empty);
        }

        _container.appendChild(_listEl);

        // Footer
        _footerEl = document.createElement('div');
        _footerEl.className = 'entity-tree-footer';
        _updateFooter(entities);
        _container.appendChild(_footerEl);
    }

    // -----------------------------------------------------------------------
    // Inject scoped CSS
    // -----------------------------------------------------------------------
    function _injectStyles() {
        if (document.getElementById('entity-tree-styles')) return;
        var style = document.createElement('style');
        style.id = 'entity-tree-styles';
        style.textContent = [
            '.entity-tree-header { display: flex; align-items: center; padding: 4px 10px; background: #141428; border-bottom: 1px solid #222; font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; }',
            '.entity-tree-dot-header { width: 10px; margin-right: 8px; }',
            '.entity-tree-col-header { }',
            '.entity-tree-list { overflow-y: auto; flex: 1; min-height: 0; }',
            '.entity-tree-row { display: flex; align-items: center; padding: 5px 10px; cursor: pointer; border-left: 3px solid transparent; user-select: none; }',
            '.entity-tree-row:hover { background: #1a1a36; }',
            '.entity-tree-row-selected { background: #1a2a4a; border-left-color: #4488ff; }',
            '.entity-tree-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-right: 8px; }',
            '.entity-tree-name { flex: 2; color: #ddd; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.entity-tree-type { flex: 1; color: #777; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.entity-tree-pos { flex: 2; color: #666; font-size: 11px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: monospace; }',
            '.entity-tree-empty { color: #555; font-size: 12px; padding: 16px 10px; text-align: center; font-style: italic; }',
            '.entity-tree-footer { padding: 4px 10px; background: #0e0e1a; border-top: 1px solid #222; color: #666; font-size: 10px; flex-shrink: 0; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Initialize the entity tree into a DOM container.
         * @param {string} containerId - ID of the parent element.
         */
        init: function(containerId) {
            _container = document.getElementById(containerId);
            if (!_container) {
                console.error('[EntityTree] Container not found: ' + containerId);
                return;
            }
            _injectStyles();
            _render();

            // Make container focusable for keyboard events
            _container.setAttribute('tabindex', '0');
            _container.style.outline = 'none';
            _container.addEventListener('keydown', _onKeyDown);
        },

        /** Rebuild the entity list from BuilderApp scenario data. */
        refresh: function() {
            _render();
        },

        /**
         * Highlight the row for the given entity ID.
         * @param {string} entityId
         */
        setSelected: function(entityId) {
            _selectedId = entityId || null;
            _highlightSelected();
        },

        /**
         * Return the currently selected entity ID (or null).
         * @returns {string|null}
         */
        getSelected: function() {
            return _selectedId;
        }
    };
})();
