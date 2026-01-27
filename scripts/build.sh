#!/bin/bash
# Build script for All-Domain Simulation Environment

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== All-Domain Simulation Environment Build ===${NC}"

# Check for required dependencies
echo "Checking dependencies..."

if ! command -v cmake &> /dev/null; then
    echo -e "${RED}ERROR: cmake not found${NC}"
    exit 1
fi

if ! command -v ninja &> /dev/null; then
    echo -e "${YELLOW}WARNING: ninja not found, using make instead${NC}"
    GENERATOR="Unix Makefiles"
else
    GENERATOR="Ninja"
fi

# Create build directory
BUILD_DIR="build"
if [ -d "$BUILD_DIR" ]; then
    echo "Cleaning existing build directory..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure
echo "Configuring with CMake..."
cmake -G "$GENERATOR" \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
      ..

# Build
echo "Building..."
if [ "$GENERATOR" == "Ninja" ]; then
    ninja
else
    make -j$(nproc)
fi

echo -e "${GREEN}Build complete!${NC}"
echo "Executable: ${BUILD_DIR}/bin/sim_engine"
