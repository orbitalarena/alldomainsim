/**
 * CyberCockpit — Interactive command terminal for cyber operations.
 *
 * Provides a hacker-style terminal interface inside the Live Sim Viewer
 * for conducting cyber warfare operations against enemy network nodes.
 *
 * Features:
 *   - Green-on-black terminal aesthetic with blinking cursor
 *   - Command-line interface with tab completion
 *   - Network topology scanner with entity discovery
 *   - Attack commands: scan, exploit, brick, ddos, mitm, inject
 *   - Defense commands: patch, firewall, harden, alert
 *   - Recon commands: nmap, traceroute, whois, netstat, sniff
 *   - Per-target state machine: UNDISCOVERED → SCANNED → EXPLOITED → CONTROLLED/DENIED
 *   - Access levels: NONE → USER → ROOT → PERSISTENT
 *   - Time-based mechanics with progress feedback
 *   - Integrates with CommEngine for real network effects
 *
 * Usage:
 *   CyberCockpit.init(world);
 *   CyberCockpit.toggle();       // Open/close terminal
 *   CyberCockpit.update(dt);     // Call each frame
 *
 * Keyboard:
 *   Backtick (`) — Toggle terminal
 *   Enter        — Execute command
 *   Tab          — Auto-complete
 *   Up/Down      — Command history
 *   Ctrl+L       — Clear screen
 *   Ctrl+C       — Cancel running operation
 *   Escape       — Close terminal
 */
(function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------------
    var MAX_OUTPUT_LINES = 500;
    var PROMPT = '<span class="cy-prompt">root@cyberops</span><span class="cy-path">:~</span>$ ';
    var BLINK_RATE = 530; // ms

    // Target states (from player's perspective)
    var TARGET_STATE = {
        UNDISCOVERED: 'UNDISCOVERED',
        SCANNED:      'SCANNED',
        EXPLOITED:    'EXPLOITED',
        CONTROLLED:   'CONTROLLED',
        DENIED:       'DENIED'
    };

    // Access levels
    var ACCESS = {
        NONE:       0,
        USER:       1,
        ROOT:       2,
        PERSISTENT: 3
    };

    var ACCESS_NAMES = ['NONE', 'USER', 'ROOT', 'PERSISTENT'];

    // Operation timings (seconds)
    var TIMING = {
        scan:      { base: 3, perHardening: 0.5 },
        exploit:   { base: 8, perHardening: 2 },
        brick:     { base: 2, perHardening: 0.3 },
        ddos:      { base: 1, perHardening: 0.2 },
        mitm:      { base: 5, perHardening: 1 },
        inject:    { base: 4, perHardening: 0.8 },
        patch:     { base: 5, perHardening: 0 },
        firewall:  { base: 3, perHardening: 0 },
        harden:    { base: 10, perHardening: 0 }
    };

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------
    var _world = null;
    var _panel = null;
    var _output = null;
    var _input = null;
    var _visible = false;
    var _initialized = false;

    // Target tracking
    var _targets = {};       // entityId → { state, access, hardening, lastScan, vulns, ... }
    var _discoveredNets = {}; // networkId → { discovered, members[] }

    // Operation queue
    var _activeOps = [];     // { type, targetId, progress, duration, startTime, callback }
    var _opIdCounter = 0;

    // Command history
    var _cmdHistory = [];
    var _historyIndex = -1;
    var _maxHistory = 100;

    // Tab completion state
    var _tabCandidates = [];
    var _tabIndex = -1;
    var _tabPrefix = '';

    // Player team
    var _playerTeam = 'blue';

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------
    function init(world) {
        _world = world;
        _createPanel();
        _initialized = true;
    }

    function _createPanel() {
        if (document.getElementById('cyberCockpit')) {
            _panel = document.getElementById('cyberCockpit');
            _output = document.getElementById('cyberOutput');
            _input = document.getElementById('cyberInput');
            return;
        }

        _panel = document.createElement('div');
        _panel.id = 'cyberCockpit';
        _panel.style.cssText =
            'display:none;position:fixed;bottom:0;left:0;right:0;height:40vh;' +
            'background:rgba(0,0,0,0.95);' +
            'border-top:2px solid #00ff41;' +
            'z-index:3000;font-family:"Courier New",monospace;' +
            'box-shadow:0 -4px 20px rgba(0,255,65,0.15);';

        // Header bar
        var header = document.createElement('div');
        header.style.cssText =
            'display:flex;justify-content:space-between;align-items:center;' +
            'padding:4px 12px;background:rgba(0,255,65,0.08);border-bottom:1px solid #003300;' +
            'user-select:none;';
        header.innerHTML =
            '<span style="color:#00ff41;font-size:11px;font-weight:bold;letter-spacing:2px">' +
            '[ CYBER OPERATIONS TERMINAL ]</span>' +
            '<div style="display:flex;gap:12px;align-items:center">' +
            '<span id="cyberOpsCount" style="color:#00aa33;font-size:10px">OPS: 0</span>' +
            '<span id="cyberAccess" style="color:#00aa33;font-size:10px">ACCESS: ---</span>' +
            '<span id="cyberCockpitClose" style="cursor:pointer;color:#00ff41;font-size:16px">&times;</span>' +
            '</div>';

        // Output area
        _output = document.createElement('div');
        _output.id = 'cyberOutput';
        _output.style.cssText =
            'height:calc(100% - 62px);overflow-y:auto;padding:8px 12px;' +
            'color:#00ff41;font-size:12px;line-height:1.6;' +
            'scrollbar-width:thin;scrollbar-color:#003300 transparent;';

        // Input area
        var inputBar = document.createElement('div');
        inputBar.style.cssText =
            'display:flex;align-items:center;padding:4px 12px;' +
            'border-top:1px solid #003300;background:rgba(0,255,65,0.03);';

        var promptSpan = document.createElement('span');
        promptSpan.innerHTML = PROMPT;
        promptSpan.style.cssText = 'flex-shrink:0;font-size:12px;';

        _input = document.createElement('input');
        _input.id = 'cyberInput';
        _input.type = 'text';
        _input.spellcheck = false;
        _input.autocomplete = 'off';
        _input.style.cssText =
            'flex:1;background:transparent;border:none;outline:none;' +
            'color:#00ff41;font-family:"Courier New",monospace;font-size:12px;' +
            'caret-color:#00ff41;padding:2px 0;';

        inputBar.appendChild(promptSpan);
        inputBar.appendChild(_input);

        _panel.appendChild(header);
        _panel.appendChild(_output);
        _panel.appendChild(inputBar);

        document.body.appendChild(_panel);

        // Style injection
        _injectStyles();

        // Event handlers
        _input.addEventListener('keydown', _handleKeyDown);
        var closeBtn = document.getElementById('cyberCockpitClose');
        if (closeBtn) closeBtn.addEventListener('click', function() { toggle(); });

        // Prevent sim keys while typing
        _input.addEventListener('keydown', function(e) {
            e.stopPropagation();
        });
        _input.addEventListener('keyup', function(e) {
            e.stopPropagation();
        });
        _input.addEventListener('keypress', function(e) {
            e.stopPropagation();
        });
    }

    function _injectStyles() {
        if (document.getElementById('cyberCockpitStyles')) return;
        var style = document.createElement('style');
        style.id = 'cyberCockpitStyles';
        style.textContent =
            '.cy-prompt { color: #ff3333; font-weight: bold; }' +
            '.cy-path { color: #3388ff; }' +
            '.cy-info { color: #00ff41; }' +
            '.cy-warn { color: #ffaa00; }' +
            '.cy-error { color: #ff3333; }' +
            '.cy-success { color: #44ff88; }' +
            '.cy-cyan { color: #00ccff; }' +
            '.cy-magenta { color: #ff44ff; }' +
            '.cy-dim { color: #336633; }' +
            '.cy-bold { font-weight: bold; }' +
            '.cy-progress { color: #00aa33; }' +
            '.cy-target { color: #ffcc44; text-decoration: underline; cursor: pointer; }' +
            '#cyberOutput::-webkit-scrollbar { width: 6px; }' +
            '#cyberOutput::-webkit-scrollbar-track { background: transparent; }' +
            '#cyberOutput::-webkit-scrollbar-thumb { background: #003300; border-radius: 3px; }' +
            '#cyberOutput .cyber-progress-bar { ' +
            '  display: inline-block; width: 200px; height: 10px; ' +
            '  background: #001100; border: 1px solid #003300; ' +
            '  vertical-align: middle; margin: 0 6px; position: relative; }' +
            '#cyberOutput .cyber-progress-fill { ' +
            '  height: 100%; background: #00ff41; transition: width 0.3s; }';
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // Toggle / Visibility
    // -----------------------------------------------------------------------
    function toggle() {
        _visible = !_visible;
        if (_panel) {
            _panel.style.display = _visible ? '' : 'none';
            if (_visible) {
                _input.focus();
                if (_output.children.length === 0) {
                    _printBanner();
                }
            }
        }
    }

    function isVisible() {
        return _visible;
    }

    // -----------------------------------------------------------------------
    // Banner
    // -----------------------------------------------------------------------
    function _printBanner() {
        _printLine('<span class="cy-success cy-bold">');
        _printLine('  ╔═══════════════════════════════════════════════════════╗');
        _printLine('  ║            CYBER OPERATIONS TERMINAL v2.0            ║');
        _printLine('  ║     All-Domain Simulation — Cyber Warfare Module     ║');
        _printLine('  ╚═══════════════════════════════════════════════════════╝</span>');
        _printLine('');
        _printLine('  <span class="cy-dim">Type "help" for commands. Tab for auto-complete.</span>');
        _printLine('  <span class="cy-dim">Target entities by ID or use "scan" to discover.</span>');
        _printLine('');
    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------
    function _printLine(html) {
        if (!_output) return;
        var line = document.createElement('div');
        line.innerHTML = html;
        _output.appendChild(line);

        // Cap output
        while (_output.children.length > MAX_OUTPUT_LINES) {
            _output.removeChild(_output.firstChild);
        }

        // Auto-scroll
        _output.scrollTop = _output.scrollHeight;
    }

    function _printCmd(cmd) {
        _printLine(PROMPT + '<span class="cy-info">' + _esc(cmd) + '</span>');
    }

    function _esc(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // -----------------------------------------------------------------------
    // Keyboard handling
    // -----------------------------------------------------------------------
    function _handleKeyDown(e) {
        switch (e.key) {
            case 'Enter':
                e.preventDefault();
                _executeInput();
                break;

            case 'Tab':
                e.preventDefault();
                _tabComplete();
                break;

            case 'ArrowUp':
                e.preventDefault();
                _navigateHistory(-1);
                break;

            case 'ArrowDown':
                e.preventDefault();
                _navigateHistory(1);
                break;

            case 'l':
                if (e.ctrlKey) {
                    e.preventDefault();
                    _output.innerHTML = '';
                }
                break;

            case 'c':
                if (e.ctrlKey) {
                    e.preventDefault();
                    _cancelOps();
                    _printLine('<span class="cy-warn">^C — Operations cancelled</span>');
                    _input.value = '';
                }
                break;

            case 'Escape':
                e.preventDefault();
                toggle();
                break;
        }

        // Reset tab state on any non-tab key
        if (e.key !== 'Tab') {
            _tabCandidates = [];
            _tabIndex = -1;
        }
    }

    function _navigateHistory(dir) {
        if (_cmdHistory.length === 0) return;
        _historyIndex += dir;
        if (_historyIndex < 0) _historyIndex = 0;
        if (_historyIndex >= _cmdHistory.length) {
            _historyIndex = _cmdHistory.length;
            _input.value = '';
            return;
        }
        _input.value = _cmdHistory[_historyIndex];
    }

    // -----------------------------------------------------------------------
    // Tab completion
    // -----------------------------------------------------------------------
    function _tabComplete() {
        var val = _input.value;
        var parts = val.split(/\s+/);

        if (_tabCandidates.length > 0 && _tabPrefix === val.substring(0, val.lastIndexOf(' ') + 1)) {
            // Cycle through existing candidates
            _tabIndex = (_tabIndex + 1) % _tabCandidates.length;
            _input.value = _tabPrefix + _tabCandidates[_tabIndex];
            return;
        }

        // Build candidate list
        _tabCandidates = [];
        _tabIndex = 0;

        if (parts.length <= 1) {
            // Complete command names
            var cmds = ['help', 'scan', 'nmap', 'exploit', 'brick', 'ddos', 'mitm',
                        'inject', 'patch', 'firewall', 'harden', 'alert',
                        'traceroute', 'whois', 'netstat', 'sniff', 'status',
                        'targets', 'ops', 'networks', 'topology', 'clear', 'kill', 'pivot',
                        'escalate', 'exfil', 'persist', 'defend'];
            var prefix = parts[0].toLowerCase();
            _tabPrefix = '';
            for (var i = 0; i < cmds.length; i++) {
                if (cmds[i].indexOf(prefix) === 0) {
                    _tabCandidates.push(cmds[i]);
                }
            }
        } else {
            // Complete entity IDs
            var idPrefix = parts[parts.length - 1].toLowerCase();
            _tabPrefix = parts.slice(0, -1).join(' ') + ' ';

            if (_world) {
                _world.entities.forEach(function(ent) {
                    var eid = ent.id.toLowerCase();
                    if (eid.indexOf(idPrefix) === 0) {
                        _tabCandidates.push(ent.id);
                    }
                    // Also match by name
                    var ename = (ent.name || '').toLowerCase();
                    if (ename.indexOf(idPrefix) === 0 && _tabCandidates.indexOf(ent.id) < 0) {
                        _tabCandidates.push(ent.id);
                    }
                });
            }
        }

        if (_tabCandidates.length === 1) {
            _input.value = _tabPrefix + _tabCandidates[0] + ' ';
            _tabCandidates = [];
        } else if (_tabCandidates.length > 1) {
            _input.value = _tabPrefix + _tabCandidates[0];
            // Show options
            _printLine('<span class="cy-dim">' + _tabCandidates.join('  ') + '</span>');
        }
    }

    // -----------------------------------------------------------------------
    // Command execution
    // -----------------------------------------------------------------------
    function _executeInput() {
        var raw = _input.value.trim();
        _input.value = '';

        if (!raw) return;

        // Add to history
        _cmdHistory.push(raw);
        if (_cmdHistory.length > _maxHistory) _cmdHistory.shift();
        _historyIndex = _cmdHistory.length;

        // Echo command
        _printCmd(raw);

        // Parse
        var parts = raw.split(/\s+/);
        var cmd = parts[0].toLowerCase();
        var args = parts.slice(1);

        // Dispatch
        switch (cmd) {
            case 'help':     _cmdHelp(args); break;
            case 'scan':     _cmdScan(args); break;
            case 'nmap':     _cmdNmap(args); break;
            case 'exploit':  _cmdExploit(args); break;
            case 'brick':    _cmdBrick(args); break;
            case 'ddos':     _cmdDdos(args); break;
            case 'mitm':     _cmdMitm(args); break;
            case 'inject':   _cmdInject(args); break;
            case 'patch':    _cmdDefend(args, 'patch'); break;
            case 'firewall': _cmdDefend(args, 'firewall'); break;
            case 'harden':   _cmdDefend(args, 'harden'); break;
            case 'alert':    _cmdAlert(args); break;
            case 'traceroute': _cmdTraceroute(args); break;
            case 'whois':    _cmdWhois(args); break;
            case 'netstat':  _cmdNetstat(args); break;
            case 'sniff':    _cmdSniff(args); break;
            case 'status':   _cmdStatus(args); break;
            case 'targets':  _cmdTargets(args); break;
            case 'ops':      _cmdOps(args); break;
            case 'networks': _cmdNetworks(args); break;
            case 'topology': _cmdTopology(args); break;
            case 'clear':    _output.innerHTML = ''; break;
            case 'kill':     _cmdKill(args); break;
            case 'pivot':    _cmdPivot(args); break;
            case 'escalate': _cmdEscalate(args); break;
            case 'exfil':    _cmdExfil(args); break;
            case 'persist':  _cmdPersist(args); break;
            case 'defend':   _cmdDefend(args, 'harden'); break;
            default:
                _printLine('<span class="cy-error">Unknown command: ' + _esc(cmd) + '</span>');
                _printLine('<span class="cy-dim">Type "help" for available commands.</span>');
        }
    }

    // -----------------------------------------------------------------------
    // Commands: Help
    // -----------------------------------------------------------------------
    function _cmdHelp(args) {
        if (args.length > 0) {
            _cmdHelpDetail(args[0]);
            return;
        }
        _printLine('<span class="cy-cyan cy-bold">═══ CYBER OPERATIONS COMMANDS ═══</span>');
        _printLine('');
        _printLine('<span class="cy-cyan">RECON:</span>');
        _printLine('  <span class="cy-success">scan</span> [target|all]     Discover and assess target vulnerabilities');
        _printLine('  <span class="cy-success">nmap</span> <target>          Detailed port/service scan on target');
        _printLine('  <span class="cy-success">traceroute</span> <target>    Show network path to target');
        _printLine('  <span class="cy-success">whois</span> <target>         Show detailed entity information');
        _printLine('  <span class="cy-success">netstat</span>                Show active connections and traffic');
        _printLine('  <span class="cy-success">sniff</span> <target>         Capture packets from target link');
        _printLine('');
        _printLine('<span class="cy-cyan">ATTACK:</span>');
        _printLine('  <span class="cy-error">exploit</span> <target>       Gain access to target system');
        _printLine('  <span class="cy-error">brick</span> <target>         Disable target node completely');
        _printLine('  <span class="cy-error">ddos</span> <target>          Flood target bandwidth');
        _printLine('  <span class="cy-error">mitm</span> <target>          Man-in-the-middle intercept');
        _printLine('  <span class="cy-error">inject</span> <target>        Inject false data into network');
        _printLine('');
        _printLine('<span class="cy-cyan">POST-EXPLOIT:</span>');
        _printLine('  <span class="cy-magenta">escalate</span> <target>     Escalate privileges (USER → ROOT)');
        _printLine('  <span class="cy-magenta">persist</span> <target>      Install persistent backdoor');
        _printLine('  <span class="cy-magenta">pivot</span> <target>        Use target as attack relay');
        _printLine('  <span class="cy-magenta">exfil</span> <target>        Exfiltrate intelligence data');
        _printLine('');
        _printLine('<span class="cy-cyan">DEFENSE:</span>');
        _printLine('  <span class="cy-success">patch</span> <target>        Remove exploits from friendly node');
        _printLine('  <span class="cy-success">firewall</span> <target>     Block incoming scans on node');
        _printLine('  <span class="cy-success">harden</span> <target>       Increase node hardening level');
        _printLine('  <span class="cy-success">defend</span> <target>       Alias for harden');
        _printLine('  <span class="cy-success">alert</span>                 Show all detected intrusions');
        _printLine('');
        _printLine('<span class="cy-cyan">STATUS:</span>');
        _printLine('  <span class="cy-info">status</span>                 Show overall cyber ops status');
        _printLine('  <span class="cy-info">targets</span>                List discovered targets');
        _printLine('  <span class="cy-info">ops</span>                    Show active operations');
        _printLine('  <span class="cy-info">networks</span>               Show discovered networks');
        _printLine('  <span class="cy-info">topology</span> [net]          ASCII network topology map');
        _printLine('  <span class="cy-info">kill</span> <op-id>           Cancel an active operation');
        _printLine('  <span class="cy-info">clear</span>                  Clear terminal output');
        _printLine('');
        _printLine('<span class="cy-dim">Use "help <command>" for detailed usage.</span>');
    }

    function _cmdHelpDetail(cmd) {
        switch (cmd.toLowerCase()) {
            case 'scan':
                _printLine('<span class="cy-cyan">scan [target|all]</span>');
                _printLine('  Performs reconnaissance on target entity or all enemy entities.');
                _printLine('  Discovers network membership, services, hardening level, and vulnerabilities.');
                _printLine('  Use "scan all" to sweep all enemy nodes in range.');
                _printLine('  Duration: 3-8s depending on target hardening level.');
                break;
            case 'exploit':
                _printLine('<span class="cy-cyan">exploit <target></span>');
                _printLine('  Attempts to gain access to the target system.');
                _printLine('  Requires target to be SCANNED first.');
                _printLine('  Grants USER access on success. Use "escalate" for ROOT.');
                _printLine('  Duration: 8-28s. Detection risk: ~20% per attempt.');
                break;
            default:
                _printLine('<span class="cy-dim">No detailed help for: ' + _esc(cmd) + '</span>');
        }
    }

    // -----------------------------------------------------------------------
    // Commands: Recon
    // -----------------------------------------------------------------------
    function _cmdScan(args) {
        if (args.length === 0 || args[0] === 'all') {
            _scanAll();
            return;
        }

        var targetId = args[0];
        var entity = _resolveTarget(targetId);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(targetId) + '</span>');
            return;
        }

        // Set scanning visual flag on entity during scan
        if (entity.state) entity.state._cyberScanning = true;

        _beginOp('scan', entity.id, function(success) {
            // Clear scanning flag
            if (entity.state) entity.state._cyberScanning = false;

            if (success) {
                var tgt = _getOrCreateTarget(entity);
                tgt.state = TARGET_STATE.SCANNED;
                tgt.lastScan = _world ? _world.simTime : Date.now() / 1000;
                tgt.vulns = _assessVulns(entity);
                tgt.services = _assessServices(entity);

                // Set scanned visual flag
                if (entity.state) entity.state._cyberScanned = true;

                _printLine('<span class="cy-success">[+] Scan complete: ' + _esc(entity.name || entity.id) + '</span>');
                _printLine('    State: <span class="cy-warn">' + tgt.state + '</span>');
                _printLine('    Hardening: ' + _hardeningBar(tgt.hardening));
                _printLine('    Vulns: <span class="cy-error">' + tgt.vulns.length + ' found</span>');
                for (var v = 0; v < tgt.vulns.length; v++) {
                    _printLine('      <span class="cy-dim">- ' + tgt.vulns[v].name + ' (' + tgt.vulns[v].severity + ')</span>');
                }
                _printLine('    Services: ' + tgt.services.join(', '));
            } else {
                _printLine('<span class="cy-error">[-] Scan failed: target unreachable</span>');
            }
        });
    }

    function _scanAll() {
        if (!_world) {
            _printLine('<span class="cy-error">No simulation loaded</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Initiating network sweep...</span>');

        var enemies = [];
        _world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.team === _playerTeam) return;
            enemies.push(ent);
        });

        if (enemies.length === 0) {
            _printLine('<span class="cy-dim">No enemy entities detected.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Found ' + enemies.length + ' enemy node(s). Scanning...</span>');

        // Create a delayed scan operation for each
        var delay = 0;
        for (var i = 0; i < enemies.length; i++) {
            (function(ent, d) {
                // Set scanning flag during sweep
                if (ent.state) ent.state._cyberScanning = true;
                setTimeout(function() {
                    var tgt = _getOrCreateTarget(ent);
                    tgt.state = TARGET_STATE.SCANNED;
                    tgt.lastScan = _world ? _world.simTime : Date.now() / 1000;
                    tgt.vulns = _assessVulns(ent);
                    tgt.services = _assessServices(ent);

                    // Clear scanning, set scanned visual flag
                    if (ent.state) {
                        ent.state._cyberScanning = false;
                        ent.state._cyberScanned = true;
                    }

                    var teamC = ent.team === 'red' ? 'cy-error' : 'cy-warn';
                    _printLine('  <span class="' + teamC + '">' + _esc(ent.id) + '</span> — ' +
                        _esc(ent.name || '?') + ' [' + (ent.type || '?') + '] H:' +
                        tgt.hardening + ' V:' + tgt.vulns.length);
                }, d);
            })(enemies[i], delay);
            delay += 150 + Math.random() * 200;
        }

        setTimeout(function() {
            _printLine('<span class="cy-success">[+] Network sweep complete. ' + enemies.length + ' targets cataloged.</span>');
            _printLine('<span class="cy-dim">Use "targets" to view discovered hosts.</span>');
        }, delay + 100);
    }

    function _cmdNmap(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: nmap <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        _printLine('<span class="cy-info">[*] Starting Nmap scan on ' + _esc(entity.id) + '...</span>');

        // Set scanning visual flag
        if (entity.state) entity.state._cyberScanning = true;

        _beginOp('scan', entity.id, function() {
            // Clear scanning flag, set scanned
            if (entity.state) {
                entity.state._cyberScanning = false;
                entity.state._cyberScanned = true;
            }
            tgt.state = TARGET_STATE.SCANNED;
            tgt.vulns = _assessVulns(entity);
            tgt.services = _assessServices(entity);
            tgt.lastScan = _world ? _world.simTime : 0;

            _printLine('');
            _printLine('<span class="cy-info">Nmap scan report for ' + _esc(entity.name || entity.id) + '</span>');
            _printLine('<span class="cy-dim">Host is up (latency ' + (10 + Math.floor(Math.random() * 50)) + 'ms).</span>');
            _printLine('');
            _printLine('PORT     STATE   SERVICE');

            var ports = [
                { port: '22/tcp', state: 'open', svc: 'ssh' },
                { port: '80/tcp', state: 'open', svc: 'http' },
                { port: '443/tcp', state: 'open', svc: 'https' },
            ];

            // Add sensor-specific ports
            if (entity.getComponent && entity.getComponent('sensors')) {
                ports.push({ port: '1553/udp', state: 'open', svc: 'mil-std-1553' });
                ports.push({ port: '4200/tcp', state: 'open', svc: 'radar-ctrl' });
            }
            if (entity.getComponent && entity.getComponent('weapons')) {
                ports.push({ port: '5001/tcp', state: 'open', svc: 'fire-ctrl' });
            }

            // CommEngine membership
            var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
            if (hasComm) {
                var comms = CommEngine.getEntityComms(entity.id);
                if (comms && comms.networks.length > 0) {
                    ports.push({ port: '8200/udp', state: 'open', svc: 'link16-gw' });
                }
            }

            for (var p = 0; p < ports.length; p++) {
                var pp = ports[p];
                var stateColor = pp.state === 'open' ? 'cy-success' : 'cy-dim';
                _printLine(_pad(pp.port, 9) + '<span class="' + stateColor + '">' + _pad(pp.state, 8) + '</span>' + pp.svc);
            }

            _printLine('');
            _printLine('<span class="cy-dim">OS guess: MIL-RTOS 4.2 (98% confidence)</span>');
            _printLine('Hardening level: ' + _hardeningBar(tgt.hardening));
            _printLine('Vulns found: <span class="cy-error">' + tgt.vulns.length + '</span>');
        });
    }

    function _cmdTraceroute(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: traceroute <target></span>');
            return;
        }

        _printLine('<span class="cy-info">traceroute to ' + _esc(entity.name || entity.id) + ', 30 hops max</span>');

        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        var hops = [];

        if (hasComm) {
            var comms = CommEngine.getEntityComms(entity.id);
            if (comms && comms.commandRoute) {
                hops = comms.commandRoute.path || [];
            }
        }

        if (hops.length === 0) {
            hops = ['local_gw', entity.id];
        }

        for (var h = 0; h < hops.length; h++) {
            var latency = 5 + Math.floor(Math.random() * 20) + h * 8;
            var hopEnt = _world ? _world.getEntity(hops[h]) : null;
            var hopName = hopEnt ? (hopEnt.name || hops[h]) : hops[h];
            _printLine(' ' + _pad(String(h + 1), 3) + _pad(latency + ' ms', 10) + '<span class="cy-cyan">' + _esc(hopName) + '</span>');
        }
    }

    function _cmdWhois(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: whois <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        var s = entity.state || {};

        _printLine('<span class="cy-cyan cy-bold">═══ WHOIS: ' + _esc(entity.id) + ' ═══</span>');
        _printLine('  Name:      ' + _esc(entity.name || '---'));
        _printLine('  Type:      ' + _esc(entity.type || '---'));
        _printLine('  Team:      <span class="' + (entity.team === 'red' ? 'cy-error' : 'cy-cyan') + '">' + _esc(entity.team || '---') + '</span>');
        _printLine('  Active:    ' + (entity.active ? '<span class="cy-success">YES</span>' : '<span class="cy-error">NO</span>'));

        if (s.lat != null) {
            _printLine('  Position:  ' + (s.lat * 180 / Math.PI).toFixed(4) + ', ' + (s.lon * 180 / Math.PI).toFixed(4));
        }
        if (s.alt != null) {
            _printLine('  Altitude:  ' + (s.alt > 10000 ? (s.alt / 1000).toFixed(1) + ' km' : Math.round(s.alt) + ' m'));
        }

        _printLine('  Hardening: ' + _hardeningBar(tgt.hardening));
        _printLine('  Access:    <span class="cy-warn">' + ACCESS_NAMES[tgt.access] + '</span>');
        _printLine('  State:     ' + tgt.state);

        // Comm info
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (hasComm) {
            var comms = CommEngine.getEntityComms(entity.id);
            if (comms) {
                _printLine('  Networks:  ' + (comms.networks.length > 0 ? comms.networks.join(', ') : 'none'));
                _printLine('  Links:     ' + comms.activeLinks);
                _printLine('  BW:        ' + comms.totalBandwidth_mbps.toFixed(1) + ' Mbps');
                if (comms.bricked) _printLine('  <span class="cy-error">** NODE BRICKED **</span>');
                if (comms.compromised) _printLine('  <span class="cy-magenta">** COMPROMISED **</span>');
            }
        }

        // Components
        var compList = [];
        if (entity.getComponent) {
            if (entity.getComponent('sensors')) compList.push('sensors');
            if (entity.getComponent('weapons')) compList.push('weapons');
            if (entity.getComponent('physics')) compList.push('physics');
            if (entity.getComponent('ai')) compList.push('ai');
        }
        if (compList.length > 0) {
            _printLine('  Systems:   ' + compList.join(', '));
        }
    }

    function _cmdNetstat(args) {
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (!hasComm) {
            _printLine('<span class="cy-error">CommEngine not available</span>');
            return;
        }

        var metrics = CommEngine.getMetrics();
        _printLine('<span class="cy-cyan cy-bold">Active Network Connections</span>');
        _printLine('');
        _printLine('  Nodes:     ' + metrics.activeNodes + '/' + metrics.totalNodes);
        _printLine('  Links:     ' + metrics.activeLinks + '/' + metrics.totalLinks);
        _printLine('  Packets:   ' + metrics.packetsInFlight + ' in-flight');
        _printLine('  Delivered: ' + metrics.totalPacketsDelivered);
        _printLine('  Dropped:   <span class="' + (metrics.totalPacketsDropped > 0 ? 'cy-warn' : 'cy-dim') + '">' + metrics.totalPacketsDropped + '</span>');
        _printLine('  Delivery:  ' + (metrics.packetDeliveryRate * 100).toFixed(1) + '%');
        _printLine('  Jammers:   <span class="' + (metrics.activeJammers > 0 ? 'cy-error' : 'cy-dim') + '">' + metrics.activeJammers + '</span>');
        _printLine('  Cyber:     <span class="' + (metrics.activeCyberAttacks > 0 ? 'cy-magenta' : 'cy-dim') + '">' + metrics.activeCyberAttacks + '</span>');
    }

    function _cmdSniff(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: sniff <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.USER) {
            _printLine('<span class="cy-error">[-] Need at least USER access to sniff traffic. Run "exploit" first.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Capturing packets on ' + _esc(entity.id) + '... (5s capture)</span>');

        // Simulate packet capture from comm engine state
        setTimeout(function() {
            _printLine('<span class="cy-success">[+] Capture complete. Packets:</span>');

            var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
            if (hasComm) {
                var comms = CommEngine.getEntityComms(entity.id);
                if (comms) {
                    _printLine('  Sent:     ' + comms.packetsSent);
                    _printLine('  Received: ' + comms.packetsReceived);
                    _printLine('  Links:    ' + comms.links.length);

                    for (var li = 0; li < Math.min(comms.links.length, 5); li++) {
                        var lk = comms.links[li];
                        var quality = lk.quality || 'unknown';
                        _printLine('    <span class="cy-dim">' + entity.id + ' <-> ' + lk.peerId +
                            ' [' + quality + '] ' + (lk.latency_ms || 0).toFixed(0) + 'ms' +
                            (lk.jammed ? ' <span class="cy-error">JAMMED</span>' : '') + '</span>');
                    }
                }
            }

            // Simulate intercepted data if MITM
            if (tgt.access >= ACCESS.ROOT) {
                _printLine('  <span class="cy-magenta">[!] Decrypted track data intercepted:</span>');
                var fakeTrack = {
                    lat: 35 + Math.random() * 2,
                    lon: -118 + Math.random() * 2,
                    alt: Math.floor(5000 + Math.random() * 10000),
                    speed: Math.floor(200 + Math.random() * 600)
                };
                _printLine('    <span class="cy-dim">TRACK: lat=' + fakeTrack.lat.toFixed(4) +
                    ' lon=' + fakeTrack.lon.toFixed(4) +
                    ' alt=' + fakeTrack.alt + 'm spd=' + fakeTrack.speed + 'm/s</span>');
            }
        }, 1500);
    }

    // -----------------------------------------------------------------------
    // Commands: Attack
    // -----------------------------------------------------------------------
    function _cmdExploit(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: exploit <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.state === TARGET_STATE.UNDISCOVERED) {
            _printLine('<span class="cy-warn">[!] Target not scanned. Running scan first...</span>');
            _cmdScan([entity.id]);
            return;
        }

        if (tgt.access >= ACCESS.USER) {
            _printLine('<span class="cy-warn">[!] Already have ' + ACCESS_NAMES[tgt.access] + ' access to ' + _esc(entity.id) + '</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Attempting exploit on ' + _esc(entity.id) + '...</span>');

        _beginOp('exploit', entity.id, function(success) {
            if (success) {
                tgt.access = ACCESS.USER;
                tgt.state = TARGET_STATE.EXPLOITED;

                // Set exploited visual flag on entity
                if (entity.state) entity.state._cyberExploited = true;

                _printLine('<span class="cy-success">[+] EXPLOIT SUCCESSFUL — ' + _esc(entity.name || entity.id) + '</span>');
                _printLine('    Access level: <span class="cy-warn">USER</span>');
                _printLine('    <span class="cy-dim">Use "escalate" for ROOT, "persist" for backdoor.</span>');

                // Notify CommEngine
                _notifyCommEngine('exploit', entity.id, true);
            } else {
                _printLine('<span class="cy-error">[-] Exploit failed. Target patched or hardened.</span>');
                // Detection risk
                if (Math.random() < 0.3) {
                    _printLine('<span class="cy-error">[!] ALERT: Intrusion attempt detected by target!</span>');
                    tgt.hardening = Math.min(10, tgt.hardening + 1);
                }
            }
        });
    }

    function _cmdBrick(args) {
        _cmdAttack(args, 'brick', 'BRICK', function(entity, tgt) {
            tgt.state = TARGET_STATE.DENIED;
            if (entity.state) {
                entity.state._commBricked = true;
                entity.state._cyberDenied = true;
            }
            _notifyCommEngine('brick', entity.id, true);
            _printLine('<span class="cy-error">[+] NODE BRICKED: ' + _esc(entity.id) + '</span>');
            _printLine('    <span class="cy-dim">Node will attempt reboot in ~60s.</span>');
        });
    }

    function _cmdDdos(args) {
        _cmdAttack(args, 'ddos', 'DDoS', function(entity, tgt) {
            tgt.state = TARGET_STATE.DENIED;
            if (entity.state) entity.state._cyberDenied = true;
            _notifyCommEngine('ddos', entity.id, true);
            _printLine('<span class="cy-error">[+] DDoS ACTIVE: ' + _esc(entity.id) + ' — bandwidth flooded</span>');
        });
    }

    function _cmdMitm(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: mitm <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.USER) {
            _printLine('<span class="cy-error">[-] Need USER access for MITM. Run "exploit" first.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Setting up MITM on ' + _esc(entity.id) + '...</span>');

        _beginOp('mitm', entity.id, function(success) {
            if (success) {
                _notifyCommEngine('mitm', entity.id, true);
                _printLine('<span class="cy-magenta">[+] MITM ACTIVE: Intercepting traffic through ' + _esc(entity.id) + '</span>');
            } else {
                _printLine('<span class="cy-error">[-] MITM setup failed.</span>');
            }
        });
    }

    function _cmdInject(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: inject <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.USER) {
            _printLine('<span class="cy-error">[-] Need USER access to inject data. Run "exploit" first.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Preparing injection payload for ' + _esc(entity.id) + '...</span>');

        _beginOp('inject', entity.id, function(success) {
            if (success) {
                _notifyCommEngine('inject', entity.id, true);
                _printLine('<span class="cy-magenta">[+] INJECT ACTIVE: False track data being injected via ' + _esc(entity.id) + '</span>');
                _printLine('    <span class="cy-dim">Ghost targets will appear on enemy radar displays.</span>');
            } else {
                _printLine('<span class="cy-error">[-] Injection failed.</span>');
            }
        });
    }

    function _cmdAttack(args, type, label, successCallback) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: ' + type + ' <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.state === TARGET_STATE.UNDISCOVERED) {
            _printLine('<span class="cy-warn">[!] Target not scanned. Use "scan ' + _esc(entity.id) + '" first.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Initiating ' + label + ' on ' + _esc(entity.id) + '...</span>');

        _beginOp(type, entity.id, function(success) {
            if (success) {
                successCallback(entity, tgt);
            } else {
                _printLine('<span class="cy-error">[-] ' + label + ' failed on ' + _esc(entity.id) + '</span>');
            }
        });
    }

    // -----------------------------------------------------------------------
    // Commands: Post-Exploit
    // -----------------------------------------------------------------------
    function _cmdEscalate(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: escalate <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.USER) {
            _printLine('<span class="cy-error">[-] No access to escalate. Run "exploit" first.</span>');
            return;
        }
        if (tgt.access >= ACCESS.ROOT) {
            _printLine('<span class="cy-warn">[!] Already have ' + ACCESS_NAMES[tgt.access] + ' access.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Attempting privilege escalation on ' + _esc(entity.id) + '...</span>');

        var duration = 5 + tgt.hardening * 1.5;
        var successChance = Math.max(0.2, 0.8 - tgt.hardening * 0.08);

        _beginOpCustom('escalate', entity.id, duration, successChance, function(success) {
            if (success) {
                tgt.access = ACCESS.ROOT;
                _printLine('<span class="cy-success">[+] ESCALATION SUCCESSFUL — ROOT access on ' + _esc(entity.id) + '</span>');
                _printLine('    <span class="cy-dim">Full control. Use "persist" for backdoor, "pivot" to relay.</span>');
            } else {
                _printLine('<span class="cy-error">[-] Escalation failed. Patched vulnerability.</span>');
                if (Math.random() < 0.4) {
                    _printLine('<span class="cy-error">[!] DETECTION: Security alert triggered on target!</span>');
                    tgt.hardening = Math.min(10, tgt.hardening + 1);
                }
            }
        });
    }

    function _cmdPersist(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: persist <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access. Run "escalate" first.</span>');
            return;
        }
        if (tgt.access >= ACCESS.PERSISTENT) {
            _printLine('<span class="cy-warn">[!] Already have PERSISTENT access.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Installing persistent backdoor on ' + _esc(entity.id) + '...</span>');

        _beginOpCustom('persist', entity.id, 8, 0.85, function(success) {
            if (success) {
                tgt.access = ACCESS.PERSISTENT;
                tgt.state = TARGET_STATE.CONTROLLED;

                // Set controlled visual flag on entity
                if (entity.state) entity.state._cyberControlled = true;

                _printLine('<span class="cy-success">[+] PERSISTENT ACCESS — ' + _esc(entity.id) + '</span>');
                _printLine('    <span class="cy-dim">Backdoor survives reboots. Full C2 channel established.</span>');
            } else {
                _printLine('<span class="cy-error">[-] Persistence implant failed. AV detected payload.</span>');
            }
        });
    }

    function _cmdPivot(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: pivot <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access to pivot. Run "escalate" first.</span>');
            return;
        }

        _printLine('<span class="cy-magenta">[+] PIVOT ACTIVE — ' + _esc(entity.id) + ' is now an attack relay</span>');
        _printLine('    <span class="cy-dim">Attacks from this node have reduced detection risk.</span>');

        tgt.isPivot = true;

        // Discover adjacent nodes
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (hasComm) {
            var comms = CommEngine.getEntityComms(entity.id);
            if (comms && comms.links) {
                _printLine('    Adjacent nodes discovered:');
                for (var li = 0; li < comms.links.length; li++) {
                    var peerId = comms.links[li].peerId;
                    var peer = _world ? _world.getEntity(peerId) : null;
                    if (peer) {
                        var peerTgt = _getOrCreateTarget(peer);
                        if (peerTgt.state === TARGET_STATE.UNDISCOVERED) {
                            peerTgt.state = TARGET_STATE.SCANNED;
                            peerTgt.vulns = _assessVulns(peer);
                            peerTgt.services = _assessServices(peer);
                        }
                        _printLine('      <span class="cy-cyan">' + _esc(peerId) + '</span> — ' + _esc(peer.name || '?'));
                    }
                }
            }
        }
    }

    function _cmdExfil(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: exfil <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.USER) {
            _printLine('<span class="cy-error">[-] Need access to exfiltrate. Run "exploit" first.</span>');
            return;
        }

        _printLine('<span class="cy-info">[*] Exfiltrating intelligence from ' + _esc(entity.id) + '...</span>');

        _beginOpCustom('exfil', entity.id, 6, 0.9, function(success) {
            if (success) {
                // Generate fake intelligence based on entity type
                _printLine('<span class="cy-success">[+] EXFIL COMPLETE — Intelligence gathered:</span>');

                if (entity.getComponent && entity.getComponent('sensors')) {
                    var sComp = entity.getComponent('sensors');
                    _printLine('    <span class="cy-cyan">SENSOR CONFIG:</span> ' + (sComp.config ? sComp.config.type : 'unknown'));
                    if (sComp.config && sComp.config.maxRange_m) {
                        _printLine('      Range: ' + (sComp.config.maxRange_m / 1000).toFixed(0) + ' km');
                    }
                }

                if (entity.getComponent && entity.getComponent('weapons')) {
                    var wComp = entity.getComponent('weapons');
                    _printLine('    <span class="cy-error">WEAPON CONFIG:</span> ' + (wComp.config ? wComp.config.type : 'unknown'));
                    if (wComp.config && wComp.config.maxRange_m) {
                        _printLine('      Max range: ' + (wComp.config.maxRange_m / 1000).toFixed(0) + ' km');
                    }
                }

                if (entity.getComponent && entity.getComponent('ai')) {
                    _printLine('    <span class="cy-warn">AI MODULE:</span> Active');
                    var aiComp = entity.getComponent('ai');
                    if (aiComp.config && aiComp.config.waypoints) {
                        _printLine('      Waypoints: ' + aiComp.config.waypoints.length);
                    }
                }

                // Reveal entity details
                _printLine('    <span class="cy-dim">Intel shared to friendly COP.</span>');

                // Mark entity as "intel known" for friendly team
                if (entity.state) {
                    entity.state._cyberIntelExfiltrated = true;
                }
            } else {
                _printLine('<span class="cy-error">[-] Exfiltration blocked — data encrypted.</span>');
            }
        });
    }

    // -----------------------------------------------------------------------
    // Commands: Defense
    // -----------------------------------------------------------------------
    function _cmdDefend(args, type) {
        if (!args[0]) {
            _printLine('<span class="cy-error">Usage: ' + type + ' <target></span>');
            return;
        }

        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(args[0]) + '</span>');
            return;
        }

        if (entity.team !== _playerTeam) {
            _printLine('<span class="cy-error">[-] Can only defend friendly nodes.</span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);

        switch (type) {
            case 'patch':
                _printLine('<span class="cy-info">[*] Patching ' + _esc(entity.id) + '...</span>');
                _beginOpCustom('patch', entity.id, 5, 0.95, function() {
                    // Remove exploits
                    tgt.access = ACCESS.NONE;
                    tgt.state = TARGET_STATE.SCANNED;
                    if (entity.state) {
                        entity.state._commBricked = false;
                        entity.state._commCyber = null;
                        entity.state._cyberAttackDetected = false;
                        entity.state._cyberScanning = false;
                        entity.state._cyberExploited = false;
                        entity.state._cyberControlled = false;
                        entity.state._cyberDenied = false;
                        entity.state._cyberAccessLevel = 0;
                    }
                    _notifyCommEngine('patch', entity.id, false);
                    _printLine('<span class="cy-success">[+] PATCHED: ' + _esc(entity.id) + ' — all exploits removed.</span>');
                });
                break;

            case 'firewall':
                _printLine('<span class="cy-info">[*] Configuring firewall on ' + _esc(entity.id) + '...</span>');
                _beginOpCustom('firewall', entity.id, 3, 0.98, function() {
                    tgt.firewalled = true;
                    tgt.hardening = Math.min(10, tgt.hardening + 2);
                    _printLine('<span class="cy-success">[+] FIREWALL ACTIVE: ' + _esc(entity.id) + ' — scan resistance +2</span>');
                });
                break;

            case 'harden':
                _printLine('<span class="cy-info">[*] Hardening ' + _esc(entity.id) + '...</span>');
                _beginOpCustom('harden', entity.id, 10, 1.0, function() {
                    tgt.hardening = Math.min(10, tgt.hardening + 3);
                    _printLine('<span class="cy-success">[+] HARDENED: ' + _esc(entity.id) + ' — level now ' + tgt.hardening + '/10</span>');
                });
                break;
        }
    }

    function _cmdAlert(args) {
        _printLine('<span class="cy-cyan cy-bold">═══ INTRUSION DETECTION ALERTS ═══</span>');

        var alertCount = 0;
        if (_world) {
            _world.entities.forEach(function(ent) {
                if (ent.team !== _playerTeam) return;
                if (!ent.state) return;

                if (ent.state._cyberAttackDetected) {
                    alertCount++;
                    _printLine('  <span class="cy-error">[ALERT]</span> ' + _esc(ent.id) + ' — ' +
                        (ent.state._cyberAttackType || 'unknown') + ' attack from ' +
                        (ent.state._cyberAttackerId || 'unknown'));
                }
                if (ent.state._commBricked) {
                    alertCount++;
                    _printLine('  <span class="cy-error">[BRICK]</span> ' + _esc(ent.id) + ' — Node offline');
                }
                if (ent.state._commCyber) {
                    alertCount++;
                    _printLine('  <span class="cy-warn">[CYBER]</span> ' + _esc(ent.id) + ' — ' +
                        (ent.state._commCyber.type || 'unknown') + ' active');
                }
            });
        }

        if (alertCount === 0) {
            _printLine('  <span class="cy-success">No intrusions detected.</span>');
        } else {
            _printLine('');
            _printLine('  <span class="cy-warn">Total alerts: ' + alertCount + '</span>');
        }
    }

    // -----------------------------------------------------------------------
    // Commands: Status
    // -----------------------------------------------------------------------
    function _cmdStatus(args) {
        _printLine('<span class="cy-cyan cy-bold">═══ CYBER OPS STATUS ═══</span>');
        _printLine('');

        var targetCount = Object.keys(_targets).length;
        var exploited = 0, controlled = 0, denied = 0, scanned = 0;
        for (var tid in _targets) {
            var t = _targets[tid];
            if (t.state === TARGET_STATE.SCANNED) scanned++;
            if (t.state === TARGET_STATE.EXPLOITED) exploited++;
            if (t.state === TARGET_STATE.CONTROLLED) controlled++;
            if (t.state === TARGET_STATE.DENIED) denied++;
        }

        _printLine('  Targets discovered: ' + targetCount);
        _printLine('  Scanned:    <span class="cy-info">' + scanned + '</span>');
        _printLine('  Exploited:  <span class="cy-warn">' + exploited + '</span>');
        _printLine('  Controlled: <span class="cy-magenta">' + controlled + '</span>');
        _printLine('  Denied:     <span class="cy-error">' + denied + '</span>');
        _printLine('  Active ops: ' + _activeOps.length);
        _printLine('');

        // Network summary
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (hasComm) {
            var metrics = CommEngine.getMetrics();
            _printLine('  <span class="cy-cyan">Network Status:</span>');
            _printLine('    Links: ' + metrics.activeLinks + '/' + metrics.totalLinks);
            _printLine('    Delivery: ' + (metrics.packetDeliveryRate * 100).toFixed(1) + '%');
            _printLine('    Jammers: ' + metrics.activeJammers);
        }
    }

    function _cmdTargets(args) {
        var keys = Object.keys(_targets);
        if (keys.length === 0) {
            _printLine('<span class="cy-dim">No targets discovered. Use "scan all" to discover.</span>');
            return;
        }

        _printLine('<span class="cy-cyan cy-bold">═══ DISCOVERED TARGETS ═══</span>');
        _printLine('');
        _printLine(_pad('ID', 20) + _pad('NAME', 18) + _pad('STATE', 14) + _pad('ACCESS', 12) + 'HARD');

        keys.sort();
        for (var i = 0; i < keys.length; i++) {
            var tid = keys[i];
            var tgt = _targets[tid];
            var ent = _world ? _world.getEntity(tid) : null;
            var name = ent ? (ent.name || '---') : '---';

            var stateColor = tgt.state === TARGET_STATE.CONTROLLED ? 'cy-magenta' :
                             tgt.state === TARGET_STATE.EXPLOITED ? 'cy-warn' :
                             tgt.state === TARGET_STATE.DENIED ? 'cy-error' :
                             tgt.state === TARGET_STATE.SCANNED ? 'cy-info' : 'cy-dim';

            _printLine(
                _pad(_esc(tid), 20) +
                _pad(_esc(name).substring(0, 16), 18) +
                '<span class="' + stateColor + '">' + _pad(tgt.state, 14) + '</span>' +
                _pad(ACCESS_NAMES[tgt.access], 12) +
                tgt.hardening + '/10'
            );
        }
    }

    function _cmdOps(args) {
        if (_activeOps.length === 0) {
            _printLine('<span class="cy-dim">No active operations.</span>');
            return;
        }

        _printLine('<span class="cy-cyan cy-bold">═══ ACTIVE OPERATIONS ═══</span>');
        for (var i = 0; i < _activeOps.length; i++) {
            var op = _activeOps[i];
            var pct = Math.min(100, (op.progress / op.duration * 100)).toFixed(0);
            _printLine('  [' + op.id + '] ' + op.type.toUpperCase() + ' → ' + _esc(op.targetId) +
                ' ' + _progressBar(op.progress / op.duration) + ' ' + pct + '%');
        }
    }

    function _cmdNetworks(args) {
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (!hasComm) {
            _printLine('<span class="cy-error">CommEngine not available</span>');
            return;
        }

        var status = CommEngine.getNetworkStatus();
        if (!status || status.length === 0) {
            _printLine('<span class="cy-dim">No networks detected.</span>');
            return;
        }

        _printLine('<span class="cy-cyan cy-bold">═══ DETECTED NETWORKS ═══</span>');
        for (var n = 0; n < status.length; n++) {
            var net = status[n];
            var healthPct = (net.health * 100).toFixed(0);
            var hColor = net.health > 0.7 ? 'cy-success' : net.health > 0.3 ? 'cy-warn' : 'cy-error';
            _printLine('');
            _printLine('  <span class="cy-cyan">' + _esc(net.name || net.id) + '</span> [' + net.type + ']');
            _printLine('    Members: ' + net.activeMembers + '/' + net.totalMembers);
            _printLine('    Links:   ' + net.activeLinks + '/' + net.totalLinks);
            _printLine('    Health:  <span class="' + hColor + '">' + healthPct + '% ' + net.healthStatus + '</span>');
            if (net.jammedLinks > 0) _printLine('    <span class="cy-error">Jammed links: ' + net.jammedLinks + '</span>');
            if (net.compromisedLinks > 0) _printLine('    <span class="cy-magenta">Compromised: ' + net.compromisedLinks + '</span>');
        }
    }

    function _cmdTopology(args) {
        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (!hasComm) {
            _printLine('<span class="cy-error">CommEngine not available</span>');
            return;
        }

        var status = CommEngine.getNetworkStatus();
        if (!status || status.length === 0) {
            _printLine('<span class="cy-dim">No networks to map.</span>');
            return;
        }

        var filter = args[0] ? args[0].toLowerCase() : null;

        for (var n = 0; n < status.length; n++) {
            var net = status[n];
            if (filter && net.id.toLowerCase().indexOf(filter) < 0 &&
                (net.name || '').toLowerCase().indexOf(filter) < 0) continue;

            var hColor = net.health > 0.7 ? 'cy-success' : net.health > 0.3 ? 'cy-warn' : 'cy-error';
            _printLine('');
            _printLine('<span class="cy-cyan cy-bold">═══ TOPOLOGY: ' + _esc(net.name || net.id) + ' [' + net.type + '] ═══</span>');
            _printLine('  Health: <span class="' + hColor + '">' + (net.health * 100).toFixed(0) + '% ' + net.healthStatus + '</span>');
            _printLine('');

            // Build node → links map
            var nodeLinks = {};
            var allNodes = [];
            var nodeSet = {};
            if (net.links) {
                for (var li = 0; li < net.links.length; li++) {
                    var lk = net.links[li];
                    if (!nodeSet[lk.fromId]) { nodeSet[lk.fromId] = true; allNodes.push(lk.fromId); }
                    if (!nodeSet[lk.toId]) { nodeSet[lk.toId] = true; allNodes.push(lk.toId); }
                    if (!nodeLinks[lk.fromId]) nodeLinks[lk.fromId] = [];
                    nodeLinks[lk.fromId].push(lk);
                }
            }

            // Render each node
            for (var ni = 0; ni < allNodes.length; ni++) {
                var nodeId = allNodes[ni];
                var ent = _world ? _world.getEntity(nodeId) : null;
                var name = ent ? (ent.name || nodeId) : nodeId;
                var team = ent ? ent.team : '?';
                var teamC = team === 'blue' ? 'cy-cyan' : team === 'red' ? 'cy-error' : 'cy-dim';

                // Cyber status tag
                var cyberTag = '';
                var tgt = _targets[nodeId];
                if (ent && ent.state && ent.state._commBricked) cyberTag = ' <span class="cy-error">[BRICKED]</span>';
                else if (tgt) {
                    if (tgt.state === TARGET_STATE.CONTROLLED) cyberTag = ' <span class="cy-magenta">[CTRL]</span>';
                    else if (tgt.state === TARGET_STATE.EXPLOITED) cyberTag = ' <span class="cy-warn">[PWNED]</span>';
                    else if (tgt.state === TARGET_STATE.DENIED) cyberTag = ' <span class="cy-error">[DOWN]</span>';
                    else if (tgt.state === TARGET_STATE.SCANNED) cyberTag = ' <span class="cy-dim">[ENUM]</span>';
                }

                _printLine('  <span class="' + teamC + '">╔═ ' + _esc(name.substring(0, 22)) + ' ═╗</span>' + cyberTag);

                var links = nodeLinks[nodeId] || [];
                for (var ci = 0; ci < links.length; ci++) {
                    var cl = links[ci];
                    var peerEnt = _world ? _world.getEntity(cl.toId) : null;
                    var peerName = peerEnt ? (peerEnt.name || cl.toId) : cl.toId;

                    var arrow = cl.alive ? '───▸' : '<span class="cy-error">─╳─▸</span>';
                    var qc = !cl.alive ? 'cy-error' :
                             cl.quality === 'EXCELLENT' || cl.quality === 'GOOD' ? 'cy-success' :
                             cl.quality === 'MARGINAL' ? 'cy-warn' : 'cy-error';
                    var extras = '';
                    if (cl.jammed) extras += ' <span class="cy-error">JAM</span>';

                    _printLine('  <span class="' + teamC + '">║</span> <span class="' + qc + '">' + arrow + '</span> ' + _esc(peerName.substring(0, 20)) + extras);
                }
                _printLine('  <span class="' + teamC + '">╚════════════════════════╝</span>');
            }
        }
    }

    function _cmdKill(args) {
        if (!args[0]) {
            _printLine('<span class="cy-error">Usage: kill <op-id></span>');
            return;
        }

        var opId = parseInt(args[0]);
        for (var i = 0; i < _activeOps.length; i++) {
            if (_activeOps[i].id === opId) {
                _printLine('<span class="cy-warn">[!] Killed operation ' + opId + ' (' + _activeOps[i].type + ' → ' + _activeOps[i].targetId + ')</span>');
                _activeOps.splice(i, 1);
                return;
            }
        }
        _printLine('<span class="cy-error">Operation not found: ' + opId + '</span>');
    }

    // -----------------------------------------------------------------------
    // Operation engine
    // -----------------------------------------------------------------------
    function _beginOp(type, targetId, callback) {
        var tgt = _targets[targetId];
        var hardening = tgt ? tgt.hardening : 3;
        var timing = TIMING[type] || { base: 5, perHardening: 1 };
        var duration = timing.base + hardening * timing.perHardening;
        var successChance = Math.max(0.15, 0.9 - hardening * 0.07);

        _beginOpCustom(type, targetId, duration, successChance, callback);
    }

    function _beginOpCustom(type, targetId, duration, successChance, callback) {
        var op = {
            id: ++_opIdCounter,
            type: type,
            targetId: targetId,
            progress: 0,
            duration: duration,
            successChance: successChance,
            callback: callback,
            startTime: _world ? _world.simTime : Date.now() / 1000,
            progressLineEl: null
        };

        _activeOps.push(op);

        // Create progress line in output
        var line = document.createElement('div');
        line.innerHTML = '  <span class="cy-dim">[op:' + op.id + '] ' + type.toUpperCase() + ' → ' + _esc(targetId) + ' </span>' +
            '<span class="cyber-progress-bar"><span class="cyber-progress-fill" style="width:0%"></span></span>' +
            '<span class="cy-progress"> 0%</span>';
        _output.appendChild(line);
        _output.scrollTop = _output.scrollHeight;
        op.progressLineEl = line;

        _updateHeader();
    }

    function _cancelOps() {
        while (_activeOps.length > 0) {
            var op = _activeOps.pop();
            if (op.progressLineEl) {
                op.progressLineEl.innerHTML += ' <span class="cy-error">[CANCELLED]</span>';
            }
            // Clear scanning flag on target
            if (_world) {
                var cancelEnt = _world.getEntity(op.targetId);
                if (cancelEnt && cancelEnt.state) {
                    cancelEnt.state._cyberScanning = false;
                    cancelEnt.state._cyberOpType = null;
                    cancelEnt.state._cyberOpProgress = 0;
                }
            }
        }
        _updateHeader();
    }

    // -----------------------------------------------------------------------
    // Frame update
    // -----------------------------------------------------------------------
    function update(dt) {
        if (!_initialized) return;

        // Set scanning flags on entities with active scan operations
        if (_world) {
            for (var oi = 0; oi < _activeOps.length; oi++) {
                var scanOp = _activeOps[oi];
                if (scanOp.type === 'scan' || scanOp.type === 'exploit' || scanOp.type === 'brick' ||
                    scanOp.type === 'ddos' || scanOp.type === 'mitm' || scanOp.type === 'inject') {
                    var scanEnt = _world.getEntity(scanOp.targetId);
                    if (scanEnt && scanEnt.state) {
                        scanEnt.state._cyberScanning = true;
                        scanEnt.state._cyberOpType = scanOp.type;
                        scanEnt.state._cyberOpProgress = scanOp.progress / scanOp.duration;
                    }
                }
            }
        }

        // Process active operations
        var i = _activeOps.length;
        while (i--) {
            var op = _activeOps[i];
            op.progress += dt;

            // Update progress display
            var pct = Math.min(100, (op.progress / op.duration * 100));
            if (op.progressLineEl) {
                var fill = op.progressLineEl.querySelector('.cyber-progress-fill');
                var text = op.progressLineEl.querySelector('.cy-progress');
                if (fill) fill.style.width = pct.toFixed(0) + '%';
                if (text) text.textContent = ' ' + pct.toFixed(0) + '%';
            }

            // Complete?
            if (op.progress >= op.duration) {
                var success = Math.random() < op.successChance;

                // Clear scanning flag
                if (_world) {
                    var opEnt = _world.getEntity(op.targetId);
                    if (opEnt && opEnt.state) {
                        opEnt.state._cyberScanning = false;
                        opEnt.state._cyberOpType = null;
                        opEnt.state._cyberOpProgress = 0;
                    }
                }

                // Update progress to 100%
                if (op.progressLineEl) {
                    var fill2 = op.progressLineEl.querySelector('.cyber-progress-fill');
                    var text2 = op.progressLineEl.querySelector('.cy-progress');
                    if (fill2) {
                        fill2.style.width = '100%';
                        fill2.style.background = success ? '#44ff88' : '#ff4444';
                    }
                    if (text2) {
                        text2.innerHTML = success ? ' <span class="cy-success">DONE</span>' : ' <span class="cy-error">FAIL</span>';
                    }
                }

                // Call completion handler
                if (op.callback) op.callback(success);

                _activeOps.splice(i, 1);
                _updateHeader();
            }
        }

        // Sync visual state flags from target tracking to entity.state
        _syncVisualFlags();

        // Update header ops count
        if (_visible && _activeOps.length > 0) {
            _updateHeader();
        }
    }

    /**
     * Sync target tracking state to entity.state for visual components to read.
     */
    function _syncVisualFlags() {
        if (!_world) return;
        for (var tid in _targets) {
            var tgt = _targets[tid];
            var ent = _world.getEntity(tid);
            if (!ent || !ent.state) continue;

            ent.state._cyberScanned = (tgt.state !== TARGET_STATE.UNDISCOVERED);
            ent.state._cyberExploited = (tgt.state === TARGET_STATE.EXPLOITED || tgt.access >= ACCESS.USER);
            ent.state._cyberControlled = (tgt.state === TARGET_STATE.CONTROLLED || tgt.access >= ACCESS.PERSISTENT);
            ent.state._cyberDenied = (tgt.state === TARGET_STATE.DENIED);
            ent.state._cyberAccessLevel = tgt.access;
        }
    }

    function _updateHeader() {
        var opsEl = document.getElementById('cyberOpsCount');
        if (opsEl) opsEl.textContent = 'OPS: ' + _activeOps.length;

        // Show current access summary
        var accEl = document.getElementById('cyberAccess');
        if (accEl) {
            var maxAccess = 0;
            for (var tid in _targets) {
                if (_targets[tid].access > maxAccess) maxAccess = _targets[tid].access;
            }
            accEl.textContent = 'MAX ACCESS: ' + ACCESS_NAMES[maxAccess];
        }
    }

    // -----------------------------------------------------------------------
    // Target management
    // -----------------------------------------------------------------------
    function _getOrCreateTarget(entity) {
        if (!_targets[entity.id]) {
            _targets[entity.id] = {
                state: TARGET_STATE.UNDISCOVERED,
                access: ACCESS.NONE,
                hardening: _computeHardening(entity),
                lastScan: 0,
                vulns: [],
                services: [],
                firewalled: false,
                isPivot: false
            };
        }
        return _targets[entity.id];
    }

    function _computeHardening(entity) {
        // Compute hardening based on entity type/importance
        var base = 3;
        var type = (entity.type || '').toLowerCase();
        if (type === 'ground_station' || type === 'ground') base = 5;
        if (type === 'satellite') base = 4;

        var name = (entity.name || '').toLowerCase();
        if (name.indexOf('command') >= 0 || name.indexOf('c2') >= 0) base = 7;
        if (name.indexOf('awacs') >= 0) base = 6;

        return Math.min(10, base + Math.floor(Math.random() * 2));
    }

    function _assessVulns(entity) {
        var vulns = [];
        var hardening = _targets[entity.id] ? _targets[entity.id].hardening : 5;
        var numVulns = Math.max(0, 5 - Math.floor(hardening / 2)) + Math.floor(Math.random() * 2);

        var possibleVulns = [
            { name: 'CVE-2026-0142: MIL-STD-1553 buffer overflow', severity: 'CRITICAL' },
            { name: 'CVE-2026-0287: Weak authentication in radar control', severity: 'HIGH' },
            { name: 'CVE-2026-0391: Unencrypted telemetry stream', severity: 'HIGH' },
            { name: 'CVE-2025-4821: Default credentials on management port', severity: 'CRITICAL' },
            { name: 'CVE-2026-0156: RTOS command injection via SNMP', severity: 'HIGH' },
            { name: 'CVE-2026-0544: Weak crypto in Link-16 implementation', severity: 'MEDIUM' },
            { name: 'CVE-2025-9012: Information disclosure via timing attack', severity: 'LOW' },
            { name: 'CVE-2026-0033: GPS spoofing susceptibility', severity: 'MEDIUM' },
        ];

        for (var i = 0; i < Math.min(numVulns, possibleVulns.length); i++) {
            vulns.push(possibleVulns[i]);
        }
        return vulns;
    }

    function _assessServices(entity) {
        var services = ['ssh', 'http'];

        if (entity.getComponent && entity.getComponent('sensors')) {
            services.push('radar-ctrl', 'telemetry');
        }
        if (entity.getComponent && entity.getComponent('weapons')) {
            services.push('fire-ctrl', 'wpn-mgmt');
        }

        var hasComm = typeof CommEngine !== 'undefined' && CommEngine.isInitialized();
        if (hasComm) {
            var comms = CommEngine.getEntityComms(entity.id);
            if (comms && comms.networks.length > 0) {
                services.push('link16-gw', 'crypto');
            }
        }

        return services;
    }

    function _resolveTarget(idOrName) {
        if (!idOrName || !_world) return null;

        var lower = idOrName.toLowerCase();

        // Direct ID match
        var ent = _world.getEntity(idOrName);
        if (ent) return ent;

        // Case-insensitive ID match
        var found = null;
        _world.entities.forEach(function(e) {
            if (found) return;
            if (e.id.toLowerCase() === lower) found = e;
            else if ((e.name || '').toLowerCase() === lower) found = e;
            else if (e.id.toLowerCase().indexOf(lower) >= 0) found = e;
        });

        return found;
    }

    // -----------------------------------------------------------------------
    // CommEngine integration
    // -----------------------------------------------------------------------
    function _notifyCommEngine(type, targetId, active) {
        if (typeof CommEngine === 'undefined' || !CommEngine.isInitialized()) return;

        try {
            if (typeof CommEngine.addCyberAttack === 'function') {
                CommEngine.addCyberAttack({
                    attackerId: '__player__',
                    targetId: targetId,
                    type: type,
                    active: active,
                    data: active
                });
            }
        } catch (e) {
            // Silent failure
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------
    function _pad(str, width) {
        str = String(str);
        while (str.length < width) str += ' ';
        return str;
    }

    function _hardeningBar(level) {
        var filled = Math.min(10, level || 0);
        var bar = '';
        for (var i = 0; i < 10; i++) {
            if (i < filled) {
                bar += i < 3 ? '<span class="cy-success">█</span>' :
                       i < 7 ? '<span class="cy-warn">█</span>' :
                       '<span class="cy-error">█</span>';
            } else {
                bar += '<span class="cy-dim">░</span>';
            }
        }
        return bar + ' ' + filled + '/10';
    }

    function _progressBar(fraction) {
        var width = 20;
        var filled = Math.floor(fraction * width);
        var bar = '[';
        for (var i = 0; i < width; i++) {
            bar += i < filled ? '=' : (i === filled ? '>' : ' ');
        }
        bar += ']';
        return '<span class="cy-progress">' + bar + '</span>';
    }

    // -----------------------------------------------------------------------
    // Set player team
    // -----------------------------------------------------------------------
    function setPlayerTeam(team) {
        _playerTeam = team || 'blue';
    }

    function setWorld(world) {
        _world = world;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    window.CyberCockpit = {
        init: init,
        toggle: toggle,
        isVisible: isVisible,
        update: update,
        setPlayerTeam: setPlayerTeam,
        setWorld: setWorld
    };

})();
