# All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios — from runway taxi through atmospheric flight to orbital mechanics. KSP meets STK meets AFSIM with Cesium 3D globe visualization.

**Team**: Human + Claude | **Status**: Live Cockpit Combat + Orbital Fix + Platform Builder + MC Engine

## Quick Start

No build step needed for the interactive sims — just serve and open in a browser:

```bash
cd visualization/cesium
python3 serve.py 8000
```

Then open: **http://localhost:8000/**

> `serve.py` is a custom server that supports static file serving plus scenario export (`POST /api/export`). You can also use `python3 -m http.server 8000` for read-only serving.

### Featured

| App | URL | Description |
|-----|-----|-------------|
| **Scenario Builder** | `/scenario_builder.html` | Interactive drag-and-drop scenario editor. Place aircraft, satellites, SAM batteries, ground stations. Run simulation, analyze with Chart.js dashboard, export to C++ engine. |
| **Live Sim** | `/live_sim_viewer.html` | Cockpit sim launched from Scenario Builder. Weapons HUD, sensor cycling, pitch trim, chase camera with bank, per-element HUD toggles. |
| **Replay Viewer** | `/replay_viewer.html?replay=replay_iads.json` | C++ replay playback with range rings, animated missile trails, engagement timeline. 11 pre-generated replays. |
| **Spaceplane** | `/spaceplane_viewer.html` | Atmosphere-to-orbit flight. KSP-style orbital mechanics, maneuver nodes, 3 propulsion modes. Start on the runway or in orbit. |
| **Fighter** | `/fighter_sim_viewer.html` | F-16 flight sim with full HUD, weapons (AIM-9/AIM-120/bombs/gun), AI adversaries. |
| **Scenario Viewer** | `/scenario_viewer.html?scenario=scenarios/demo_multi_domain.json` | Lightweight viewer for exported scenarios (live ECS physics). |
| **Model Viewer** | `/model_viewer.html?czml=scenarios/name_czml.json` | CZML rapid-playback viewer for model exports (no physics overhead). |
| **Satellite Tour** | `/sat_tour_viewer.html` | Animated 3D tour of satellite constellations on Cesium globe. |
| **GEO Sim** | `/geo_sim_viewer.html` | GEO rendezvous with Newton-Raphson intercept planner. |
| **Launch Trajectory** | `/launch_viewer.html` | Gravity turn rocket launch with multiple scenario demos. |
| **Orbit Viewer** | `/orbit_viewer.html` | TLE-based orbit visualization with ground tracks. |

## Scenario Builder

Interactive multi-domain scenario editor with three modes:

- **BUILD** — Drag entities from the palette onto the Cesium globe. Configure properties in the inspector. Right-click for context menu (focus, duplicate, delete).
- **RUN** — Execute the ECS simulation with live physics, AI, radar, weapons. Timeline panel shows entity activity. Time warp with +/-.
- **ANALYZE** — Post-run overlays: track history, coverage heat maps, engagement markers and summary.

### Entity Types
- **Aircraft**: F-16, MiG-29, X-37S Spaceplane (3-DOF flight physics)
- **Satellites**: LEO, GPS, GEO with Classical Orbital Elements dialog (SMA, eccentricity, inclination, RAAN, arg perigee, mean anomaly)
- **Ground**: SAM batteries (F2T2EA kill chain), ground stations, GPS receivers, EW radar
- **AI**: Waypoint patrol, intercept pursuit
- **Custom Platforms**: Create any entity via the Platform Builder (see below)

### Platform Builder
Click **"+ Platform"** in the Scenario Builder toolbar to create fully custom entities. Five configuration tabs:

**PHYSICS** — Choose the motion model:
- **TLE**: Paste Two-Line Element for real satellite orbits
- **COE**: Classical Orbital Elements (SMA, ecc, inc, RAAN, arg perigee, MA)
- **Atmospheric**: 3-DOF flight with configurable aircraft type (F-16, F-22, MiG-29, Spaceplane, Bomber, AWACS, etc.)

**PROPULSION** — Select multiple engine types (P key cycles in sim):
- Air-breathing (turbofan), Hypersonic (scramjet), Rocket, Ion/Electric, RCS thrusters
- Available for ALL physics types — satellites can have thrusters, spaceplanes can re-enter

**SENSORS** — Add sensor packages (S key opens sensor view):
- Search Radar, Electro-Optical camera, Infrared/Thermal, SAR (all-weather)
- SIGINT/ESM (passive), LIDAR (3D mapping)

**PAYLOAD** — Multiple weapon/effect systems:
- *Weapons*: A2A missiles, A2G ordnance, Kinetic Kill Vehicle (ASAT)
- *EW*: Jammer/ECM, Decoys/Chaff/Flares
- *Debris*: Space debris (collision-triggered), Air debris (destruction)
- *Special*: Cargo deployer (cubesats, drones), ☢ Nuclear warhead (Starfish Prime style), ☢ Nuclear cruise missile

**ENVIRON** — Configure scenario environment:
- *Gravity*: Earth, Moon, Mars, Jupiter, Venus, or custom μ
- *Atmosphere*: Earth Standard, Mars, Venus, Titan, or vacuum
- *Magnetic Field*: Earth dipole, Jupiter (14x), custom — required for EMP effects
- *Ionosphere*: Standard, Solar Max/Min, disturbance levels (including "Nuclear EMP Event")
- *Radiation Belts*: Van Allen, Starfish-Enhanced, Jupiter-level

Custom platforms are saved to localStorage and embedded in scenario JSON.

### Export Modes
- **Export Sim** — Writes scenario JSON to `scenarios/`, opens in the Scenario Viewer with live ECS physics
- **Export Model** — Runs sim headlessly at max speed, records all positions, exports CZML for native Cesium playback with zero JS overhead
- **Export C++ Replay** — Sends scenario to C++ MC engine via Node.js bridge, generates replay JSON for the Replay Viewer with progress reporting

### MC Analysis Dashboard
Run batch Monte Carlo simulations (JS or C++ engine) and view results in a Chart.js tabbed dashboard:
- **Overview**: Team survival bar chart, kill distribution histogram, entity survival table
- **Weapons**: Weapon effectiveness doughnut chart, kill chain funnel (SAM F2T2EA success rates)
- **Timeline**: Engagement scatter plot (time vs run index, colored by event type)
- **Raw Data**: Per-run tables, CSV/JSON export

### Scenario Templates
| Template | Description |
|----------|-------------|
| Multi-Domain Awareness | LEO/MEO/GEO satellites + aircraft + ground stations |
| IADS Engagement | Blue strike package vs red SAM network with AI patrol |
| GPS Coverage Analysis | 6 GPS satellites, 3 receivers, DOP analysis |
| Contested Orbit | SSA scenario with co-orbital threats and GEO inspector |
| Strike Package | F-16 flight vs SA-20 IADS in theater |
| Orbital Arena Large | 850v850 across LEO Sun-Synch, GTO, GEO, and Lunar orbit |

## Spaceplane Sim

Fly from the runway to orbit and back. Full 3-DOF flight physics with smooth atmosphere-to-vacuum transition.

### Controls
```
W/S or Up/Down    Throttle, pitch
A/D or Left/Right Roll (bank)
Q/E               Yaw (repoints nose in vacuum, does not change orbit)
P                 Cycle propulsion: AIR → HYPERSONIC → ROCKET
Escape            Pause (cockpit + planner modes)
E                 Engine on/off
Space             Fire weapon
W                 Cycle weapon
V                 Cycle sensor
T / Shift+T       Adjust pitch trim (+0.5° / -0.5°)
M                 Toggle orbital planner mode
N                 Create maneuver node
Enter             Execute maneuver node
+/-               Time warp (up to 1024x)
C                 Cycle camera (chase with bank / cockpit / free)
H                 Show all controls
1/2/3             Toggle flight data / systems / orbital panels
O                 Toggle orbital elements panel
Tab               Hide/show all panels
```

### Start Modes
1. **Airborne** — 5km altitude, 200 m/s
2. **Runway** — Edwards AFB, standing start
3. **Suborbital** — 80km, Mach 10, climbing
4. **Orbital** — 400km circular orbit, 7700 m/s

### Physics
- Inverse-square gravity with centrifugal V²/R term (real orbits)
- US Standard Atmosphere extended to thermosphere (exponential decay above 84km)
- Smooth aero-to-vacuum blend based on dynamic pressure
- Three propulsion modes: AIR (160kN turbofan), HYPERSONIC (800kN), ROCKET (5 MN)
- **Thrust vectoring**: Point nose at prograde/normal/radial and throttle to apply delta-V in that direction. Thrust decomposes into prograde, normal, and lateral components.
- Free rotation in vacuum (pitch, roll, yaw unclamped). Roll is 360° in atmosphere for spaceplane.
- Yaw in vacuum repoints the nose without changing the velocity vector (realistic RCS behavior)
- KSP-style orbital markers on HUD and compact navball (prograde, retrograde, normal, radial)
- Flight regime detection with color-coded indicator: ATMOSPHERIC → SUBORBITAL → ORBIT → ESCAPE
- Orbital elements panel with projected trajectory data starting at 30km altitude
- Maneuver node planner with predicted orbit visualization
- Toggleable UI panels (1/2/3/O/Tab) for minimal or full cockpit display

## Fighter Sim

Full F-16 simulation with realistic flight dynamics.

- Pitch ladder, speed/altitude tapes, heading, G meter
- AIM-9 Sidewinder, AIM-120 AMRAAM, bombs, gun
- AI wingmen and adversary aircraft
- Autopilot (altitude, heading, speed hold)
- Gear, flaps, brakes, afterburner

## C++ MC Engine

Headless Monte Carlo simulation engine for batch analysis and replay generation:

```bash
# Build
cd build && cmake .. && ninja mc_engine

# Batch MC (100 runs, aggregated results)
./bin/mc_engine --scenario ../visualization/cesium/scenarios/demo_iads_engagement.json \
    --runs 100 --seed 42 --max-time 600 --output results.json --verbose

# Replay (trajectory JSON for Cesium viewer)
./bin/mc_engine --replay --scenario ../visualization/cesium/scenarios/demo_iads_engagement.json \
    --seed 42 --max-time 600 --sample-interval 2 --output replay.json --verbose
```

### Pre-Generated Replays (11 datasets)
| Replay | Scenario | Entities |
|--------|----------|----------|
| `replay_arena_large.json` | Orbital Arena Large | 1700 (4 orbital regimes: LEO/GTO/GEO/Lunar) |
| `replay_iads.json` | IADS Engagement | 10 (aircraft + SAM + sat + ground) |
| `replay_strike.json` | Strike Package | 8 (aircraft + SAM + ground) |
| `replay_data.json` | Orbital Arena | 100 (GEO satellites) |
| `replay_contested_orbit.json` | Contested Orbit | 7 (sats + ground) |
| `replay_gps_coverage.json` | GPS Coverage | 10 (GPS sats + ground) |

### C++ Architecture
```
src/
├── core/          Simulation engine, state vectors
├── physics/       Gravity (J2/J3/J4), orbital elements, atmosphere,
│                  Hohmann/Lambert transfers, CW equations, SRP, drag
├── entities/      Satellite (TLE), launch vehicle, aircraft, fighter
├── coordinate/    ECI/ECEF/Geodetic transforms, GMST
├── propagators/   RK4 integrator
├── io/            TLE parser, JSON reader/writer
└── montecarlo/    MC engine: entity, world, parser, runner, replay writer,
                   AI (orbital combat, waypoint patrol, intercept),
                   weapons (kinetic kill, SAM battery, A2A missile),
                   sensors (radar), events, flight3DOF, Kepler propagator
```

### JavaScript Sim Modules
```
visualization/cesium/js/
├── live_sim_engine.js       Hybrid cockpit+ECS engine (weapons, sensors, trim, camera)
├── fighter_sim_engine.js    3-DOF flight physics engine
├── fighter_atmosphere.js    US Standard Atmosphere + thermosphere
├── fighter_hud.js           Canvas HUD with pitch ladder & orbital markers
├── fighter_autopilot.js     Altitude/heading/speed hold
├── fighter_weapons.js       Air-to-air/air-to-ground weapons
├── fighter_ai.js            AI adversary tactics
├── spaceplane_orbital.js    Orbital mechanics (elements, Kepler, regimes)
├── spaceplane_planner.js    Maneuver node system
└── spaceplane_hud.js        Planner mode HUD & navball
```

### ECS Scenario Framework
```
visualization/cesium/js/
├── framework/
│   ├── ecs.js               Entity-Component-System core (indexed lookups)
│   ├── constants.js          Shared physics constants
│   ├── registry.js           Component class registry
│   ├── systems.js            AI, Control, Physics, Viz, HUD, UI systems
│   ├── loader.js             Scenario JSON → ECS world builder
│   ├── sensor_system.js      Sensor detection pipeline
│   ├── weapon_system.js      Weapon engagement pipeline
│   ├── event_system.js       Timed/proximity/detection event triggers
│   └── tle_parser.js         TLE catalog parsing + SGP4 propagation
├── components/
│   ├── physics/flight3dof.js       Aircraft 3-DOF integration
│   ├── physics/orbital_2body.js    Keplerian + TLE orbit propagation
│   ├── control/player_input.js     Keyboard flight controls
│   ├── ai/waypoint_patrol.js       Waypoint navigation AI
│   ├── ai/intercept.js             Target pursuit AI
│   ├── sensors/radar.js            Scanning radar with FOV/range/Pd
│   ├── weapons/sam_battery.js      SAM with F2T2EA kill chain
│   ├── visual/cesium_entity.js     Point marker + trail rendering
│   ├── visual/satellite_visual.js  Orbit path + ground track + Ap/Pe
│   ├── visual/ground_station.js    Ground station icon + comm links
│   └── visual/radar_coverage.js    Radar coverage fan visualization
└── builder/
    ├── builder_app.js         Main app controller (BUILD/RUN/ANALYZE)
    ├── scenario_io.js         Save/load/export/validate + CZML model export
    ├── globe_interaction.js   Click/drag/context menu on Cesium globe
    ├── object_palette.js      Entity template definitions + custom platforms
    ├── property_inspector.js  Entity property editing panel
    ├── entity_tree.js         Bottom panel entity list
    ├── satellite_dialog.js    COE input dialog for satellite placement
    ├── timeline_panel.js      Canvas timeline with playhead + events
    ├── analysis_overlay.js    Post-run track/coverage/engagement overlays
    ├── platform_builder.js    Modular platform composer (5-tab dialog)
    └── sensor_view_mode.js    Camera switching for optical sensor view
```

## The "We Crushed It" Scenario

The end goal — all in one continuous simulation:

1. Launch a space shuttle with multi-stage rocket physics
2. Achieve orbit using orbital propagation
3. Rendezvous with a satellite from a TLE catalog
4. Satellite captures synthetic imagery of shuttle
5. Shuttle performs proximity maneuvers around target
6. Re-entry using aerodynamic flight model
7. Navigate atmospheric flight to runway
8. Land and taxi into hangar
9. Full 3D visualization in Cesium

### Milestone Progress
- [x] M0: Project skeleton, build system
- [x] M1: TLE parsing, orbit propagation
- [x] M2: Cesium 3D visualization
- [x] M3: Coordinate transforms, animation, ground tracks
- [x] M4: Launch vehicle physics, rendezvous planning
- [x] M5: GEO rendezvous dynamics, multi-sat tours
- [x] M6: LEO imaging constellation
- [x] M7: Multi-body gravity, aerobraking
- [x] **Interactive**: Fighter sim (F-16 with weapons, AI, full HUD)
- [x] **Interactive**: Spaceplane sim (atmosphere-to-orbit, KSP-style)
- [x] **Interactive**: Domain transitions, thrust vectoring, navball, regime detection
- [x] **Scenario Builder**: ECS framework, drag-and-drop editor, 10+ entity types, radar/SAM/AI components
- [x] **Export**: Dual Sim (live ECS) + Model (CZML rapid playback) export with custom server
- [x] **MC Engine**: C++ headless Monte Carlo (batch + replay), Node.js bridge, Chart.js dashboard
- [x] **Replay Viewer**: Range rings, missile trails, engagement timeline, 11 pre-generated replays
- [x] **Orbital Arena Large**: 1700-entity multi-regime scenario (LEO/GTO/GEO/Lunar)
- [x] **Platform Builder**: Modular entity composer with 5 tabs (Physics/Propulsion/Sensors/Payload/Environment)
- [x] **Nuclear Systems**: Warhead (Starfish Prime EMP), cruise missile, ionosphere/magnetic field interaction
- [x] **Environment Config**: Multi-body gravity (Jupiter), atmospheres, radiation belts
- [x] **Live Sim Cockpit**: Weapons HUD, sensor cycling, pitch trim, chase camera with bank, orbital mechanics fix
- [ ] M8: Runway landing + ground taxi
- [ ] M9: Full scenario integration

## Dependencies

- **C++ backend**: CMake 3.20+, C++17
- **MC bridge server**: Node.js (spawns C++ engine, manages job queue)
- **Interactive sims**: Python3 (HTTP server), modern browser with WebGL
- **CDN libraries**: CesiumJS, Chart.js

## References

- [Kerbal Space Program](https://www.kerbalspaceprogram.com/) — Game-like multi-domain physics
- [STK (Systems Tool Kit)](https://www.agi.com/products/stk) — Professional orbital analysis
- [AFSIM](https://www.afsim.com/) — Multi-domain modeling framework
- [CelesTrak](https://celestrak.org/) — TLE data source
- [CesiumJS](https://cesium.com/cesiumjs/) — 3D globe visualization

---
*Last Updated*: 2026-02-06
*Team*: Human + Claude
*Status*: Live cockpit combat, orbital mechanics fix, platform builder, C++ MC engine, Chart.js dashboard
