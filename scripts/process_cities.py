#!/usr/bin/env python3
"""
Process raw city data into a clean format for the simulation.
Creates a JSON file with the 1000 largest cities by population.
"""

import json
import sys

def process_cities(input_file, output_file):
    with open(input_file, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)

    cities = []
    for i, city in enumerate(raw_data):
        # Extract coordinates
        coords = city.get('coordinates', {})
        if not coords:
            continue

        lat = coords.get('lat')
        lon = coords.get('lon')
        if lat is None or lon is None:
            continue

        # Get elevation (use DEM if elevation not available)
        elevation = city.get('elevation')
        if elevation is None:
            elevation = city.get('dem', 0)
        if elevation is None:
            elevation = 0

        cities.append({
            'id': i,
            'name': city.get('name', 'Unknown'),
            'ascii_name': city.get('ascii_name', city.get('name', 'Unknown')),
            'country': city.get('cou_name_en', city.get('country_code', 'Unknown')),
            'country_code': city.get('country_code', ''),
            'latitude': lat,
            'longitude': lon,
            'elevation_m': elevation,
            'population': city.get('population', 0),
            'timezone': city.get('timezone', '')
        })

    # Sort by population descending and take top 1000
    cities.sort(key=lambda x: x['population'], reverse=True)
    cities = cities[:1000]

    # Re-assign IDs after sorting
    for i, city in enumerate(cities):
        city['id'] = i

    # Create output structure
    output = {
        'metadata': {
            'description': 'Top 1000 cities by population',
            'source': 'GeoNames via OpenDataSoft',
            'count': len(cities),
            'fields': ['id', 'name', 'ascii_name', 'country', 'country_code',
                      'latitude', 'longitude', 'elevation_m', 'population', 'timezone']
        },
        'cities': cities
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    # Print summary
    print(f"Processed {len(cities)} cities")
    print(f"\nTop 10 cities by population:")
    for city in cities[:10]:
        print(f"  {city['name']}, {city['country']}: {city['population']:,} "
              f"({city['latitude']:.2f}, {city['longitude']:.2f}, {city['elevation_m']}m)")

    print(f"\nPopulation range: {cities[-1]['population']:,} - {cities[0]['population']:,}")
    print(f"Output written to: {output_file}")

if __name__ == '__main__':
    input_file = sys.argv[1] if len(sys.argv) > 1 else 'data/raw_cities.json'
    output_file = sys.argv[2] if len(sys.argv) > 2 else 'data/world_cities_1000.json'
    process_cities(input_file, output_file)
