/**
 * ObjectPalette - Left sidebar entity catalog for the Scenario Builder.
 * Groups entity templates by category (Aircraft, Spacecraft, Ground).
 * Click a template to begin placement on the globe.
 */
var ObjectPalette = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Entity Templates
    // -----------------------------------------------------------------------
    var TEMPLATES = [
        // --- Aircraft ---
        {
            category: 'Aircraft',
            name: 'F-16C Fighting Falcon',
            icon: '#4488ff',
            description: '4th-gen multirole fighter, 3-DOF flight physics',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 5000, speed: 200, heading: 90, gamma: 0,
                throttle: 0.6, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'f16' },
                control: { type: 'player_input', config: 'fighter' },
                visual: { type: 'point', color: '#4488ff', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'MiG-29 Fulcrum',
            icon: '#ff4444',
            description: '4th-gen air superiority fighter, AI patrol',
            type: 'aircraft',
            team: 'red',
            defaults: {
                alt: 6000, speed: 220, heading: 270, gamma: 0,
                throttle: 0.7, engineOn: true, gearDown: false, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'mig29' },
                ai: { type: 'waypoint_patrol', waypoints: [], loopMode: 'cycle' },
                visual: { type: 'point', color: '#ff4444', pixelSize: 12, trail: true }
            }
        },
        {
            category: 'Aircraft',
            name: 'X-37S Spaceplane',
            icon: '#00ccff',
            description: 'Runway-to-orbit vehicle, multi-mode propulsion',
            type: 'aircraft',
            team: 'blue',
            defaults: {
                alt: 5000, speed: 200, heading: 90, gamma: 0,
                throttle: 0.5, engineOn: true, infiniteFuel: true
            },
            components: {
                physics: { type: 'flight3dof', config: 'spaceplane' },
                control: { type: 'player_input', config: 'spaceplane' },
                visual: { type: 'point', color: '#00ccff', pixelSize: 12, trail: true }
            }
        },
        // --- Spacecraft ---
        {
            category: 'Spacecraft',
            name: 'LEO Satellite',
            icon: '#ffaa00',
            description: 'Low Earth orbit satellite (400km circular)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 400000, speed: 7670, heading: 45, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffaa00', pixelSize: 8, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GPS Satellite',
            icon: '#ffcc00',
            description: 'MEO GPS constellation satellite (20,200km)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 20200000, speed: 3874, heading: 55, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ffcc44', pixelSize: 6, orbitPath: true, groundTrack: true, apPeMarkers: true }
            }
        },
        {
            category: 'Spacecraft',
            name: 'GEO Comms Satellite',
            icon: '#ff8800',
            description: 'Geostationary communications satellite (35,786km)',
            type: 'satellite',
            team: 'neutral',
            defaults: { alt: 35786000, speed: 3075, heading: 90, gamma: 0 },
            components: {
                physics: { type: 'orbital_2body', source: 'state' },
                visual: { type: 'satellite', color: '#ff88ff', pixelSize: 6, orbitPath: true, groundTrack: false, apPeMarkers: true }
            }
        },
        // --- Ground ---
        {
            category: 'Ground',
            name: 'Ground Station',
            icon: '#00ff88',
            description: 'TT&C facility with radar and sensor cone',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 150000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.9 },
                visual: { type: 'ground_station', color: '#00ff88', label: 'GND', sensorRange_m: 150000 }
            }
        },
        {
            category: 'Ground',
            name: 'SAM Battery',
            icon: '#ff2222',
            description: 'SA-20 with radar, kill chain, missiles',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 200000, fov_deg: 360, scanRate_dps: 36, detectionProbability: 0.95 },
                weapons: { type: 'sam_battery', maxRange_m: 150000, engagementRules: 'weapons_free' },
                visual: { type: 'ground_station', color: '#ff2222', label: 'SAM', sensorRange_m: 200000, sensorColor: 'rgba(255,50,50,0.06)', sensorOutlineColor: '#ff4444' }
            }
        },
        {
            category: 'Ground',
            name: 'EW Radar',
            icon: '#ff8800',
            description: 'Early warning radar, 300km detection range',
            type: 'ground',
            team: 'red',
            defaults: { alt: 0, speed: 0 },
            components: {
                sensors: { type: 'radar', maxRange_m: 300000, fov_deg: 360, scanRate_dps: 20, detectionProbability: 0.8 },
                visual: { type: 'ground_station', color: '#ff8800', label: 'EW', sensorRange_m: 300000, sensorColor: 'rgba(255,136,0,0.03)', sensorOutlineColor: '#ff8800' }
            }
        },
        {
            category: 'Ground',
            name: 'GPS Receiver',
            icon: '#44ff44',
            description: 'GPS ground receiver for DOP analysis',
            type: 'ground',
            team: 'blue',
            defaults: { alt: 0, speed: 0 },
            components: {
                visual: { type: 'point', color: '#44ff44', pixelSize: 8, label: 'GPS-RX' }
            }
        }
    ];

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _container = null;
    var _activeIndex = -1;       // currently highlighted template index
    var _collapsedCats = {};     // category name -> bool (collapsed)

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /** Group templates by category, preserving insertion order. */
    function _groupByCategory() {
        var groups = {};
        var order = [];
        for (var i = 0; i < TEMPLATES.length; i++) {
            var cat = TEMPLATES[i].category;
            if (!groups[cat]) {
                groups[cat] = [];
                order.push(cat);
            }
            groups[cat].push({ template: TEMPLATES[i], index: i });
        }
        return { groups: groups, order: order };
    }

    /** Build a single palette item element. */
    function _createItem(entry) {
        var tpl = entry.template;
        var idx = entry.index;

        var item = document.createElement('div');
        item.className = 'palette-item';
        if (idx === _activeIndex) {
            item.classList.add('palette-item-active');
        }
        item.setAttribute('data-template-index', idx);

        // Icon dot
        var icon = document.createElement('span');
        icon.className = 'palette-icon';
        icon.style.background = tpl.icon;
        item.appendChild(icon);

        // Info block
        var info = document.createElement('div');
        info.className = 'palette-item-info';

        var nameEl = document.createElement('div');
        nameEl.className = 'palette-item-name';
        nameEl.textContent = tpl.name;
        info.appendChild(nameEl);

        var descEl = document.createElement('div');
        descEl.className = 'palette-item-desc';
        descEl.textContent = tpl.description;
        info.appendChild(descEl);

        item.appendChild(info);

        // Click handler
        item.addEventListener('click', function() {
            _setActive(idx);
            if (typeof BuilderApp !== 'undefined') {
                BuilderApp.startPlacement(TEMPLATES[idx]);
            }
        });

        return item;
    }

    /** Build a category section. */
    function _createCategory(catName, entries) {
        var section = document.createElement('div');
        section.className = 'palette-category';

        // Header
        var header = document.createElement('div');
        header.className = 'palette-category-header';

        var arrow = document.createElement('span');
        arrow.className = 'palette-arrow';
        var collapsed = !!_collapsedCats[catName];
        arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
        header.appendChild(arrow);

        var label = document.createElement('span');
        label.textContent = ' ' + catName;
        header.appendChild(label);

        var count = document.createElement('span');
        count.className = 'palette-category-count';
        count.textContent = ' (' + entries.length + ')';
        header.appendChild(count);

        header.addEventListener('click', function() {
            _collapsedCats[catName] = !_collapsedCats[catName];
            _render();
        });

        section.appendChild(header);

        // Items container
        var itemsDiv = document.createElement('div');
        itemsDiv.className = 'palette-category-items';
        if (collapsed) {
            itemsDiv.style.display = 'none';
        }

        for (var i = 0; i < entries.length; i++) {
            itemsDiv.appendChild(_createItem(entries[i]));
        }

        section.appendChild(itemsDiv);
        return section;
    }

    /** Highlight the active template. */
    function _setActive(index) {
        _activeIndex = index;
        // Update highlight in DOM without full re-render
        if (!_container) return;
        var items = _container.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            var itemIdx = parseInt(items[i].getAttribute('data-template-index'), 10);
            if (itemIdx === _activeIndex) {
                items[i].classList.add('palette-item-active');
            } else {
                items[i].classList.remove('palette-item-active');
            }
        }
    }

    /** Full re-render into the container. */
    function _render() {
        if (!_container) return;
        _container.innerHTML = '';

        // Title
        var title = document.createElement('div');
        title.className = 'palette-title';
        title.textContent = 'Object Palette';
        _container.appendChild(title);

        // Search / filter (simple text filter)
        var search = document.createElement('input');
        search.type = 'text';
        search.className = 'palette-search';
        search.placeholder = 'Filter entities...';
        search.addEventListener('input', function() {
            _renderFiltered(search.value.trim().toLowerCase());
        });
        _container.appendChild(search);

        // Categories
        var grouped = _groupByCategory();
        for (var ci = 0; ci < grouped.order.length; ci++) {
            var catName = grouped.order[ci];
            var section = _createCategory(catName, grouped.groups[catName]);
            _container.appendChild(section);
        }
    }

    /** Render with text filter applied — hides non-matching items. */
    function _renderFiltered(query) {
        if (!_container) return;
        var items = _container.querySelectorAll('.palette-item');
        for (var i = 0; i < items.length; i++) {
            var idx = parseInt(items[i].getAttribute('data-template-index'), 10);
            var tpl = TEMPLATES[idx];
            if (!query) {
                items[i].style.display = '';
                continue;
            }
            var text = (tpl.name + ' ' + tpl.description + ' ' + tpl.category).toLowerCase();
            items[i].style.display = text.indexOf(query) !== -1 ? '' : 'none';
        }
        // Show/hide category headers if all items hidden
        var sections = _container.querySelectorAll('.palette-category');
        for (var s = 0; s < sections.length; s++) {
            var catItems = sections[s].querySelectorAll('.palette-item');
            var anyVisible = false;
            for (var j = 0; j < catItems.length; j++) {
                if (catItems[j].style.display !== 'none') {
                    anyVisible = true;
                    break;
                }
            }
            sections[s].style.display = anyVisible ? '' : 'none';
        }
    }

    // -----------------------------------------------------------------------
    // Inject scoped CSS
    // -----------------------------------------------------------------------
    function _injectStyles() {
        if (document.getElementById('object-palette-styles')) return;
        var style = document.createElement('style');
        style.id = 'object-palette-styles';
        style.textContent = [
            '.palette-title { font-size: 14px; font-weight: bold; color: #ccc; padding: 8px 10px 4px; text-transform: uppercase; letter-spacing: 1px; }',
            '.palette-search { width: calc(100% - 20px); margin: 4px 10px 8px; padding: 5px 8px; background: #1a1a2e; border: 1px solid #333; border-radius: 3px; color: #ccc; font-size: 12px; outline: none; }',
            '.palette-search:focus { border-color: #4488ff; }',
            '.palette-category { margin-bottom: 2px; }',
            '.palette-category-header { padding: 6px 10px; cursor: pointer; color: #aaa; font-size: 12px; font-weight: bold; background: #141428; user-select: none; }',
            '.palette-category-header:hover { background: #1a1a36; color: #ddd; }',
            '.palette-category-count { color: #666; font-weight: normal; }',
            '.palette-arrow { display: inline-block; width: 12px; font-size: 10px; }',
            '.palette-category-items { }',
            '.palette-item { display: flex; align-items: center; padding: 6px 10px 6px 18px; cursor: pointer; border-left: 3px solid transparent; }',
            '.palette-item:hover { background: #1a1a36; border-left-color: #4488ff; }',
            '.palette-item-active { background: #1a2a4a; border-left-color: #4488ff; }',
            '.palette-icon { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-right: 8px; }',
            '.palette-item-info { overflow: hidden; }',
            '.palette-item-name { color: #ddd; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.palette-item-desc { color: #777; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Initialize the palette into a DOM container.
         * @param {string} containerId - ID of the parent element.
         */
        init: function(containerId) {
            _container = document.getElementById(containerId);
            if (!_container) {
                console.error('[ObjectPalette] Container not found: ' + containerId);
                return;
            }
            _injectStyles();
            _render();
        },

        /** Return the full TEMPLATES array. */
        getTemplates: function() {
            return TEMPLATES;
        },

        /** Look up a template by name (case-insensitive). */
        getTemplateByName: function(name) {
            var lower = name.toLowerCase();
            for (var i = 0; i < TEMPLATES.length; i++) {
                if (TEMPLATES[i].name.toLowerCase() === lower) {
                    return TEMPLATES[i];
                }
            }
            return null;
        },

        /** Force a full re-render. */
        refresh: function() {
            _render();
        }
    };
})();
