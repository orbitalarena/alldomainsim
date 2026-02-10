/**
 * TimelinePanel — Bottom-right panel showing simulation timeline with
 * event markers, entity lifecycle bars, and playhead scrubber.
 *
 * Renders onto #timelineCanvas. Shows:
 * - Time axis (seconds/minutes/hours depending on zoom)
 * - Playhead line (current sim time, red vertical line)
 * - Event markers (from scenario events array) as colored diamonds
 * - Entity state bars (active/destroyed status) as horizontal bars
 * - Engagement markers (SAM launches, kills) as special icons
 * - Click-to-seek (click on timeline to set sim time)
 * - Zoom in/out with mouse wheel
 *
 * Uses standard IIFE module pattern. Works with BuilderApp (getMode, getScenarioData)
 * and the ECS World object.
 */
var TimelinePanel = (function() {
    'use strict';

    // State
    var _canvas = null, _ctx = null, _placeholder = null;
    var _world = null, _scenarioData = null, _visible = false;
    var _viewStart = 0, _viewEnd = 300, _zoom = 1.0;
    var _isDragging = false, _dragStartX = 0, _dragViewStart = 0;

    // Layout
    var HDR_H = 28, AXIS_H = 24, ROW_H = 14, ROW_GAP = 2;
    var LBL_W = 100, R_PAD = 12;

    // Colors
    var C_BG = '#060a12', C_GRID = '#0f1826', C_TEXT = '#506880', C_BRIGHT = '#8098b8';
    var C_HEAD = '#ff4444', C_EV_BLUE = '#4a9eff', C_EV_RED = '#ff4444', C_EV_YEL = '#ffaa44';
    var C_BAR = { blue: '#2244aa', red: '#aa2222', neutral: '#227722' };
    var C_INACTIVE = '#1a2030';

    // Mission phase colors
    var C_PHASE = {
        'planning':  { bg: 'rgba(100,100,200,0.25)', border: '#6666cc', label: '#aaaaff' },
        'ingress':   { bg: 'rgba(200,150,50,0.25)',  border: '#cc9933', label: '#ffcc66' },
        'strike':    { bg: 'rgba(255,50,50,0.25)',   border: '#ff3333', label: '#ff6666' },
        'egress':    { bg: 'rgba(50,200,100,0.25)',  border: '#33cc66', label: '#66ff99' },
        'loiter':    { bg: 'rgba(100,200,255,0.25)', border: '#66ccff', label: '#88ddff' },
        'refuel':    { bg: 'rgba(200,200,50,0.25)',  border: '#cccc33', label: '#ffff66' },
        'transit':   { bg: 'rgba(150,150,150,0.25)', border: '#999999', label: '#cccccc' },
        'combat':    { bg: 'rgba(255,100,0,0.25)',   border: '#ff6600', label: '#ff8844' },
        'defend':    { bg: 'rgba(50,100,255,0.25)',  border: '#3366ff', label: '#6699ff' },
        'patrol':    { bg: 'rgba(0,200,200,0.25)',   border: '#00cccc', label: '#44ffff' }
    };
    var PHASE_H = 20;  // Height of mission phase band

    // ---- Helpers ----

    function _pad2(n) { return n < 10 ? '0' + n : '' + n; }

    function _formatTime(sec) {
        var s = Math.max(0, Math.floor(sec));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        return h > 0 ? _pad2(h) + ':' + _pad2(m) + ':' + _pad2(ss) : _pad2(m) + ':' + _pad2(ss);
    }

    function _timeToX(t) {
        var dw = _canvas.width - LBL_W - R_PAD, span = _viewEnd - _viewStart;
        return span <= 0 ? LBL_W : LBL_W + ((t - _viewStart) / span) * dw;
    }

    function _xToTime(x) {
        var dw = _canvas.width - LBL_W - R_PAD, span = _viewEnd - _viewStart;
        return dw <= 0 ? _viewStart : _viewStart + ((x - LBL_W) / dw) * span;
    }

    function _tickInterval() {
        var raw = (_viewEnd - _viewStart) / 10;
        var nice = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
        for (var i = 0; i < nice.length; i++) { if (nice[i] >= raw) return nice[i]; }
        return 3600;
    }

    function _getSimTime() { return _world ? (_world.simTime || 0) : 0; }

    function _getEntities() {
        var list = [];
        if (_world && _world.entities) {
            _world.entities.forEach(function(e) { list.push(e); });
            return list;
        }
        return (_scenarioData && _scenarioData.entities) ? _scenarioData.entities : list;
    }

    function _getEvents() {
        if (_world && _world.events) return _world.events;
        return (_scenarioData && _scenarioData.events) ? _scenarioData.events : [];
    }

    function _getEngagements() {
        var markers = [];
        if (!_world || !_world.entities) return markers;
        _world.entities.forEach(function(entity) {
            var sam = entity.state && entity.state._samState;
            if (!sam) return;
            var name = entity.name || entity.id;
            var types = ['launches', 'kills', 'misses'];
            var labels = ['launch', 'kill', 'miss'];
            for (var t = 0; t < types.length; t++) {
                var arr = sam[types[t]];
                if (!arr) continue;
                for (var i = 0; i < arr.length; i++) {
                    markers.push({ time: arr[i].time || 0, type: labels[t], entity: name });
                }
            }
        });
        return markers;
    }

    function _getMissionPhases() {
        // Get phases from scenario data or world
        var src = _scenarioData || (_world && _world._scenarioData) || {};
        var phases = src.missionPhases || src.mission_phases || [];
        if (!phases.length && src.events) {
            // Auto-derive phases from timed events with phase annotations
            for (var i = 0; i < src.events.length; i++) {
                var evt = src.events[i];
                if (evt.phase) {
                    phases.push({
                        name: evt.phase,
                        startTime: evt.trigger && evt.trigger.time ? evt.trigger.time : 0,
                        endTime: evt.endTime || (evt.trigger && evt.trigger.time ? evt.trigger.time + 60 : 60)
                    });
                }
            }
        }
        return phases;
    }

    function _drawMissionPhases() {
        var phases = _getMissionPhases();
        if (!phases.length) return 0; // Return 0 height used
        var y = HDR_H + AXIS_H;
        // Draw phase background band
        _ctx.fillStyle = 'rgba(10,15,25,0.5)';
        _ctx.fillRect(LBL_W, y, _canvas.width - LBL_W - R_PAD, PHASE_H);
        // Label
        _ctx.fillStyle = C_TEXT; _ctx.font = '9px sans-serif';
        _ctx.textAlign = 'right'; _ctx.textBaseline = 'middle';
        _ctx.fillText('PHASES', LBL_W - 6, y + PHASE_H / 2);
        // Draw each phase
        for (var i = 0; i < phases.length; i++) {
            var phase = phases[i];
            var x1 = _timeToX(phase.startTime || 0);
            var x2 = _timeToX(phase.endTime || phase.startTime + 60);
            if (x2 < LBL_W || x1 > _canvas.width - R_PAD) continue;
            x1 = Math.max(x1, LBL_W);
            x2 = Math.min(x2, _canvas.width - R_PAD);
            var phaseName = (phase.name || 'unknown').toLowerCase();
            var colors = C_PHASE[phaseName] || C_PHASE.transit;
            // Phase box
            _ctx.fillStyle = colors.bg;
            _ctx.fillRect(x1, y + 1, x2 - x1, PHASE_H - 2);
            _ctx.strokeStyle = colors.border;
            _ctx.lineWidth = 1;
            _ctx.strokeRect(x1, y + 1, x2 - x1, PHASE_H - 2);
            // Phase label
            if (x2 - x1 > 30) {
                _ctx.fillStyle = colors.label;
                _ctx.font = 'bold 9px sans-serif';
                _ctx.textAlign = 'center'; _ctx.textBaseline = 'middle';
                var label = phase.name || phaseName;
                _ctx.fillText(_clip(label.toUpperCase(), 12), (x1 + x2) / 2, y + PHASE_H / 2);
            }
        }
        return PHASE_H + 2; // Return height used
    }

    function _evtColor(evt) {
        if (!evt || !evt.action) return C_EV_BLUE;
        if (evt.action.type === 'destroy') return C_EV_RED;
        if (evt.action.type === 'spawn') return C_EV_YEL;
        return C_EV_BLUE;
    }

    function _clip(label, max) {
        return label.length > max ? label.substring(0, max - 2) + '..' : label;
    }

    // ---- Drawing ----

    function _drawHeader() {
        _ctx.fillStyle = '#0a0f1a';
        _ctx.fillRect(0, 0, _canvas.width, HDR_H);
        _ctx.strokeStyle = C_GRID;
        _ctx.beginPath(); _ctx.moveTo(0, HDR_H); _ctx.lineTo(_canvas.width, HDR_H); _ctx.stroke();
        _ctx.beginPath(); _ctx.moveTo(LBL_W, HDR_H); _ctx.lineTo(LBL_W, _canvas.height); _ctx.stroke();
    }

    function _drawAxis() {
        var interval = _tickInterval();
        var first = Math.ceil(_viewStart / interval) * interval;
        _ctx.font = '10px monospace';
        _ctx.textAlign = 'center';
        _ctx.textBaseline = 'top';
        for (var t = first; t <= _viewEnd; t += interval) {
            var x = _timeToX(t);
            if (x < LBL_W || x > _canvas.width - R_PAD) continue;
            // Grid line
            _ctx.strokeStyle = C_GRID; _ctx.lineWidth = 1;
            _ctx.beginPath(); _ctx.moveTo(x, HDR_H); _ctx.lineTo(x, _canvas.height); _ctx.stroke();
            // Tick
            _ctx.strokeStyle = C_TEXT;
            _ctx.beginPath(); _ctx.moveTo(x, HDR_H); _ctx.lineTo(x, HDR_H + 5); _ctx.stroke();
            // Label
            _ctx.fillStyle = C_TEXT;
            _ctx.fillText(_formatTime(t), x, HDR_H + 7);
        }
    }

    function _drawEntityBars(phaseOffset) {
        var ents = _getEntities(), startY = HDR_H + AXIS_H + (phaseOffset || 0);
        _ctx.font = '10px sans-serif';
        _ctx.textBaseline = 'middle';
        for (var i = 0; i < ents.length; i++) {
            var ent = ents[i], y = startY + i * (ROW_H + ROW_GAP);
            // Alternating stripe
            if (i % 2 === 0) {
                _ctx.fillStyle = 'rgba(15,24,38,0.3)';
                _ctx.fillRect(0, y, _canvas.width, ROW_H);
            }
            // Label
            _ctx.fillStyle = C_BRIGHT; _ctx.textAlign = 'right';
            _ctx.fillText(_clip(ent.name || ent.id || 'Entity ' + i, 14), LBL_W - 6, y + ROW_H / 2);
            // Bar
            var active = ent.active !== undefined ? ent.active : true;
            var color = C_BAR[ent.team] || C_BAR.neutral;
            var x1 = _timeToX(Math.max(0, _viewStart));
            var x2 = _timeToX(_viewEnd);
            if (x2 > x1) {
                _ctx.fillStyle = active ? color : C_INACTIVE;
                _ctx.fillRect(x1, y + 1, x2 - x1, ROW_H - 2);
                // Destroyed marker
                if (!active) {
                    var xEnd = _timeToX(_getSimTime());
                    if (xEnd >= x1 && xEnd <= _canvas.width - R_PAD) {
                        _ctx.strokeStyle = C_EV_RED; _ctx.lineWidth = 2;
                        var cy = y + ROW_H / 2;
                        _ctx.beginPath();
                        _ctx.moveTo(xEnd - 3, cy - 3); _ctx.lineTo(xEnd + 3, cy + 3);
                        _ctx.moveTo(xEnd + 3, cy - 3); _ctx.lineTo(xEnd - 3, cy + 3);
                        _ctx.stroke(); _ctx.lineWidth = 1;
                    }
                }
            }
        }
    }

    function _drawEventMarkers(phaseOffset) {
        var events = _getEvents();
        if (!events || !events.length) return;
        var mY = HDR_H + AXIS_H + (phaseOffset || 0) + _getEntities().length * (ROW_H + ROW_GAP) + 8;
        for (var i = 0; i < events.length; i++) {
            var evt = events[i], t = null;
            if (evt.trigger && evt.trigger.type === 'time') {
                t = evt.trigger.time || evt.trigger.seconds || 0;
            } else if (evt._firedAt !== undefined) { t = evt._firedAt; }
            if (t === null) continue;
            var x = _timeToX(t);
            if (x < LBL_W || x > _canvas.width - R_PAD) continue;
            // Diamond
            _ctx.fillStyle = _evtColor(evt);
            _ctx.beginPath();
            _ctx.moveTo(x, mY - 5); _ctx.lineTo(x + 5, mY);
            _ctx.lineTo(x, mY + 5); _ctx.lineTo(x - 5, mY);
            _ctx.closePath(); _ctx.fill();
            // Label
            var lbl = evt.name || evt.id;
            if (lbl) {
                _ctx.fillStyle = C_TEXT; _ctx.font = '9px sans-serif';
                _ctx.textAlign = 'center'; _ctx.textBaseline = 'top';
                _ctx.fillText(_clip(lbl, 12), x, mY + 7);
            }
        }
    }

    function _drawEngagementMarkers(phaseOffset) {
        var engs = _getEngagements();
        if (!engs.length) return;
        var baseY = HDR_H + AXIS_H + (phaseOffset || 0) + _getEntities().length * (ROW_H + ROW_GAP) + 30;
        for (var i = 0; i < engs.length; i++) {
            var eng = engs[i], x = _timeToX(eng.time);
            if (x < LBL_W || x > _canvas.width - R_PAD) continue;
            var y = baseY + (i % 3) * 12;
            if (eng.type === 'launch') {
                _ctx.fillStyle = '#ff8844';
                _ctx.beginPath();
                _ctx.moveTo(x, y - 5); _ctx.lineTo(x + 4, y + 3); _ctx.lineTo(x - 4, y + 3);
                _ctx.closePath(); _ctx.fill();
            } else if (eng.type === 'kill') {
                _ctx.strokeStyle = '#ff2222'; _ctx.lineWidth = 2;
                _ctx.beginPath();
                _ctx.moveTo(x - 4, y - 4); _ctx.lineTo(x + 4, y + 4);
                _ctx.moveTo(x + 4, y - 4); _ctx.lineTo(x - 4, y + 4);
                _ctx.stroke(); _ctx.lineWidth = 1;
            } else {
                _ctx.strokeStyle = '#888888'; _ctx.lineWidth = 1;
                _ctx.beginPath(); _ctx.arc(x, y, 3, 0, Math.PI * 2); _ctx.stroke();
            }
        }
    }

    function _drawPlayhead() {
        var t = _getSimTime(), x = _timeToX(t);
        if (x < LBL_W || x > _canvas.width - R_PAD) return;
        // Line
        _ctx.strokeStyle = C_HEAD; _ctx.lineWidth = 2;
        _ctx.beginPath(); _ctx.moveTo(x, HDR_H); _ctx.lineTo(x, _canvas.height); _ctx.stroke();
        _ctx.lineWidth = 1;
        // Time label
        _ctx.fillStyle = C_HEAD; _ctx.font = 'bold 10px monospace';
        _ctx.textAlign = 'center'; _ctx.textBaseline = 'bottom';
        _ctx.fillText(_formatTime(t), x, HDR_H - 2);
        // Triangle
        _ctx.beginPath();
        _ctx.moveTo(x - 5, HDR_H); _ctx.lineTo(x + 5, HDR_H); _ctx.lineTo(x, HDR_H + 6);
        _ctx.closePath(); _ctx.fill();
    }

    function _drawZoomIndicator() {
        var span = _viewEnd - _viewStart;
        var lbl = span < 60 ? Math.round(span) + 's'
                : span < 3600 ? (span / 60).toFixed(1) + 'm'
                : (span / 3600).toFixed(1) + 'h';
        _ctx.fillStyle = C_TEXT; _ctx.font = '9px monospace';
        _ctx.textAlign = 'right'; _ctx.textBaseline = 'bottom';
        _ctx.fillText('span: ' + lbl, _canvas.width - 4, _canvas.height - 3);
    }

    // ---- Mouse interaction ----

    function _onMouseDown(e) {
        if (!_canvas) return;
        var rect = _canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        if (x < LBL_W) return;
        _isDragging = true; _dragStartX = x; _dragViewStart = _viewStart;
        e.preventDefault();
    }

    function _onMouseMove(e) {
        if (!_isDragging || !_canvas) return;
        var rect = _canvas.getBoundingClientRect();
        var dx = (e.clientX - rect.left) - _dragStartX;
        var dw = _canvas.width - LBL_W - R_PAD, span = _viewEnd - _viewStart;
        if (dw <= 0) return;
        var ns = _dragViewStart - (dx / dw) * span;
        if (ns < 0) ns = 0;
        _viewStart = ns; _viewEnd = ns + span;
        _doRender();
    }

    function _onMouseUp(e) {
        if (!_isDragging || !_canvas) return;
        var rect = _canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        if (Math.abs(x - _dragStartX) < 4) {
            var seekTime = _xToTime(x);
            if (seekTime >= 0 && _world) _world.simTime = seekTime;
        }
        _isDragging = false;
        _doRender();
    }

    function _onWheel(e) {
        if (!_canvas) return;
        e.preventDefault();
        var rect = _canvas.getBoundingClientRect();
        var mouseTime = _xToTime(e.clientX - rect.left);
        var factor = e.deltaY > 0 ? 1.15 : (1 / 1.15);
        var span = _viewEnd - _viewStart, ns = span * factor;
        if (ns < 5) ns = 5; if (ns > 36000) ns = 36000;
        var frac = span > 0 ? (mouseTime - _viewStart) / span : 0;
        _viewStart = mouseTime - frac * ns;
        if (_viewStart < 0) _viewStart = 0;
        _viewEnd = _viewStart + ns; _zoom = 300 / ns;
        _doRender();
    }

    // ---- Visibility ----

    function _show() {
        _visible = true;
        if (_canvas) _canvas.style.display = 'block';
        if (_placeholder) _placeholder.style.display = 'none';
    }

    function _hide() {
        _visible = false;
        if (_canvas) _canvas.style.display = 'none';
        if (_placeholder) _placeholder.style.display = '';
    }

    // ---- Render (internal + public) ----

    function _doRender() {
        if (!_canvas || !_ctx || !_visible) return;
        var container = _canvas.parentElement;
        if (container) {
            var cw = container.clientWidth, ch = container.clientHeight - 30;
            if (ch < 40) ch = 40;
            if (_canvas.width !== cw || _canvas.height !== ch) {
                _canvas.width = cw; _canvas.height = ch;
            }
        }
        _ctx.fillStyle = C_BG;
        _ctx.fillRect(0, 0, _canvas.width, _canvas.height);
        _drawHeader(); _drawAxis();
        var phaseOffset = _drawMissionPhases();
        _drawEntityBars(phaseOffset);
        _drawEventMarkers(phaseOffset); _drawEngagementMarkers(phaseOffset);
        _drawPlayhead(); _drawZoomIndicator();
    }

    // ---- Public API ----

    function init() {
        _canvas = document.getElementById('timelineCanvas');
        _placeholder = document.getElementById('timelinePlaceholder');
        if (!_canvas) { console.warn('[TimelinePanel] #timelineCanvas not found'); return; }
        _ctx = _canvas.getContext('2d');
        _canvas.addEventListener('mousedown', _onMouseDown);
        document.addEventListener('mousemove', _onMouseMove);
        document.addEventListener('mouseup', _onMouseUp);
        _canvas.addEventListener('wheel', _onWheel);
        _viewStart = 0; _viewEnd = 300; _zoom = 1.0; _isDragging = false;
        if (typeof BuilderApp !== 'undefined') _scenarioData = BuilderApp.getScenarioData();
        _hide();
        console.log('[TimelinePanel] Initialized');
    }

    function setWorld(world) {
        _world = world;
        if (typeof BuilderApp !== 'undefined') _scenarioData = BuilderApp.getScenarioData();
        _viewStart = 0; _viewEnd = 300;
        _show(); _doRender();
    }

    function clearWorld() { _world = null; _hide(); }

    function render() { _doRender(); }

    var _updateAccum = 0;
    var _UPDATE_INTERVAL = 0.25;  // 4 Hz canvas redraws instead of every frame

    function update(dt) {
        if (!_world || !_visible) return;
        _updateAccum += (typeof dt === 'number' && dt > 0) ? dt : 0.016;
        if (_updateAccum < _UPDATE_INTERVAL) return;
        _updateAccum = 0;

        var t = _getSimTime(), span = _viewEnd - _viewStart, margin = span * 0.15;
        if (t > _viewEnd - margin) {
            _viewStart = t - span * 0.7;
            if (_viewStart < 0) _viewStart = 0;
            _viewEnd = _viewStart + span;
        } else if (t < _viewStart + margin && _viewStart > 0) {
            _viewStart = Math.max(0, t - span * 0.3);
            _viewEnd = _viewStart + span;
        }
        _doRender();
    }

    return { init: init, setWorld: setWorld, clearWorld: clearWorld, render: render, update: update };
})();
