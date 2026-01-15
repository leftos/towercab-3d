#!/usr/bin/env python3
"""
GLB Source Lookup Tool

Given a converted GLB filename, finds the original MSFS source files.
Uses the same discovery logic as msfs.rs and convert_fsltl_batch.py.

Usage:
    python lookup_glb_source.py "aig_AIGAIM_United Airlines Boeing 737 MAX 8.glb"
    python lookup_glb_source.py "fsltl_FSLTL_FAIB_B738_American.glb"

    # With custom community path:
    python lookup_glb_source.py --community "D:/MSFS/Community" "aig_AIGAIM_United Airlines Boeing 737 MAX 8.glb"

    # Dump full GLTF structure:
    python lookup_glb_source.py --dump-gltf "X:/path/to/model.glb"
"""

import argparse
import json
import struct
import sys
from pathlib import Path


# Default community folder paths to search
DEFAULT_COMMUNITY_PATHS = [
    Path("D:/MSFS/Community"),
    Path("X:/Games/MSFlightSimPackages2024/Community"),
    Path("C:/MSFS/Community"),
]


def parse_glb_filename(filename: str) -> dict:
    """
    Parse a converted GLB filename to extract source info.

    Format: {source}_{liveryTitle}.glb
    Examples:
        - aig_AIGAIM_United Airlines Boeing 737 MAX 8.glb
        - fsltl_FSLTL_FAIB_B738_American.glb

    Returns dict with:
        - source: "fsltl" or "aig"
        - livery_title: The full livery title from aircraft.cfg
    """
    # Remove .glb extension
    name = filename
    if name.lower().endswith('.glb'):
        name = name[:-4]

    # Split on first underscore to get source prefix
    if name.startswith('aig_'):
        return {
            'source': 'aig',
            'livery_title': name[4:]  # Everything after "aig_"
        }
    elif name.startswith('fsltl_'):
        return {
            'source': 'fsltl',
            'livery_title': name[6:]  # Everything after "fsltl_"
        }
    else:
        return {
            'source': 'unknown',
            'livery_title': name
        }


def parse_aircraft_cfg_all_liveries(aircraft_dir: Path) -> list[dict]:
    """
    Parse FLTSIM sections from aircraft.cfg.
    Returns list of dicts with: title, texture_folder, icao_airline, icao_type

    Mirrors the Rust function in msfs.rs
    """
    cfg_path = aircraft_dir / "aircraft.cfg"
    if not cfg_path.exists():
        return []

    liveries = []
    icao_type = None

    try:
        content = cfg_path.read_text(encoding='utf-8', errors='ignore')
        in_fltsim = False
        in_general = False
        current_livery = {}

        for line in content.splitlines():
            trimmed = line.strip()

            # Check for section headers
            if trimmed.startswith('['):
                # Save previous livery if complete
                if in_fltsim and current_livery.get('title') and current_livery.get('texture_folder'):
                    current_livery['icao_type'] = icao_type
                    liveries.append(current_livery)

                upper = trimmed.upper()
                in_fltsim = upper.startswith('[FLTSIM')
                in_general = upper == '[GENERAL]'
                current_livery = {}
                continue

            if '=' not in trimmed:
                continue

            key, _, value = trimmed.partition('=')
            key = key.strip().lower()
            value = value.split(';')[0].strip().strip('"').strip("'").strip()

            if in_general:
                if key == 'icao_type_designator':
                    icao_type = value.upper()

            if in_fltsim:
                if key == 'title':
                    current_livery['title'] = value
                elif key == 'texture' and not key.startswith('texture.'):
                    current_livery['texture_folder'] = value
                elif key == 'icao_airline':
                    current_livery['icao_airline'] = value.upper()

        # Don't forget the last section
        if in_fltsim and current_livery.get('title') and current_livery.get('texture_folder'):
            current_livery['icao_type'] = icao_type
            liveries.append(current_livery)

    except Exception as e:
        print(f"  Warning: Error parsing {cfg_path}: {e}")

    return liveries


def find_gltf_in_dir(aircraft_dir: Path) -> Path | None:
    """
    Find GLTF file in an aircraft directory.
    Returns the path to the best exterior GLTF file, or None if not found.
    """
    # Find model.* directories
    model_dirs = [d for d in aircraft_dir.iterdir()
                  if d.is_dir() and d.name.lower().startswith('model')]

    for model_dir in model_dirs:
        # Find all GLTF files
        gltf_files = list(model_dir.glob("*.gltf")) + list(model_dir.glob("*.GLTF"))

        # Filter out interior/cockpit
        exterior = [f for f in gltf_files
                    if 'INTERIOR' not in f.stem.upper() and 'COCKPIT' not in f.stem.upper()]
        if not exterior:
            exterior = gltf_files

        if not exterior:
            continue

        # Sort by LOD (prefer LOD0)
        def lod_key(p: Path):
            name = p.stem.upper()
            if 'LOD00' in name:
                return 0
            if 'LOD01' in name:
                return 1
            if 'LOD0' in name:
                return 0
            if 'LOD1' in name:
                return 1
            if 'LOD2' in name:
                return 2
            if 'LOD3' in name:
                return 3
            return 5

        exterior.sort(key=lod_key)
        return exterior[0]

    return None


def collect_texture_dirs(aircraft_dir: Path) -> list[Path]:
    """Collect texture directories from a folder."""
    return [d for d in aircraft_dir.iterdir()
            if d.is_dir() and (d.name.lower().startswith('texture') or d.name.lower().startswith('oci'))]


def find_source_for_livery(community_path: Path, source: str, livery_title: str) -> dict | None:
    """
    Find the source files for a specific livery.

    Returns dict with:
        - aircraft_folder: Path to the aircraft folder
        - gltf_path: Path to the source GLTF file
        - texture_dirs: List of texture directory paths
        - livery_info: Dict with title, texture_folder, icao_airline, icao_type
    """
    # Determine base path based on source
    if source == 'fsltl':
        base_path = community_path / 'fsltl-traffic-base'
        folder_prefix = 'FSLTL_'
    elif source == 'aig':
        base_path = community_path / 'aig-aitraffic-oci'
        folder_prefix = 'AIGAIM_'
    else:
        return None

    airplanes = base_path / 'SimObjects' / 'Airplanes'
    if not airplanes.exists():
        return None

    # Search through all aircraft folders
    for aircraft_dir in airplanes.iterdir():
        if not aircraft_dir.is_dir():
            continue
        if not aircraft_dir.name.startswith(folder_prefix):
            continue

        # Parse liveries from aircraft.cfg
        liveries = parse_aircraft_cfg_all_liveries(aircraft_dir)

        for livery in liveries:
            if livery['title'] == livery_title:
                # Found it! Now get the GLTF and texture info
                gltf_path = find_gltf_in_dir(aircraft_dir)

                # Get texture directories
                texture_dirs = []

                # Add livery-specific texture folder
                tex_folder = livery.get('texture_folder', '')
                if tex_folder:
                    for prefix in ['texture.', 'Texture.']:
                        tex_path = aircraft_dir / f"{prefix}{tex_folder}"
                        if tex_path.exists():
                            texture_dirs.append(tex_path)
                            break

                # Add shared texture directories (oci.* folders)
                for d in aircraft_dir.iterdir():
                    if d.is_dir() and d.name.lower().startswith('oci'):
                        texture_dirs.append(d)

                return {
                    'aircraft_folder': aircraft_dir,
                    'gltf_path': gltf_path,
                    'texture_dirs': texture_dirs,
                    'livery_info': livery
                }

    return None


def read_glb_gltf(glb_path: Path) -> dict | None:
    """Read and return the GLTF JSON from a GLB file."""
    try:
        with open(glb_path, 'rb') as f:
            # Read header
            magic, version, length = struct.unpack('<4sII', f.read(12))
            if magic != b'glTF':
                print("Error: Not a valid GLB file")
                return None

            # Read JSON chunk
            json_len, json_type = struct.unpack('<II', f.read(8))
            if json_type != 0x4E4F534A:  # "JSON"
                print("Error: First chunk is not JSON")
                return None

            json_bytes = f.read(json_len)
            return json.loads(json_bytes)
    except Exception as e:
        print(f"Error reading GLB: {e}")
        return None


def get_embedded_source_metadata(glb_path: Path) -> dict | None:
    """
    Read TowerCab 3D source metadata embedded in a GLB file.

    Returns the metadata dict if found, or None if not embedded.
    """
    gltf = read_glb_gltf(glb_path)
    if not gltf:
        return None

    asset = gltf.get('asset', {})
    extras = asset.get('extras', {})
    return extras.get('towercab3d')


def dump_node_tree(gltf: dict, node_idx: int, indent: int = 0):
    """Recursively print node hierarchy."""
    nodes = gltf.get('nodes', [])
    if node_idx >= len(nodes):
        return

    node = nodes[node_idx]
    name = node.get('name', f'(unnamed_{node_idx})')
    mesh = node.get('mesh')
    skin = node.get('skin')

    # Build info string
    info_parts = []
    if mesh is not None:
        info_parts.append(f"mesh={mesh}")
    if skin is not None:
        info_parts.append(f"skin={skin}")
    if 'translation' in node:
        t = node['translation']
        if any(abs(v) > 0.001 for v in t):
            info_parts.append(f"t=[{t[0]:.2f},{t[1]:.2f},{t[2]:.2f}]")
    if 'rotation' in node:
        r = node['rotation']
        if any(abs(v) > 0.001 for v in r[:3]) or abs(r[3] - 1.0) > 0.001:
            info_parts.append(f"r=[{r[0]:.3f},{r[1]:.3f},{r[2]:.3f},{r[3]:.3f}]")
    if 'scale' in node:
        s = node['scale']
        if any(abs(v - 1.0) > 0.001 for v in s):
            info_parts.append(f"s=[{s[0]:.2f},{s[1]:.2f},{s[2]:.2f}]")

    info = ' '.join(info_parts)
    prefix = '  ' * indent
    print(f"{prefix}[{node_idx}] {name} {info}")

    for child_idx in node.get('children', []):
        dump_node_tree(gltf, child_idx, indent + 1)


def main():
    parser = argparse.ArgumentParser(
        description='Look up source files for a converted MSFS GLB model',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument('glb_file', help='GLB filename or path to look up')
    parser.add_argument('--community', '-c', type=Path,
                        help='MSFS Community folder path')
    parser.add_argument('--dump-gltf', '-d', action='store_true',
                        help='Dump the GLTF structure from the GLB file')
    parser.add_argument('--dump-nodes', '-n', action='store_true',
                        help='Dump the node hierarchy from the GLB file')
    parser.add_argument('--node', type=int,
                        help='Inspect a specific node by index')

    args = parser.parse_args()

    glb_path = Path(args.glb_file)

    # If dumping GLTF/nodes, just read the GLB and print info
    if args.dump_gltf or args.dump_nodes or args.node is not None:
        if not glb_path.exists():
            print(f"Error: File not found: {glb_path}")
            sys.exit(1)

        gltf = read_glb_gltf(glb_path)
        if not gltf:
            sys.exit(1)

        if args.dump_gltf:
            print(json.dumps(gltf, indent=2))

        if args.dump_nodes:
            print("\n=== Node Hierarchy ===")
            scenes = gltf.get('scenes', [])
            if scenes:
                for root_idx in scenes[0].get('nodes', []):
                    dump_node_tree(gltf, root_idx)

        if args.node is not None:
            nodes = gltf.get('nodes', [])
            if args.node >= len(nodes):
                print(f"Error: Node {args.node} not found (max: {len(nodes)-1})")
                sys.exit(1)

            node = nodes[args.node]
            print(f"\n=== Node {args.node} ===")
            print(json.dumps(node, indent=2))

            # If node has a mesh, show mesh details
            if 'mesh' in node:
                mesh_idx = node['mesh']
                meshes = gltf.get('meshes', [])
                if mesh_idx < len(meshes):
                    mesh = meshes[mesh_idx]
                    print(f"\n=== Mesh {mesh_idx} ===")
                    print(f"Name: {mesh.get('name', '(unnamed)')}")
                    print(f"Primitives: {len(mesh.get('primitives', []))}")
                    for i, prim in enumerate(mesh.get('primitives', [])):
                        print(f"  Primitive {i}:")
                        print(f"    Attributes: {list(prim.get('attributes', {}).keys())}")
                        if 'material' in prim:
                            print(f"    Material: {prim['material']}")

        return

    # Check if the GLB file exists and has embedded metadata
    if glb_path.exists():
        embedded = get_embedded_source_metadata(glb_path)
        if embedded:
            print("=== Embedded Source Metadata (from GLB) ===")
            print(f"Version: {embedded.get('version', 'unknown')}")
            print(f"Source: {embedded.get('source')}")
            print(f"Livery Title: {embedded.get('liveryTitle')}")
            print(f"Folder Name: {embedded.get('folderName')}")
            print(f"Aircraft Type: {embedded.get('aircraftType')}")
            print(f"ICAO Airline: {embedded.get('icaoAirline')}")
            print(f"Aircraft Folder: {embedded.get('aircraftFolder')}")
            print(f"GLTF Path: {embedded.get('gltfPath')}")
            print()
            print("Texture Directories:")
            for tex_dir in embedded.get('textureDirs', []):
                print(f"  - {tex_dir}")
            print()
            print("(Source metadata was embedded during conversion - no lookup needed)")
            return

    # Parse the GLB filename for fallback lookup
    filename = glb_path.name
    info = parse_glb_filename(filename)

    print(f"GLB File: {filename}")
    print(f"Source: {info['source']}")
    print(f"Livery Title: {info['livery_title']}")
    print()
    print("(No embedded metadata found - performing filesystem lookup)")
    print()

    if info['source'] == 'unknown':
        print("Error: Could not determine source type from filename")
        print("Expected format: {source}_{liveryTitle}.glb")
        print("  e.g., aig_AIGAIM_United Airlines Boeing 737 MAX 8.glb")
        print("  e.g., fsltl_FSLTL_FAIB_B738_American.glb")
        sys.exit(1)

    # Find community folder
    community_path = args.community
    if not community_path:
        for path in DEFAULT_COMMUNITY_PATHS:
            if path.exists():
                community_path = path
                break

    if not community_path or not community_path.exists():
        print("Error: Could not find MSFS Community folder")
        print("Use --community to specify the path")
        sys.exit(1)

    print(f"Community Path: {community_path}")
    print()

    # Look up the source
    result = find_source_for_livery(community_path, info['source'], info['livery_title'])

    if not result:
        print("Error: Could not find source files for this livery")
        print(f"Searched in: {community_path}")
        sys.exit(1)

    print("=== Source Files Found (via filesystem lookup) ===")
    print(f"Aircraft Folder: {result['aircraft_folder']}")
    print(f"GLTF Path: {result['gltf_path']}")
    print()
    print("Texture Directories:")
    for tex_dir in result['texture_dirs']:
        print(f"  - {tex_dir}")
    print()
    print("Livery Info:")
    for key, value in result['livery_info'].items():
        print(f"  {key}: {value}")

    # Also show the source GLTF's node structure if requested
    if result['gltf_path'] and result['gltf_path'].exists():
        print("\n=== Source GLTF ===")
        print(f"Path: {result['gltf_path']}")

        # Read and show basic info
        try:
            with open(result['gltf_path'], 'r', encoding='utf-8') as f:
                source_gltf = json.load(f)

            print(f"Nodes: {len(source_gltf.get('nodes', []))}")
            print(f"Meshes: {len(source_gltf.get('meshes', []))}")
            print(f"Materials: {len(source_gltf.get('materials', []))}")
            print(f"Animations: {len(source_gltf.get('animations', []))}")
            print(f"Skins: {len(source_gltf.get('skins', []))}")
            print(f"Extensions Used: {source_gltf.get('extensionsUsed', [])}")
        except Exception as e:
            print(f"Could not read source GLTF: {e}")


if __name__ == '__main__':
    main()
