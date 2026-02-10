/**
 * Firewall component — network traffic filtering for cyber defense.
 *
 * Sits on a network node and filters incoming traffic. Cyber actors must
 * defeat the firewall before accessing nodes behind it. Integrates with
 * CommEngine for packet-level effects (latency, drop rate).
 *
 * State outputs: _firewallActive, _firewallRating, _firewallIDS,
 * _firewallBypassed, _firewallAlerts, _firewallBlockedPackets,
 * _firewallConnections, _firewallUnderAttack, _firewallHealth,
 * _firewallBlocking, _firewallLatency
 *
 * Registers as: cyber/firewall
 */
(function() {
    'use strict';

    // --- Constants ---
    var UPDATE_INTERVAL       = 0.5;
    var HEALTH_DEGRADE_RATE   = 0.1;    // per second under DDoS
    var HEALTH_RECOVER_RATE   = 0.02;   // per second when not attacked
    var AUTO_BYPASS_THRESHOLD = 0.2;    // health below this → auto-bypass
    var SPIKE_THRESHOLD       = 3.0;    // packet rate multiplier for spike
    var SPIKE_WINDOW          = 5.0;    // seconds of packet rate history

    var BLOCKING_RATES  = { 'strict': 0.15, 'default': 0.05, 'permissive': 0.01 };
    var LATENCY_OVERHEAD = { 'strict': 0.020, 'default': 0.005, 'permissive': 0.001 };

    // -----------------------------------------------------------------------
    // Firewall Component
    // -----------------------------------------------------------------------
    class Firewall extends ECS.Component {
        constructor(config) {
            super(config);
            this._rating         = config.rating !== undefined ? config.rating : 0.7;
            this._ids            = config.ids !== false;
            this._rules          = BLOCKING_RATES.hasOwnProperty(config.rules) ? config.rules : 'default';
            this._maxConnections = config.maxConnections !== undefined ? config.maxConnections : 1000;
            this._logLevel       = config.logLevel || 'normal';

            this._updateAccum    = 0;
            this._packetHistory  = [];
            this._packetBaseline = 0;
            this._baselineWindow = 0;
            this._alertLog       = [];
        }

        init(world) {
            var s = this.entity.state;
            s._firewallActive        = true;
            s._firewallRating        = this._rating;
            s._firewallIDS           = this._ids;
            s._firewallBypassed      = false;
            s._firewallAlerts        = 0;
            s._firewallBlockedPackets = 0;
            s._firewallConnections   = 0;
            s._firewallUnderAttack   = false;
            s._firewallHealth        = 1.0;
            s._firewallBlocking      = BLOCKING_RATES[this._rules];
            s._firewallLatency       = LATENCY_OVERHEAD[this._rules];
        }

        update(dt, world) {
            var entity = this.entity;
            if (!entity.active) return;
            var s = entity.state;

            this._updateAccum += dt;
            if (this._updateAccum < UPDATE_INTERVAL) return;
            var tickDt = this._updateAccum;
            this._updateAccum = 0;

            if (!s._firewallActive) return;

            // Bypassed: no filtering, try recovery
            if (s._firewallBypassed) {
                s._firewallBlocking = 0;
                s._firewallLatency = 0;
                this._tryRecover(tickDt, s);
                return;
            }

            this._detectSpike(s, tickDt);
            this._processDDoS(s, tickDt);
            if (this._ids) this._runIDS(s, tickDt, world);
            this._updateConnections(s);

            // Health-based auto-bypass
            if (s._firewallHealth < AUTO_BYPASS_THRESHOLD) {
                s._firewallBypassed = true;
                s._firewallBlocking = 0;
                s._firewallLatency = 0;
                this._addAlert(s, world, 'CRITICAL: Health below threshold, firewall bypassed');
            }

            // Recovery when not under attack
            if (!s._firewallUnderAttack) {
                this._tryRecover(tickDt, s);
            }

            // Update blocking rate based on health + attack status
            if (!s._firewallBypassed) {
                var baseRate = BLOCKING_RATES[this._rules];
                if (s._firewallUnderAttack) {
                    s._firewallBlocking = Math.min(0.8, baseRate + (1.0 - s._firewallHealth) * 0.5);
                } else {
                    s._firewallBlocking = baseRate;
                }
                s._firewallLatency = LATENCY_OVERHEAD[this._rules];
            }
        }

        // -------------------------------------------------------------------
        // Traffic spike detection
        // -------------------------------------------------------------------
        _detectSpike(s, dt) {
            var current = s._commPacketsRecv || 0;
            this._packetHistory.push({ count: current, dt: dt });
            this._baselineWindow += dt;

            // Trim to SPIKE_WINDOW
            while (this._baselineWindow > SPIKE_WINDOW && this._packetHistory.length > 1) {
                var removed = this._packetHistory.shift();
                this._baselineWindow -= removed.dt;
            }

            if (this._packetHistory.length >= 2) {
                var total = 0;
                for (var i = 0; i < this._packetHistory.length - 1; i++) {
                    total += this._packetHistory[i].count;
                }
                this._packetBaseline = total / (this._packetHistory.length - 1);

                if (this._packetBaseline > 0 && current > this._packetBaseline * SPIKE_THRESHOLD) {
                    s._firewallUnderAttack = true;
                    s._firewallBlockedPackets += Math.floor(current * 0.5);
                } else if (current <= this._packetBaseline * 1.5) {
                    s._firewallUnderAttack = false;
                }
            }
        }

        // -------------------------------------------------------------------
        // DDoS processing
        // -------------------------------------------------------------------
        _processDDoS(s, dt) {
            var underDDoS = !!s._cyberDenied ||
                            (s._commCyber && s._commCyber.type === 'ddos');

            if (underDDoS) {
                s._firewallUnderAttack = true;
                s._firewallHealth = Math.max(0, s._firewallHealth - HEALTH_DEGRADE_RATE * dt);
                s._firewallBlockedPackets += Math.floor(this._maxConnections * 0.8 * dt);
            }
        }

        // -------------------------------------------------------------------
        // Intrusion Detection System
        // -------------------------------------------------------------------
        _runIDS(s, dt, world) {
            var entity = this.entity;
            var myTeam = entity.team;
            var myNets = s._commNetworks || [];
            var self = this;

            world.entities.forEach(function(other) {
                if (other.id === entity.id || !other.active || !other.state) return;
                if (other.team !== myTeam) return;

                // Check shared network membership
                var otherNets = other.state._commNetworks || [];
                var shared = false;
                for (var i = 0; i < myNets.length; i++) {
                    if (otherNets.indexOf(myNets[i]) >= 0) { shared = true; break; }
                }
                if (!shared && myNets.length > 0) return;

                if (other.state._cyberScanning) {
                    s._firewallAlerts++;
                    self._addAlert(s, world, 'IDS: Scanning detected on ' + other.id);
                }
                if (other.state._cyberAttackDetected) {
                    s._firewallAlerts++;
                    self._addAlert(s, world, 'IDS: Attack on ' + other.id +
                        ' (' + (other.state._cyberAttackType || 'unknown') + ')');
                }
            });
        }

        _addAlert(s, world, message) {
            if (this._logLevel === 'none') return;
            this._alertLog.push({ time: world.simTime, message: message });
            if (this._alertLog.length > 200) this._alertLog.shift();
        }

        // -------------------------------------------------------------------
        // Connection tracking
        // -------------------------------------------------------------------
        _updateConnections(s) {
            var links = s._commLinks || [];
            s._firewallConnections = links.length;

            if (s._firewallConnections > this._maxConnections) {
                var overload = s._firewallConnections / this._maxConnections;
                var extra = Math.min(0.5, (overload - 1.0) * 0.3);
                s._firewallBlocking = Math.min(0.9, s._firewallBlocking + extra);
            }
        }

        // -------------------------------------------------------------------
        // Recovery
        // -------------------------------------------------------------------
        _tryRecover(dt, s) {
            if (s._firewallHealth < 1.0) {
                s._firewallHealth = Math.min(1.0, s._firewallHealth + HEALTH_RECOVER_RATE * dt);
            }
            // Auto-restore if health recovers above threshold
            if (s._firewallBypassed && s._firewallHealth > AUTO_BYPASS_THRESHOLD + 0.1) {
                s._firewallBypassed = false;
                s._firewallBlocking = BLOCKING_RATES[this._rules];
                s._firewallLatency = LATENCY_OVERHEAD[this._rules];
            }
        }

        // -------------------------------------------------------------------
        // Cleanup
        // -------------------------------------------------------------------
        cleanup(world) {
            var s = this.entity.state;
            s._firewallActive        = false;
            s._firewallBypassed      = false;
            s._firewallAlerts        = 0;
            s._firewallBlockedPackets = 0;
            s._firewallConnections   = 0;
            s._firewallUnderAttack   = false;
            s._firewallHealth        = 1.0;
            s._firewallBlocking      = 0;
            s._firewallLatency       = 0;

            this._packetHistory  = [];
            this._alertLog       = [];
            this._packetBaseline = 0;
            this._baselineWindow = 0;
        }

        // -------------------------------------------------------------------
        // Editor schema
        // -------------------------------------------------------------------
        static editorSchema() {
            return [
                { key: 'rating',         label: 'Rating (0-1)',    type: 'number',  default: 0.7,       min: 0,  max: 1,      step: 0.05 },
                { key: 'ids',            label: 'IDS Enabled',     type: 'boolean', default: true },
                { key: 'rules',          label: 'Ruleset',         type: 'select',  default: 'default', options: ['default', 'strict', 'permissive'] },
                { key: 'maxConnections', label: 'Max Connections', type: 'number',  default: 1000,      min: 10, max: 100000 },
                { key: 'logLevel',       label: 'Log Level',       type: 'select',  default: 'normal',  options: ['none', 'normal', 'verbose'] }
            ];
        }
    }

    // Register with framework
    ComponentRegistry.register('cyber', 'firewall', Firewall);
})();
