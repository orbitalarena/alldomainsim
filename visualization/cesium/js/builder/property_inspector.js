/**
 * PropertyInspector - Right sidebar for editing the selected entity's
 * properties: identity, position, state, and components.
 */
var PropertyInspector = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _container = null;
    var _currentEntityId = null;
    var _readOnly = false;
    var _debounceTimers = {};
    var _previousValues = {};  // cache previous valid values per field for NaN fallback

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /** Debounced callback — avoids flooding updates while the user types. */
    function _debounce(key, fn, delay) {
        if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
        _debounceTimers[key] = setTimeout(fn, delay || 120);
    }

    /** Look up the live entity definition from the scenario. */
    function _getEntityDef(id) {
        if (typeof BuilderApp === 'undefined') return null;
        var data = BuilderApp.getScenarioData();
        if (!data || !data.entities) return null;
        for (var i = 0; i < data.entities.length; i++) {
            if (data.entities[i].id === id) return data.entities[i];
        }
        return null;
    }

    /** Push a change to BuilderApp. */
    function _pushChange(changes) {
        if (!_currentEntityId || _readOnly) return;
        if (typeof BuilderApp !== 'undefined') {
            BuilderApp.updateEntityDef(_currentEntityId, changes);
        }
    }

    /** Create a labeled form row. */
    function _createRow(labelText) {
        var row = document.createElement('div');
        row.className = 'inspector-row';

        var label = document.createElement('label');
        label.className = 'inspector-label';
        label.textContent = labelText;
        row.appendChild(label);

        var valueCell = document.createElement('div');
        valueCell.className = 'inspector-value';
        row.appendChild(valueCell);

        return { row: row, valueCell: valueCell };
    }

    /** Create a generic input element. */
    function _createInput(type, value, onChange) {
        var input = document.createElement('input');
        input.type = type;
        if (value !== undefined && value !== null) {
            input.value = value;
        }
        input.className = 'inspector-input';
        if (_readOnly) input.disabled = true;
        if (onChange) {
            input.addEventListener('input', onChange);
        }
        return input;
    }

    /** Create a read-only text span. */
    function _createReadOnlyText(text) {
        var span = document.createElement('span');
        span.className = 'inspector-readonly';
        span.textContent = text;
        return span;
    }

    // -----------------------------------------------------------------------
    // Numeric input validation
    // -----------------------------------------------------------------------

    /** Validation rules for numeric fields. */
    var _validationRules = {
        lat:      { min: -90,  max: 90,  wrap: false },
        lon:      { min: -180, max: 180, wrap: false },
        alt:      { min: 0,    max: null, wrap: false },
        speed:    { min: 0,    max: null, wrap: false },
        heading:  { min: 0,    max: 360, wrap: true  },
        gamma:    { min: -90,  max: 90,  wrap: false },
        throttle: { min: 0,    max: 1,   wrap: false }
    };

    /**
     * Validate and correct a numeric value per field rules.
     * Returns { value: correctedNumber, corrected: boolean }.
     * If the raw string parses to NaN, uses prevValue (or 0).
     */
    function _validateNumeric(fieldName, rawValue, prevValue) {
        var val = parseFloat(rawValue);
        var rule = _validationRules[fieldName];
        var corrected = false;

        // NaN guard — revert to previous value or 0
        if (isNaN(val)) {
            return { value: (prevValue !== undefined && !isNaN(prevValue)) ? prevValue : 0, corrected: true };
        }

        if (!rule) return { value: val, corrected: false };

        if (rule.wrap && rule.min !== null && rule.max !== null) {
            // Wrap into [min, max) — used for heading
            var range = rule.max - rule.min;
            while (val < rule.min) val += range;
            while (val >= rule.max) val -= range;
            if (val !== parseFloat(rawValue)) corrected = true;
        } else {
            // Clamp
            if (rule.min !== null && val < rule.min) { val = rule.min; corrected = true; }
            if (rule.max !== null && val > rule.max) { val = rule.max; corrected = true; }
        }

        return { value: val, corrected: corrected };
    }

    /** Flash the input border red briefly to signal auto-correction. */
    function _flashInvalid(inputEl) {
        inputEl.classList.add('pi-invalid');
        setTimeout(function() {
            inputEl.classList.remove('pi-invalid');
        }, 400);
    }

    /**
     * Create a validated numeric input change handler.
     * @param {string} fieldName   - Validation rule key (lat, lon, alt, etc.)
     * @param {HTMLInputElement} inputEl - The input element
     * @param {function} onValid   - Callback with corrected numeric value
     */
    function _makeValidatedHandler(fieldName, inputEl, onValid) {
        return function() {
            var prev = _previousValues[fieldName];
            var result = _validateNumeric(fieldName, inputEl.value, prev);

            if (result.corrected) {
                _flashInvalid(inputEl);
                // Update the input to show the corrected value after a brief delay
                // so the user sees the flash alongside the correction
                var correctedVal = result.value;
                setTimeout(function() {
                    inputEl.value = correctedVal;
                }, 200);
            }

            _previousValues[fieldName] = result.value;
            onValid(result.value);
        };
    }

    /** Create a select dropdown. */
    function _createSelect(options, selected, onChange) {
        var sel = document.createElement('select');
        sel.className = 'inspector-input inspector-select';
        if (_readOnly) sel.disabled = true;
        for (var i = 0; i < options.length; i++) {
            var opt = document.createElement('option');
            opt.value = options[i].value;
            opt.textContent = options[i].label;
            if (options[i].value === selected) opt.selected = true;
            sel.appendChild(opt);
        }
        if (onChange) {
            sel.addEventListener('change', onChange);
        }
        return sel;
    }

    /** Create a checkbox with label. */
    function _createCheckbox(checked, labelText, onChange) {
        var wrapper = document.createElement('label');
        wrapper.className = 'inspector-checkbox-label';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!checked;
        cb.className = 'inspector-checkbox';
        if (_readOnly) cb.disabled = true;
        if (onChange) {
            cb.addEventListener('change', onChange);
        }
        wrapper.appendChild(cb);
        var span = document.createElement('span');
        span.textContent = ' ' + labelText;
        wrapper.appendChild(span);
        return wrapper;
    }

    /** Create a range slider with numeric readout. */
    function _createSlider(min, max, step, value, onChange) {
        var wrapper = document.createElement('div');
        wrapper.className = 'inspector-slider-wrap';

        var slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min;
        slider.max = max;
        slider.step = step;
        slider.value = value;
        slider.className = 'inspector-slider';
        if (_readOnly) slider.disabled = true;

        var readout = document.createElement('span');
        readout.className = 'inspector-slider-readout';
        readout.textContent = parseFloat(value).toFixed(2);

        slider.addEventListener('input', function() {
            readout.textContent = parseFloat(slider.value).toFixed(2);
            if (onChange) onChange(parseFloat(slider.value));
        });

        wrapper.appendChild(slider);
        wrapper.appendChild(readout);
        return wrapper;
    }

    /** Create a collapsible section with title. */
    function _createSection(title, initiallyOpen) {
        var section = document.createElement('div');
        section.className = 'inspector-section';

        var header = document.createElement('div');
        header.className = 'inspector-section-header';

        var arrow = document.createElement('span');
        arrow.className = 'inspector-section-arrow';
        arrow.textContent = initiallyOpen ? '\u25BC' : '\u25B6';

        var label = document.createElement('span');
        label.textContent = ' ' + title;

        header.appendChild(arrow);
        header.appendChild(label);

        var body = document.createElement('div');
        body.className = 'inspector-section-body';
        if (!initiallyOpen) body.style.display = 'none';

        header.addEventListener('click', function() {
            var hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            arrow.textContent = hidden ? '\u25BC' : '\u25B6';
        });

        section.appendChild(header);
        section.appendChild(body);

        return { section: section, body: body };
    }

    // -----------------------------------------------------------------------
    // Section builders
    // -----------------------------------------------------------------------

    /** Identity: name, id, type, team. */
    function _buildIdentitySection(def) {
        var sec = _createSection('Identity', true);

        // Name
        var nameRow = _createRow('Name');
        var nameInput = _createInput('text', def.name, function() {
            var val = nameInput.value;
            _debounce('name', function() {
                _pushChange({ name: val });
            });
        });
        nameRow.valueCell.appendChild(nameInput);
        sec.body.appendChild(nameRow.row);

        // ID (read-only)
        var idRow = _createRow('ID');
        idRow.valueCell.appendChild(_createReadOnlyText(def.id));
        sec.body.appendChild(idRow.row);

        // Type (read-only)
        var typeRow = _createRow('Type');
        typeRow.valueCell.appendChild(_createReadOnlyText(def.type || 'unknown'));
        sec.body.appendChild(typeRow.row);

        // Team
        var teamRow = _createRow('Team');
        var teamSelect = _createSelect(
            [
                { value: 'blue', label: 'Blue' },
                { value: 'red', label: 'Red' },
                { value: 'neutral', label: 'Neutral' }
            ],
            def.team || 'neutral',
            function() {
                _pushChange({ team: teamSelect.value });
            }
        );
        teamRow.valueCell.appendChild(teamSelect);
        sec.body.appendChild(teamRow.row);

        return sec.section;
    }

    /** Position: lat, lon, alt. */
    function _buildPositionSection(def) {
        var sec = _createSection('Position', true);
        var state = def.initialState || {};

        // Lat
        var latRow = _createRow('Lat (\u00B0)');
        var latInitial = state.lat !== undefined ? state.lat : 0;
        _previousValues['lat'] = latInitial;
        var latInput = _createInput('number', latInitial, null);
        latInput.step = '0.01';
        latInput.min = '-90';
        latInput.max = '90';
        latInput.addEventListener('input', _makeValidatedHandler('lat', latInput, function(val) {
            _debounce('lat', function() {
                _pushChange({ initialState: { lat: val } });
            });
        }));
        latRow.valueCell.appendChild(latInput);
        sec.body.appendChild(latRow.row);

        // Lon
        var lonRow = _createRow('Lon (\u00B0)');
        var lonInitial = state.lon !== undefined ? state.lon : 0;
        _previousValues['lon'] = lonInitial;
        var lonInput = _createInput('number', lonInitial, null);
        lonInput.step = '0.01';
        lonInput.min = '-180';
        lonInput.max = '180';
        lonInput.addEventListener('input', _makeValidatedHandler('lon', lonInput, function(val) {
            _debounce('lon', function() {
                _pushChange({ initialState: { lon: val } });
            });
        }));
        lonRow.valueCell.appendChild(lonInput);
        sec.body.appendChild(lonRow.row);

        // Alt
        var altRow = _createRow('Alt (m)');
        var altInitial = state.alt !== undefined ? state.alt : 0;
        _previousValues['alt'] = altInitial;
        var altInput = _createInput('number', altInitial, null);
        altInput.step = '100';
        altInput.min = '0';
        altInput.addEventListener('input', _makeValidatedHandler('alt', altInput, function(val) {
            _debounce('alt', function() {
                _pushChange({ initialState: { alt: val } });
            });
        }));
        altRow.valueCell.appendChild(altInput);
        sec.body.appendChild(altRow.row);

        return sec.section;
    }

    /** State: speed, heading, gamma, throttle, engine. */
    function _buildStateSection(def) {
        var state = def.initialState || {};
        // Only show state for entities that move (aircraft / satellite)
        if (def.type === 'ground') return null;

        var sec = _createSection('State', true);

        // Speed
        var speedRow = _createRow('Speed (m/s)');
        var speedInitial = state.speed !== undefined ? state.speed : 0;
        _previousValues['speed'] = speedInitial;
        var speedInput = _createInput('number', speedInitial, null);
        speedInput.step = '10';
        speedInput.min = '0';
        speedInput.addEventListener('input', _makeValidatedHandler('speed', speedInput, function(val) {
            _debounce('speed', function() {
                _pushChange({ initialState: { speed: val } });
            });
        }));
        speedRow.valueCell.appendChild(speedInput);
        sec.body.appendChild(speedRow.row);

        // Heading
        var hdgRow = _createRow('Heading (\u00B0)');
        var hdgInitial = state.heading !== undefined ? state.heading : 0;
        _previousValues['heading'] = hdgInitial;
        var hdgInput = _createInput('number', hdgInitial, null);
        hdgInput.step = '1';
        hdgInput.min = '0';
        hdgInput.max = '360';
        hdgInput.addEventListener('input', _makeValidatedHandler('heading', hdgInput, function(val) {
            _debounce('heading', function() {
                _pushChange({ initialState: { heading: val } });
            });
        }));
        hdgRow.valueCell.appendChild(hdgInput);
        sec.body.appendChild(hdgRow.row);

        // Gamma (flight path angle)
        var gammaRow = _createRow('Gamma (\u00B0)');
        var gammaInitial = state.gamma !== undefined ? state.gamma : 0;
        _previousValues['gamma'] = gammaInitial;
        var gammaInput = _createInput('number', gammaInitial, null);
        gammaInput.step = '1';
        gammaInput.min = '-90';
        gammaInput.max = '90';
        gammaInput.addEventListener('input', _makeValidatedHandler('gamma', gammaInput, function(val) {
            _debounce('gamma', function() {
                _pushChange({ initialState: { gamma: val } });
            });
        }));
        gammaRow.valueCell.appendChild(gammaInput);
        sec.body.appendChild(gammaRow.row);

        // Throttle (slider)
        if (def.type === 'aircraft') {
            var thrRow = _createRow('Throttle');
            var thrSlider = _createSlider(0, 1, 0.01, state.throttle !== undefined ? state.throttle : 0.5, function(val) {
                _debounce('throttle', function() {
                    _pushChange({ initialState: { throttle: val } });
                });
            });
            thrRow.valueCell.appendChild(thrSlider);
            sec.body.appendChild(thrRow.row);

            // Engine on/off
            var engRow = _createRow('Engine');
            var engCb = _createCheckbox(state.engineOn !== undefined ? state.engineOn : true, 'ON', function() {
                var cb = engCb.querySelector('input[type="checkbox"]');
                _pushChange({ initialState: { engineOn: cb.checked } });
            });
            engRow.valueCell.appendChild(engCb);
            sec.body.appendChild(engRow.row);
        }

        return sec.section;
    }

    /** Components: read-only display of physics, control, visual configs. */
    function _buildComponentsSection(def) {
        var comps = def.components;
        if (!comps) return null;

        var sec = _createSection('Components', false);
        var keys = Object.keys(comps);

        for (var k = 0; k < keys.length; k++) {
            var compName = keys[k];
            var comp = comps[compName];
            if (!comp) continue;

            // Sub-section per component
            var summary = comp.type || 'unknown';
            if (comp.config) summary += ' (' + comp.config + ')';
            var sub = _createSection(compName.charAt(0).toUpperCase() + compName.slice(1) + ': ' + summary, false);

            // Key-value pairs
            var compKeys = Object.keys(comp);
            for (var j = 0; j < compKeys.length; j++) {
                var row = _createRow(compKeys[j]);
                var val = comp[compKeys[j]];
                var displayVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
                row.valueCell.appendChild(_createReadOnlyText(displayVal));
                sub.body.appendChild(row.row);
            }

            sec.body.appendChild(sub.section);
        }

        return sec.section;
    }

    // -----------------------------------------------------------------------
    // Main render
    // -----------------------------------------------------------------------

    /** Render the empty / deselected state. */
    function _renderEmpty() {
        if (!_container) return;
        _container.innerHTML = '';

        var title = document.createElement('div');
        title.className = 'inspector-title';
        title.textContent = 'Properties';
        _container.appendChild(title);

        var msg = document.createElement('div');
        msg.className = 'inspector-empty';
        msg.textContent = 'Select an entity to edit properties';
        _container.appendChild(msg);
    }

    /** Render inspector for a specific entity definition. */
    function _renderEntity(def) {
        if (!_container) return;
        _container.innerHTML = '';

        // Title
        var title = document.createElement('div');
        title.className = 'inspector-title';
        title.textContent = 'Properties';
        _container.appendChild(title);

        // Entity header with icon and name
        var header = document.createElement('div');
        header.className = 'inspector-entity-header';

        var dot = document.createElement('span');
        dot.className = 'inspector-entity-dot';
        var teamColor = def.team === 'blue' ? '#4488ff' : def.team === 'red' ? '#ff4444' : '#aaaaaa';
        if (def.components && def.components.visual && def.components.visual.color) {
            dot.style.background = def.components.visual.color;
        } else {
            dot.style.background = teamColor;
        }
        header.appendChild(dot);

        var headerName = document.createElement('span');
        headerName.className = 'inspector-entity-name';
        headerName.textContent = def.name || def.id;
        header.appendChild(headerName);

        _container.appendChild(header);

        // Sections
        _container.appendChild(_buildIdentitySection(def));
        _container.appendChild(_buildPositionSection(def));

        var stateSection = _buildStateSection(def);
        if (stateSection) _container.appendChild(stateSection);

        var compSection = _buildComponentsSection(def);
        if (compSection) _container.appendChild(compSection);

        // Delete button at bottom
        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'inspector-delete-btn';
        deleteBtn.textContent = 'Remove Entity';
        if (_readOnly) deleteBtn.disabled = true;
        deleteBtn.addEventListener('click', function() {
            if (!_currentEntityId) return;
            if (typeof BuilderApp !== 'undefined') {
                BuilderApp.removeEntity(_currentEntityId);
            }
        });
        _container.appendChild(deleteBtn);
    }

    // -----------------------------------------------------------------------
    // Inject scoped CSS
    // -----------------------------------------------------------------------
    function _injectStyles() {
        if (document.getElementById('property-inspector-styles')) return;
        var style = document.createElement('style');
        style.id = 'property-inspector-styles';
        style.textContent = [
            '.inspector-title { font-size: 14px; font-weight: bold; color: #ccc; padding: 8px 10px 4px; text-transform: uppercase; letter-spacing: 1px; }',
            '.inspector-empty { color: #666; font-size: 12px; padding: 20px 10px; text-align: center; font-style: italic; }',
            '.inspector-entity-header { display: flex; align-items: center; padding: 6px 10px; background: #141428; margin-bottom: 4px; }',
            '.inspector-entity-dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }',
            '.inspector-entity-name { color: #fff; font-size: 14px; font-weight: bold; }',
            '.inspector-section { margin-bottom: 2px; }',
            '.inspector-section-header { padding: 5px 10px; cursor: pointer; color: #aaa; font-size: 12px; font-weight: bold; background: #141428; user-select: none; }',
            '.inspector-section-header:hover { background: #1a1a36; color: #ddd; }',
            '.inspector-section-arrow { display: inline-block; width: 12px; font-size: 10px; }',
            '.inspector-section-body { padding: 2px 0; }',
            '.inspector-row { display: flex; align-items: center; padding: 3px 10px 3px 18px; min-height: 26px; }',
            '.inspector-label { width: 80px; flex-shrink: 0; color: #888; font-size: 11px; text-transform: capitalize; }',
            '.inspector-value { flex: 1; min-width: 0; }',
            '.inspector-input { width: 100%; padding: 3px 6px; background: #1a1a2e; border: 1px solid #333; border-radius: 3px; color: #ccc; font-size: 12px; outline: none; box-sizing: border-box; }',
            '.inspector-input:focus { border-color: #4488ff; }',
            '.inspector-input.pi-invalid { border-color: #ff4444; transition: border-color 0.3s; }',
            '.inspector-input:disabled { opacity: 0.5; cursor: not-allowed; }',
            '.inspector-select { cursor: pointer; }',
            '.inspector-readonly { color: #666; font-size: 12px; }',
            '.inspector-checkbox-label { color: #ccc; font-size: 12px; cursor: pointer; user-select: none; }',
            '.inspector-checkbox { margin-right: 2px; }',
            '.inspector-slider-wrap { display: flex; align-items: center; gap: 6px; }',
            '.inspector-slider { flex: 1; -webkit-appearance: none; appearance: none; height: 4px; background: #333; border-radius: 2px; outline: none; }',
            '.inspector-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #4488ff; cursor: pointer; }',
            '.inspector-slider:disabled::-webkit-slider-thumb { background: #555; cursor: not-allowed; }',
            '.inspector-slider-readout { width: 36px; text-align: right; color: #aaa; font-size: 11px; font-family: monospace; }',
            '.inspector-delete-btn { display: block; width: calc(100% - 20px); margin: 12px 10px; padding: 6px; background: #3a1515; border: 1px solid #662222; border-radius: 3px; color: #ff6666; font-size: 12px; cursor: pointer; text-align: center; }',
            '.inspector-delete-btn:hover { background: #4a1a1a; border-color: #883333; }',
            '.inspector-delete-btn:disabled { opacity: 0.4; cursor: not-allowed; }'
        ].join('\n');
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Initialize the inspector into a DOM container.
         * @param {string} containerId - ID of the parent element.
         */
        init: function(containerId) {
            _container = document.getElementById(containerId);
            if (!_container) {
                console.error('[PropertyInspector] Container not found: ' + containerId);
                return;
            }
            _injectStyles();
            _renderEmpty();
        },

        /**
         * Show and populate the inspector for the given entity definition.
         * @param {object} entityDef - Full entity definition from scenario JSON.
         */
        showEntity: function(entityDef) {
            if (!entityDef) {
                this.clear();
                return;
            }
            _currentEntityId = entityDef.id;
            _renderEntity(entityDef);
        },

        /** Clear the inspector and show the empty placeholder. */
        clear: function() {
            _currentEntityId = null;
            _renderEmpty();
        },

        /** Re-render the current entity (call after external changes). */
        refresh: function() {
            if (!_currentEntityId) {
                _renderEmpty();
                return;
            }
            var def = _getEntityDef(_currentEntityId);
            if (def) {
                _renderEntity(def);
            } else {
                // Entity was removed
                _currentEntityId = null;
                _renderEmpty();
            }
        },

        /**
         * Enable or disable editing (e.g., disable in RUN mode).
         * @param {boolean} readOnly
         */
        setReadOnly: function(readOnly) {
            _readOnly = !!readOnly;
            this.refresh();
        }
    };
})();
