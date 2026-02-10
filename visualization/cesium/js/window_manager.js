/**
 * WindowManager - Draggable, snappable, collapsible panel system for Live Sim Viewer.
 *
 * Usage:
 *   WindowManager.register('myPanel', document.getElementById('myPanel'), { title: 'My Panel', snap: true });
 *   WindowManager.init();
 *
 * Features:
 *   - Drag panels by their title bar / drag handle
 *   - Snap to edges and corners (8px threshold)
 *   - Double-click title bar to collapse/expand
 *   - Save/restore layout to localStorage
 *   - Z-index management (click to bring to front)
 *   - Cascade layout reset
 */
var WindowManager = (function() {
    'use strict';

    var _windows = {};       // id -> { el, opts, collapsed, x, y, w, h, zIndex }
    var _zCounter = 100;     // global z-index counter
    var _dragState = null;   // { id, startX, startY, startLeft, startTop }
    var _resizeState = null; // { id, startX, startY, startW, startH, edge }
    var _SNAP_THRESHOLD = 12;
    var _STORAGE_KEY = 'livesim_window_layout';
    var _initialized = false;

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Register a panel element to be managed.
     * @param {string} id - Unique panel identifier
     * @param {HTMLElement} el - The panel DOM element
     * @param {Object} opts - Options: { title, snap, resizable, collapsible, minWidth, minHeight, closable, onClose }
     */
    function register(id, el, opts) {
        if (!el) return;
        opts = opts || {};
        var win = {
            el: el,
            opts: Object.assign({
                title: id,
                snap: true,
                resizable: false,
                collapsible: true,
                closable: false,
                minWidth: 160,
                minHeight: 60,
                pinned: false,
                onClose: null
            }, opts),
            collapsed: false,
            zIndex: _zCounter++,
            originalDisplay: el.style.display || ''
        };
        _windows[id] = win;
        _injectDragHandle(id, win);
        _makeInteractive(id, win);
    }

    /** Initialize the window manager - load saved layout, set up global listeners. */
    function init() {
        if (_initialized) return;
        _initialized = true;
        _loadLayout();
        // Global mouse move/up for drag
        document.addEventListener('mousemove', _onMouseMove, { passive: false });
        document.addEventListener('mouseup', _onMouseUp);
    }

    /** Save current layout to localStorage. */
    function saveLayout() {
        var layout = {};
        var keys = Object.keys(_windows);
        for (var i = 0; i < keys.length; i++) {
            var id = keys[i];
            var win = _windows[id];
            var rect = win.el.getBoundingClientRect();
            layout[id] = {
                x: parseInt(win.el.style.left) || rect.left,
                y: parseInt(win.el.style.top) || rect.top,
                w: win.el.offsetWidth,
                h: win.el.offsetHeight,
                collapsed: win.collapsed,
                zIndex: win.zIndex
            };
        }
        try {
            localStorage.setItem(_STORAGE_KEY, JSON.stringify(layout));
        } catch(e) { /* quota */ }
    }

    /** Reset all panels to their default CSS positions. */
    function resetLayout() {
        var keys = Object.keys(_windows);
        for (var i = 0; i < keys.length; i++) {
            var win = _windows[keys[i]];
            win.el.style.left = '';
            win.el.style.top = '';
            win.el.style.right = '';
            win.el.style.bottom = '';
            win.el.style.width = '';
            win.el.style.height = '';
            win.el.style.transform = '';
            win.collapsed = false;
            _setCollapsed(keys[i], win, false);
        }
        try { localStorage.removeItem(_STORAGE_KEY); } catch(e) {}
    }

    /** Bring a window to front. */
    function bringToFront(id) {
        var win = _windows[id];
        if (!win) return;
        win.zIndex = ++_zCounter;
        win.el.style.zIndex = String(win.zIndex);
    }

    /** Toggle collapse on a window. */
    function toggleCollapse(id) {
        var win = _windows[id];
        if (!win || !win.opts.collapsible) return;
        win.collapsed = !win.collapsed;
        _setCollapsed(id, win, win.collapsed);
        saveLayout();
    }

    /** Check if a window is registered. */
    function has(id) {
        return !!_windows[id];
    }

    /** Get the window object */
    function get(id) {
        return _windows[id] || null;
    }

    // -----------------------------------------------------------------------
    // Internal: Drag Handle Injection
    // -----------------------------------------------------------------------

    function _injectDragHandle(id, win) {
        var el = win.el;
        // Don't add handle if element already has one
        if (el.querySelector('.wm-handle')) return;

        var handle = document.createElement('div');
        handle.className = 'wm-handle';
        handle.setAttribute('data-wm-id', id);

        // Title text
        var titleSpan = document.createElement('span');
        titleSpan.className = 'wm-title';
        titleSpan.textContent = win.opts.title;
        handle.appendChild(titleSpan);

        // Spacer
        var spacer = document.createElement('span');
        spacer.style.flex = '1';
        handle.appendChild(spacer);

        // Collapse button
        if (win.opts.collapsible) {
            var collapseBtn = document.createElement('span');
            collapseBtn.className = 'wm-btn wm-collapse';
            collapseBtn.textContent = '\u2212'; // minus
            collapseBtn.title = 'Collapse';
            collapseBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleCollapse(id);
            });
            handle.appendChild(collapseBtn);
        }

        // Close button
        if (win.opts.closable) {
            var closeBtn = document.createElement('span');
            closeBtn.className = 'wm-btn wm-close';
            closeBtn.textContent = '\u00d7'; // x
            closeBtn.title = 'Close';
            closeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                el.style.display = 'none';
                if (win.opts.onClose) win.opts.onClose(id);
            });
            handle.appendChild(closeBtn);
        }

        el.insertBefore(handle, el.firstChild);
    }

    // -----------------------------------------------------------------------
    // Internal: Make Interactive
    // -----------------------------------------------------------------------

    function _makeInteractive(id, win) {
        var el = win.el;
        var handle = el.querySelector('.wm-handle');
        if (!handle) return;

        // Mousedown on handle starts drag
        handle.addEventListener('mousedown', function(e) {
            if (e.target.classList.contains('wm-btn')) return;
            e.preventDefault();
            e.stopPropagation();

            bringToFront(id);

            // Convert to absolute positioning if not already
            _ensureAbsolutePos(id, win);

            _dragState = {
                id: id,
                startX: e.clientX,
                startY: e.clientY,
                startLeft: parseInt(el.style.left) || 0,
                startTop: parseInt(el.style.top) || 0
            };
        });

        // Click anywhere on panel brings to front
        el.addEventListener('mousedown', function() {
            bringToFront(id);
        });

        // Double click on handle toggles collapse
        handle.addEventListener('dblclick', function(e) {
            if (e.target.classList.contains('wm-btn')) return;
            toggleCollapse(id);
        });
    }

    function _ensureAbsolutePos(id, win) {
        var el = win.el;
        // If element uses right/bottom/transform positioning, convert to left/top
        var rect = el.getBoundingClientRect();
        var computed = getComputedStyle(el);

        if (computed.position !== 'fixed') {
            el.style.position = 'absolute';
        }

        // Clear transform-based centering
        el.style.transform = 'none';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.left = rect.left + 'px';
        el.style.top = rect.top + 'px';
    }

    // -----------------------------------------------------------------------
    // Internal: Mouse Events
    // -----------------------------------------------------------------------

    function _onMouseMove(e) {
        if (_dragState) {
            e.preventDefault();
            var dx = e.clientX - _dragState.startX;
            var dy = e.clientY - _dragState.startY;
            var newX = _dragState.startLeft + dx;
            var newY = _dragState.startTop + dy;

            var win = _windows[_dragState.id];
            if (!win) return;

            // Snap to edges
            if (win.opts.snap) {
                var snapped = _snapPosition(win.el, newX, newY);
                newX = snapped.x;
                newY = snapped.y;
            }

            // Keep on screen
            var maxX = window.innerWidth - 40;
            var maxY = window.innerHeight - 20;
            newX = Math.max(-win.el.offsetWidth + 60, Math.min(maxX, newX));
            newY = Math.max(0, Math.min(maxY, newY));

            win.el.style.left = newX + 'px';
            win.el.style.top = newY + 'px';
        }
    }

    function _onMouseUp() {
        if (_dragState) {
            _dragState = null;
            saveLayout();
        }
        _resizeState = null;
    }

    // -----------------------------------------------------------------------
    // Internal: Snapping
    // -----------------------------------------------------------------------

    function _snapPosition(el, x, y) {
        var vw = window.innerWidth;
        var vh = window.innerHeight;
        var w = el.offsetWidth;
        var h = el.offsetHeight;

        // Snap to left edge
        if (Math.abs(x) < _SNAP_THRESHOLD) x = 0;
        // Snap to right edge
        if (Math.abs(x + w - vw) < _SNAP_THRESHOLD) x = vw - w;
        // Snap to top edge
        if (Math.abs(y) < _SNAP_THRESHOLD) y = 0;
        // Snap to bottom edge
        if (Math.abs(y + h - vh) < _SNAP_THRESHOLD) y = vh - h;

        // Snap to nearby panels
        var keys = Object.keys(_windows);
        for (var i = 0; i < keys.length; i++) {
            var other = _windows[keys[i]];
            if (other.el === el) continue;
            if (other.el.style.display === 'none') continue;
            var or = other.el.getBoundingClientRect();

            // Snap left edge to other's right edge
            if (Math.abs(x - (or.right + 4)) < _SNAP_THRESHOLD) x = or.right + 4;
            // Snap right edge to other's left edge
            if (Math.abs((x + w) - (or.left - 4)) < _SNAP_THRESHOLD) x = or.left - 4 - w;
            // Snap top edge to other's top
            if (Math.abs(y - or.top) < _SNAP_THRESHOLD) y = or.top;
            // Snap top to other's bottom
            if (Math.abs(y - (or.bottom + 4)) < _SNAP_THRESHOLD) y = or.bottom + 4;
        }

        return { x: x, y: y };
    }

    // -----------------------------------------------------------------------
    // Internal: Collapse
    // -----------------------------------------------------------------------

    function _setCollapsed(id, win, collapsed) {
        var el = win.el;
        var handle = el.querySelector('.wm-handle');
        var collapseBtn = handle ? handle.querySelector('.wm-collapse') : null;

        // Find all children except handle
        var children = el.children;
        for (var i = 0; i < children.length; i++) {
            if (children[i].classList.contains('wm-handle')) continue;
            children[i].style.display = collapsed ? 'none' : '';
        }

        if (collapseBtn) {
            collapseBtn.textContent = collapsed ? '\u25a1' : '\u2212'; // square vs minus
            collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
        }

        el.classList.toggle('wm-collapsed', collapsed);
    }

    // -----------------------------------------------------------------------
    // Internal: Layout Persistence
    // -----------------------------------------------------------------------

    function _loadLayout() {
        try {
            var saved = localStorage.getItem(_STORAGE_KEY);
            if (!saved) return;
            var layout = JSON.parse(saved);
            var keys = Object.keys(layout);
            for (var i = 0; i < keys.length; i++) {
                var id = keys[i];
                var win = _windows[id];
                if (!win) continue;
                var pos = layout[id];
                // Only apply if the saved position is reasonable
                if (pos.x != null && pos.y != null) {
                    _ensureAbsolutePos(id, win);
                    win.el.style.left = Math.min(pos.x, window.innerWidth - 40) + 'px';
                    win.el.style.top = Math.min(pos.y, window.innerHeight - 20) + 'px';
                }
                if (pos.collapsed && win.opts.collapsible) {
                    win.collapsed = true;
                    _setCollapsed(id, win, true);
                }
                if (pos.zIndex) {
                    win.zIndex = pos.zIndex;
                    win.el.style.zIndex = String(pos.zIndex);
                }
            }
        } catch(e) { /* ignore corrupt data */ }
    }

    // -----------------------------------------------------------------------
    // CSS Injection
    // -----------------------------------------------------------------------
    (function _injectStyles() {
        if (document.getElementById('wm-styles')) return;
        var style = document.createElement('style');
        style.id = 'wm-styles';
        style.textContent = [
            '.wm-handle {',
            '  display: flex; align-items: center; gap: 6px;',
            '  padding: 4px 10px; cursor: grab;',
            '  background: rgba(0, 40, 0, 0.6);',
            '  border-bottom: 1px solid rgba(0, 170, 0, 0.3);',
            '  border-radius: 4px 4px 0 0;',
            '  margin: -10px -10px 8px -10px;',
            '  user-select: none; -webkit-user-select: none;',
            '}',
            '.wm-handle:active { cursor: grabbing; }',
            '.wm-title {',
            '  font-size: 10px; font-weight: bold;',
            '  color: #00cc66; text-transform: uppercase;',
            '  letter-spacing: 1px; white-space: nowrap;',
            '}',
            '.wm-btn {',
            '  width: 18px; height: 18px;',
            '  display: flex; align-items: center; justify-content: center;',
            '  font-size: 14px; cursor: pointer;',
            '  color: #006600; border-radius: 2px;',
            '  transition: color 0.1s, background 0.1s;',
            '}',
            '.wm-btn:hover { color: #00ff00; background: rgba(0,80,0,0.4); }',
            '.wm-close:hover { color: #ff4444; background: rgba(80,0,0,0.4); }',
            '.wm-collapsed { min-height: 0 !important; max-height: none !important; overflow: visible !important; }',
            '.wm-collapsed .wm-handle { margin-bottom: -10px; border-bottom: none; border-radius: 4px; }',
            /* Snap indicator */
            '.wm-snap-guide {',
            '  position: fixed; background: rgba(0,255,0,0.3);',
            '  z-index: 99999; pointer-events: none;',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    })();

    return {
        register: register,
        init: init,
        saveLayout: saveLayout,
        resetLayout: resetLayout,
        bringToFront: bringToFront,
        toggleCollapse: toggleCollapse,
        has: has,
        get: get
    };
})();
