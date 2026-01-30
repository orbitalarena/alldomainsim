#!/usr/bin/env python3
"""
Custom HTTP server for the Scenario Builder.

Serves static files and handles scenario export via POST /api/export.
Export writes JSON directly to the scenarios/ directory.

Usage:
    python3 serve.py [port]
    # Default port: 8000
"""

import http.server
import json
import os
import re
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
SCENARIOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scenarios')


def sanitize_filename(name):
    """Replace non-alphanumeric chars (except hyphens/underscores) with underscores."""
    s = re.sub(r'[^a-zA-Z0-9_\-]', '_', name)
    s = re.sub(r'_+', '_', s).strip('_').lower()
    return s or 'untitled'


class BuilderHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/export':
            self._handle_export()
        else:
            self.send_error(404, 'Not found')

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
        print(f'  Builder:  http://localhost:{PORT}/scenario_builder.html')
        print(f'  Viewer:   http://localhost:{PORT}/scenario_viewer.html?scenario=scenarios/demo_multi_domain.json')
        print(f'  Export:   POST /api/export')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')
