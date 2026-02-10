/**
 * Computer component — onboard computer that can be hacked via the cyber cockpit terminal.
 *
 * Every platform has an onboard computer with an OS, hardening level, patch level, and
 * firewall rating. When compromised by a cyber actor, the attacker gains control over
 * subsystems (sensors, navigation, weapons, comms) depending on access level.
 *
 * The computer calculates its vulnerability based on OS type, patch level, and hardening.
 * When hacked, subsystem effects are applied to entity.state flags that other components
 * (sensors, weapons, AI, comms) can read and respect.
 *
 * Self-healing: when no longer compromised, hacked subsystems recover at 1% per second.
 *
 * Config (from scenario JSON):
 *   type: "computer"
 *   os: "mil_spec"                — mil_spec, linux_hardened, vxworks, windows_embedded, custom
 *   hardening: 0.5                — 0-1, difficulty to hack
 *   patchLevel: 0.5               — 0-1, higher = fewer vulnerabilities
 *   firewallRating: 0.5           — 0-1, network access protection
 *   hackableSubsystems: ["sensors", "navigation", "weapons", "comms"]
 *
 * State outputs on entity.state:
 *   _computerOS               — OS type string
 *   _computerHardening        — hardening value
 *   _computerPatchLevel       — patch level value
 *   _computerFirewallRating   — firewall rating value
 *   _computerCompromised      — boolean, set by cyber cockpit
 *   _computerAccessLevel      — NONE/USER/ROOT/PERSISTENT
 *   _computerHackedSubsystems — { sensors: true, navigation: false, ... }
 *   _sensorDisabled           — forced off by hacker
 *   _sensorRedirected         — forced to look away
 *   _navigationHijacked       — heading/course altered
 *   _weaponsDisabled          — can't fire
 *   _commsDisabled            — radio silence forced
 *   _dataExfiltrated          — intelligence being stolen
 *   _fullControl              — complete platform takeover
 *
 * Registers as: cyber/computer
 */
(function() {
    'use strict';

    // --- OS base vulnerability values ---
    var OS_VULNERABILITY = {
        'windows_embedded': 0.40,
        'custom':           0.30,
        'vxworks':          0.25,
        'linux_hardened':   0.20,
        'mil_spec':         0.15
    };

    // --- Access levels (ordered by severity) ---
    var ACCESS_NONE       = 'NONE';
    var ACCESS_USER       = 'USER';
    var ACCESS_ROOT       = 'ROOT';
    var ACCESS_PERSISTENT = 'PERSISTENT';

    // --- Self-healing rate ---
    var HEAL_RATE_PER_SEC = 0.01;   // 1% recovery per second per subsystem

    // --- Valid subsystem names ---
    var VALID_SUBSYSTEMS = ['sensors', 'navigation', 'weapons', 'comms'];

    // --- Default hackable subsystems ---
    var DEFAULT_SUBSYSTEMS = ['sensors', 'navigation', 'weapons', 'comms'];

    // -----------------------------------------------------------------------
    // Computer Component
    // -----------------------------------------------------------------------
    class Computer extends ECS.Component {
        constructor(config) {
            super(config);

            // Config with defaults
            this._os              = config.os || 'mil_spec';
            this._hardening       = config.hardening !== undefined ? config.hardening : 0.5;
            this._patchLevel      = config.patchLevel !== undefined ? config.patchLevel : 0.5;
            this._firewallRating  = config.firewallRating !== undefined ? config.firewallRating : 0.5;
            this._hackableSubsystems = config.hackableSubsystems
                ? config.hackableSubsystems.slice()
                : DEFAULT_SUBSYSTEMS.slice();

            // Validate OS type
            if (!OS_VULNERABILITY.hasOwnProperty(this._os)) {
                this._os = 'mil_spec';
            }

            // Clamp numeric values to 0-1
            this._hardening      = Math.max(0, Math.min(1, this._hardening));
            this._patchLevel     = Math.max(0, Math.min(1, this._patchLevel));
            this._firewallRating = Math.max(0, Math.min(1, this._firewallRating));

            // Filter to valid subsystems only
            this._hackableSubsystems = this._hackableSubsystems.filter(function(s) {
                return VALID_SUBSYSTEMS.indexOf(s) >= 0;
            });

            // Internal healing accumulators per subsystem
            this._healProgress = {};

            // Graduated degradation per subsystem (0.0 = normal, 1.0 = fully disabled)
            this._degradation = {
                sensors: 0,      // 0-1: reduces radar range and detection probability
                navigation: 0,   // 0-1: adds position drift/offset
                weapons: 0,      // 0-1: increases miss probability
                comms: 0         // 0-1: increases latency and packet loss
            };
        }

        init(world) {
            var state = this.entity.state;

            // Computer identity
            state._computerOS             = this._os;
            state._computerHardening      = this._hardening;
            state._computerPatchLevel     = this._patchLevel;
            state._computerFirewallRating = this._firewallRating;

            // Compromise state (set externally by cyber cockpit / cyber_actor)
            state._computerCompromised      = false;
            state._computerAccessLevel      = ACCESS_NONE;
            state._computerHackedSubsystems = {};

            // Initialize all hackable subsystems as not hacked
            for (var i = 0; i < this._hackableSubsystems.length; i++) {
                state._computerHackedSubsystems[this._hackableSubsystems[i]] = false;
            }

            // Effect flags (read by other components)
            state._sensorDisabled      = false;
            state._sensorRedirected    = false;
            state._navigationHijacked  = false;
            state._weaponsDisabled     = false;
            state._commsDisabled       = false;
            state._dataExfiltrated     = false;
            state._fullControl         = false;

            // Graduated degradation state (read by sensors, weapons, etc.)
            state._cyberDegradation = {
                sensors: 0,
                navigation: 0,
                weapons: 0,
                comms: 0
            };

            // Reset internal degradation tracking
            this._degradation = {
                sensors: 0,
                navigation: 0,
                weapons: 0,
                comms: 0
            };

            // Reset healing accumulators
            this._healProgress = {};
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;

            var state = entity.state;

            // --- Compromised: apply hacked subsystem effects ---
            if (state._computerCompromised &&
                (state._computerAccessLevel === ACCESS_ROOT ||
                 state._computerAccessLevel === ACCESS_PERSISTENT)) {

                this._applyHackedEffects(state);

                // Reset healing progress while compromised
                this._healProgress = {};

            } else {
                // --- Not compromised: self-healing recovery ---
                this._selfHeal(dt, state);
            }

            // --- Sync graduated degradation to entity state ---
            state._cyberDegradation = {
                sensors:    this._degradation.sensors,
                navigation: this._degradation.navigation,
                weapons:    this._degradation.weapons,
                comms:      this._degradation.comms
            };

            // --- When degradation reaches 1.0, set the corresponding full-disable flag ---
            if (this._degradation.sensors >= 1.0) {
                state._sensorDisabled = true;
            }
            if (this._degradation.navigation >= 1.0) {
                state._navigationHijacked = true;
            }
            if (this._degradation.weapons >= 1.0) {
                state._weaponsDisabled = true;
            }
            if (this._degradation.comms >= 1.0) {
                state._commsDisabled = true;
            }
        }

        /**
         * Apply subsystem effects based on which subsystems are hacked.
         * Only applies when access level is ROOT or PERSISTENT.
         */
        _applyHackedEffects(state) {
            var hacked = state._computerHackedSubsystems;
            var allHacked = true;

            // Sensors
            if (hacked.sensors) {
                state._sensorDisabled   = true;
                state._sensorRedirected = true;
            } else {
                state._sensorDisabled   = false;
                state._sensorRedirected = false;
                if (this._hackableSubsystems.indexOf('sensors') >= 0) {
                    allHacked = false;
                }
            }

            // Navigation
            if (hacked.navigation) {
                state._navigationHijacked = true;
            } else {
                state._navigationHijacked = false;
                if (this._hackableSubsystems.indexOf('navigation') >= 0) {
                    allHacked = false;
                }
            }

            // Weapons
            if (hacked.weapons) {
                state._weaponsDisabled = true;
            } else {
                state._weaponsDisabled = false;
                if (this._hackableSubsystems.indexOf('weapons') >= 0) {
                    allHacked = false;
                }
            }

            // Comms
            if (hacked.comms) {
                state._commsDisabled   = true;
                state._dataExfiltrated = true;
            } else {
                state._commsDisabled   = false;
                state._dataExfiltrated = false;
                if (this._hackableSubsystems.indexOf('comms') >= 0) {
                    allHacked = false;
                }
            }

            // Full control if ALL hackable subsystems are compromised
            state._fullControl = allHacked && this._hackableSubsystems.length > 0;
        }

        /**
         * Self-healing: when not compromised, gradually clear hacked subsystems.
         * Each subsystem recovers independently at HEAL_RATE_PER_SEC (1% per second).
         * Once healing reaches 100%, the subsystem is restored.
         */
        _selfHeal(dt, state) {
            var hacked = state._computerHackedSubsystems;
            var anyStillHacked = false;

            for (var i = 0; i < this._hackableSubsystems.length; i++) {
                var sub = this._hackableSubsystems[i];

                // Heal degradation when not compromised
                if (this._degradation[sub] !== undefined && this._degradation[sub] > 0) {
                    this._degradation[sub] = Math.max(0, this._degradation[sub] - HEAL_RATE_PER_SEC * dt);
                }

                if (hacked[sub]) {
                    // Accumulate healing progress
                    if (!this._healProgress[sub]) {
                        this._healProgress[sub] = 0;
                    }
                    this._healProgress[sub] += HEAL_RATE_PER_SEC * dt;

                    if (this._healProgress[sub] >= 1.0) {
                        // Subsystem fully recovered
                        hacked[sub] = false;
                        this._healProgress[sub] = 0;
                    } else {
                        anyStillHacked = true;
                    }
                }
            }

            // Clear effect flags for recovered subsystems
            if (!hacked.sensors) {
                state._sensorDisabled   = false;
                state._sensorRedirected = false;
            }
            if (!hacked.navigation) {
                state._navigationHijacked = false;
            }
            if (!hacked.weapons) {
                state._weaponsDisabled = false;
            }
            if (!hacked.comms) {
                state._commsDisabled   = false;
                state._dataExfiltrated = false;
            }

            // Full control requires all subsystems hacked — clear if any recovered
            if (!anyStillHacked) {
                state._fullControl = false;
            } else {
                // Re-check: are ALL subsystems still hacked?
                var allHacked = true;
                for (var j = 0; j < this._hackableSubsystems.length; j++) {
                    if (!hacked[this._hackableSubsystems[j]]) {
                        allHacked = false;
                        break;
                    }
                }
                state._fullControl = allHacked && this._hackableSubsystems.length > 0;
            }
        }

        /**
         * Calculate vulnerability score (0-1) based on OS, patch level, and hardening.
         * Used by cyber actors to determine hack difficulty.
         *
         * Formula:
         *   base = OS_VULNERABILITY[os]
         *   vuln = base * (1 - patchLevel) * (1 - hardening * 0.5)
         *   result clamped to [0.05, 0.95]
         *
         * @returns {number} Vulnerability score 0.05 to 0.95
         */
        getVulnerability() {
            var base = OS_VULNERABILITY[this._os] || OS_VULNERABILITY['mil_spec'];
            var vuln = base * (1 - this._patchLevel) * (1 - this._hardening * 0.5);
            return Math.max(0.05, Math.min(0.95, vuln));
        }

        /**
         * Get the firewall rating. Used by cyber actors to determine
         * network access difficulty before exploitation begins.
         *
         * @returns {number} Firewall rating 0-1
         */
        getFirewallRating() {
            return this._firewallRating;
        }

        /**
         * Get the list of hackable subsystems on this computer.
         *
         * @returns {string[]} Array of subsystem names
         */
        getHackableSubsystems() {
            return this._hackableSubsystems.slice();
        }

        /**
         * Get the current degradation level for a subsystem.
         * @param {string} subsystem  One of 'sensors', 'navigation', 'weapons', 'comms'
         * @returns {number} Degradation level 0-1 (0 = normal, 1 = fully disabled)
         */
        getDegradation(subsystem) {
            if (this._degradation.hasOwnProperty(subsystem)) {
                return this._degradation[subsystem];
            }
            return 0;
        }

        /**
         * Set the degradation level for a subsystem.
         * @param {string} subsystem  One of 'sensors', 'navigation', 'weapons', 'comms'
         * @param {number} level      Degradation level, clamped to 0-1
         */
        setDegradation(subsystem, level) {
            if (this._degradation.hasOwnProperty(subsystem)) {
                this._degradation[subsystem] = Math.max(0, Math.min(1, level));
            }
        }

        /**
         * Add degradation to a subsystem (incremental).
         * @param {string} subsystem  One of 'sensors', 'navigation', 'weapons', 'comms'
         * @param {number} amount     Amount to add, result clamped to 0-1
         */
        applyDegradation(subsystem, amount) {
            if (this._degradation.hasOwnProperty(subsystem)) {
                this._degradation[subsystem] = Math.max(0, Math.min(1, this._degradation[subsystem] + amount));
            }
        }

        /**
         * Clean up all state on entity removal.
         */
        cleanup(world) {
            var state = this.entity.state;

            // Clear computer state
            state._computerCompromised      = false;
            state._computerAccessLevel      = ACCESS_NONE;
            state._computerHackedSubsystems = {};

            // Clear all effect flags
            state._sensorDisabled      = false;
            state._sensorRedirected    = false;
            state._navigationHijacked  = false;
            state._weaponsDisabled     = false;
            state._commsDisabled       = false;
            state._dataExfiltrated     = false;
            state._fullControl         = false;

            // Clear degradation
            state._cyberDegradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };
            this._degradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };

            this._healProgress = {};
        }

        /**
         * Editor schema for the scenario builder UI.
         */
        static editorSchema() {
            return [
                { key: 'os',                label: 'Operating System',      type: 'select',  default: 'mil_spec',
                  options: ['mil_spec', 'linux_hardened', 'vxworks', 'windows_embedded', 'custom'] },
                { key: 'hardening',         label: 'Hardening',             type: 'number',  default: 0.5,  min: 0, max: 1, step: 0.05 },
                { key: 'patchLevel',        label: 'Patch Level',           type: 'number',  default: 0.5,  min: 0, max: 1, step: 0.05 },
                { key: 'firewallRating',    label: 'Firewall Rating',       type: 'number',  default: 0.5,  min: 0, max: 1, step: 0.05 },
                { key: 'hackableSubsystems', label: 'Hackable Subsystems',  type: 'text',    default: 'sensors,navigation,weapons,comms' }
            ];
        }
    }

    // Register with framework — 'cyber' category, 'computer' type
    ComponentRegistry.register('cyber', 'computer', Computer);
})();
