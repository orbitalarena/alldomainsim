# 🌍 Visualizing Orbits in Cesium

## Quick Start

### Step 1: Generate Orbit Data
```bash
cd all-domain-sim
./build/bin/demo
```

This creates `orbit_data.json` with satellite trajectories.

### Step 2: Open the Viewer

**Option A: Simple HTTP Server (Python 3)**
```bash
# In the all-domain-sim directory
python3 -m http.server 8000
```

Then open: http://localhost:8000/visualization/cesium/orbit_viewer.html

**Option B: Direct File Open (may have CORS issues)**
```bash
# Open directly in browser
xdg-open visualization/cesium/orbit_viewer.html  # Linux
open visualization/cesium/orbit_viewer.html      # Mac
```

## What You'll See

The Cesium viewer will display:
- **3D Earth** with realistic terrain
- **Orbit Paths** colored lines showing satellite trajectories
- **Satellite Positions** points at the end of each trajectory
- **Labels** satellite names

### Colors
- Red: First satellite (ISS)
- Yellow: Second satellite (Hubble)
- Green: Third satellite (GPS)
- And so on...

## Controls

### Mouse
- **Left Click + Drag**: Rotate view
- **Right Click + Drag**: Pan
- **Scroll Wheel**: Zoom in/out
- **Middle Click + Drag**: Rotate camera

### Buttons
- **Load Orbit Data**: Reload the JSON file
- **Reset View**: Return to default view

## Understanding the Visualization

### ECI Coordinates
The orbits are displayed in **J2000 ECI (Earth-Centered Inertial)** frame:
- Origin: Earth's center
- Z-axis: Points to North Pole
- X-axis: Points to vernal equinox
- The Earth rotates beneath the fixed orbital planes

### Orbit Characteristics

**ISS (Red)**
- Low Earth Orbit (LEO)
- ~410 km altitude
- 51.6° inclination
- Visible as tight circle near Earth

**Hubble (Yellow)**
- LEO
- ~540 km altitude
- 28.5° inclination
- Slightly larger circle

**GPS (Green)**
- Medium Earth Orbit (MEO)
- ~20,400 km altitude
- 55° inclination
- Much larger orbit

## Troubleshooting

### "Error loading orbit_data.json"
**Problem**: CORS policy blocking local files

**Solution**: Use HTTP server
```bash
python3 -m http.server 8000
```

### Orbit paths not visible
**Problem**: Data file path incorrect

**Check**: orbit_data.json should be in `all-domain-sim/` directory

**Fix path in HTML** if needed:
```javascript
const response = await fetch('../../orbit_data.json');
```

### Blank screen
**Problem**: Cesium failed to load

**Solution**: Check internet connection (Cesium loads from CDN)

## Advanced Usage

### Longer Propagation
Edit `src/demo.cpp`:
```cpp
double sim_duration = 5580.0; // One full ISS orbit (93 minutes)
```

Rebuild and run:
```bash
./scripts/manual_build.sh
./build/bin/demo
```

### More Satellites
```bash
./build/bin/demo data/tles/satcat.txt
```

**Warning**: 100 satellites will create a large JSON file and may slow the browser!

### Animation
Currently shows static trajectories. Next milestone: add time-based animation!

## Next Features (Coming Soon)

- [ ] Time-based animation (satellites moving in real-time)
- [ ] Coordinate frame transformations (show orbits in ECEF)
- [ ] Multiple scenarios side-by-side
- [ ] Camera following satellites
- [ ] Orbital parameter display (altitude, velocity, period)
- [ ] Ground track visualization

## Technical Details

### Data Format
```json
{
  "satellites": [
    {
      "name": "ISS (ZARYA)",
      "id": 0,
      "positions": [
        {"time": 10, "x": 2.64e6, "y": -3.33e6, "z": 5.30e6},
        ...
      ]
    }
  ]
}
```

### Cesium Version
Using Cesium 1.111 from CDN (latest stable as of implementation)

### Coordinate System
- **Input**: J2000 ECI Cartesian (x, y, z in meters)
- **Display**: Cesium handles the visualization automatically
- **Note**: Earth rotates under fixed ECI frame

## Performance Tips

### For Many Satellites (50+):
1. Reduce output points:
   ```cpp
   double output_interval = 120.0; // Every 2 minutes instead of 10s
   ```

2. Shorter duration:
   ```cpp
   double sim_duration = 300.0; // 5 minutes
   ```

3. Use Chrome/Edge (better WebGL performance than Firefox)

## Screenshots

After running, you should see:
- Blue Earth sphere
- Colored orbit lines wrapping around Earth
- Satellite labels
- 3D perspective view

Try zooming out to see the full orbital geometry!

---

**Status**: ✅ Basic visualization working
**Next**: Add time-based animation and ground tracks
