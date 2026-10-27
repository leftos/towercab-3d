#!/usr/bin/env python3
"""
Extract building outline tags and aerodrome boundaries from the OSM planet

Some OSM building parts belong to a grouping relation (type=building) whose
outline member is missing from the Cesium ion OSM Buildings tileset, so the
part carries only its relation's tags. This script builds a table mapping each
such relation near a towered airport to its outline's rule tags, and the OSM
aerodrome boundary of every towered airport (an ICAO with a file in
src-tauri/resources/tower-positions/).

Outputs:
    src/renderer/data/buildingOutlines.json   (bundled into the frontend build, Biome-formatted)
    src-tauri/resources/aerodromes.json.gz    (gzip compressed)

Usage:
    uv run --no-project --python 3.12 --with osmium python \
        scripts/shipping/data-generation/extract-airport-buildings.py [--force] [--planet PBF] [--osmium EXE] [--work DIR]

Options:
    --force       Re-run the osmium filters even if their outputs are newer than the planet
    --planet      Path to the OSM planet .osm.pbf
    --osmium      Path to osmium.exe (osmium-tool)
    --work        Folder for the filtered extracts (created if missing)
"""

import argparse
import gzip
import itertools
import json
import math
import os
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

import osmium

# Coordinate precision (6 decimals = ~10cm accuracy, sufficient for our needs)
COORD_PRECISION = 6

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent.parent  # scripts/shipping/data-generation -> project root
OUTLINES_FILE = PROJECT_ROOT / "src" / "renderer" / "data" / "buildingOutlines.json"
AERODROMES_FILE = PROJECT_ROOT / "src-tauri" / "resources" / "aerodromes.json.gz"
TOWER_POSITIONS_DIR = PROJECT_ROOT / "src-tauri" / "resources" / "tower-positions"

DEFAULT_PLANET = Path(r"X:\dev-data\race-anywhere-cache\osm\planet\planet-261012\planet-261012.osm.pbf")
DEFAULT_OSMIUM = Path(r"X:\dev-data\race-anywhere-cache\tools\osmium-tool-1.19.1\Library\bin\osmium.exe")
DEFAULT_WORK = Path(r"X:\dev-data\race-anywhere-cache\osm\planet\planet-261012\tc3d-218")

META = {
    "source": "OpenStreetMap planet 2026-10-12 (planet-261012)",
    "licence": "ODbL 1.0, © OpenStreetMap contributors",
    "generator": "scripts/shipping/data-generation/extract-airport-buildings.py",
}

# Outline tags the facade style's rules read; the table carries exactly these.
RULE_KEYS = ("building", "aeroway", "amenity", "parking", "building:levels", "height")
# Any of these on an outline types it; `building` types it only when not `yes`.
TYPING_KEYS = ("aeroway", "amenity", "parking")

# =============================================================================
# Geometry
# =============================================================================


def round_ring(ring: list[tuple[float, float]]) -> list[list[float]]:
    """Round a ring's [lon, lat] points to COORD_PRECISION and make sure it is closed."""
    rounded = [[round(lon, COORD_PRECISION), round(lat, COORD_PRECISION)] for lon, lat in ring]
    if rounded and rounded[0] != rounded[-1]:
        rounded.append(list(rounded[0]))
    return rounded


def ring_area(ring: list[tuple[float, float]]) -> float:
    """Approximate ring area in square metres (shoelace on an equirectangular projection)."""
    if len(ring) < 3:
        return 0.0
    mean_lat = sum(lat for _, lat in ring) / len(ring)
    x_scale = 111_320.0 * math.cos(math.radians(mean_lat))
    y_scale = 110_540.0
    twice = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(ring, ring[1:] + ring[:1]):
        twice += (lon1 * x_scale) * (lat2 * y_scale) - (lon2 * x_scale) * (lat1 * y_scale)
    return abs(twice) / 2.0


def point_in_ring(lon: float, lat: float, ring: list) -> bool:
    """Ray-casting point-in-polygon test for one closed [lon, lat] ring."""
    inside = False
    for (x1, y1), (x2, y2) in itertools.pairwise(ring):
        if (y1 > lat) != (y2 > lat):
            x_cross = x1 + (lat - y1) * (x2 - x1) / (y2 - y1)
            if lon < x_cross:
                inside = not inside
    return inside


def point_in_boundary(lon: float, lat: float, boundary: dict) -> bool:
    """True when the point lies in a polygon's outer ring and in none of that polygon's holes."""
    for polygon in boundary["polygons"]:
        if point_in_ring(lon, lat, polygon["outer"]) and not any(point_in_ring(lon, lat, hole) for hole in polygon.get("holes", ())):
            return True
    return False


class BoundaryIndex:
    """Finds whether a point is inside any aerodrome boundary, using a one-degree grid of bounding boxes."""

    def __init__(self, boundaries: dict[str, dict]):
        self._cells: dict[tuple[int, int], list[tuple[tuple[float, float, float, float], dict]]] = {}
        for boundary in boundaries.values():
            points = [pt for polygon in boundary["polygons"] for pt in polygon["outer"]]
            bbox = (
                min(p[0] for p in points),
                min(p[1] for p in points),
                max(p[0] for p in points),
                max(p[1] for p in points),
            )
            for cx in range(math.floor(bbox[0]), math.floor(bbox[2]) + 1):
                for cy in range(math.floor(bbox[1]), math.floor(bbox[3]) + 1):
                    self._cells.setdefault((cx, cy), []).append((bbox, boundary))

    def contains(self, lon: float, lat: float) -> bool:
        """Whether the point lies inside any indexed aerodrome boundary.

        Args:
            lon: Longitude in degrees.
            lat: Latitude in degrees.

        Returns:
            True when the point is inside one of the boundaries.
        """
        for bbox, boundary in self._cells.get((math.floor(lon), math.floor(lat)), ()):
            if bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3] and point_in_boundary(lon, lat, boundary):
                return True
        return False


# =============================================================================
# Aerodrome boundaries
# =============================================================================


# A ring's (lon, lat) points; and one area polygon as its outer ring with the holes inside it.
LatLonRing = list[tuple[float, float]]
AreaPolygon = tuple[LatLonRing, list[LatLonRing]]


def _valid_points(nodes) -> tuple[LatLonRing, int]:
    """The (lon, lat) of the nodes with a valid location, and how many locations were invalid."""
    points: LatLonRing = []
    invalid = 0
    for node in nodes:
        if node.location.valid():
            points.append((node.lon, node.lat))
        else:
            invalid += 1
    return points, invalid


def _area_rings(area) -> tuple[list[AreaPolygon], int]:
    """An area's polygons and its invalid node locations.

    Args:
        area: An area assembled by pyosmium.

    Returns:
        (polygons, invalid): each outer ring with the inner rings inside it, each a (lon, lat)
        point list with the nodes whose location is invalid left out, and how many node locations
        were left out.
    """
    polygons: list[AreaPolygon] = []
    invalid = 0
    for outer in area.outer_rings():
        outer_points, dropped = _valid_points(outer)
        invalid += dropped
        holes: list[LatLonRing] = []
        for inner in area.inner_rings(outer):
            hole_points, dropped = _valid_points(inner)
            holes.append(hole_points)
            invalid += dropped
        polygons.append((outer_points, holes))
    return polygons, invalid


def _polygon_json(outer: LatLonRing, holes: list[LatLonRing]) -> dict:
    """One boundary polygon as JSON: the rounded outer ring, and the holes only when it has any."""
    polygon = {"outer": round_ring(outer)}
    if holes:
        polygon["holes"] = [round_ring(hole) for hole in holes]
    return polygon


def _area_icao_keys(tags) -> tuple[str | None, str | None]:
    icao = tags.get("icao")
    ref_icao = tags.get("ref:icao")
    return (icao.strip().upper() if icao else None, ref_icao.strip().upper() if ref_icao else None)


def read_aerodromes(path: Path, icaos: set[str]) -> tuple[dict[str, dict], list[str], int]:
    """Read the aeroway=aerodrome areas of an OSM file and pick one boundary per ICAO in `icaos`.

    An area whose `icao` tag equals the ICAO wins over one whose `ref:icao` does; among several
    matches of the winning kind the largest area wins.

    Args:
        path: The OSM file holding the aeroway=aerodrome areas.
        icaos: The ICAO codes to find a boundary for.

    Returns:
        (boundaries, duplicates, dropped): ICAO -> {"polygons": [{"outer": ring, "holes"?: [ring]}]},
        each polygon's outer ring with its own holes, rings as closed, rounded [lon, lat] lists; the
        sorted ICAOs that had several matches of the winning kind; and how many node locations were
        dropped from the rings as invalid.
    """
    by_icao: dict[str, list[tuple[float, int, list[AreaPolygon]]]] = {}
    by_ref: dict[str, list[tuple[float, int, list[AreaPolygon]]]] = {}
    dropped = 0
    for obj in osmium.FileProcessor(str(path)).with_areas():
        if not obj.is_area() or obj.tags.get("aeroway") != "aerodrome":
            continue
        icao, ref_icao = _area_icao_keys(obj.tags)
        if icao not in icaos and ref_icao not in icaos:
            continue
        polygons, invalid = _area_rings(obj)
        dropped += invalid
        size = sum(ring_area(outer) for outer, _ in polygons) - sum(ring_area(hole) for _, holes in polygons for hole in holes)
        candidate = (size, obj.id, polygons)
        if icao in icaos:
            by_icao.setdefault(icao, []).append(candidate)
        if ref_icao in icaos:
            by_ref.setdefault(ref_icao, []).append(candidate)

    boundaries: dict[str, dict] = {}
    duplicates: list[str] = []
    for icao in sorted(set(by_icao) | set(by_ref)):
        candidates = by_icao.get(icao) or by_ref[icao]
        if len(candidates) > 1:
            duplicates.append(icao)
        # Largest area first; equal areas fall back to the lower area id so the choice is stable.
        _, _, polygons = max(candidates, key=lambda c: (c[0], -c[1]))
        boundaries[icao] = {"polygons": [_polygon_json(outer, holes) for outer, holes in polygons]}
    return boundaries, duplicates, dropped


# =============================================================================
# Building outline relations
# =============================================================================


def _rule_tags(tags) -> dict[str, str]:
    return {k: tags[k] for k in RULE_KEYS if k in tags}


def _is_typed(rule_tags: dict[str, str]) -> bool:
    if any(k in rule_tags for k in TYPING_KEYS):
        return True
    return rule_tags.get("building", "yes") != "yes"


class _BuildingFile:
    """What one pass over the building-relations extract keeps: tags, way positions and grouping members."""

    def __init__(self):
        self.way_tags: dict[int, dict[str, str]] = {}
        self.relation_tags: dict[int, dict[str, str]] = {}
        self.inside_ways: set[int] = set()
        self.groups: dict[int, tuple[list[tuple[str, int]], list[int]]] = {}

    def read(self, path: Path, index: BoundaryIndex) -> None:
        for obj in osmium.FileProcessor(str(path)).with_locations():
            if obj.is_way():
                self.way_tags[obj.id] = _rule_tags(obj.tags)
                if any(n.location.valid() and index.contains(n.lon, n.lat) for n in obj.nodes):
                    self.inside_ways.add(obj.id)
            elif obj.is_relation():
                self.relation_tags[obj.id] = _rule_tags(obj.tags)
                if obj.tags.get("type") == "building":
                    outlines = [(m.type, m.ref) for m in obj.members if m.role == "outline"]
                    parts = [m.ref for m in obj.members if m.role == "part" and m.type == "w"]
                    self.groups[obj.id] = (outlines, parts)

    def outline_tags(self, member: tuple[str, int]) -> dict[str, str] | None:
        member_type, ref = member
        if member_type == "w":
            return self.way_tags.get(ref)
        if member_type == "r":
            return self.relation_tags.get(ref)
        return None

    def classify(self, outlines: list[tuple[str, int]], parts: list[int]) -> tuple[str, dict[str, str] | None]:
        if not outlines:
            return "no_outline", None
        if len(outlines) > 1:
            return "several_outlines", None
        tags = self.outline_tags(outlines[0])
        if tags is None:
            return "outline_missing", None
        if not _is_typed(tags):
            return "outline_untyped", None
        if not parts:
            return "no_part_ways", None
        if not any(ref in self.inside_ways for ref in parts):
            return "outside_boundaries", None
        return "kept", tags


def read_outline_relations(path: Path, boundaries: dict[str, dict]) -> tuple[dict[str, dict[str, str]], Counter]:
    """Build the outline table from an extract of type=building relations and their members.

    A relation is kept when it has exactly one `outline` member, that outline is typed (it carries
    aeroway, amenity, parking, or a building value other than yes), and at least one `part` member
    way has a node inside one of `boundaries`.

    Args:
        path: The OSM file holding the type=building relations and their members.
        boundaries: ICAO -> boundary, as returned by `read_aerodromes`.

    Returns:
        (relations, counts): relation id as a string -> the outline's RULE_KEYS tags; and the number
        of relations per outcome (kept, no_outline, several_outlines, outline_missing,
        outline_untyped, no_part_ways, outside_boundaries).
    """
    data = _BuildingFile()
    data.read(path, BoundaryIndex(boundaries))
    relations: dict[str, dict[str, str]] = {}
    counts: Counter = Counter()
    for rel_id, (outlines, parts) in data.groups.items():
        outcome, tags = data.classify(outlines, parts)
        counts[outcome] += 1
        if tags is not None:
            relations[str(rel_id)] = tags
    return relations, counts


# =============================================================================
# Pipeline
# =============================================================================


def load_towered_icaos(directory: Path) -> set[str]:
    """ICAO codes named by the tower position files (`<ICAO>.json`)."""
    icaos = {p.stem.upper() for p in directory.glob("*.json")}
    if not icaos:
        raise SystemExit(f"No tower position files in {directory}; expected <ICAO>.json files")
    return icaos


def run_filter(osmium_exe: Path, planet: Path, expression: str, output: Path, force: bool) -> None:
    """Run `osmium tags-filter` unless its output is already newer than the planet.

    The filter writes to `<output name>.partial` and that file is moved onto `output` only after
    osmium exits 0, so an interrupted run never leaves a truncated extract for the next run to reuse.

    Args:
        osmium_exe: The osmium-tool executable.
        planet: The planet .osm.pbf to filter.
        expression: The tags-filter expression, e.g. "nwr/aeroway=aerodrome".
        output: The extract path, replaced only when the filter succeeds.
        force: Filter even when `output` is newer than `planet`.
    """
    if not force and output.exists() and output.stat().st_mtime > planet.stat().st_mtime:
        print(f"Skipping {output.name}: newer than the planet (use --force to rebuild)")
        return
    partial = output.with_name(output.name + ".partial")
    print(f"Filtering {expression} -> {output}")
    start = time.time()
    # `-f pbf` because the .partial name has no suffix osmium could infer the output format from.
    command = [
        str(osmium_exe),
        "tags-filter",
        str(planet),
        expression,
        "-f",
        "pbf",
        "-o",
        str(partial),
        "--overwrite",
    ]
    result = subprocess.run(command, check=False)
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        raise subprocess.CalledProcessError(result.returncode, command)
    os.replace(partial, output)
    print(f"  done in {time.time() - start:.0f} s, {output.stat().st_size:,} bytes")


def encode_json(document: dict) -> bytes:
    """Encode a document as compact, sort-keyed UTF-8 JSON.

    Args:
        document: The JSON-serialisable document.

    Returns:
        The UTF-8 bytes, with no indentation and no trailing newline.
    """
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def encode_source_json(document: dict) -> bytes:
    """Encode a JSON file kept under src/ the way Biome formats it (2-space indent, trailing newline)."""
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_outputs(relations: dict, boundaries: dict) -> None:
    """Write the outline table and the gzipped aerodrome boundaries into the repository.

    Args:
        relations: Relation id -> the outline's RULE_KEYS tags.
        boundaries: ICAO -> {"polygons": [{"outer": ring, "holes"?: [ring]}]}.
    """
    outlines = encode_source_json({"_meta": META, "relations": relations})
    OUTLINES_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTLINES_FILE.write_bytes(outlines)
    aerodromes = encode_json({"_meta": META, "airports": boundaries})
    AERODROMES_FILE.write_bytes(gzip.compress(aerodromes, mtime=0))
    print(f"{OUTLINES_FILE.relative_to(PROJECT_ROOT)}: {len(outlines):,} bytes")
    print(f"{AERODROMES_FILE.relative_to(PROJECT_ROOT)}: {AERODROMES_FILE.stat().st_size:,} bytes ({len(aerodromes):,} uncompressed)")


def print_report(icaos: set[str], boundaries: dict, duplicates: list[str], counts: Counter, dropped_nodes: int) -> None:
    """Print the run's counts: airports with and without a boundary, duplicates and grouping outcomes.

    Args:
        icaos: Every towered ICAO.
        boundaries: ICAO -> boundary, for the airports that have one.
        duplicates: ICAOs with several matches, where the largest area was taken.
        counts: Grouping relation outcomes from `read_outline_relations`.
        dropped_nodes: Node locations dropped from the boundary rings as invalid.
    """
    missing = sorted(icaos - set(boundaries))
    print(f"Airports: {len(icaos)} towered, {len(boundaries)} with a boundary, {len(missing)} without")
    print(f"  without a boundary: {' '.join(missing) if missing else 'none'}")
    print(f"  several matches, largest taken: {len(duplicates)} ({' '.join(duplicates) if duplicates else 'none'})")
    print(f"  node locations dropped from boundaries as invalid: {dropped_nodes}")
    print("Grouping relations: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))


def main() -> int:
    """Run both filters and write the outline table and the gzipped aerodrome boundaries.

    Returns:
        The process exit status: 0 on success, 1 when the planet or the osmium executable is missing.
    """
    parser = argparse.ArgumentParser(description="Extract building outline tags and aerodrome boundaries from OSM")
    parser.add_argument("--force", action="store_true", help="Re-run the osmium filters")
    parser.add_argument("--planet", type=Path, default=DEFAULT_PLANET, help="OSM planet .osm.pbf")
    parser.add_argument("--osmium", type=Path, default=DEFAULT_OSMIUM, help="osmium-tool executable")
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK, help="Folder for the filtered extracts")
    args = parser.parse_args()

    for label, path in (("planet", args.planet), ("osmium", args.osmium)):
        if not path.is_file():
            print(f"Error: {label} not found at {path}; pass --{label} <path>", file=sys.stderr)
            return 1
    args.work.mkdir(parents=True, exist_ok=True)
    aerodromes_pbf = args.work / "aerodromes.osm.pbf"
    relations_pbf = args.work / "building-relations.osm.pbf"
    run_filter(args.osmium, args.planet, "nwr/aeroway=aerodrome", aerodromes_pbf, args.force)
    run_filter(args.osmium, args.planet, "r/type=building", relations_pbf, args.force)

    icaos = load_towered_icaos(TOWER_POSITIONS_DIR)
    start = time.time()
    boundaries, duplicates, dropped_nodes = read_aerodromes(aerodromes_pbf, icaos)
    print(f"Read aerodromes in {time.time() - start:.0f} s")
    start = time.time()
    relations, counts = read_outline_relations(relations_pbf, boundaries)
    print(f"Read building relations in {time.time() - start:.0f} s")

    write_outputs(relations, boundaries)
    print_report(icaos, boundaries, duplicates, counts, dropped_nodes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
