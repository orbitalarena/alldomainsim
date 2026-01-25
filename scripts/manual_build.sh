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

# Compile main
$CXX $CXXFLAGS -c src/main.cpp -o build/obj/main.o

echo "Linking..."

# Link executable
$CXX $CXXFLAGS $LDFLAGS \
    build/obj/state_vector.o \
    build/obj/physics_domain.o \
    build/obj/simulation_engine.o \
    build/obj/entity.o \
    build/obj/main.o \
    -o build/bin/sim_engine

echo "Build complete!"
echo "Executable: build/bin/sim_engine"
