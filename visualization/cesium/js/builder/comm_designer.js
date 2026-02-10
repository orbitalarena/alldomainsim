/**
 * CommDesigner — Communications Network Designer for Scenario Builder.
 *
 * Modal dialog for designing communication networks between scenario entities.
 * Supports Mesh, Star, Multi-Hop, and Custom topologies with hierarchical
 * nesting (networks can contain sub-networks as members).
 *
 * Usage:
 *   CommDesigner.init();                      // Called once at startup
 *   CommDesigner.open(entities);              // Open modal with current entities
 *   CommDesigner.close();                     // Close modal
 *   CommDesigner.getNetworks();               // Get networks for scenario JSON
 *   CommDesigner.setNetworks(networks);       // Load networks from scenario JSON
 *   CommDesigner.addEntity(entityDef);        // Notify entity added
 *   CommDesigner.removeEntity(entityId);      // Notify entity removed
 */
(function() {
    'use strict';

    // =========================================================================
    // Constants
    // =========================================================================

    var STORAGE_KEY = 'commDesigner_networks';
    var NET_ID_PREFIX = 'net_';
    var _nextNetId = 1;

    var LINK_PRESETS = {
        uhf_radio:   { linkType: 'rf',     frequency_ghz: 0.3,     bandwidth_mbps: 0.064,  power_dbw: 5,  antenna_gain_dbi: 2,   latency_ms: 1,    dataRate_mbps: 0.064,  encryption: 'none',    protocol: 'fdma',     priority: 5,  maxRange_m: 50000,     receiver_sensitivity_dbm: -107 },
        vhf_radio:   { linkType: 'rf',     frequency_ghz: 0.15,    bandwidth_mbps: 0.016,  power_dbw: 10, antenna_gain_dbi: 2,   latency_ms: 1,    dataRate_mbps: 0.016,  encryption: 'none',    protocol: 'fdma',     priority: 3,  maxRange_m: 100000,    receiver_sensitivity_dbm: -110 },
        link16:      { linkType: 'rf',     frequency_ghz: 1.2,     bandwidth_mbps: 1.0,    power_dbw: 10, antenna_gain_dbi: 6,   latency_ms: 12,   dataRate_mbps: 1.0,    encryption: 'aes256',  protocol: 'tdma',     priority: 8,  maxRange_m: 500000,    receiver_sensitivity_dbm: -100 },
        cdl:         { linkType: 'rf',     frequency_ghz: 15.0,    bandwidth_mbps: 274,    power_dbw: 20, antenna_gain_dbi: 30,  latency_ms: 2,    dataRate_mbps: 274,    encryption: 'aes256',  protocol: 'tdma',     priority: 9,  maxRange_m: 200000,    receiver_sensitivity_dbm: -90 },
        satcom_ku:   { linkType: 'satcom', frequency_ghz: 14.0,    bandwidth_mbps: 50,     power_dbw: 15, antenna_gain_dbi: 20,  latency_ms: 270,  dataRate_mbps: 50,     encryption: 'aes256',  protocol: 'tdma',     priority: 6,  maxRange_m: 40000000,  receiver_sensitivity_dbm: -95 },
        satcom_ka:   { linkType: 'satcom', frequency_ghz: 30.0,    bandwidth_mbps: 500,    power_dbw: 20, antenna_gain_dbi: 35,  latency_ms: 270,  dataRate_mbps: 500,    encryption: 'aes256',  protocol: 'tdma',     priority: 7,  maxRange_m: 40000000,  receiver_sensitivity_dbm: -85 },
        fiber:       { linkType: 'fiber',  frequency_ghz: 0,       bandwidth_mbps: 10000,  power_dbw: 0,  antenna_gain_dbi: 0,   latency_ms: 0.01, dataRate_mbps: 10000,  encryption: 'aes256',  protocol: 'ethernet', priority: 10, maxRange_m: 1000000,   receiver_sensitivity_dbm: -30 },
        laser_comm:  { linkType: 'laser',  frequency_ghz: 282000,  bandwidth_mbps: 1000,   power_dbw: 1,  antenna_gain_dbi: 50,  latency_ms: 0.02, dataRate_mbps: 1000,   encryption: 'aes256',  protocol: 'tdma',     priority: 9,  maxRange_m: 5000000,   receiver_sensitivity_dbm: -45 },
        hf_radio:    { linkType: 'rf',     frequency_ghz: 0.01,    bandwidth_mbps: 0.002,  power_dbw: 20, antenna_gain_dbi: 0,   latency_ms: 50,   dataRate_mbps: 0.002,  encryption: 'none',    protocol: 'csma',     priority: 2,  maxRange_m: 5000000,   receiver_sensitivity_dbm: -120 }
    };

    var PRESET_LABELS = {
        uhf_radio:   'UHF Radio (300 MHz)',
        vhf_radio:   'VHF Radio (150 MHz)',
        link16:      'Link 16 (JTIDS)',
        cdl:         'Common Data Link',
        satcom_ku:   'SATCOM Ku-Band',
        satcom_ka:   'SATCOM Ka-Band',
        fiber:       'Fiber Optic',
        laser_comm:  'Laser Comm (OISL)',
        hf_radio:    'HF Radio (10 MHz)'
    };

    var LINK_TYPE_COLORS = {
        rf:     '#4a9eff',
        satcom: '#aa66ff',
        fiber:  '#44ff88',
        laser:  '#ff4444'
    };

    var NETWORK_TYPE_LABELS = {
        mesh:     'Mesh',
        star:     'Star',
        multihop: 'Multi-Hop',
        custom:   'Custom'
    };

    var TEAM_COLORS = {
        blue:    '#4488ff',
        red:     '#ff4444',
        neutral: '#ffaa00',
        green:   '#44ff88'
    };

    // =========================================================================
    // State
    // =========================================================================

    var _overlay = null;
    var _initialized = false;
    var _entities = [];          // {id, name, type, team} from scenario
    var _networks = [];          // Network definitions
    var _selectedNetworkId = null;
    var _selectedNodeId = null;

    // Multi-select state for entity list
    var _selectedEntityIds = new Set();
    var _lastClickedEntityId = null;

    // Canvas / SVG state
    var _svgEl = null;
    var _nodePositions = {};     // nodeId -> {x, y}
    var _isDraggingNode = false;
    var _dragNodeId = null;
    var _dragOffsetX = 0;
    var _dragOffsetY = 0;

    // Force layout
    var _forceTimer = null;
    var _forceIterations = 0;

    // Drawing custom links
    var _isDrawingLink = false;
    var _drawLinkFrom = null;
    var _drawLinkTempLine = null;

    // Drag from entity list
    var _isDraggingFromPalette = false;
    var _paletteDragId = null;
    var _paletteDragIsNetwork = false;
    var _paletteDragGhost = null;

    // =========================================================================
    // Initialization
    // =========================================================================

    function init() {
        if (_initialized) return;
        _initialized = true;
        _injectStyles();
        _createModal();
        _loadFromStorage();
        console.log('[CommDesigner] Initialized');
    }

    // =========================================================================
    // Modal DOM Construction
    // =========================================================================

    function _createModal() {
        _overlay = document.createElement('div');
        _overlay.className = 'cd-overlay';
        _overlay.style.display = 'none';
        _overlay.addEventListener('click', function(e) {
            if (e.target === _overlay) close();
        });

        var modal = document.createElement('div');
        modal.className = 'cd-modal';

        // Header
        var header = document.createElement('div');
        header.className = 'cd-header';
        header.innerHTML = '<span class="cd-header-title">COMMUNICATIONS NETWORK DESIGNER</span>' +
            '<button class="cd-header-close" id="cd-close-btn" title="Close">&times;</button>';
        modal.appendChild(header);

        // Body: 3-panel layout
        var body = document.createElement('div');
        body.className = 'cd-body';

        // Left panel — entity list
        var leftPanel = document.createElement('div');
        leftPanel.className = 'cd-panel cd-panel-left';
        leftPanel.innerHTML =
            '<div class="cd-panel-header">ENTITIES & NETWORKS</div>' +
            '<div class="cd-search-bar">' +
                '<input type="text" id="cd-entity-search" placeholder="Search entities..." />' +
            '</div>' +
            '<div class="cd-bulk-bar" id="cd-bulk-bar">' +
                '<div class="cd-bulk-row">' +
                    '<button class="cd-bulk-btn" id="cd-select-all" title="Select/deselect all visible (Ctrl+A)">All</button>' +
                    '<select class="cd-bulk-select" id="cd-select-by-type" title="Select all of type">' +
                        '<option value="">By Type...</option>' +
                    '</select>' +
                    '<select class="cd-bulk-select" id="cd-select-by-team" title="Select all of team">' +
                        '<option value="">By Team...</option>' +
                    '</select>' +
                '</div>' +
                '<div class="cd-bulk-row">' +
                    '<button class="cd-bulk-btn cd-bulk-add" id="cd-add-selected" title="Add selected entities to current network" disabled>Add Selected (0)</button>' +
                '</div>' +
            '</div>' +
            '<div class="cd-entity-list" id="cd-entity-list"></div>' +
            '<div class="cd-panel-divider"></div>' +
            '<div class="cd-panel-header">SAVED NETWORKS</div>' +
            '<div class="cd-network-list" id="cd-saved-network-list"></div>' +
            '<div class="cd-panel-actions">' +
                '<button class="cd-btn cd-btn-primary" id="cd-new-network-btn">+ New Network</button>' +
            '</div>';
        body.appendChild(leftPanel);

        // Center panel — network canvas
        var centerPanel = document.createElement('div');
        centerPanel.className = 'cd-panel cd-panel-center';
        centerPanel.innerHTML =
            '<div class="cd-canvas-toolbar" id="cd-canvas-toolbar">' +
                '<span class="cd-canvas-title" id="cd-canvas-title">No network selected</span>' +
                '<div class="cd-canvas-tools">' +
                    '<button class="cd-tool-btn" id="cd-tool-auto-layout" title="Auto Layout">&#x2725;</button>' +
                    '<button class="cd-tool-btn" id="cd-tool-zoom-fit" title="Zoom to Fit">&#x2922;</button>' +
                    '<button class="cd-tool-btn" id="cd-tool-draw-link" title="Draw Custom Link">&#x2194;</button>' +
                    '<button class="cd-tool-btn cd-tool-danger" id="cd-tool-clear" title="Remove All Nodes">&#x2716;</button>' +
                '</div>' +
            '</div>' +
            '<div class="cd-canvas-container" id="cd-canvas-container">' +
                '<div class="cd-canvas-empty" id="cd-canvas-empty">' +
                    '<div class="cd-canvas-empty-icon">&#x1F4E1;</div>' +
                    '<div class="cd-canvas-empty-text">Select or create a network, then drag entities here</div>' +
                '</div>' +
            '</div>';
        body.appendChild(centerPanel);

        // Right panel — properties
        var rightPanel = document.createElement('div');
        rightPanel.className = 'cd-panel cd-panel-right';
        rightPanel.innerHTML =
            '<div class="cd-panel-header">NETWORK PROPERTIES</div>' +
            '<div class="cd-props-content" id="cd-props-content">' +
                '<div class="cd-props-empty">Select a network to configure</div>' +
            '</div>';
        body.appendChild(rightPanel);

        modal.appendChild(body);

        // Footer / summary bar
        var footer = document.createElement('div');
        footer.className = 'cd-footer';
        footer.innerHTML =
            '<div class="cd-summary" id="cd-summary">' +
                '<span class="cd-summary-item">Networks: <strong id="cd-sum-nets">0</strong></span>' +
                '<span class="cd-summary-item">Links: <strong id="cd-sum-links">0</strong></span>' +
                '<span class="cd-summary-item">Bandwidth: <strong id="cd-sum-bw">0</strong> Mbps</span>' +
                '<span class="cd-summary-item">Entities: <strong id="cd-sum-ents">0</strong></span>' +
            '</div>' +
            '<div class="cd-footer-actions">' +
                '<button class="cd-btn cd-btn-cancel" id="cd-btn-cancel">Cancel</button>' +
                '<button class="cd-btn cd-btn-confirm" id="cd-btn-apply">Apply & Close</button>' +
            '</div>';
        modal.appendChild(footer);

        _overlay.appendChild(modal);
        document.body.appendChild(_overlay);

        _wireEvents();
    }

    // =========================================================================
    // Event Wiring
    // =========================================================================

    function _wireEvents() {
        // Close button
        document.getElementById('cd-close-btn').addEventListener('click', close);
        document.getElementById('cd-btn-cancel').addEventListener('click', close);
        document.getElementById('cd-btn-apply').addEventListener('click', function() {
            _saveToStorage();
            close();
        });

        // New network
        document.getElementById('cd-new-network-btn').addEventListener('click', function() {
            _createNewNetwork();
        });

        // Entity search
        document.getElementById('cd-entity-search').addEventListener('input', function() {
            _selectedEntityIds.clear();
            _lastClickedEntityId = null;
            _renderEntityList();
            _updateBulkBar();
        });

        // Bulk select all
        document.getElementById('cd-select-all').addEventListener('click', function() {
            var visible = _getVisibleEntities();
            if (_selectedEntityIds.size === visible.length && visible.length > 0) {
                _selectedEntityIds.clear();
            } else {
                visible.forEach(function(ent) { _selectedEntityIds.add(ent.id); });
            }
            _renderEntityList();
            _updateBulkBar();
        });

        // Select by type
        document.getElementById('cd-select-by-type').addEventListener('change', function() {
            var type = this.value;
            if (!type) return;
            _entities.forEach(function(ent) {
                if ((ent.type || '').toLowerCase() === type.toLowerCase()) {
                    _selectedEntityIds.add(ent.id);
                }
            });
            this.value = '';
            _renderEntityList();
            _updateBulkBar();
        });

        // Select by team
        document.getElementById('cd-select-by-team').addEventListener('change', function() {
            var team = this.value;
            if (!team) return;
            _entities.forEach(function(ent) {
                if ((ent.team || '').toLowerCase() === team.toLowerCase()) {
                    _selectedEntityIds.add(ent.id);
                }
            });
            this.value = '';
            _renderEntityList();
            _updateBulkBar();
        });

        // Add selected to network
        document.getElementById('cd-add-selected').addEventListener('click', function() {
            _addSelectedToNetwork();
        });

        // Canvas tools
        document.getElementById('cd-tool-auto-layout').addEventListener('click', function() {
            if (!_selectedNetworkId) return;
            _runForceLayout();
        });
        document.getElementById('cd-tool-zoom-fit').addEventListener('click', function() {
            if (!_selectedNetworkId) return;
            _zoomToFit();
        });
        document.getElementById('cd-tool-draw-link').addEventListener('click', function() {
            var net = _getNetwork(_selectedNetworkId);
            if (!net) return;
            if (net.type !== 'custom') {
                _showToast('Custom link drawing only available in Custom topology');
                return;
            }
            _isDrawingLink = !_isDrawingLink;
            _drawLinkFrom = null;
            var btn = document.getElementById('cd-tool-draw-link');
            if (btn) btn.classList.toggle('cd-tool-active', _isDrawingLink);
            _updateCanvasStatus(_isDrawingLink ? 'Click a node to start drawing a link' : '');
        });
        document.getElementById('cd-tool-clear').addEventListener('click', function() {
            var net = _getNetwork(_selectedNetworkId);
            if (!net) return;
            if (net.members.length === 0) return;
            if (!confirm('Remove all nodes from "' + net.name + '"?')) return;
            net.members = [];
            net.hub = null;
            net.path = null;
            net.links = [];
            _nodePositions = {};
            _renderCanvas();
            _renderProperties();
            _updateSummary();
        });

        // Canvas container for drops and mouse
        var container = document.getElementById('cd-canvas-container');
        container.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        container.addEventListener('drop', function(e) {
            e.preventDefault();
            _handleCanvasDrop(e);
        });

        // Keyboard
        document.addEventListener('keydown', function(e) {
            if (_overlay.style.display === 'none') return;
            if (e.key === 'Escape') {
                if (_isDrawingLink) {
                    _isDrawingLink = false;
                    _drawLinkFrom = null;
                    _renderCanvas();
                    var btn = document.getElementById('cd-tool-draw-link');
                    if (btn) btn.classList.remove('cd-tool-active');
                    _updateCanvasStatus('');
                } else {
                    close();
                }
                e.stopPropagation();
            }
            if (e.key === 'Delete' && _selectedNodeId && _selectedNetworkId) {
                _removeNodeFromNetwork(_selectedNetworkId, _selectedNodeId);
                _selectedNodeId = null;
                e.stopPropagation();
            }
            // Ctrl+A select all entities
            if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
                var searchEl = document.getElementById('cd-entity-search');
                if (document.activeElement !== searchEl) {
                    e.preventDefault();
                    e.stopPropagation();
                    var visible = _getVisibleEntities();
                    visible.forEach(function(ent) { _selectedEntityIds.add(ent.id); });
                    _renderEntityList();
                    _updateBulkBar();
                }
            }
        });
    }

    // =========================================================================
    // Open / Close
    // =========================================================================

    function open(entities) {
        if (!_initialized) init();
        _entities = (entities || []).map(function(e) {
            return {
                id: e.id || e.def && e.def.id,
                name: e.name || (e.def && e.def.name) || e.id,
                type: e.type || (e.def && e.def.type) || 'unknown',
                team: e.team || (e.def && e.def.team) || 'neutral'
            };
        });
        _selectedNetworkId = _networks.length > 0 ? _networks[0].id : null;
        _selectedNodeId = null;
        _selectedEntityIds.clear();
        _lastClickedEntityId = null;
        _isDrawingLink = false;
        _drawLinkFrom = null;

        _populateFilterDropdowns();
        _renderEntityList();
        _renderSavedNetworkList();
        _renderCanvas();
        _renderProperties();
        _updateSummary();
        _updateBulkBar();

        _overlay.style.display = 'flex';
    }

    function close() {
        if (_overlay) _overlay.style.display = 'none';
        _stopForceLayout();
        _isDrawingLink = false;
        _drawLinkFrom = null;
    }

    // =========================================================================
    // Network CRUD
    // =========================================================================

    function _generateNetId() {
        var id = NET_ID_PREFIX + String(_nextNetId).padStart(3, '0');
        _nextNetId++;
        return id;
    }

    function _createNewNetwork() {
        var net = {
            id: _generateNetId(),
            name: 'Network ' + _networks.length,
            type: 'mesh',
            members: [],
            hub: null,
            path: null,
            links: [],
            config: _cloneObj(LINK_PRESETS.link16)
        };
        _networks.push(net);
        _selectedNetworkId = net.id;
        _selectedNodeId = null;
        _nodePositions = {};
        _renderSavedNetworkList();
        _renderCanvas();
        _renderProperties();
        _updateSummary();
        return net;
    }

    function _deleteNetwork(netId) {
        _networks = _networks.filter(function(n) { return n.id !== netId; });
        // Remove from any parent networks that reference it
        _networks.forEach(function(n) {
            n.members = n.members.filter(function(m) { return m !== netId; });
            if (n.hub === netId) n.hub = null;
            if (n.path) n.path = n.path.filter(function(p) { return p !== netId; });
            if (n.links) n.links = n.links.filter(function(l) { return l.from !== netId && l.to !== netId; });
        });
        if (_selectedNetworkId === netId) {
            _selectedNetworkId = _networks.length > 0 ? _networks[0].id : null;
            _nodePositions = {};
        }
        _renderSavedNetworkList();
        _renderCanvas();
        _renderProperties();
        _updateSummary();
    }

    function _duplicateNetwork(netId) {
        var src = _getNetwork(netId);
        if (!src) return;
        var dup = _cloneObj(src);
        dup.id = _generateNetId();
        dup.name = src.name + ' (copy)';
        _networks.push(dup);
        _selectedNetworkId = dup.id;
        _nodePositions = {};
        _renderSavedNetworkList();
        _renderCanvas();
        _renderProperties();
        _updateSummary();
    }

    function _getNetwork(id) {
        for (var i = 0; i < _networks.length; i++) {
            if (_networks[i].id === id) return _networks[i];
        }
        return null;
    }

    // =========================================================================
    // Entity List (Left Panel)
    // =========================================================================

    function _getVisibleEntities() {
        var searchEl = document.getElementById('cd-entity-search');
        var filter = searchEl ? searchEl.value.toLowerCase() : '';
        return _entities.filter(function(ent) {
            if (!filter) return true;
            return (ent.name || '').toLowerCase().indexOf(filter) >= 0 ||
                   (ent.type || '').toLowerCase().indexOf(filter) >= 0 ||
                   (ent.id || '').toLowerCase().indexOf(filter) >= 0;
        });
    }

    function _renderEntityList() {
        var listEl = document.getElementById('cd-entity-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        var filtered = _getVisibleEntities();

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="cd-entity-empty">No entities found</div>';
            return;
        }

        // Group by type for easier navigation
        var groups = {};
        var groupOrder = [];
        filtered.forEach(function(ent) {
            var t = (ent.type || 'unknown').toLowerCase();
            if (!groups[t]) {
                groups[t] = [];
                groupOrder.push(t);
            }
            groups[t].push(ent);
        });

        // If only one group or few entities, skip grouping headers
        var showGroups = groupOrder.length > 1 && filtered.length > 8;

        groupOrder.forEach(function(type) {
            if (showGroups) {
                var groupHeader = document.createElement('div');
                groupHeader.className = 'cd-entity-group-header';
                var groupCount = groups[type].length;
                var selectedInGroup = groups[type].filter(function(e) { return _selectedEntityIds.has(e.id); }).length;
                groupHeader.innerHTML =
                    '<span class="cd-entity-group-label">' + type.toUpperCase() + ' (' + groupCount + ')</span>' +
                    '<button class="cd-entity-group-add-all" title="Select all ' + type + '">Select All</button>';
                groupHeader.querySelector('.cd-entity-group-add-all').addEventListener('click', function() {
                    groups[type].forEach(function(ent) { _selectedEntityIds.add(ent.id); });
                    _renderEntityList();
                    _updateBulkBar();
                });
                listEl.appendChild(groupHeader);
            }

            groups[type].forEach(function(ent) {
                var card = document.createElement('div');
                var isSelected = _selectedEntityIds.has(ent.id);
                card.className = 'cd-entity-card' + (isSelected ? ' cd-entity-card-selected' : '');
                card.setAttribute('draggable', 'true');
                card.setAttribute('data-entity-id', ent.id);

                var teamColor = TEAM_COLORS[ent.team] || '#888';
                var typeLabel = (ent.type || 'unknown').toUpperCase();

                // Check if already in current network
                var net = _getNetwork(_selectedNetworkId);
                var inNetwork = net && net.members.indexOf(ent.id) >= 0;

                card.innerHTML =
                    '<div class="cd-entity-checkbox">' +
                        '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' tabindex="-1" />' +
                    '</div>' +
                    '<div class="cd-entity-dot" style="background:' + teamColor + '"></div>' +
                    '<div class="cd-entity-info">' +
                        '<div class="cd-entity-name">' + _escapeHtml(ent.name) +
                            (inNetwork ? ' <span class="cd-entity-in-net">IN NET</span>' : '') +
                        '</div>' +
                        '<div class="cd-entity-type">' + typeLabel + '</div>' +
                    '</div>';

                // Click for multi-select (Ctrl/Cmd = toggle, Shift = range)
                card.addEventListener('click', function(e) {
                    e.preventDefault();
                    if (e.ctrlKey || e.metaKey) {
                        // Toggle individual
                        if (_selectedEntityIds.has(ent.id)) {
                            _selectedEntityIds.delete(ent.id);
                        } else {
                            _selectedEntityIds.add(ent.id);
                        }
                    } else if (e.shiftKey && _lastClickedEntityId) {
                        // Range select
                        var idxStart = -1, idxEnd = -1;
                        for (var fi = 0; fi < filtered.length; fi++) {
                            if (filtered[fi].id === _lastClickedEntityId) idxStart = fi;
                            if (filtered[fi].id === ent.id) idxEnd = fi;
                        }
                        if (idxStart >= 0 && idxEnd >= 0) {
                            var lo = Math.min(idxStart, idxEnd);
                            var hi = Math.max(idxStart, idxEnd);
                            for (var ri = lo; ri <= hi; ri++) {
                                _selectedEntityIds.add(filtered[ri].id);
                            }
                        }
                    } else {
                        // Single click: toggle if already selected, else select only this
                        if (_selectedEntityIds.has(ent.id) && _selectedEntityIds.size === 1) {
                            _selectedEntityIds.clear();
                        } else {
                            _selectedEntityIds.clear();
                            _selectedEntityIds.add(ent.id);
                        }
                    }
                    _lastClickedEntityId = ent.id;
                    _renderEntityList();
                    _updateBulkBar();
                });

                // Drag start — drag all selected (or just this one if not selected)
                card.addEventListener('dragstart', function(e) {
                    var ids;
                    if (_selectedEntityIds.has(ent.id) && _selectedEntityIds.size > 1) {
                        ids = Array.from(_selectedEntityIds);
                    } else {
                        ids = [ent.id];
                    }
                    e.dataTransfer.setData('text/plain', JSON.stringify({
                        entityIds: ids,
                        entityId: ids[0],
                        isNetwork: false,
                        isMulti: ids.length > 1
                    }));
                    e.dataTransfer.effectAllowed = 'copy';
                });

                listEl.appendChild(card);
            });
        });
    }

    function _populateFilterDropdowns() {
        // Populate type dropdown
        var typeSelect = document.getElementById('cd-select-by-type');
        if (typeSelect) {
            typeSelect.innerHTML = '<option value="">By Type...</option>';
            var types = {};
            _entities.forEach(function(ent) {
                var t = (ent.type || 'unknown').toLowerCase();
                if (!types[t]) types[t] = 0;
                types[t]++;
            });
            Object.keys(types).sort().forEach(function(t) {
                var opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t.toUpperCase() + ' (' + types[t] + ')';
                typeSelect.appendChild(opt);
            });
        }

        // Populate team dropdown
        var teamSelect = document.getElementById('cd-select-by-team');
        if (teamSelect) {
            teamSelect.innerHTML = '<option value="">By Team...</option>';
            var teams = {};
            _entities.forEach(function(ent) {
                var t = (ent.team || 'neutral').toLowerCase();
                if (!teams[t]) teams[t] = 0;
                teams[t]++;
            });
            Object.keys(teams).sort().forEach(function(t) {
                var opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t.toUpperCase() + ' (' + teams[t] + ')';
                teamSelect.appendChild(opt);
            });
        }
    }

    function _updateBulkBar() {
        var addBtn = document.getElementById('cd-add-selected');
        if (addBtn) {
            var count = _selectedEntityIds.size;
            addBtn.textContent = 'Add Selected (' + count + ')';
            addBtn.disabled = count === 0 || !_selectedNetworkId;
        }
    }

    function _addSelectedToNetwork() {
        var net = _getNetwork(_selectedNetworkId);
        if (!net) {
            _showToast('Create or select a network first');
            return;
        }
        if (_selectedEntityIds.size === 0) return;

        var container = document.getElementById('cd-canvas-container');
        var w = container ? container.clientWidth : 600;
        var h = container ? container.clientHeight : 400;
        var added = 0;

        _selectedEntityIds.forEach(function(entityId) {
            if (net.members.indexOf(entityId) >= 0) return; // already a member
            net.members.push(entityId);

            // Arrange in circle for new nodes
            var count = net.members.length;
            var radius = Math.min(w, h) * 0.35;
            var angle = (2 * Math.PI * (count - 1) / Math.max(count, 1)) - Math.PI / 2;
            _nodePositions[entityId] = {
                x: w / 2 + radius * Math.cos(angle),
                y: h / 2 + radius * Math.sin(angle)
            };

            if (net.type === 'multihop') {
                if (!net.path) net.path = [];
                net.path.push(entityId);
            }
            added++;
        });

        if (added > 0) {
            // Re-layout all positions for even spacing
            _nodePositions = {};
            _initNodePositions(net);
            _renderCanvas();
            _renderProperties();
            _updateSummary();
            _renderEntityList();
            _showToast('Added ' + added + ' entities to ' + net.name);
        } else {
            _showToast('All selected entities are already in the network');
        }
    }

    // =========================================================================
    // Saved Network List (Left Panel)
    // =========================================================================

    function _renderSavedNetworkList() {
        var listEl = document.getElementById('cd-saved-network-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        if (_networks.length === 0) {
            listEl.innerHTML = '<div class="cd-entity-empty">No networks yet</div>';
            return;
        }

        _networks.forEach(function(net) {
            var item = document.createElement('div');
            item.className = 'cd-network-item' + (net.id === _selectedNetworkId ? ' cd-network-item-selected' : '');
            item.setAttribute('draggable', 'true');
            item.setAttribute('data-network-id', net.id);

            var typeColor = net.type === 'mesh' ? '#4a9eff' :
                            net.type === 'star' ? '#ffcc44' :
                            net.type === 'multihop' ? '#44ff88' : '#aa66ff';

            item.innerHTML =
                '<div class="cd-network-icon" style="border-color:' + typeColor + '">' +
                    '<span class="cd-network-type-badge" style="color:' + typeColor + '">' +
                        (net.type === 'mesh' ? 'M' : net.type === 'star' ? 'S' : net.type === 'multihop' ? 'H' : 'C') +
                    '</span>' +
                '</div>' +
                '<div class="cd-network-info">' +
                    '<div class="cd-network-name">' + _escapeHtml(net.name) + '</div>' +
                    '<div class="cd-network-meta">' +
                        NETWORK_TYPE_LABELS[net.type] + ' | ' + net.members.length + ' nodes' +
                    '</div>' +
                '</div>' +
                '<div class="cd-network-actions">' +
                    '<button class="cd-network-action-btn cd-net-dup" title="Duplicate">&#x2750;</button>' +
                    '<button class="cd-network-action-btn cd-net-del cd-tool-danger" title="Delete">&#x2716;</button>' +
                '</div>';

            // Select network
            item.addEventListener('click', function(e) {
                if (e.target.closest('.cd-net-del') || e.target.closest('.cd-net-dup')) return;
                _selectedNetworkId = net.id;
                _selectedNodeId = null;
                _isDrawingLink = false;
                _drawLinkFrom = null;
                _initNodePositions(net);
                _renderSavedNetworkList();
                _renderCanvas();
                _renderProperties();
            });

            // Duplicate
            item.querySelector('.cd-net-dup').addEventListener('click', function(e) {
                e.stopPropagation();
                _duplicateNetwork(net.id);
            });

            // Delete
            item.querySelector('.cd-net-del').addEventListener('click', function(e) {
                e.stopPropagation();
                if (confirm('Delete network "' + net.name + '"?')) {
                    _deleteNetwork(net.id);
                }
            });

            // Drag as nested network
            item.addEventListener('dragstart', function(e) {
                e.dataTransfer.setData('text/plain', JSON.stringify({
                    entityId: net.id,
                    isNetwork: true
                }));
                e.dataTransfer.effectAllowed = 'copy';
            });

            listEl.appendChild(item);
        });
    }

    // =========================================================================
    // Network Canvas (Center Panel) — SVG-based
    // =========================================================================

    function _renderCanvas() {
        var container = document.getElementById('cd-canvas-container');
        if (!container) return;

        var emptyMsg = document.getElementById('cd-canvas-empty');
        var titleEl = document.getElementById('cd-canvas-title');

        var net = _getNetwork(_selectedNetworkId);

        if (!net) {
            if (emptyMsg) emptyMsg.style.display = 'flex';
            if (titleEl) titleEl.textContent = 'No network selected';
            _removeSvg();
            return;
        }

        if (titleEl) titleEl.textContent = net.name + ' (' + NETWORK_TYPE_LABELS[net.type] + ')';

        if (net.members.length === 0) {
            if (emptyMsg) {
                emptyMsg.style.display = 'flex';
                emptyMsg.querySelector('.cd-canvas-empty-text').textContent = 'Drag entities from the left panel to add nodes';
            }
            _removeSvg();
            return;
        }

        if (emptyMsg) emptyMsg.style.display = 'none';

        _initNodePositions(net);
        _drawSvg(net, container);
    }

    function _removeSvg() {
        if (_svgEl && _svgEl.parentNode) {
            _svgEl.parentNode.removeChild(_svgEl);
        }
        _svgEl = null;
    }

    function _initNodePositions(net) {
        if (!net) return;
        var containerEl = document.getElementById('cd-canvas-container');
        if (!containerEl) return;
        var w = containerEl.clientWidth || 600;
        var h = containerEl.clientHeight || 400;
        var cx = w / 2;
        var cy = h / 2;

        // Only set positions for nodes that don't have one yet
        var radius = Math.min(w, h) * 0.35;
        var count = net.members.length;

        net.members.forEach(function(memberId, i) {
            if (!_nodePositions[memberId]) {
                if (net.type === 'star' && net.hub === memberId) {
                    _nodePositions[memberId] = { x: cx, y: cy };
                } else if (net.type === 'multihop') {
                    var padding = 80;
                    var availW = w - 2 * padding;
                    var xPos = count > 1 ? padding + (i / (count - 1)) * availW : cx;
                    _nodePositions[memberId] = { x: xPos, y: cy };
                } else {
                    var angle = (2 * Math.PI * i / count) - Math.PI / 2;
                    _nodePositions[memberId] = {
                        x: cx + radius * Math.cos(angle),
                        y: cy + radius * Math.sin(angle)
                    };
                }
            }
        });
    }

    function _drawSvg(net, container) {
        _removeSvg();

        var w = container.clientWidth || 600;
        var h = container.clientHeight || 400;

        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';

        // Defs for arrowheads and glows
        var defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

        // Arrow marker for multi-hop
        var marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', 'cd-arrow');
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '10');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '8');
        marker.setAttribute('markerHeight', '8');
        marker.setAttribute('orient', 'auto-start-reverse');
        var arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
        arrowPath.setAttribute('fill', '#44ff88');
        marker.appendChild(arrowPath);
        defs.appendChild(marker);

        // Glow filter
        var filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'cd-glow');
        filter.setAttribute('x', '-50%');
        filter.setAttribute('y', '-50%');
        filter.setAttribute('width', '200%');
        filter.setAttribute('height', '200%');
        var feGauss = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
        feGauss.setAttribute('stdDeviation', '3');
        feGauss.setAttribute('result', 'coloredBlur');
        filter.appendChild(feGauss);
        var feMerge = document.createElementNS('http://www.w3.org/2000/svg', 'feMerge');
        var feMNode1 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
        feMNode1.setAttribute('in', 'coloredBlur');
        feMerge.appendChild(feMNode1);
        var feMNode2 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
        feMNode2.setAttribute('in', 'SourceGraphic');
        feMerge.appendChild(feMNode2);
        filter.appendChild(feMerge);
        defs.appendChild(filter);

        svg.appendChild(defs);

        // Links group (drawn behind nodes)
        var linksGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        linksGroup.setAttribute('class', 'cd-links-group');

        var linkPairs = _computeLinks(net);
        var linkColor = LINK_TYPE_COLORS[net.config.linkType] || '#4a9eff';

        linkPairs.forEach(function(pair) {
            var p1 = _nodePositions[pair.from];
            var p2 = _nodePositions[pair.to];
            if (!p1 || !p2) return;

            var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', p1.x);
            line.setAttribute('y1', p1.y);
            line.setAttribute('x2', p2.x);
            line.setAttribute('y2', p2.y);
            line.setAttribute('stroke', linkColor);
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-opacity', '0.6');

            if (net.type === 'multihop') {
                line.setAttribute('marker-end', 'url(#cd-arrow)');
                // Shorten line to not overlap with node circles
                var dx = p2.x - p1.x;
                var dy = p2.y - p1.y;
                var len = Math.sqrt(dx * dx + dy * dy);
                if (len > 0) {
                    var nodeRadius = 24;
                    var ux = dx / len;
                    var uy = dy / len;
                    line.setAttribute('x1', p1.x + ux * nodeRadius);
                    line.setAttribute('y1', p1.y + uy * nodeRadius);
                    line.setAttribute('x2', p2.x - ux * (nodeRadius + 8));
                    line.setAttribute('y2', p2.y - uy * (nodeRadius + 8));
                }
            }

            linksGroup.appendChild(line);
        });

        svg.appendChild(linksGroup);

        // Nodes group
        var nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        nodesGroup.setAttribute('class', 'cd-nodes-group');

        net.members.forEach(function(memberId) {
            var pos = _nodePositions[memberId];
            if (!pos) return;

            var isSubNetwork = _isNetworkId(memberId);
            var info = _getMemberInfo(memberId);
            var isHub = net.type === 'star' && net.hub === memberId;
            var isSelected = memberId === _selectedNodeId;

            var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');
            g.setAttribute('data-node-id', memberId);
            g.style.cursor = 'pointer';

            // Node shape
            if (isSubNetwork) {
                // Hexagon for sub-networks
                var hex = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                var r = isHub ? 28 : 22;
                var points = [];
                for (var a = 0; a < 6; a++) {
                    var angle = Math.PI / 3 * a - Math.PI / 6;
                    points.push((r * Math.cos(angle)).toFixed(1) + ',' + (r * Math.sin(angle)).toFixed(1));
                }
                hex.setAttribute('points', points.join(' '));
                hex.setAttribute('fill', isSelected ? '#2a4a6a' : '#1a2a44');
                hex.setAttribute('stroke', isHub ? '#ffcc44' : '#aa66ff');
                hex.setAttribute('stroke-width', isSelected ? '3' : '2');
                if (isHub) hex.setAttribute('filter', 'url(#cd-glow)');
                g.appendChild(hex);
            } else {
                // Circle for entities
                var circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                var cr = isHub ? 26 : 20;
                circle.setAttribute('r', cr);
                circle.setAttribute('fill', isSelected ? '#2a4a6a' : '#0d1a2a');
                circle.setAttribute('stroke', isHub ? '#ffcc44' : (info.teamColor || '#4a9eff'));
                circle.setAttribute('stroke-width', isSelected ? '3' : '2');
                if (isHub) circle.setAttribute('filter', 'url(#cd-glow)');
                g.appendChild(circle);
            }

            // Team color dot
            if (!isSubNetwork && info.teamColor) {
                var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                dot.setAttribute('r', '4');
                dot.setAttribute('cx', '0');
                dot.setAttribute('cy', '-10');
                dot.setAttribute('fill', info.teamColor);
                g.appendChild(dot);
            }

            // Label
            var label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('y', isSubNetwork ? '4' : '4');
            label.setAttribute('fill', '#e0e8f0');
            label.setAttribute('font-size', '10');
            label.setAttribute('font-family', 'monospace');
            label.setAttribute('pointer-events', 'none');
            var shortName = _truncate(info.name, 10);
            label.textContent = shortName;
            g.appendChild(label);

            // Hub badge
            if (isHub) {
                var badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                badge.setAttribute('text-anchor', 'middle');
                badge.setAttribute('y', (isSubNetwork ? -26 : -24));
                badge.setAttribute('fill', '#ffcc44');
                badge.setAttribute('font-size', '9');
                badge.setAttribute('font-weight', 'bold');
                badge.setAttribute('font-family', 'monospace');
                badge.setAttribute('pointer-events', 'none');
                badge.textContent = 'HUB';
                g.appendChild(badge);
            }

            // Type label below
            var typeLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            typeLabel.setAttribute('text-anchor', 'middle');
            typeLabel.setAttribute('y', isSubNetwork ? 34 : 32);
            typeLabel.setAttribute('fill', '#5a7a9a');
            typeLabel.setAttribute('font-size', '8');
            typeLabel.setAttribute('font-family', 'monospace');
            typeLabel.setAttribute('pointer-events', 'none');
            typeLabel.textContent = isSubNetwork ? 'SUBNET' : (info.type || '').toUpperCase();
            g.appendChild(typeLabel);

            // Mouse interaction
            _wireNodeMouse(g, memberId);

            nodesGroup.appendChild(g);
        });

        svg.appendChild(nodesGroup);

        // Wire SVG-level mouse events for custom link drawing
        svg.addEventListener('mousemove', function(e) {
            if (_isDraggingNode && _dragNodeId) {
                var rect = container.getBoundingClientRect();
                var x = e.clientX - rect.left;
                var y = e.clientY - rect.top;
                _nodePositions[_dragNodeId] = { x: x, y: y };
                _drawSvg(net, container);
            }
        });

        svg.addEventListener('mouseup', function() {
            _isDraggingNode = false;
            _dragNodeId = null;
        });

        container.appendChild(svg);
        _svgEl = svg;
    }

    function _wireNodeMouse(gElement, nodeId) {
        gElement.addEventListener('mousedown', function(e) {
            if (_isDrawingLink) {
                if (!_drawLinkFrom) {
                    _drawLinkFrom = nodeId;
                    _updateCanvasStatus('Now click the target node');
                } else if (_drawLinkFrom !== nodeId) {
                    // Complete the custom link
                    var net = _getNetwork(_selectedNetworkId);
                    if (net && net.type === 'custom') {
                        // Check for duplicate
                        var exists = net.links.some(function(l) {
                            return (l.from === _drawLinkFrom && l.to === nodeId) ||
                                   (l.from === nodeId && l.to === _drawLinkFrom);
                        });
                        if (!exists) {
                            net.links.push({ from: _drawLinkFrom, to: nodeId });
                        }
                    }
                    _drawLinkFrom = null;
                    _isDrawingLink = false;
                    var btn = document.getElementById('cd-tool-draw-link');
                    if (btn) btn.classList.remove('cd-tool-active');
                    _updateCanvasStatus('');
                    _renderCanvas();
                    _updateSummary();
                } else {
                    _drawLinkFrom = null;
                    _updateCanvasStatus('Click a node to start drawing a link');
                }
                e.stopPropagation();
                return;
            }

            _selectedNodeId = nodeId;
            _isDraggingNode = true;
            _dragNodeId = nodeId;
            _renderCanvas();
            _renderNodeProps(nodeId);
            e.stopPropagation();
            e.preventDefault();
        });

        // Right-click context menu
        gElement.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
            _showNodeContextMenu(e, nodeId);
        });
    }

    // =========================================================================
    // Node Context Menu
    // =========================================================================

    function _showNodeContextMenu(e, nodeId) {
        _removeContextMenu();

        var net = _getNetwork(_selectedNetworkId);
        if (!net) return;

        var menu = document.createElement('div');
        menu.className = 'cd-context-menu';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';

        var info = _getMemberInfo(nodeId);

        // Header
        var header = document.createElement('div');
        header.className = 'cd-ctx-header';
        header.textContent = _truncate(info.name, 20);
        menu.appendChild(header);

        // Set as Hub (for star networks)
        if (net.type === 'star') {
            var hubItem = document.createElement('div');
            hubItem.className = 'cd-ctx-item';
            hubItem.textContent = net.hub === nodeId ? 'Remove Hub Role' : 'Set as Hub';
            hubItem.addEventListener('click', function() {
                net.hub = net.hub === nodeId ? null : nodeId;
                _removeContextMenu();
                _renderCanvas();
                _renderProperties();
            });
            menu.appendChild(hubItem);
        }

        // Move up/down in path (for multihop)
        if (net.type === 'multihop') {
            var idx = net.members.indexOf(nodeId);
            if (idx > 0) {
                var moveUp = document.createElement('div');
                moveUp.className = 'cd-ctx-item';
                moveUp.textContent = 'Move Earlier in Chain';
                moveUp.addEventListener('click', function() {
                    var temp = net.members[idx - 1];
                    net.members[idx - 1] = net.members[idx];
                    net.members[idx] = temp;
                    _nodePositions = {};
                    _removeContextMenu();
                    _renderCanvas();
                    _renderProperties();
                });
                menu.appendChild(moveUp);
            }
            if (idx < net.members.length - 1) {
                var moveDown = document.createElement('div');
                moveDown.className = 'cd-ctx-item';
                moveDown.textContent = 'Move Later in Chain';
                moveDown.addEventListener('click', function() {
                    var temp = net.members[idx + 1];
                    net.members[idx + 1] = net.members[idx];
                    net.members[idx] = temp;
                    _nodePositions = {};
                    _removeContextMenu();
                    _renderCanvas();
                    _renderProperties();
                });
                menu.appendChild(moveDown);
            }
        }

        // Remove from network
        var removeItem = document.createElement('div');
        removeItem.className = 'cd-ctx-item cd-ctx-danger';
        removeItem.textContent = 'Remove from Network';
        removeItem.addEventListener('click', function() {
            _removeNodeFromNetwork(net.id, nodeId);
            _removeContextMenu();
        });
        menu.appendChild(removeItem);

        document.body.appendChild(menu);

        // Close on outside click
        setTimeout(function() {
            document.addEventListener('click', _removeContextMenu, { once: true });
        }, 10);
    }

    function _removeContextMenu() {
        var existing = document.querySelector('.cd-context-menu');
        if (existing) existing.parentNode.removeChild(existing);
    }

    // =========================================================================
    // Canvas Drop Handling
    // =========================================================================

    function _handleCanvasDrop(e) {
        var net = _getNetwork(_selectedNetworkId);
        if (!net) {
            _showToast('Create or select a network first');
            return;
        }

        var raw = e.dataTransfer.getData('text/plain');
        if (!raw) return;

        var data;
        try { data = JSON.parse(raw); } catch (err) { return; }

        var isNetwork = data.isNetwork;

        // Handle multi-entity drop
        if (data.isMulti && data.entityIds && data.entityIds.length > 1) {
            var container = document.getElementById('cd-canvas-container');
            var rect = container.getBoundingClientRect();
            var dropX = e.clientX - rect.left;
            var dropY = e.clientY - rect.top;
            var added = 0;
            var total = data.entityIds.length;
            var radius = Math.min(total * 15, 120);

            data.entityIds.forEach(function(entityId, idx) {
                if (net.members.indexOf(entityId) >= 0) return;
                net.members.push(entityId);
                // Spread around drop point in circle
                var angle = (2 * Math.PI * idx / total) - Math.PI / 2;
                _nodePositions[entityId] = {
                    x: dropX + radius * Math.cos(angle),
                    y: dropY + radius * Math.sin(angle)
                };
                if (net.type === 'multihop') {
                    if (!net.path) net.path = [];
                    net.path.push(entityId);
                }
                added++;
            });

            if (added > 0) {
                _renderCanvas();
                _renderProperties();
                _updateSummary();
                _renderEntityList();
                _showToast('Added ' + added + ' entities to ' + net.name);
            } else {
                _showToast('All entities already in network');
            }
            return;
        }

        // Single entity/network drop
        var memberId = data.entityId;

        // Prevent adding a network to itself
        if (isNetwork && memberId === net.id) {
            _showToast('Cannot add a network to itself');
            return;
        }

        // Prevent circular nesting
        if (isNetwork && _wouldCreateCycle(net.id, memberId)) {
            _showToast('Cannot add: would create circular reference');
            return;
        }

        // Check if already a member
        if (net.members.indexOf(memberId) >= 0) {
            _showToast('Already a member of this network');
            return;
        }

        // Add as member
        net.members.push(memberId);

        // Position at drop location
        var container2 = document.getElementById('cd-canvas-container');
        var rect2 = container2.getBoundingClientRect();
        _nodePositions[memberId] = {
            x: e.clientX - rect2.left,
            y: e.clientY - rect2.top
        };

        // For multihop, also add to path
        if (net.type === 'multihop') {
            if (!net.path) net.path = [];
            net.path.push(memberId);
        }

        _renderCanvas();
        _renderProperties();
        _updateSummary();
        _renderEntityList();
    }

    function _removeNodeFromNetwork(netId, nodeId) {
        var net = _getNetwork(netId);
        if (!net) return;

        net.members = net.members.filter(function(m) { return m !== nodeId; });
        if (net.hub === nodeId) net.hub = null;
        if (net.path) net.path = net.path.filter(function(p) { return p !== nodeId; });
        if (net.links) net.links = net.links.filter(function(l) { return l.from !== nodeId && l.to !== nodeId; });
        delete _nodePositions[nodeId];

        _renderCanvas();
        _renderProperties();
        _updateSummary();
    }

    // =========================================================================
    // Link Computation
    // =========================================================================

    function _computeLinks(net) {
        var links = [];
        var members = net.members;

        switch (net.type) {
            case 'mesh':
                // All-to-all
                for (var i = 0; i < members.length; i++) {
                    for (var j = i + 1; j < members.length; j++) {
                        links.push({ from: members[i], to: members[j] });
                    }
                }
                break;

            case 'star':
                // Hub to all spokes
                if (net.hub) {
                    members.forEach(function(m) {
                        if (m !== net.hub) {
                            links.push({ from: net.hub, to: m });
                        }
                    });
                }
                break;

            case 'multihop':
                // Sequential chain
                var chain = net.path && net.path.length > 0 ? net.path : members;
                for (var k = 0; k < chain.length - 1; k++) {
                    links.push({ from: chain[k], to: chain[k + 1] });
                }
                break;

            case 'custom':
                // User-defined links
                links = (net.links || []).slice();
                break;
        }

        return links;
    }

    function _countTotalLinks() {
        var total = 0;
        _networks.forEach(function(net) {
            total += _computeLinks(net).length;
        });
        return total;
    }

    function _countTotalBandwidth() {
        var total = 0;
        _networks.forEach(function(net) {
            var linkCount = _computeLinks(net).length;
            total += linkCount * (net.config.bandwidth_mbps || 0);
        });
        return total;
    }

    function _countUniqueEntities() {
        var set = {};
        _networks.forEach(function(net) {
            net.members.forEach(function(m) {
                if (!_isNetworkId(m)) set[m] = true;
            });
        });
        return Object.keys(set).length;
    }

    // =========================================================================
    // Properties Panel (Right Panel)
    // =========================================================================

    function _renderProperties() {
        var propsEl = document.getElementById('cd-props-content');
        if (!propsEl) return;

        var net = _getNetwork(_selectedNetworkId);
        if (!net) {
            propsEl.innerHTML = '<div class="cd-props-empty">Select a network to configure</div>';
            return;
        }

        var html = '';

        // Network name
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Network Name</label>';
        html += '<input type="text" class="cd-prop-input" id="cd-prop-name" value="' + _escapeAttr(net.name) + '" />';
        html += '</div>';

        // Network type
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Topology</label>';
        html += '<select class="cd-prop-select" id="cd-prop-type">';
        ['mesh', 'star', 'multihop', 'custom'].forEach(function(t) {
            html += '<option value="' + t + '"' + (net.type === t ? ' selected' : '') + '>' + NETWORK_TYPE_LABELS[t] + '</option>';
        });
        html += '</select>';
        html += '<div class="cd-prop-hint">' + _getTypeHint(net.type) + '</div>';
        html += '</div>';

        // Members summary with reorder support
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Members (' + net.members.length + ')' +
            (net.type === 'multihop' ? ' <span style="color:#44ff88;font-size:9px"> — drag to reorder chain</span>' : '') +
            '</label>';
        html += '<div class="cd-prop-members" id="cd-prop-members-list">';
        if (net.members.length === 0) {
            html += '<div class="cd-prop-member-empty">Drag entities to canvas, or select + click "Add Selected"</div>';
        } else {
            net.members.forEach(function(m, idx) {
                var info = _getMemberInfo(m);
                var isHub = net.type === 'star' && net.hub === m;
                var draggable = net.type === 'multihop' ? ' draggable="true"' : '';
                html += '<div class="cd-prop-member-item' + (net.type === 'multihop' ? ' cd-prop-member-draggable' : '') + '"' +
                    draggable + ' data-member-id="' + m + '" data-member-idx="' + idx + '">' +
                    (net.type === 'multihop' ? '<span class="cd-prop-member-grip">&#x2630;</span>' : '') +
                    '<span class="cd-prop-member-dot" style="background:' + (info.teamColor || '#888') + '"></span>' +
                    '<span class="cd-prop-member-name">' + _escapeHtml(info.name) + '</span>' +
                    (isHub ? '<span class="cd-prop-hub-badge">HUB</span>' : '') +
                    (net.type === 'multihop' ? '<span class="cd-prop-member-order">#' + (idx + 1) + '</span>' : '') +
                    '<button class="cd-prop-member-remove" data-remove-id="' + m + '" title="Remove">&times;</button>' +
                    '</div>';
            });
        }
        html += '</div>';
        html += '</div>';

        // Hub selector (star only)
        if (net.type === 'star' && net.members.length > 0) {
            html += '<div class="cd-prop-group">';
            html += '<label class="cd-prop-label">Hub Node</label>';
            html += '<select class="cd-prop-select" id="cd-prop-hub">';
            html += '<option value="">-- Select Hub --</option>';
            net.members.forEach(function(m) {
                var info = _getMemberInfo(m);
                html += '<option value="' + m + '"' + (net.hub === m ? ' selected' : '') + '>' + _escapeHtml(info.name) + '</option>';
            });
            html += '</select>';
            html += '</div>';
        }

        // Link configuration
        html += '<div class="cd-prop-divider"></div>';
        html += '<label class="cd-prop-label" style="color:#4a9eff">LINK CONFIGURATION</label>';

        // Preset selector
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Preset</label>';
        html += '<select class="cd-prop-select" id="cd-prop-preset">';
        html += '<option value="">-- Custom --</option>';
        Object.keys(LINK_PRESETS).forEach(function(key) {
            html += '<option value="' + key + '">' + PRESET_LABELS[key] + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Link type
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Link Type</label>';
        html += '<select class="cd-prop-select" id="cd-prop-linkType">';
        ['rf', 'satcom', 'fiber', 'laser'].forEach(function(lt) {
            html += '<option value="' + lt + '"' + (net.config.linkType === lt ? ' selected' : '') + '>' + lt.toUpperCase() + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Link parameters
        var fields = [
            { id: 'frequency_ghz',           label: 'Frequency (GHz)',         step: '0.1',   min: '0' },
            { id: 'bandwidth_mbps',           label: 'Bandwidth (Mbps)',        step: '1',     min: '0' },
            { id: 'dataRate_mbps',            label: 'Data Rate (Mbps)',        step: '1',     min: '0' },
            { id: 'power_dbw',                label: 'Tx Power (dBW)',          step: '1',     min: '-10' },
            { id: 'antenna_gain_dbi',         label: 'Antenna Gain (dBi)',      step: '1',     min: '0' },
            { id: 'receiver_sensitivity_dbm', label: 'Rx Sensitivity (dBm)',    step: '1',     min: '-150' },
            { id: 'maxRange_m',               label: 'Max Range (m)',           step: '1000',  min: '0' },
            { id: 'latency_ms',               label: 'Latency (ms)',            step: '0.1',   min: '0' }
        ];

        html += '<div class="cd-prop-fields-grid">';
        fields.forEach(function(f) {
            var val = net.config[f.id];
            if (val === undefined || val === null) val = 0;
            html += '<div class="cd-prop-field">';
            html += '<label class="cd-prop-field-label">' + f.label + '</label>';
            html += '<input type="number" class="cd-prop-input cd-prop-field-input" id="cd-prop-' + f.id + '" ' +
                    'value="' + val + '" step="' + f.step + '" min="' + f.min + '" />';
            html += '</div>';
        });
        html += '</div>';

        // Encryption
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Encryption</label>';
        html += '<select class="cd-prop-select" id="cd-prop-encryption">';
        ['none', 'aes128', 'aes256', 'type1'].forEach(function(enc) {
            html += '<option value="' + enc + '"' + (net.config.encryption === enc ? ' selected' : '') + '>' + enc.toUpperCase() + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Protocol
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Protocol</label>';
        html += '<select class="cd-prop-select" id="cd-prop-protocol">';
        ['tdma', 'fdma', 'cdma', 'csma', 'ethernet'].forEach(function(p) {
            html += '<option value="' + p + '"' + (net.config.protocol === p ? ' selected' : '') + '>' + p.toUpperCase() + '</option>';
        });
        html += '</select>';
        html += '</div>';

        // Priority
        html += '<div class="cd-prop-group">';
        html += '<label class="cd-prop-label">Routing Priority (1-10)</label>';
        html += '<input type="range" class="cd-prop-range" id="cd-prop-priority" min="1" max="10" value="' + (net.config.priority || 5) + '" />';
        html += '<span class="cd-prop-range-value" id="cd-prop-priority-val">' + (net.config.priority || 5) + '</span>';
        html += '</div>';

        // Link budget summary
        html += '<div class="cd-prop-divider"></div>';
        html += '<div class="cd-link-budget-summary" id="cd-link-budget-summary"></div>';

        propsEl.innerHTML = html;

        // Wire property change events
        _wirePropertyEvents(net);

        // Wire member remove buttons
        var removeButtons = propsEl.querySelectorAll('.cd-prop-member-remove');
        removeButtons.forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var removeId = btn.getAttribute('data-remove-id');
                if (removeId) {
                    _removeNodeFromNetwork(net.id, removeId);
                }
            });
        });

        // Wire drag-to-reorder for multi-hop members
        if (net.type === 'multihop') {
            _wireMemberDragReorder(net);
        }

        // Compute and display link budget
        _updateLinkBudgetSummary(net);
    }

    function _wireMemberDragReorder(net) {
        var memberList = document.getElementById('cd-prop-members-list');
        if (!memberList) return;

        var dragSrcIdx = -1;

        var items = memberList.querySelectorAll('.cd-prop-member-draggable');
        items.forEach(function(item) {
            item.addEventListener('dragstart', function(e) {
                dragSrcIdx = parseInt(item.getAttribute('data-member-idx'));
                item.classList.add('cd-prop-member-dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', dragSrcIdx.toString());
            });

            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                item.classList.add('cd-prop-member-dragover');
            });

            item.addEventListener('dragleave', function() {
                item.classList.remove('cd-prop-member-dragover');
            });

            item.addEventListener('drop', function(e) {
                e.preventDefault();
                e.stopPropagation();
                item.classList.remove('cd-prop-member-dragover');

                var destIdx = parseInt(item.getAttribute('data-member-idx'));
                if (dragSrcIdx >= 0 && dragSrcIdx !== destIdx) {
                    // Reorder members array
                    var moved = net.members.splice(dragSrcIdx, 1)[0];
                    net.members.splice(destIdx, 0, moved);
                    // Also reorder path if exists
                    if (net.path) {
                        net.path = net.members.slice();
                    }
                    _nodePositions = {};
                    _renderCanvas();
                    _renderProperties();
                }
            });

            item.addEventListener('dragend', function() {
                item.classList.remove('cd-prop-member-dragging');
                dragSrcIdx = -1;
            });
        });
    }

    function _wirePropertyEvents(net) {
        // Name
        var nameEl = document.getElementById('cd-prop-name');
        if (nameEl) {
            nameEl.addEventListener('input', function() {
                net.name = nameEl.value;
                _renderSavedNetworkList();
                var titleEl = document.getElementById('cd-canvas-title');
                if (titleEl) titleEl.textContent = net.name + ' (' + NETWORK_TYPE_LABELS[net.type] + ')';
            });
        }

        // Type
        var typeEl = document.getElementById('cd-prop-type');
        if (typeEl) {
            typeEl.addEventListener('change', function() {
                var oldType = net.type;
                net.type = typeEl.value;

                // Reset type-specific fields
                if (net.type !== 'star') net.hub = null;
                if (net.type === 'multihop') {
                    net.path = net.members.slice();
                } else {
                    net.path = null;
                }
                if (net.type !== 'custom') {
                    net.links = [];
                }

                _nodePositions = {};
                _renderSavedNetworkList();
                _renderCanvas();
                _renderProperties();
                _updateSummary();
            });
        }

        // Hub
        var hubEl = document.getElementById('cd-prop-hub');
        if (hubEl) {
            hubEl.addEventListener('change', function() {
                net.hub = hubEl.value || null;
                _renderCanvas();
            });
        }

        // Preset
        var presetEl = document.getElementById('cd-prop-preset');
        if (presetEl) {
            presetEl.addEventListener('change', function() {
                var preset = LINK_PRESETS[presetEl.value];
                if (preset) {
                    net.config = _cloneObj(preset);
                    _renderProperties();
                    _renderCanvas();
                    _updateSummary();
                }
            });
        }

        // Link type
        var linkTypeEl = document.getElementById('cd-prop-linkType');
        if (linkTypeEl) {
            linkTypeEl.addEventListener('change', function() {
                net.config.linkType = linkTypeEl.value;
                _renderCanvas();
            });
        }

        // Numeric fields
        var numericFields = [
            'frequency_ghz', 'bandwidth_mbps', 'dataRate_mbps', 'power_dbw',
            'antenna_gain_dbi', 'receiver_sensitivity_dbm', 'maxRange_m', 'latency_ms'
        ];
        numericFields.forEach(function(field) {
            var el = document.getElementById('cd-prop-' + field);
            if (el) {
                el.addEventListener('input', function() {
                    net.config[field] = parseFloat(el.value) || 0;
                    _updateLinkBudgetSummary(net);
                    _updateSummary();
                });
            }
        });

        // Encryption
        var encEl = document.getElementById('cd-prop-encryption');
        if (encEl) {
            encEl.addEventListener('change', function() {
                net.config.encryption = encEl.value;
            });
        }

        // Protocol
        var protoEl = document.getElementById('cd-prop-protocol');
        if (protoEl) {
            protoEl.addEventListener('change', function() {
                net.config.protocol = protoEl.value;
            });
        }

        // Priority
        var prioEl = document.getElementById('cd-prop-priority');
        var prioValEl = document.getElementById('cd-prop-priority-val');
        if (prioEl) {
            prioEl.addEventListener('input', function() {
                net.config.priority = parseInt(prioEl.value) || 5;
                if (prioValEl) prioValEl.textContent = prioEl.value;
            });
        }
    }

    function _renderNodeProps(nodeId) {
        // Optionally show node-specific info — currently the right panel
        // shows the full network properties. Could add a node detail section.
    }

    function _getTypeHint(type) {
        switch (type) {
            case 'mesh':     return 'All members communicate directly with all others. N*(N-1)/2 links.';
            case 'star':     return 'Hub relays between spokes. Spokes cannot talk directly.';
            case 'multihop': return 'Ordered chain. Each node relays to the next. Good for relay satellites.';
            case 'custom':   return 'Manually draw links between specific nodes.';
            default: return '';
        }
    }

    // =========================================================================
    // Link Budget Summary
    // =========================================================================

    function _updateLinkBudgetSummary(net) {
        var el = document.getElementById('cd-link-budget-summary');
        if (!el || !net) return;

        var c = net.config;
        var linkCount = _computeLinks(net).length;

        // Simple link budget: EIRP - FSPL + Rx gain - Rx sensitivity = margin
        var eirp_dbw = (c.power_dbw || 0) + (c.antenna_gain_dbi || 0);
        var freq_hz = (c.frequency_ghz || 1) * 1e9;
        var range_m = c.maxRange_m || 1;

        // Free Space Path Loss = 20*log10(4*pi*d*f/c)
        var c_speed = 299792458;
        var fspl_db = 20 * Math.log10(4 * Math.PI * range_m * freq_hz / c_speed);
        if (isNaN(fspl_db) || !isFinite(fspl_db)) fspl_db = 0;

        var rx_gain = c.antenna_gain_dbi || 0;
        var rx_sensitivity = c.receiver_sensitivity_dbm || -100;

        // Received power in dBm (convert EIRP from dBW to dBm: +30)
        var rx_power_dbm = (eirp_dbw + 30) - fspl_db + rx_gain;
        var margin_db = rx_power_dbm - rx_sensitivity;

        var marginColor = margin_db >= 10 ? '#44ff88' : margin_db >= 3 ? '#ffcc44' : '#ff4444';
        var marginLabel = margin_db >= 10 ? 'GOOD' : margin_db >= 3 ? 'MARGINAL' : 'INSUFFICIENT';

        el.innerHTML =
            '<div class="cd-budget-title">LINK BUDGET</div>' +
            '<div class="cd-budget-row"><span>EIRP</span><span>' + eirp_dbw.toFixed(1) + ' dBW</span></div>' +
            '<div class="cd-budget-row"><span>FSPL @ max range</span><span>' + fspl_db.toFixed(1) + ' dB</span></div>' +
            '<div class="cd-budget-row"><span>Rx Power</span><span>' + rx_power_dbm.toFixed(1) + ' dBm</span></div>' +
            '<div class="cd-budget-row"><span>Rx Sensitivity</span><span>' + rx_sensitivity.toFixed(1) + ' dBm</span></div>' +
            '<div class="cd-budget-row cd-budget-margin" style="color:' + marginColor + '">' +
                '<span>Link Margin</span><span>' + margin_db.toFixed(1) + ' dB (' + marginLabel + ')</span>' +
            '</div>' +
            '<div class="cd-budget-row"><span>Total Links</span><span>' + linkCount + '</span></div>' +
            '<div class="cd-budget-row"><span>Aggregate BW</span><span>' + (linkCount * (c.bandwidth_mbps || 0)).toFixed(1) + ' Mbps</span></div>';
    }

    // =========================================================================
    // Force-Directed Layout
    // =========================================================================

    function _runForceLayout() {
        var net = _getNetwork(_selectedNetworkId);
        if (!net || net.members.length < 2) return;

        _stopForceLayout();

        var container = document.getElementById('cd-canvas-container');
        var w = container ? container.clientWidth : 600;
        var h = container ? container.clientHeight : 400;
        var cx = w / 2;
        var cy = h / 2;

        // Initialize any missing positions
        _initNodePositions(net);

        _forceIterations = 0;
        var maxIterations = 100;
        var links = _computeLinks(net);

        _forceTimer = setInterval(function() {
            _forceIterations++;
            if (_forceIterations > maxIterations) {
                _stopForceLayout();
                return;
            }

            var alpha = 1 - (_forceIterations / maxIterations);
            alpha = Math.max(0.01, alpha);

            var forces = {};
            net.members.forEach(function(m) {
                forces[m] = { fx: 0, fy: 0 };
            });

            // Repulsion between all nodes
            var repulseK = 8000;
            for (var i = 0; i < net.members.length; i++) {
                for (var j = i + 1; j < net.members.length; j++) {
                    var a = net.members[i];
                    var b = net.members[j];
                    var pa = _nodePositions[a];
                    var pb = _nodePositions[b];
                    if (!pa || !pb) continue;
                    var dx = pa.x - pb.x;
                    var dy = pa.y - pb.y;
                    var dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 1) dist = 1;
                    var f = repulseK / (dist * dist);
                    var ux = dx / dist;
                    var uy = dy / dist;
                    forces[a].fx += ux * f;
                    forces[a].fy += uy * f;
                    forces[b].fx -= ux * f;
                    forces[b].fy -= uy * f;
                }
            }

            // Attraction along links
            var attractK = 0.05;
            var targetLen = 120;
            links.forEach(function(link) {
                var pa = _nodePositions[link.from];
                var pb = _nodePositions[link.to];
                if (!pa || !pb) return;
                var dx = pb.x - pa.x;
                var dy = pb.y - pa.y;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1) dist = 1;
                var f = attractK * (dist - targetLen);
                var ux = dx / dist;
                var uy = dy / dist;
                forces[link.from].fx += ux * f;
                forces[link.from].fy += uy * f;
                forces[link.to].fx -= ux * f;
                forces[link.to].fy -= uy * f;
            });

            // Center gravity
            var gravK = 0.01;
            net.members.forEach(function(m) {
                var p = _nodePositions[m];
                if (!p) return;
                forces[m].fx += (cx - p.x) * gravK;
                forces[m].fy += (cy - p.y) * gravK;
            });

            // Apply forces
            var padding = 40;
            net.members.forEach(function(m) {
                var p = _nodePositions[m];
                if (!p) return;
                var f = forces[m];
                p.x += f.fx * alpha;
                p.y += f.fy * alpha;
                p.x = Math.max(padding, Math.min(w - padding, p.x));
                p.y = Math.max(padding, Math.min(h - padding, p.y));
            });

            _drawSvg(net, container);
        }, 30);
    }

    function _stopForceLayout() {
        if (_forceTimer) {
            clearInterval(_forceTimer);
            _forceTimer = null;
        }
    }

    function _zoomToFit() {
        var net = _getNetwork(_selectedNetworkId);
        if (!net || net.members.length === 0) return;

        var container = document.getElementById('cd-canvas-container');
        var w = container ? container.clientWidth : 600;
        var h = container ? container.clientHeight : 400;

        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        net.members.forEach(function(m) {
            var p = _nodePositions[m];
            if (!p) return;
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        });

        if (!isFinite(minX)) return;

        var contentW = maxX - minX || 1;
        var contentH = maxY - minY || 1;
        var padding = 80;
        var scaleX = (w - 2 * padding) / contentW;
        var scaleY = (h - 2 * padding) / contentH;
        var scale = Math.min(scaleX, scaleY, 2.0);

        var centerContentX = (minX + maxX) / 2;
        var centerContentY = (minY + maxY) / 2;

        net.members.forEach(function(m) {
            var p = _nodePositions[m];
            if (!p) return;
            p.x = w / 2 + (p.x - centerContentX) * scale;
            p.y = h / 2 + (p.y - centerContentY) * scale;
        });

        _renderCanvas();
    }

    // =========================================================================
    // Summary Bar
    // =========================================================================

    function _updateSummary() {
        var netsEl = document.getElementById('cd-sum-nets');
        var linksEl = document.getElementById('cd-sum-links');
        var bwEl = document.getElementById('cd-sum-bw');
        var entsEl = document.getElementById('cd-sum-ents');

        if (netsEl) netsEl.textContent = _networks.length;
        if (linksEl) linksEl.textContent = _countTotalLinks();
        if (bwEl) bwEl.textContent = _formatBandwidth(_countTotalBandwidth());
        if (entsEl) entsEl.textContent = _countUniqueEntities();
    }

    function _formatBandwidth(mbps) {
        if (mbps >= 1000) return (mbps / 1000).toFixed(1) + ' Gbps';
        return mbps.toFixed(1) + ' Mbps';
    }

    // =========================================================================
    // Canvas Status Bar
    // =========================================================================

    function _updateCanvasStatus(msg) {
        var titleEl = document.getElementById('cd-canvas-title');
        if (!titleEl) return;
        var net = _getNetwork(_selectedNetworkId);
        var baseTitle = net ? (net.name + ' (' + NETWORK_TYPE_LABELS[net.type] + ')') : 'No network selected';
        if (msg) {
            titleEl.textContent = baseTitle + '  --  ' + msg;
        } else {
            titleEl.textContent = baseTitle;
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _isNetworkId(id) {
        return _networks.some(function(n) { return n.id === id; });
    }

    function _getMemberInfo(memberId) {
        // Check networks first
        for (var i = 0; i < _networks.length; i++) {
            if (_networks[i].id === memberId) {
                return {
                    name: _networks[i].name,
                    type: 'network',
                    team: 'neutral',
                    teamColor: '#aa66ff'
                };
            }
        }
        // Check entities
        for (var j = 0; j < _entities.length; j++) {
            if (_entities[j].id === memberId) {
                return {
                    name: _entities[j].name,
                    type: _entities[j].type,
                    team: _entities[j].team,
                    teamColor: TEAM_COLORS[_entities[j].team] || '#888'
                };
            }
        }
        return { name: memberId, type: 'unknown', team: 'neutral', teamColor: '#888' };
    }

    function _wouldCreateCycle(parentNetId, childNetId) {
        // BFS to check if childNetId contains parentNetId anywhere in its tree
        var visited = {};
        var queue = [childNetId];
        while (queue.length > 0) {
            var current = queue.shift();
            if (current === parentNetId) return true;
            if (visited[current]) continue;
            visited[current] = true;
            var net = _getNetwork(current);
            if (net) {
                net.members.forEach(function(m) {
                    if (_isNetworkId(m) && !visited[m]) {
                        queue.push(m);
                    }
                });
            }
        }
        return false;
    }

    function _cloneObj(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    function _escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    function _escapeAttr(str) {
        return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function _truncate(str, maxLen) {
        if (!str) return '';
        if (str.length <= maxLen) return str;
        return str.substring(0, maxLen - 1) + '\u2026';
    }

    function _showToast(msg) {
        // Use BuilderApp showMessage if available, otherwise console
        if (typeof BuilderApp !== 'undefined' && BuilderApp.showMessage) {
            BuilderApp.showMessage(msg, 3000);
        } else {
            console.log('[CommDesigner] ' + msg);
        }
    }

    // =========================================================================
    // Storage Persistence
    // =========================================================================

    function _loadFromStorage() {
        try {
            var stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                var data = JSON.parse(stored);
                if (Array.isArray(data)) {
                    _networks = data;
                    // Update _nextNetId to avoid collisions
                    _networks.forEach(function(n) {
                        var match = n.id && n.id.match(/net_(\d+)/);
                        if (match) {
                            var num = parseInt(match[1]);
                            if (num >= _nextNetId) _nextNetId = num + 1;
                        }
                    });
                    console.log('[CommDesigner] Loaded ' + _networks.length + ' networks from storage');
                }
            }
        } catch (e) {
            console.warn('[CommDesigner] Failed to load from storage:', e);
        }
    }

    function _saveToStorage() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(_networks));
        } catch (e) {
            console.warn('[CommDesigner] Failed to save to storage:', e);
        }
    }

    // =========================================================================
    // Public API: getNetworks / setNetworks
    // =========================================================================

    function getNetworks() {
        return _cloneObj(_networks);
    }

    function setNetworks(networks) {
        if (!Array.isArray(networks)) return;
        _networks = _cloneObj(networks);
        // Update _nextNetId
        _networks.forEach(function(n) {
            var match = n.id && n.id.match(/net_(\d+)/);
            if (match) {
                var num = parseInt(match[1]);
                if (num >= _nextNetId) _nextNetId = num + 1;
            }
        });
        _saveToStorage();
    }

    function addEntity(entityDef) {
        if (!entityDef || !entityDef.id) return;
        var exists = _entities.some(function(e) { return e.id === entityDef.id; });
        if (!exists) {
            _entities.push({
                id: entityDef.id,
                name: entityDef.name || entityDef.id,
                type: entityDef.type || 'unknown',
                team: entityDef.team || 'neutral'
            });
        }
    }

    function removeEntity(entityId) {
        _entities = _entities.filter(function(e) { return e.id !== entityId; });
        // Remove from all networks
        _networks.forEach(function(net) {
            net.members = net.members.filter(function(m) { return m !== entityId; });
            if (net.hub === entityId) net.hub = null;
            if (net.path) net.path = net.path.filter(function(p) { return p !== entityId; });
            if (net.links) net.links = net.links.filter(function(l) { return l.from !== entityId && l.to !== entityId; });
        });
    }

    // =========================================================================
    // Styles
    // =========================================================================

    function _injectStyles() {
        if (document.getElementById('comm-designer-styles')) return;

        var style = document.createElement('style');
        style.id = 'comm-designer-styles';
        style.textContent = [
            // Overlay
            '.cd-overlay {',
            '    position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
            '    background: rgba(0,0,0,0.75); z-index: 10000;',
            '    display: flex; align-items: center; justify-content: center;',
            '}',

            // Modal
            '.cd-modal {',
            '    background: #0d1a2a; border: 1px solid #1a2a44; border-radius: 8px;',
            '    width: 95vw; max-width: 1400px; height: 85vh; max-height: 900px;',
            '    display: flex; flex-direction: column; color: #e0e8f0;',
            '    font-family: "Courier New", monospace; font-size: 12px;',
            '    box-shadow: 0 8px 32px rgba(0,0,0,0.6);',
            '}',

            // Header
            '.cd-header {',
            '    display: flex; align-items: center; justify-content: space-between;',
            '    padding: 10px 16px; background: #0a1520; border-bottom: 1px solid #1a2a44;',
            '    border-radius: 8px 8px 0 0;',
            '}',
            '.cd-header-title {',
            '    font-size: 13px; font-weight: bold; letter-spacing: 1px; color: #4a9eff;',
            '}',
            '.cd-header-close {',
            '    background: none; border: none; color: #5a7a9a; font-size: 20px;',
            '    cursor: pointer; padding: 0 4px; line-height: 1;',
            '}',
            '.cd-header-close:hover { color: #ff4444; }',

            // Body: 3-panel layout
            '.cd-body {',
            '    display: flex; flex: 1; min-height: 0; overflow: hidden;',
            '}',

            // Panels
            '.cd-panel { display: flex; flex-direction: column; overflow: hidden; }',
            '.cd-panel-left {',
            '    width: 240px; min-width: 200px; border-right: 1px solid #1a2a44;',
            '    background: #0a1520;',
            '}',
            '.cd-panel-center {',
            '    flex: 1; min-width: 300px; position: relative; background: #080e18;',
            '}',
            '.cd-panel-right {',
            '    width: 300px; min-width: 260px; border-left: 1px solid #1a2a44;',
            '    background: #0a1520; overflow-y: auto;',
            '}',

            // Panel headers
            '.cd-panel-header {',
            '    padding: 8px 12px; font-size: 10px; font-weight: bold;',
            '    color: #5a7a9a; text-transform: uppercase; letter-spacing: 1px;',
            '    border-bottom: 1px solid #1a2a44; background: #0c1828;',
            '}',
            '.cd-panel-divider { height: 1px; background: #1a2a44; }',

            // Search bar
            '.cd-search-bar { padding: 6px 8px; border-bottom: 1px solid #1a2a44; }',
            '.cd-search-bar input {',
            '    width: 100%; box-sizing: border-box; background: #0d1a2a;',
            '    border: 1px solid #1a2a44; color: #a0b0c8; padding: 5px 8px;',
            '    border-radius: 3px; font-family: "Courier New", monospace; font-size: 11px;',
            '}',
            '.cd-search-bar input::placeholder { color: #3a5a7a; }',

            // Bulk action bar
            '.cd-bulk-bar {',
            '    padding: 4px 6px; border-bottom: 1px solid #1a2a44; background: #0c1828;',
            '}',
            '.cd-bulk-row {',
            '    display: flex; gap: 4px; margin-bottom: 3px;',
            '}',
            '.cd-bulk-row:last-child { margin-bottom: 0; }',
            '.cd-bulk-btn {',
            '    flex-shrink: 0; padding: 3px 8px; font-size: 10px; cursor: pointer;',
            '    background: #0d1a2a; border: 1px solid #1a2a44; color: #5a7a9a;',
            '    border-radius: 3px; font-family: "Courier New", monospace;',
            '}',
            '.cd-bulk-btn:hover { background: #1a2a44; color: #a0b0c8; }',
            '.cd-bulk-btn:disabled { opacity: 0.4; cursor: default; }',
            '.cd-bulk-add {',
            '    flex: 1; background: #1a3a2a; color: #44ff88; border-color: #2a5a3a;',
            '}',
            '.cd-bulk-add:hover:not(:disabled) { background: #2a5a3a; }',
            '.cd-bulk-select {',
            '    flex: 1; padding: 3px 4px; font-size: 10px;',
            '    background: #0d1a2a; border: 1px solid #1a2a44; color: #5a7a9a;',
            '    border-radius: 3px; font-family: "Courier New", monospace;',
            '}',

            // Entity group headers
            '.cd-entity-group-header {',
            '    display: flex; align-items: center; justify-content: space-between;',
            '    padding: 4px 8px; background: #0c1828; border-bottom: 1px solid #1a2a44;',
            '    margin-top: 2px;',
            '}',
            '.cd-entity-group-label {',
            '    font-size: 9px; color: #5a7a9a; font-weight: bold; letter-spacing: 0.5px;',
            '}',
            '.cd-entity-group-add-all {',
            '    background: none; border: 1px solid #1a2a44; color: #4a9eff;',
            '    font-size: 9px; padding: 1px 6px; border-radius: 3px; cursor: pointer;',
            '    font-family: "Courier New", monospace;',
            '}',
            '.cd-entity-group-add-all:hover { background: #1a2a44; }',

            // Entity list
            '.cd-entity-list {',
            '    flex: 1; overflow-y: auto; padding: 4px;',
            '}',
            '.cd-entity-card {',
            '    display: flex; align-items: center; gap: 6px; padding: 5px 6px;',
            '    border: 1px solid transparent; border-radius: 4px; cursor: pointer;',
            '    margin-bottom: 1px; transition: background 0.15s;',
            '}',
            '.cd-entity-card:hover { background: #1a2a44; border-color: #2a4a6a; }',
            '.cd-entity-card-selected {',
            '    background: #1a2a44; border-color: #4a9eff;',
            '}',
            '.cd-entity-checkbox {',
            '    flex-shrink: 0; display: flex; align-items: center;',
            '}',
            '.cd-entity-checkbox input {',
            '    margin: 0; accent-color: #4a9eff; pointer-events: none;',
            '}',
            '.cd-entity-dot {',
            '    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;',
            '}',
            '.cd-entity-info { min-width: 0; flex: 1; }',
            '.cd-entity-name {',
            '    font-size: 11px; color: #e0e8f0; white-space: nowrap;',
            '    overflow: hidden; text-overflow: ellipsis;',
            '}',
            '.cd-entity-in-net {',
            '    font-size: 8px; color: #44ff88; background: #1a3a2a;',
            '    padding: 0 4px; border-radius: 2px; margin-left: 4px;',
            '}',
            '.cd-entity-type { font-size: 9px; color: #5a7a9a; text-transform: uppercase; }',
            '.cd-entity-empty {',
            '    padding: 12px; color: #3a5a7a; font-size: 11px; text-align: center;',
            '    font-style: italic;',
            '}',

            // Saved network list
            '.cd-network-list { flex: 1; overflow-y: auto; padding: 4px; }',
            '.cd-network-item {',
            '    display: flex; align-items: center; gap: 8px; padding: 6px 8px;',
            '    border: 1px solid transparent; border-radius: 4px; cursor: pointer;',
            '    margin-bottom: 2px; transition: background 0.15s;',
            '}',
            '.cd-network-item:hover { background: #1a2a44; }',
            '.cd-network-item-selected {',
            '    background: #1a2a44; border-color: #4a9eff;',
            '}',
            '.cd-network-icon {',
            '    width: 28px; height: 28px; border: 2px solid #4a9eff;',
            '    border-radius: 6px; display: flex; align-items: center;',
            '    justify-content: center; flex-shrink: 0; background: #0d1a2a;',
            '}',
            '.cd-network-type-badge { font-size: 14px; font-weight: bold; }',
            '.cd-network-info { flex: 1; min-width: 0; }',
            '.cd-network-name {',
            '    font-size: 11px; color: #e0e8f0; white-space: nowrap;',
            '    overflow: hidden; text-overflow: ellipsis;',
            '}',
            '.cd-network-meta { font-size: 9px; color: #5a7a9a; }',
            '.cd-network-actions { display: flex; gap: 4px; }',
            '.cd-network-action-btn {',
            '    background: none; border: 1px solid #1a2a44; color: #5a7a9a;',
            '    width: 22px; height: 22px; border-radius: 3px; cursor: pointer;',
            '    font-size: 11px; display: flex; align-items: center; justify-content: center;',
            '    padding: 0;',
            '}',
            '.cd-network-action-btn:hover { background: #1a2a44; color: #a0b0c8; }',

            // Panel actions
            '.cd-panel-actions { padding: 8px; border-top: 1px solid #1a2a44; }',

            // Buttons
            '.cd-btn {',
            '    padding: 7px 16px; border-radius: 4px; font-size: 11px; cursor: pointer;',
            '    border: 1px solid #1a2a44; font-family: "Courier New", monospace;',
            '    letter-spacing: 0.5px;',
            '}',
            '.cd-btn-primary { background: #1a3a5a; color: #4a9eff; width: 100%; }',
            '.cd-btn-primary:hover { background: #2a4a6a; }',
            '.cd-btn-cancel { background: #1a2a3a; color: #a0b0c8; }',
            '.cd-btn-cancel:hover { background: #2a3a4a; }',
            '.cd-btn-confirm { background: #1a4a2a; color: #44ff88; }',
            '.cd-btn-confirm:hover { background: #2a5a3a; }',

            // Canvas toolbar
            '.cd-canvas-toolbar {',
            '    display: flex; align-items: center; justify-content: space-between;',
            '    padding: 6px 12px; background: #0c1828; border-bottom: 1px solid #1a2a44;',
            '}',
            '.cd-canvas-title {',
            '    font-size: 11px; color: #a0b0c8; font-weight: bold;',
            '}',
            '.cd-canvas-tools { display: flex; gap: 4px; }',
            '.cd-tool-btn {',
            '    background: #0d1a2a; border: 1px solid #1a2a44; color: #5a7a9a;',
            '    width: 28px; height: 28px; border-radius: 4px; cursor: pointer;',
            '    font-size: 14px; display: flex; align-items: center; justify-content: center;',
            '    padding: 0;',
            '}',
            '.cd-tool-btn:hover { background: #1a2a44; color: #a0b0c8; }',
            '.cd-tool-active { background: #1a3a5a; border-color: #4a9eff; color: #4a9eff; }',
            '.cd-tool-danger:hover { color: #ff4444; border-color: #ff4444; }',

            // Canvas container
            '.cd-canvas-container {',
            '    flex: 1; position: relative; overflow: hidden;',
            '}',
            '.cd-canvas-empty {',
            '    position: absolute; top: 0; left: 0; right: 0; bottom: 0;',
            '    display: flex; flex-direction: column; align-items: center;',
            '    justify-content: center; color: #2a4a6a;',
            '}',
            '.cd-canvas-empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }',
            '.cd-canvas-empty-text { font-size: 12px; text-align: center; max-width: 300px; }',

            // Properties panel
            '.cd-props-content { padding: 10px 12px; }',
            '.cd-props-empty {',
            '    padding: 24px 12px; color: #3a5a7a; font-size: 11px;',
            '    text-align: center; font-style: italic;',
            '}',
            '.cd-prop-group { margin-bottom: 10px; }',
            '.cd-prop-label {',
            '    display: block; font-size: 10px; color: #5a7a9a;',
            '    text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px;',
            '}',
            '.cd-prop-hint {',
            '    font-size: 10px; color: #3a5a7a; margin-top: 3px; font-style: italic;',
            '}',
            '.cd-prop-input {',
            '    width: 100%; box-sizing: border-box; background: #0d1a2a;',
            '    border: 1px solid #1a2a44; color: #a0d0ff; padding: 5px 8px;',
            '    border-radius: 3px; font-family: "Courier New", monospace; font-size: 11px;',
            '}',
            '.cd-prop-select {',
            '    width: 100%; box-sizing: border-box; background: #0d1a2a;',
            '    border: 1px solid #1a2a44; color: #a0d0ff; padding: 5px 8px;',
            '    border-radius: 3px; font-family: "Courier New", monospace; font-size: 11px;',
            '}',
            '.cd-prop-range {',
            '    width: calc(100% - 40px); accent-color: #4a9eff; vertical-align: middle;',
            '}',
            '.cd-prop-range-value {',
            '    display: inline-block; width: 30px; text-align: center;',
            '    color: #4a9eff; font-weight: bold;',
            '}',
            '.cd-prop-divider { height: 1px; background: #1a2a44; margin: 12px 0; }',

            // Members list in properties
            '.cd-prop-members {',
            '    max-height: 140px; overflow-y: auto; background: #080e18;',
            '    border: 1px solid #1a2a44; border-radius: 4px; padding: 4px;',
            '}',
            '.cd-prop-member-item {',
            '    display: flex; align-items: center; gap: 6px; padding: 3px 6px;',
            '    font-size: 11px; border: 1px solid transparent; border-radius: 3px;',
            '}',
            '.cd-prop-member-draggable {',
            '    cursor: grab; transition: background 0.15s;',
            '}',
            '.cd-prop-member-draggable:hover { background: #1a2a44; }',
            '.cd-prop-member-dragging { opacity: 0.4; }',
            '.cd-prop-member-dragover { border-color: #4a9eff; background: #1a2a44; }',
            '.cd-prop-member-grip {',
            '    color: #3a5a7a; font-size: 10px; cursor: grab; flex-shrink: 0;',
            '}',
            '.cd-prop-member-dot {',
            '    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;',
            '}',
            '.cd-prop-member-name { color: #a0b0c8; flex: 1; min-width: 0;',
            '    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
            '.cd-prop-member-order {',
            '    font-size: 9px; color: #44ff88; flex-shrink: 0;',
            '}',
            '.cd-prop-member-remove {',
            '    background: none; border: none; color: #5a7a9a; cursor: pointer;',
            '    font-size: 14px; padding: 0 2px; line-height: 1; flex-shrink: 0;',
            '}',
            '.cd-prop-member-remove:hover { color: #ff4444; }',
            '.cd-prop-member-empty {',
            '    padding: 8px; color: #3a5a7a; font-size: 10px; text-align: center;',
            '    font-style: italic;',
            '}',
            '.cd-prop-hub-badge {',
            '    font-size: 9px; color: #ffcc44; font-weight: bold;',
            '    background: #2a2a1a; padding: 1px 5px; border-radius: 3px;',
            '    flex-shrink: 0;',
            '}',

            // Fields grid
            '.cd-prop-fields-grid {',
            '    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px;',
            '    margin: 8px 0;',
            '}',
            '.cd-prop-field { }',
            '.cd-prop-field-label {',
            '    display: block; font-size: 9px; color: #5a7a9a; margin-bottom: 2px;',
            '}',
            '.cd-prop-field-input {',
            '    width: 100%; box-sizing: border-box; font-size: 11px;',
            '}',

            // Link budget summary
            '.cd-link-budget-summary {',
            '    background: #080e18; border: 1px solid #1a2a44; border-radius: 4px;',
            '    padding: 8px 10px;',
            '}',
            '.cd-budget-title {',
            '    font-size: 10px; font-weight: bold; color: #4a9eff;',
            '    margin-bottom: 6px; text-transform: uppercase;',
            '}',
            '.cd-budget-row {',
            '    display: flex; justify-content: space-between; padding: 2px 0;',
            '    font-size: 10px; color: #a0b0c8;',
            '}',
            '.cd-budget-margin {',
            '    font-weight: bold; border-top: 1px solid #1a2a44;',
            '    margin-top: 4px; padding-top: 4px;',
            '}',

            // Context menu
            '.cd-context-menu {',
            '    position: fixed; background: #0d1a2a; border: 1px solid #1a2a44;',
            '    border-radius: 4px; min-width: 180px; z-index: 10001;',
            '    box-shadow: 0 4px 16px rgba(0,0,0,0.5); padding: 4px 0;',
            '}',
            '.cd-ctx-header {',
            '    padding: 6px 12px; font-size: 10px; color: #5a7a9a;',
            '    border-bottom: 1px solid #1a2a44; font-weight: bold;',
            '    text-transform: uppercase;',
            '}',
            '.cd-ctx-item {',
            '    padding: 6px 12px; font-size: 11px; color: #a0b0c8; cursor: pointer;',
            '}',
            '.cd-ctx-item:hover { background: #1a2a44; }',
            '.cd-ctx-danger { color: #ff4444; }',
            '.cd-ctx-danger:hover { background: #2a1a1a; }',

            // Footer
            '.cd-footer {',
            '    display: flex; align-items: center; justify-content: space-between;',
            '    padding: 8px 16px; background: #0a1520; border-top: 1px solid #1a2a44;',
            '    border-radius: 0 0 8px 8px;',
            '}',
            '.cd-summary { display: flex; gap: 20px; }',
            '.cd-summary-item { font-size: 10px; color: #5a7a9a; }',
            '.cd-summary-item strong { color: #4a9eff; }',
            '.cd-footer-actions { display: flex; gap: 8px; }',

            // Scrollbar styling
            '.cd-panel-left::-webkit-scrollbar, .cd-panel-right::-webkit-scrollbar,',
            '.cd-entity-list::-webkit-scrollbar, .cd-network-list::-webkit-scrollbar,',
            '.cd-prop-members::-webkit-scrollbar {',
            '    width: 6px;',
            '}',
            '.cd-panel-left::-webkit-scrollbar-track, .cd-panel-right::-webkit-scrollbar-track,',
            '.cd-entity-list::-webkit-scrollbar-track, .cd-network-list::-webkit-scrollbar-track,',
            '.cd-prop-members::-webkit-scrollbar-track {',
            '    background: transparent;',
            '}',
            '.cd-panel-left::-webkit-scrollbar-thumb, .cd-panel-right::-webkit-scrollbar-thumb,',
            '.cd-entity-list::-webkit-scrollbar-thumb, .cd-network-list::-webkit-scrollbar-thumb,',
            '.cd-prop-members::-webkit-scrollbar-thumb {',
            '    background: #1a2a44; border-radius: 3px;',
            '}',

            // SVG styles via CSS
            '.cd-nodes-group g:hover circle,',
            '.cd-nodes-group g:hover polygon {',
            '    stroke-width: 3;',
            '    filter: url(#cd-glow);',
            '}',

            ''
        ].join('\n');

        document.head.appendChild(style);
    }

    // =========================================================================
    // Expose Public API
    // =========================================================================

    window.CommDesigner = {
        init:          init,
        open:          open,
        close:         close,
        getNetworks:   getNetworks,
        setNetworks:   setNetworks,
        addEntity:     addEntity,
        removeEntity:  removeEntity
    };

})();
