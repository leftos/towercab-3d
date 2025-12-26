#!/usr/bin/env python3
"""
Generate tower positions by combining:
- FAA DOF (tower existence + heights)
- vNAS API (refined positions + headings)
- OurAirports (runway data for heading estimation)
- mwgg/Airports (ICAO code mapping)

Usage:
    python scripts/scrape-tower-positions.py [--dof-path PATH]

Requires:
    pip install requests
"""

import argparse
import csv
import json
import math
import time
from io import StringIO
from pathlib import Path

try:
    import requests
except ImportError:
    print("Error: requests library required. Install with: pip install requests")
    exit(1)

# Configuration
ARTCCS = [
    "ZAB", "ZAN", "ZAU", "ZBW", "ZDC", "ZDV", "ZFW", "ZHU", "ZID", "ZJX", "ZKC",
    "ZLA", "ZLC", "ZMA", "ZME", "ZMP", "ZNY", "ZOA", "ZOB", "ZSE", "ZTL", "ZHN"
]
DEFAULT_DOF_PATH = Path("X:/Downloads/DOF_251026/DOF.DAT")
AIRPORTS_URL = "https://raw.githubusercontent.com/mwgg/Airports/master/airports.json"
RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
VNAS_MATCH_RADIUS = 500    # meters - for matching vNAS to DOF
AIRPORT_MATCH_RADIUS = 3000  # meters - for matching DOF to airport ICAO

# Caching
CACHE_DIR = Path(__file__).parent / ".cache"


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance in meters between two points."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1-a))


def calculate_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate initial bearing from point 1 to point 2 in degrees (0-360)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlam = math.radians(lon2 - lon1)
    x = math.sin(dlam) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlam)
    bearing = math.degrees(math.atan2(x, y))
    return (bearing + 360) % 360


def download_cached(url: str, filename: str) -> str:
    """Download file with local caching."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / filename
    if cache_path.exists():
        print(f"  Using cached {filename}")
        return cache_path.read_text(encoding='utf-8')
    print(f"  Downloading {filename}...")
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    cache_path.write_text(resp.text, encoding='utf-8')
    return resp.text


def parse_dof(path: Path) -> list[dict]:
    """Parse DOF for CTRL TWR entries."""
    if not path.exists():
        print(f"Error: DOF file not found at {path}")
        print("Download from: https://www.faa.gov/air_traffic/flight_info/aeronav/obst_data/")
        exit(1)

    towers = []
    with open(path, 'r', encoding='latin-1') as f:
        for line in f:
            if 'CTRL TWR' not in line:
                continue
            try:
                city = line[18:34].strip()
                lat = int(line[35:37]) + int(line[38:40])/60 + float(line[41:46])/3600
                if line[46] == 'S': lat = -lat
                lon = int(line[48:51]) + int(line[52:54])/60 + float(line[55:60])/3600
                if line[60] == 'W': lon = -lon
                agl_ft = int(line[83:88])
                towers.append({
                    'city': city,
                    'lat': lat,
                    'lon': lon,
                    'agl_m': agl_ft * 0.3048
                })
            except (ValueError, IndexError) as e:
                # Skip malformed lines
                continue
    return towers


def load_airports() -> dict:
    """Load airport database, indexed by ICAO."""
    data = download_cached(AIRPORTS_URL, "airports.json")
    return json.loads(data)


def load_runways() -> dict[str, list]:
    """Load runway data with threshold positions, indexed by airport ICAO."""
    data = download_cached(RUNWAYS_URL, "runways.csv")
    runways_by_icao: dict[str, list] = {}
    reader = csv.DictReader(StringIO(data))
    for row in reader:
        icao = row.get('airport_ident', '').upper()
        if not icao:
            continue
        try:
            length = float(row.get('length_ft', 0) or 0)
            if length <= 0:
                continue
            # Get both threshold positions
            le_lat = row.get('le_latitude_deg', '')
            le_lon = row.get('le_longitude_deg', '')
            he_lat = row.get('he_latitude_deg', '')
            he_lon = row.get('he_longitude_deg', '')

            thresholds = []
            if le_lat and le_lon:
                thresholds.append({'lat': float(le_lat), 'lon': float(le_lon)})
            if he_lat and he_lon:
                thresholds.append({'lat': float(he_lat), 'lon': float(he_lon)})

            if thresholds:
                runways_by_icao.setdefault(icao, []).append({
                    'length': length,
                    'thresholds': thresholds
                })
        except ValueError:
            continue
    return runways_by_icao


def fetch_vnas_towers() -> dict:
    """Fetch all tower positions from vNAS ARTCCs."""
    towers = {}
    for artcc in ARTCCS:
        print(f"  Fetching {artcc}...")
        try:
            resp = requests.get(
                f"https://data-api.vnas.vatsim.net/api/artccs/{artcc}",
                timeout=30
            )
            resp.raise_for_status()
            data = resp.json()
            # API returns {"facility": {...}} wrapper
            if "facility" in data:
                extract_vnas_towers(data["facility"], towers)
            else:
                extract_vnas_towers(data, towers)
        except Exception as e:
            print(f"    Error: {e}")
        time.sleep(0.3)
    return towers


def extract_vnas_towers(facility: dict, towers: dict) -> None:
    """Recursively extract towerCabConfiguration."""
    if "towerCabConfiguration" in facility:
        cfg = facility["towerCabConfiguration"]
        if "towerLocation" in cfg:
            towers[facility["id"]] = {
                "lat": cfg["towerLocation"]["lat"],
                "lon": cfg["towerLocation"]["lon"],
                "heading": cfg.get("defaultRotation", None),
                "zoomRange": cfg.get("defaultZoomRange", None)  # NM for 2D view
            }
    for child in facility.get("childFacilities", []):
        extract_vnas_towers(child, towers)


def find_nearest(
    lat: float,
    lon: float,
    items: list,
    radius: float,
    key_lat: str = 'lat',
    key_lon: str = 'lon'
) -> tuple[dict | None, float]:
    """Find nearest item within radius."""
    best, best_dist = None, float('inf')
    for item in items:
        d = haversine(lat, lon, item[key_lat], item[key_lon])
        if d < best_dist and d <= radius:
            best, best_dist = item, d
    return best, best_dist


def estimate_heading_from_runways(
    tower_lat: float,
    tower_lon: float,
    runways: list
) -> float | None:
    """
    Estimate tower heading by pointing at the approach end of the longest runway.
    Picks the threshold further from the tower for a longer approach view.
    """
    if not runways:
        return None

    longest = max(runways, key=lambda r: r['length'])
    thresholds = longest.get('thresholds', [])

    if not thresholds:
        return None

    # Find the threshold furthest from the tower (gives longer approach view)
    best_threshold = None
    best_dist = -1
    for t in thresholds:
        dist = haversine(tower_lat, tower_lon, t['lat'], t['lon'])
        if dist > best_dist:
            best_dist = dist
            best_threshold = t

    if best_threshold:
        return calculate_bearing(
            tower_lat, tower_lon,
            best_threshold['lat'], best_threshold['lon']
        )
    return None


def main():
    parser = argparse.ArgumentParser(
        description="Generate tower positions from FAA DOF, vNAS, and OurAirports data"
    )
    parser.add_argument(
        '--dof-path',
        type=Path,
        default=DEFAULT_DOF_PATH,
        help=f"Path to DOF.DAT file (default: {DEFAULT_DOF_PATH})"
    )
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path("mods/tower-positions"),
        help="Output directory for tower position JSON files"
    )
    parser.add_argument(
        '--force',
        action='store_true',
        help="Overwrite existing tower position files"
    )
    args = parser.parse_args()

    print("Loading data sources...")

    # Parse DOF
    dof_towers = parse_dof(args.dof_path)
    print(f"  DOF: {len(dof_towers)} control towers")

    # Load airports
    airports = load_airports()
    airport_list = [
        {'icao': k, 'lat': v['lat'], 'lon': v['lon']}
        for k, v in airports.items()
    ]
    print(f"  Airports: {len(airport_list)}")

    # Load runways
    runways = load_runways()
    print(f"  Runways: {len(runways)} airports with runway data")

    # Fetch vNAS towers
    print("Fetching vNAS tower data...")
    vnas_towers = fetch_vnas_towers()
    print(f"  vNAS: {len(vnas_towers)} towers")

    # Process each DOF tower
    print("\nProcessing towers...")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    stats = {
        'written': 0,
        'skipped': 0,
        'vnas_match': 0,
        'vnas_2d_heading': 0,
        'runway_heading': 0,
        'no_airport': 0
    }

    for dof in dof_towers:
        # Find nearest airport to get ICAO code
        airport, dist = find_nearest(
            dof['lat'], dof['lon'],
            airport_list,
            AIRPORT_MATCH_RADIUS
        )
        if not airport:
            stats['no_airport'] += 1
            continue

        icao = airport['icao']
        path = args.output_dir / f"{icao}.json"

        if path.exists() and not args.force:
            stats['skipped'] += 1
            continue

        # Check for vNAS match (better position precision + 2D view heading)
        # vNAS uses 3-letter codes (SFO), airports use 4-letter ICAOs (KSFO)
        vnas = vnas_towers.get(icao)
        if not vnas and icao.startswith('K') and len(icao) == 4:
            # Try without K prefix for US airports
            vnas = vnas_towers.get(icao[1:])

        vnas_heading = None
        vnas_zoom = None
        if vnas and haversine(dof['lat'], dof['lon'], vnas['lat'], vnas['lon']) <= VNAS_MATCH_RADIUS:
            lat, lon = vnas['lat'], vnas['lon']
            vnas_heading = vnas.get('heading')  # For 2D view rotation
            vnas_zoom = vnas.get('zoomRange')  # For 2D view altitude
            stats['vnas_match'] += 1
        else:
            lat, lon = dof['lat'], dof['lon']

        # Calculate 3D heading by pointing at approach end of longest runway
        heading_3d = estimate_heading_from_runways(lat, lon, runways.get(icao, []))
        if heading_3d is not None:
            stats['runway_heading'] += 1
        else:
            heading_3d = 0  # Final fallback

        position: dict = {
            "view3d": {
                "lat": lat,
                "lon": lon,
                "aglHeight": round(dof['agl_m'], 1),
                "heading": round(heading_3d, 1)
            }
        }

        # Add 2D view defaults if vNAS data is available
        if vnas_heading is not None or vnas_zoom is not None:
            view2d: dict = {}
            if vnas_heading is not None:
                view2d["heading"] = round(vnas_heading, 1)
            if vnas_zoom is not None:
                # Store raw vNAS range value - converted to altitude at runtime
                view2d["vNasRange"] = round(vnas_zoom, 1)
            position["view2d"] = view2d
            stats['vnas_2d_heading'] += 1

        path.write_text(json.dumps(position, indent=2))
        stats['written'] += 1

    print(f"\nResults:")
    print(f"  Written: {stats['written']}")
    print(f"  Skipped (existing): {stats['skipped']}")
    print(f"  vNAS position: {stats['vnas_match']}")
    print(f"  vNAS 2D heading: {stats['vnas_2d_heading']}")
    print(f"  Runway-based 3D heading: {stats['runway_heading']}")
    print(f"  No airport match: {stats['no_airport']}")


if __name__ == "__main__":
    main()
