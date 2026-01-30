# Claude Code Project Context

## Project: All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios from ground operations through orbital mechanics. Think KSP meets STK meets AFSIM with Cesium 3D visualization.

## Current Status: Interactive Sims Operational

### C++ Backend (Milestones 0-4):
- **M0**: Project skeleton, CMake build system, Git setup
- **M1**: TLE parsing, single orbit propagation
- **M2**: Cesium 3D visualization of orbits
- **M3**: Coordinate transformations (ECI/ECEF/Geodetic), animation, ground tracks
- **M4**: Launch vehicle physics, orbital elements, rendezvous planning

### JavaScript Interactive Sims (visualization/cesium/):
These are standalone browser-based simulations — no C++ backend needed.

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
core/           - SimulationEngine, StateVector, PhysicsDomain
physics/        - GravityModel (J2), OrbitalElements, AtmosphereModel,
                  ManeuverPlanner (Hohmann/Lambert), ProximityOps (CW equations)
entities/       - Entity base, Satellite (from TLE), LaunchVehicle (multi-stage)
coordinate/     - TimeUtils (JD/GMST), FrameTransformer (ECI/ECEF/Geodetic)
propagators/    - RK4Integrator
io/             - TLEParser
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

### Executables:
- `demo` — TLE catalog visualization (generates orbit_data.json)
- `rendezvous_demo` — Launch from Cape Canaveral, orbit insertion, transfer

### Visualization HTML pages:
All served from `visualization/cesium/` via `python3 -m http.server 8000`

## Build & Run

### C++ Backend
```bash
cd build && cmake .. && make -j$(nproc)
./build/bin/demo data/tles/satcat.txt
./build/bin/rendezvous_demo
```

### Interactive Sims (no build needed)
```bash
cd visualization/cesium
python3 -m http.server 8000
# Then open in browser:
# http://localhost:8000/spaceplane_viewer.html    — Spaceplane sim
# http://localhost:8000/fighter_sim_viewer.html    — Fighter sim
# http://localhost:8000/orbit_viewer.html          — Orbit viz
# http://localhost:8000/                           — Directory listing
```

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
- **Keep the HTTP server running**: `cd visualization/cesium && python3 -m http.server 8000`
  The user tests changes by refreshing the browser (Ctrl+F5 for hard refresh).

## Git Conventions
- Commit messages: imperative mood, describe what changes do
- Co-author: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`
