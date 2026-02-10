// =========================================================================
// KEYBOARD HELP OVERLAY — Self-contained module for live sim viewer
// =========================================================================
// Displays a full-screen keybinding reference, grouped by category,
// with context-sensitive highlighting based on current sim mode.
// =========================================================================
'use strict';

var KeyboardHelp = (function() {

    // ===================== STATE =====================
    var _visible = false;
    var _mode = 'flight';   // 'flight', 'observer', 'planner', 'ground'
    var _overlay = null;
    var _styleInjected = false;

    // ===================== KEYBINDING DATA =====================
    // Each category has a name, color, and array of bindings.
    // 'modes' indicates which modes highlight this category.
    // If omitted, the category is always active.
    var _categories = [
        {
            name: 'Flight Controls',
            color: '#00ff66',
            modes: ['flight', 'ground'],
            bindings: [
                { key: 'W',           desc: 'Throttle up' },
                { key: 'S',           desc: 'Throttle down' },
                { key: 'Up',          desc: 'Pitch up (nose down)' },
                { key: 'Down',        desc: 'Pitch down (nose up)' },
                { key: 'Left',        desc: 'Roll left' },
                { key: 'Right',       desc: 'Roll right' },
                { key: 'Q',           desc: 'Yaw left' },
                { key: 'E',           desc: 'Yaw right (vacuum: nose only)' },
            ]
        },
        {
            name: 'Engine / Propulsion',
            color: '#ffaa00',
            modes: ['flight', 'ground'],
            bindings: [
                { key: 'P',           desc: 'Engine selection panel' },
                { key: 'E',           desc: 'Engine on/off toggle' },
                { key: '1-9, 0',      desc: 'Quick-select engine (when panel open)' },
            ]
        },
        {
            name: 'Weapons / Sensors',
            color: '#ff4444',
            modes: ['flight'],
            bindings: [
                { key: 'Space',       desc: 'Fire / activate weapon' },
                { key: 'R',           desc: 'Cycle weapon' },
                { key: 'V',           desc: 'Cycle sensor (EO/IR/etc.)' },
                { key: 'I',           desc: 'Cycle pointing mode' },
                { key: 'L',           desc: 'Pointing mode panel' },
            ]
        },
        {
            name: 'Orbital / Planner',
            color: '#44ccff',
            modes: ['flight', 'planner'],
            bindings: [
                { key: 'M',           desc: 'Toggle planner mode' },
                { key: 'N',           desc: 'Create maneuver node' },
                { key: 'Enter',       desc: 'Execute maneuver node' },
                { key: 'Del',         desc: 'Delete maneuver node' },
                { key: 'O',           desc: 'Toggle orbital panel (auto/on/off)' },
            ]
        },
        {
            name: 'Planner Adjust',
            color: '#ff8800',
            modes: ['planner'],
            bindings: [
                { key: 'W / S',       desc: 'Prograde / retrograde dV' },
                { key: 'A / D',       desc: 'Normal / anti-normal dV' },
                { key: 'Q / E',       desc: 'Radial in / radial out dV' },
                { key: 'Click',       desc: 'Click orbit to place node' },
                { key: 'Esc',         desc: 'Cancel auto-execute' },
            ]
        },
        {
            name: 'Camera',
            color: '#ffff44',
            modes: null,  // always active
            bindings: [
                { key: 'C',           desc: 'Cycle camera mode' },
                { key: 'Mouse Drag',  desc: 'Look around (chase/cockpit)' },
                { key: 'Scroll',      desc: 'Zoom in/out' },
                { key: 'Middle Click', desc: 'Reset camera offset' },
            ]
        },
        {
            name: 'Time',
            color: '#cc88ff',
            modes: null,
            bindings: [
                { key: '+ / =',      desc: 'Increase time warp' },
                { key: '- / _',      desc: 'Decrease time warp' },
                { key: 'Esc',         desc: 'Pause / resume' },
            ]
        },
        {
            name: 'Display',
            color: '#88ff88',
            modes: null,
            bindings: [
                { key: 'Tab',         desc: 'Hide/show all panels' },
                { key: '1',           desc: 'Toggle flight data panel' },
                { key: '2',           desc: 'Toggle systems panel' },
                { key: '3',           desc: 'Toggle entity list' },
                { key: 'O',           desc: 'Toggle orbital panel' },
                { key: 'F',           desc: 'Search entities' },
                { key: 'H',           desc: 'Toggle this help overlay' },
            ]
        },
        {
            name: 'Ground Operations',
            color: '#cc6600',
            modes: ['ground'],
            bindings: [
                { key: 'B',           desc: 'Wheel brakes (hold)' },
                { key: 'G',           desc: 'Toggle landing gear' },
                { key: 'F',           desc: 'Toggle flaps' },
                { key: 'X',           desc: 'Speed brake' },
            ]
        },
        {
            name: 'Trim / Autopilot',
            color: '#00ccaa',
            modes: ['flight', 'ground'],
            bindings: [
                { key: 'T',           desc: 'Auto-trim (hold) / Trim up' },
                { key: 'Shift+T',     desc: 'Trim down' },
                { key: 'Ctrl+T',      desc: 'Trim up (step)' },
                { key: 'A',           desc: 'Toggle autopilot' },
            ]
        },
    ];

    // ===================== CSS INJECTION =====================
    function _injectStyles() {
        if (_styleInjected) return;
        _styleInjected = true;

        var css = [
            '#keyboardHelpOverlay {',
            '  position: fixed;',
            '  top: 0; left: 0; width: 100%; height: 100%;',
            '  background: rgba(0, 0, 0, 0.88);',
            '  z-index: 10000;',
            '  overflow-y: auto;',
            '  font-family: "Courier New", monospace;',
            '  color: #cccccc;',
            '  padding: 30px 20px 40px;',
            '  backdrop-filter: blur(4px);',
            '  -webkit-backdrop-filter: blur(4px);',
            '}',
            '',
            '#keyboardHelpOverlay .kh-title {',
            '  text-align: center;',
            '  font-size: 28px;',
            '  font-weight: bold;',
            '  color: #44aaff;',
            '  letter-spacing: 6px;',
            '  margin-bottom: 6px;',
            '  text-shadow: 0 0 20px rgba(68, 170, 255, 0.4);',
            '}',
            '',
            '#keyboardHelpOverlay .kh-subtitle {',
            '  text-align: center;',
            '  font-size: 11px;',
            '  color: #555555;',
            '  letter-spacing: 2px;',
            '  margin-bottom: 4px;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-mode-bar {',
            '  text-align: center;',
            '  margin-bottom: 20px;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-mode-tag {',
            '  display: inline-block;',
            '  padding: 3px 12px;',
            '  margin: 0 4px;',
            '  border: 1px solid #333;',
            '  border-radius: 3px;',
            '  font-size: 10px;',
            '  letter-spacing: 1px;',
            '  text-transform: uppercase;',
            '  color: #555;',
            '  cursor: default;',
            '  transition: all 0.2s;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-mode-tag.active {',
            '  border-color: #44aaff;',
            '  color: #44aaff;',
            '  background: rgba(68, 170, 255, 0.1);',
            '  text-shadow: 0 0 8px rgba(68, 170, 255, 0.3);',
            '}',
            '',
            '#keyboardHelpOverlay .kh-grid {',
            '  display: grid;',
            '  grid-template-columns: repeat(3, 1fr);',
            '  gap: 16px 24px;',
            '  max-width: 1100px;',
            '  margin: 0 auto;',
            '}',
            '',
            '@media (max-width: 900px) {',
            '  #keyboardHelpOverlay .kh-grid {',
            '    grid-template-columns: repeat(2, 1fr);',
            '  }',
            '}',
            '',
            '@media (max-width: 600px) {',
            '  #keyboardHelpOverlay .kh-grid {',
            '    grid-template-columns: 1fr;',
            '  }',
            '}',
            '',
            '#keyboardHelpOverlay .kh-category {',
            '  background: rgba(20, 25, 20, 0.7);',
            '  border: 1px solid #333;',
            '  border-radius: 6px;',
            '  padding: 12px 14px;',
            '  transition: opacity 0.3s, border-color 0.3s;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-category.dimmed {',
            '  opacity: 0.35;',
            '  border-color: #222;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-category.highlighted {',
            '  border-color: #446;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-cat-title {',
            '  font-size: 12px;',
            '  font-weight: bold;',
            '  letter-spacing: 2px;',
            '  text-transform: uppercase;',
            '  margin-bottom: 8px;',
            '  padding-bottom: 4px;',
            '  border-bottom: 1px solid #333;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-binding {',
            '  display: flex;',
            '  align-items: baseline;',
            '  margin: 4px 0;',
            '  gap: 8px;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-key {',
            '  display: inline-block;',
            '  min-width: 28px;',
            '  padding: 2px 6px;',
            '  background: rgba(40, 45, 40, 0.9);',
            '  border: 1px solid #555;',
            '  border-bottom: 2px solid #444;',
            '  border-radius: 4px;',
            '  font-size: 11px;',
            '  font-weight: bold;',
            '  text-align: center;',
            '  color: #ffffff;',
            '  white-space: nowrap;',
            '  flex-shrink: 0;',
            '  text-shadow: 0 1px 2px rgba(0,0,0,0.5);',
            '  box-shadow: 0 1px 3px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1);',
            '}',
            '',
            '#keyboardHelpOverlay .kh-desc {',
            '  font-size: 11px;',
            '  color: #999;',
            '  line-height: 1.4;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-footer {',
            '  text-align: center;',
            '  margin-top: 24px;',
            '  font-size: 12px;',
            '  color: #444;',
            '  letter-spacing: 1px;',
            '}',
            '',
            '#keyboardHelpOverlay .kh-footer .kh-key {',
            '  font-size: 10px;',
            '  padding: 1px 5px;',
            '  min-width: 20px;',
            '}',
        ].join('\n');

        var style = document.createElement('style');
        style.type = 'text/css';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ===================== RENDER =====================
    function _render() {
        if (!_overlay) return;
        _injectStyles();

        var html = [];
        html.push('<div class="kh-title">KEYBOARD SHORTCUTS</div>');
        html.push('<div class="kh-subtitle">ALL DOMAIN SIMULATION</div>');

        // Mode indicator bar
        html.push('<div class="kh-mode-bar">');
        var modes = ['flight', 'observer', 'planner', 'ground'];
        var modeLabels = { flight: 'Flight', observer: 'Observer', planner: 'Planner', ground: 'Ground' };
        for (var mi = 0; mi < modes.length; mi++) {
            var m = modes[mi];
            var activeClass = (m === _mode) ? ' active' : '';
            html.push('<span class="kh-mode-tag' + activeClass + '">' + modeLabels[m] + '</span>');
        }
        html.push('</div>');

        // Category grid
        html.push('<div class="kh-grid">');
        for (var ci = 0; ci < _categories.length; ci++) {
            var cat = _categories[ci];
            var isActive = _isCategoryActive(cat);
            var catClass = 'kh-category';
            if (isActive) catClass += ' highlighted';
            else catClass += ' dimmed';

            html.push('<div class="' + catClass + '">');
            html.push('<div class="kh-cat-title" style="color:' + cat.color + '">' + cat.name + '</div>');

            for (var bi = 0; bi < cat.bindings.length; bi++) {
                var b = cat.bindings[bi];
                html.push('<div class="kh-binding">');
                html.push('<span class="kh-key">' + _escapeHtml(b.key) + '</span>');
                html.push('<span class="kh-desc">' + _escapeHtml(b.desc) + '</span>');
                html.push('</div>');
            }

            html.push('</div>');
        }
        html.push('</div>');

        // Footer
        html.push('<div class="kh-footer">');
        html.push('Press <span class="kh-key">H</span> or <span class="kh-key">Esc</span> to close');
        html.push('</div>');

        _overlay.innerHTML = html.join('');

        // Click on background to close
        if (!_overlay._clickHandler) {
            _overlay._clickHandler = function(e) {
                if (e.target === _overlay) {
                    hide();
                }
            };
            _overlay.addEventListener('click', _overlay._clickHandler);
        }
    }

    function _isCategoryActive(cat) {
        if (!cat.modes) return true; // always active
        return cat.modes.indexOf(_mode) >= 0;
    }

    function _escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ===================== PUBLIC API =====================
    function show() {
        if (!_overlay) {
            _overlay = document.getElementById('keyboardHelpOverlay');
        }
        if (!_overlay) return;
        _visible = true;
        _overlay.style.display = 'block';
        _render();
    }

    function hide() {
        if (!_overlay) return;
        _visible = false;
        _overlay.style.display = 'none';
    }

    function toggle() {
        if (_visible) hide();
        else show();
    }

    function setMode(mode) {
        if (['flight', 'observer', 'planner', 'ground'].indexOf(mode) < 0) return;
        _mode = mode;
        if (_visible) _render();
    }

    function isVisible() {
        return _visible;
    }

    return {
        show: show,
        hide: hide,
        toggle: toggle,
        setMode: setMode,
        isVisible: isVisible
    };

})();
