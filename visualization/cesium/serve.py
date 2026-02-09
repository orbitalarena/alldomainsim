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
# TLE Catalog — parse fullsatcat.txt once, group by constellation
# ──────────────────────────────────────────────────────────────────────

TLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data', 'tles')

CONSTELLATION_PREFIXES = [
    ('STARLINK', 'STARLINK'),
    ('ONEWEB', 'ONEWEB'),
    ('IRIDIUM', 'IRIDIUM'),
    ('NAVSTAR', 'GPS'),
    ('GPS ', 'GPS'),
    ('BEIDOU', 'BEIDOU'),
    ('COSMOS', 'COSMOS'),
    ('GLOBALSTAR', 'GLOBALSTAR'),
    ('FLOCK', 'FLOCK'),
    ('ORBCOMM', 'ORBCOMM'),
    ('INTELSAT', 'INTELSAT'),
    ('SES-', 'SES'),
    ('GOES', 'GOES'),
    ('GALILEO', 'GALILEO'),
    ('O3B', 'O3B'),
    ('HULIANWANG', 'HULIANWANG'),
    ('LEMUR', 'LEMUR'),
    ('SPACEBEE', 'SPACEBEE'),
    ('YAOGAN', 'YAOGAN'),
    ('JILIN', 'JILIN'),
]

_tle_cache = None  # { 'constellations': { name: [sat,...] }, 'summary': [...] }


def _parse_tle_catalog():
    """Parse fullsatcat.txt and group by constellation. Cached after first call."""
    global _tle_cache
    if _tle_cache is not None:
        return _tle_cache

    fullsat_path = os.path.join(TLES_DIR, 'fullsatcat.txt')
    if not os.path.exists(fullsat_path):
        _tle_cache = {'constellations': {}, 'summary': [], 'total': 0}
        return _tle_cache

    constellations = {}  # name -> [{ name, line1, line2, norad }]

    with open(fullsat_path, 'r') as f:
        lines = f.readlines()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        # Look for 3-line format: name, line1 (starts with '1 '), line2 (starts with '2 ')
        if (i + 2 < len(lines)
                and lines[i + 1].startswith('1 ')
                and lines[i + 2].startswith('2 ')):
            sat_name = line.strip()
            line1 = lines[i + 1].rstrip()
            line2 = lines[i + 2].rstrip()

            # Extract NORAD catalog number from line 1 (cols 2-7)
            try:
                norad = int(line1[2:7].strip())
            except (ValueError, IndexError):
                norad = 0

            # Determine constellation
            group = 'OTHER'
            upper_name = sat_name.upper()
            for prefix, group_name in CONSTELLATION_PREFIXES:
                if upper_name.startswith(prefix):
                    group = group_name
                    break

            if group not in constellations:
                constellations[group] = []
            constellations[group].append({
                'name': sat_name,
                'line1': line1,
                'line2': line2,
                'norad': norad,
            })
            i += 3
        else:
            i += 1

    # Build summary sorted by count descending
    total = sum(len(v) for v in constellations.values())
    summary = sorted(
        [{'name': k, 'count': len(v)} for k, v in constellations.items()],
        key=lambda x: -x['count']
    )

    _tle_cache = {
        'constellations': constellations,
        'summary': summary,
        'total': total,
    }
    print(f'  TLE catalog parsed: {total} satellites in {len(constellations)} groups')
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
        """Return TLE catalog summary (constellation names + counts)."""
        try:
            catalog = _parse_tle_catalog()
            self._json_response(200, {
                'totalSatellites': catalog['total'],
                'constellations': catalog['summary'],
            })
        except Exception as e:
            self._json_response(500, {'error': str(e)})

    def _handle_tle_constellation(self):
        """Return full TLE data for a single constellation."""
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
                self._json_response(404, {'error': f'Constellation not found: {name}'})
                return

            self._json_response(200, {
                'name': name,
                'count': len(sats),
                'satellites': sats,
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
