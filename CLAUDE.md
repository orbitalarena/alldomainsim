# Claude Code Project Context

## Project: All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios from ground operations through orbital mechanics. Think KSP meets STK meets AFSIM with Cesium 3D visualization.

## Current Status: C++ Multi-Domain MC Engine Complete

### C++ Backend (Milestones 0-4 + Phases 2-3 + MC Engine):
- **M0**: Project skeleton, CMake build system, Git setup
- **M1**: TLE parsing, single orbit propagation
- **M2**: Cesium 3D visualization of orbits
- **M3**: Coordinate transformations (ECI/ECEF/Geodetic), animation, ground tracks
- **M4**: Launch vehicle physics, orbital elements, rendezvous planning
- **Phase 2**: High-fidelity orbital perturbations (J2/J3/J4, Sun/Moon third-body, SRP, drag)
- **Phase 3**: 6DOF aerodynamics, synthetic camera, gamepad input, checkpoint/resume, crushed-it demo
- **MC Engine**: Headless Monte Carlo simulation engine — see detailed section below

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

---

## C++ Headless MC Engine — Complete Architecture

### Overview
The `mc_engine` executable runs Monte Carlo simulations headlessly at native speed, processing scenario JSON from the browser builder and outputting results JSON or replay JSON for Cesium playback.

### Two Modes
1. **Batch MC mode** (`mc_engine --scenario <path> --runs N`): Runs N independent simulations, outputs aggregated results (engagement counts, survival rates, per-run breakdown)
2. **Replay mode** (`mc_engine --replay --scenario <path>`): Single deterministic run sampling ECEF positions at intervals, outputs trajectory JSON for the Cesium replay viewer

### Build & Run
```bash
cd build && cmake .. && ninja mc_engine

# Batch MC (100 runs, results JSON)
./bin/mc_engine --scenario ../visualization/cesium/scenarios/demo_iads_engagement.json \
    --runs 100 --seed 42 --max-time 600 --output results.json --verbose

# Replay (single run, trajectory JSON for Cesium)
./bin/mc_engine --replay \
    --scenario ../visualization/cesium/scenarios/demo_iads_engagement.json \
    --seed 42 --max-time 600 --sample-interval 2 \
    --output ../visualization/cesium/replay_iads.json --verbose
```

### Source Files (src/montecarlo/)

**Core:**
| File | Purpose |
|------|---------|
| `mc_entity.hpp` | Flat entity struct: identity, PhysicsType/AIType/WeaponType enums, ECI state, geodetic pos, flight state, aircraft params, waypoint/intercept/radar/SAM/A2A state, engagement log |
| `mc_world.hpp` | Entity container + ScenarioEvent structs (trigger/action) |
| `mc_world.cpp` | add_entity, get_entity by ID (O(1) via unordered_map) |
| `scenario_parser.hpp/cpp` | MCConfig + JSON→MCWorld parser. Handles both IADS (entityA/entityB) and Strike (entityId/targetId) event naming. Auto-assigns waypoint_patrol AI to player_input entities. |
| `mc_runner.hpp/cpp` | Batch MC orchestrator + replay runner. Tick order: AI→Physics→Sensors→Weapons→Events. Multi-domain combat resolution (orbital HVA + atmospheric aircraft). |
| `mc_results.hpp/cpp` | RunResult, EngagementEvent, EntitySurvival, JSON output |
| `mc_engine.cpp` | CLI entry point (--scenario, --replay, --runs, --seed, --max-time, --dt, --sample-interval, --output, --verbose) |

**Physics:**
| File | Purpose |
|------|---------|
| `kepler_propagator.hpp` | Kepler propagation + init_from_elements (for orbital entities) |
| `flight3dof.hpp/cpp` | 3-DOF atmospheric flight: lift/drag/thrust/gravity → dV/dGamma/dHeading → geodetic position update |
| `atmosphere.hpp` | US Standard Atmosphere 1976 (header-only): 7 layers + thermosphere. `get_atmosphere(alt_m)` → T, P, ρ, a |
| `aircraft_configs.hpp` | F-16, MiG-29, AWACS, F-15, Su-27 parameter structs (header-only) |
| `geo_utils.hpp` | Haversine, geodetic→ECEF (WGS84), bearing, destination_point, slant_range, elevation_angle (header-only) |

**AI:**
| File | Purpose |
|------|---------|
| `orbital_combat_ai.hpp/cpp` | GEO combat AI: HVA defense, pursuit, kinetic kill targeting |
| `waypoint_patrol_ai.hpp/cpp` | Great-circle waypoint navigation with bank/altitude/speed steering |
| `intercept_ai.hpp/cpp` | Pure-pursuit intercept toward target entity |

**Sensors:**
| File | Purpose |
|------|---------|
| `radar_sensor.hpp/cpp` | Periodic sweep, ECEF range/elevation check, probabilistic detection via seeded RNG |

**Weapons:**
| File | Purpose |
|------|---------|
| `kinetic_kill.hpp/cpp` | Orbital KKV: cooldown, range check, Pk roll |
| `sam_battery.hpp/cpp` | F2T2EA kill chain: DETECT(1s)→TRACK(2s)→ENGAGE(TOF)→ASSESS(3s), salvo fire, Pk per missile |
| `a2a_missile.hpp/cpp` | A2A engagement: LOCK(1.5s)→FIRE(TOF)→ASSESS(2s), weapon selection by range, inventory tracking |

**Events & Output:**
| File | Purpose |
|------|---------|
| `event_system.hpp/cpp` | Trigger evaluation (time, proximity, detection) + action execution (message, change_rules, set_state) |
| `replay_writer.hpp/cpp` | Trajectory sampling, ECI→ECEF / geodetic→ECEF, JSON output for Cesium viewer |
| `sim_rng.hpp` | Deterministic seeded RNG (xorshift128+) |

### Tick Order
```
1. AI:      OrbitalCombatAI → WaypointPatrolAI → InterceptAI
2. Physics: Kepler (orbital) → Flight3DOF (atmospheric) → [Static: no-op]
3. Sensors: RadarSensor
4. Weapons: KineticKill → SAMBattery → A2AMissile
5. Events:  EventSystem
```

### Entity Type Discriminators
```cpp
PhysicsType: NONE | ORBITAL_2BODY | FLIGHT_3DOF | STATIC
AIType:      NONE | ORBITAL_COMBAT | WAYPOINT_PATROL | INTERCEPT
WeaponType:  NONE | KINETIC_KILL | SAM_BATTERY | A2A_MISSILE
```

### Replay JSON Format (replay_v1)
```json
{
  "format": "replay_v1",
  "config": { "seed": 42, "duration": 600, "sampleInterval": 2 },
  "timeline": { "endTime": 447.8, "sampleTimes": [0, 2, 4, ...] },
  "entities": [
    { "id": "eagle_1", "name": "EAGLE 1", "team": "blue", "type": "aircraft",
      "role": null, "deathTime": 162.9,
      "positions": [[-2513976,-4630168,3596823], ...] }
  ],
  "events": [
    { "time": 13.2, "type": "LAUNCH", "sourceId": "sam_alpha", "targetId": "gnd_edwards",
      "sourcePosition": [...], "targetPosition": [...] }
  ],
  "summary": { "blueAlive": 0, "blueTotal": 3, "redAlive": 4, "redTotal": 4,
               "totalKills": 4, "totalLaunches": 8 }
}
```

### Replay Viewer (replay_viewer.html)
Cesium-based 3D playback of replay JSON:
- PointPrimitiveCollection (single draw call for all entities)
- Float64Array per entity for zero-allocation interpolation
- Linear position interpolation between samples
- Kill flash animation (yellow burst, 3s fade)
- Engagement polylines (20s fade)
- Cesium timeline scrubbing + play/pause/speed control
- Stats panel, scrolling event log, entity list with click-to-track
- Keyboard: Space=play/pause, +/-=speed, L/T/K=toggle labels/trails/kills, Esc=untrack

### Scenario Compatibility Matrix
| Scenario | Entities | C++ Support | Replay Generated |
|----------|----------|-------------|------------------|
| test_orbital_arena_small | 10 (GEO sats) | Full (orbital_2body + orbital_combat + kinetic_kill) | replay_data.json |
| test_orbital_arena_100 | 100 (GEO sats) | Full | replay_data.json |
| demo_iads_engagement | 10 (aircraft+SAM+sat+ground) | Full (multi-domain) | replay_iads.json |
| template_strike_package | 8 (aircraft+SAM+ground) | Full (multi-domain) | replay_strike.json |
| demo_multi_domain | 9 (sats+aircraft+ground) | Full (multi-domain) | Not yet generated |
| template_contested_orbit | 7 (sats+ground) | Full (orbital only, ground is static) | Not yet generated |
| template_gps_coverage | 10 (GPS sats+ground) | Partial (no combat, just propagation) | Not yet generated |
| demo_fighter_patrol | 1 (F-16) | Full (flight3dof, player→auto AI) | Not yet generated |
| demo_two_aircraft | 2 (F-16s) | Full (flight3dof) | Not yet generated |
| h.json | 7 (sats+ground) | Full (orbital+static) | Not yet generated |

### Performance
| Scenario | Mode | Time |
|----------|------|------|
| IADS (10 entities, 448s sim) | Replay | 7.8ms |
| Strike (8 entities, 600s sim) | Replay | 7.5ms |
| Orbital Arena (10 entities, 600s) | Replay | 13.8ms |
| IADS (10 entities, 300s × 10 runs) | Batch MC | 34.8ms |

---

## NEXT STEPS — Detailed Instructions

### What Was Just Completed
The C++ headless MC engine now supports multi-domain scenarios (atmospheric flight, radar sensors, SAM batteries, A2A missiles, waypoint/intercept AI, events). Three replay JSONs have been generated:
- `replay_data.json` — orbital arena (from earlier session)
- `replay_iads.json` — IADS engagement (10 entities, combat resolves at 448s)
- `replay_strike.json` — strike package (8 entities, runs full 600s)

### Step 1: Upgrade replay_viewer.html for Multi-Domain

The replay viewer was originally built for orbital GEO combat. It needs several improvements to properly handle atmospheric/ground scenarios:

**Camera auto-detection**: Currently starts at 80,000,000m altitude (GEO view). Should detect scenario type from entity positions:
- If ALL entities are > 100km altitude → orbital camera (current behavior)
- If ANY entity is < 100km altitude → atmospheric camera (~500km altitude, centered on entity cluster)
- Calculate centroid of initial entity positions to set camera target

**Entity coloring by type**: Current color scheme is role-based (HVA=gold, defender=blue, etc.) which only makes sense for orbital combat. Need type-aware coloring:
- Aircraft: team color (blue=#4488ff, red=#ff4444) with brightness by type (fighter=bright, AWACS=medium, bomber=dim)
- Ground stations: team color but desaturated/darker
- SAM sites: team color + distinct shape or pulsing
- Satellites: keep existing role-based colors
- Fallback: if entity has no role, use team color + type string

**Ground entity rendering**: Ground stations/SAMs currently render as tiny dots on the Earth surface. Need:
- Larger pixel size for ground entities (12px vs 8px for aircraft vs 6px for satellites)
- Optional range rings for SAM/radar entities (if maxRange available in replay data — would need to add to replay JSON)
- Different point shape if possible (Cesium supports different point primitives)

**Entity info on hover/click**: Show entity metadata (type, team, weapons, status) in a tooltip or sidebar detail panel when clicked.

**Replay file selector**: Add a dropdown or file picker to switch between replay files without editing the URL. List all `replay_*.json` files.

### Step 2: Generate Replays for All Remaining Scenarios

Run the C++ engine on all compatible scenarios:

```bash
cd /home/ace/all-domain-sim/build

# Multi-domain demo
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/demo_multi_domain.json \
    --seed 42 --max-time 600 --sample-interval 2 \
    --output ../visualization/cesium/replay_multi_domain.json --verbose

# Contested orbit
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/template_contested_orbit.json \
    --seed 42 --max-time 600 --sample-interval 2 \
    --output ../visualization/cesium/replay_contested_orbit.json --verbose

# GPS coverage
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/template_gps_coverage.json \
    --seed 42 --max-time 600 --sample-interval 2 \
    --output ../visualization/cesium/replay_gps_coverage.json --verbose

# Fighter patrol
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/demo_fighter_patrol.json \
    --seed 42 --max-time 300 --sample-interval 2 \
    --output ../visualization/cesium/replay_fighter_patrol.json --verbose

# Two aircraft
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/demo_two_aircraft.json \
    --seed 42 --max-time 300 --sample-interval 2 \
    --output ../visualization/cesium/replay_two_aircraft.json --verbose
```

Some scenarios may need parser updates if they use JSON fields not yet handled (check for errors).

### Step 3: Wire Scenario Builder MC Panel to C++ Engine

The scenario builder has a built-in MC analysis panel (`js/builder/mc_runner.js`, `mc_analysis.js`, `mc_panel.js`) that currently runs MC simulations in JavaScript (slow). Wire it to use the C++ engine:

**Option A: Node.js wrapper** (requires Node):
- Create a small Node.js server that accepts scenario JSON via POST, spawns `mc_engine` as a child process, streams results back
- Builder sends scenario to Node server instead of running JS MC
- Advantages: fast (C++ speed), runs on same machine, keeps browser responsive
- File: `visualization/cesium/mc_server.js` or similar

**Option B: WebAssembly compilation**:
- Compile the C++ MC engine to WASM via Emscripten
- Load in browser, run MC directly without server
- Advantages: no server needed, works offline
- Disadvantages: Emscripten setup, may need build system changes

**Option C: Shell script bridge** (simplest):
- Builder exports scenario JSON to disk (already supports this via POST /api/export)
- User runs `mc_engine` from terminal
- Builder loads results JSON for analysis display
- Advantages: zero new code for engine, just UI to trigger and load

### Step 4: Index/Hub Page Updates

Update `index.html` (hub page) to include:
- Link to replay viewer with all available replays
- Scenario compatibility status (which scenarios have replay data)
- C++ engine build instructions

### Known Behavior Notes

**SAM targeting ground bases**: Both IADS and Strike scenarios have SAM batteries engaging ground stations (Edwards AFB, Ali Al Salem AB). This happens because radar detects all opposing-team entities regardless of type, and SAMs engage any detected target. This is technically correct (SAMs fire at radar returns) but may not match scenario intent. To fix: add target type filtering in `sam_battery.cpp` to skip entities where `geo_alt < 100` or `type == "ground"`.

**Strike package detection event**: The `evt_sam_weapons_free` event in `template_strike_package.json` triggers on radar detection of `strike_1`. The SAM's radar (200km range) detects strike_1 almost immediately since they start ~170km apart. This means the SAM goes weapons_free very early. If longer delay is desired, reduce SAM radar range or increase the starting distance.

**Player input auto-AI**: Entities with `control.type == "player_input"` get auto-assigned `WAYPOINT_PATROL` AI with a single waypoint 100km ahead on current heading. They fly straight and level. This is a reasonable headless approximation but means "player" aircraft don't do anything tactical.

---

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
montecarlo/     - MC engine: MCEntity, MCWorld, ScenarioParser, MCRunner,
                  ReplayWriter, OrbitalCombatAI, KineticKill, Flight3DOF,
                  WaypointPatrolAI, InterceptAI, RadarSensor, SAMBattery,
                  A2AMissile, EventSystem, atmosphere, aircraft_configs, geo_utils
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
  ai/orbital_combat.js       - GEO combat AI (HVA, defender, attacker, sweep)
  sensors/radar.js           - Search radar: range, FOV, scan rate, Pd
  weapons/sam_battery.js     - SAM battery with F2T2EA kill chain states
  weapons/fighter_loadout.js - Aircraft weapons (AIM-120/AIM-9/bombs)
  weapons/a2a_missile.js     - Air-to-air missile engagement
  weapons/kinetic_kill.js    - Kinetic projectile intercept (orbital)
  visual/cesium_entity.js    - Point marker + trail (circular buffer) + label
  visual/satellite_visual.js - Orbit path, ground track, Ap/Pe markers
  visual/ground_station.js   - Ground station icon + comm link lines
  visual/radar_coverage.js   - Radar coverage fan (ellipse + arc)

builder/
  builder_app.js         - Main controller: BUILD/RUN/ANALYZE modes
  scenario_io.js         - File open/save, exportToViewer, exportModel
  globe_interaction.js   - Click-to-place, drag-to-move
  object_palette.js      - Entity templates (aircraft, sats, ground, naval)
  property_inspector.js  - Entity property editing panel
  entity_tree.js         - Bottom panel entity list
  satellite_dialog.js    - COE input dialog
  timeline_panel.js      - Canvas timeline: playhead, entity bars, event markers
  analysis_overlay.js    - Post-run overlays
  run_inspector.js       - Live simulation HUD
  event_editor.js        - Visual event creator
  mc_runner.js           - Monte Carlo batch executor (JS, slow)
  mc_analysis.js         - MC result aggregator
  mc_panel.js            - MC UI panel
```

### Executables:
- `mc_engine` — **Headless Monte Carlo engine** (batch MC + replay generation)
- `demo` — TLE catalog visualization (generates orbit_data.json)
- `rendezvous_demo` — Launch from Cape Canaveral, orbit insertion, transfer
- `perturbation_demo` — Phase 2: 30-day perturbation fidelity comparison

### Visualization HTML pages:
All served from `visualization/cesium/` via `python3 serve.py 8000`

- `scenario_builder.html` — Interactive scenario editor (BUILD/RUN/ANALYZE)
- `scenario_viewer.html` — Lightweight scenario runner (live ECS physics)
- `replay_viewer.html` — **C++ replay playback** (load ?replay=replay_iads.json)
- `model_viewer.html` — CZML rapid-playback viewer (native Cesium, no JS physics)
- `index.html` — Hub page linking all sims + builder

### Server
`serve.py` extends Python's SimpleHTTPRequestHandler with `POST /api/export`
for writing scenario JSON/CZML directly to the `scenarios/` directory.

## Build & Run

### C++ Backend
```bash
cd build && cmake .. && ninja mc_engine
# or ninja -j$(nproc) for all targets
```

### MC Engine Usage
```bash
# Batch MC
./bin/mc_engine --scenario <path.json> --runs 100 --seed 42 --max-time 600 --output results.json --verbose

# Replay generation
./bin/mc_engine --replay --scenario <path.json> --seed 42 --max-time 600 --sample-interval 2 --output replay.json --verbose
```

### Scenario Builder + Interactive Sims (no build needed)
```bash
cd visualization/cesium
python3 serve.py 8000
# Then open in browser:
# http://localhost:8000/scenario_builder.html     — Scenario Builder
# http://localhost:8000/replay_viewer.html?replay=replay_iads.json  — Replay
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
4. **SAM targets ground bases**: SAM engages any radar-detected opposing entity including ground stations. Fix: filter by target altitude or type in `sam_battery.cpp`.

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
- **C++ build uses Ninja**: Always `cd build && cmake .. && ninja mc_engine` (not make).

## Git Conventions
- Commit messages: imperative mood, describe what changes do
- Co-author: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`
