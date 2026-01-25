# Design Conversation Summary

## Project Inception: 2026-01-25

This document captures the key decisions made during the initial design conversation between Human and Claude.

## Vision Statement
Create an all-domain simulation environment that seamlessly models ground, atmospheric, rocket, and orbital dynamics with 3D visualization - capable of executing the "crushed it" scenario: launching a shuttle, achieving orbit, rendezvousing with a satellite, capturing synthetic imagery, re-entering, landing, and taxiing to a hangar.

## Key Design Decisions

### 1. Execution Modes
**Decision**: Implement two distinct modes
- **Model Mode**: Run at maximum computational speed for data generation
- **Simulation Mode**: Real-time (or time-scaled) for human/AI in-the-loop

**Rationale**: Different use cases require different performance characteristics. Batch analysis needs speed; interactive training needs real-time.

### 2. Architecture Style
**Decision**: Modular physics domains with automatic transitions
**Rationale**: Clean separation of concerns. Rocket physics shouldn't know about taxi dynamics. Altitude-based switching (e.g., 50km threshold) provides simple, robust handoffs.

### 3. Coordinate Frame Strategy
**Decision**: Build transformation pipeline from the start
- TEME for TLE input
- J2000 ECI for physics
- ECEF for visualization
**Rationale**: Coordinate bugs are insidious. Better to handle correctly from day one than retrofit later.

### 4. TLE Handling
**Decision**: Convert TLE → Classical Elements → Unified Physics Engine
**Rationale**: Don't want dual propagation systems (SGP4 for TLEs, custom for native entities). Single multi-body propagator for all. TLE is just an initial condition format.

### 5. Visualization Approach
**Decision**: Start with CesiumJS (web), migrate to mature 3D engine if needed
**Rationale**: Fastest path to 3D visualization. Web-based means easy access. Can port later if performance demands it.

### 6. Synthetic Camera
**Decision**: Dual Cesium instances, camera-manipulated, post-processed
**Rationale**: Fake it before you make it. Easier than building a real raytracer. Good enough for initial validation.

### 7. Physics Fidelity Targets
- **Orbital**: Multi-body + J-effects + full force model (eventually)
- **Aero**: 6DOF with joystick control (eventually)
- **Data**: Lookup tables acceptable for first iterations

**Rationale**: Start simple, add fidelity incrementally. Baby steps prevent scope creep.

### 8. Development Environment
**Decision**: Linux-only, CMake/Ninja, open-source libraries
**Rationale**: Clean development environment. No Windows/Mac complexity initially. Can port later if needed.

### 9. Build Delivery Method
**Decision**: Copy-paste terminal commands (cat/heredoc)
**Rationale**: Human requested this to ensure reproducibility and eliminate manual file editing errors.

### 10. State Transitions
**Decision**: Altitude-based thresholds with acceptance for non-smooth handoffs initially
**Rationale**: Perfect is the enemy of good. Get it working first, optimize later. ~50km is physically meaningful (atmosphere effectively gone).

## Technical Constraints Acknowledged

### Network Limitation
- Network is disabled in development environment
- Cannot use automated package managers
- Pre-installed tools only (g++, standard libraries)
- Implemented manual build as fallback

### Initial Simplifications
- Using simple Vec3/Quat instead of Eigen temporarily
- No unit tests yet (infrastructure in place)
- Placeholder CMakeLists for unimplemented modules

## Repository Structure Decisions

### Why This Layout?
```
src/
  core/       - Engine orchestration (no physics)
  physics/    - Domain-specific models
  entities/   - Object definitions (spacecraft, aircraft, etc.)
  coordinate/ - Frame transformations (isolated)
  propagators/- Integration algorithms
  io/         - TLE parsing, HLA/DIS/JSON output
  utils/      - Math helpers, logging
```

**Rationale**: Clear boundaries prevent tangled dependencies. Easy to test in isolation.

### Git Hooks
Pre-commit hook checks for:
- Large files (>5MB)
- TODO/FIXME warnings
- CMakeLists.txt changes

**Rationale**: Prevent accidental commits of large data files. Remind developers to test build changes.

## Milestone Strategy

### Approach
Baby-step validation: each milestone must be testable end-to-end before moving forward.

### First Milestone (Completed)
✅ Project skeleton
✅ Core simulation engine
✅ State vector framework
✅ Domain transition logic
✅ Entity base class
✅ Build system (CMake + manual fallback)
✅ Git repository with hooks
✅ Documentation (README, QUICKSTART, ARCHITECTURE)

### Next Milestone (Planned)
⬜ TLE parsing
⬜ Keplerian orbit propagation
⬜ Single satellite visualization in Cesium
⬜ Verify Model/Sim mode switching works

### Guiding Principle
"Build generic physics that scales, not scenario-specific code that breaks when we add new features."

## Questions We Deliberately Left Open
1. Exact atmosphere model (US Std 1976 vs NRLMSISE-00)
2. Time representation (UTC vs TAI vs TT)
3. Multi-body coordinate center (ECI vs barycentric)
4. CFD vs lookup tables for aero
5. HLA/RTI for distributed sim

**Rationale**: Don't need to decide yet. Will become clear as we build.

## Human's Stated Success Criteria (The "Crushed It" Scenario)
1. Launch shuttle with multi-stage rocket
2. Achieve orbit
3. Rendezvous with TLE-catalog satellite
4. Satellite captures synthetic image of shuttle
5. Shuttle performs rendezvous maneuvers
6. Re-entry with aero model
7. Runway landing
8. Taxi to hangar
9. Full 3D visualization throughout

**Status**: Framework now supports all these conceptually. Implementation in progress.

## Team Dynamics
- Team size: 2 (Human + Claude)
- Human has domain expertise and vision
- Claude implements technical details
- Collaborative decision-making
- Emphasis on reproducibility (copy-paste builds)

## References Cited
- KSP (Kerbal Space Program): Multi-domain physics inspiration
- STK (Systems Tool Kit): Professional orbital analysis
- AFSIM (Advanced Framework for Simulation): Multi-domain modeling
- CelesTrak: TLE data source
- SGP4: TLE propagation standard

## Key Quotes

**Human**: "I just want to avoid creating physics that only work for a single scenario, and then as soon as we add one new feature we break those old features and basically rebuild from scratch."

**Resolution**: Modular architecture with domain-agnostic state vectors and pluggable physics modules.

---

**Human**: "Like KSP, STK, or AFSIM. And then we visualize it all."

**Resolution**: Aiming for best-of-breed: KSP's multi-domain feel, STK's orbital fidelity, AFSIM's scenario flexibility.

---

**Human**: "We'll know we crushed it when we can Launch a space shuttle..."

**Resolution**: Clear, testable success criteria. Not a fuzzy goal.

---

## Next Session Prep

When we resume, we should:
1. Implement TLE parser (read satcat.txt)
2. Build Keplerian propagator
3. Create basic Cesium visualization
4. Test Model Mode vs Sim Mode performance
5. Visualize first orbit

## Document Maintenance
This document should be updated whenever major architectural decisions are made. It serves as the "source of truth" for why things are the way they are.

---
*Created*: 2026-01-25
*Team*: Human + Claude
*Status*: Living Document
