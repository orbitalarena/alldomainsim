# Claude Code Project Context

## Project: All-Domain Simulation Environment

An integrated Earth-Air-Space simulation for multi-domain scenarios from ground operations through orbital mechanics. Think KSP meets STK meets AFSIM with Cesium 3D visualization.

## Current Status: Milestone 4 Complete

### Completed Milestones:
- **M0**: Project skeleton, CMake build system, Git setup
- **M1**: TLE parsing, single orbit propagation
- **M2**: Cesium 3D visualization of orbits
- **M3**: Coordinate transformations (ECI/ECEF/Geodetic), animation, ground tracks
- **M4**: Launch vehicle physics, orbital elements, rendezvous planning

### Remaining Milestones:
- **M5**: Basic rendezvous dynamics (refine proximity ops)
- **M6**: Synthetic camera implementation
- **M7**: Atmospheric re-entry physics
- **M8**: Runway landing + ground taxi
- **M9**: Full "crushed it" scenario integration

## Architecture

### Core Components (src/):
```
core/           - SimulationEngine, StateVector, PhysicsDomain
physics/        - GravityModel (J2), OrbitalElements, AtmosphereModel,
                  ManeuverPlanner (Hohmann/Lambert), ProximityOps (CW equations)
entities/       - Entity base, Satellite (from TLE), LaunchVehicle (multi-stage)
coordinate/     - TimeUtils (JD/GMST), FrameTransformer (ECI/ECEF/Geodetic)
propagators/    - RK4Integrator
io/             - TLEParser
```

### Executables:
- `demo` - TLE catalog visualization (all satellites, 24hr)
- `rendezvous_demo` - Launch from Cape Canaveral, orbit insertion, transfer to target

### Visualization:
- `visualization/cesium/orbit_viewer.html` - Cesium viewer with animation, ground tracks
- Uses built-in NaturalEarthII imagery (no Ion token required)
- Reads `orbit_data.json` from project root

## Build Commands
```bash
cd build && cmake .. && make -j$(nproc)
```

## Run Commands
```bash
# TLE orbit visualization (generates orbit_data.json)
./build/bin/demo data/tles/satcat.txt

# Rendezvous scenario (generates rendezvous_data.json)
./build/bin/rendezvous_demo
cp rendezvous_data.json orbit_data.json

# Visualization server
python3 -m http.server 8000
# Open: http://localhost:8000/visualization/cesium/orbit_viewer.html
```

## Key Technical Details

### Coordinate Frames:
- J2000_ECI: Primary physics frame
- ECEF: Earth-fixed (via GMST rotation)
- Geodetic: WGS84 lat/lon/alt for ground tracks

### Launch Vehicle Physics:
- Multi-stage with thrust, Isp (sea level & vacuum), mass flow
- Gravity turn: gradual pitch based on altitude (0-80km)
- Automatic orbit insertion detection (periapsis > 100km, e < 0.5)
- Located at Cape Canaveral (28.5623°N, 80.5774°W)

### Orbital Mechanics:
- Classical elements <-> ECI state conversion
- Kepler's equation solver (Newton-Raphson)
- Hohmann transfer calculator
- Lambert solver for general transfers
- CW/Hill equations for relative motion

### Current Rocket Config (rendezvous_demo):
- Stage 1: 5 MN thrust, 300t propellant, Isp 290/320s
- Stage 2: 500 kN thrust, 30t propellant, Isp 320/360s
- Payload: 5t
- Achieves ~140x320 km orbit (needs tuning for 400km circular)

## Known Issues to Address

1. **Orbit insertion altitude**: Currently 140x320 km, should target 400 km circular
2. **Proximity ops NaN**: LVLH transform has edge case when vehicles overlap
3. **Data density**: Recording interval too sparse for smooth viz
4. **Maneuver execution**: Burns happen but range doesn't converge perfectly

## JSON Output Format
```json
{
  "metadata": {
    "epoch_jd": 2460335.0,
    "epoch_iso": "2024-01-25T12:00:00Z",
    "time_step": 10.0,
    "duration": 600.0
  },
  "satellites": [{
    "name": "...",
    "id": 0,
    "positions": [{
      "time": 10,
      "eci": {"x": ..., "y": ..., "z": ...},
      "geo": {"lat": ..., "lon": ..., "alt": ...}
    }]
  }]
}
```

## Dependencies
- CMake 3.20+
- C++17
- Eigen3 (optional, for future use)
- Python3 (for HTTP server)
- Modern browser with WebGL (for Cesium)

## Git Conventions
- Commit messages: imperative mood, describe what changes do
- Co-author: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`
- Milestone commits summarize all changes in that milestone
