#!/usr/bin/env python3
"""
FSLTL Batch Converter

Converts FSLTL GLTF models with DDS textures to self-contained GLB files.
Supports batch conversion, texture downscaling, and progress reporting.

Features:
- Batch conversion of multiple models
- Texture downscaling (full, 2k, 1k, 512)
- Progress reporting to JSON file
- Animation detection for landing gear
- Proper output directory structure (TYPE/AIRLINE/model.glb)

Usage:
    python convert_fsltl_batch.py \
        --source "X:/...../fsltl-traffic-base" \
        --output "X:/...../mods/aircraft/fsltl" \
        --texture-scale 1k \
        --progress-file "progress.json" \
        --models "FSLTL_B738_AAL,FSLTL_A320_UAL"
"""

# IMPORTANT: Parse progress file arg FIRST before any imports that might fail
# This allows us to write errors to the progress file if imports fail
import sys
import json
from pathlib import Path

def _get_progress_file_from_args():
    """Extract --progress-file from sys.argv before full argument parsing."""
    for i, arg in enumerate(sys.argv):
        if arg == '--progress-file' and i + 1 < len(sys.argv):
            return Path(sys.argv[i + 1])
        if arg.startswith('--progress-file='):
            return Path(arg.split('=', 1)[1])
    return None

def _write_startup_error(progress_file: Path | None, error_msg: str, details: str = ""):
    """Write an error to the progress file and print to stderr."""
    full_error = f"{error_msg}\n{details}" if details else error_msg
    print(f"STARTUP ERROR: {full_error}", file=sys.stderr)

    if progress_file:
        try:
            progress_file.parent.mkdir(parents=True, exist_ok=True)
            with open(progress_file, 'w') as f:
                json.dump({
                    'status': 'error',
                    'total': 0,
                    'completed': 0,
                    'current': None,
                    'errors': [error_msg],
                    'converted': [],
                    'startup_error': full_error
                }, f)
        except Exception as e:
            print(f"Failed to write error to progress file: {e}", file=sys.stderr)

# Get progress file path BEFORE importing potentially failing modules
_progress_file_path = _get_progress_file_from_args()

# Now try to import everything else, catching any failures
try:
    import argparse
    import re
    import struct
    from PIL import Image
    import numpy as np
    import io
    import traceback
    import time
    import os
    import subprocess
    import tempfile
    import urllib.request
    import zipfile
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading
except ImportError as e:
    _write_startup_error(
        _progress_file_path,
        f"Failed to import required module: {e.name}",
        f"Full error: {e}\n\nThis usually means the converter was not built correctly.\nPlease run 'npm run build:converter' to rebuild."
    )
    sys.exit(1)
except Exception as e:
    _write_startup_error(
        _progress_file_path,
        f"Unexpected error during startup: {type(e).__name__}",
        traceback.format_exc()
    )
    sys.exit(1)

# Global texconv.exe path (downloaded on first use)
_texconv_path: Path | None = None
_texconv_lock = threading.Lock()

def get_texconv_path() -> Path | None:
    """Get path to texconv.exe bundled with the application."""
    global _texconv_path

    with _texconv_lock:
        if _texconv_path and _texconv_path.exists():
            return _texconv_path

        # When running as PyInstaller bundle, check next to the executable
        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            check_paths = [
                exe_dir / "texconv.exe",
            ]
        else:
            # Development mode - check script directory
            script_dir = Path(__file__).parent
            check_paths = [
                script_dir / "texconv.exe",
                Path("texconv.exe"),
            ]

        for check_path in check_paths:
            if check_path.exists():
                _texconv_path = check_path
                return _texconv_path

        print("ERROR: texconv.exe not found. It should be bundled with the converter.")
        return None


def convert_dds_with_texconv(dds_path: Path, target_size: int | None = None) -> bytes | None:
    """Convert DDS to PNG using Microsoft's texconv.exe."""
    texconv = get_texconv_path()
    if not texconv:
        return None

    # Create temp directory for output
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir_path = Path(tmpdir)
        output_file = tmpdir_path / (dds_path.stem + ".png")

        # Run texconv to convert DDS -> PNG
        try:
            result = subprocess.run(
                [str(texconv), "-ft", "png", "-o", str(tmpdir_path), "-y", str(dds_path)],
                capture_output=True,
                timeout=30
            )
            if result.returncode != 0 or not output_file.exists():
                return None

            # Read and optionally resize
            img = Image.open(output_file)
            if img.mode != 'RGBA':
                img = img.convert('RGBA')

            if target_size is not None and max(img.size) > target_size:
                ratio = target_size / max(img.size)
                new_size = (int(img.width * ratio), int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)

            buffer = io.BytesIO()
            img.save(buffer, format='PNG', optimize=True)
            return buffer.getvalue()
        except Exception:
            return None


# Texture scale limits
TEXTURE_SCALE_MAP = {
    'full': None,   # No scaling
    '2k': 2048,
    '1k': 1024,
    '512': 512
}


def convert_dds_to_png(dds_path: Path, target_size: int | None = None) -> bytes:
    """Convert DDS file to PNG bytes, optionally resizing.

    Uses PIL for common formats, falls back to texconv.exe for BC7 and other advanced formats.
    """
    # First try PIL (faster for supported formats)
    try:
        img = Image.open(dds_path)
        # PIL succeeded - process the image
        if img.mode != 'RGBA':
            img = img.convert('RGBA')

        if target_size is not None and max(img.size) > target_size:
            ratio = target_size / max(img.size)
            new_size = (int(img.width * ratio), int(img.height * ratio))
            img = img.resize(new_size, Image.LANCZOS)

        buffer = io.BytesIO()
        img.save(buffer, format='PNG', optimize=True)
        return buffer.getvalue()

    except NotImplementedError:
        # Unsupported DDS format (e.g., BC7/DXGI format 78)
        # Fall back to texconv.exe
        result = convert_dds_with_texconv(dds_path, target_size)
        if result:
            return result

        # texconv also failed - create placeholder
        print(f"  Warning: Could not convert {dds_path.name}, using placeholder")
        img = Image.new('RGBA', (64, 64), (128, 128, 128, 255))
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return buffer.getvalue()


def find_texture_file(texture_name: str, model_dir: Path, texture_dirs: list[Path]) -> Path | None:
    """Find texture file in model dir or texture directories."""
    for ext in ['.DDS', '.dds', '.PNG', '.png', '.png.dds', '.PNG.DDS', '']:
        candidate = model_dir / f"{texture_name}{ext}"
        if candidate.exists():
            return candidate

    for tex_dir in texture_dirs:
        for ext in ['.DDS', '.dds', '.PNG', '.png', '.png.dds', '.PNG.DDS', '']:
            candidate = tex_dir / f"{texture_name}{ext}"
            if candidate.exists():
                return candidate

    return None


def detect_animations(gltf: dict) -> bool:
    """Check if model has landing gear or other relevant animations."""
    animations = gltf.get('animations', [])
    for anim in animations:
        name = anim.get('name', '').lower()
        if 'gear' in name or 'landing' in name or 'wheel' in name:
            return True
    return False


def convert_single_gltf(gltf_path: Path, output_path: Path, texture_dirs: list[Path],
                        texture_scale: int | None = None) -> dict:
    """
    Convert a single GLTF file to GLB.

    Returns dict with:
        - success: bool
        - has_animations: bool
        - output_size: int (bytes)
        - error: str (if failed)
    """
    model_dir = gltf_path.parent

    # Load GLTF
    with open(gltf_path, 'r', encoding='utf-8') as f:
        gltf = json.load(f)

    # Detect animations
    has_animations = detect_animations(gltf)

    # Load binary buffer
    buffer_uri = gltf['buffers'][0].get('uri', '')
    if buffer_uri:
        bin_file = model_dir / buffer_uri
        with open(bin_file, 'rb') as f:
            bin_data = bytearray(f.read())
    else:
        bin_data = bytearray()

    # Process images - convert DDS to PNG with optional scaling
    image_buffers = []
    if 'images' in gltf:
        for i, image in enumerate(gltf['images']):
            uri = image.get('uri', '')
            if uri:
                texture_path = find_texture_file(uri, model_dir, texture_dirs)
                if texture_path is None:
                    base_name = Path(uri).stem
                    if base_name.endswith('.PNG') or base_name.endswith('.png'):
                        base_name = base_name[:-4]
                    texture_path = find_texture_file(base_name, model_dir, texture_dirs)

                if texture_path:
                    png_data = convert_dds_to_png(texture_path, texture_scale)
                    image_buffers.append(png_data)
                else:
                    # Create placeholder texture
                    img = Image.new('RGBA', (1, 1), (255, 0, 255, 255))
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_buffers.append(buffer.getvalue())

    # Convert float16 UVs to float32
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])

    # Find all TEXCOORD_0 accessors and remove problematic attributes
    uv_accessors = {}
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            attrs = prim.get('attributes', {})
            if 'TEXCOORD_0' in attrs:
                acc_idx = attrs['TEXCOORD_0']
                if acc_idx not in uv_accessors:
                    uv_accessors[acc_idx] = accessors[acc_idx]

            # Remove problematic attributes
            for attr in ['COLOR_0', 'TEXCOORD_1', 'NORMAL', 'TANGENT']:
                if attr in attrs:
                    del attrs[attr]

    # Build new buffer with float32 UVs
    new_uv_data = bytearray()
    uv_accessor_mapping = {}

    for acc_idx, acc in uv_accessors.items():
        if acc['componentType'] != 5122:  # Only convert SHORT (actually float16)
            continue

        bv = buffer_views[acc['bufferView']]
        offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = bv.get('byteStride', 4)
        count = acc['count']

        # Read float16 values and convert to float32
        uv_start = len(new_uv_data)
        for i in range(count):
            pos = offset + i * stride
            # Bounds check to prevent buffer over-read
            if pos + 4 > len(bin_data):
                raise ValueError(f"UV accessor reads past buffer end at position {pos} (buffer size: {len(bin_data)})")
            raw_bytes = bytes(bin_data[pos:pos+4])
            u = float(np.frombuffer(raw_bytes[0:2], dtype=np.float16)[0])
            v = float(np.frombuffer(raw_bytes[2:4], dtype=np.float16)[0])
            new_uv_data.extend(struct.pack('<ff', u, v))

        uv_accessor_mapping[acc_idx] = {
            'offset': uv_start,
            'count': count
        }

    # Add image data to bin_data
    current_offset = len(bin_data)
    padding_needed = (4 - (current_offset % 4)) % 4
    bin_data += b'\x00' * padding_needed
    current_offset = len(bin_data)

    for i, img_data in enumerate(image_buffers):
        bv_index = len(gltf['bufferViews'])
        gltf['bufferViews'].append({
            'buffer': 0,
            'byteOffset': current_offset,
            'byteLength': len(img_data)
        })

        gltf['images'][i] = {
            'bufferView': bv_index,
            'mimeType': 'image/png'
        }

        bin_data += img_data
        current_offset += len(img_data)

        padding_needed = (4 - (current_offset % 4)) % 4
        bin_data += b'\x00' * padding_needed
        current_offset = len(bin_data)

    # Add float32 UV data
    uv_bv_start = current_offset
    bin_data += new_uv_data
    current_offset += len(new_uv_data)

    padding_needed = (4 - (current_offset % 4)) % 4
    bin_data += b'\x00' * padding_needed
    current_offset = len(bin_data)

    # Create buffer view for UV data
    uv_buffer_view_idx = len(gltf['bufferViews'])
    gltf['bufferViews'].append({
        'buffer': 0,
        'byteOffset': uv_bv_start,
        'byteLength': len(new_uv_data)
    })

    # Update UV accessors
    for acc_idx, mapping in uv_accessor_mapping.items():
        acc = accessors[acc_idx]
        acc['bufferView'] = uv_buffer_view_idx
        acc['byteOffset'] = mapping['offset']
        acc['componentType'] = 5126  # FLOAT
        acc['normalized'] = False
        acc.pop('min', None)
        acc.pop('max', None)

    # Update buffer size
    gltf['buffers'] = [{'byteLength': len(bin_data)}]

    # Remove MSFS-specific extensions
    extensions_to_remove = ['MSFT_texture_dds', 'ASOBO_normal_map_convention',
                            'ASOBO_macro_light', 'ASOBO_asset_optimized']

    if 'extensionsUsed' in gltf:
        gltf['extensionsUsed'] = [e for e in gltf['extensionsUsed'] if e not in extensions_to_remove]
        if not gltf['extensionsUsed']:
            del gltf['extensionsUsed']

    if 'extensionsRequired' in gltf:
        gltf['extensionsRequired'] = [e for e in gltf['extensionsRequired'] if e not in extensions_to_remove]
        if not gltf['extensionsRequired']:
            del gltf['extensionsRequired']

    # Clean up materials
    if 'materials' in gltf:
        for mat in gltf['materials']:
            if 'extensions' in mat:
                for ext in extensions_to_remove:
                    mat['extensions'].pop(ext, None)
                if not mat['extensions']:
                    del mat['extensions']

            mat['alphaMode'] = 'OPAQUE'
            mat['doubleSided'] = True

            pbr = mat.get('pbrMetallicRoughness', {})
            if 'metallicRoughnessTexture' in pbr:
                del pbr['metallicRoughnessTexture']
            pbr['metallicFactor'] = 0.0
            pbr['roughnessFactor'] = 1.0
            mat['pbrMetallicRoughness'] = pbr

    # Fix texture references
    if 'textures' in gltf:
        for tex in gltf['textures']:
            if 'extensions' in tex and 'MSFT_texture_dds' in tex['extensions']:
                dds_ext = tex['extensions']['MSFT_texture_dds']
                if 'source' in dds_ext and 'source' not in tex:
                    tex['source'] = dds_ext['source']

            if 'extensions' in tex:
                for ext in extensions_to_remove:
                    tex['extensions'].pop(ext, None)
                if not tex['extensions']:
                    del tex['extensions']

    # Serialize JSON
    json_str = json.dumps(gltf, separators=(',', ':'))
    json_bytes = json_str.encode('utf-8')

    json_padding = (4 - (len(json_bytes) % 4)) % 4
    json_bytes += b' ' * json_padding

    bin_padding = (4 - (len(bin_data) % 4)) % 4
    bin_data += b'\x00' * bin_padding

    # GLB header
    total_length = 12 + 8 + len(json_bytes) + 8 + len(bin_data)
    header = struct.pack('<4sII', b'glTF', 2, total_length)

    json_chunk_header = struct.pack('<II', len(json_bytes), 0x4E4F534A)
    bin_chunk_header = struct.pack('<II', len(bin_data), 0x004E4942)

    # Create output directory
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write GLB
    with open(output_path, 'wb') as f:
        f.write(header)
        f.write(json_chunk_header)
        f.write(json_bytes)
        f.write(bin_chunk_header)
        f.write(bytes(bin_data))

    return {
        'success': True,
        'has_animations': has_animations,
        'output_size': total_length
    }


def parse_aircraft_cfg(aircraft_dir: Path) -> dict:
    """
    Parse aircraft.cfg to extract base_container, model, and texture info.
    Returns dict with 'base_container', 'model', 'texture' keys.
    """
    cfg_path = aircraft_dir / "aircraft.cfg"
    if not cfg_path.exists():
        return {}

    result = {}
    try:
        content = cfg_path.read_text(encoding='utf-8', errors='ignore')
        for line in content.splitlines():
            line = line.strip()
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip().lower()
                value = value.strip().strip('"').strip("'")
                if key == 'base_container':
                    result['base_container'] = value
                elif key == 'model':
                    result['model'] = value
                elif key == 'texture':
                    result['texture'] = value
    except Exception:
        pass
    return result


def parse_model_cfg(model_cfg_path: Path) -> Path | None:
    """
    Parse a model.CFG file to extract the base GLTF path.

    MSFS livery folders have a MODEL.xxx/model.CFG that specifies which
    base model to use via [models] normal=..\\..\\FSLTL_A321\\model.CFM_S\\FAIB_A321S_CFM.xml

    Returns the path to the GLTF file (derived from the .xml path) or None.
    """
    if not model_cfg_path.exists():
        return None

    try:
        content = model_cfg_path.read_text(encoding='utf-8', errors='ignore')
        for line in content.splitlines():
            line = line.strip()
            if line.lower().startswith('normal='):
                # Extract path after 'normal='
                rel_path = line.partition('=')[2].strip()
                if rel_path:
                    # Convert backslashes to forward slashes
                    rel_path = rel_path.replace('\\', '/')
                    # The path points to an .xml file, but we want the GLTF
                    # e.g., model.CFM_S/FAIB_A321S_CFM.xml -> model.CFM_S/FAIB_A321S_CFM_LOD0.gltf
                    if rel_path.endswith('.xml'):
                        gltf_base = rel_path[:-4]  # Remove .xml
                        # Resolve relative to model.CFG's parent directory
                        abs_path = (model_cfg_path.parent / gltf_base).resolve()
                        # Try to find the GLTF in that directory
                        gltf_dir = abs_path.parent
                        gltf_stem = abs_path.name
                        if gltf_dir.exists():
                            # Look for LOD0 first, then any LOD
                            for suffix in ['_LOD0.gltf', '_LOD0.GLTF']:
                                candidate = gltf_dir / f"{gltf_stem}{suffix}"
                                if candidate.exists():
                                    return candidate
                            # Fall back to any GLTF with matching prefix
                            for gltf_file in gltf_dir.glob(f"{gltf_stem}*.gltf"):
                                return gltf_file
                            for gltf_file in gltf_dir.glob(f"{gltf_stem}*.GLTF"):
                                return gltf_file
    except Exception:
        pass
    return None


def get_gltf_vertex_count(gltf_path: Path) -> int:
    """Get approximate vertex count from a GLTF file."""
    try:
        with open(gltf_path, 'r', encoding='utf-8') as f:
            gltf = json.load(f)

        total_vertices = 0
        accessors = gltf.get('accessors', [])
        for mesh in gltf.get('meshes', []):
            for prim in mesh.get('primitives', []):
                pos_idx = prim.get('attributes', {}).get('POSITION')
                if pos_idx is not None and pos_idx < len(accessors):
                    total_vertices += accessors[pos_idx].get('count', 0)
        return total_vertices
    except:
        return 0


# Vertex threshold: if a model exceeds this, try a higher LOD for better performance
# 40K verts is more than enough detail for tower cab viewing (even in orbit mode)
MAX_PREFERRED_VERTICES = 40000


def find_gltf_in_model_dir(model_dir: Path) -> Path | None:
    """Find GLTF file in a model directory, balancing quality and performance."""
    # Get all GLTF files
    all_gltf = list(model_dir.glob("*.gltf")) + list(model_dir.glob("*.GLTF"))
    if not all_gltf:
        return None

    # Filter out interior models (we want exterior only)
    exterior_gltf = [f for f in all_gltf if 'INTERIOR' not in f.stem.upper()]
    if not exterior_gltf:
        exterior_gltf = all_gltf  # Fall back to all if no exterior found

    # Sort by LOD number (lowest first = highest quality)
    def lod_sort_key(path: Path):
        name = path.stem.upper()
        match = re.search(r'LOD(\d+)', name)
        if match:
            return (0, int(match.group(1)))
        return (1, 0)  # No LOD number (sort after LOD files)

    exterior_gltf.sort(key=lod_sort_key)

    # Pick the best LOD that's under the vertex threshold
    # This handles Asobo models (LOD03=118K verts) by stepping up to LOD04 (31K verts)
    for gltf_file in exterior_gltf:
        vertex_count = get_gltf_vertex_count(gltf_file)
        if vertex_count <= MAX_PREFERRED_VERTICES or gltf_file == exterior_gltf[-1]:
            # Either under threshold, or it's our last option
            if vertex_count > MAX_PREFERRED_VERTICES:
                print(f"  Note: Using {gltf_file.name} ({vertex_count:,} verts) - no lower-poly LOD available")
            return gltf_file

    return exterior_gltf[0]  # Fallback (shouldn't reach here)


def find_model_gltf(aircraft_dir: Path) -> tuple[Path | None, list[Path], Path | None]:
    """
    Find the GLTF file and texture directories for an aircraft.
    Handles both base models and livery variants.

    Returns (gltf_path, texture_dirs, base_dir)
    - For base models: gltf from aircraft_dir, textures from aircraft_dir
    - For liveries: gltf from base model, textures from livery folder (priority) + base folder
    """
    # First, try to find GLTF directly in this folder (base model)
    model_dirs = list(aircraft_dir.glob("model*")) + list(aircraft_dir.glob("MODEL*"))

    # Check if any model dir has a model.CFG pointing to a base GLTF
    # This is how MSFS liveries specify which variant to use (e.g., CFM vs IAE engines)
    gltf_from_cfg = None
    for model_dir in model_dirs:
        if model_dir.is_dir():
            model_cfg = model_dir / "model.CFG"
            if not model_cfg.exists():
                model_cfg = model_dir / "model.cfg"
            if model_cfg.exists():
                gltf_from_cfg = parse_model_cfg(model_cfg)
                if gltf_from_cfg:
                    break

    for model_dir in model_dirs:
        if model_dir.is_dir():
            gltf_file = find_gltf_in_model_dir(model_dir)
            if gltf_file:
                # This is a base model - use textures from here
                texture_dirs = list(aircraft_dir.glob("TEXTURE*")) + list(aircraft_dir.glob("texture*"))
                return gltf_file, texture_dirs, None

    # No GLTF found - check if this is a livery referencing a base model
    cfg = parse_aircraft_cfg(aircraft_dir)
    base_container = cfg.get('base_container', '')
    texture_suffix = cfg.get('texture', '')

    if base_container:
        # Resolve base container path (e.g., "..\FSLTL_A20N" -> parent/FSLTL_A20N)
        base_path = (aircraft_dir / base_container).resolve()
        if base_path.exists():
            # If we found a specific GLTF from model.CFG, use it
            # Otherwise fall back to searching all model directories
            gltf_file = gltf_from_cfg

            if gltf_file is None:
                # Fall back: search all model directories in base path
                base_model_dirs = list(base_path.glob("model*")) + list(base_path.glob("MODEL*"))
                for model_dir in base_model_dirs:
                    if model_dir.is_dir():
                        gltf_file = find_gltf_in_model_dir(model_dir)
                        if gltf_file:
                            break

            if gltf_file:
                # Texture priority: livery textures first, then base textures
                texture_dirs = []

                # Add livery-specific texture folders
                if texture_suffix:
                    livery_tex = list(aircraft_dir.glob(f"texture.{texture_suffix}")) + \
                                list(aircraft_dir.glob(f"TEXTURE.{texture_suffix}")) + \
                                list(aircraft_dir.glob(f"texture{texture_suffix}")) + \
                                list(aircraft_dir.glob(f"TEXTURE{texture_suffix}"))
                    texture_dirs.extend(livery_tex)

                # Also add any texture folder in livery dir
                texture_dirs.extend(list(aircraft_dir.glob("texture*")) + list(aircraft_dir.glob("TEXTURE*")))

                # Add base model textures as fallback
                texture_dirs.extend(list(base_path.glob("TEXTURE*")) + list(base_path.glob("texture*")))

                return gltf_file, texture_dirs, base_path

    return None, [], None


def parse_model_name(model_name: str) -> tuple[str, str | None]:
    """
    Parse FSLTL model name into aircraft type and airline code.

    Handles both standard and FAIB-prefixed names:
    - "FSLTL_B738_AAL" -> ("B738", "AAL")
    - "FSLTL_B738_ZZZZ" -> ("B738", None)  # base livery
    - "FSLTL_FAIB_A320_UAL" -> ("A320", "UAL")
    - "FSLTL_B738_AAL_NC" -> ("B738", "AAL")  # extra suffix ignored

    This logic matches the TypeScript parseModelName in src/renderer/types/fsltl.ts
    """
    # Remove FSLTL_ prefix if present
    name = model_name
    if name.startswith('FSLTL_'):
        name = name[6:]  # Remove 'FSLTL_'

    # Remove optional FAIB_ prefix (some models have this intermediary)
    if name.startswith('FAIB_'):
        name = name[5:]  # Remove 'FAIB_'

    parts = name.split('_')
    if len(parts) >= 1:
        aircraft_type = parts[0].strip()
        airline_code = parts[1].strip() if len(parts) > 1 else None
        # ZZZZ or ZZZ is the generic/base livery code
        if airline_code in ('ZZZZ', 'ZZZ', ''):
            airline_code = None
        # Handle dash-separated names like "UAL-United" - take code before dash
        elif airline_code and '-' in airline_code:
            airline_code = airline_code.split('-')[0].strip()
        return aircraft_type, airline_code
    return model_name.strip(), None


def write_progress(progress_file: Path, progress: dict):
    """Write progress to JSON file."""
    with open(progress_file, 'w') as f:
        json.dump(progress, f)


def convert_model_task(args_tuple):
    """Worker function to convert a single model. Returns result dict."""
    model_name, source_path, output_path, texture_scale, texture_scale_name = args_tuple

    try:
        # Find aircraft directory
        aircraft_dir = source_path / "SimObjects" / "Airplanes" / model_name
        if not aircraft_dir.exists():
            raise FileNotFoundError(f"Aircraft directory not found: {aircraft_dir}")

        # Find GLTF and textures (handles both base models and liveries)
        gltf_path, texture_dirs, base_dir = find_model_gltf(aircraft_dir)
        if gltf_path is None:
            raise FileNotFoundError(f"No GLTF file found for {model_name} (checked base_container if livery)")

        # Determine output path
        aircraft_type, airline_code = parse_model_name(model_name)
        if airline_code:
            model_output = output_path / aircraft_type / airline_code / "model.glb"
        else:
            model_output = output_path / aircraft_type / "base" / "model.glb"

        # Convert
        result = convert_single_gltf(gltf_path, model_output, texture_dirs, texture_scale)
        result['model_name'] = model_name
        result['output_path'] = str(model_output)
        result['aircraft_type'] = aircraft_type
        result['airline_code'] = airline_code
        result['texture_scale_name'] = texture_scale_name
        result['is_livery'] = base_dir is not None

        return result

    except Exception as e:
        return {
            'model_name': model_name,
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }


def main():
    # Quick self-test before full argument parsing (allows --self-test without other required args)
    if '--self-test' in sys.argv:
        print("Self-test: Checking bundled dependencies...")
        print(f"  Python: {sys.version}")
        print(f"  PIL: {Image.__version__ if hasattr(Image, '__version__') else 'OK'}")
        print(f"  NumPy: {np.__version__}")
        print(f"  Struct: OK")
        print(f"  Concurrent.futures: OK")
        # Quick numpy operation test
        arr = np.array([1, 2, 3], dtype=np.float32)
        assert arr.sum() == 6.0, "NumPy operation failed"
        print(f"  NumPy operations: OK")
        print("Self-test PASSED: All dependencies working correctly.")
        return 0

    parser = argparse.ArgumentParser(description='Convert FSLTL models to GLB')
    parser.add_argument('--source', required=True, help='Path to fsltl-traffic-base')
    parser.add_argument('--output', required=True, help='Output directory for converted models')
    parser.add_argument('--texture-scale', default='1k', choices=['full', '2k', '1k', '512'],
                        help='Texture scaling (default: 1k)')
    parser.add_argument('--progress-file', help='Path to write progress JSON')
    parser.add_argument('--models', help='Comma-separated list of model names to convert')
    parser.add_argument('--models-file', help='Path to file containing model names (one per line)')
    parser.add_argument('--workers', type=int, default=0, help='Number of parallel workers (0=auto)')
    parser.add_argument('--sample', action='store_true',
                        help='Sample mode: convert only one livery per aircraft type (for testing)')
    parser.add_argument('--log-file', help='Write output to log file instead of console')
    parser.add_argument('--self-test', action='store_true', help='Test that all dependencies are bundled correctly')
    args = parser.parse_args()

    # Set up logging to file if requested
    if args.log_file:
        log_file = open(args.log_file, 'w', encoding='utf-8')
        sys.stdout = log_file
        sys.stderr = log_file
        print(f"Logging to: {args.log_file}")

    source_path = Path(args.source)
    output_path = Path(args.output)
    texture_scale = TEXTURE_SCALE_MAP[args.texture_scale]
    progress_file = Path(args.progress_file) if args.progress_file else None

    # Ensure output directory exists
    output_path.mkdir(parents=True, exist_ok=True)

    # Parse model list (priority: --models-file > --models > all)
    if args.models_file:
        models_file_path = Path(args.models_file)
        models_to_convert = [
            line.strip() for line in models_file_path.read_text().splitlines()
            if line.strip() and not line.startswith('#')
        ]
    elif args.models:
        models_to_convert = [m.strip() for m in args.models.split(',') if m.strip()]
    else:
        # Convert all models if none specified
        # Includes both base models (with GLTF) and liveries (referencing base via aircraft.cfg)
        airplanes_path = source_path / "SimObjects" / "Airplanes"
        models_to_convert = sorted([
            d.name for d in airplanes_path.iterdir()
            if d.is_dir() and d.name.startswith('FSLTL_')
        ])

    # Sample mode: keep only one livery per aircraft type
    if args.sample and models_to_convert:
        seen_types = set()
        sampled_models = []
        for model_name in models_to_convert:
            aircraft_type, _ = parse_model_name(model_name)
            if aircraft_type not in seen_types:
                seen_types.add(aircraft_type)
                sampled_models.append(model_name)
        print(f"Sample mode: reduced {len(models_to_convert)} models to {len(sampled_models)} (one per aircraft type)")
        models_to_convert = sampled_models

    # Determine worker count
    if args.workers <= 0:
        # Auto: use CPU count, but cap at 8 to avoid memory issues
        num_workers = min(os.cpu_count() or 4, 8)
    else:
        num_workers = args.workers

    print(f"Converting {len(models_to_convert)} models using {num_workers} workers...")

    # Thread-safe progress tracking
    progress_lock = threading.Lock()
    progress = {
        'status': 'converting',
        'total': len(models_to_convert),
        'completed': 0,
        'current': None,
        'errors': [],
        'converted': []
    }

    # Write initial progress immediately
    if progress_file:
        write_progress(progress_file, progress)

    last_progress_write = time.time()
    PROGRESS_WRITE_INTERVAL = 0.5  # Write every 500ms for responsive UI

    def update_progress():
        """Write progress if enough time has passed."""
        nonlocal last_progress_write
        now = time.time()
        if progress_file and (now - last_progress_write) >= PROGRESS_WRITE_INTERVAL:
            with progress_lock:
                write_progress(progress_file, progress)
            last_progress_write = now

    # Prepare task arguments
    tasks = [
        (model_name, source_path, output_path, texture_scale, args.texture_scale)
        for model_name in models_to_convert
    ]

    # Process in parallel
    completed_count = 0
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        # Submit all tasks
        future_to_model = {
            executor.submit(convert_model_task, task): task[0]
            for task in tasks
        }

        # Process results as they complete
        for future in as_completed(future_to_model):
            model_name = future_to_model[future]
            completed_count += 1

            try:
                result = future.result()

                with progress_lock:
                    progress['completed'] = completed_count
                    progress['current'] = model_name

                    if result.get('success'):
                        progress['converted'].append({
                            'modelName': result['model_name'],
                            'modelPath': result['output_path'],
                            'aircraftType': result['aircraft_type'],
                            'airlineCode': result['airline_code'],
                            'textureSize': result['texture_scale_name'],
                            'hasAnimations': result.get('has_animations', False),
                            'fileSize': result.get('output_size', 0),
                            'convertedAt': int(time.time() * 1000)
                        })
                        size_mb = result.get('output_size', 0) / 1024 / 1024
                        print(f"[{completed_count}/{len(models_to_convert)}] {model_name} ({size_mb:.2f} MB)")
                    else:
                        error_msg = f"{model_name}: {result.get('error', 'Unknown error')}"
                        progress['errors'].append(error_msg)
                        print(f"[{completed_count}/{len(models_to_convert)}] ERROR: {model_name}: {result.get('error')}")
                        if result.get('traceback'):
                            print(result['traceback'])

                update_progress()

            except Exception as e:
                with progress_lock:
                    progress['completed'] = completed_count
                    progress['errors'].append(f"{model_name}: {str(e)}")
                print(f"[{completed_count}/{len(models_to_convert)}] EXCEPTION: {model_name}: {e}")
                traceback.print_exc()
                update_progress()

    # Copy FSLTL_Rules.vmr to output folder for future use without source folder
    vmr_source = source_path / "FSLTL_Rules.vmr"
    vmr_dest = output_path / "FSLTL_Rules.vmr"
    if vmr_source.exists():
        try:
            import shutil
            shutil.copy2(vmr_source, vmr_dest)
            print(f"Copied FSLTL_Rules.vmr to output folder")
        except Exception as e:
            print(f"Warning: Failed to copy FSLTL_Rules.vmr: {e}")

    # Final status
    with progress_lock:
        progress['status'] = 'complete' if not progress['errors'] else 'error'
        progress['current'] = None
    if progress_file:
        write_progress(progress_file, progress)

    # Summary
    successful = len(progress['converted'])
    failed = len(progress['errors'])
    print(f"\nConversion complete: {successful} successful, {failed} failed")

    if progress['errors']:
        print(f"\nErrors ({len(progress['errors'])}):")
        for error in progress['errors'][:10]:
            print(f"  - {error}")
        if len(progress['errors']) > 10:
            print(f"  ... and {len(progress['errors']) - 10} more")

    return 0 if not failed else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        # Catch any uncaught exception and write to progress file
        _write_startup_error(
            _progress_file_path,
            f"Converter crashed: {type(e).__name__}: {e}",
            traceback.format_exc()
        )
        sys.exit(1)
