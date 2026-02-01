/**
 * EventEditor — Visual modal for creating/editing/deleting scenario events in BUILD mode.
 * Trigger types: time, proximity, detection, state_change
 * Action types: set_state, spawn_entity, message, change_rules
 */
const EventEditor = (function() {
    'use strict';

    var _scenarioData = null, _editingIndex = -1, _currentView = 'list';
    var _overlay = null, _modal = null;

    // --- Helpers ---

    function _esc(str) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(str == null ? '' : String(str)));
        return d.innerHTML;
    }

    function _entLabel(e) { return (e.name || e.id) + ' (' + e.id + ')'; }

    function _entName(id) {
        var ents = _scenarioData && _scenarioData.entities || [];
        for (var i = 0; i < ents.length; i++) if (ents[i].id === id) return ents[i].name || id;
        return id || '?';
    }

    function _describeTrigger(t) {
        if (!t || !t.type) return '(no trigger)';
        switch (t.type) {
            case 'time': return 'time = ' + (t.simTime_s || 0) + 's';
            case 'proximity': return 'proximity(' + _entName(t.entityA) + ', ' + _entName(t.entityB) + ') < ' + (t.range_m || 0) + 'm';
            case 'detection': return 'detection(' + _entName(t.sensorEntity) + ', ' + _entName(t.targetEntity) + ')';
            case 'state_change': return _entName(t.entity) + '.' + (t.field || '?') + ' = ' + (t.value || '?');
            default: return t.type + '(?)';
        }
    }

    function _describeAction(a) {
        if (!a || !a.type) return '(no action)';
        switch (a.type) {
            case 'set_state': return 'set ' + _entName(a.entity) + '.' + (a.field || '?') + ' = ' + (a.value || '?');
            case 'message': return 'message("' + _esc(a.text || '') + '")';
            case 'change_rules': return 'change_rules(' + _entName(a.entity) + ') \u2192 ' + (a.value || '?');
            case 'spawn_entity': return 'spawn_entity(...)';
            default: return a.type + '(?)';
        }
    }

    // --- DOM factories ---

    function _el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text) e.textContent = text;
        return e;
    }

    function _btn(cls, text, onClick) {
        var b = _el('button', cls, text);
        b.addEventListener('click', onClick);
        return b;
    }

    function _entitySelect(selectedId) {
        var sel = _el('select', 'ee-input ee-select');
        var none = _el('option', null, '-- Select --');
        none.value = '';
        sel.appendChild(none);
        var ents = _scenarioData && _scenarioData.entities || [];
        for (var i = 0; i < ents.length; i++) {
            var o = _el('option', null, _entLabel(ents[i]));
            o.value = ents[i].id;
            if (ents[i].id === selectedId) o.selected = true;
            sel.appendChild(o);
        }
        return sel;
    }

    function _row(label) {
        var r = _el('div', 'ee-row');
        r.appendChild(_el('label', 'ee-label', label));
        var c = _el('div', 'ee-control');
        r.appendChild(c);
        return { row: r, ctl: c };
    }

    function _textInput(val, ph) {
        var inp = _el('input', 'ee-input');
        inp.type = 'text'; inp.value = val || '';
        if (ph) inp.placeholder = ph;
        return inp;
    }

    function _numInput(val, ph) {
        var inp = _el('input', 'ee-input ee-input-number');
        inp.type = 'number'; inp.value = (val != null) ? val : '';
        if (ph) inp.placeholder = ph;
        return inp;
    }

    function _header(titleText, closeFn) {
        var h = _el('div', 'ee-header');
        h.appendChild(_el('span', 'ee-header-title', titleText));
        var x = _btn('ee-close-btn', '\u00D7', closeFn);
        h.appendChild(x);
        return h;
    }

    // --- Styles ---

    function _injectStyles() {
        if (document.getElementById('ee-styles')) return;
        var s = _el('style'); s.id = 'ee-styles';
        s.textContent =
            '#eventEditorOverlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000}' +
            '#eventEditorModal{background:rgba(12,18,30,.98);border:1px solid #4a9eff;border-radius:8px;color:#e0e8f0;width:520px;max-height:80vh;overflow-y:auto;font-family:"Segoe UI",Arial,sans-serif;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,.7)}' +
            '.ee-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px 10px;border-bottom:1px solid #1a2a44}' +
            '.ee-header-title{font-size:15px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#8cb4e0}' +
            '.ee-close-btn{background:none;border:none;color:#667;font-size:20px;cursor:pointer;padding:0 4px;line-height:1}.ee-close-btn:hover{color:#ff6666}' +
            '.ee-body{padding:12px 18px 18px}' +
            '.ee-event-item{background:#0a1020;border:1px solid #1a2a44;border-radius:6px;padding:10px 14px;margin-bottom:10px;position:relative}.ee-event-item:hover{border-color:#2a4a6a}' +
            '.ee-event-name{font-weight:bold;color:#a0c4e8;font-size:13px;margin-bottom:4px}' +
            '.ee-event-desc{color:#7090b0;font-size:12px;font-family:monospace;line-height:1.5}' +
            '.ee-event-actions{position:absolute;top:8px;right:10px;display:flex;gap:6px}' +
            '.ee-btn{padding:5px 14px;border-radius:4px;border:1px solid #2a4a6a;background:#0e1a2e;color:#8cb4e0;font-size:12px;cursor:pointer;font-family:inherit}.ee-btn:hover{background:#142238;border-color:#4a9eff;color:#c0d8f0}' +
            '.ee-btn-primary{background:#1a3050;border-color:#4a9eff;color:#a0d0ff}.ee-btn-primary:hover{background:#244060}' +
            '.ee-btn-danger{border-color:#662222;color:#ff6666}.ee-btn-danger:hover{background:#2a1010;border-color:#993333}' +
            '.ee-btn-sm{padding:3px 10px;font-size:11px}' +
            '.ee-add-bar{text-align:right;margin-top:6px}' +
            '.ee-empty{color:#556;text-align:center;padding:24px 0;font-style:italic}' +
            '.ee-separator{border:none;border-top:1px solid #1a2a44;margin:14px 0 12px}' +
            '.ee-section-title{font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#4a9eff;margin:14px 0 8px}' +
            '.ee-row{display:flex;align-items:center;margin-bottom:8px}' +
            '.ee-label{width:130px;flex-shrink:0;color:#7090b0;font-size:12px}' +
            '.ee-control{flex:1;min-width:0}' +
            '.ee-input{width:100%;padding:5px 8px;background:#0a0e17;border:1px solid #1a2a44;border-radius:4px;color:#c0d8f0;font-size:12px;font-family:monospace;outline:none;box-sizing:border-box}.ee-input:focus{border-color:#4a9eff}' +
            '.ee-input-number{width:120px}' +
            '.ee-select{cursor:pointer;font-family:inherit}' +
            '.ee-cb-row{display:flex;align-items:center;margin-bottom:8px}.ee-cb-row label{color:#7090b0;font-size:12px;cursor:pointer;user-select:none}.ee-cb-row input[type=checkbox]{margin-right:6px}' +
            '.ee-button-bar{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}' +
            '.ee-coming-soon{color:#556;font-style:italic;padding:8px 0}';
        document.head.appendChild(s);
    }

    // --- List view ---

    function _renderListView() {
        _currentView = 'list';
        _modal.innerHTML = '';
        _modal.appendChild(_header('Scenario Events', hide));
        var body = _el('div', 'ee-body');

        var events = _scenarioData.events;
        if (!events.length) {
            body.appendChild(_el('div', 'ee-empty', 'No events defined. Click "+ Add Event" to create one.'));
        } else {
            for (var i = 0; i < events.length; i++) body.appendChild(_renderEventItem(events[i], i));
        }
        var bar = _el('div', 'ee-add-bar');
        bar.appendChild(_btn('ee-btn ee-btn-primary', '+ Add Event', function() { _editingIndex = -1; _renderEditView(null); }));
        body.appendChild(bar);
        _modal.appendChild(body);
    }

    function _renderEventItem(evt, idx) {
        var item = _el('div', 'ee-event-item');
        var name = _el('div', 'ee-event-name', evt.name ? _esc(evt.name) : 'Event ' + (idx + 1));
        if (evt.once === false) name.textContent += ' (repeating)';
        item.appendChild(name);

        var desc = _el('div', 'ee-event-desc');
        desc.textContent = 'WHEN: ' + _describeTrigger(evt.trigger);
        desc.appendChild(document.createElement('br'));
        desc.appendChild(document.createTextNode('THEN: ' + _describeAction(evt.action)));
        item.appendChild(desc);

        var acts = _el('div', 'ee-event-actions');
        acts.appendChild(_btn('ee-btn ee-btn-sm', 'Edit', (function(i) {
            return function() { _editingIndex = i; _renderEditView(_scenarioData.events[i]); };
        })(idx)));
        var del = _btn('ee-btn ee-btn-sm ee-btn-danger', '\u00D7', (function(i) {
            return function() { if (confirm('Delete this event?')) { _scenarioData.events.splice(i, 1); _renderListView(); } };
        })(idx));
        del.title = 'Delete event';
        acts.appendChild(del);
        item.appendChild(acts);
        return item;
    }

    // --- Edit view ---

    function _renderEditView(evt) {
        _currentView = 'edit';
        _modal.innerHTML = '';

        var isNew = !evt;
        if (!evt) evt = { id: 'event_' + Date.now(), name: '', once: true, trigger: { type: 'time', simTime_s: 0 }, action: { type: 'message', text: '' } };

        _modal.appendChild(_header(isNew ? 'New Event' : 'Edit Event', hide));
        var body = _el('div', 'ee-body');

        // Name
        var nameR = _row('Name'); var nameInp = _textInput(evt.name, 'Event name (optional)');
        nameR.ctl.appendChild(nameInp); body.appendChild(nameR.row);

        // Fire once
        var cbRow = _el('div', 'ee-cb-row'); var cbLbl = _el('label');
        var onceCb = document.createElement('input'); onceCb.type = 'checkbox'; onceCb.checked = evt.once !== false;
        cbLbl.appendChild(onceCb); cbLbl.appendChild(document.createTextNode(' Fire once'));
        cbRow.appendChild(cbLbl); body.appendChild(cbRow);

        // --- TRIGGER ---
        body.appendChild(_el('hr', 'ee-separator'));
        body.appendChild(_el('div', 'ee-section-title', 'Trigger'));

        var trigR = _row('Type'); var trigSel = _el('select', 'ee-input ee-select');
        ['time', 'proximity', 'detection', 'state_change'].forEach(function(t) {
            var o = _el('option', null, t); o.value = t;
            if (evt.trigger && evt.trigger.type === t) o.selected = true;
            trigSel.appendChild(o);
        });
        trigR.ctl.appendChild(trigSel); body.appendChild(trigR.row);

        var trigBox = _el('div'); body.appendChild(trigBox);
        var trigRefs = {};

        function buildTrigFields(type, d) {
            trigBox.innerHTML = ''; trigRefs = {}; d = d || {};
            if (type === 'time') {
                var r = _row('Time (seconds)'); var inp = _numInput(d.simTime_s, '0'); inp.min = '0';
                trigRefs.simTime_s = inp; r.ctl.appendChild(inp); trigBox.appendChild(r.row);
            } else if (type === 'proximity') {
                var rA = _row('Entity A'); trigRefs.entityA = _entitySelect(d.entityA); rA.ctl.appendChild(trigRefs.entityA); trigBox.appendChild(rA.row);
                var rB = _row('Entity B'); trigRefs.entityB = _entitySelect(d.entityB); rB.ctl.appendChild(trigRefs.entityB); trigBox.appendChild(rB.row);
                var rR = _row('Range (meters)'); trigRefs.range_m = _numInput(d.range_m, '1000'); trigRefs.range_m.min = '0'; rR.ctl.appendChild(trigRefs.range_m); trigBox.appendChild(rR.row);
            } else if (type === 'detection') {
                var rS = _row('Sensor Entity'); trigRefs.sensorEntity = _entitySelect(d.sensorEntity); rS.ctl.appendChild(trigRefs.sensorEntity); trigBox.appendChild(rS.row);
                var rT = _row('Target Entity'); trigRefs.targetEntity = _entitySelect(d.targetEntity); rT.ctl.appendChild(trigRefs.targetEntity); trigBox.appendChild(rT.row);
            } else if (type === 'state_change') {
                var rE = _row('Entity'); trigRefs.entity = _entitySelect(d.entity); rE.ctl.appendChild(trigRefs.entity); trigBox.appendChild(rE.row);
                var rF = _row('Field'); trigRefs.field = _textInput(d.field, 'e.g. engineOn'); rF.ctl.appendChild(trigRefs.field); trigBox.appendChild(rF.row);
                var rV = _row('Value'); trigRefs.value = _textInput(d.value, 'e.g. true'); rV.ctl.appendChild(trigRefs.value); trigBox.appendChild(rV.row);
            }
        }
        trigSel.addEventListener('change', function() { buildTrigFields(trigSel.value, {}); });
        buildTrigFields(evt.trigger ? evt.trigger.type : 'time', evt.trigger || {});

        // --- ACTION ---
        body.appendChild(_el('hr', 'ee-separator'));
        body.appendChild(_el('div', 'ee-section-title', 'Action'));

        var actR = _row('Type'); var actSel = _el('select', 'ee-input ee-select');
        ['set_state', 'message', 'change_rules', 'spawn_entity'].forEach(function(t) {
            var o = _el('option', null, t); o.value = t;
            if (evt.action && evt.action.type === t) o.selected = true;
            actSel.appendChild(o);
        });
        actR.ctl.appendChild(actSel); body.appendChild(actR.row);

        var actBox = _el('div'); body.appendChild(actBox);
        var actRefs = {};

        function buildActFields(type, d) {
            actBox.innerHTML = ''; actRefs = {}; d = d || {};
            if (type === 'set_state') {
                var rE = _row('Entity'); actRefs.entity = _entitySelect(d.entity); rE.ctl.appendChild(actRefs.entity); actBox.appendChild(rE.row);
                var rF = _row('Field'); actRefs.field = _textInput(d.field, 'e.g. speed'); rF.ctl.appendChild(actRefs.field); actBox.appendChild(rF.row);
                var rV = _row('Value'); actRefs.value = _textInput(d.value != null ? String(d.value) : '', 'e.g. 300'); rV.ctl.appendChild(actRefs.value); actBox.appendChild(rV.row);
            } else if (type === 'message') {
                var rM = _row('Message Text'); actRefs.text = _textInput(d.text, 'Enter message...'); rM.ctl.appendChild(actRefs.text); actBox.appendChild(rM.row);
            } else if (type === 'change_rules') {
                var rCE = _row('Entity'); actRefs.entity = _entitySelect(d.entity); rCE.ctl.appendChild(actRefs.entity); actBox.appendChild(rCE.row);
                var rCV = _row('Value'); var sel = _el('select', 'ee-input ee-select');
                ['weapons_free', 'weapons_tight', 'weapons_hold'].forEach(function(v) {
                    var o = _el('option', null, v); o.value = v;
                    if (d.value === v) o.selected = true; sel.appendChild(o);
                });
                actRefs.value = sel; rCV.ctl.appendChild(sel); actBox.appendChild(rCV.row);
            } else if (type === 'spawn_entity') {
                actBox.appendChild(_el('div', 'ee-coming-soon', 'Coming soon \u2014 spawn_entity is not yet implemented.'));
            }
        }
        actSel.addEventListener('change', function() { buildActFields(actSel.value, {}); });
        buildActFields(evt.action ? evt.action.type : 'set_state', evt.action || {});

        // --- Buttons ---
        var bar = _el('div', 'ee-button-bar');
        bar.appendChild(_btn('ee-btn', 'Cancel', function() { _renderListView(); }));
        bar.appendChild(_btn('ee-btn ee-btn-primary', 'Save', function() {
            // Build trigger
            var tType = trigSel.value, trigger = { type: tType };
            if (tType === 'time') trigger.simTime_s = parseFloat(trigRefs.simTime_s.value) || 0;
            else if (tType === 'proximity') { trigger.entityA = trigRefs.entityA.value; trigger.entityB = trigRefs.entityB.value; trigger.range_m = parseFloat(trigRefs.range_m.value) || 0; }
            else if (tType === 'detection') { trigger.sensorEntity = trigRefs.sensorEntity.value; trigger.targetEntity = trigRefs.targetEntity.value; }
            else if (tType === 'state_change') { trigger.entity = trigRefs.entity.value; trigger.field = trigRefs.field.value; trigger.value = trigRefs.value.value; }

            // Build action
            var aType = actSel.value, action = { type: aType };
            if (aType === 'set_state') { action.entity = actRefs.entity.value; action.field = actRefs.field.value; action.value = actRefs.value.value; }
            else if (aType === 'message') action.text = actRefs.text.value;
            else if (aType === 'change_rules') { action.entity = actRefs.entity.value; action.value = actRefs.value.value; }

            var newEvt = { id: evt.id || ('event_' + Date.now()), name: nameInp.value.trim(), once: onceCb.checked, trigger: trigger, action: action };
            if (_editingIndex >= 0 && _editingIndex < _scenarioData.events.length) _scenarioData.events[_editingIndex] = newEvt;
            else _scenarioData.events.push(newEvt);
            _renderListView();
        }));
        body.appendChild(bar);
        _modal.appendChild(body);
    }

    // --- Overlay / keyboard ---

    function _onKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            _currentView === 'edit' ? _renderListView() : hide();
        }
    }

    // --- Public API ---

    function init() { _injectStyles(); }

    function show(scenarioData) {
        if (!scenarioData) return;
        _scenarioData = scenarioData;
        if (!_scenarioData.events) _scenarioData.events = [];

        _overlay = _el('div'); _overlay.id = 'eventEditorOverlay';
        _overlay.addEventListener('click', function(e) { if (e.target === _overlay) hide(); });
        _modal = _el('div'); _modal.id = 'eventEditorModal';
        _overlay.appendChild(_modal);
        document.body.appendChild(_overlay);
        document.addEventListener('keydown', _onKeyDown, true);
        _editingIndex = -1;
        _renderListView();
    }

    function hide() {
        document.removeEventListener('keydown', _onKeyDown, true);
        if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        _overlay = null; _modal = null; _scenarioData = null;
        _editingIndex = -1; _currentView = 'list';
    }

    return { init: init, show: show, hide: hide };
})();
