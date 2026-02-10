/**
 * EntityTree - Bottom panel entity list with search/filter for the Scenario Builder.
 *
 * The entity rows in #entityTreeTable are created by builder_app.js (_doUpdateEntityListUI).
 * This module adds a filter bar that hides/shows rows based on a text query,
 * matching against entity name, type, and team (case-insensitive).
 *
 * Public API:
 *   EntityTree.initFilter()   — Wire up filter input events (call once on page load)
 *   EntityTree.applyFilter()  — Re-apply current filter to rows (call after row rebuild)
 *   EntityTree.clearFilter()  — Clear filter text and show all rows
 *   EntityTree.getFilterText() — Return current filter string
 */
var EntityTree = (function() {
    'use strict';

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _filterInput = null;
    var _clearBtn = null;
    var _matchCountEl = null;
    var _filterText = '';

    // -----------------------------------------------------------------------
    // Filter logic
    // -----------------------------------------------------------------------

    /**
     * Apply the current filter text to all .tree-row elements in #entityTreeTable.
     * Hides non-matching rows, updates the match count badge.
     */
    function _applyFilter() {
        var tableEl = document.getElementById('entityTreeTable');
        var countEl = document.getElementById('entityCount');
        if (!tableEl) return;

        var rows = tableEl.querySelectorAll('.tree-row');
        var query = _filterText.toLowerCase().trim();
        var total = rows.length;
        var matched = 0;

        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!query) {
                // No filter — show everything
                row.style.display = '';
                matched++;
                continue;
            }

            // Gather searchable text from the row's child spans
            var name = '';
            var type = '';
            var nameEl = row.querySelector('.tree-name');
            var typeEl = row.querySelector('.tree-type');
            if (nameEl) name = nameEl.textContent.toLowerCase();
            if (typeEl) type = typeEl.textContent.toLowerCase();

            // Also match against team via the dot class (team-blue, team-red, etc.)
            var dotEl = row.querySelector('.tree-team-dot');
            var team = '';
            if (dotEl) {
                var classes = dotEl.className;
                var teamMatch = classes.match(/team-(\w+)/);
                if (teamMatch) team = teamMatch[1].toLowerCase();
            }

            // Also match against the entity ID stored in data attribute
            var entityId = (row.getAttribute('data-entity-id') || '').toLowerCase();

            var haystack = name + ' ' + type + ' ' + team + ' ' + entityId;
            if (haystack.indexOf(query) !== -1) {
                row.style.display = '';
                matched++;
            } else {
                row.style.display = 'none';
            }
        }

        // Update match count display
        if (_matchCountEl) {
            if (query && total > 0) {
                _matchCountEl.textContent = '(' + matched + '/' + total + ')';
            } else {
                _matchCountEl.textContent = '';
            }
        }

        // Update the main entity count badge with filter info
        if (countEl && query && total > 0) {
            countEl.textContent = matched + '/' + total + ' entit' + (total === 1 ? 'y' : 'ies');
        }

        // Show/hide clear button
        if (_clearBtn) {
            _clearBtn.style.display = query ? 'flex' : 'none';
        }

        // Show/hide the empty message
        var emptyEl = document.getElementById('treeEmptyMsg');
        if (emptyEl) {
            if (total === 0) {
                emptyEl.style.display = 'flex';
            } else if (query && matched === 0) {
                emptyEl.style.display = 'flex';
                emptyEl.textContent = 'No entities match "' + _filterText.trim() + '"';
            } else {
                emptyEl.style.display = 'none';
            }
        }
    }

    /**
     * Handle input event on the filter field.
     */
    function _onFilterInput() {
        _filterText = _filterInput ? _filterInput.value : '';
        _applyFilter();
    }

    /**
     * Clear the filter and show all rows.
     */
    function _clearFilter() {
        _filterText = '';
        if (_filterInput) {
            _filterInput.value = '';
        }
        _applyFilter();
        // Restore the original empty message with guidance
        var emptyEl = document.getElementById('treeEmptyMsg');
        if (emptyEl) {
            emptyEl.innerHTML =
                '<div class="empty-state-guidance">' +
                '<div class="empty-state-title">No entities in scenario</div>' +
                '<div class="empty-state-step">1. Click an entity from the palette on the left, then click the globe to place it.</div>' +
                '<div class="empty-state-step">2. Or load a template from the <b>Demo</b> menu above.</div>' +
                '<div class="empty-state-tip">Tip: Right-click entities for options (focus, duplicate, delete).</div>' +
                '</div>';
        }
    }

    /**
     * Handle Escape key in the filter input to clear filter.
     */
    function _onFilterKeyDown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            _clearFilter();
            _filterInput.blur();
        }
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    return {
        /**
         * Wire up the filter input events. Call once after DOM is ready.
         * Expects these elements to exist in the HTML:
         *   #entityFilterInput  — the text input
         *   #entityFilterClear  — the X clear button
         *   #entityFilterCount  — the match count span
         */
        initFilter: function() {
            _filterInput = document.getElementById('entityFilterInput');
            _clearBtn = document.getElementById('entityFilterClear');
            _matchCountEl = document.getElementById('entityFilterCount');

            if (!_filterInput) {
                console.warn('[EntityTree] Filter input #entityFilterInput not found');
                return;
            }

            _filterInput.addEventListener('input', _onFilterInput);
            _filterInput.addEventListener('keydown', _onFilterKeyDown);

            if (_clearBtn) {
                _clearBtn.addEventListener('click', function() {
                    _clearFilter();
                    _filterInput.focus();
                });
            }
        },

        /**
         * Re-apply the current filter to the rows in #entityTreeTable.
         * Call this after builder_app.js rebuilds the entity rows.
         */
        applyFilter: function() {
            _applyFilter();
        },

        /**
         * Clear the filter text and show all rows.
         */
        clearFilter: function() {
            _clearFilter();
        },

        /**
         * Return the current filter string.
         * @returns {string}
         */
        getFilterText: function() {
            return _filterText;
        }
    };
})();
