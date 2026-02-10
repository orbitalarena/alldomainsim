#!/usr/bin/env python3
"""
Custom HTTP server for the Scenario Builder.

Serves static files and handles:
  POST /api/export      — Save scenario JSON to scenarios/
  POST /api/dis_export  — Save binary DIS PDU file to scenarios/
  POST /api/dis_poll    — Receive DIS PDUs via HTTP (WebSocket fallback)
  GET  /api/dis_config  — Get/set DIS configuration

Optionally relays DIS PDUs to UDP multicast when websockets are available.

Usage:
    python3 serve.py [port]
    # Default port: 8000
"""

import http.server
import json
import os
import re
import socket
import struct
import sys
import threading
import urllib.request
import urllib.error

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
SCENARIOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scenarios')
SIMS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sims')

# DIS multicast configuration
DIS_CONFIG = {
    'multicastGroup': '239.1.2.3',
    'multicastPort': 3000,
    'exerciseId': 1,
    'pduRate': 5,
    'relayEnabled': True
}

# UDP socket for DIS multicast relay (lazy init)
_udp_socket = None
_udp_lock = threading.Lock()


def get_udp_socket():
    """Lazily create UDP multicast socket for DIS relay."""
    global _udp_socket
    if _udp_socket is not None:
        return _udp_socket
    with _udp_lock:
        if _udp_socket is not None:
            return _udp_socket
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 32)
            _udp_socket = sock
            print(f'  DIS UDP relay: {DIS_CONFIG["multicastGroup"]}:{DIS_CONFIG["multicastPort"]}')
        except Exception as e:
            print(f'  DIS UDP relay unavailable: {e}')
            _udp_socket = None
    return _udp_socket


def relay_pdus_to_multicast(data):
    """Relay binary PDU data to UDP multicast group."""
    if not DIS_CONFIG['relayEnabled']:
        return
    sock = get_udp_socket()
    if not sock:
        return
    try:
        # Parse individual PDUs from the combined buffer and send each
        offset = 0
        while offset + 12 <= len(data):
            # Read PDU length from header (bytes 8-9, big-endian uint16)
            pdu_len = struct.unpack('>H', data[offset + 8:offset + 10])[0]
            if pdu_len < 12 or offset + pdu_len > len(data):
                break
            pdu = data[offset:offset + pdu_len]
            sock.sendto(pdu, (DIS_CONFIG['multicastGroup'], DIS_CONFIG['multicastPort']))
            offset += pdu_len
    except Exception as e:
        pass  # Best-effort relay


def sanitize_filename(name):
    """Replace non-alphanumeric chars (except hyphens/underscores) with underscores."""
    s = re.sub(r'[^a-zA-Z0-9_\-]', '_', name)
    s = re.sub(r'_+', '_', s).strip('_').lower()
    return s or 'untitled'


MC_SERVER_PORT = 8001  # Port where mc_server.js runs

# ──────────────────────────────────────────────────────────────────────
# TLE Catalog — parse fullsatcat.txt, group by mega-constellation + orbit regime
# ──────────────────────────────────────────────────────────────────────

import math as _math

TLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data', 'tles')

_MU_EARTH = 3.986004418e14  # m³/s²
_R_EARTH_M = 6371000.0      # m
_TWO_PI = 2 * _math.pi
_MEGA_THRESHOLD = 200        # constellations with >= this many sats are "mega"

_tle_cache = None


def _orbit_regime(mean_motion_revday, ecc):
    """Classify orbit regime from TLE mean motion (revs/day) and eccentricity."""
    if mean_motion_revday <= 0:
        return 'OTHER'
    if ecc > 0.25:
        return 'HEO'
    n_rad = _TWO_PI * mean_motion_revday / 86400.0
    sma = (_MU_EARTH / (n_rad * n_rad)) ** (1.0 / 3.0)
    alt_km = (sma - _R_EARTH_M) / 1000.0
    if alt_km < 2000:
        return 'LEO'
    elif alt_km < 35000:
        return 'MEO'
    elif alt_km <= 37000:
        return 'GEO'
    else:
        return 'OTHER'


def _parse_tle_line2(line2):
    """Extract mean motion (revs/day) and eccentricity from TLE line 2."""
    try:
        # Eccentricity: cols 26-33 (implicit leading decimal)
        ecc = float('0.' + line2[26:33].strip())
        # Mean motion: cols 52-63
        mm = float(line2[52:63].strip())
        return mm, ecc
    except (ValueError, IndexError):
        return 0, 0


def _parse_tle_catalog():
    """Parse fullsatcat.txt. Group by mega-constellations (>200) + orbit regime.
    Cached after first call."""
    global _tle_cache
    if _tle_cache is not None:
        return _tle_cache

    fullsat_path = os.path.join(TLES_DIR, 'fullsatcat.txt')
    if not os.path.exists(fullsat_path):
        _tle_cache = {'constellations': {}, 'groups': [], 'total': 0}
        return _tle_cache

    # First pass: collect all sats, count name prefixes
    all_sats = []
    prefix_counts = {}  # prefix -> count (first word of name, uppercase)

    with open(fullsat_path, 'r') as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if (i + 2 < len(lines)
                and lines[i + 1].startswith('1 ')
                and lines[i + 2].startswith('2 ')):
            sat_name = line.strip()
            line1 = lines[i + 1].rstrip()
            line2 = lines[i + 2].rstrip()

            try:
                norad = int(line1[2:7].strip())
            except (ValueError, IndexError):
                norad = 0

            mm, ecc = _parse_tle_line2(line2)
            regime = _orbit_regime(mm, ecc)

            # Determine prefix: first token before space/dash/digit
            upper = sat_name.upper().strip()
            # Use everything before first space, dash-number, or paren as prefix
            prefix = upper.split()[0] if upper else 'UNKNOWN'
            # Strip trailing numbers/dashes from prefix (e.g. "STARLINK" from "STARLINK-1234")
            prefix = prefix.rstrip('0123456789-')
            if not prefix:
                prefix = upper.split()[0] if upper else 'UNKNOWN'

            sat_data = {
                'name': sat_name,
                'line1': line1,
                'line2': line2,
                'norad': norad,
                'regime': regime,
                'prefix': prefix,
            }
            all_sats.append(sat_data)
            prefix_counts[prefix] = prefix_counts.get(prefix, 0) + 1
            i += 3
        else:
            i += 1

    # Identify mega-constellations (>= MEGA_THRESHOLD same prefix)
    mega_prefixes = {p for p, c in prefix_counts.items() if c >= _MEGA_THRESHOLD}

    # Build constellation groups (keyed by name)
    constellations = {}  # name -> [sat_data, ...]
    # Mega-constellations get their own group, everything else goes to regime groups
    regime_groups = {'LEO': [], 'MEO': [], 'GEO': [], 'HEO': [], 'OTHER': []}

    for sat in all_sats:
        if sat['prefix'] in mega_prefixes:
            group_name = sat['prefix']
            if group_name not in constellations:
                constellations[group_name] = []
            constellations[group_name].append(sat)
        else:
            regime_groups[sat['regime']].append(sat)
            # Also store in constellations for /api/tle/constellation/ lookup
            regime_key = sat['regime']
            if regime_key not in constellations:
                constellations[regime_key] = []
            constellations[regime_key].append(sat)

    # Build summary groups for catalog endpoint
    total = len(all_sats)
    groups = []

    # Mega-constellations first (sorted by count desc)
    mega_names = sorted(mega_prefixes, key=lambda p: -len(constellations.get(p, [])))
    for name in mega_names:
        sats = constellations[name]
        # Determine dominant regime
        regime_counts = {}
        for s in sats:
            r = s['regime']
            regime_counts[r] = regime_counts.get(r, 0) + 1
        dominant_regime = max(regime_counts, key=regime_counts.get) if regime_counts else 'LEO'
        groups.append({
            'name': name,
            'count': len(sats),
            'kind': 'mega',
            'regime': dominant_regime,
        })

    # Orbit regime groups (non-mega sats only)
    for regime in ['LEO', 'MEO', 'GEO', 'HEO', 'OTHER']:
        sats = regime_groups[regime]
        if sats:
            groups.append({
                'name': regime,
                'count': len(sats),
                'kind': 'regime',
            })

    _tle_cache = {
        'constellations': constellations,
        'groups': groups,
        'total': total,
    }
    n_mega = len(mega_prefixes)
    n_regime = sum(1 for g in groups if g['kind'] == 'regime')
    print(f'  TLE catalog parsed: {total} satellites, {n_mega} mega-constellations, {n_regime} orbit regimes')
    return _tle_cache


class BuilderHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/export':
            self._handle_export()
        elif self.path == '/api/save_replay':
            self._handle_save_replay()
        elif self.path == '/api/sim/save':
            self._handle_sim_save()
        elif self.path == '/api/dis_export':
            self._handle_dis_export()
        elif self.path == '/api/dis_poll':
            self._handle_dis_poll()
        elif self.path.startswith('/api/mc/'):
            self._proxy_mc(self.path)
        else:
            self.send_error(404, 'Not found')

    def do_GET(self):
        if self.path == '/api/dis_config':
            self._handle_dis_config_get()
        elif self.path == '/api/sim/list':
            self._handle_sim_list()
        elif self.path == '/api/models/list':
            self._handle_models_list()
        elif self.path == '/api/tle/catalog':
            self._handle_tle_catalog()
        elif self.path.startswith('/api/tle/constellation/'):
            self._handle_tle_constellation()
        elif self.path.startswith('/api/mc/'):
            self._proxy_mc_get(self.path)
        else:
            super().do_GET()

    def do_DELETE(self):
        if self.path.startswith('/api/sim/delete/'):
            self._handle_sim_delete()
        else:
            self.send_error(404, 'Not found')

    def do_PUT(self):
        if self.path == '/api/dis_config':
            self._handle_dis_config_put()
        else:
            self.send_error(404, 'Not found')

    def _proxy_mc(self, path):
        """Proxy POST requests to the Node.js MC server."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length) if length > 0 else b''
            url = f'http://localhost:{MC_SERVER_PORT}{path}'
            req = urllib.request.Request(url, data=body, method='POST',
                                         headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=310) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', len(data))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.URLError:
            self._json_response(503, {
                'error': 'MC server not running. Start with: node mc_server.js'
            })
        except Exception as e:
            self._json_response(502, {'error': f'MC proxy error: {e}'})

    def _proxy_mc_get(self, path):
        """Proxy GET requests to the Node.js MC server."""
        try:
            url = f'http://localhost:{MC_SERVER_PORT}{path}'
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', len(data))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.URLError:
            self._json_response(503, {
                'error': 'MC server not running. Start with: node mc_server.js'
            })
        except Exception as e:
            self._json_response(502, {'error': f'MC proxy error: {e}'})

    def _handle_export(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            scenario = payload.get('scenario')
            name = payload.get('name', '')

            if not scenario or not isinstance(scenario, dict):
                self._json_response(400, {'error': 'Missing scenario object'})
                return

            if not name:
                name = 'untitled'
            filename = sanitize_filename(name) + '.json'
            filepath = os.path.join(SCENARIOS_DIR, filename)

            # Ensure scenarios directory exists
            os.makedirs(SCENARIOS_DIR, exist_ok=True)

            # Write scenario JSON
            with open(filepath, 'w') as f:
                json.dump(scenario, f, indent=2)

            viewer_url = f'scenario_viewer.html?scenario=scenarios/{filename}'
            self._json_response(200, {
                'ok': True,
                'filename': filename,
                'path': f'scenarios/{filename}',
                'viewerUrl': viewer_url
            })

            print(f'  Exported: {filepath}')

        except json.JSONDecodeError:
            self._json_response(400, {'error': 'Invalid JSON'})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_save_replay(self):
        """Save replay JSON to a replay_*.json file in the cesium directory."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            replay = payload.get('replay')
            name = payload.get('name', '')

            if not replay or not isinstance(replay, dict):
                self._json_response(400, {'error': 'Missing replay object'})
                return

            if not name:
                name = 'untitled'
            filename = 'replay_' + sanitize_filename(name) + '.json'
            # Save in the cesium directory (same level as serve.py)
            filepath = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)

            with open(filepath, 'w') as f:
                json.dump(replay, f)

            self._json_response(200, {
                'ok': True,
                'filename': filename,
                'viewerUrl': f'replay_viewer.html?replay={filename}'
            })

            print(f'  Replay saved: {filepath}')

        except json.JSONDecodeError:
            self._json_response(400, {'error': 'Invalid JSON'})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_dis_export(self):
        """Save binary DIS PDU data to a .dis file."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                self._json_response(400, {'error': 'Empty body'})
                return

            body = self.rfile.read(length)
            name = self.headers.get('X-Filename', 'untitled')
            filename = sanitize_filename(name) + '.dis'
            filepath = os.path.join(SCENARIOS_DIR, filename)

            os.makedirs(SCENARIOS_DIR, exist_ok=True)

            with open(filepath, 'wb') as f:
                f.write(body)

            # Count PDUs by parsing headers
            pdu_count = 0
            offset = 0
            while offset + 12 <= len(body):
                pdu_len = struct.unpack('>H', body[offset + 8:offset + 10])[0]
                if pdu_len < 12 or offset + pdu_len > len(body):
                    break
                pdu_count += 1
                offset += pdu_len

            self._json_response(200, {
                'ok': True,
                'filename': filename,
                'path': f'scenarios/{filename}',
                'pduCount': pdu_count,
                'bytes': len(body)
            })

            print(f'  DIS Export: {filepath} ({pdu_count} PDUs, {len(body)} bytes)')

        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_dis_poll(self):
        """Receive DIS PDUs via HTTP POST and relay to multicast."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length == 0:
                self._json_response(200, {'ok': True, 'relayed': 0})
                return

            body = self.rfile.read(length)

            # Relay to UDP multicast
            relay_pdus_to_multicast(body)

            self._json_response(200, {'ok': True, 'relayed': length})

        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_sim_save(self):
        """Save a .sim file (scenario snapshot from builder)."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            scenario = payload.get('scenario')
            name = payload.get('name', '')

            if not scenario or not isinstance(scenario, dict):
                self._json_response(400, {'error': 'Missing scenario object'})
                return

            if not name:
                name = 'untitled'
            filename = sanitize_filename(name) + '.sim'
            filepath = os.path.join(SIMS_DIR, filename)

            os.makedirs(SIMS_DIR, exist_ok=True)

            with open(filepath, 'w') as f:
                json.dump(scenario, f, indent=2)

            self._json_response(200, {
                'ok': True,
                'filename': filename,
                'path': 'sims/' + filename
            })

            print(f'  Sim saved: {filepath}')

        except json.JSONDecodeError:
            self._json_response(400, {'error': 'Invalid JSON'})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_sim_list(self):
        """List all .sim files in the sims directory."""
        try:
            os.makedirs(SIMS_DIR, exist_ok=True)
            sims = []
            for f in sorted(os.listdir(SIMS_DIR)):
                if not f.endswith('.sim'):
                    continue
                filepath = os.path.join(SIMS_DIR, f)
                stat = os.stat(filepath)
                # Read scenario to extract metadata
                meta = {}
                entity_count = 0
                try:
                    with open(filepath, 'r') as fh:
                        data = json.load(fh)
                        meta = data.get('metadata', {})
                        entity_count = len(data.get('entities', []))
                except Exception:
                    pass
                sims.append({
                    'filename': f,
                    'path': 'sims/' + f,
                    'name': meta.get('name', f.replace('.sim', '')),
                    'entityCount': entity_count,
                    'size': stat.st_size,
                    'modified': stat.st_mtime,
                })
            self._json_response(200, {'sims': sims})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_sim_delete(self):
        """Delete a .sim file."""
        try:
            # Extract filename from path: /api/sim/delete/{filename}
            parts = self.path.split('/')
            if len(parts) < 5 or parts[3] != 'delete':
                self._json_response(400, {'error': 'Invalid path'})
                return
            filename = parts[4]
            if not filename.endswith('.sim'):
                self._json_response(400, {'error': 'Not a .sim file'})
                return
            filepath = os.path.join(SIMS_DIR, filename)
            if not os.path.exists(filepath):
                self._json_response(404, {'error': 'File not found'})
                return
            os.remove(filepath)
            self._json_response(200, {'ok': True, 'deleted': filename})
            print(f'  Sim deleted: {filepath}')
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_models_list(self):
        """List all .glb/.gltf model files in the models directory."""
        try:
            models_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
            os.makedirs(models_dir, exist_ok=True)
            models = []
            for f in sorted(os.listdir(models_dir)):
                if not (f.endswith('.glb') or f.endswith('.gltf')):
                    continue
                filepath = os.path.join(models_dir, f)
                stat = os.stat(filepath)
                models.append({
                    'filename': f,
                    'path': 'models/' + f,
                    'size': stat.st_size,
                })
            self._json_response(200, {'models': models})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_dis_config_get(self):
        """Return current DIS configuration."""
        self._json_response(200, DIS_CONFIG)

    def _handle_dis_config_put(self):
        """Update DIS configuration."""
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            for key in payload:
                if key in DIS_CONFIG:
                    DIS_CONFIG[key] = payload[key]

            self._json_response(200, {'ok': True, 'config': DIS_CONFIG})
            print(f'  DIS config updated: {DIS_CONFIG}')

        except json.JSONDecodeError:
            self._json_response(400, {'error': 'Invalid JSON'})
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_tle_catalog(self):
        """Return TLE catalog summary: mega-constellations + orbit regime groups."""
        try:
            catalog = _parse_tle_catalog()
            self._json_response(200, {
                'totalSatellites': catalog['total'],
                'groups': catalog['groups'],
                # Backward compat: also include flat list as 'constellations'
                'constellations': catalog['groups'],
            })
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_tle_constellation(self):
        """Return full TLE data for a single constellation or orbit regime group."""
        try:
            # Extract constellation name from path: /api/tle/constellation/{name}
            parts = self.path.split('/')
            if len(parts) < 5:
                self._json_response(400, {'error': 'Missing constellation name'})
                return
            name = urllib.request.unquote(parts[4]).upper()

            catalog = _parse_tle_catalog()
            sats = catalog['constellations'].get(name)
            if sats is None:
                self._json_response(404, {'error': f'Group not found: {name}'})
                return

            # Strip internal fields (prefix) from response
            clean_sats = [{
                'name': s['name'], 'line1': s['line1'], 'line2': s['line2'],
                'norad': s['norad'], 'regime': s.get('regime', 'LEO'),
            } for s in sats]

            self._json_response(200, {
                'name': name,
                'count': len(clean_sats),
                'satellites': clean_sats,
            })
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _json_response(self, code, data):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quieter logging — skip 200s for static files
        if args and '200' not in str(args[1]):
            super().log_message(format, *args)
        elif self.path.startswith('/api/'):
            super().log_message(format, *args)


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with http.server.HTTPServer(('', PORT), BuilderHandler) as httpd:
        print(f'Scenario Builder server running on http://localhost:{PORT}')
        print(f'  Builder:     http://localhost:{PORT}/scenario_builder.html')
        print(f'  Viewer:      http://localhost:{PORT}/scenario_viewer.html?scenario=scenarios/demo_multi_domain.json')
        print(f'  Export:      POST /api/export')
        print(f'  DIS Export:  POST /api/dis_export')
        print(f'  DIS Config:  GET/PUT /api/dis_config')
        print(f'  DIS Relay:   POST /api/dis_poll → UDP {DIS_CONFIG["multicastGroup"]}:{DIS_CONFIG["multicastPort"]}')
        print(f'  Sim Files:   POST /api/sim/save | GET /api/sim/list | DELETE /api/sim/delete/{{name}}')
        print(f'  TLE Catalog: GET /api/tle/catalog | GET /api/tle/constellation/{{name}}')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')
