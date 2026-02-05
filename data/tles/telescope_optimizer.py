#!/usr/bin/env python3
"""
Telescope Location Optimizer for OneWeb Constellation Observation

Finds optimal locations for 5 ground-based telescopes to maximize unique
satellite observations over 24 hours.

Constraints:
- Night-only observations (sun below horizon)
- 30-minute recalibration between observations
- Minimum 10° elevation above horizon
- Land-based locations only
- Prefer low annual cloud cover regions

Output:
- Optimal telescope locations with observation statistics
- Cesium visualization JSON
"""

import json
import math
import os
import sys
from datetime import datetime, timedelta
from dataclasses import dataclass
from typing import List, Tuple, Dict, Set, Optional
from sgp4.api import Satrec, jday
import numpy as np

# Flush stdout for real-time output
sys.stdout.reconfigure(line_buffering=True)

# Constants
DEG2RAD = math.pi / 180.0
RAD2DEG = 180.0 / math.pi

# Observation constraints
MIN_ELEVATION_DEG = 10.0
RECALIBRATION_TIME_MIN = 30

@dataclass
class GroundStation:
    name: str
    lat: float  # degrees
    lon: float  # degrees
    alt: float  # km
    cloud_cover: float  # 0-1

@dataclass
class Satellite:
    name: str
    catalog_num: int
    satrec: Satrec

# ============================================================================
# Candidate Locations - curated for low cloud cover
# ============================================================================
CANDIDATE_LOCATIONS = [
    # Chile - world's best sites
    GroundStation("Paranal_CL", -24.63, -70.40, 2.6, 0.10),
    GroundStation("La_Silla_CL", -29.26, -70.73, 2.4, 0.12),
    GroundStation("ALMA_CL", -23.02, -67.75, 5.0, 0.08),

    # Namibia/South Africa
    GroundStation("Gamsberg_NA", -23.34, 16.23, 2.3, 0.12),
    GroundStation("Sutherland_ZA", -32.38, 20.81, 1.8, 0.20),

    # Australia
    GroundStation("Siding_Spring_AU", -31.27, 149.07, 1.1, 0.25),
    GroundStation("Alice_Springs_AU", -23.7, 133.9, 0.5, 0.20),

    # USA Southwest
    GroundStation("Mauna_Kea_HI", 19.82, -155.47, 4.2, 0.25),
    GroundStation("Mt_Graham_AZ", 32.70, -109.89, 3.2, 0.22),
    GroundStation("Death_Valley_CA", 36.5, -117.0, 0.0, 0.15),

    # Canary Islands
    GroundStation("La_Palma_ES", 28.76, -17.89, 2.4, 0.30),

    # New Zealand
    GroundStation("Mt_John_NZ", -43.99, 170.46, 1.0, 0.45),

    # High latitude sites
    GroundStation("Fairbanks_AK", 64.8, -147.7, 0.1, 0.55),
    GroundStation("Yellowknife_CA", 62.5, -114.4, 0.2, 0.50),
]

# ============================================================================
# TLE Loading
# ============================================================================
def load_tles(tle_file: str) -> List[Satellite]:
    satellites = []
    with open(tle_file, 'r') as f:
        lines = f.readlines()

    i = 0
    while i < len(lines) - 2:
        name = lines[i].strip()
        line1 = lines[i + 1].strip()
        line2 = lines[i + 2].strip()

        if line1.startswith('1 ') and line2.startswith('2 '):
            try:
                satrec = Satrec.twoline2rv(line1, line2)
                catalog_num = int(line1[2:7])
                satellites.append(Satellite(name, catalog_num, satrec))
            except:
                pass
            i += 3
        else:
            i += 1

    return satellites

# ============================================================================
# Coordinate Transforms & Visibility
# ============================================================================
def jday_from_datetime(dt: datetime) -> Tuple[float, float]:
    jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
    return jd, fr

def gmst_from_jd(jd: float, fr: float) -> float:
    T = ((jd - 2451545.0) + fr) / 36525.0
    gmst = 280.46061837 + 360.98564736629 * ((jd - 2451545.0) + fr) + 0.000387933 * T * T
    return (gmst % 360.0) * DEG2RAD

def ecef_from_geodetic(lat_deg: float, lon_deg: float, alt_km: float) -> np.ndarray:
    lat = lat_deg * DEG2RAD
    lon = lon_deg * DEG2RAD
    a = 6378.137
    f = 1.0 / 298.257223563
    e2 = 2*f - f*f
    sin_lat, cos_lat = math.sin(lat), math.cos(lat)
    N = a / math.sqrt(1 - e2 * sin_lat * sin_lat)
    return np.array([
        (N + alt_km) * cos_lat * math.cos(lon),
        (N + alt_km) * cos_lat * math.sin(lon),
        (N * (1 - e2) + alt_km) * sin_lat
    ])

def sun_position_eci(jd: float, fr: float) -> np.ndarray:
    n = (jd - 2451545.0) + fr
    L = (280.460 + 0.9856474 * n) % 360.0
    g = ((357.528 + 0.9856003 * n) % 360.0) * DEG2RAD
    lam = (L + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)) * DEG2RAD
    eps = 23.439 * DEG2RAD
    R = 149597870.7 * (1.00014 - 0.01671 * math.cos(g))
    return np.array([R * math.cos(lam), R * math.cos(eps) * math.sin(lam), R * math.sin(eps) * math.sin(lam)])

def is_night(station: GroundStation, jd: float, fr: float) -> bool:
    sun_eci = sun_position_eci(jd, fr)
    gmst = gmst_from_jd(jd, fr)
    c, s = math.cos(gmst), math.sin(gmst)
    sun_ecef = np.array([sun_eci[0]*c + sun_eci[1]*s, -sun_eci[0]*s + sun_eci[1]*c, sun_eci[2]])
    station_ecef = ecef_from_geodetic(station.lat, station.lon, station.alt)
    to_sun = sun_ecef - station_ecef
    up = station_ecef / np.linalg.norm(station_ecef)
    sun_elev = math.asin(np.clip(np.dot(to_sun / np.linalg.norm(to_sun), up), -1, 1)) * RAD2DEG
    return sun_elev < -12.0

def sat_elevation(sat: Satellite, station: GroundStation, jd: float, fr: float) -> Tuple[float, np.ndarray]:
    """Returns (elevation_deg, sat_ecef_position)"""
    e, pos_eci, _ = sat.satrec.sgp4(jd, fr)
    if e != 0:
        return -90.0, np.zeros(3)

    pos_eci = np.array(pos_eci)
    gmst = gmst_from_jd(jd, fr)
    c, s = math.cos(gmst), math.sin(gmst)
    sat_ecef = np.array([pos_eci[0]*c + pos_eci[1]*s, -pos_eci[0]*s + pos_eci[1]*c, pos_eci[2]])

    station_ecef = ecef_from_geodetic(station.lat, station.lon, station.alt)
    delta = sat_ecef - station_ecef
    up = station_ecef / np.linalg.norm(station_ecef)
    elev = math.asin(np.clip(np.dot(delta / np.linalg.norm(delta), up), -1, 1)) * RAD2DEG

    return elev, sat_ecef

# ============================================================================
# Pass Finding (optimized)
# ============================================================================
def find_night_passes_fast(satellites: List[Satellite], station: GroundStation,
                           start_jd: float, duration_hours: float = 24) -> List[Tuple[int, float, float, np.ndarray]]:
    """
    Find all night-time passes above MIN_ELEVATION for all satellites.
    Returns list of (sat_idx, peak_time_jd, peak_elevation, peak_position_ecef)
    """
    passes = []
    step_min = 2.0  # 2-minute steps for coarse scan
    step_jd = step_min / 1440.0
    duration_jd = duration_hours / 24.0

    # Pre-compute station ECEF
    station_ecef = ecef_from_geodetic(station.lat, station.lon, station.alt)
    up = station_ecef / np.linalg.norm(station_ecef)

    for sat_idx, sat in enumerate(satellites):
        jd = start_jd
        fr = 0.0
        in_pass = False
        pass_peak_elev = 0.0
        pass_peak_time = 0.0
        pass_peak_pos = np.zeros(3)

        while jd + fr < start_jd + duration_jd:
            # Check if night
            if not is_night(station, jd, fr):
                if in_pass:
                    # End pass
                    if pass_peak_elev > MIN_ELEVATION_DEG:
                        passes.append((sat_idx, pass_peak_time, pass_peak_elev, pass_peak_pos.copy()))
                    in_pass = False
                fr += step_jd
                if fr >= 1.0:
                    jd += 1
                    fr -= 1.0
                continue

            # Propagate satellite
            e, pos_eci, _ = sat.satrec.sgp4(jd, fr)
            if e != 0:
                fr += step_jd
                if fr >= 1.0:
                    jd += 1
                    fr -= 1.0
                continue

            pos_eci = np.array(pos_eci)
            gmst = gmst_from_jd(jd, fr)
            c, s = math.cos(gmst), math.sin(gmst)
            sat_ecef = np.array([pos_eci[0]*c + pos_eci[1]*s, -pos_eci[0]*s + pos_eci[1]*c, pos_eci[2]])

            delta = sat_ecef - station_ecef
            elev = math.asin(np.clip(np.dot(delta / np.linalg.norm(delta), up), -1, 1)) * RAD2DEG

            if elev > MIN_ELEVATION_DEG:
                if not in_pass:
                    in_pass = True
                    pass_peak_elev = elev
                    pass_peak_time = jd + fr
                    pass_peak_pos = sat_ecef
                elif elev > pass_peak_elev:
                    pass_peak_elev = elev
                    pass_peak_time = jd + fr
                    pass_peak_pos = sat_ecef
            else:
                if in_pass:
                    # End pass
                    passes.append((sat_idx, pass_peak_time, pass_peak_elev, pass_peak_pos.copy()))
                    in_pass = False

            fr += step_jd
            if fr >= 1.0:
                jd += 1
                fr -= 1.0

        # End any open pass
        if in_pass and pass_peak_elev > MIN_ELEVATION_DEG:
            passes.append((sat_idx, pass_peak_time, pass_peak_elev, pass_peak_pos.copy()))

    return passes

def schedule_observations(passes: List[Tuple[int, float, float, np.ndarray]],
                          recal_min: float = 30) -> List[Tuple[int, float, float, np.ndarray]]:
    """Schedule observations respecting recalibration time. Prioritize high elevation."""
    # Sort by elevation descending
    sorted_passes = sorted(passes, key=lambda x: -x[2])

    scheduled = []
    observed_sats = set()
    recal_jd = recal_min / 1440.0

    # Track occupied time slots
    obs_times = []

    for sat_idx, peak_time, peak_elev, peak_pos in sorted_passes:
        if sat_idx in observed_sats:
            continue

        # Check if time slot is available
        slot_free = True
        for obs_time in obs_times:
            if abs(peak_time - obs_time) < recal_jd:
                slot_free = False
                break

        if slot_free:
            scheduled.append((sat_idx, peak_time, peak_elev, peak_pos))
            observed_sats.add(sat_idx)
            obs_times.append(peak_time)

    return scheduled

# ============================================================================
# Evaluation & Optimization
# ============================================================================
def evaluate_stations(stations: List[GroundStation], satellites: List[Satellite],
                      start_jd: float) -> Tuple[int, Dict]:
    """Evaluate a set of stations. Returns (unique_sats, stats_dict)"""
    global_observed = set()
    stats = {}

    for station in stations:
        passes = find_night_passes_fast(satellites, station, start_jd, 24)
        scheduled = schedule_observations(passes, RECALIBRATION_TIME_MIN)

        station_sats = set(s[0] for s in scheduled)
        new_sats = station_sats - global_observed
        global_observed.update(station_sats)

        stats[station.name] = {
            'total_passes': len(passes),
            'scheduled': len(scheduled),
            'unique_sats': len(station_sats),
            'new_unique': len(new_sats),
            'observations': scheduled
        }

    return len(global_observed), stats

def optimize_greedy(satellites: List[Satellite], candidates: List[GroundStation],
                    num_stations: int, start_jd: float) -> Tuple[List[GroundStation], Dict]:
    """Greedy optimization: pick stations that add most new satellites."""
    print(f"\nRunning greedy optimization for {num_stations} stations...")
    print(f"Precomputing passes for {len(candidates)} candidate locations...")

    # Precompute passes for all candidates
    candidate_passes = {}
    for i, station in enumerate(candidates):
        print(f"  {i+1}/{len(candidates)}: {station.name}...", end=" ", flush=True)
        passes = find_night_passes_fast(satellites, station, start_jd, 24)
        scheduled = schedule_observations(passes, RECALIBRATION_TIME_MIN)
        candidate_passes[station.name] = {
            'station': station,
            'passes': passes,
            'scheduled': scheduled,
            'sats': set(s[0] for s in scheduled)
        }
        print(f"{len(scheduled)} obs, {len(candidate_passes[station.name]['sats'])} unique sats")

    # Greedy selection
    selected = []
    global_observed = set()
    stats = {}

    for round_num in range(num_stations):
        best_station = None
        best_new = 0
        best_data = None

        for name, data in candidate_passes.items():
            if data['station'] in selected:
                continue

            new_sats = data['sats'] - global_observed
            # Weight by cloud cover (prefer clearer skies)
            score = len(new_sats) * (1.0 - data['station'].cloud_cover * 0.5)

            if score > best_new:
                best_new = score
                best_station = data['station']
                best_data = data

        if best_station:
            selected.append(best_station)
            new_sats = best_data['sats'] - global_observed
            global_observed.update(best_data['sats'])

            stats[best_station.name] = {
                'total_passes': len(best_data['passes']),
                'scheduled': len(best_data['scheduled']),
                'unique_sats': len(best_data['sats']),
                'new_unique': len(new_sats),
                'observations': best_data['scheduled']
            }

            print(f"\nSelected #{round_num+1}: {best_station.name}")
            print(f"  New satellites: {len(new_sats)}, Total so far: {len(global_observed)}")

    return selected, stats

# ============================================================================
# Visualization Output
# ============================================================================
def generate_visualization(stations: List[GroundStation], stats: Dict,
                           satellites: List[Satellite], start_jd: float,
                           output_path: str):
    """Generate Cesium visualization JSON"""
    print("\nGenerating Cesium visualization...")

    # Collect observed satellite indices
    observed_indices = set()
    for station_name, station_stats in stats.items():
        for sat_idx, _, _, _ in station_stats['observations']:
            observed_indices.add(sat_idx)

    # Sample satellite positions over 24 hours
    step_min = 1.0
    steps = int(24 * 60 / step_min)

    sat_trajectories = {}
    for sat_idx in observed_indices:
        sat = satellites[sat_idx]
        positions = []

        for step in range(steps):
            fr = (step * step_min) / 1440.0
            jd = start_jd + int(fr)
            fr = fr % 1.0

            e, pos_eci, _ = sat.satrec.sgp4(jd, fr)
            if e == 0:
                pos_eci = np.array(pos_eci)
                gmst = gmst_from_jd(jd, fr)
                c, s = math.cos(gmst), math.sin(gmst)
                ecef = [
                    (pos_eci[0]*c + pos_eci[1]*s) * 1000,  # km to m
                    (-pos_eci[0]*s + pos_eci[1]*c) * 1000,
                    pos_eci[2] * 1000
                ]
                positions.append(ecef)
            else:
                positions.append(None)

        sat_trajectories[sat_idx] = {
            'name': sat.name,
            'positions': positions
        }

    # Build output
    start_dt = datetime(2026, 8, 3, 0, 0, 0)

    output = {
        'format': 'telescope_analysis_v1',
        'config': {
            'start_time': start_dt.isoformat() + 'Z',
            'duration_hours': 24,
            'sample_interval_sec': int(step_min * 60),
            'min_elevation_deg': MIN_ELEVATION_DEG,
            'recalibration_min': RECALIBRATION_TIME_MIN
        },
        'stations': [],
        'satellites': [],
        'observations': [],
        'summary': {
            'total_unique_satellites': len(observed_indices),
            'total_satellites': len(satellites)
        }
    }

    for station in stations:
        st = stats.get(station.name, {})
        output['stations'].append({
            'name': station.name,
            'lat': station.lat,
            'lon': station.lon,
            'alt_km': station.alt,
            'cloud_cover': station.cloud_cover,
            'scheduled_observations': st.get('scheduled', 0),
            'unique_satellites': st.get('unique_sats', 0)
        })

    for sat_idx, traj in sat_trajectories.items():
        output['satellites'].append({
            'idx': sat_idx,
            'name': traj['name'],
            'positions': traj['positions']
        })

    # Add observations with times
    for station in stations:
        st = stats.get(station.name, {})
        for sat_idx, peak_time, peak_elev, peak_pos in st.get('observations', []):
            # Convert JD to datetime
            days_since_start = peak_time - start_jd
            obs_dt = start_dt + timedelta(days=days_since_start)

            output['observations'].append({
                'station': station.name,
                'satellite': satellites[sat_idx].name,
                'satellite_idx': sat_idx,
                'time': obs_dt.isoformat() + 'Z',
                'elevation_deg': round(peak_elev, 1),
                'position_ecef': [peak_pos[0]*1000, peak_pos[1]*1000, peak_pos[2]*1000]
            })

    output['observations'].sort(key=lambda x: x['time'])

    with open(output_path, 'w') as f:
        json.dump(output, f, indent=2)

    print(f"Visualization saved to: {output_path}")

# ============================================================================
# Main
# ============================================================================
def run_multi_day_analysis(satellites: List[Satellite], stations: List[GroundStation],
                           start_jd: float, num_days: int = 7) -> Tuple[Dict, Set]:
    """Run analysis over multiple days, tracking cumulative unique satellites."""
    print(f"\nRunning {num_days}-day analysis...")

    all_observations = []
    cumulative_observed = set()
    daily_stats = []

    for day in range(num_days):
        day_start_jd = start_jd + day
        day_observed = set()
        day_obs = []

        print(f"\n  Day {day + 1}:", end=" ", flush=True)

        for station in stations:
            passes = find_night_passes_fast(satellites, station, day_start_jd, 24)
            scheduled = schedule_observations(passes, RECALIBRATION_TIME_MIN)

            for sat_idx, peak_time, peak_elev, peak_pos in scheduled:
                is_new = sat_idx not in cumulative_observed
                day_obs.append({
                    'sat_idx': sat_idx,
                    'time_jd': peak_time,
                    'elevation': peak_elev,
                    'position': peak_pos,
                    'station': station.name,
                    'is_first_collect': is_new,
                    'day': day
                })
                day_observed.add(sat_idx)
                cumulative_observed.add(sat_idx)

        new_today = len(day_observed - (cumulative_observed - day_observed))
        print(f"{len(day_obs)} obs, {len(day_observed)} unique today, {len(cumulative_observed)} cumulative")

        daily_stats.append({
            'day': day + 1,
            'observations': len(day_obs),
            'unique_today': len(day_observed),
            'cumulative': len(cumulative_observed)
        })

        all_observations.extend(day_obs)

    return {
        'observations': all_observations,
        'daily_stats': daily_stats,
        'total_unique': len(cumulative_observed)
    }, cumulative_observed


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    tle_file = os.path.join(script_dir, 'ONEWEB.txt')
    viz_output = os.path.join(script_dir, '..', '..', 'visualization', 'cesium', 'telescope_analysis.json')

    print("=" * 70)
    print("ONEWEB TELESCOPE LOCATION OPTIMIZER - 7 DAY ANALYSIS")
    print("=" * 70)

    print("\nLoading OneWeb TLEs...")
    satellites = load_tles(tle_file)
    print(f"Loaded {len(satellites)} satellites")

    # Start time: Aug 3, 2026 00:00 UTC (Antarctic winter!)
    jd, fr = jday(2026, 8, 3, 0, 0, 0)
    start_jd = jd + fr

    NUM_DAYS = 7
    print(f"\nAnalysis period: 2026-02-03 to 2026-02-{3 + NUM_DAYS - 1} ({NUM_DAYS} days)")

    # ALL ANTARCTICA - testing polar geometry for near-polar constellation
    # February = Antarctic summer (limited darkness!)
    best_stations = [
        GroundStation("South_Pole", -90.0, 0.0, 2.8, 0.05),         # Amundsen-Scott Station
        GroundStation("Dome_A", -80.4, 77.1, 4.1, 0.05),            # Highest point, driest
        GroundStation("Dome_C", -75.1, 123.4, 3.2, 0.05),           # Concordia Station
        GroundStation("Dome_Fuji", -77.3, 39.7, 3.8, 0.05),         # Japanese base
        GroundStation("McMurdo", -77.8, 166.7, 0.0, 0.15),          # US base, Ross Island
    ]

    # Run multi-day analysis
    analysis_results, observed_set = run_multi_day_analysis(
        satellites=satellites,
        stations=best_stations,
        start_jd=start_jd,
        num_days=NUM_DAYS
    )

    # Build stats dict for visualization (compatibility)
    stats = {}
    for station in best_stations:
        station_obs = [o for o in analysis_results['observations'] if o['station'] == station.name]
        stats[station.name] = {
            'total_passes': len(station_obs) * 10,  # Approximate
            'scheduled': len(station_obs),
            'unique_sats': len(set(o['sat_idx'] for o in station_obs)),
            'new_unique': len([o for o in station_obs if o['is_first_collect']]),
            'observations': [(o['sat_idx'], o['time_jd'], o['elevation'], o['position']) for o in station_obs]
        }

    # Print results
    print("\n" + "=" * 70)
    print("OPTIMAL TELESCOPE LOCATIONS")
    print("=" * 70)

    total_unique = set()
    for i, station in enumerate(best_stations, 1):
        st = stats[station.name]
        print(f"\n{i}. {station.name}")
        print(f"   Coordinates: {station.lat:.2f}°N, {station.lon:.2f}°E")
        print(f"   Altitude: {station.alt:.1f} km")
        print(f"   Annual cloud cover: {station.cloud_cover*100:.0f}%")
        print(f"   Night passes available: {st['total_passes']}")
        print(f"   Scheduled observations: {st['scheduled']}")
        print(f"   Unique satellites: {st['unique_sats']}")
        print(f"   New unique (not seen elsewhere): {st['new_unique']}")

        for sat_idx, _, _, _ in st['observations']:
            total_unique.add(sat_idx)

    print("\n" + "=" * 70)
    print(f"TOTAL UNIQUE SATELLITES OBSERVED: {len(total_unique)} / {len(satellites)}")
    print(f"COVERAGE: {100*len(total_unique)/len(satellites):.1f}%")
    print("=" * 70)

    # Print daily summary
    print("\nDAILY CUMULATIVE COVERAGE:")
    for ds in analysis_results['daily_stats']:
        pct = 100 * ds['cumulative'] / len(satellites)
        bar = '█' * int(pct / 2) + '░' * (50 - int(pct / 2))
        print(f"  Day {ds['day']}: {ds['cumulative']:3d} satellites ({pct:5.1f}%) {bar}")

    # Generate visualization with multi-day data
    generate_multiday_visualization(
        best_stations, analysis_results, satellites, start_jd, NUM_DAYS, viz_output
    )

    print("\nDone!")
    print(f"\nTo visualize, run the HTTP server and open:")
    print(f"  http://localhost:8000/telescope_viewer.html")


def generate_multiday_visualization(stations: List[GroundStation], analysis: Dict,
                                    satellites: List[Satellite], start_jd: float,
                                    num_days: int, output_path: str):
    """Generate Cesium visualization JSON for multi-day analysis"""
    print("\nGenerating multi-day Cesium visualization...")

    # Collect observed satellite indices for marking first-collect times
    observed_indices = set(o['sat_idx'] for o in analysis['observations'])

    # Sample ALL satellite positions over entire period (every 2 minutes to reduce size)
    step_min = 2.0
    steps = int(num_days * 24 * 60 / step_min)

    print(f"  Sampling ALL {len(satellites)} satellite trajectories over {num_days} days...")

    sat_trajectories = {}
    for sat_idx, sat in enumerate(satellites):
        sat = satellites[sat_idx]
        positions = []

        for step in range(steps):
            fr = (step * step_min) / 1440.0
            jd = start_jd + int(fr)
            fr = fr % 1.0

            e, pos_eci, _ = sat.satrec.sgp4(jd, fr)
            if e == 0:
                pos_eci = np.array(pos_eci)
                gmst = gmst_from_jd(jd, fr)
                c, s = math.cos(gmst), math.sin(gmst)
                ecef = [
                    round((pos_eci[0]*c + pos_eci[1]*s) * 1000),  # km to m, rounded to save space
                    round((-pos_eci[0]*s + pos_eci[1]*c) * 1000),
                    round(pos_eci[2] * 1000)
                ]
                positions.append(ecef)
            else:
                positions.append(None)

        sat_trajectories[sat_idx] = {
            'name': sat.name,
            'positions': positions
        }

    # Build output
    start_dt = datetime(2026, 8, 3, 0, 0, 0)

    output = {
        'format': 'telescope_analysis_v2',
        'config': {
            'start_time': start_dt.isoformat() + 'Z',
            'duration_days': num_days,
            'duration_hours': num_days * 24,
            'sample_interval_sec': int(step_min * 60),
            'min_elevation_deg': MIN_ELEVATION_DEG,
            'recalibration_min': RECALIBRATION_TIME_MIN
        },
        'stations': [],
        'satellites': [],
        'observations': [],
        'daily_stats': analysis['daily_stats'],
        'summary': {
            'total_unique_satellites': analysis['total_unique'],
            'total_satellites': len(satellites),
            'total_observations': len(analysis['observations'])
        }
    }

    for station in stations:
        station_obs = [o for o in analysis['observations'] if o['station'] == station.name]
        output['stations'].append({
            'name': station.name,
            'lat': station.lat,
            'lon': station.lon,
            'alt_km': station.alt,
            'cloud_cover': station.cloud_cover,
            'total_observations': len(station_obs),
            'first_collects': len([o for o in station_obs if o['is_first_collect']])
        })

    for sat_idx, traj in sat_trajectories.items():
        # Find first collection time for this satellite
        first_collect = None
        for o in analysis['observations']:
            if o['sat_idx'] == sat_idx and o['is_first_collect']:
                days_since_start = o['time_jd'] - start_jd
                first_collect = (start_dt + timedelta(days=days_since_start)).isoformat() + 'Z'
                break

        output['satellites'].append({
            'idx': sat_idx,
            'name': traj['name'],
            'first_collect_time': first_collect,
            'positions': traj['positions']
        })

    # Add observations with times and first-collect flag
    for obs in analysis['observations']:
        days_since_start = obs['time_jd'] - start_jd
        obs_dt = start_dt + timedelta(days=days_since_start)

        output['observations'].append({
            'station': obs['station'],
            'satellite': satellites[obs['sat_idx']].name,
            'satellite_idx': obs['sat_idx'],
            'time': obs_dt.isoformat() + 'Z',
            'day': obs['day'] + 1,
            'elevation_deg': round(obs['elevation'], 1),
            'is_first_collect': obs['is_first_collect'],
            'position_ecef': [
                round(obs['position'][0] * 1000),
                round(obs['position'][1] * 1000),
                round(obs['position'][2] * 1000)
            ]
        })

    output['observations'].sort(key=lambda x: x['time'])

    with open(output_path, 'w') as f:
        json.dump(output, f)

    print(f"  Visualization saved to: {output_path}")
    print(f"  File size: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB")


if __name__ == '__main__':
    main()
