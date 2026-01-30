# Claude Code Project Context

## Project: All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios from ground operations through orbital mechanics. Think KSP meets STK meets AFSIM with Cesium 3D visualization.

## Current Status: Scenario Builder Operational

### C++ Backend (Milestones 0-4 + Phases 2-3):
- **M0**: Project skeleton, CMake build system, Git setup
- **M1**: TLE parsing, single orbit propagation
- **M2**: Cesium 3D visualization of orbits
- **M3**: Coordinate transformations (ECI/ECEF/Geodetic), animation, ground tracks
- **M4**: Launch vehicle physics, orbital elements, rendezvous planning
- **Phase 2**: High-fidelity orbital perturbations (J2/J3/J4, Sun/Moon third-body, SRP, drag)
- **Phase 3**: 6DOF aerodynamics, synthetic camera, gamepad input, checkpoint/resume, crushed-it demo

### Scenario Builder (visualization/cesium/scenario_builder.html):
Interactive drag-and-drop editor with ECS simulation engine. No C++ needed.

- **ECS Framework**: Entity-Component-System with indexed component lookups, 9-system pipeline (AI→Control→Physics→Sensor→Weapon→Event→Viz→HUD→UI)
- **Entity types**: F-16, MiG-29, Spaceplane, LEO/GPS/GEO satellites (with COE dialog), SAM batteries, ground stations, EW radar, GPS receivers
- **Components**: flight3dof, orbital_2body (Kepler + TLE), radar sensor, SAM battery (F2T2EA kill chain), waypoint patrol AI, intercept AI
- **Three modes**: BUILD (place/configure), RUN (simulate), ANALYZE (post-run overlays)
- **Export**: Sim (live ECS in viewer) + Model (headless run → CZML rapid playback)
- **5 scenario templates**: Multi-domain, IADS engagement, GPS coverage, contested orbit, strike package

### JavaScript Interactive Sims (visualization/cesium/):
Standalone browser-based simulations — no C++ backend needed.

- **Satellite Tour** (`sat_tour_viewer.html`) — Animated tour of satellite constellations
- **GEO Sim** (`geo_sim_viewer.html`) — GEO rendezvous with Newton-Raphson intercept
- **LEO Sensor** — LEO imaging constellation revisit visualization
- **GPS PDOP** — Position dilution of precision grid calculator
- **Launch Trajectory** (`launch_viewer.html`) — Gravity turn rocket launch demos
- **Fighter Sim** (`fighter_sim_viewer.html`) — Full F-16 flight sim with HUD, weapons, AI
- **Spaceplane Sim** (`spaceplane_viewer.html`) — **Atmosphere-to-orbit KSP-style sim**

## Architecture

### C++ Core (src/):
```
core/           - SimulationEngine (save_state/load_state), StateVector, PhysicsDomain
physics/        - GravityModel (J2/J3/J4), OrbitalElements, AtmosphereModel,
                  ManeuverPlanner (Hohmann/Lambert), ProximityOps (CW equations),
                  OrbitalPerturbations (unified force model), SolarEphemeris,
                  LunarEphemeris, SolarRadiationPressure, MultiBodyGravity,
                  Aerodynamics6DOF (moments, Euler's equation, quaternion attitude),
                  SyntheticCamera (FOV footprint, GSD, ray-Earth intersection),
                  Vec3Ops (vector/quaternion math utilities)
entities/       - Entity base, Satellite (from TLE), LaunchVehicle (multi-stage),
                  Aircraft (3DOF + optional 6DOF), Fighter (BVR combat),
                  CommandModule (reentry + parachutes)
coordinate/     - TimeUtils (JD/GMST), FrameTransformer (ECI/ECEF/Geodetic)
propagators/    - RK4Integrator
io/             - TLEParser, JsonWriter (header-only), JsonReader, Checkpoint
```

### JavaScript Sim Modules (visualization/cesium/js/):
```
fighter_sim_engine.js   - 3-DOF flight physics (F-16 + spaceplane configs)
                          Gravity, aero, thrust, control, ground handling
fighter_atmosphere.js   - US Standard Atmosphere + thermosphere extension above 84km
fighter_hud.js          - Canvas HUD: pitch ladder, speed/alt tapes, heading,
                          G meter, weapons, target reticle, orbital markers
fighter_autopilot.js    - Altitude/heading/speed hold, waypoint nav
fighter_weapons.js      - AIM-9/AIM-120/bombs/gun with ballistics
fighter_ai.js           - AI wingmen and adversary tactics

spaceplane_orbital.js   - Geodetic→ECI, orbital elements, Kepler propagation,
                          orbit path prediction, flight regime detection
spaceplane_planner.js   - KSP-style maneuver nodes (create/edit/execute)
spaceplane_hud.js       - Planner mode HUD, navball, orbital overlay
```

### ECS Scenario Framework (visualization/cesium/js/):
```
framework/
  ecs.js               - Entity, Component, World classes. Component index cache
                          for O(smallest-set) entitiesWith() lookups.
  constants.js         - R_EARTH, MU_EARTH, DEG/RAD converters
  registry.js          - ComponentRegistry: category/type → class mapping
  systems.js           - System pipeline: AI → Control → Physics → Sensor →
                          Weapon → Event → Visualization → HUD → UI
  loader.js            - ScenarioLoader: JSON → ECS.World (async + sync)
  sensor_system.js     - Runs sensor components (radar detection sweep)
  weapon_system.js     - Runs weapon components (SAM engagement)
  event_system.js      - Timed/proximity/detection event triggers + actions
  tle_parser.js        - TLE parsing, SGP4-lite propagation, ECI↔geodetic

components/
  physics/flight3dof.js      - Aircraft 3-DOF (uses fighter_sim_engine)
  physics/orbital_2body.js   - Keplerian propagation (elements) + TLE (SGP4)
  control/player_input.js    - Keyboard → entity state (fighter controls)
  ai/waypoint_patrol.js      - Fly ordered waypoints, loiter, RTB
  ai/intercept.js            - Pure-pursuit intercept toward target entity
  sensors/radar.js           - Search radar: range, FOV, scan rate, Pd, detection lines
  weapons/sam_battery.js     - SAM battery with F2T2EA kill chain states
  visual/cesium_entity.js    - Point marker + trail (circular buffer) + label
  visual/satellite_visual.js - Orbit path, ground track, Ap/Pe markers
  visual/ground_station.js   - Ground station icon + comm link lines
  visual/radar_coverage.js   - Radar coverage fan (ellipse + arc)

builder/
  builder_app.js         - Main controller: BUILD/RUN/ANALYZE modes, toolbar,
                           inspector, entity tree, palette wiring, tick handler
  scenario_io.js         - File open/save, exportToViewer (Sim), exportModel
                           (headless → CZML), TLE import, validation
  globe_interaction.js   - Click-to-place, drag-to-move, right-click context menu
  object_palette.js      - Entity templates (aircraft, satellites, ground, sensors)
  property_inspector.js  - Entity property editing panel
  entity_tree.js         - Bottom panel entity list with team dots
  satellite_dialog.js    - COE input dialog (6 elements, template defaults,
                           click-position seeding, live periapsis/apoapsis)
  timeline_panel.js      - Canvas timeline: playhead, entity bars, event markers
  analysis_overlay.js    - Post-run: track history, coverage heat map,
                           engagement markers + summary table
```

### Executables:
- `demo` — TLE catalog visualization (generates orbit_data.json)
- `rendezvous_demo` — Launch from Cape Canaveral, orbit insertion, transfer
- `perturbation_demo` — Phase 2: 30-day perturbation fidelity comparison

### Visualization HTML pages:
All served from `visualization/cesium/` via `python3 serve.py 8000`

- `scenario_builder.html` — Interactive scenario editor (BUILD/RUN/ANALYZE)
- `scenario_viewer.html` — Lightweight scenario runner (live ECS physics)
- `model_viewer.html` — CZML rapid-playback viewer (native Cesium, no JS physics)
- `index.html` — Hub page linking all sims + builder

### Server
`serve.py` extends Python's SimpleHTTPRequestHandler with `POST /api/export`
for writing scenario JSON/CZML directly to the `scenarios/` directory.

## Build & Run

### C++ Backend
```bash
cd build && cmake .. && make -j$(nproc)
./build/bin/demo data/tles/satcat.txt
./build/bin/rendezvous_demo
```

### Scenario Builder + Interactive Sims (no build needed)
```bash
cd visualization/cesium
python3 serve.py 8000
# Then open in browser:
# http://localhost:8000/scenario_builder.html     — Scenario Builder
# http://localhost:8000/spaceplane_viewer.html    — Spaceplane sim
# http://localhost:8000/fighter_sim_viewer.html    — Fighter sim
# http://localhost:8000/                           — Hub page
```

## Phase 2 — Orbital Perturbation Models (C++)

### Unified Perturbation Accumulator (`orbital_perturbations.hpp`)
`PerturbationConfig` toggles each perturbation independently:
- `j2`, `j3`, `j4` — Zonal harmonics (EGM96 coefficients)
- `moon`, `sun` — Third-body gravitational perturbations
- `srp` — Solar radiation pressure (cannonball model + cylindrical shadow)
- `drag` — Atmospheric drag with co-rotating atmosphere

Convenience constructors: `two_body_only()`, `j2_only()`, `full_harmonics()`,
`full_fidelity()`, `leo_satellite(mass, area, cd)`, `geo_satellite(mass, area, cr)`

### Key Files
```
physics/gravity_utils.hpp          - J2/J3/J4 perturbation functions, BodyConstants
physics/solar_ephemeris.hpp/cpp    - Low-precision Sun position (Meeus algorithm)
physics/solar_radiation_pressure.hpp/cpp - Cannonball SRP + Earth shadow
physics/orbital_perturbations.hpp/cpp   - Unified force model accumulator
```

### Usage
```cpp
// Configure perturbations
PerturbationConfig config = PerturbationConfig::leo_satellite(420000, 1600, 2.2);
config.epoch_jd = 2461045.0;

// Option 1: Use with Satellite entity
satellite->set_perturbation_config(config);

// Option 2: Use directly with RK4
auto deriv = OrbitalPerturbations::make_derivative_function(config, epoch_jd);
state = RK4Integrator::step(state, dt, deriv);

// Diagnostics: individual perturbation magnitudes
PerturbationBreakdown bd = OrbitalPerturbations::compute_breakdown(pos, vel, config, jd);
```

### Perturbation Magnitudes at 400 km (ISS-like)
| Perturbation | Magnitude (m/s²) | Ratio to J2 |
|---|---|---|
| Central body | 8.685 | — |
| J2 oblateness | 1.25e-2 | 1.0 |
| J3 asymmetry | 2.75e-5 | 0.002 |
| J4 higher-order | 2.06e-5 | 0.002 |
| Moon (3rd body) | 7.1e-7 | 0.00006 |
| Sun (3rd body) | 3.1e-7 | 0.00002 |
| SRP | 2.7e-8 | 0.000002 |

## Spaceplane Sim — Technical Details

### Physics Engine (fighter_sim_engine.js)
- **3-DOF point-mass**: dV/dt (speed), dγ/dt (flight path angle), dψ/dt (heading)
- **Gravity**: `g = μ/(R+alt)²` for spaceplane, constant 9.80665 for fighter
- **Centrifugal term**: `V²/(R_EARTH + alt)` in dGamma — sustains orbit at 7.8 km/s
- **Aero blend**: Log-linear on dynamic pressure (q>100Pa → full aero, q<1Pa → vacuum)
- **Propulsion modes** (P key toggle):
  - AIR: 160kN with density lapse (atmosphere only)
  - HYPERSONIC: 400kN flat (anywhere)
  - ROCKET: 2 MN flat (anywhere)
- **Thrust decomposition by nose direction**:
  - Prograde component: `T·cos(α)·cos(yawOffset)` → changes speed
  - Normal component: `T·sin(α)` → changes flight path angle (orbit raise/lower)
  - Lateral component: `T·cos(α)·sin(yawOffset)` → changes heading (plane change)
  - Point at prograde/retrograde/normal/radial and throttle to apply delta-V
- **Vacuum rotation**: All clamps/damping removed when aeroBlend < 0.5
  - Roll: free 360° everywhere for spaceplane (F-16 keeps ±80° clamp)
  - Pitch (alpha): free rotation, no trim
  - Yaw: rotates `yawOffset` (cosmetic nose direction), NOT the velocity vector
  - Gamma: wraps instead of clamping (spaceplane can loop in atmosphere)
- **yawOffset**: Separates nose heading from velocity heading in vacuum
  - HUD and camera use `heading + yawOffset` (nose direction)
  - Physics and orbital mechanics use `heading` (velocity direction)
  - Decays to 0 in atmosphere as aero forces realign nose with velocity
- **Sub-stepping**: Up to 500 steps of 0.05s each for time warp stability

### Key Constants
```javascript
MU_EARTH = 3.986004418e14   // m³/s²
R_EARTH  = 6371000           // m
OMEGA_EARTH = 7.2921159e-5   // rad/s
SPACEPLANE mass = 15,000 kg, fuel = Infinity
```

### Orbital Mechanics (spaceplane_orbital.js)
- **geodeticToECI()**: lat/lon/alt + speed/heading/gamma → ECI state (includes Earth rotation)
- **computeOrbitalElements()**: Classical elements from r,v vectors
  - Guards against NaN (degenerate inputs, near-zero angular momentum)
- **predictOrbitPath()**: 360-point Kepler propagation
  - Draws suborbital arcs (periapsis threshold: R_EARTH * 0.05)
  - Activates when apoapsisAlt > 30km even in ATMOSPHERIC regime
  - NaN-filtered Cartesian3 output
- **detectFlightRegime()**: ATMOSPHERIC / SUBORBITAL / ORBIT / ESCAPE
  - Uses physical altitude as fallback (above Karman line → SUBORBITAL minimum)
  - Handles parabolic trajectories (sma = Infinity) via energy check
- Update interval: every 15 frames (performance optimization)

### Cockpit HUD (fighter_hud.js)
Above 30km, KSP-style orbital markers appear on the pitch ladder:
- Prograde (green), Retrograde (red), Normal (purple), Anti-normal,
  Radial-out (cyan), Radial-in
- Computed from ECI velocity/position → ENU → bearing/elevation → pitch ladder coords
- Requires `simTime` passed as 5th arg to `FighterHUD.render()`

**Compact navball** at bottom-center (above 30km):
- Horizon line based on pitch
- Dynamic prograde/retrograde/normal/radial markers from ECI state
- All bearing calculations use nose heading (`heading + yawOffset`)

**Flight regime indicator** at top-right:
- Color-coded: green=ATMOSPHERIC, yellow=SUBORBITAL, cyan=ORBIT, red=ESCAPE
- Always visible in cockpit mode

### Keyboard Controls (spaceplane_viewer.html)
```
WASD / Arrows  — Throttle, pitch, roll
Q/E            — Yaw (nose rotation in vacuum — does NOT change velocity)
Space          — Pause
E              — Engine on/off
P              — Cycle propulsion: AIR → HYPERSONIC → ROCKET
M              — Toggle planner mode
N              — Create maneuver node
Enter          — Execute maneuver node
Delete         — Delete maneuver node
+/-            — Time warp (up to 1024x)
C              — Cycle camera
H              — Controls help
1 / 2 / 3     — Toggle flight data / systems / orbital panels
O              — Toggle orbital elements panel (auto / on / off)
Tab            — Hide/show all panels
```

### Start Modes
1. Airborne (5km, 200 m/s)
2. Runway (Edwards AFB)
3. Suborbital (80km, Mach 10, 35° gamma)
4. Orbital (400km, 7700 m/s, circular)

## Fighter Sim — Technical Details

Same physics engine with F-16 config:
- Realistic F-16 aero (wing area, Cl/Cd curves, Oswald efficiency)
- AB thrust 130kN, TSFC modeled, 3200kg fuel
- Weapons: AIM-9, AIM-120, bombs, gun with ballistic prediction
- AI adversaries with basic tactics
- Full HUD: pitch ladder, speed/alt tapes, heading, G meter, warnings

## Scenario Builder — Technical Details

### ECS Architecture
- **Entity**: id, name, type, team, flat mutable `state` object, component map
- **Component**: Base class with `init(world)`, `update(dt, world)`, `cleanup(world)` lifecycle
- **World**: Entity map, ordered system list, simTime/wallTime/timeWarp, Cesium viewer ref
- **Component Index Cache**: `_componentIndex[componentName] → Set<entityId>` — `entitiesWith()` intersects smallest index set instead of O(n) scanning all entities
- **System Pipeline Order**: AI → Control → Physics → Sensor → Weapon → Event → Visualization → HUD → UI

### Scenario JSON Format
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

### Satellite COE Dialog
When placing a satellite on the globe, a modal dialog appears with 6 Classical Orbital Elements:
- SMA (km), Eccentricity, Inclination (°), RAAN (°), Arg of Perigee (°), Mean Anomaly (°)
- Template-specific defaults: LEO (6771km, 51.6°), GPS (26571km, 55°), GEO (42164km, 0.05°)
- Click-position seeding: RAAN from longitude, inclination from |latitude|
- Live computed periapsis/apoapsis altitude and orbital period

### Dual Export
- **Export Sim**: POST scenario JSON to `/api/export`, open `scenario_viewer.html` (live ECS physics, full component pipeline)
- **Export Model**: Build ECS world, tick headlessly at max speed for N seconds, record entity positions at 2 Hz, generate CZML document, open `model_viewer.html` (native Cesium interpolation playback, zero JS physics overhead)

### Performance Optimizations
- Component index cache: `entitiesWith()` O(smallest-set) instead of O(N)
- Radar material caching: 3 pre-created `PolylineDashMaterialProperty` objects, reused per sweep
- Radar entity filtering: skip ground-to-ground (both below 100m)
- Timeline canvas: throttled to 4 Hz instead of every frame
- Analysis recording: throttled to 2 Hz instead of every frame
- Sim time DOM display: throttled to 4 Hz
- Entity tree DOM updates: throttled to 250ms
- Trail circular buffer: O(1) overwrite instead of O(n) `Array.shift()`
- Cached Cartesian3 position: updated once per tick, reused by CallbackProperty

## Known Issues
1. **C++ orbit insertion**: 140x320km, should target 400km circular
2. **Proximity ops NaN**: LVLH edge case when vehicles overlap
3. **Model**: Removed (using point marker) — can be re-added with any .glb

## Bugs Fixed (2026-01-30 session)
- **SpaceplaneOrbital SyntaxError**: Duplicate `const rPe` in `computeApPePositions`
  prevented the entire module from loading. All orbital mechanics were silently
  non-functional. Regime was always ATMOSPHERIC at any altitude.
- **Orbit viz too restrictive**: `predictOrbitPath` rejected periapsis < 0.5 R_EARTH,
  which excluded all suborbital arcs. Lowered to 0.05 R_EARTH.
- **NaN guard killed parabolic orbits**: sma=Infinity for near-escape trajectories
  triggered the NaN guard, forcing ATMOSPHERIC regardless of altitude/energy.
- **Yaw changed orbit**: Vacuum yaw modified `state.heading` (velocity azimuth),
  directly altering the trajectory. Now modifies `yawOffset` (cosmetic only).
- **Thrust always prograde**: No matter which direction the nose pointed, thrust
  only changed speed. Now decomposes thrust into prograde/normal/lateral components.

## Dependencies
- CMake 3.20+, C++17 (for C++ backend)
- Python3 (HTTP server)
- Modern browser with WebGL (Cesium)
- No npm/node — Cesium loaded from CDN

## Working Style

- **Bias toward action**: When the user gives direction, implement it fully. Don't ask
  clarifying questions when the intent is clear — just build it.
- **Investigate root causes**: When a bug is reported, trace through the actual code path
  to find the real issue. Don't slap a try/catch on it.
- **Ship complete features**: A new feature means the physics, the UI, the keyboard
  bindings, the display updates, and the edge case guards. Not just the core logic.
- **Commit only when asked**: Don't commit or push unless the user explicitly says to.
- **The user gives high-level direction**: "Add yaw rotation in space" or "the planner
  buttons don't work." Figure out which files, which functions, what the fix is.
- **Read before you edit**: Always read the current state of a file before modifying it.
  The codebase evolves fast and assumptions from earlier in the session may be stale.
- **Performance matters**: These run in the browser at 60fps. Guard against per-frame
  allocations, NaN propagation to Cesium, and unbounded loops. The orbital prediction
  freeze was caused by NaN Cartesian3 values reaching Cesium's renderer.
- **Keep the HTTP server running**: `cd visualization/cesium && python3 serve.py 8000`
  The user tests changes by refreshing the browser (Ctrl+F5 for hard refresh).
  Use `serve.py` instead of `python3 -m http.server` — it adds `POST /api/export`.

## Git Conventions
- Commit messages: imperative mood, describe what changes do
- Co-author: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`
