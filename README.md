# All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios — from runway taxi through atmospheric flight to orbital mechanics. KSP meets STK meets AFSIM with Cesium 3D globe visualization.

**Team**: Human + Claude | **Status**: Scenario Builder + Interactive sims operational

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
| **Scenario Builder** | `/scenario_builder.html` | Interactive drag-and-drop scenario editor. Place aircraft, satellites, SAM batteries, ground stations on the globe. Configure orbital elements, radar, AI patrol routes. Run simulation, analyze results, export. |
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

### Export Modes
- **Export Sim** — Writes scenario JSON to `scenarios/`, opens in the Scenario Viewer with live ECS physics
- **Export Model** — Runs sim headlessly at max speed, records all positions, exports CZML for native Cesium playback with zero JS overhead

### Scenario Templates
| Template | Description |
|----------|-------------|
| Multi-Domain Awareness | LEO/MEO/GEO satellites + aircraft + ground stations |
| IADS Engagement | Blue strike package vs red SAM network with AI patrol |
| GPS Coverage Analysis | 6 GPS satellites, 3 receivers, DOP analysis |
| Contested Orbit | SSA scenario with co-orbital threats and GEO inspector |
| Strike Package | F-16 flight vs SA-20 IADS in theater |

## Spaceplane Sim

Fly from the runway to orbit and back. Full 3-DOF flight physics with smooth atmosphere-to-vacuum transition.

### Controls
```
W/S or Up/Down    Throttle
A/D or Left/Right Roll (bank)
Pitch             Up/Down arrows
Q/E               Yaw (repoints nose in vacuum, does not change orbit)
P                 Cycle propulsion: AIR → HYPERSONIC → ROCKET
Space             Pause
E                 Engine on/off
M                 Toggle orbital planner mode
N                 Create maneuver node
Enter             Execute maneuver node
+/-               Time warp (up to 1024x)
C                 Cycle camera
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
- Three propulsion modes: AIR (160kN turbofan), HYPERSONIC (400kN), ROCKET (2 MN)
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

## C++ Backend

For offline orbit computation and data generation:

```bash
# Build
cd build && cmake .. && make -j$(nproc)

# Generate TLE orbit data
./build/bin/demo data/tles/satcat.txt

# Run rendezvous scenario
./build/bin/rendezvous_demo
```

### C++ Architecture
```
src/
├── core/          Simulation engine, state vectors
├── physics/       Gravity (J2), orbital elements, atmosphere,
│                  Hohmann/Lambert transfers, CW equations
├── entities/      Satellite (TLE), launch vehicle (multi-stage)
├── coordinate/    ECI/ECEF/Geodetic transforms, GMST
├── propagators/   RK4 integrator
└── io/            TLE parser
```

### JavaScript Sim Modules
```
visualization/cesium/js/
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
    ├── object_palette.js      Entity template definitions
    ├── property_inspector.js  Entity property editing panel
    ├── entity_tree.js         Bottom panel entity list
    ├── satellite_dialog.js    COE input dialog for satellite placement
    ├── timeline_panel.js      Canvas timeline with playhead + events
    └── analysis_overlay.js    Post-run track/coverage/engagement overlays
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
- [ ] M8: Runway landing + ground taxi
- [ ] M9: Full scenario integration

## Dependencies

- **C++ backend**: CMake 3.20+, C++17
- **Interactive sims**: Python3 (HTTP server), modern browser with WebGL
- **No npm/node** — Cesium loaded from CDN

## References

- [Kerbal Space Program](https://www.kerbalspaceprogram.com/) — Game-like multi-domain physics
- [STK (Systems Tool Kit)](https://www.agi.com/products/stk) — Professional orbital analysis
- [AFSIM](https://www.afsim.com/) — Multi-domain modeling framework
- [CelesTrak](https://celestrak.org/) — TLE data source
- [CesiumJS](https://cesium.com/cesiumjs/) — 3D globe visualization

---
*Last Updated*: 2026-01-30
*Team*: Human + Claude
*Status*: Scenario Builder with ECS framework, dual export (Sim + Model), COE satellite placement, and interactive flight sims
