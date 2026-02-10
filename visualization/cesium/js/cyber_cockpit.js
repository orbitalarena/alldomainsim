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

    // Exfil data types and their durations
    var EXFIL_TYPES = {
        radar: { label: 'RADAR CONTACTS', duration: 20, desc: 'Steal radar track data' },
        nav:   { label: 'NAVIGATION DATA', duration: 25, desc: 'Steal position/waypoint data' },
        keys:  { label: 'ENCRYPTION KEYS', duration: 60, desc: 'Steal comm encryption keys' },
        all:   { label: 'ALL DATA', duration: 45, desc: 'Full data exfiltration' }
    };

    // Operation timings (seconds)
    var TIMING = {
        scan:      { base: 3, perHardening: 0.5 },
        exploit:   { base: 8, perHardening: 2 },
        brick:     { base: 2, perHardening: 0.3 },
        ddos:      { base: 1, perHardening: 0.2 },
        mitm:      { base: 5, perHardening: 1 },
        inject:    { base: 4, perHardening: 0.8 },
        exfil:     { base: 20, perHardening: 3 },
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

    function show() {
        if (!_visible) toggle();
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
                        'escalate', 'exfil', 'persist', 'defend', 'redirect', 'lookaway',
                        'isolate', 'score', 'hack', 'takeover', 'sysinfo'];
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
            case 'hack':     _cmdHack(args); break;
            case 'takeover': _cmdTakeover(args); break;
            case 'sysinfo':  _cmdSysinfo(args); break;
            case 'redirect': _cmdRedirect(args); break;
            case 'lookaway': _cmdLookaway(args); break;
            case 'isolate':  _cmdIsolate(args); break;
            case 'score':    _cmdScore(args); break;
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
        _printLine('  <span class="cy-magenta">exfil</span> <target> [type]  Exfiltrate data (radar|nav|keys|all)');
        _printLine('  <span class="cy-magenta">hack</span> <target> <sub>   Hack subsystem (sensors|nav|weapons|comms)');
        _printLine('  <span class="cy-magenta">takeover</span> <target>     Full platform control (all subsystems)');
        _printLine('  <span class="cy-magenta">redirect</span> <tgt> <lat> <lon> Redirect hijacked platform to coords');
        _printLine('  <span class="cy-magenta">lookaway</span> <target> [deg]  Force radar to scan wrong bearing');
        _printLine('  <span class="cy-magenta">isolate</span> <target>      Disconnect node from comm network');
        _printLine('  <span class="cy-magenta">sysinfo</span> <target>      Show onboard computer details');
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
        _printLine('  <span class="cy-info">score</span>                  Cyber warfare scoreboard');
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
            case 'exfil':
                _printLine('<span class="cy-cyan">exfil <target> [data_type]</span>');
                _printLine('  Exfiltrate intelligence data from a compromised target.');
                _printLine('  Requires EXPLOITED state or higher (run "exploit" first).');
                _printLine('');
                _printLine('  <span class="cy-warn">Data types:</span>');
                _printLine('    <span class="cy-info">radar</span>  — Steal radar contacts/tracks (20s)');
                _printLine('           Attacker gains victim radar tracks');
                _printLine('    <span class="cy-info">nav</span>    — Steal position/waypoint data (25s)');
                _printLine('           Attacker knows exact target positions');
                _printLine('    <span class="cy-info">keys</span>   — Steal comm encryption keys (60s)');
                _printLine('           Can decrypt enemy communications');
                _printLine('    <span class="cy-info">all</span>    — Full data exfiltration (45s)');
                _printLine('           Steal all of the above');
                _printLine('');
                _printLine('  Default: all (if no type specified).');
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

                // Show Computer component details if present
                if (entity.getComponent) {
                    var compScan = entity.getComponent('cyber/computer');
                    if (compScan) {
                        _printLine('    <span class="cy-cyan">ONBOARD COMPUTER:</span>');
                        _printLine('      OS: <span class="cy-warn">' + (compScan._os || 'unknown') + '</span>');
                        _printLine('      Vulnerability: ' + _vulnBar(compScan.getVulnerability()));
                        _printLine('      Firewall: ' + (compScan._firewallRating * 100).toFixed(0) + '%');
                        var subs = compScan.getHackableSubsystems();
                        _printLine('      Hackable: <span class="cy-error">' + subs.join(', ') + '</span>');
                    }
                    var fwScan = entity.getComponent('cyber/firewall');
                    if (fwScan) {
                        var fwState = entity.state || {};
                        _printLine('    <span class="cy-cyan">FIREWALL:</span> Rating ' +
                            (fwScan._rating * 100).toFixed(0) + '% | IDS: ' +
                            (fwScan._ids ? '<span class="cy-success">ON</span>' : '<span class="cy-error">OFF</span>') +
                            ' | Health: ' + ((fwState._firewallHealth || 1) * 100).toFixed(0) + '%');
                    }
                }

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

        // Network access check
        var access = _checkNetworkAccess(entity, 'exploit');
        if (!access.reachable) {
            _printLine('<span class="cy-error">[-] No network path to target. Need comm link or pivot node.</span>');
            _printLine('<span class="cy-dim">  Use "pivot" on a compromised node adjacent to target.</span>');
            return;
        }
        if (access.method === 'pivot') {
            _printLine('<span class="cy-dim">[*] Routing through pivot: ' + _esc(access.via) + '</span>');
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

        var access = _checkNetworkAccess(entity, 'mitm');
        if (!access.reachable) {
            _printLine('<span class="cy-error">[-] No network path to target.</span>');
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

        var access = _checkNetworkAccess(entity, 'inject');
        if (!access.reachable) {
            _printLine('<span class="cy-error">[-] No network path to target.</span>');
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

        // Network access check
        var access = _checkNetworkAccess(entity, type);
        if (!access.reachable) {
            _printLine('<span class="cy-error">[-] No network path to target.</span>');
            _printLine('<span class="cy-dim">  Need comm link or pivot. Use "pivot" on adjacent compromised node.</span>');
            return;
        }
        if (access.method === 'pivot') {
            _printLine('<span class="cy-dim">[*] Routing through: ' + _esc(access.via) + '</span>');
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
            _printLine('<span class="cy-error">Usage: exfil <target> [radar|nav|keys|all]</span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);

        // Must be EXPLOITED or higher
        if (tgt.state !== TARGET_STATE.EXPLOITED && tgt.state !== TARGET_STATE.CONTROLLED) {
            if (tgt.access < ACCESS.USER) {
                _printLine('<span class="cy-error">[-] Target must be EXPLOITED or CONTROLLED. Run "exploit" first.</span>');
                return;
            }
        }

        // Parse data type (default: all)
        var dataType = 'all';
        if (args.length >= 2) {
            dataType = args[1].toLowerCase();
        }
        var exfilInfo = EXFIL_TYPES[dataType];
        if (!exfilInfo) {
            _printLine('<span class="cy-error">Unknown data type: ' + _esc(dataType) + '</span>');
            _printLine('<span class="cy-dim">  Valid types: radar, nav, keys, all</span>');
            return;
        }

        // Duration scales with hardening
        var duration = exfilInfo.duration + tgt.hardening * 3;
        var successChance = Math.max(0.25, 0.9 - tgt.hardening * 0.06);

        _printLine('<span class="cy-info">[*] Exfiltrating ' + exfilInfo.label + ' from ' + _esc(entity.id) + '...</span>');
        _printLine('    <span class="cy-dim">Estimated time: ~' + Math.round(duration) + 's</span>');

        _beginOpCustom('exfil_' + dataType, entity.id, duration, successChance, function(success) {
            if (success) {
                _printLine('<span class="cy-success cy-bold">[+] EXFIL COMPLETE — ' + exfilInfo.label + ' from ' + _esc(entity.name || entity.id) + '</span>');

                var targetId = entity.id;
                var targetState = entity.state || {};

                // Set exfiltration flags on target
                targetState._dataExfiltrated = true;
                targetState._exfilProgress = 1.0;

                // Find the player entity to set attacker-side flags
                var playerEntity = _findPlayerEntity();
                var playerState = playerEntity ? playerEntity.state : null;

                if (dataType === 'radar' || dataType === 'all') {
                    if (playerState) playerState._exfilRadarFrom = targetId;
                    _printLine('    <span class="cy-cyan">RADAR:</span> Stolen radar contact tracks');
                    // Show what we got
                    if (entity.getComponent && entity.getComponent('sensors')) {
                        var sComp = entity.getComponent('sensors');
                        _printLine('      Sensor type: ' + (sComp.config ? sComp.config.type : 'radar'));
                        if (sComp.config && sComp.config.maxRange_m) {
                            _printLine('      Range: ' + (sComp.config.maxRange_m / 1000).toFixed(0) + ' km');
                        }
                        _printLine('      <span class="cy-success">Attacker now receives victim radar tracks</span>');
                    } else {
                        _printLine('      <span class="cy-success">Radar track data captured</span>');
                    }
                }

                if (dataType === 'nav' || dataType === 'all') {
                    if (playerState) playerState._exfilNavFrom = targetId;
                    _printLine('    <span class="cy-warn">NAV:</span> Stolen navigation/position data');
                    if (entity.state && entity.state.lat != null) {
                        var lat = (entity.state.lat * 180 / Math.PI).toFixed(4);
                        var lon = (entity.state.lon * 180 / Math.PI).toFixed(4);
                        var alt = entity.state.alt ? Math.round(entity.state.alt) + 'm' : '?';
                        _printLine('      Current pos: ' + lat + ', ' + lon + ' alt ' + alt);
                    }
                    if (entity.getComponent && entity.getComponent('ai')) {
                        var aiComp = entity.getComponent('ai');
                        if (aiComp.config && aiComp.config.waypoints) {
                            _printLine('      Waypoints: ' + aiComp.config.waypoints.length + ' route points extracted');
                        }
                    }
                    _printLine('      <span class="cy-success">Attacker knows exact target positions</span>');
                }

                if (dataType === 'keys' || dataType === 'all') {
                    if (playerState) {
                        playerState._exfilKeysFrom = targetId;
                        playerState._hasEnemyKeys = true;
                    }
                    _printLine('    <span class="cy-error">KEYS:</span> Stolen comm encryption keys');
                    _printLine('      <span class="cy-success">Can now decrypt enemy communications</span>');
                    _printLine('      <span class="cy-dim">SIGINT intercepts will show cleartext.</span>');
                }

                // Mark entity as intel-exfiltrated
                targetState._cyberIntelExfiltrated = true;

                _printLine('');
                _printLine('    <span class="cy-dim">Intel shared to friendly COP.</span>');

                // Notify CommEngine
                _notifyCommEngine('exfil', entity.id, true);
            } else {
                _printLine('<span class="cy-error">[-] Exfiltration blocked — data encrypted or transfer interrupted.</span>');
                if (Math.random() < 0.25) {
                    _printLine('<span class="cy-error">[!] ALERT: Data exfiltration attempt detected by target!</span>');
                    tgt.hardening = Math.min(10, tgt.hardening + 1);
                }
            }
        });
    }

    /**
     * Find the player entity in the world (first entity on player team that
     * has player_input control or is the first blue entity).
     */
    function _findPlayerEntity() {
        if (!_world) return null;
        var player = null;
        _world.entities.forEach(function(ent) {
            if (player) return;
            if (ent.team !== _playerTeam) return;
            if (!ent.active) return;
            // Prefer entities with player control
            if (ent.getComponent && ent.getComponent('control')) {
                var ctrl = ent.getComponent('control');
                if (ctrl.config && ctrl.config.type === 'player_input') {
                    player = ent;
                    return;
                }
            }
        });
        // Fallback: first active entity on player team
        if (!player) {
            _world.entities.forEach(function(ent) {
                if (player) return;
                if (ent.team === _playerTeam && ent.active) player = ent;
            });
        }
        return player;
    }

    // -----------------------------------------------------------------------
    // Commands: Subsystem Hacking
    // -----------------------------------------------------------------------

    var SUBSYSTEM_LABELS = {
        'sensors':    { name: 'Sensors',    effect: 'Radar/EO/IR disabled + redirected' },
        'nav':        { name: 'Navigation', key: 'navigation', effect: 'Heading/course hijacked' },
        'navigation': { name: 'Navigation', effect: 'Heading/course hijacked' },
        'weapons':    { name: 'Weapons',    effect: 'Fire control disabled' },
        'comms':      { name: 'Comms',      effect: 'Radio silenced + data exfiltration' }
    };

    function _cmdHack(args) {
        if (args.length < 2) {
            _printLine('<span class="cy-error">Usage: hack <target> <subsystem></span>');
            _printLine('<span class="cy-dim">  Subsystems: sensors, nav, weapons, comms</span>');
            return;
        }

        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(args[0]) + '</span>');
            return;
        }

        var sub = args[1].toLowerCase();
        var subInfo = SUBSYSTEM_LABELS[sub];
        if (!subInfo) {
            _printLine('<span class="cy-error">Unknown subsystem: ' + _esc(sub) + '</span>');
            _printLine('<span class="cy-dim">  Valid: sensors, nav, weapons, comms</span>');
            return;
        }
        var subKey = subInfo.key || sub; // 'nav' → 'navigation'

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access. Run "escalate" first.</span>');
            return;
        }

        // Check if Computer component exists and subsystem is hackable
        var hasComp = false;
        if (entity.getComponent) {
            var comp = entity.getComponent('cyber/computer');
            if (comp) {
                hasComp = true;
                var subs = comp.getHackableSubsystems();
                if (subs.indexOf(subKey) < 0) {
                    _printLine('<span class="cy-error">[-] ' + subInfo.name + ' not hackable on this platform.</span>');
                    _printLine('<span class="cy-dim">  Available: ' + subs.join(', ') + '</span>');
                    return;
                }
            }
        }

        _printLine('<span class="cy-info">[*] Hacking ' + subInfo.name + ' on ' + _esc(entity.id) + '...</span>');

        var duration = 4 + tgt.hardening * 0.5;
        var successChance = Math.max(0.3, 0.85 - tgt.hardening * 0.05);

        _beginOpCustom('hack_' + subKey, entity.id, duration, successChance, function(success) {
            if (success) {
                // Set the subsystem as hacked on Computer component
                if (entity.state && entity.state._computerHackedSubsystems) {
                    entity.state._computerHackedSubsystems[subKey] = true;
                }

                // Set direct effect flags for systems without Computer component
                if (entity.state) {
                    if (subKey === 'sensors') {
                        entity.state._sensorDisabled = true;
                        entity.state._sensorRedirected = true;
                    } else if (subKey === 'navigation') {
                        entity.state._navigationHijacked = true;
                    } else if (subKey === 'weapons') {
                        entity.state._weaponsDisabled = true;
                    } else if (subKey === 'comms') {
                        entity.state._commsDisabled = true;
                        entity.state._dataExfiltrated = true;
                    }
                }

                _printLine('<span class="cy-success">[+] ' + subInfo.name.toUpperCase() + ' COMPROMISED on ' + _esc(entity.id) + '</span>');
                _printLine('    Effect: <span class="cy-warn">' + subInfo.effect + '</span>');
            } else {
                _printLine('<span class="cy-error">[-] ' + subInfo.name + ' hack failed — access denied.</span>');
            }
        });
    }

    function _cmdTakeover(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: takeover <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access. Run "escalate" first.</span>');
            return;
        }

        // Get hackable subsystems
        var subsystems = ['sensors', 'navigation', 'weapons', 'comms'];
        if (entity.getComponent) {
            var comp = entity.getComponent('cyber/computer');
            if (comp) subsystems = comp.getHackableSubsystems();
        }

        _printLine('<span class="cy-info">[*] FULL TAKEOVER — hacking all subsystems on ' + _esc(entity.id) + '...</span>');
        _printLine('    <span class="cy-dim">Targeting: ' + subsystems.join(', ') + '</span>');

        var duration = 10 + tgt.hardening * 2;
        var successChance = Math.max(0.15, 0.7 - tgt.hardening * 0.06);

        _beginOpCustom('takeover', entity.id, duration, successChance, function(success) {
            if (success) {
                // Hack all subsystems
                if (entity.state) {
                    if (!entity.state._computerHackedSubsystems) {
                        entity.state._computerHackedSubsystems = {};
                    }
                    for (var si = 0; si < subsystems.length; si++) {
                        entity.state._computerHackedSubsystems[subsystems[si]] = true;
                    }
                    entity.state._sensorDisabled = true;
                    entity.state._sensorRedirected = true;
                    entity.state._navigationHijacked = true;
                    entity.state._weaponsDisabled = true;
                    entity.state._commsDisabled = true;
                    entity.state._dataExfiltrated = true;
                    entity.state._fullControl = true;
                    entity.state._computerCompromised = true;
                    entity.state._computerAccessLevel = 'PERSISTENT';
                }

                tgt.access = ACCESS.PERSISTENT;
                tgt.state = TARGET_STATE.CONTROLLED;

                _printLine('<span class="cy-success cy-bold">[+] ███ FULL TAKEOVER ███ — ' + _esc(entity.name || entity.id) + '</span>');
                _printLine('    <span class="cy-warn">ALL subsystems compromised. Platform under your control.</span>');

                var typeLabel = (entity.type || 'platform').toUpperCase();
                _printLine('    <span class="cy-cyan">Platform type: ' + typeLabel + '</span>');
                if (entity.type === 'satellite') {
                    _printLine('    <span class="cy-magenta">Satellite captured — can redirect orbit, sensors, comms.</span>');
                } else if (entity.type === 'aircraft') {
                    _printLine('    <span class="cy-magenta">Aircraft captured — can redirect flight path, weapons, sensors.</span>');
                } else if (entity.type === 'ground' || entity.type === 'ground_station') {
                    _printLine('    <span class="cy-magenta">Ground node captured — can disable defense systems, exfil data.</span>');
                } else if (entity.type === 'naval') {
                    _printLine('    <span class="cy-magenta">Naval vessel captured — can redirect course, weapons, sensors.</span>');
                }

                _notifyCommEngine('exploit', entity.id, true);
            } else {
                _printLine('<span class="cy-error">[-] Takeover failed — defensive measures blocked access.</span>');
                if (Math.random() < 0.5) {
                    _printLine('<span class="cy-error">[!] ALERT: Full intrusion attempt detected!</span>');
                    tgt.hardening = Math.min(10, tgt.hardening + 2);
                }
            }
        });
    }

    function _cmdSysinfo(args) {
        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Usage: sysinfo <target></span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.state === TARGET_STATE.UNDISCOVERED) {
            _printLine('<span class="cy-error">[-] Target not scanned. Use "scan" first.</span>');
            return;
        }

        _printLine('<span class="cy-cyan cy-bold">═══ SYSTEM INFO: ' + _esc(entity.name || entity.id) + ' ═══</span>');
        _printLine('  Type: ' + (entity.type || 'unknown'));
        _printLine('  Team: ' + (entity.team || 'unknown'));
        _printLine('  Hardening: ' + _hardeningBar(tgt.hardening));

        if (entity.getComponent) {
            var comp = entity.getComponent('cyber/computer');
            if (comp) {
                _printLine('');
                _printLine('  <span class="cy-cyan">ONBOARD COMPUTER</span>');
                _printLine('    OS: <span class="cy-warn">' + (comp._os || 'unknown') + '</span>');
                _printLine('    Hardening: ' + (comp._hardening * 100).toFixed(0) + '%');
                _printLine('    Patch Level: ' + (comp._patchLevel * 100).toFixed(0) + '%');
                _printLine('    Firewall: ' + (comp._firewallRating * 100).toFixed(0) + '%');
                _printLine('    Vulnerability: ' + _vulnBar(comp.getVulnerability()));
                var subs = comp.getHackableSubsystems();
                _printLine('    Hackable: ' + subs.join(', '));

                // Show hacked state
                if (entity.state && entity.state._computerHackedSubsystems) {
                    var hacked = entity.state._computerHackedSubsystems;
                    var hackedList = [];
                    for (var s = 0; s < subs.length; s++) {
                        if (hacked[subs[s]]) hackedList.push(subs[s]);
                    }
                    if (hackedList.length > 0) {
                        _printLine('    <span class="cy-error">COMPROMISED: ' + hackedList.join(', ') + '</span>');
                    }
                }
                if (entity.state && entity.state._fullControl) {
                    _printLine('    <span class="cy-error cy-bold">██ FULL CONTROL ACTIVE ██</span>');
                }
            } else {
                _printLine('');
                _printLine('  <span class="cy-dim">No onboard computer detected (legacy system).</span>');
            }

            var fw = entity.getComponent('cyber/firewall');
            if (fw) {
                _printLine('');
                _printLine('  <span class="cy-cyan">FIREWALL</span>');
                _printLine('    Rating: ' + (fw._rating * 100).toFixed(0) + '%');
                _printLine('    IDS: ' + (fw._ids ? 'ENABLED' : 'DISABLED'));
                _printLine('    Rules: ' + (fw._rules || 'default'));
                if (entity.state) {
                    _printLine('    Health: ' + ((entity.state._firewallHealth || 1) * 100).toFixed(0) + '%');
                    _printLine('    Bypassed: ' + (entity.state._firewallBypassed ? '<span class="cy-error">YES</span>' : 'NO'));
                    _printLine('    Alerts: ' + (entity.state._firewallAlerts || 0));
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Commands: Redirect, Lookaway, Isolate, Score
    // -----------------------------------------------------------------------

    /**
     * redirect <target> <lat> <lon> [alt] — Redirect a hijacked platform to fly
     * toward the specified geographic coordinates. Requires navigation to be
     * hijacked (_navigationHijacked). Sets _hijackWaypoint on target entity.
     */
    function _cmdRedirect(args) {
        if (args.length < 3) {
            _printLine('<span class="cy-error">Usage: redirect <target> <lat> <lon> [alt]</span>');
            _printLine('<span class="cy-dim">  Coordinates in degrees. Alt in meters (default: 500).</span>');
            _printLine('<span class="cy-dim">  Requires navigation to be hacked first.</span>');
            return;
        }

        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(args[0]) + '</span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access. Run "escalate" first.</span>');
            return;
        }

        if (!entity.state || !entity.state._navigationHijacked) {
            _printLine('<span class="cy-error">[-] Navigation not hijacked. Run "hack ' + _esc(entity.id) + ' nav" first.</span>');
            return;
        }

        var lat = parseFloat(args[1]);
        var lon = parseFloat(args[2]);
        var alt = args.length > 3 ? parseFloat(args[3]) : 500;

        if (isNaN(lat) || isNaN(lon)) {
            _printLine('<span class="cy-error">[-] Invalid coordinates. Use decimal degrees.</span>');
            return;
        }

        // Convert degrees to radians for internal use
        var DEG_RAD = Math.PI / 180;
        entity.state._hijackWaypoint = {
            lat: lat * DEG_RAD,
            lon: lon * DEG_RAD,
            alt: alt,
            speed: 100  // slow — vulnerable
        };

        _printLine('<span class="cy-success">[+] REDIRECT — ' + _esc(entity.name || entity.id) + '</span>');
        _printLine('    Target coords: <span class="cy-cyan">' + lat.toFixed(4) + '°, ' + lon.toFixed(4) + '°</span> alt <span class="cy-cyan">' + alt + 'm</span>');
        _printLine('    <span class="cy-warn">Platform will fly toward specified coordinates.</span>');

        if (entity.type === 'aircraft') {
            _printLine('    <span class="cy-magenta">Aircraft descending to ' + alt + 'm — entering SAM engagement zone.</span>');
        } else if (entity.type === 'satellite') {
            _printLine('    <span class="cy-magenta">Satellite orbit modification in progress.</span>');
        }
    }

    /**
     * lookaway <target> [bearing_deg] — Force a compromised radar to scan
     * a useless bearing. Sets _sensorForcedBearing on target.
     * Requires sensors to be hacked.
     */
    function _cmdLookaway(args) {
        if (args.length < 1) {
            _printLine('<span class="cy-error">Usage: lookaway <target> [bearing_deg]</span>');
            _printLine('<span class="cy-dim">  Default: 180° (opposite of threats). Range: 0-360.</span>');
            _printLine('<span class="cy-dim">  Requires sensors to be hacked first.</span>');
            return;
        }

        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(args[0]) + '</span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access. Run "escalate" first.</span>');
            return;
        }

        var deg = entity.state._cyberDegradation;
        if (!deg || deg.sensors < 0.5) {
            _printLine('<span class="cy-error">[-] Sensors not sufficiently degraded. Run "hack ' + _esc(entity.id) + ' sensors" first.</span>');
            return;
        }

        var bearing = args.length > 1 ? parseFloat(args[1]) : 180;
        if (isNaN(bearing)) bearing = 180;
        bearing = ((bearing % 360) + 360) % 360;

        entity.state._sensorRedirected = true;
        entity.state._sensorForcedBearing = bearing;

        _printLine('<span class="cy-success">[+] LOOKAWAY — ' + _esc(entity.name || entity.id) + '</span>');
        _printLine('    Forced bearing: <span class="cy-cyan">' + bearing.toFixed(0) + '°</span>');
        _printLine('    <span class="cy-warn">Radar now scanning in wrong direction.</span>');
        _printLine('    <span class="cy-dim">Threats approaching from other bearings will go undetected.</span>');
    }

    /**
     * isolate <target> — Disconnect a compromised node from all comm networks.
     * Requires the target to be exploited. Sets _commIsolated on entity state,
     * which CommEngine uses to exclude it from packet routing.
     */
    function _cmdIsolate(args) {
        if (args.length < 1) {
            _printLine('<span class="cy-error">Usage: isolate <target></span>');
            _printLine('<span class="cy-dim">  Disconnects node from comm network. Can isolate enemy OR friendly nodes.</span>');
            return;
        }

        var entity = _resolveTarget(args[0]);
        if (!entity) {
            _printLine('<span class="cy-error">Target not found: ' + _esc(args[0]) + '</span>');
            return;
        }

        var tgt = _getOrCreateTarget(entity);

        // Isolating friendly nodes requires only SCANNED state (defensive action)
        if (entity.team === _playerTeam) {
            if (!entity.state) return;
            entity.state._commIsolated = true;
            _printLine('<span class="cy-success">[+] ISOLATED — ' + _esc(entity.name || entity.id) + ' (friendly)</span>');
            _printLine('    <span class="cy-warn">Node disconnected from comm network as defensive measure.</span>');
            _printLine('    <span class="cy-dim">Will not receive or forward any packets.</span>');
            return;
        }

        // Isolating enemy nodes requires ROOT access
        if (tgt.access < ACCESS.ROOT) {
            _printLine('<span class="cy-error">[-] Need ROOT access on enemy node. Run "escalate" first.</span>');
            return;
        }

        if (!entity.state) return;
        entity.state._commIsolated = true;

        _printLine('<span class="cy-success">[+] ISOLATED — ' + _esc(entity.name || entity.id) + '</span>');
        _printLine('    <span class="cy-warn">Enemy node cut off from comm network.</span>');
        _printLine('    <span class="cy-dim">No targeting data, no track updates, no command relay.</span>');

        // Notify CommEngine
        _notifyCommEngine('isolate', entity.id, true);
    }

    /**
     * score — Display cyber warfare scoreboard with per-team metrics.
     * Scans all entities in the world and tallies cyber state flags.
     */
    function _cmdScore(args) {
        if (!_world) {
            _printLine('<span class="cy-error">No world loaded.</span>');
            return;
        }

        var stats = {};

        _world.entities.forEach(function(ent) {
            if (!ent.state || !ent.active) return;
            var team = ent.team || 'neutral';
            if (!stats[team]) {
                stats[team] = { total: 0, scanned: 0, exploited: 0, controlled: 0,
                    sensorsOff: 0, weaponsOff: 0, navHijacked: 0, commsOff: 0,
                    bricked: 0, isolated: 0, dataExfil: 0 };
            }
            var t = stats[team];
            t.total++;
            if (ent.state._cyberScanning) t.scanned++;
            if (ent.state._cyberExploited) t.exploited++;
            if (ent.state._cyberControlled || ent.state._fullControl) t.controlled++;
            if (ent.state._sensorDisabled) t.sensorsOff++;
            if (ent.state._weaponsDisabled) t.weaponsOff++;
            if (ent.state._navigationHijacked) t.navHijacked++;
            if (ent.state._commsDisabled) t.commsOff++;
            if (ent.state._commBricked) t.bricked++;
            if (ent.state._commIsolated) t.isolated++;
            if (ent.state._dataExfiltrated) t.dataExfil++;
        });

        _printLine('<span class="cy-cyan cy-bold">═══ CYBER WARFARE SCOREBOARD ═══</span>');
        _printLine('');

        var teams = Object.keys(stats).sort();
        for (var ti = 0; ti < teams.length; ti++) {
            var team = teams[ti];
            var s = stats[team];
            var color = team === 'blue' ? 'cy-info' : team === 'red' ? 'cy-error' : 'cy-dim';
            _printLine('<span class="' + color + ' cy-bold">' + team.toUpperCase() + '</span> (' + s.total + ' entities)');

            var compromised = s.exploited + s.controlled;
            var subsOff = s.sensorsOff + s.weaponsOff + s.navHijacked + s.commsOff;

            if (compromised === 0 && subsOff === 0 && s.bricked === 0) {
                _printLine('  <span class="cy-success">All systems nominal. No cyber damage.</span>');
            } else {
                if (s.exploited > 0) _printLine('  Exploited: <span class="cy-error">' + s.exploited + '</span>');
                if (s.controlled > 0) _printLine('  Under control: <span class="cy-error cy-bold">' + s.controlled + '</span>');
                if (s.sensorsOff > 0) _printLine('  Sensors disabled: <span class="cy-warn">' + s.sensorsOff + '</span>');
                if (s.weaponsOff > 0) _printLine('  Weapons disabled: <span class="cy-warn">' + s.weaponsOff + '</span>');
                if (s.navHijacked > 0) _printLine('  Nav hijacked: <span class="cy-warn">' + s.navHijacked + '</span>');
                if (s.commsOff > 0) _printLine('  Comms disabled: <span class="cy-warn">' + s.commsOff + '</span>');
                if (s.bricked > 0) _printLine('  Bricked: <span class="cy-error">' + s.bricked + '</span>');
                if (s.isolated > 0) _printLine('  Isolated: <span class="cy-warn">' + s.isolated + '</span>');
                if (s.dataExfil > 0) _printLine('  Data exfiltrated: <span class="cy-magenta">' + s.dataExfil + '</span>');
            }

            // Score: each compromised entity = points for opposing team
            var damageScore = s.exploited * 5 + s.controlled * 10 + subsOff * 3 +
                              s.bricked * 8 + s.dataExfil * 8;
            _printLine('  <span class="cy-dim">Damage taken: ' + damageScore + ' pts</span>');
            _printLine('');
        }

        // Net advantage
        if (stats.blue && stats.red) {
            var blueDmg = stats.blue.exploited * 5 + stats.blue.controlled * 10 +
                (stats.blue.sensorsOff + stats.blue.weaponsOff + stats.blue.navHijacked + stats.blue.commsOff) * 3 +
                stats.blue.bricked * 8 + stats.blue.dataExfil * 8;
            var redDmg = stats.red.exploited * 5 + stats.red.controlled * 10 +
                (stats.red.sensorsOff + stats.red.weaponsOff + stats.red.navHijacked + stats.red.commsOff) * 3 +
                stats.red.bricked * 8 + stats.red.dataExfil * 8;

            if (redDmg > blueDmg) {
                _printLine('<span class="cy-error cy-bold">RED ADVANTAGE: +' + (redDmg - blueDmg) + ' pts</span>');
            } else if (blueDmg > redDmg) {
                _printLine('<span class="cy-info cy-bold">BLUE ADVANTAGE: +' + (blueDmg - redDmg) + ' pts</span>');
            } else {
                _printLine('<span class="cy-warn cy-bold">TIED — both teams equally damaged</span>');
            }
        }
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
                        // Clear all subsystem hack flags
                        entity.state._sensorDisabled = false;
                        entity.state._sensorRedirected = false;
                        entity.state._navigationHijacked = false;
                        entity.state._weaponsDisabled = false;
                        entity.state._commsDisabled = false;
                        entity.state._dataExfiltrated = false;
                        entity.state._fullControl = false;
                        entity.state._computerCompromised = false;
                        entity.state._commIsolated = false;
                        entity.state._hijackWaypoint = null;
                        entity.state._sensorForcedBearing = null;
                        // Clear degradation
                        if (entity.state._cyberDegradation) {
                            entity.state._cyberDegradation = { sensors: 0, navigation: 0, weapons: 0, comms: 0 };
                        }
                        if (entity.state._computerHackedSubsystems) {
                            entity.state._computerHackedSubsystems = {};
                        }
                    }
                    // Update Computer component — increase patch level
                    if (entity.getComponent) {
                        var comp = entity.getComponent('cyber/computer');
                        if (comp) {
                            comp._patchLevel = Math.min(1.0, (comp._patchLevel || 0) + 0.2);
                            comp._compromised = false;
                            _printLine('    Computer patch level: <span class="cy-cyan">' +
                                (comp._patchLevel * 100).toFixed(0) + '%</span>');
                        }
                    }
                    _notifyCommEngine('patch', entity.id, false);
                    _printLine('<span class="cy-success">[+] PATCHED: ' + _esc(entity.id) + ' — all exploits removed, subsystems restored.</span>');
                });
                break;

            case 'firewall':
                _printLine('<span class="cy-info">[*] Configuring firewall on ' + _esc(entity.id) + '...</span>');
                _beginOpCustom('firewall', entity.id, 3, 0.98, function() {
                    tgt.firewalled = true;
                    tgt.hardening = Math.min(10, tgt.hardening + 2);
                    // Activate or upgrade Firewall component
                    if (entity.getComponent) {
                        var fw = entity.getComponent('cyber/firewall');
                        if (fw) {
                            // Upgrade existing firewall
                            fw._rating = Math.min(1.0, (fw._rating || 0.5) + 0.15);
                            fw._idsEnabled = true;
                            if (entity.state) {
                                entity.state._firewallActive = true;
                                entity.state._firewallBypassed = false;
                                entity.state._firewallHealth = Math.min(1.0, (entity.state._firewallHealth || 0.5) + 0.3);
                            }
                            _printLine('<span class="cy-success">[+] FIREWALL UPGRADED: ' + _esc(entity.id) +
                                ' — rating ' + (fw._rating * 100).toFixed(0) + '%, IDS active, health restored</span>');
                        } else {
                            // No Firewall component — just boost hardening
                            _printLine('<span class="cy-success">[+] FIREWALL RULES APPLIED: ' + _esc(entity.id) +
                                ' — scan resistance +2</span>');
                        }
                        // Also boost Computer firewallRating
                        var comp = entity.getComponent('cyber/computer');
                        if (comp) {
                            comp._firewallRating = Math.min(1.0, (comp._firewallRating || 0) + 0.15);
                        }
                    } else {
                        _printLine('<span class="cy-success">[+] FIREWALL ACTIVE: ' + _esc(entity.id) + ' — scan resistance +2</span>');
                    }
                });
                break;

            case 'harden':
                _printLine('<span class="cy-info">[*] Hardening ' + _esc(entity.id) + '...</span>');
                _beginOpCustom('harden', entity.id, 10, 1.0, function() {
                    tgt.hardening = Math.min(10, tgt.hardening + 3);
                    // Upgrade Computer component hardening
                    if (entity.getComponent) {
                        var comp = entity.getComponent('cyber/computer');
                        if (comp) {
                            comp._hardening = Math.min(1.0, (comp._hardening || 0) + 0.15);
                            comp._patchLevel = Math.min(1.0, (comp._patchLevel || 0) + 0.1);
                            _printLine('<span class="cy-success">[+] HARDENED: ' + _esc(entity.id) +
                                ' — computer hardening ' + (comp._hardening * 100).toFixed(0) +
                                '%, patch ' + (comp._patchLevel * 100).toFixed(0) + '%</span>');
                        } else {
                            _printLine('<span class="cy-success">[+] HARDENED: ' + _esc(entity.id) + ' — level now ' + tgt.hardening + '/10</span>');
                        }
                        // Also restore Firewall health if present
                        var fw = entity.getComponent('cyber/firewall');
                        if (fw && entity.state) {
                            entity.state._firewallHealth = Math.min(1.0, (entity.state._firewallHealth || 0.5) + 0.1);
                        }
                    } else {
                        _printLine('<span class="cy-success">[+] HARDENED: ' + _esc(entity.id) + ' — level now ' + tgt.hardening + '/10</span>');
                    }
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

        // Factor in Computer component vulnerability if present
        var ent = _world ? _world.getEntity(targetId) : null;
        if (ent && ent.getComponent) {
            var comp = ent.getComponent('cyber/computer');
            if (comp && typeof comp.getVulnerability === 'function') {
                var vuln = comp.getVulnerability(); // 0.05-0.95
                // Higher vulnerability = easier attack = shorter duration, higher success
                duration *= (1.2 - vuln);
                successChance = Math.min(0.95, successChance + vuln * 0.2);
            }
            // Factor in Firewall component
            var fw = ent.getComponent('cyber/firewall');
            if (fw && ent.state && ent.state._firewallActive && !ent.state._firewallBypassed) {
                duration *= 1.5;
                successChance *= 0.7;
            }
        }

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
                    scanOp.type === 'ddos' || scanOp.type === 'mitm' || scanOp.type === 'inject' ||
                    scanOp.type.indexOf('exfil') === 0) {
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

            // Sync to Computer component if present
            if (ent.getComponent) {
                var comp = ent.getComponent('cyber/computer');
                if (comp) {
                    ent.state._computerCompromised = (tgt.access >= ACCESS.USER);
                    ent.state._computerAccessLevel = ACCESS_NAMES[tgt.access] || 'NONE';
                }
            }
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
        // If entity has a Computer component, use its real data
        if (entity.getComponent) {
            var comp = entity.getComponent('cyber/computer');
            if (comp) {
                // Scale 0-1 hardening + patchLevel to 0-10 difficulty
                var h = (comp._hardening || 0) + (comp._patchLevel || 0);
                var fw = comp._firewallRating || 0;
                return Math.min(10, Math.round(h * 4 + fw * 2 + Math.random()));
            }
        }

        // Fallback: estimate from entity type/importance
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
    // Network access check
    // -----------------------------------------------------------------------

    /**
     * Check if the player's cyber ops station can reach a target entity
     * through the communications network. Returns an object:
     *   { reachable: bool, method: string, via: string|null }
     *
     * Reachability methods:
     *   'direct'  — target shares a network with a friendly node
     *   'pivot'   — target is reachable through a compromised pivot node
     *   'local'   — target is on the same team (defense commands)
     *   'ddos'    — DDoS doesn't require network access, just proximity
     *   'none'    — no network path found
     */
    function _checkNetworkAccess(targetEntity, opType) {
        // Defense operations on friendly nodes always allowed
        if (targetEntity.team === _playerTeam) {
            return { reachable: true, method: 'local', via: null };
        }

        // DDoS doesn't need precise network access
        if (opType === 'ddos') {
            return { reachable: true, method: 'ddos', via: null };
        }

        // If CommEngine isn't loaded, allow all (fallback for simple scenarios)
        if (typeof CommEngine === 'undefined' || !CommEngine.isInitialized()) {
            return { reachable: true, method: 'direct', via: null };
        }

        var targetId = targetEntity.id;

        // Check: does target share any network with any friendly node?
        var friendlyNodes = [];
        _world.entities.forEach(function(ent) {
            if (!ent.active) return;
            if (ent.team === _playerTeam) friendlyNodes.push(ent.id);
        });

        for (var fi = 0; fi < friendlyNodes.length; fi++) {
            var friendComms = CommEngine.getEntityComms(friendlyNodes[fi]);
            if (!friendComms || !friendComms.links) continue;
            for (var li = 0; li < friendComms.links.length; li++) {
                if (friendComms.links[li].peerId === targetId) {
                    return { reachable: true, method: 'direct', via: friendlyNodes[fi] };
                }
            }
        }

        // Check: reachable through a pivot node?
        for (var tid in _targets) {
            var tgt = _targets[tid];
            if (!tgt.isPivot) continue;
            var pivotComms = CommEngine.getEntityComms(tid);
            if (!pivotComms || !pivotComms.links) continue;
            for (var pli = 0; pli < pivotComms.links.length; pli++) {
                if (pivotComms.links[pli].peerId === targetId) {
                    return { reachable: true, method: 'pivot', via: tid };
                }
            }
        }

        // Check: target shares any network with any compromised node?
        for (var ctid in _targets) {
            if (_targets[ctid].access < ACCESS.USER) continue;
            var compComms = CommEngine.getEntityComms(ctid);
            if (!compComms || !compComms.links) continue;
            for (var cli = 0; cli < compComms.links.length; cli++) {
                if (compComms.links[cli].peerId === targetId) {
                    return { reachable: true, method: 'pivot', via: ctid };
                }
            }
        }

        return { reachable: false, method: 'none', via: null };
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

    function _vulnBar(vuln) {
        // vuln is 0.05-0.95, show as colored bar
        var pct = Math.round(vuln * 100);
        var color = pct > 60 ? 'cy-error' : pct > 30 ? 'cy-warn' : 'cy-success';
        var filled = Math.round(vuln * 10);
        var bar = '';
        for (var i = 0; i < 10; i++) {
            bar += i < filled ? '<span class="' + color + '">█</span>' : '<span class="cy-dim">░</span>';
        }
        return bar + ' <span class="' + color + '">' + pct + '%</span>';
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
        show: show,
        isVisible: isVisible,
        update: update,
        setPlayerTeam: setPlayerTeam,
        setWorld: setWorld
    };

})();
