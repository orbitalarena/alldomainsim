# Quick Start Guide

## Installation & Build

### 1. Install Dependencies
```bash
cd /home/claude/all-domain-sim
./scripts/setup_dependencies.sh
```

This installs:
- CMake (build system)
- Ninja (fast build tool)
- GCC (C++ compiler)
- Eigen3 (linear algebra library)

### 2. Build the Project
```bash
./scripts/build.sh
```

This will:
- Create a `build/` directory
- Configure CMake with Ninja generator
- Compile all source files
- Generate the `sim_engine` executable

### 3. Run the Simulation
```bash
./build/bin/sim_engine
```

## Project Structure Quick Reference

```
all-domain-sim/
├── src/
│   ├── core/              # Simulation engine, state vectors, modes
│   ├── physics/           # Physics models (rocket, orbital, aero, ground)
│   ├── entities/          # Entity base class and implementations
│   ├── coordinate/        # Coordinate frame transformations
│   ├── propagators/       # State propagators (SGP4, multi-body)
│   ├── io/                # I/O (TLE parsing, HLA/DIS/JSON output)
│   └── utils/             # Utilities
├── visualization/cesium/  # Cesium web visualization
├── data/                  # TLE files, 3D models, configs
├── tests/                 # Unit tests
└── scripts/               # Build and utility scripts
```

## Development Workflow

### Making Changes
1. Edit source files
2. Run `./scripts/build.sh` to rebuild
3. Test with `./build/bin/sim_engine`

### Git Workflow
```bash
# Stage changes
git add <files>

# Commit (pre-commit hook will run automatically)
git commit -m "Description of changes"
```

### Adding New Modules
1. Create header (.hpp) and implementation (.cpp) files
2. Add to appropriate CMakeLists.txt
3. Rebuild

## Next Steps

See README.md for:
- Architecture details
- Design decisions
- Milestone roadmap
- Full documentation

## Copy-Paste Commands

### Full Fresh Build
```bash
cd /home/claude/all-domain-sim
./scripts/setup_dependencies.sh
./scripts/build.sh
./build/bin/sim_engine
```

### Rebuild After Changes
```bash
cd /home/claude/all-domain-sim
./scripts/build.sh
./build/bin/sim_engine
```

### Clean Build
```bash
cd /home/claude/all-domain-sim
rm -rf build/
./scripts/build.sh
```
