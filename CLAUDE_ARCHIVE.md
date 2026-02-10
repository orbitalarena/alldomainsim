# CLAUDE.md Archive — Historical Session Details

> Reference material moved from CLAUDE.md to reduce file size. For current project context, see [CLAUDE.md](./CLAUDE.md).

---

## Session History

### Session (2026-02-10): Analytics, Globe Occlusion, TLE Epoch, Smart Search
Six feature additions to the live sim viewer.

- **Data Analytics Panel**: Chart.js graphs in live sim — regime pie chart, team bar chart, population/fuel time-series, custom variable plotting. 6 graph templates (Overview, Regime, Population, Teams, Fuel, Custom). `_analyticsHistory[]` records snapshots at ~1Hz. Auto-refresh every 5 seconds.
- **Globe Occlusion**: Removed `disableDepthTestDistance: Number.POSITIVE_INFINITY` from satellite_visual.js, cesium_entity.js, ground_station.js. Entities behind the globe now naturally hidden by Cesium depth testing.
- **TLE Epoch-Aware Propagation**: `TLEParser.tleEpochToJD()` converts TLE epoch to Julian Date. `orbital_2body.js` `_initFromTLE()` advances mean anomaly from TLE epoch to sim epoch before `tleToECI()`. Uses `world.simEpochJD`.
- **Sim Start Time**: `_JD_SIM_EPOCH_LOCAL` now dynamic — reads `scenario.environment.simStartTime` (ISO string) or defaults to `Date.now()`. EnvironmentDialog has datetime input with "Use Current Time" button.
- **Default Template Removal**: Removed `loadBuiltinScenarios()` calls from live_sim_viewer.html splash. Only saved sims + TLE catalog shown.
- **Smart Search**: F key toggles search panel. Name/regime/inclination/SMA/team filters. Debounced matching. `_searchEntities(criteria)` returns matched IDs. `_highlightSearchResults()` sets gold outline on matched entities. Bulk actions: set team, set color, orbits on/off, labels on/off.

### Session (2026-02-09): Observer Mode, Click-to-Assume, 20 Autonomous Improvements
Massive feature session: observer mode, click-to-assume control, TLE catalog API, sensor footprints, auto-pointing, naval physics, weather system, and many UX improvements.

- **Observer Mode**: `player=__observer__` URL param. Camera cycles free/earth/moon. Entity list clickable (click → track). ECS runs without player hijack.
- **Click-to-Assume Control**: `_setupEntityPicker()` uses Cesium LEFT_CLICK + `scene.pick()` → popup with TRACK/ASSUME CONTROL. `_assumeControl(entity)` hijacks new entity, inits cockpit, recreates orbit viz.
- **TLE Catalog API**: `serve.py` `/api/tle/catalog` returns constellation groups (STARLINK, ONEWEB) + orbit regime groups (LEO/MEO/GEO/HEO). `/api/tle/constellation/{name}` returns TLEs. TLE picker with platform template dropdown. 14,000+ satellites.
- **Auto-Pointing System**: `_tickPointing()` maintains spacecraft attitude. Modes: manual/prograde/retrograde/normal/antinormal/radial/nadir/sun/target. I key cycles, L key opens panel. Active above 80km.
- **Sensor Footprint Component**: `sensor_footprint.js` — radar sector, EO/IR ellipse, SAR swath, SIGINT ring, LIDAR spot. Throttled 2Hz. Auto-added when `_custom.sensors` present.
- **Sensor View Camera**: V key cycles sensors. When visual sensor active + pointing mode, camera looks in pointing direction. CSS filters for EO/IR.
- **Engine Selection Panel**: P key opens/closes categorized dropdown. Digit keys 1-9/0 quick-select. Categories: ATMOSPHERIC/MICRO/LIGHT/MEDIUM/HEAVY. Rocket engine presets: OMS 25kN, AJ10 100kN, RL10 500kN, RS25 5MN.
- **Naval ECS Physics**: `naval.js` wraps `NavalPhysics` module. Object Palette naval templates (`type: 'naval'` with cruise speeds).
- **Weather System**: EnvironmentDialog weather presets. `WeatherSystem.init(viewer, preset)`. Wind deltas applied after physics step.
- **Viz Controls**: `_vizGroups` keyed by type/team/category. Toggle show per group. Global defaults: orbits=OFF, trails=OFF, labels=ON, sensors=ON. Persisted in localStorage.
- **Entity List**: Groups by vizCategory with section headers. Double-click → assume control. Team color indicators.
- **Player Ground Track**: `_playerGroundTrack[]` polyline at alt=0, CYAN 25% opacity.
- **TLE Regime Colors**: LEO=#44ccff, MEO=#44ff88, GEO=#ffcc44, HEO=#ff6688, OTHER=#aa88ff.
- **Remember Last Sim**: `localStorage` stores last-used sim path, shown first in list tagged "LAST USED".
- **Observer Export**: Scenario Builder "Launch Observer" button saves sim + opens in observer mode.
- **Weapon Key Rebind**: Weapon cycling moved from W to R. W is throttle-up only.
- **RCS in Radar**: `radar.js` uses `EWSystem.getRCS()` + `computeDetectionPd()` for range-dependent detection.

### Session (2026-02-07/08): Orbital Mechanics + Maneuver System
Major orbital mechanics improvements for the live sim spaceplane cockpit.

- **Unified Physics Model**: NO `isSpaceplane` flag. ALL entities use inverse-square gravity, centrifugal term, aero blend, Kepler vacuum propagation. Behavior driven by dynamic pressure and altitude.
- **Hohmann Two-Burn**: `_computeHohmann()` stores `_pendingHohmann`. Burn complete handler recalculates from actual post-burn elements. Works for both raising and lowering transfers.
- **Orbital Element Targeting**: Monitor actual SMA/ecc during burn. Monotonic SMA crossing for cutoff — can never be missed at any warp. DV cutoff at 2x as safety.
- **Dynamic Warp During Burns**: `maxWarpForDV = dvRemaining / dvPerFrameAt1x`. Warp drops to 1x at burn start, then ramps up. SMA proximity warp scaling when |curSMA - targetR| < 500km.
- **Auto-Execute Burn Direction**: `_computeBurnOrientation(node)` uses CURRENT ECI state orbital frame, not stale node creation data. Recalculated every frame during long burns.
- **DV-Based Burn Cutoff**: `_autoExecCumulativeDV` tracks delivered thrust per frame. Primary cutoff; time at 2x is safety fallback.
- **High-Warp Substep Fix**: Uncapped substeps (numSteps = ceil(totalDt/0.05)) instead of 500-step cap that lost 76% of physics at 1024x warp.
- **COE Deg/Rad Fix**: `satellite_dialog.js` returns degrees, `globe_interaction.js:_coeToFlightState()` converts to radians.
- **orbital_2body.js Fixes**: Accepts both short (`ecc`/`inc`) and long (`eccentricity`/`inclination`) field names. Fixed ω×r bug. Fixed `||` treating 0 as falsy.
- **Plane Change Escape Guard**: Pure normal DV = 2v·sin(Δi/2). Warns when plane change would exceed escape velocity.

### Session (2026-02-06): DOE System + Analytic Tools + Cockpit Combat
- **DOE System** (`doe_panel.js` + `doe_results.js`): Design of Experiments for Orbital Arena. Role ranges, Cartesian product, heat map, sensitivity, export.
- **Analytic Tools**: 6 standalone HTML pages — ballistic planner, TLE intercept, orbital maneuver, visibility, radar horizon, RF link budget.
- **Live Sim Cockpit**: Weapons HUD (R cycles, Space fires), sensor cycling (V), pitch trim (T), chase camera with bank, per-element HUD toggles.
- **Orbital Mechanics Fix**: Removed ω×r from geodeticToECI (speed already inertial). Fixed SMA oscillation.
- **Escape Trajectory Recovery**: Ecc guard 0.99, period cap 30 days, ESCAPE clears display.

### Session (2026-02-05): Platform Builder + Nuclear + Environment Systems
Major feature: Modular platform composer for creating custom entities with any combination of physics, propulsion, sensors, payloads, and environment settings.

- **Platform Builder** (`platform_builder.js`): 5-tab modal dialog (Physics/Propulsion/Sensors/Payload/Environment)
  - Physics: TLE paste, COE (orbital elements), or Atmospheric flight with 10 aircraft configs
  - Propulsion: Air/Hypersonic/Rocket/Ion/RCS — P key cycles through enabled modes at runtime
  - Sensors: Radar, EO, IR, SAR, SIGINT, LIDAR — S key opens sensor view mode
  - Payloads (multi-select): A2A/A2G missiles, KKV, Jammer, Decoys, Space/Air debris, Cargo deployer
  - Nuclear: Warhead (10kt-50Mt, exoatmospheric EMP), Cruise missile (AGM-86B style)
  - Environment: Multi-body gravity (Earth/Moon/Mars/Jupiter), atmospheres, magnetic field, ionosphere, radiation belts
- **Sensor View Mode** (`sensor_view_mode.js`): Camera switching with B&W filter, noise overlay, HUD for optical sensors
- **Player Input Extended**: P key propulsion cycling, S key sensor view toggle
- **Object Palette Extended**: Custom platform category with localStorage persistence
- **Scenario Builder UI**: "+ Platform" button in toolbar, Custom section in palette

#### Platform Builder Tabs Detail

**Physics Tab:**
- TLE: Paste Two-Line Element for real satellite orbits
- COE: Classical Orbital Elements (SMA, eccentricity, inclination, RAAN, arg perigee, mean anomaly) with live Pe/Ap/Period computation
- Atmospheric: 3-DOF flight with 10 aircraft configs (F-16, F-22, MiG-29, Su-27, F-15, Spaceplane, Bomber, AWACS, Transport, MQ-9)

**Propulsion Tab (P key cycles at runtime):**
- Air-Breathing (turbofan, 90-160 kN with density lapse)
- Hypersonic (scramjet, 800 kN constant, Mach 2-10)
- Rocket (5 MN, works in vacuum)
- Ion/Electric (0.5 N, high Isp, station-keeping)
- RCS Thrusters (attitude control, proximity ops)
- Available for ALL physics types (satellites can have thrusters, spaceplanes can re-enter)

**Sensors Tab (S key opens sensor view):**
- Search Radar: Range, FOV, scan rate, detection probability
- Electro-Optical: FOV, GSD (ground sample distance)
- Infrared/Thermal: FOV, sensitivity levels
- SAR (Synthetic Aperture): Resolution, swath width
- SIGINT/ESM: Passive signal detection range
- LIDAR: 3D mapping range and resolution

**Payload Tab (multi-select):**
- Weapons: A2A missiles (loadout configs), A2G ordnance, Kinetic Kill Vehicle
- Electronic Warfare: Jammer/ECM, Decoys/Chaff/Flares
- Debris/Effects: Space debris (collision trigger), Air debris
- Special: Cargo deployer (cubesats, drones, sensors, decoy sats)
- Nuclear: Warhead (10kt-50Mt, exoatmospheric EMP), Cruise missile (AGM-86B style)

**Environment Tab:**
- Gravity: Earth, Moon, Mars, Jupiter, Venus, or custom mu
- Atmosphere: Earth Standard, Mars, Venus, Titan, or vacuum
- Magnetic Field: Earth dipole, Jupiter (14x), custom intensity — required for EMP effects
- Ionosphere: Standard, Solar Max/Min, disturbance levels (Minor/Major storm, Nuclear EMP Event)
- Radiation Belts: Van Allen, Starfish-Enhanced, Jupiter-level

**Runtime Integration:**
- Custom platforms saved to localStorage + embedded in scenario JSON
- P key cycles through enabled propulsion modes
- S key toggles sensor view (nadir camera, B&W filter, noise overlay, HUD)
- Custom category appears in Object Palette when platforms are created

### Session (2026-01-31): MC Pipeline + Orbital Arena Large
Completed features across C++, Node.js, and browser:

- **C++ Combat Fixes**: SAM target filtering (skips STATIC/ground entities), racetrack AI pattern for player_input entities (4-waypoint 50km×20km loop), maxRange field in replay JSON
- **Progress Reporting Pipeline**: C++ `--progress` flag → JSON-Lines stderr → Node.js job queue → browser polling with real-time progress bars
- **Node.js MC Bridge** (`mc_server.js`): Job queue with async C++ engine spawning, `POST /api/mc/batch` and `/api/mc/replay` return jobId, `GET /api/mc/jobs/:jobId` for polling
- **MC Analysis Dashboard**: Chart.js tabbed visualization (Overview/Weapons/Timeline/Raw Data) with 5 chart types: survival bar, kill histogram, weapon doughnut, kill chain funnel, engagement timeline scatter
- **Replay Viewer Enhancements**: Range rings for SAM/radar ground entities, animated missile trails (cyan=blue, orange=red, glow material), engagement timeline bar with click-to-scrub, rewind cleanup
- **Orbital Arena Large**: 1700-entity (850v850) scenario across 4 orbital regimes — LEO Sun-Synch (100v100, inc=98.2deg, 700km), GTO (200v200, perigee 250km, apogee GEO), GEO (500v500), Lunar orbit (50v50, 200km above Moon)
- **All Replays Regenerated**: 11 replay datasets with updated SAM behavior and maxRange fields

#### MC Pipeline Phases Detail

**Phase 1: C++ Combat Fixes + Replay Enhancement**
- SAM target filtering (`sam_battery.cpp`): Skip targets with `physics_type == STATIC` or `geo_alt < 100m`
- Player AI racetrack (`scenario_parser.cpp`): `player_input` entities get 4-waypoint racetrack pattern (50km x 20km loop)
- maxRange in replay JSON (`replay_writer.cpp`): Entity serialization includes `maxRange` for SAM/radar entities

**Phase 2: Progress Reporting Pipeline (C++ to Node.js to Browser)**
- C++ `--progress` flag: JSON-Lines to stderr
- Node.js job queue (`mc_server.js`): In-memory job store, async spawn, polling endpoint
- Browser polling (`mc_panel.js`, `builder_app.js`): 500ms poll, progress bars, completion

**Phase 3: Replay Viewer Enhancements**
- Range rings for ground entities with maxRange
- Animated missile trails (cyan=blue, orange=red, glow material, max 20 concurrent)
- Engagement timeline bar (canvas with event dots, click to scrub)
- Rewind cleanup

**Phase 4: MC Analysis Dashboard (`mc_analysis.js`)**
- 4 tabs: Overview | Weapons | Timeline | Raw Data
- Lazy tab rendering, chart lifecycle management

**Phase 5: Orbital Arena Large**
- LEO Sun-Synch (100v100): sma=7078km, ecc=0.001, inc=98.2deg
- GTO (200v200): perigee 250km, apogee 35,800km, ecc=0.7285
- GEO (500v500): sma=42,164km, circular equatorial
- Lunar orbit (50v50): Selenocentric 200km alt above Moon

---

## C++ Headless MC Engine — Detailed Architecture

### Overview
The `mc_engine` executable runs Monte Carlo simulations headlessly at native speed, processing scenario JSON from the browser builder and outputting results JSON or replay JSON for Cesium playback.

### Three Modes
1. **Batch MC mode** (`mc_engine --scenario <path> --runs N`): Runs N independent simulations, outputs aggregated results (engagement counts, survival rates, per-run breakdown)
2. **Replay mode** (`mc_engine --replay --scenario <path>`): Single deterministic run sampling ECEF positions at intervals, outputs trajectory JSON for the Cesium replay viewer
3. **Progress mode** (`--progress` flag): Emits JSON-Lines to stderr for real-time progress tracking by Node.js bridge

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

# With progress reporting (used by Node.js bridge)
./bin/mc_engine --progress --replay --scenario <path> --output replay.json
# stderr: {"type":"replay_progress","step":5000,"maxStep":6000,"simTime":500.0}
# stderr: {"type":"done","elapsed":2.35}
```

### Source Files (src/montecarlo/)

**Core:**
| File | Purpose |
|------|---------|
| `mc_entity.hpp` | Flat entity struct: identity, PhysicsType/AIType/WeaponType enums, ECI state, geodetic pos, flight state, aircraft params, waypoint/intercept/radar/SAM/A2A state, engagement log |
| `mc_world.hpp` | Entity container + ScenarioEvent structs (trigger/action) |
| `mc_world.cpp` | add_entity, get_entity by ID (O(1) via unordered_map) |
| `scenario_parser.hpp/cpp` | MCConfig + JSON to MCWorld parser. Handles both IADS (entityA/entityB) and Strike (entityId/targetId) event naming. Auto-assigns waypoint_patrol AI to player_input entities. |
| `mc_runner.hpp/cpp` | Batch MC orchestrator + replay runner. Tick order: AI to Physics to Sensors to Weapons to Events. Multi-domain combat resolution (orbital HVA + atmospheric aircraft). |
| `mc_results.hpp/cpp` | RunResult, EngagementEvent, EntitySurvival, JSON output |
| `mc_engine.cpp` | CLI entry point (--scenario, --replay, --runs, --seed, --max-time, --dt, --sample-interval, --output, --verbose, --progress) |

**Physics:**
| File | Purpose |
|------|---------|
| `kepler_propagator.hpp` | Kepler propagation + init_from_elements (for orbital entities) |
| `flight3dof.hpp/cpp` | 3-DOF atmospheric flight: lift/drag/thrust/gravity to dV/dGamma/dHeading to geodetic position update |
| `atmosphere.hpp` | US Standard Atmosphere 1976 (header-only): 7 layers + thermosphere. `get_atmosphere(alt_m)` to T, P, rho, a |
| `aircraft_configs.hpp` | F-16, MiG-29, AWACS, F-15, Su-27 parameter structs (header-only) |
| `geo_utils.hpp` | Haversine, geodetic to ECEF (WGS84), bearing, destination_point, slant_range, elevation_angle (header-only) |

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
| `sam_battery.hpp/cpp` | F2T2EA kill chain: DETECT(1s) to TRACK(2s) to ENGAGE(TOF) to ASSESS(3s), salvo fire, Pk per missile |
| `a2a_missile.hpp/cpp` | A2A engagement: LOCK(1.5s) to FIRE(TOF) to ASSESS(2s), weapon selection by range, inventory tracking |

**Events & Output:**
| File | Purpose |
|------|---------|
| `event_system.hpp/cpp` | Trigger evaluation (time, proximity, detection) + action execution (message, change_rules, set_state) |
| `replay_writer.hpp/cpp` | Trajectory sampling, ECI to ECEF / geodetic to ECEF, JSON output for Cesium viewer |
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
      "role": null, "deathTime": 162.9, "maxRange": null,
      "positions": [[-2513976,-4630168,3596823], ...] },
    { "id": "sam_alpha", "name": "SA-20", "team": "red", "type": "sam",
      "role": null, "deathTime": null, "maxRange": 200000,
      "positions": [[-2513976,-4630168,3596823], ...] }
  ],
  "events": [
    { "time": 13.2, "type": "LAUNCH", "sourceId": "sam_alpha", "targetId": "eagle_1",
      "sourcePosition": [...], "targetPosition": [...] }
  ],
  "summary": { "blueAlive": 0, "blueTotal": 3, "redAlive": 4, "redTotal": 4,
               "totalKills": 4, "totalLaunches": 8 }
}
```
- `maxRange`: SAM/radar max engagement range in meters (null for entities without weapons/sensors). Used by replay viewer to render range rings.

### Replay Viewer (replay_viewer.html)
Cesium-based 3D playback of replay JSON:
- PointPrimitiveCollection (single draw call for all entities)
- Float64Array per entity for zero-allocation interpolation
- Linear position interpolation between samples
- Kill flash animation (yellow burst, 3s fade)
- Engagement polylines (20s fade)
- Range rings for SAM/radar ground entities (semi-transparent team-color ellipses)
- Animated missile trails on LAUNCH events (cyan=blue, orange=red, glow material, max 20 concurrent)
- Engagement timeline bar above Cesium timeline (canvas with event dots, click to scrub)
- Cesium timeline scrubbing + play/pause/speed control
- Stats panel, scrolling event log, entity list with click-to-track
- Replay file selector dropdown
- Auto-camera detection (orbital vs atmospheric)
- Keyboard: Space=play/pause, +/-=speed, L/T/K=toggle labels/trails/kills, Esc=untrack

### Scenario Compatibility Matrix
| Scenario | Entities | C++ Support | Replay File |
|----------|----------|-------------|-------------|
| test_orbital_arena_small | 10 (GEO sats) | Full (orbital_2body + orbital_combat + kinetic_kill) | replay_data.json |
| test_orbital_arena_100 | 100 (GEO sats) | Full | replay_data.json |
| test_orbital_arena_large | 1700 (4-regime sats) | Full (LEO/GTO/GEO/Lunar) | replay_arena_large.json (51MB) |
| demo_iads_engagement | 10 (aircraft+SAM+sat+ground) | Full (multi-domain) | replay_iads.json |
| template_strike_package | 8 (aircraft+SAM+ground) | Full (multi-domain) | replay_strike.json |
| demo_multi_domain | 9 (sats+aircraft+ground) | Full (multi-domain) | replay_multi_domain.json |
| template_contested_orbit | 7 (sats+ground) | Full (orbital only, ground is static) | replay_contested_orbit.json |
| template_gps_coverage | 10 (GPS sats+ground) | Partial (no combat, just propagation) | replay_gps_coverage.json |
| demo_fighter_patrol | 1 (F-16) | Full (flight3dof, player to auto AI) | replay_fighter_patrol.json |
| demo_two_aircraft | 2 (F-16s) | Full (flight3dof) | replay_two_aircraft.json |
| h.json | 7 (sats+ground) | Full (orbital+static) | replay_h.json |

### Performance
| Scenario | Mode | Time |
|----------|------|------|
| IADS (10 entities, 448s sim) | Replay | 7.8ms |
| Strike (8 entities, 600s sim) | Replay | 7.5ms |
| Orbital Arena Small (10 entities, 600s) | Replay | 13.8ms |
| Orbital Arena Large (1700 entities, 600s) | Replay | 5.3s |
| IADS (10 entities, 300s x 10 runs) | Batch MC | 34.8ms |

---

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
| Perturbation | Magnitude (m/s^2) | Ratio to J2 |
|---|---|---|
| Central body | 8.685 | -- |
| J2 oblateness | 1.25e-2 | 1.0 |
| J3 asymmetry | 2.75e-5 | 0.002 |
| J4 higher-order | 2.06e-5 | 0.002 |
| Moon (3rd body) | 7.1e-7 | 0.00006 |
| Sun (3rd body) | 3.1e-7 | 0.00002 |
| SRP | 2.7e-8 | 0.000002 |

---

## Spaceplane Sim — Technical Details

### Physics Engine (fighter_sim_engine.js)
- **3-DOF point-mass**: dV/dt (speed), dGamma/dt (flight path angle), dPsi/dt (heading)
- **Gravity**: `g = mu/(R+alt)^2` for spaceplane, constant 9.80665 for fighter
- **Centrifugal term**: `V^2/(R_EARTH + alt)` in dGamma — sustains orbit at 7.8 km/s
- **Aero blend**: Log-linear on dynamic pressure (q>100Pa = full aero, q<1Pa = vacuum)
- **Propulsion modes** (P key toggle):
  - AIR: 160kN with density lapse (atmosphere only)
  - HYPERSONIC: 800kN flat (anywhere)
  - ROCKET: 5 MN flat (anywhere)
- **Thrust decomposition by nose direction**:
  - Prograde component: `T*cos(alpha)*cos(yawOffset)` changes speed
  - Normal component: `T*sin(alpha)` changes flight path angle (orbit raise/lower)
  - Lateral component: `T*cos(alpha)*sin(yawOffset)` changes heading (plane change)
  - Point at prograde/retrograde/normal/radial and throttle to apply delta-V
- **Vacuum rotation**: All clamps/damping removed when aeroBlend < 0.5
  - Roll: free 360 deg everywhere for spaceplane (F-16 keeps +/-80 deg clamp)
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
MU_EARTH = 3.986004418e14   // m^3/s^2
R_EARTH  = 6371000           // m
OMEGA_EARTH = 7.2921159e-5   // rad/s
SPACEPLANE mass = 15,000 kg, fuel = Infinity
```

### Orbital Mechanics (spaceplane_orbital.js)
- **geodeticToECI()**: lat/lon/alt + speed/heading/gamma to ECI state (non-rotating frame — speed is already inertial)
- **computeOrbitalElements()**: Classical elements from r,v vectors. Guards against NaN.
- **predictOrbitPath()**: 360-point Kepler propagation. Draws suborbital arcs (periapsis threshold: R_EARTH * 0.05). Activates when apoapsisAlt > 30km. NaN-filtered Cartesian3 output.
- **detectFlightRegime()**: ATMOSPHERIC / SUBORBITAL / ORBIT / ESCAPE. Physical altitude fallback. Handles parabolic trajectories.
- Update interval: every 15 frames (performance optimization)

### Cockpit HUD (fighter_hud.js)
Above 30km, KSP-style orbital markers appear on the pitch ladder:
- Prograde (green), Retrograde (red), Normal (purple), Anti-normal, Radial-out (cyan), Radial-in
- Computed from ECI velocity/position to ENU to bearing/elevation to pitch ladder coords
- Requires `simTime` passed as 5th arg to `FighterHUD.render()`

**Compact navball** at bottom-center (above 30km):
- Horizon line, dynamic prograde/retrograde/normal/radial markers from ECI state
- All bearing calculations use nose heading (`heading + yawOffset`)

**Flight regime indicator** at top-right:
- Color-coded: green=ATMOSPHERIC, yellow=SUBORBITAL, cyan=ORBIT, red=ESCAPE

### Start Modes
1. Airborne (5km, 200 m/s)
2. Runway (Edwards AFB)
3. Suborbital (80km, Mach 10, 35 deg gamma)
4. Orbital (400km, 7700 m/s, circular)

---

## Fighter Sim — Technical Details

Same physics engine with F-16 config:
- Realistic F-16 aero (wing area, Cl/Cd curves, Oswald efficiency)
- AB thrust 130kN, TSFC modeled, 3200kg fuel
- Weapons: AIM-9, AIM-120, bombs, gun with ballistic prediction
- AI adversaries with basic tactics
- Full HUD: pitch ladder, speed/alt tapes, heading, G meter, warnings

---

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
