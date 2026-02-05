#!/bin/bash
# Setup script for offline Cesium operation
# Downloads Cesium 1.111 and Chart.js locally

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"

CESIUM_VERSION="1.111"
CESIUM_URL="https://github.com/CesiumGS/cesium/releases/download/$CESIUM_VERSION/Cesium-$CESIUM_VERSION.zip"
CHARTJS_VERSION="4.4.7"
CHARTJS_URL="https://cdn.jsdelivr.net/npm/chart.js@$CHARTJS_VERSION/dist/chart.umd.min.js"

echo "=== All-Domain Sim Offline Setup ==="
echo "This will download ~70MB of assets for offline operation."
echo ""

# Create lib directory
mkdir -p "$LIB_DIR"

# Download and extract Cesium
if [ -d "$LIB_DIR/Cesium" ] && [ -f "$LIB_DIR/Cesium/Cesium.js" ]; then
    echo "Cesium already exists in $LIB_DIR/Cesium"
    read -p "Re-download? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$LIB_DIR/Cesium"
    else
        echo "Skipping Cesium download."
    fi
fi

if [ ! -f "$LIB_DIR/Cesium/Cesium.js" ]; then
    echo "Downloading Cesium $CESIUM_VERSION..."
    TEMP_ZIP=$(mktemp)
    TEMP_DIR=$(mktemp -d)
    curl -L -o "$TEMP_ZIP" "$CESIUM_URL"

    echo "Extracting Cesium..."
    unzip -q "$TEMP_ZIP" -d "$TEMP_DIR"

    # The zip extracts to a nested structure, we want the Build/Cesium contents
    # which contains Cesium.js, Widgets/, Workers/, Assets/
    rm -rf "$LIB_DIR/Cesium"
    mv "$TEMP_DIR/Build/Cesium" "$LIB_DIR/Cesium"

    # Clean up
    rm "$TEMP_ZIP"
    rm -rf "$TEMP_DIR"

    echo "Cesium $CESIUM_VERSION installed to $LIB_DIR/Cesium"
fi

# Download Chart.js
if [ -f "$LIB_DIR/chart.umd.min.js" ]; then
    echo "Chart.js already exists."
else
    echo "Downloading Chart.js $CHARTJS_VERSION..."
    curl -L -o "$LIB_DIR/chart.umd.min.js" "$CHARTJS_URL"
    echo "Chart.js installed to $LIB_DIR/chart.umd.min.js"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Directory structure:"
ls -la "$LIB_DIR"
echo ""
echo "Cesium contents:"
ls "$LIB_DIR/Cesium/" | head -10
echo ""
echo "Cesium size:"
du -sh "$LIB_DIR/Cesium" 2>/dev/null || echo "  (not installed)"
echo ""
echo "To use offline mode, add ?offline=true to any viewer URL."
echo "Example: http://localhost:8000/scenario_builder.html?offline=true"
