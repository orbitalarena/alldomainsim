# All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios — from runway taxi through atmospheric flight to orbital mechanics. KSP meets STK meets AFSIM with Cesium 3D globe visualization.

**Team**: Human + Claude | **Status**: Interactive sims operational

## Quick Start

No build step needed for the interactive sims — just serve and open in a browser:

```bash
cd visualization/cesium
python3 -m http.server 8000
```

Then open: **http://localhost:8000/**

### Featured Sims

| Sim | URL | Description |
|-----|-----|-------------|
| **Spaceplane** | `/spaceplane_viewer.html` | Atmosphere-to-orbit flight. KSP-style orbital mechanics, maneuver nodes, 3 propulsion modes. Start on the runway or in orbit. |
| **Fighter** | `/fighter_sim_viewer.html` | F-16 flight sim with full HUD, weapons (AIM-9/AIM-120/bombs/gun), AI adversaries. |
| **Satellite Tour** | `/sat_tour_viewer.html` | Animated 3D tour of satellite constellations on Cesium globe. |
| **GEO Sim** | `/geo_sim_viewer.html` | GEO rendezvous with Newton-Raphson intercept planner. |
| **Launch Trajectory** | `/launch_viewer.html` | Gravity turn rocket launch with multiple scenario demos. |
| **Orbit Viewer** | `/orbit_viewer.html` | TLE-based orbit visualization with ground tracks. |

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
*Status*: Interactive flight sims operational — Spaceplane with thrust vectoring, domain transitions, and orbital mechanics
