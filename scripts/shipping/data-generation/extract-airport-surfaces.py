#!/usr/bin/env python3
"""
Extract airport surface data (taxiways, aprons) from X-Plane apt.dat

This script parses the X-Plane apt.dat file and extracts pavement polygon data
for use in terrain flattening. It's designed to be run as part of the build
process and will skip extraction if the apt.dat file hasn't changed.

Output: src-tauri/resources/airport-surfaces.json.gz (gzip compressed)

Usage:
    python scripts/shipping/data-generation/extract-airport-surfaces.py [--force] [--apt-dat PATH]

Options:
    --force       Force re-extraction even if apt.dat hasn't changed
    --apt-dat     Path to apt.dat file (default: auto-detect)
"""

import argparse
import gzip
import json
import sys
import time
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

# Coordinate precision (6 decimals = ~10cm accuracy, sufficient for our needs)
COORD_PRECISION = 6

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent.parent  # scripts/shipping/data-generation -> project root
OUTPUT_FILE = PROJECT_ROOT / "src-tauri" / "resources" / "airport-surfaces.json.gz"
MEMO_FILE = PROJECT_ROOT / "src-tauri" / "resources" / ".airport-surfaces-memo.json"

# Common apt.dat locations
APT_DAT_PATHS = [
    Path(r"F:\Steam\steamapps\common\X-Plane 12\Global Scenery\Global Airports\Earth nav data\apt.dat"),
    Path(r"C:\X-Plane 12\Global Scenery\Global Airports\Earth nav data\apt.dat"),
    Path(r"D:\X-Plane 12\Global Scenery\Global Airports\Earth nav data\apt.dat"),
    Path.home() / "X-Plane 12" / "Global Scenery" / "Global Airports" / "Earth nav data" / "apt.dat",
]

# =============================================================================
# Surface code mapping
# =============================================================================

def categorize_surface(code: int) -> str:
    """Categorize X-Plane surface code into simplified type"""
    if code == 1 or 20 <= code <= 38:
        return 'asphalt'
    elif code == 2 or 50 <= code <= 57:
        return 'concrete'
    elif code == 3:
        return 'grass'
    elif code == 4:
        return 'dirt'
    elif code == 5:
        return 'gravel'
    elif code == 12:
        return 'lakebed'
    elif code == 13:
        return 'water'
    elif code == 14:
        return 'snow'
    elif code == 15:
        return 'transparent'
    else:
        return 'other'

# =============================================================================
# Data structures
# =============================================================================

@dataclass
class PavementPolygon:
    """A single pavement polygon (taxiway, apron, etc.)"""
    surface: str
    vertices: list  # [[lon, lat], ...]
    holes: list = field(default_factory=list)  # [[[lon, lat], ...], ...]

@dataclass
class AirportSurfaces:
    """Surface data for a single airport"""
    icao: str
    name: str
    elevation_ft: int
    pavements: list = field(default_factory=list)  # List of PavementPolygon

# =============================================================================
# apt.dat parsing
# =============================================================================

def find_apt_dat() -> Optional[Path]:
    """Find apt.dat file in common locations"""
    for path in APT_DAT_PATHS:
        if path.exists():
            return path
    return None

def parse_apt_dat(apt_dat_path: Path) -> dict[str, AirportSurfaces]:
    """
    Parse apt.dat and extract pavement polygons for all airports.

    Row codes we care about:
    - 1, 16, 17: Airport header (land, seaplane, heliport)
    - 110: Pavement (taxiway/apron) header
    - 111: Node (plain)
    - 112: Node with Bezier control point
    - 113: Node (close loop)
    - 114: Node with Bezier (close loop)
    - 115: Node (end) - terminates a hole
    - 116: Node with Bezier (end)
    """
    airports = {}
    current_airport: Optional[AirportSurfaces] = None
    current_pavement: Optional[PavementPolygon] = None
    current_vertices: list = []
    current_holes: list = []
    in_hole = False

    file_size = apt_dat_path.stat().st_size
    bytes_read = 0
    last_progress = 0

    print(f"Parsing {apt_dat_path}")
    print(f"File size: {file_size / 1024 / 1024:.1f} MB")

    start_time = time.time()

    with open(apt_dat_path, 'r', encoding='latin-1') as f:
        for line in f:
            bytes_read += len(line)

            # Progress indicator every 10%
            progress = int(bytes_read / file_size * 100)
            if progress >= last_progress + 10:
                last_progress = progress
                print(f"  {progress}% complete...")

            line = line.strip()
            if not line:
                continue

            parts = line.split()
            if not parts:
                continue

            try:
                row_code = int(parts[0])
            except ValueError:
                continue

            # Airport header
            if row_code in (1, 16, 17):
                # Save previous airport if it has pavements
                if current_airport and current_airport.pavements:
                    airports[current_airport.icao] = current_airport

                # Start new airport
                if len(parts) >= 5:
                    current_airport = AirportSurfaces(
                        icao=parts[4],
                        name=' '.join(parts[5:]) if len(parts) > 5 else '',
                        elevation_ft=int(parts[1]) if parts[1].lstrip('-').isdigit() else 0,
                    )
                else:
                    current_airport = None

                current_pavement = None
                current_vertices = []
                current_holes = []
                in_hole = False

            # Pavement header (row 110)
            elif row_code == 110 and current_airport:
                # Save previous pavement if exists
                if current_pavement and current_vertices:
                    current_pavement.vertices = current_vertices
                    current_pavement.holes = current_holes
                    current_airport.pavements.append(current_pavement)

                # Start new pavement
                # Format: 110 surface_code smoothness edge_lighting
                surface_code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
                surface_type = categorize_surface(surface_code)

                # Skip transparent surfaces
                if surface_type == 'transparent':
                    current_pavement = None
                else:
                    current_pavement = PavementPolygon(surface=surface_type, vertices=[], holes=[])

                current_vertices = []
                current_holes = []
                in_hole = False

            # Pavement boundary nodes (111-116)
            elif row_code in (111, 112, 113, 114, 115, 116) and current_pavement:
                # Format: 111 lat lon [bezier_lat bezier_lon] [line_code...]
                if len(parts) >= 3:
                    try:
                        lat = float(parts[1])
                        lon = float(parts[2])

                        if in_hole:
                            if current_holes:
                                current_holes[-1].append([lon, lat])
                        else:
                            current_vertices.append([lon, lat])

                        # 113/114 = close loop and start hole (or end pavement)
                        if row_code in (113, 114):
                            if not in_hole:
                                # First boundary complete, start collecting holes
                                in_hole = True
                                current_holes.append([])
                            else:
                                # Hole complete, start another
                                current_holes.append([])

                        # 115/116 = end (terminates current ring)
                        elif row_code in (115, 116):
                            if in_hole and current_holes and not current_holes[-1]:
                                # Empty hole started, remove it
                                current_holes.pop()
                    except (ValueError, IndexError):
                        pass

            # End of airport data (row 99 or new airport)
            elif row_code == 99:
                # Save current pavement
                if current_pavement and current_vertices:
                    current_pavement.vertices = current_vertices
                    current_pavement.holes = [h for h in current_holes if h]  # Remove empty holes
                    current_airport.pavements.append(current_pavement)

                # Save airport
                if current_airport and current_airport.pavements:
                    airports[current_airport.icao] = current_airport

                current_airport = None
                current_pavement = None

    # Don't forget last airport
    if current_pavement and current_vertices:
        current_pavement.vertices = current_vertices
        current_pavement.holes = [h for h in current_holes if h]
        current_airport.pavements.append(current_pavement)

    if current_airport and current_airport.pavements:
        airports[current_airport.icao] = current_airport

    elapsed = time.time() - start_time
    print(f"Parsed {len(airports)} airports with pavement data in {elapsed:.1f}s")

    return airports

# =============================================================================
# Output generation
# =============================================================================

def round_coords(vertices: list) -> list:
    """Round coordinate precision to save space"""
    return [[round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)] for lon, lat in vertices]

def generate_output(airports: dict[str, AirportSurfaces]) -> dict:
    """Generate the output JSON structure"""
    output = {
        "_meta": {
            "version": 1,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "X-Plane apt.dat",
            "airport_count": len(airports),
            "license": "GNU GPL - X-Plane airport data is free to redistribute with copyright notice intact"
        },
        "airports": {}
    }

    total_pavements = 0

    for icao, airport in airports.items():
        # Convert to serializable format
        pavements = []
        for p in airport.pavements:
            # Round coordinates to save space
            rounded_vertices = round_coords(p.vertices)

            pavement_data = {
                "s": p.surface[0],  # Just first letter: a=asphalt, c=concrete, g=grass, etc.
                "v": rounded_vertices
            }

            # Only include holes if they have actual vertices
            valid_holes = [round_coords(h) for h in p.holes if h and len(h) >= 3]
            if valid_holes:
                pavement_data["h"] = valid_holes

            pavements.append(pavement_data)

        output["airports"][icao] = {
            "n": airport.name,
            "e": airport.elevation_ft,
            "p": pavements
        }
        total_pavements += len(pavements)

    output["_meta"]["total_pavements"] = total_pavements

    return output

# =============================================================================
# Memo management
# =============================================================================

def get_file_memo(path: Path) -> dict:
    """Get memoization data for a file"""
    stat = path.stat()
    return {
        "path": str(path),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "mtime_str": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime))
    }

def load_memo() -> Optional[dict]:
    """Load the memo file if it exists"""
    if MEMO_FILE.exists():
        try:
            with open(MEMO_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return None

def save_memo(apt_dat_path: Path):
    """Save memo file with current apt.dat info"""
    memo = {
        "apt_dat": get_file_memo(apt_dat_path),
        "extracted": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    }
    with open(MEMO_FILE, 'w') as f:
        json.dump(memo, f, indent=2)
    print(f"Saved memo to {MEMO_FILE}")

def needs_extraction(apt_dat_path: Path, force: bool = False) -> bool:
    """Check if we need to re-extract data"""
    if force:
        print("Force flag set, will re-extract")
        return True

    if not OUTPUT_FILE.exists():
        print(f"Output file {OUTPUT_FILE} doesn't exist, will extract")
        return True

    memo = load_memo()
    if not memo:
        print("No memo file found, will extract")
        return True

    current = get_file_memo(apt_dat_path)
    previous = memo.get("apt_dat", {})

    if current["size"] != previous.get("size"):
        print(f"apt.dat size changed: {previous.get('size')} -> {current['size']}")
        return True

    if current["mtime"] != previous.get("mtime"):
        print(f"apt.dat modified: {previous.get('mtime_str')} -> {current['mtime_str']}")
        return True

    print(f"apt.dat unchanged (size={current['size']}, modified={current['mtime_str']})")
    return False

# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser(description="Extract airport surface data from X-Plane apt.dat")
    parser.add_argument("--force", action="store_true", help="Force re-extraction")
    parser.add_argument("--apt-dat", type=Path, help="Path to apt.dat file")
    args = parser.parse_args()

    # Find apt.dat
    apt_dat_path = args.apt_dat
    if not apt_dat_path:
        apt_dat_path = find_apt_dat()

    if not apt_dat_path or not apt_dat_path.exists():
        print("ERROR: Could not find apt.dat file")
        print("Tried locations:")
        for p in APT_DAT_PATHS:
            print(f"  {p}")
        print("\nUse --apt-dat to specify the path manually")
        sys.exit(1)

    print(f"Using apt.dat: {apt_dat_path}")

    # Check if extraction needed
    if not needs_extraction(apt_dat_path, args.force):
        print("Skipping extraction (apt.dat unchanged)")
        print(f"Existing output: {OUTPUT_FILE}")
        return

    # Parse apt.dat
    airports = parse_apt_dat(apt_dat_path)

    if not airports:
        print("ERROR: No airports with pavement data found")
        sys.exit(1)

    # Generate output
    output = generate_output(airports)

    # Write gzip compressed output
    print(f"\nWriting output to {OUTPUT_FILE}")
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)

    json_bytes = json.dumps(output, separators=(',', ':')).encode('utf-8')
    uncompressed_size = len(json_bytes)

    with gzip.open(OUTPUT_FILE, 'wb', compresslevel=9) as f:
        f.write(json_bytes)

    output_size = OUTPUT_FILE.stat().st_size
    compression_ratio = uncompressed_size / output_size
    print(f"Uncompressed: {uncompressed_size / 1024 / 1024:.1f} MB")
    print(f"Compressed:   {output_size / 1024 / 1024:.1f} MB ({compression_ratio:.1f}x compression)")

    # Also write a pretty version for debugging (optional, can remove later)
    debug_file = OUTPUT_FILE.with_name('airport-surfaces.debug.json')
    with open(debug_file, 'w', encoding='utf-8') as f:
        # Just write metadata + a few sample airports
        sample_keys = ['KJFK', 'KLAX', 'EGLL', 'KATL', 'KDEN']
        sample = {
            "_meta": output["_meta"],
            "_key_format": {
                "s": "surface (a=asphalt, c=concrete, g=grass, d=dirt, r=gravel, l=lakebed, w=water, n=snow, o=other)",
                "v": "vertices [[lon,lat],...]",
                "h": "holes (optional) [[[lon,lat],...],...]",
                "n": "name",
                "e": "elevation_ft",
                "p": "pavements"
            },
            "airports": {k: output["airports"][k] for k in sample_keys if k in output["airports"]}
        }
        json.dump(sample, f, indent=2)
    print(f"Debug sample: {debug_file}")

    # Save memo
    save_memo(apt_dat_path)

    # Summary
    print(f"\n{'='*60}")
    print("EXTRACTION COMPLETE")
    print(f"{'='*60}")
    print(f"Airports: {output['_meta']['airport_count']}")
    print(f"Total pavements: {output['_meta']['total_pavements']}")
    print(f"Output: {OUTPUT_FILE} ({output_size / 1024 / 1024:.1f} MB)")

if __name__ == "__main__":
    main()
