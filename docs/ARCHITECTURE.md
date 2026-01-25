# All-Domain Simulation Architecture

## Overview
This document describes the technical architecture of the All-Domain Simulation Environment, a modular physics simulation framework spanning ground, atmospheric, rocket, and orbital domains.

## Core Principles

### 1. Domain Modularity
Physics models are cleanly separated by domain:
- **Ground**: Surface vehicle dynamics, runway operations
- **Aero**: Atmospheric flight with aerodynamic forces (eventual 6DOF)
- **Rocket**: Multi-stage propulsion systems
- **Orbital**: Multi-body celestial mechanics with perturbations

Domain transitions occur automatically based on altitude and velocity thresholds, allowing seamless handoff between physics regimes.

### 2. Dual Execution Modes
- **Model Mode**: Maximum computational speed for batch analysis and data generation
- **Simulation Mode**: Real-time execution with time scaling for interactive scenarios and human/AI-in-the-loop operations

### 3. Coordinate Frame Consistency
All state vectors carry their coordinate frame metadata:
- **TEME**: Two-Line Element input (satellite catalog)
- **J2000 ECI**: Internal physics calculations
- **ECEF/WGS84**: Visualization and ground-referenced operations
- **Body Frame**: Entity-local attitude and control

Transformation pipeline ensures correct conversions at domain boundaries.

### 4. Generic Entity Architecture
All simulated objects inherit from a common `Entity` base class:
- Spacecraft, satellites, aircraft, ground vehicles share common state representation
- Physics-agnostic state propagation interface
- Pluggable physics models based on current domain

## System Architecture

### Component Hierarchy
```
SimulationEngine
    ├── Entity Management
    │   ├── Entity 1 (e.g., Space Shuttle)
    │   ├── Entity 2 (e.g., Target Satellite)
    │   └── Entity N
    ├── Time Management
    │   ├── Mode (Model/Simulation)
    │   └── Time Scale
    ├── Physics Subsystems
    │   ├── Ground Physics Module
    │   ├── Aero Physics Module
    │   ├── Rocket Physics Module
    │   └── Orbital Physics Module
    ├── Coordinate Transformations
    │   ├── TEME ↔ J2000 ECI
    │   ├── J2000 ECI ↔ ECEF
    │   └── ECEF ↔ Body
    └── I/O Subsystems
        ├── TLE Parser
        ├── State Output (HLA/DIS/JSON)
        └── Visualization Interface (Cesium)
```

## Data Flow

### 1. Initialization Phase
```
User Input → TLE Parser → Classical Orbital Elements → Initial State Vectors
```

### 2. Simulation Loop (Model Mode)
```
1. For each entity:
   a. Determine current physics domain (based on state)
   b. Apply appropriate physics model
   c. Propagate state forward by dt
   d. Check for domain transitions
2. Increment simulation time
3. Output state vectors (optional, at specified intervals)
4. Repeat until end_time
```

### 3. Simulation Loop (Sim Mode)
```
1. Calculate real-time elapsed since last tick
2. Scale by time_scale factor
3. Perform entity updates (same as Model Mode)
4. Push state updates to visualization
5. Check for human/AI input events
6. Sleep briefly to maintain real-time pacing
7. Repeat
```

### 4. Visualization Pipeline
```
Entity States (ECI) → Coordinate Transform (ECI→ECEF) → 
JSON/HLA/DIS Output → Cesium Web Client → 3D Render
```

## State Vector Design

### StateVector Structure
```cpp
struct StateVector {
    Vec3 position;           // [m] in specified frame
    Vec3 velocity;           // [m/s] in specified frame
    Quat attitude;           // Quaternion (w, x, y, z)
    Vec3 angular_velocity;   // [rad/s] body frame
    double time;             // Simulation time [s since epoch]
    CoordinateFrame frame;   // TEME, J2000_ECI, ECEF, BODY
};
```

### Why This Design?
- **Position/Velocity**: Cartesian coordinates simplify multi-body dynamics
- **Attitude**: Quaternions avoid gimbal lock, efficient for rotations
- **Frame Metadata**: Prevents coordinate system errors during handoffs
- **Time**: Enables event synchronization across distributed entities

## Physics Domain Transitions

### Transition Thresholds (Default)
```
Ground ↔ Aero:     10m altitude, 100 m/s velocity
Aero ↔ Orbital:    50,000m altitude
Aero → Rocket:     Velocity > 8,000 m/s (hypersonic)
```

### Transition Logic
```cpp
if (altitude < 10m && velocity < 100 m/s) → GROUND
else if (altitude >= 50,000m) → ORBITAL
else if (velocity > 8,000 m/s) → ROCKET
else → AERO
```

### Handoff Strategy
1. Detect threshold crossing
2. Switch physics module pointer
3. Continue with same StateVector (no interpolation needed initially)
4. (Future) Add hysteresis to prevent rapid switching

## TLE Integration Strategy

### Problem
TLEs use SGP4/SDP4 propagators which have unique perturbation models. We want a unified physics engine.

### Solution
```
TLE → Parse to Keplerian Elements → Convert to Cartesian (pos, vel) → 
Use unified multi-body propagator for all entities
```

### Benefits
- Single physics engine for native entities and TLE-derived entities
- Easier to add higher-fidelity models (J2, J3, solar pressure, drag)
- TLE becomes just an initial condition format, not a propagation method

## Future Extensions

### Phase 1 (Current)
- ✅ Core simulation engine
- ✅ State vector framework
- ✅ Domain transition logic
- ✅ Entity base class
- ⬜ TLE parsing
- ⬜ Basic orbital propagator (Keplerian)
- ⬜ Cesium visualization

### Phase 2
- ⬜ Multi-body dynamics (Moon, Sun perturbations)
- ⬜ J2/J3 Earth gravity harmonics
- ⬜ Atmospheric drag model
- ⬜ Multi-stage rocket physics
- ⬜ Basic aerodynamic model (point-mass)

### Phase 3
- ⬜ 6DOF aerodynamics
- ⬜ Joystick input for interactive flight
- ⬜ Synthetic camera system
- ⬜ Full "crushed it" scenario integration
- ⬜ Checkpoint/resume capability

### Phase 4
- ⬜ Interplanetary trajectories (Mars, asteroids)
- ⬜ N-body mission design
- ⬜ Advanced visualizations (particle effects, atmospheric scattering)
- ⬜ Distributed simulation (multiple processes)

## Performance Considerations

### Model Mode Optimizations
- No real-time constraints: use large time steps when safe
- Batch output writing (buffer states, flush periodically)
- Parallel entity updates (future: thread pool)

### Simulation Mode Optimizations
- Adaptive time stepping based on CPU availability
- Prioritize visualization updates over physics fidelity if falling behind
- Predictive state extrapolation for smooth rendering

## File Organization Rationale

### src/core/
Core simulation engine and fundamental data structures. No physics, just orchestration.

### src/physics/
Physics models organized by domain. Each module is self-contained.

### src/entities/
Entity definitions (Spacecraft, Satellite, Aircraft). Holds parameters but delegates physics.

### src/coordinate/
Frame transformations. Isolated to prevent contamination of physics code.

### src/propagators/
State propagation algorithms (RK4, multi-step methods). Separate from physics forces.

### src/io/
Input (TLE parsing, config files) and output (HLA/DIS/JSON for visualization).

### src/utils/
Math utilities, logging, timing, etc.

## Testing Strategy

### Unit Tests
- Each module tested in isolation
- Mock interfaces for dependencies
- Focus on coordinate transformations, physics edge cases

### Integration Tests
- End-to-end scenario tests (orbit, re-entry, landing)
- Compare against known solutions (Keplerian orbits, ballistic trajectories)

### Validation Tests
- Cross-check with STK, GMAT for orbital scenarios
- Wind tunnel data for aerodynamics (when implemented)

## Build System

### CMake (Preferred)
- Cross-platform
- Dependency management
- Out-of-source builds
- Test integration

### Manual Build (Fallback)
- Direct g++ invocation
- For environments without CMake
- Ensures portability

## Version Control Strategy

### Commit Guidelines
- Checkpoint after each working feature
- Pre-commit hooks prevent large files, broken builds
- Clear commit messages describing what works now

### Branching (Future)
- `main`: Stable, tested code
- `develop`: Integration branch
- Feature branches for major additions

## Questions for Future Design Decisions

1. **Coordinate Frame for Multi-Body**: Use J2000 ECI or solar system barycentric?
2. **Time Representation**: UTC, TAI, or TT for high-precision orbital mechanics?
3. **Atmosphere Model**: US Standard Atmosphere 1976 sufficient, or need NRLMSISE-00?
4. **Aerodynamic Coefficients**: Static tables or real-time CFD lookup?
5. **Distributed Simulation**: HLA/RTI for multi-process, or custom protocol?

---
*Document Version*: 1.0
*Last Updated*: 2026-01-25
*Authors*: Human + Claude
