# All-Domain Simulation Environment

## Project Vision
An integrated Earth-Air-Space simulation environment capable of modeling multi-domain scenarios from ground operations through atmospheric flight to orbital mechanics and beyond. Think KSP meets STK meets AFSIM with full 3D visualization.

## Success Criteria (The "We Crushed It" Scenario)
1. Launch a space shuttle with multi-stage rocket physics
2. Achieve orbit using orbital propagation
3. Rendezvous with a satellite from a TLE catalog (thousands of objects)
4. Satellite captures synthetic imagery of shuttle's .obj model
5. Shuttle performs rendezvous maneuvers around target satellite
6. Re-entry using aerodynamic flight model
7. Navigate atmospheric flight to runway landing
8. Taxi into hangar using ground physics
9. Full 3D visualization in Cesium

## Architecture Overview

### Execution Modes
- **Model Mode**: Maximum speed computation for data generation/analysis
- **Simulation Mode**: Real-time (or scaled time) execution with human/AI in-the-loop capability

### Physics Domains (Modular)
1. **Ground Physics**: Taxi, runway operations
2. **Aerodynamics**: 6DOF atmospheric flight (eventual joystick control)
3. **Rocket Physics**: Multi-stage launch vehicles
4. **Orbital Mechanics**: Multi-body dynamics with J-effects, full force model
5. **Domain Transitions**: Altitude-based switching (~50km threshold for aero/orbital)

### Coordinate Frames
- **TEME**: Two-Line Element propagation
- **J2000 ECI**: Multi-body dynamics
- **ECEF/WGS84**: Cesium visualization
- **Transformation Pipeline**: Built-in conversions between all frames

### Visualization
- **Phase 1**: CesiumJS (web-based)
- **Phase 2**: Migration to mature 3D engine (Unity/Unreal) if needed
- **Synthetic Imagery**: Dual Cesium instances for camera simulation with B&W filters and noise

### Data Flow
- C++ engine outputs state vectors (ECI positions/velocities)
- Communication via HLA/DIS/JSON protocol
- Cesium polls or receives pushed updates each sim-tick

### External Data
- TLE catalog from CelesTrak (satcat.txt, user-provided)
- TLE → Classical Orbital Elements conversion for unified physics engine
- .obj models for 3D entities

## Technology Stack

### Core Language
- C++ (primary simulation engine)

### Build System
- CMake with Ninja generator
- Linux-only development environment

### Dependencies (Open Source)
- SGP4: TLE propagation
- Eigen: Linear algebra
- Additional libraries TBD as needed

### Version Control
- Git with automated hooks
- Checkpoint commits for each milestone
- CMakeLists.txt tracked in repository

## Development Philosophy

### Incremental Validation
- Baby-step approach: validate each subsystem independently
- First milestone: Single TLE orbit propagation → Cesium visualization
- Avoid scenario-specific code; build generic physics that scales

### Code Delivery
- Each build step is copy-paste terminal commands
- Use `cat` or heredoc for file creation/patching
- No manual file editing required

### Team
- Just us two: Human + Claude

## Design Decisions Log

### Q: Real-time vs Batch?
**A**: Both. Model Mode for fast computation, Sim Mode for interactive scenarios.

### Q: Monolithic vs Modular?
**A**: Modular physics domains that activate based on flight regime.

### Q: Cesium Integration?
**A**: CesiumJS initially, with C++ pushing ECI state via HLA/DIS/JSON.

### Q: Orbital Mechanics Fidelity?
**A**: Full multi-body with J-effects. Goal: Moon landings, Mars missions, asteroid inspections.

### Q: Aerodynamics Fidelity?
**A**: 6DOF eventual target with joystick support. Lookup tables acceptable.

### Q: TLE Handling?
**A**: Convert TLE → classical elements, use unified physics engine (not SGP4 directly in sim).

### Q: Synthetic Camera?
**A**: Dual Cesium instances, one camera-manipulated for satellite POV, post-process with B&W + noise.

### Q: State Transitions?
**A**: Altitude-based thresholds (e.g., 50km for aero/orbital boundary). Smooth handoffs preferred but not critical for v1.

### Q: Coordinate Frames Strategy?
**A**: Build transformation pipeline from start. TEME for TLE input, J2000 for physics, ECEF for visualization.

## Project Structure
```
all-domain-sim/
├── README.md                 # This file
├── docs/                     # Design documents, API specs
├── src/
│   ├── core/                 # Main simulation engine
│   ├── physics/              # Physics modules (rocket, orbital, aero, ground)
│   ├── entities/             # Spacecraft, satellites, aircraft definitions
│   ├── coordinate/           # Frame transformations (TEME, ECI, ECEF)
│   ├── propagators/          # State propagators (SGP4, multi-body)
│   ├── io/                   # TLE parsing, HLA/DIS/JSON output
│   └── utils/                # Common utilities
├── visualization/
│   └── cesium/               # Cesium web client
├── data/
│   ├── tles/                 # TLE catalog files
│   ├── models/               # .obj 3D models
│   └── config/               # Simulation configurations
├── tests/                    # Unit and integration tests
├── scripts/                  # Build and deployment scripts
└── CMakeLists.txt            # Root build configuration
```

## Getting Started
(To be populated with build instructions)

## Milestones
- [x] Milestone 0: Project skeleton, build system, Git setup
- [x] Milestone 1: TLE parsing + single orbit propagation
- [x] Milestone 2: Cesium visualization of propagated orbit (including RK4/J2)
- [x] Milestone 3: Mode switching (Model/Sim) with time control
- [x] Milestone 4: Multi-entity simulation (shuttle + satellite from TLE)
- [x] Milestone 5: Basic rendezvous dynamics (GEO & multi-sat tours)
- [x] Milestone 6: Synthetic camera implementation (LEO imaging constellation)
- [x] Milestone 7: Atmospheric re-entry physics (multi-body gravity, aerobraking)
- [ ] Milestone 8: Runway landing + ground taxi
- [ ] Milestone 9: Full "crushed it" scenario integration

## References
- KSP (Kerbal Space Program): Game-like multi-domain physics
- STK (Systems Tool Kit): Professional orbital analysis
- AFSIM (Advanced Framework for Simulation): Multi-domain modeling
- CelesTrak: TLE data source
- SGP4: Simplified perturbations model for TLE propagation

---
*Last Updated*: 2026-01-26
*Team*: Human + Claude
*Status*: Milestone 7 Complete - Multi-body physics & aerobraking
