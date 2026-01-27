#!/bin/bash
# Setup script - Install dependencies for All-Domain Simulation Environment

set -e

echo "=== Installing Dependencies ==="

# Update package list
echo "Updating package list..."
sudo apt-get update

# Install build essentials
echo "Installing build tools..."
sudo apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    git

# Install Eigen3
echo "Installing Eigen3..."
sudo apt-get install -y libeigen3-dev

# Verify installations
echo ""
echo "Verifying installations..."
echo "CMake: $(cmake --version | head -n1)"
echo "Ninja: $(ninja --version)"
echo "GCC: $(gcc --version | head -n1)"
echo "Eigen3: $(dpkg -l | grep libeigen3-dev | awk '{print $3}')"

echo ""
echo "=== Dependencies installed successfully ==="
echo "Run './scripts/build.sh' to build the project"
