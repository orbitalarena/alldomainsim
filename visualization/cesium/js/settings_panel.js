/**
 * SettingsPanel - Tabbed settings panel replacing the cluttered gear dropdown.
 *
 * Tabs:
 *   1. Panels    - Flight data, systems, orbital, entity list, status, tools
 *   2. HUD       - All HUD element toggles, brightness
 *   3. Orbits    - Orbit traces, trails, revolutions, entity display
 *   4. Tools     - Search, analytics, comms, cyber, combat, exports
 *   5. Layout    - Window layout presets, reset, save
 *
 * Reads/writes the same data-* attributes as the old dropdown for backwards compat.
 */
var SettingsPanel = (function() {
    'use strict';

    var _panel = null;
    var _activeTab = 'panels';
    var _isOpen = false;
    var _callbacks = {};  // event handlers

    // Tab definitions
    var TABS = [
        { id: 'panels',  label: 'PANELS',  icon: '\u25a3' },
        { id: 'hud',     label: 'HUD',     icon: '\u25c9' },
        { id: 'orbits',  label: 'ORBITS',  icon: '\u25ef' },
        { id: 'tools',   label: 'TOOLS',   icon: '\u2692' },
        { id: 'layout',  label: 'LAYOUT',  icon: '\u2b1a' }
    ];

    function init(callbacks) {
        _callbacks = callbacks || {};
        _buildPanel();
        _attachToGear();
    }

    function toggle() {
        _isOpen = !_isOpen;
        if (_panel) {
            _panel.style.display = _isOpen ? 'block' : 'none';
        }
        var btn = document.getElementById('settingsBtn');
        if (btn) btn.classList.toggle('open', _isOpen);
        if (_isOpen) syncAll();
    }

    function close() {
        _isOpen = false;
        if (_panel) _panel.style.display = 'none';
        var btn = document.getElementById('settingsBtn');
        if (btn) btn.classList.remove('open');
    }

    function isOpen() { return _isOpen; }

    function syncAll() {
        _syncTab(_activeTab);
    }

    // -----------------------------------------------------------------------
    // Build the panel
    // -----------------------------------------------------------------------

    function _buildPanel() {
        // Hide old dropdown
        var oldDropdown = document.getElementById('settingsDropdown');
        if (oldDropdown) oldDropdown.style.display = 'none';

        _panel = document.createElement('div');
        _panel.id = 'settingsTabbedPanel';
        _panel.style.cssText = [
            'position:absolute; top:44px; left:10px;',
            'background:rgba(8,12,8,0.95);',
            'border:1px solid #00aa00; border-radius:6px;',
            'z-index:35; display:none;',
            'width:320px; max-height:calc(100vh - 60px);',
            'font-family:"Courier New",monospace; font-size:11px;',
            'color:#00aa00; overflow:hidden;',
            'box-shadow: 0 4px 20px rgba(0,0,0,0.6);'
        ].join('');

        // Tab bar
        var tabBar = document.createElement('div');
        tabBar.className = 'sp-tabbar';
        tabBar.style.cssText = 'display:flex; border-bottom:1px solid #004400; background:rgba(0,20,0,0.5);';

        for (var i = 0; i < TABS.length; i++) {
            var tab = TABS[i];
            var tabBtn = document.createElement('div');
            tabBtn.className = 'sp-tab' + (tab.id === _activeTab ? ' sp-tab-active' : '');
            tabBtn.setAttribute('data-tab', tab.id);
            tabBtn.style.cssText = [
                'flex:1; padding:8px 4px; text-align:center; cursor:pointer;',
                'font-size:9px; letter-spacing:1px; color:#006600;',
                'transition: color 0.1s, background 0.1s; user-select:none;',
                'border-bottom:2px solid transparent;'
            ].join('');
            if (tab.id === _activeTab) {
                tabBtn.style.color = '#00ff00';
                tabBtn.style.borderBottomColor = '#00ff00';
                tabBtn.style.background = 'rgba(0,40,0,0.4)';
            }
            tabBtn.innerHTML = '<div style="font-size:14px;margin-bottom:2px">' + tab.icon + '</div>' + tab.label;
            tabBtn.addEventListener('click', _onTabClick);
            tabBtn.addEventListener('mouseenter', function() {
                if (!this.classList.contains('sp-tab-active')) {
                    this.style.color = '#00aa00';
                    this.style.background = 'rgba(0,30,0,0.3)';
                }
            });
            tabBtn.addEventListener('mouseleave', function() {
                if (!this.classList.contains('sp-tab-active')) {
                    this.style.color = '#006600';
                    this.style.background = '';
                }
            });
            tabBar.appendChild(tabBtn);
        }
        _panel.appendChild(tabBar);

        // Content area
        var content = document.createElement('div');
        content.id = 'sp-content';
        content.style.cssText = 'padding:8px 0; max-height:calc(100vh - 120px); overflow-y:auto; scrollbar-width:thin; scrollbar-color:#005500 transparent;';
        _panel.appendChild(content);

        document.body.appendChild(_panel);

        // Close on click outside
        document.addEventListener('click', function(e) {
            if (!_isOpen) return;
            if (_panel.contains(e.target)) return;
            var btn = document.getElementById('settingsBtn');
            if (btn && btn.contains(e.target)) return;
            close();
        });

        // Build initial tab content
        _renderTab(_activeTab);
    }

    function _onTabClick(e) {
        var tabId = this.getAttribute('data-tab');
        if (tabId === _activeTab) return;
        _activeTab = tabId;

        // Update tab bar styling
        var tabs = _panel.querySelectorAll('.sp-tab');
        for (var i = 0; i < tabs.length; i++) {
            var isActive = tabs[i].getAttribute('data-tab') === tabId;
            tabs[i].classList.toggle('sp-tab-active', isActive);
            tabs[i].style.color = isActive ? '#00ff00' : '#006600';
            tabs[i].style.borderBottomColor = isActive ? '#00ff00' : 'transparent';
            tabs[i].style.background = isActive ? 'rgba(0,40,0,0.4)' : '';
        }

        _renderTab(tabId);
    }

    function _attachToGear() {
        var btn = document.getElementById('settingsBtn');
        if (!btn) return;
        // Remove old click handlers by cloning
        var newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            toggle();
        });
    }

    // -----------------------------------------------------------------------
    // Tab Rendering
    // -----------------------------------------------------------------------

    function _renderTab(tabId) {
        var content = document.getElementById('sp-content');
        if (!content) return;

        switch(tabId) {
            case 'panels': content.innerHTML = _buildPanelsTab(); break;
            case 'hud':    content.innerHTML = _buildHUDTab(); break;
            case 'orbits': content.innerHTML = _buildOrbitsTab(); break;
            case 'tools':  content.innerHTML = _buildToolsTab(); break;
            case 'layout': content.innerHTML = _buildLayoutTab(); break;
        }

        _attachTabListeners(tabId, content);
        _syncTab(tabId);
    }

    // --- Panels Tab ---
    function _buildPanelsTab() {
        return '' +
            _sectionTitle('Core Panels') +
            _checkItem('flightData', 'Flight Data', '1', 'panel') +
            _checkItem('systems', 'Systems Panel', '2', 'panel') +
            _checkItem('orbital', 'Orbital Elements', 'O', 'panel') +
            _checkItem('entityList', 'Entity List', '3', 'panel') +
            _checkItem('statusBar', 'Status Bar', '', 'panel') +
            _checkItem('help', 'Controls Help', 'H', 'panel') +
            _sep() +
            _sectionTitle('Secondary Panels') +
            _checkItem('autopilot', 'Autopilot', 'A', 'panel', '#00ff88') +
            _checkItem('search', 'Smart Search', 'F', 'panel', '#4a9eff') +
            _checkItem('analytics', 'Analytics Dashboard', '', 'panel', '#44ccff') +
            _checkItem('comm', 'Comm Panel', '', 'panel', '#44ff88') +
            _sep() +
            _sectionTitle('Subsystems') +
            _checkItem('audio', 'Audio Engine', '', 'subsystem') +
            _checkItem('visualfx', 'Visual Effects', '', 'subsystem');
    }

    // --- HUD Tab ---
    function _buildHUDTab() {
        return '' +
            _sectionTitle('HUD Master') +
            _checkItem('hud', 'HUD (master toggle)', '', 'hud') +
            '<div class="sp-row" style="padding:4px 14px;display:flex;align-items:center;gap:8px">' +
                '<span style="color:#006600;font-size:10px;flex:1">Brightness</span>' +
                '<input type="range" id="spHudBrightness" min="30" max="200" value="100" step="5" style="flex:2;accent-color:#00ff00">' +
                '<span id="spHudBrightnessVal" style="color:#00aa00;font-size:10px;width:36px;text-align:right">100%</span>' +
            '</div>' +
            _sep() +
            _sectionTitle('Flight Instruments') +
            _checkItem('speedTape', 'Speed Tape', '', 'hud') +
            _checkItem('altTape', 'Altitude Tape', '', 'hud') +
            _checkItem('heading', 'Heading', '', 'hud') +
            _checkItem('pitchLadder', 'Pitch Ladder', '', 'hud') +
            _checkItem('fpm', 'Flight Path Marker', '', 'hud') +
            _checkItem('gMeter', 'G-Meter', '', 'hud') +
            _sep() +
            _sectionTitle('Systems Display') +
            _checkItem('engineFuel', 'Engine / Fuel', '', 'hud') +
            _checkItem('weapons', 'Weapons / Target', '', 'hud') +
            _checkItem('warnings', 'Warnings / Status', '', 'hud') +
            _sep() +
            _sectionTitle('Navigation') +
            _checkItem('orbital', 'Orbital / Navball', '', 'hud') +
            _checkItem('minimap', 'Minimap Scope', '', 'hud') +
            _checkItem('rwr', 'RWR Display', '', 'hud') +
            _checkItem('coordinates', 'Coordinates', '', 'hud') +
            _checkItem('warpIndicator', 'Time Warp', '', 'hud') +
            _checkItem('approachAids', 'Approach Aids', '', 'hud') +
            _sep() +
            '<div style="display:flex;gap:6px;padding:4px 14px">' +
                '<button class="sp-btn" id="spHudAllOn">All On</button>' +
                '<button class="sp-btn" id="spHudAllOff">All Off</button>' +
            '</div>';
    }

    // --- Orbits Tab ---
    function _buildOrbitsTab() {
        return '' +
            _sectionTitle('Player Orbit Traces') +
            _checkItem('ecef', 'ECEF Orbit (ground track)', '', 'trace') +
            _checkItem('eci', 'ECI Orbit (inertial)', '', 'trace') +
            _checkItem('groundtrack', 'Predicted Ground Track', '', 'trace') +
            '<div class="sp-row" style="padding:4px 14px;display:flex;align-items:center;gap:8px">' +
                '<span style="color:#006600;font-size:10px;flex:1">Revolutions</span>' +
                '<select id="spOrbitRevs" style="background:rgba(0,30,0,0.8);border:1px solid #005500;color:#00ff00;font-family:monospace;font-size:11px;padding:2px 4px;border-radius:2px">' +
                    '<option value="1">1</option><option value="2">2</option><option value="5">5</option><option value="10">10</option><option value="20">20</option>' +
                '</select>' +
            '</div>' +
            _sep() +
            _sectionTitle('History Trail') +
            _checkItem('trail', 'History Trail', '', 'trace') +
            '<div class="sp-row" style="padding:4px 14px;display:flex;align-items:center;gap:8px">' +
                '<span style="color:#006600;font-size:10px;flex:1">Duration (sec, 0=inf)</span>' +
                '<input type="number" id="spTrailDuration" value="0" min="0" step="30" style="width:60px;background:rgba(0,30,0,0.8);border:1px solid #005500;color:#00ff00;font-family:monospace;font-size:11px;padding:2px 4px;border-radius:2px">' +
            '</div>' +
            _sep() +
            _sectionTitle('Entity Display (Global)') +
            _checkItem('globalOrbits', 'All Orbits', '', 'viz') +
            _checkItem('globalTrails', 'All Trails', '', 'viz') +
            _checkItem('globalLabels', 'All Labels', '', 'viz') +
            _checkItem('globalSensors', 'Display Sensors', '', 'viz') +
            _checkItem('globalComms', 'Comm Links', '', 'viz') +
            _sep() +
            _sectionTitle('Viz Groups') +
            '<div id="spVizGroupList"></div>';
    }

    // --- Tools Tab ---
    function _buildToolsTab() {
        return '' +
            _sectionTitle('Tactical') +
            _checkItem('cyber', 'Cyber Terminal', 'Shift+~', 'panel', '#ff8844') +
            _checkItem('cyberLog', 'Cyber Log', 'Shift+C', 'panel', '#ff8844') +
            _checkItem('threats', 'Threat Overlay', 'Shift+T', 'panel', '#ff6644') +
            _checkItem('engagement', 'Combat Stats', '', 'panel', '#ff4466') +
            _checkItem('engTimeline', 'Engagement Timeline', '', 'panel', '#ff8844') +
            _sep() +
            _sectionTitle('Analysis') +
            _checkItem('aar', 'After-Action Report', 'Shift+A', 'panel', '#00ff88') +
            _checkItem('statusboard', 'Status Board', 'Shift+E', 'panel', '#00ff88') +
            _checkItem('dataExport', 'Data Export', '', 'panel', '#44ffaa') +
            _sep() +
            _sectionTitle('Operations') +
            _checkItem('spread', 'Spread Launch', '', 'panel', '#cc88ff') +
            _sep() +
            _sectionTitle('Carrier Operations') +
            '<div class="sp-action-item" id="spCarrierLaunch" style="padding:5px 14px;cursor:pointer;color:#44ccff;transition:background 0.1s">' +
                '<span style="margin-right:8px">&#9992;</span> Launch Aircraft from Carrier' +
            '</div>' +
            '<div class="sp-action-item" id="spSatDeploy" style="padding:5px 14px;cursor:pointer;color:#cc88ff;transition:background 0.1s">' +
                '<span style="margin-right:8px">&#11044;</span> Deploy Sub-Satellite' +
            '</div>';
    }

    // --- Layout Tab ---
    function _buildLayoutTab() {
        return '' +
            _sectionTitle('Window Layout') +
            '<div style="padding:6px 14px;color:#006600;font-size:10px">' +
                'Drag any panel by its title bar to reposition.<br>' +
                'Double-click title bar to collapse.<br>' +
                'Panels snap to edges and each other.' +
            '</div>' +
            _sep() +
            '<div style="display:flex;gap:6px;padding:8px 14px;flex-wrap:wrap">' +
                '<button class="sp-btn sp-btn-primary" id="spLayoutSave">Save Layout</button>' +
                '<button class="sp-btn" id="spLayoutReset">Reset Default</button>' +
            '</div>' +
            _sep() +
            _sectionTitle('Presets') +
            '<div class="sp-action-item" data-layout="combat" style="padding:5px 14px;cursor:pointer;color:#ff6644">' +
                'Combat Layout - HUD + threats + engagement' +
            '</div>' +
            '<div class="sp-action-item" data-layout="orbital" style="padding:5px 14px;cursor:pointer;color:#44ccff">' +
                'Orbital Ops - Orbital elements + orbits + nav' +
            '</div>' +
            '<div class="sp-action-item" data-layout="observer" style="padding:5px 14px;cursor:pointer;color:#00ff88">' +
                'Observer - Entity list + analytics + search' +
            '</div>' +
            '<div class="sp-action-item" data-layout="cyber" style="padding:5px 14px;cursor:pointer;color:#ff8844">' +
                'Cyber Ops - Cyber terminal + comms + threats' +
            '</div>' +
            '<div class="sp-action-item" data-layout="minimal" style="padding:5px 14px;cursor:pointer;color:#00aa00">' +
                'Minimal - HUD only, no panels' +
            '</div>';
    }

    // -----------------------------------------------------------------------
    // HTML Builders
    // -----------------------------------------------------------------------

    function _sectionTitle(text) {
        return '<div style="padding:3px 14px;color:#006600;font-size:10px;text-transform:uppercase;letter-spacing:1px">' + text + '</div>';
    }

    function _sep() {
        return '<div style="height:1px;background:#003300;margin:4px 10px"></div>';
    }

    function _checkItem(key, label, shortcut, type, color) {
        var colorStyle = color ? ' style="color:' + color + '"' : '';
        return '<div class="sp-check-item" data-sp-key="' + key + '" data-sp-type="' + type + '">' +
            '<div class="sp-check"><span class="sp-checkmark">&#10003;</span></div>' +
            '<span class="sp-label"' + colorStyle + '>' + label + '</span>' +
            (shortcut ? '<span class="sp-shortcut">' + shortcut + '</span>' : '') +
        '</div>';
    }

    // -----------------------------------------------------------------------
    // Event Listeners
    // -----------------------------------------------------------------------

    function _attachTabListeners(tabId, content) {
        // Check item toggles
        var items = content.querySelectorAll('.sp-check-item');
        for (var i = 0; i < items.length; i++) {
            items[i].addEventListener('click', _onCheckItemClick);
        }

        // Action items hover
        var actions = content.querySelectorAll('.sp-action-item');
        for (var j = 0; j < actions.length; j++) {
            actions[j].addEventListener('mouseenter', function() { this.style.background = 'rgba(0,60,0,0.5)'; });
            actions[j].addEventListener('mouseleave', function() { this.style.background = ''; });
        }

        if (tabId === 'hud') {
            var brightnessSlider = content.querySelector('#spHudBrightness');
            if (brightnessSlider) {
                brightnessSlider.addEventListener('input', function() {
                    var val = this.value;
                    var valSpan = content.querySelector('#spHudBrightnessVal');
                    if (valSpan) valSpan.textContent = val + '%';
                    if (_callbacks.onHudBrightness) _callbacks.onHudBrightness(parseInt(val));
                });
            }
            var allOnBtn = content.querySelector('#spHudAllOn');
            var allOffBtn = content.querySelector('#spHudAllOff');
            if (allOnBtn) allOnBtn.addEventListener('click', function() {
                if (_callbacks.onHudAllOn) _callbacks.onHudAllOn();
                setTimeout(function() { _syncTab('hud'); }, 50);
            });
            if (allOffBtn) allOffBtn.addEventListener('click', function() {
                if (_callbacks.onHudAllOff) _callbacks.onHudAllOff();
                setTimeout(function() { _syncTab('hud'); }, 50);
            });
        }

        if (tabId === 'orbits') {
            var revSelect = content.querySelector('#spOrbitRevs');
            if (revSelect) {
                revSelect.addEventListener('change', function() {
                    if (_callbacks.onOrbitRevs) _callbacks.onOrbitRevs(parseInt(this.value) || 1);
                });
            }
            var trailInput = content.querySelector('#spTrailDuration');
            if (trailInput) {
                trailInput.addEventListener('change', function() {
                    if (_callbacks.onTrailDuration) _callbacks.onTrailDuration(Math.max(0, parseInt(this.value) || 0));
                });
            }
        }

        if (tabId === 'layout') {
            var saveBtn = content.querySelector('#spLayoutSave');
            var resetBtn = content.querySelector('#spLayoutReset');
            if (saveBtn) saveBtn.addEventListener('click', function() {
                if (typeof WindowManager !== 'undefined') WindowManager.saveLayout();
                if (_callbacks.onShowMessage) _callbacks.onShowMessage('LAYOUT SAVED');
            });
            if (resetBtn) resetBtn.addEventListener('click', function() {
                if (typeof WindowManager !== 'undefined') WindowManager.resetLayout();
                if (_callbacks.onShowMessage) _callbacks.onShowMessage('LAYOUT RESET');
            });

            // Layout presets
            var presetItems = content.querySelectorAll('[data-layout]');
            for (var k = 0; k < presetItems.length; k++) {
                presetItems[k].addEventListener('click', function() {
                    var preset = this.getAttribute('data-layout');
                    if (_callbacks.onLayoutPreset) _callbacks.onLayoutPreset(preset);
                });
            }
        }

        if (tabId === 'tools') {
            var carrierLaunch = content.querySelector('#spCarrierLaunch');
            if (carrierLaunch) carrierLaunch.addEventListener('click', function() {
                if (_callbacks.onCarrierLaunch) _callbacks.onCarrierLaunch();
            });
            var satDeploy = content.querySelector('#spSatDeploy');
            if (satDeploy) satDeploy.addEventListener('click', function() {
                if (_callbacks.onSatDeploy) _callbacks.onSatDeploy();
            });
        }
    }

    function _onCheckItemClick() {
        var key = this.getAttribute('data-sp-key');
        var type = this.getAttribute('data-sp-type');
        if (!key || !type) return;

        if (type === 'panel' && _callbacks.onTogglePanel) _callbacks.onTogglePanel(key);
        else if (type === 'hud' && _callbacks.onToggleHud) _callbacks.onToggleHud(key);
        else if (type === 'trace' && _callbacks.onToggleTrace) _callbacks.onToggleTrace(key);
        else if (type === 'subsystem' && _callbacks.onToggleSubsystem) _callbacks.onToggleSubsystem(key);
        else if (type === 'viz' && _callbacks.onToggleViz) _callbacks.onToggleViz(key);

        // Defer sync to let the callback process
        var self = this;
        setTimeout(function() { _syncTab(_activeTab); }, 30);
    }

    // -----------------------------------------------------------------------
    // Sync State
    // -----------------------------------------------------------------------

    function _syncTab(tabId) {
        var content = document.getElementById('sp-content');
        if (!content) return;

        var items = content.querySelectorAll('.sp-check-item');
        for (var i = 0; i < items.length; i++) {
            var key = items[i].getAttribute('data-sp-key');
            var type = items[i].getAttribute('data-sp-type');
            var isActive = false;

            if (_callbacks.getState) {
                isActive = _callbacks.getState(type, key);
            }

            items[i].classList.toggle('sp-active', isActive);
        }

        // Sync orbit revs
        if (tabId === 'orbits') {
            var revSelect = content.querySelector('#spOrbitRevs');
            if (revSelect && _callbacks.getOrbitRevs) {
                revSelect.value = String(_callbacks.getOrbitRevs());
            }
            var trailInput = content.querySelector('#spTrailDuration');
            if (trailInput && _callbacks.getTrailDuration) {
                trailInput.value = String(_callbacks.getTrailDuration());
            }
            // Viz group list
            var vizGroupList = content.querySelector('#spVizGroupList');
            if (vizGroupList && _callbacks.getVizGroupsHtml) {
                vizGroupList.innerHTML = _callbacks.getVizGroupsHtml();
            }
        }

        // Sync HUD brightness
        if (tabId === 'hud') {
            var brightnessSlider = content.querySelector('#spHudBrightness');
            if (brightnessSlider && _callbacks.getHudBrightness) {
                var val = _callbacks.getHudBrightness();
                brightnessSlider.value = String(val);
                var valSpan = content.querySelector('#spHudBrightnessVal');
                if (valSpan) valSpan.textContent = val + '%';
            }
        }
    }

    // -----------------------------------------------------------------------
    // CSS
    // -----------------------------------------------------------------------
    (function _injectStyles() {
        if (document.getElementById('sp-styles')) return;
        var style = document.createElement('style');
        style.id = 'sp-styles';
        style.textContent = [
            '.sp-check-item {',
            '  display:flex; align-items:center; padding:5px 14px;',
            '  cursor:pointer; color:#00aa00; gap:8px;',
            '  transition:background 0.1s;',
            '}',
            '.sp-check-item:hover { background:rgba(0,60,0,0.5); }',
            '.sp-check {',
            '  width:14px; height:14px;',
            '  border:1px solid #005500; border-radius:2px;',
            '  display:flex; align-items:center; justify-content:center;',
            '  flex-shrink:0; transition:all 0.1s;',
            '}',
            '.sp-checkmark { font-size:11px; color:#00ff00; opacity:0; transition:opacity 0.1s; }',
            '.sp-active .sp-check { border-color:#00ff00; background:rgba(0,100,0,0.4); }',
            '.sp-active .sp-checkmark { opacity:1; }',
            '.sp-label { flex:1; font-size:11px; }',
            '.sp-shortcut { color:#006600; font-size:10px; }',
            '.sp-btn {',
            '  background:rgba(0,40,0,0.8); border:1px solid #005500;',
            '  color:#00cc00; font-family:"Courier New",monospace;',
            '  font-size:10px; padding:5px 12px; border-radius:3px;',
            '  cursor:pointer; transition:all 0.15s;',
            '}',
            '.sp-btn:hover { border-color:#00ff00; color:#00ff00; background:rgba(0,60,0,0.8); }',
            '.sp-btn-primary { border-color:#005588; color:#44aaff; background:rgba(0,30,60,0.8); }',
            '.sp-btn-primary:hover { border-color:#44aaff; color:#88ccff; }',
        ].join('\n');
        document.head.appendChild(style);
    })();

    return {
        init: init,
        toggle: toggle,
        close: close,
        isOpen: isOpen,
        syncAll: syncAll
    };
})();
