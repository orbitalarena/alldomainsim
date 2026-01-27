#!/bin/bash
# Manual build script (CMake alternative when dependencies unavailable)

set -e

echo "=== Manual Build (No CMake) ==="

# Create output directories
mkdir -p build/obj
mkdir -p build/bin

# Compiler settings
CXX="g++"
CXXFLAGS="-std=c++17 -O3 -Wall -Wextra -I./src"
LDFLAGS=""

echo "Compiling source files..."

# Compile core
$CXX $CXXFLAGS -c src/core/state_vector.cpp -o build/obj/state_vector.o
$CXX $CXXFLAGS -c src/core/physics_domain.cpp -o build/obj/physics_domain.o
$CXX $CXXFLAGS -c src/core/simulation_engine.cpp -o build/obj/simulation_engine.o

# Compile entities
$CXX $CXXFLAGS -c src/entities/entity.cpp -o build/obj/entity.o
$CXX $CXXFLAGS -c src/entities/satellite.cpp -o build/obj/satellite.o

# Compile io
$CXX $CXXFLAGS -c src/io/tle_parser.cpp -o build/obj/tle_parser.o

# Compile physics
$CXX $CXXFLAGS -c src/physics/gravity_model.cpp -o build/obj/gravity_model.o

# Compile propagators
$CXX $CXXFLAGS -c src/propagators/rk4_integrator.cpp -o build/obj/rk4_integrator.o

# Compile main
$CXX $CXXFLAGS -c src/main.cpp -o build/obj/main.o

# Compile demo
$CXX $CXXFLAGS -c src/demo.cpp -o build/obj/demo.o

# Compile comparison
$CXX $CXXFLAGS -c src/comparison.cpp -o build/obj/comparison.o

echo "Linking executables..."

# Link sim_engine executable
$CXX $CXXFLAGS $LDFLAGS \
    build/obj/state_vector.o \
    build/obj/physics_domain.o \
    build/obj/simulation_engine.o \
    build/obj/entity.o \
    build/obj/satellite.o \
    build/obj/tle_parser.o \
    build/obj/gravity_model.o \
    build/obj/rk4_integrator.o \
    build/obj/main.o \
    -o build/bin/sim_engine

# Link demo executable
$CXX $CXXFLAGS $LDFLAGS \
    build/obj/state_vector.o \
    build/obj/physics_domain.o \
    build/obj/simulation_engine.o \
    build/obj/entity.o \
    build/obj/satellite.o \
    build/obj/tle_parser.o \
    build/obj/gravity_model.o \
    build/obj/rk4_integrator.o \
    build/obj/demo.o \
    -o build/bin/demo

# Link comparison executable
$CXX $CXXFLAGS $LDFLAGS \
    build/obj/state_vector.o \
    build/obj/physics_domain.o \
    build/obj/simulation_engine.o \
    build/obj/entity.o \
    build/obj/satellite.o \
    build/obj/tle_parser.o \
    build/obj/gravity_model.o \
    build/obj/rk4_integrator.o \
    build/obj/comparison.o \
    -o build/bin/comparison

echo "Build complete!"
echo "Executables:"
echo "  - build/bin/sim_engine"
echo "  - build/bin/demo"
echo "  - build/bin/comparison"
