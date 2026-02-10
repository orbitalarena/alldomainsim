# Claude Code Project Context

## Project: All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios from ground operations through orbital mechanics. Think KSP meets STK meets AFSIM with Cesium 3D visualization.

> For detailed session history, MC engine internals, perturbation models, and sim technical details, see [CLAUDE_ARCHIVE.md](./CLAUDE_ARCHIVE.md).

## Current Capabilities

**Live Sim Viewer** (`live_sim_viewer.html`): Full cockpit sim with TLE catalog (14k+ satellites), observer mode, click-to-assume control, analytics panel (Chart.js), smart search (F key), auto-pointing (9 modes), sensor footprints, weather, naval physics, Hohmann transfer planner, engine selection panel, comm networks, cyber cockpit, viz group controls.

**Scenario Builder** (`scenario_builder.html`): Drag-and-drop ECS editor. BUILD/RUN/ANALYZE modes. Platform Builder (5-tab composer: Physics/Propulsion/Sensors/Payload/Environment). 6 scenario templates. MC analysis dashboard. DOE system. Export to live viewer, CZML model, or C++ replay.

**C++ MC Engine** (`mc_engine`): Headless Monte Carlo — batch MC (100 runs in 35ms) or replay generation. Multi-domain combat: orbital KKV + atmospheric SAM/A2A + flight3dof. Progress reporting via JSON-Lines stderr. 11 scenario/replay pairs.

**Standalone Sims**: Fighter sim (F-16 with weapons/AI), Spaceplane sim (atmosphere-to-orbit), GEO rendezvous, satellite tour, GPS PDOP, launch trajectory. 6 analytic tools (ballistic/intercept/maneuver/visibility/radar/link budget planners).

**Communications + Cyber**: CommEngine (Dijkstra routing, link budget, jamming, fiber/laser links). Cyber cockpit terminal (scan/exploit/brick/ddos/mitm/inject + defense commands). F2T2EA comm-integrated kill chain.

---

## Architecture

### C++ Core (src/)
```
core/           - SimulationEngine, StateVector, PhysicsDomain
physics/        - GravityModel (J2/J3/J4), OrbitalElements, AtmosphereModel,
                  ManeuverPlanner, ProximityOps, OrbitalPerturbations,
                  SolarEphemeris, LunarEphemeris, SolarRadiationPressure,
                  Aerodynamics6DOF, SyntheticCamera, Vec3Ops
entities/       - Satellite (TLE), LaunchVehicle, Aircraft, Fighter, CommandModule
coordinate/     - TimeUtils (JD/GMST), FrameTransformer (ECI/ECEF/Geodetic)
propagators/    - RK4Integrator
io/             - TLEParser, JsonWriter, JsonReader, Checkpoint
montecarlo/     - MCEntity, MCWorld, ScenarioParser, MCRunner, ReplayWriter,
                  OrbitalCombatAI, KineticKill, Flight3DOF, WaypointPatrolAI,
                  InterceptAI, RadarSensor, SAMBattery, A2AMissile, EventSystem
```

### JavaScript Modules (visualization/cesium/js/)
```
live_sim_engine.js      - Hybrid cockpit+ECS: player hijack, weapons, sensors,
                          camera, observer, TLE, analytics, search, pointing,
                          Hohmann, engine panel, viz controls, weather, comms
fighter_sim_engine.js   - 3-DOF flight physics (unified model, aero blend)
fighter_hud.js          - Canvas HUD: pitch ladder, tapes, orbital markers, navball
fighter_atmosphere.js   - US Standard Atmosphere + thermosphere
fighter_autopilot.js    - Alt/heading/speed hold, waypoint nav
fighter_weapons.js      - AIM-9/AIM-120/bombs/gun
fighter_ai.js           - AI wingmen and adversary tactics
spaceplane_orbital.js   - Geodetic↔ECI, orbital elements, Kepler, regime detection
spaceplane_planner.js   - KSP-style maneuver nodes (create/edit/execute)
spaceplane_hud.js       - Planner mode HUD, navball, orbital overlay
comm_engine.js          - Dijkstra routing, link budget, jamming, cyber attacks
cyber_cockpit.js        - Terminal UI, scan/exploit/defend commands
minimap.js              - Minimap overlay
```

### ECS Framework (visualization/cesium/js/framework/)
```
ecs.js            - Entity, Component, World. Component index cache.
constants.js      - R_EARTH, MU_EARTH, DEG/RAD
registry.js       - ComponentRegistry: category/type → class
systems.js        - Pipeline: AI → Control → Physics → Sensor → Weapon → Event → Viz → HUD → UI
loader.js         - ScenarioLoader: JSON → ECS.World
sensor_system.js  - Radar detection sweep
weapon_system.js  - SAM engagement
event_system.js   - Timed/proximity/detection triggers + actions
tle_parser.js     - TLE parsing, SGP4-lite, epoch-aware propagation
```

### ECS Components (visualization/cesium/js/components/)
```
physics/    flight3dof, orbital_2body, naval
control/    player_input
ai/         waypoint_patrol, intercept, orbital_combat, cyber_defense, cyber_ops
sensors/    radar
weapons/    sam_battery, fighter_loadout, a2a_missile, kinetic_kill
visual/     cesium_entity, satellite_visual, ground_station, radar_coverage, sensor_footprint
cyber/      computer, firewall
```

### Builder (visualization/cesium/js/builder/)
```
builder_app.js        - Main controller: BUILD/RUN/ANALYZE
scenario_io.js        - File open/save, export
globe_interaction.js  - Click-to-place, drag-to-move
object_palette.js     - Entity templates + custom platforms
property_inspector.js - Entity property editing
satellite_dialog.js   - COE input dialog
timeline_panel.js     - Canvas timeline
event_editor.js       - Visual event creator
mc_runner.js          - MC batch executor (JS fallback)
mc_analysis.js        - MC results + Chart.js dashboard
mc_panel.js           - MC UI + C++ engine polling
orbital_arena.js      - Arena generators (Small/100/Large)
platform_builder.js   - 5-tab platform composer (~2100 lines)
sensor_view_mode.js   - Optical sensor camera + post-processing
doe_panel.js          - DOE configuration
doe_results.js        - DOE results (heat map, sensitivity, export)
environment_dialog.js - Scenario environment config + sim start time
```

### HTML Pages (visualization/cesium/)
```
scenario_builder.html   - Interactive scenario editor
live_sim_viewer.html    - Cockpit sim (TLE catalog, observer, analytics)
replay_viewer.html      - C++ replay playback (?replay=file.json)
scenario_viewer.html    - Lightweight scenario runner
model_viewer.html       - CZML rapid-playback viewer
index.html              - Hub page
ballistic_planner.html  - Ballistic trajectory planner
intercept_planner.html  - TLE satellite intercept (Lambert solver)
maneuver_planner.html   - Orbital maneuver planner
visibility_planner.html - Satellite pass prediction
radar_horizon.html      - Radar horizon calculator
link_budget.html        - RF link budget analyzer
```

### Servers
- `serve.py` — Python HTTP server (port 8000). Serves files, `POST /api/export`, `/api/sim/*`, `/api/tle/*`. Proxies `/api/mc/*` to Node.js.
- `mc_server.js` — Node.js MC bridge (port 8001). Job queue, async C++ engine spawn. `POST /api/mc/batch|replay|doe`, `GET /api/mc/jobs/:jobId`.

---

## Build & Run

### C++ Backend
```bash
cd build && cmake .. && ninja mc_engine
```

### MC Engine
```bash
./bin/mc_engine --scenario <path.json> --runs 100 --seed 42 --max-time 600 --output results.json --verbose
./bin/mc_engine --replay --scenario <path.json> --seed 42 --max-time 600 --sample-interval 2 --output replay.json --verbose
```

### Web Viewer (no build needed)
```bash
cd visualization/cesium
python3 serve.py 8000 &      # Main server
node mc_server.js &           # MC bridge (optional, for C++ MC runs)
# Open http://localhost:8000/
```

### Offline Mode
```bash
cd visualization/cesium && ./setup_offline.sh    # Downloads ~70MB to lib/
# Then add ?offline=true to any URL
```

---

## Scenario JSON Format
```json
{
  "metadata": { "name": "...", "version": "2.0" },
  "environment": { "atmosphere": "us_standard_1976", "gravity": "constant", "maxTimeWarp": 64 },
  "entities": [
    {
      "id": "f16_0", "name": "Eagle 1", "type": "aircraft", "team": "blue",
      "initialState": { "lat": 34.9, "lon": -117.9, "alt": 5000, "speed": 200, "heading": 90 },
      "components": {
        "physics": { "type": "flight3dof", "config": "f16" },
        "ai": { "type": "waypoint_patrol", "waypoints": [...] },
        "sensors": { "type": "radar", "maxRange_m": 150000 },
        "visual": { "type": "point", "color": "#4488ff", "trail": true }
      }
    }
  ],
  "events": [ { "type": "timed", "time": 120, "action": "changeROE", ... } ],
  "camera": { "mode": "free", "range": 5000000 }
}
```
Coordinates: scenario JSON uses **degrees**, ECS runtime uses **radians** (converted by loader).

---

## Keyboard Controls (live_sim_viewer.html)
```
W/S or Up/Down — Throttle, pitch
A/D or Left/Right — Roll (bank)
Q/E            — Yaw (nose rotation in vacuum — does NOT change velocity)
Escape         — Pause
P              — Engine selection panel (1-9/0 quick-select)
E              — Engine on/off
Space          — Fire weapon
R              — Cycle weapon
V              — Cycle sensor (EO/IR with CSS effects)
T / Shift+T    — Pitch trim (+0.5° / -0.5°)
I              — Cycle pointing mode (prograde/retrograde/normal/radial/nadir/sun/target)
L              — Pointing mode panel
F              — Smart search panel
M              — Planner mode
N              — Create maneuver node
Enter          — Execute maneuver node
Delete         — Delete maneuver node
+/-            — Time warp (up to 1024x)
C              — Cycle camera (chase/cockpit/free/earth/moon)
B              — Hold to brake
H              — Controls help
1/2/3          — Toggle flight data / systems / orbital panels
O              — Toggle orbital elements panel
Tab            — Hide/show all panels
Shift+`        — Cyber terminal
```

---

## Known Issues
1. **C++ orbit insertion**: 140x320km, should target 400km circular
2. **Proximity ops NaN**: LVLH edge case when vehicles overlap
3. **Model files**: Removed (using point markers) — can re-add with .glb
4. ~~**SAM targets ground bases**~~: FIXED
5. **Short-lived replays**: fighter_patrol, two_aircraft, multi_domain resolve at t=0.1s (no combatants on one side)
6. ~~**SMA oscillation**~~: FIXED
7. ~~**Escape trajectory crash**~~: FIXED
8. ~~**e.replace not a function**~~: FIXED — `cfg.label: true` (boolean) passed to Cesium label text which expects string; also `_escapeHtmlStr` not handling non-string inputs
9. ~~**_canvas not defined**~~: FIXED — `fighter_hud.js` typo `_canvas` vs `canvas` in drawWeatherInfo/drawWaypointCue
10. ~~**No player entity crash**~~: FIXED — graceful observer mode fallback when no controllable entity found
11. ~~**Normalized result NaN**~~: FIXED — NaN guard on camera + orbital_2body COE init from `initialState` fields
12. ~~**Export menu off-screen**~~: FIXED — CSS `left: 0` instead of `right: 0`, added `max-width`
13. ~~**Replay viewer stuck on splash**~~: FIXED — embedded replay selector in loading overlay

## Known Behavior Notes
- **Strike package detection**: SAM radar (200km) detects strike_1 almost immediately (~170km apart). Reduce radar range or increase distance for longer delay.
- **Player input racetrack**: `player_input` entities get auto-assigned 4-waypoint racetrack patrol (50km x 20km) in headless MC.

## Potential Enhancements
- WASM compilation of mc_engine for in-browser MC
- SGP4 propagation for TLE accuracy beyond 30 days
- Multi-player via WebSocket
- Terrain-aware ground operations

---

## Dependencies
- CMake 3.20+, C++17 (C++ backend)
- Python3 (HTTP server)
- Node.js (MC bridge server)
- Modern browser with WebGL (Cesium)
- Cesium + Chart.js (CDN or offline via `setup_offline.sh`)

## Working Style
- **Bias toward action**: Implement fully when intent is clear.
- **Investigate root causes**: Trace code paths, don't slap try/catch.
- **Ship complete features**: Physics + UI + keybindings + edge cases.
- **Commit only when asked**: Never commit/push unless explicitly told.
- **Read before you edit**: Codebase evolves fast, check current state.
- **Performance matters**: 60fps browser target. Guard against per-frame allocations, NaN propagation, unbounded loops.
- **Keep the HTTP server running**: `cd visualization/cesium && python3 serve.py 8000`. Use `serve.py` (not `python3 -m http.server`).
- **C++ build uses Ninja**: `cd build && cmake .. && ninja mc_engine` (not make).

## Git Conventions
- Commit messages: imperative mood, describe what changes do
- Co-author: `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`
