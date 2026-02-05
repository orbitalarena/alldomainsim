#!/usr/bin/env python3
"""
TLE Constellation Parser

Parses a full satellite catalog TLE file and extracts satellites matching a search term.

TLE format:
  Line 0: Satellite name (up to 24 chars, may contain numbers)
  Line 1: TLE line 1 (starts with "1 " followed by 5-digit catalog number)
  Line 2: TLE line 2 (starts with "2 " followed by 5-digit catalog number)

Usage:
  python tle_parser.py <search_term> [input_file] [output_file]

Examples:
  python tle_parser.py ONEWEB
  python tle_parser.py STARLINK
  python tle_parser.py "GPS " fullsatcat.txt GPS.txt
"""

import sys
import os
import re

def is_tle_data_line(line):
    """
    Check if a line is a TLE data line (line 1 or 2).
    TLE data lines start with "1 " or "2 " followed by a 5-digit catalog number.
    This distinguishes them from satellite names that might start with 1 or 2.
    """
    # TLE line 1: "1 NNNNN..." where NNNNN is the catalog number
    # TLE line 2: "2 NNNNN..." where NNNNN is the catalog number
    return bool(re.match(r'^[12] \d{5}', line))

def parse_tle_file(input_path, search_term, output_path):
    """
    Parse TLE file and extract satellites matching the search term.

    Args:
        input_path: Path to input TLE file (e.g., fullsatcat.txt)
        search_term: Case-insensitive search term for satellite names
        output_path: Path to output TLE file

    Returns:
        Number of satellites found
    """
    search_upper = search_term.upper()
    found_count = 0

    with open(input_path, 'r') as infile:
        lines = infile.readlines()

    output_lines = []
    i = 0

    while i < len(lines):
        line = lines[i].rstrip('\n\r')

        # Check if this is a satellite name line (not a TLE data line)
        if not is_tle_data_line(line):
            # This is a satellite name
            sat_name = line

            # Check if we have the next two lines for TLE data
            if i + 2 < len(lines):
                tle_line1 = lines[i + 1].rstrip('\n\r')
                tle_line2 = lines[i + 2].rstrip('\n\r')

                # Verify they are valid TLE data lines
                if is_tle_data_line(tle_line1) and is_tle_data_line(tle_line2):
                    # Check if satellite name matches search term
                    if search_upper in sat_name.upper():
                        output_lines.append(sat_name)
                        output_lines.append(tle_line1)
                        output_lines.append(tle_line2)
                        found_count += 1

                    # Skip past the TLE data lines
                    i += 3
                    continue

        # Move to next line
        i += 1

    # Write output file
    with open(output_path, 'w') as outfile:
        outfile.write('\n'.join(output_lines))
        if output_lines:
            outfile.write('\n')

    return found_count

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    search_term = sys.argv[1]

    # Default paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_input = os.path.join(script_dir, 'fullsatcat.txt')
    default_output = os.path.join(script_dir, f'{search_term.replace(" ", "_")}.txt')

    input_path = sys.argv[2] if len(sys.argv) > 2 else default_input
    output_path = sys.argv[3] if len(sys.argv) > 3 else default_output

    # Make paths absolute if relative
    if not os.path.isabs(input_path):
        input_path = os.path.join(script_dir, input_path)
    if not os.path.isabs(output_path):
        output_path = os.path.join(script_dir, output_path)

    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}")
        sys.exit(1)

    print(f"Parsing {input_path}")
    print(f"Searching for: {search_term}")

    count = parse_tle_file(input_path, search_term, output_path)

    print(f"Found {count} satellites matching '{search_term}'")
    print(f"Output written to: {output_path}")

if __name__ == '__main__':
    main()
