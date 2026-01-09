#!/usr/bin/env python3
"""
FSLTL/AIG Batch Converter

Converts MSFS aircraft models from GLTF with DDS textures to self-contained GLB files.
Uses aircraft.cfg livery titles for filtering instead of folder names.

Features:
- Discover liveries from aircraft.cfg FLTSIM sections
- Filter by livery titles (comma-separated list or all if not specified)
- Batch conversion with multiple texture scale options
- Progress reporting to JSON file
- Animation detection for landing gear

Usage:
    python convert_fsltl_batch.py \
        --source "X:/...../fsltl-traffic-base" \
        --output "X:/...../mods/aircraft/fsltl" \
        --texture-scale 1k \
        --liveries "FSLTL_FAIB_B738_American,FSLTL_FAIB_A320_UAL"

    # Convert all liveries if --liveries not specified:
    python convert_fsltl_batch.py --source "..." --output "..."
"""

# IMPORTANT: Parse progress file arg FIRST before any imports that might fail
# This allows us to write errors to the progress file if imports fail
import sys
import json
import traceback  # Safe stdlib import - needed for error handling
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

# Converter version - increment when conversion logic changes to invalidate cached models
# Version history:
#   1: Initial version with source metadata embedding
#   2: Added animation baking for MSFS models (fixes misaligned flaps, slats, gear, etc.)
#   3: Fixed steering animations by using identity quaternion frame instead of frame 0
CONVERTER_VERSION = 3

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
            # Convert to RGB to avoid premultiplied alpha issues during resize
            if img.mode != 'RGB':
                img = img.convert('RGB')

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

    IMPORTANT: We convert to RGB (dropping alpha) before resizing because:
    1. MSFS livery textures often have alpha channels used for day/night switching
       (not transparency) where transparent areas still have valid RGB data
    2. LANCZOS/BILINEAR resize uses premultiplied alpha blending, which destroys
       RGB values in transparent areas (RGB → black)
    3. Our output uses alphaMode=OPAQUE, so alpha is ignored anyway
    """
    # First try PIL (faster for supported formats)
    try:
        img = Image.open(dds_path)
        # PIL succeeded - process the image
        # Convert to RGB to avoid premultiplied alpha issues during resize
        # (LANCZOS blending destroys RGB values in transparent areas)
        if img.mode != 'RGB':
            img = img.convert('RGB')

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
                        texture_scale: int | None = None,
                        source_metadata: dict | None = None) -> dict:
    """
    Convert a single GLTF file to GLB.

    Args:
        gltf_path: Path to source GLTF file
        output_path: Path for output GLB file
        texture_dirs: List of directories to search for textures
        texture_scale: Max texture dimension (None for full size)
        source_metadata: Optional dict of source info to embed in GLB extras.
                        Keys: source, livery_title, folder_name, aircraft_type,
                              icao_airline, gltf_path, texture_dirs, aircraft_folder

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

    # Convert float16 UVs to float32 and fix SCALAR WEIGHTS_0 to VEC4
    accessors = gltf.get('accessors', [])
    buffer_views = gltf.get('bufferViews', [])

    # Find all TEXCOORD_0 accessors, SCALAR WEIGHTS_0 accessors, and remove problematic attributes
    uv_accessors = {}
    scalar_weights_accessors = {}  # MSFS non-standard: SCALAR instead of VEC4
    for mesh in gltf.get('meshes', []):
        for prim in mesh.get('primitives', []):
            attrs = prim.get('attributes', {})
            if 'TEXCOORD_0' in attrs:
                acc_idx = attrs['TEXCOORD_0']
                if acc_idx not in uv_accessors:
                    uv_accessors[acc_idx] = accessors[acc_idx]

            # Check for non-standard SCALAR WEIGHTS_0 (should be VEC4 per glTF spec)
            if 'WEIGHTS_0' in attrs:
                acc_idx = attrs['WEIGHTS_0']
                acc = accessors[acc_idx]
                if acc['type'] == 'SCALAR':
                    if acc_idx not in scalar_weights_accessors:
                        scalar_weights_accessors[acc_idx] = acc

            # Remove problematic attributes (keep JOINTS_0/WEIGHTS_0 for skinning)
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
    # Note: Do NOT set byteStride here - the accessors are stored sequentially
    # (each with its own byteOffset), not interleaved. byteStride is only for
    # interleaved data where multiple attributes share the same vertex stride.
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

    # Convert SCALAR WEIGHTS_0 to VEC4 (MSFS non-standard format)
    # glTF spec requires WEIGHTS_0 to be VEC4, but some AIG models use SCALAR
    new_weights_data = bytearray()
    weights_accessor_mapping = {}

    for acc_idx, acc in scalar_weights_accessors.items():
        bv = buffer_views[acc['bufferView']]
        offset = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        stride = bv.get('byteStride', 4)  # SCALAR float = 4 bytes
        count = acc['count']

        # Read SCALAR weight and expand to VEC4 (w, 0, 0, 0)
        weights_start = len(new_weights_data)
        for i in range(count):
            pos = offset + i * stride
            if pos + 4 > len(bin_data):
                raise ValueError(f"WEIGHTS_0 accessor reads past buffer end at position {pos}")
            w = struct.unpack('<f', bytes(bin_data[pos:pos+4]))[0]
            # Expand to VEC4: (w, 0, 0, 0) as normalized UNSIGNED_SHORT
            w_ushort = min(65535, max(0, int(w * 65535)))
            new_weights_data.extend(struct.pack('<4H', w_ushort, 0, 0, 0))

        weights_accessor_mapping[acc_idx] = {
            'offset': weights_start,
            'count': count
        }

    # Add VEC4 weights data to buffer if we have any SCALAR weights to convert
    if new_weights_data:
        padding_needed = (4 - (current_offset % 4)) % 4
        bin_data += b'\x00' * padding_needed
        current_offset = len(bin_data)

        weights_bv_start = current_offset
        bin_data += new_weights_data
        current_offset += len(new_weights_data)

        # Create buffer view for converted weights
        # Note: No byteStride needed - accessors are sequential, not interleaved
        weights_buffer_view_idx = len(gltf['bufferViews'])
        gltf['bufferViews'].append({
            'buffer': 0,
            'byteOffset': weights_bv_start,
            'byteLength': len(new_weights_data)
        })

        # Update WEIGHTS_0 accessors from SCALAR FLOAT to VEC4 UNSIGNED_SHORT normalized
        for acc_idx, mapping in weights_accessor_mapping.items():
            acc = accessors[acc_idx]
            acc['bufferView'] = weights_buffer_view_idx
            acc['byteOffset'] = mapping['offset']
            acc['componentType'] = 5123  # UNSIGNED_SHORT
            acc['type'] = 'VEC4'
            acc['normalized'] = True
            acc.pop('min', None)
            acc.pop('max', None)

    # ========================================================================
    # MSFS SKINNING FIX
    # ========================================================================
    # MSFS uses skinning differently than standard glTF:
    # 1. MSFS ignores inverseBindMatrices (vertices already in model space)
    # 2. Node transforms are applied differently
    # 3. Standard loaders apply both, causing incorrect positioning
    #
    # Solution: Strip skinning entirely and fix node transforms
    # - Wings: Vertices already in model space, zero translation/rotation
    # - Slats: Skinned slats are in skeleton-local space, hide them
    #          (non-skinned bone-parented slats render correctly)
    # - Left meshes: May need mirroring if vertices are on wrong side
    # ========================================================================
    meshes_list = gltf.get('meshes', [])
    skins = gltf.get('skins', [])

    if skins:
        for node in gltf.get('nodes', []):
            if 'skin' not in node:
                continue

            node_name = node.get('name', 'unnamed')
            is_slat = 'slat' in node_name.lower()

            # Remove skin reference (standard loaders can't handle MSFS skinning)
            del node['skin']

            if is_slat:
                # Skinned slat meshes are in skeleton-local space and can't be
                # properly positioned without MSFS-specific skinning logic.
                # Hide them by removing mesh reference - the non-skinned slat
                # meshes (r_slats1/l_slats1 parented to bone) render correctly.
                if 'mesh' in node:
                    del node['mesh']
                if 'rotation' in node:
                    del node['rotation']
                node['translation'] = [0.0, 0.0, 0.0]
            else:
                # Wings and other skinned meshes: vertices are already in model
                # space, so zero node transforms (MSFS applies differently)
                node['translation'] = [0.0, 0.0, 0.0]
                if 'rotation' in node:
                    del node['rotation']

            # Auto-detect left meshes that need mirroring
            # Some left meshes have vertices on the right side (positive X)
            # and need scale=[-1,1,1] to render correctly
            is_left = node_name.lower().startswith('l_')
            if 'mesh' in node and is_left:
                mesh = meshes_list[node['mesh']]
                prims = mesh.get('primitives', [])
                if prims:
                    pos_acc_idx = prims[0].get('attributes', {}).get('POSITION')
                    if pos_acc_idx is not None:
                        acc = accessors[pos_acc_idx]
                        x_min = acc.get('min', [0])[0] if acc.get('min') else 0
                        x_max = acc.get('max', [0])[0] if acc.get('max') else 0
                        x_center = (x_min + x_max) / 2
                        if x_center > 1.0:
                            # Left mesh but vertices on right side - mirror it
                            node['scale'] = [-1.0, 1.0, 1.0]

        # Remove skins array entirely (no longer used)
        del gltf['skins']

        # Remove JOINTS_0 and WEIGHTS_0 from mesh primitives (skinning stripped)
        for mesh in meshes_list:
            for prim in mesh.get('primitives', []):
                attrs = prim.get('attributes', {})
                for attr in list(attrs.keys()):
                    if attr.startswith('JOINTS_') or attr.startswith('WEIGHTS_'):
                        del attrs[attr]

    # Update buffer size
    gltf['buffers'] = [{'byteLength': len(bin_data)}]

    # Remove MSFS-specific extensions (exact matches)
    extensions_to_remove = ['MSFT_texture_dds']
    # Also remove any extension starting with ASOBO_ (MSFS-specific)
    asobo_prefix = 'ASOBO_'

    if 'extensionsUsed' in gltf:
        gltf['extensionsUsed'] = [e for e in gltf['extensionsUsed']
                                  if e not in extensions_to_remove and not e.startswith(asobo_prefix)]
        if not gltf['extensionsUsed']:
            del gltf['extensionsUsed']

    if 'extensionsRequired' in gltf:
        gltf['extensionsRequired'] = [e for e in gltf['extensionsRequired']
                                      if e not in extensions_to_remove and not e.startswith(asobo_prefix)]
        if not gltf['extensionsRequired']:
            del gltf['extensionsRequired']

    # Clean up asset extensions (ASOBO extensions often stored here)
    if 'asset' in gltf and 'extensions' in gltf['asset']:
        keys_to_remove = [k for k in gltf['asset']['extensions']
                          if k in extensions_to_remove or k.startswith(asobo_prefix)]
        for ext in keys_to_remove:
            gltf['asset']['extensions'].pop(ext, None)
        if not gltf['asset']['extensions']:
            del gltf['asset']['extensions']

    # Clean up materials
    if 'materials' in gltf:
        for mat in gltf['materials']:
            if 'extensions' in mat:
                keys_to_remove = [k for k in mat['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
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

            # Remove emissive textures and factors from MSFS models
            # MSFS uses _L textures for day/night lighting which doesn't translate to glTF
            # Keeping them causes paint artifacts where the underpaint looks too bright
            if 'emissiveTexture' in mat:
                del mat['emissiveTexture']
            mat['emissiveFactor'] = [0, 0, 0]

            # Remove normal textures - MSFS uses DirectX format (inverted green channel)
            # but Babylon.js/Cesium expect OpenGL format. We already removed NORMAL/TANGENT
            # vertex attributes, so normal maps wouldn't work correctly anyway.
            if 'normalTexture' in mat:
                del mat['normalTexture']

            # Remove occlusion textures (ambient occlusion) - not needed for traffic display
            if 'occlusionTexture' in mat:
                del mat['occlusionTexture']

    # Fix texture references
    if 'textures' in gltf:
        for tex in gltf['textures']:
            if 'extensions' in tex and 'MSFT_texture_dds' in tex['extensions']:
                dds_ext = tex['extensions']['MSFT_texture_dds']
                if 'source' in dds_ext and 'source' not in tex:
                    tex['source'] = dds_ext['source']

            if 'extensions' in tex:
                keys_to_remove = [k for k in tex['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
                    tex['extensions'].pop(ext, None)
                if not tex['extensions']:
                    del tex['extensions']

    # Clean up top-level extensions object
    if 'extensions' in gltf:
        keys_to_remove = [k for k in gltf['extensions']
                          if k in extensions_to_remove or k.startswith(asobo_prefix)]
        for ext in keys_to_remove:
            gltf['extensions'].pop(ext, None)
        if not gltf['extensions']:
            del gltf['extensions']

    # Clean up node extensions (ASOBO_unique_id, etc.)
    if 'nodes' in gltf:
        for i, node in enumerate(gltf['nodes']):
            if 'extensions' in node:
                keys_to_remove = [k for k in node['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
                    node['extensions'].pop(ext, None)
                if not node['extensions']:
                    del node['extensions']

    # Clean up mesh extensions
    if 'meshes' in gltf:
        for mesh in gltf['meshes']:
            if 'extensions' in mesh:
                keys_to_remove = [k for k in mesh['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
                    mesh['extensions'].pop(ext, None)
                if not mesh['extensions']:
                    del mesh['extensions']
            # Also clean primitives
            if 'primitives' in mesh:
                for prim in mesh['primitives']:
                    if 'extensions' in prim:
                        keys_to_remove = [k for k in prim['extensions']
                                          if k in extensions_to_remove or k.startswith(asobo_prefix)]
                        for ext in keys_to_remove:
                            prim['extensions'].pop(ext, None)
                        if not prim['extensions']:
                            del prim['extensions']

    # Bake first frame of ALL animations into node transforms (MSFS models fix)
    # MSFS models are designed to look correct with animations at their default state.
    # For static display (without animation playback), we bake the t=0 keyframe of all
    # animations into the node transforms so parts render in their correct positions.
    # This fixes issues with flaps, slats, spoilers, gear, and other animated parts.
    #
    # Special handling for steering animations (e.g., front wheel):
    # - Rotation channels are scanned to find the keyframe closest to identity quaternion
    # - If a near-identity keyframe exists (angle < 5°), use that instead of frame 0
    # - This ensures steering wheels point straight forward rather than turned
    if 'animations' in gltf and 'accessors' in gltf and 'bufferViews' in gltf:
        import math
        animation_count = len(gltf['animations'])
        if animation_count > 0:
            print(f"  Baking first frame of {animation_count} animations into static transforms")

        for anim in gltf['animations']:
            for channel in anim.get('channels', []):
                target_node = channel['target']['node']
                target_path = channel['target']['path']  # 'translation', 'rotation', or 'scale'
                sampler = anim['samplers'][channel['sampler']]

                # Read the output accessor (animation data)
                output_acc_idx = sampler['output']
                output_acc = gltf['accessors'][output_acc_idx]
                output_bv = gltf['bufferViews'][output_acc['bufferView']]
                offset = output_bv.get('byteOffset', 0) + output_acc.get('byteOffset', 0)
                keyframe_count = output_acc['count']

                # For rotations, find the keyframe closest to identity quaternion
                # This handles steering animations where neutral position is in the middle
                keyframe_to_use = 0
                if target_path == 'rotation' and keyframe_count > 1:
                    min_angle = float('inf')
                    best_frame = 0

                    for i in range(keyframe_count):
                        frame_offset = offset + i * 16  # 4 floats = 16 bytes
                        quat = struct.unpack_from('<4f', bin_data, frame_offset)
                        # Angle from identity = 2 * acos(w), where w is the 4th component
                        w_clamped = max(-1.0, min(1.0, quat[3]))
                        angle = 2 * math.acos(w_clamped)

                        if angle < min_angle:
                            min_angle = angle
                            best_frame = i

                    # Use identity frame if it's close enough (< 5° = ~0.087 radians)
                    if min_angle < 0.087:  # 5 degrees in radians
                        keyframe_to_use = best_frame

                # Read keyframe value
                if target_path == 'translation':
                    # VEC3 FLOAT
                    value_offset = offset + keyframe_to_use * 12  # 3 floats = 12 bytes
                    value = struct.unpack_from('<3f', bin_data, value_offset)
                    gltf['nodes'][target_node]['translation'] = list(value)
                elif target_path == 'rotation':
                    # VEC4 FLOAT (quaternion)
                    value_offset = offset + keyframe_to_use * 16  # 4 floats = 16 bytes
                    value = struct.unpack_from('<4f', bin_data, value_offset)
                    gltf['nodes'][target_node]['rotation'] = list(value)
                elif target_path == 'scale':
                    # VEC3 FLOAT
                    value_offset = offset + keyframe_to_use * 12  # 3 floats = 12 bytes
                    value = struct.unpack_from('<3f', bin_data, value_offset)
                    gltf['nodes'][target_node]['scale'] = list(value)

    # Clean up animation extensions (ASOBO_animation_retargeting, etc.)
    if 'animations' in gltf:
        for anim in gltf['animations']:
            if 'extensions' in anim:
                keys_to_remove = [k for k in anim['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
                    anim['extensions'].pop(ext, None)
                if not anim['extensions']:
                    del anim['extensions']

    # Embed source metadata in asset.extras for debugging and lookup
    if source_metadata:
        if 'asset' not in gltf:
            gltf['asset'] = {'version': '2.0'}
        gltf['asset']['extras'] = {
            'towercab3d': {
                'converterVersion': CONVERTER_VERSION,
                'source': source_metadata.get('source'),
                'liveryTitle': source_metadata.get('livery_title'),
                'folderName': source_metadata.get('folder_name'),
                'aircraftType': source_metadata.get('aircraft_type'),
                'icaoAirline': source_metadata.get('icao_airline'),
                'gltfPath': source_metadata.get('gltf_path'),
                'textureDirs': source_metadata.get('texture_dirs'),
                'aircraftFolder': source_metadata.get('aircraft_folder'),
            }
        }

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


def parse_aircraft_cfg_all_liveries(aircraft_dir: Path, requested_titles: set[str] | None = None) -> list[dict]:
    """
    Parse FLTSIM sections from aircraft.cfg.
    Returns list of dicts with: title, texture_folder, icao_airline (or None)

    Args:
        aircraft_dir: Path to aircraft folder
        requested_titles: Optional set of livery titles to find. If provided, stops parsing once all are found.
                         If None, parses all liveries.

    This mirrors the Rust function parse_aircraft_cfg_all_liveries() in msfs.rs
    """
    cfg_path = aircraft_dir / "aircraft.cfg"
    if not cfg_path.exists():
        return []

    liveries = []
    try:
        content = cfg_path.read_text(encoding='utf-8', errors='ignore')
        in_fltsim = False
        current_livery = {}

        for line in content.splitlines():
            trimmed = line.strip()

            # Check for section headers
            if trimmed.startswith('['):
                # Save previous livery if complete (title + texture_folder key exists, even if empty)
                if in_fltsim and current_livery.get('title') and 'texture_folder' in current_livery:
                    liveries.append(current_livery)

                    # Early stopping: if we found all requested liveries, we're done
                    if requested_titles and all(liv['title'] in requested_titles for liv in liveries):
                        return liveries

                in_fltsim = trimmed.upper().startswith('[FLTSIM')
                current_livery = {}
                continue

            if not in_fltsim or '=' not in trimmed:
                continue

            key, _, value = trimmed.partition('=')
            key = key.strip().lower()
            value = value.split(';')[0].strip().strip('"').strip("'").strip()

            if key == 'title':
                current_livery['title'] = value
            elif key == 'texture' and not key.startswith('texture.'):
                current_livery['texture_folder'] = value
            elif key == 'icao_airline':
                current_livery['icao_airline'] = value.upper()

        # Don't forget the last section (title + texture_folder key exists, even if empty)
        if in_fltsim and current_livery.get('title') and 'texture_folder' in current_livery:
            liveries.append(current_livery)

    except Exception:
        pass

    return liveries


def find_gltf_in_model_dir(model_dir: Path) -> Path | None:
    """Find GLTF file in a model directory, balancing quality and performance."""
    # Get all GLTF files
    all_gltf = list(model_dir.glob("*.gltf")) + list(model_dir.glob("*.GLTF"))
    if not all_gltf:
        return None

    # Filter out interior/cockpit models (we want exterior only)
    exterior_gltf = [f for f in all_gltf if 'INTERIOR' not in f.stem.upper() and 'COCKPIT' not in f.stem.upper()]
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
    return exterior_gltf[0] if exterior_gltf else None


def parse_model_cfg(model_cfg_path: Path) -> Path | None:
    """
    Parse a model.cfg file to find the referenced base GLTF.

    MSFS livery folders have a model.XXX/model.cfg that points to the base model:
        [models]
        normal=..\\..\\FSLTL_A320\\model.iae\\FAIB_A320_IAE.xml

    Returns the GLTF path derived from the XML reference, or None.
    """
    if not model_cfg_path.exists():
        return None

    try:
        content = model_cfg_path.read_text(encoding='utf-8', errors='ignore')
        for line in content.splitlines():
            line = line.strip()
            if line.lower().startswith('normal='):
                rel_path = line.partition('=')[2].strip()
                if rel_path:
                    # Convert backslashes to forward slashes
                    rel_path = rel_path.replace('\\', '/')
                    # The path points to an .xml file - find the corresponding GLTF
                    # e.g., model.iae/FAIB_A320_IAE.xml -> model.iae/FAIB_A320_IAE_LOD0.gltf
                    if rel_path.endswith('.xml'):
                        gltf_base = rel_path[:-4]  # Remove .xml
                        # Resolve relative to model.cfg's parent directory
                        abs_path = (model_cfg_path.parent / gltf_base).resolve()
                        gltf_dir = abs_path.parent
                        gltf_stem = abs_path.name
                        if gltf_dir.exists():
                            # Look for LOD0 first (highest quality), then any LOD
                            for suffix in ['_LOD0.gltf', '_LOD0.GLTF', '_LOD1.gltf', '_LOD1.GLTF']:
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


def parse_base_container(aircraft_dir: Path) -> Path | None:
    """
    Parse aircraft.cfg to find the base_container reference.

    Returns the resolved base container path, or None.
    """
    cfg_path = aircraft_dir / "aircraft.cfg"
    if not cfg_path.exists():
        return None

    try:
        content = cfg_path.read_text(encoding='utf-8', errors='ignore')
        for line in content.splitlines():
            line = line.strip()
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip().lower()
                if key == 'base_container':
                    value = value.strip().strip('"').strip("'")
                    if value:
                        # Resolve relative path (e.g., "..\FSLTL_A320")
                        base_path = (aircraft_dir / value.replace('\\', '/')).resolve()
                        if base_path.exists():
                            return base_path
    except Exception:
        pass
    return None


def find_gltf_for_aircraft(aircraft_dir: Path) -> tuple[Path | None, Path | None]:
    """
    Find the GLTF file for an aircraft folder.

    Handles both:
    1. Base models (GLTF directly in model.* subfolder)
    2. Livery-only folders (model.cfg references a base model)

    Returns (gltf_path, base_model_dir) where base_model_dir is set if
    this is a livery referencing another folder's model.
    """
    model_dirs = list(aircraft_dir.glob("model*")) + list(aircraft_dir.glob("MODEL*"))

    # First try to find GLTF directly in this folder
    for model_dir in model_dirs:
        if model_dir.is_dir():
            gltf = find_gltf_in_model_dir(model_dir)
            if gltf:
                return gltf, None

    # No direct GLTF - check for model.cfg references to base model
    for model_dir in model_dirs:
        if model_dir.is_dir():
            model_cfg = model_dir / "model.cfg"
            if not model_cfg.exists():
                model_cfg = model_dir / "model.CFG"
            if model_cfg.exists():
                gltf = parse_model_cfg(model_cfg)
                if gltf:
                    # Return the base model's directory for texture fallback
                    base_dir = gltf.parent.parent  # model.xxx -> aircraft folder
                    return gltf, base_dir

    # Also check base_container in aircraft.cfg
    base_container = parse_base_container(aircraft_dir)
    if base_container:
        base_model_dirs = list(base_container.glob("model*")) + list(base_container.glob("MODEL*"))
        for model_dir in base_model_dirs:
            if model_dir.is_dir():
                gltf = find_gltf_in_model_dir(model_dir)
                if gltf:
                    return gltf, base_container

    return None, None


def discover_liveries_in_source(source_path: Path, requested_titles: set[str] | None = None) -> list[dict]:
    """
    Discover liveries in source path (smart detection).

    If source_path is an aircraft folder (ends with FSLTL_*, AIGAIM_*, etc.),
    scans only that folder (fast). Otherwise, scans all aircraft folders in
    source/SimObjects/Airplanes (slow, batch mode).

    Handles both:
    - Base model folders (contain GLTF directly)
    - Livery-only folders (reference base model via model.cfg or base_container)

    Args:
        source_path: Path to source (traffic base or specific aircraft folder)
        requested_titles: Optional set of livery titles to find. Enables early stopping in parsing.

    Returns list of dicts with livery information.
    """
    folder_name = source_path.name

    # Check if this is a specific aircraft folder (fast path)
    if folder_name.startswith("FSLTL_") or folder_name.startswith("AIGAIM_"):
        # Fast path: source_path is already an aircraft folder
        if not source_path.is_dir():
            return []

        # Find GLTF (handles both direct and referenced models)
        gltf_path, base_model_dir = find_gltf_for_aircraft(source_path)

        if not gltf_path:
            return []

        # Extract aircraft type from folder name
        parts = folder_name.split('_')
        aircraft_type = parts[1] if len(parts) > 1 else folder_name

        # Parse liveries from this aircraft's aircraft.cfg (with early stopping if requested_titles provided)
        liveries = parse_aircraft_cfg_all_liveries(source_path, requested_titles)

        # Get texture directories for shared textures (from this folder)
        # Match any subfolder containing "texture" (covers TEXTURE*, texture.*, oci.texture*, etc.)
        texture_dirs = [d for d in source_path.iterdir() if d.is_dir() and 'texture' in d.name.lower()]

        # If using a base model, also include base model's textures as fallback
        base_texture_dirs = []
        if base_model_dir:
            base_texture_dirs = [d for d in base_model_dir.iterdir() if d.is_dir() and 'texture' in d.name.lower()]

        if not liveries:
            # Fallback: create a single entry if no liveries found
            liveries = [{'title': folder_name, 'texture_folder': '', 'icao_airline': None}]

        # Determine source type from folder name
        source_type = 'fsltl' if folder_name.lower().startswith('fsltl') else 'aig'

        all_liveries = []
        for livery in liveries:
            # Build texture directory list (priority order)
            texture_dirs_for_livery = []

            # 1. Add livery-specific texture folder first (if it exists)
            if livery.get('texture_folder'):
                livery_tex_path = source_path / f"texture.{livery['texture_folder']}"
                if not livery_tex_path.exists():
                    livery_tex_path = source_path / f"Texture.{livery['texture_folder']}"
                if livery_tex_path.exists():
                    texture_dirs_for_livery.append(str(livery_tex_path))

            # 2. Add shared textures from this folder
            texture_dirs_for_livery.extend([str(d) for d in texture_dirs])

            # 3. Add base model textures as final fallback (for livery-only folders)
            texture_dirs_for_livery.extend([str(d) for d in base_texture_dirs])

            all_liveries.append({
                'source': source_type,
                'folder_name': folder_name,
                'livery_title': livery['title'],
                'texture_folder': livery.get('texture_folder', ''),
                'icao_airline': livery.get('icao_airline'),
                'gltf_path': str(gltf_path),
                'texture_dirs': texture_dirs_for_livery,
                'aircraft_type': aircraft_type,
            })

        return all_liveries

    # Slow path: source_path is the traffic base (fsltl-traffic-base or aig-aitraffic-oci)
    # Scan all aircraft folders
    airplanes = source_path / "SimObjects" / "Airplanes"
    if not airplanes.exists():
        return []

    # Determine source type from the traffic base folder name
    source_type = 'fsltl' if 'fsltl' in source_path.name.lower() else 'aig'

    all_liveries = []

    for aircraft_dir in sorted(airplanes.iterdir()):
        if not aircraft_dir.is_dir():
            continue

        aircraft_folder_name = aircraft_dir.name

        # Skip non-traffic folders
        if not (aircraft_folder_name.startswith("FSLTL_") or aircraft_folder_name.startswith("AIGAIM_")):
            continue

        # Find GLTF (handles both direct and referenced models)
        gltf_path, base_model_dir = find_gltf_for_aircraft(aircraft_dir)

        if not gltf_path:
            continue

        # Extract aircraft type from folder name
        parts = aircraft_folder_name.split('_')
        aircraft_type = parts[1] if len(parts) > 1 else aircraft_folder_name

        # Parse liveries from this aircraft's aircraft.cfg (with early stopping if requested_titles provided)
        liveries = parse_aircraft_cfg_all_liveries(aircraft_dir, requested_titles)

        # Get texture directories for shared textures (from this folder)
        # Match any subfolder containing "texture" (covers TEXTURE*, texture.*, oci.texture*, etc.)
        texture_dirs = [d for d in aircraft_dir.iterdir() if d.is_dir() and 'texture' in d.name.lower()]

        # If using a base model, also include base model's textures as fallback
        base_texture_dirs = []
        if base_model_dir:
            base_texture_dirs = [d for d in base_model_dir.iterdir() if d.is_dir() and 'texture' in d.name.lower()]

        if not liveries:
            # Fallback: create a single entry if no liveries found
            liveries = [{'title': aircraft_folder_name, 'texture_folder': '', 'icao_airline': None}]

        for livery in liveries:
            # Build texture directory list (priority order)
            texture_dirs_for_livery = []

            # 1. Add livery-specific texture folder first (if it exists)
            if livery.get('texture_folder'):
                livery_tex_path = aircraft_dir / f"texture.{livery['texture_folder']}"
                if not livery_tex_path.exists():
                    livery_tex_path = aircraft_dir / f"Texture.{livery['texture_folder']}"
                if livery_tex_path.exists():
                    texture_dirs_for_livery.append(str(livery_tex_path))

            # 2. Add shared textures from this folder
            texture_dirs_for_livery.extend([str(d) for d in texture_dirs])

            # 3. Add base model textures as final fallback (for livery-only folders)
            texture_dirs_for_livery.extend([str(d) for d in base_texture_dirs])

            all_liveries.append({
                'source': source_type,
                'folder_name': aircraft_folder_name,
                'aircraft_folder': str(aircraft_dir),
                'livery_title': livery['title'],
                'texture_folder': livery.get('texture_folder', ''),
                'icao_airline': livery.get('icao_airline'),
                'gltf_path': str(gltf_path),
                'texture_dirs': texture_dirs_for_livery,
                'aircraft_type': aircraft_type,
            })

    return all_liveries


def convert_livery_task(args_tuple):
    """Worker function for batch conversion."""
    livery_info, output_base_path, texture_scale, texture_scale_name = args_tuple

    aircraft_type = livery_info['aircraft_type']

    # Determine output path and airline code
    # Use icao_airline if available, otherwise try to parse from texture folder
    airline_code = livery_info.get('icao_airline')
    if not airline_code and livery_info.get('texture_folder'):
        # Try to extract 3-4 letter airline code from texture folder
        parts = livery_info['texture_folder'].split('-')
        if parts:
            code = parts[0].upper()
            if 3 <= len(code) <= 4:
                airline_code = code

    # Output flat structure: all .glb files in root with source prefix and livery title
    # Example: output_base_path/aig_AIGAIM_Singapore Airlines Airbus A350-900.glb
    #          output_base_path/fsltl_FSLTL_A350_AIR_FRANCE.glb
    livery_title = livery_info['livery_title']
    source_type = livery_info.get('source', 'aig')  # Default to 'aig' if not specified
    model_output = output_base_path / f"{source_type}_{livery_title}.glb"

    try:
        gltf_path = Path(livery_info['gltf_path'])
        texture_dirs = [Path(d) for d in livery_info['texture_dirs']]

        # Build source metadata to embed in the GLB for debugging/lookup
        source_metadata = {
            'source': source_type,
            'livery_title': livery_info['livery_title'],
            'folder_name': livery_info.get('folder_name'),
            'aircraft_type': aircraft_type,
            'icao_airline': airline_code,
            'gltf_path': str(gltf_path),
            'texture_dirs': [str(d) for d in texture_dirs],
            'aircraft_folder': livery_info.get('aircraft_folder'),
        }

        result = convert_single_gltf(gltf_path, model_output, texture_dirs, texture_scale, source_metadata)
        result['livery_title'] = livery_info['livery_title']
        result['aircraft_type'] = aircraft_type
        result['airline_code'] = airline_code
        result['output_path'] = str(model_output)
        result['texture_scale_name'] = texture_scale_name

        return result

    except Exception as e:
        return {
            'livery_title': livery_info['livery_title'],
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc(),
            'aircraft_type': aircraft_type,
            'airline_code': airline_code
        }


def write_progress(progress_file: Path, progress: dict):
    """Write progress to JSON file."""
    with open(progress_file, 'w') as f:
        json.dump(progress, f)


def main():
    # Quick self-test before full argument parsing
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

    parser = argparse.ArgumentParser(
        description='Convert MSFS aircraft models to GLB',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Convert all liveries from entire source (batch mode)
  python convert_fsltl_batch.py --source "X:/...../fsltl-traffic-base" --output "X:/mods"

  # Convert specific liveries in one aircraft (fast, for on-demand conversion)
  python convert_fsltl_batch.py --source "X:/...../fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B738_AAL" \\
    --output "X:/mods" --liveries "FSLTL_FAIB_B738_American"

  # Convert all liveries in one aircraft (fast)
  python convert_fsltl_batch.py --source "X:/...../fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B738_AAL" \\
    --output "X:/mods"

  # Convert with texture downscaling
  python convert_fsltl_batch.py --source "X:/...../fsltl-traffic-base" --output "X:/mods" --texture-scale 1k
        '''
    )
    parser.add_argument('--source', required=True, help='Path to traffic source. Can be either: (1) traffic base folder (fsltl-traffic-base or aig-aitraffic-oci) to scan all aircraft, or (2) specific aircraft folder (source/SimObjects/Airplanes/FSLTL_B738_AAL) for fast on-demand conversion.')
    parser.add_argument('--output', required=True, help='Output directory for converted models')
    parser.add_argument('--texture-scale', default='1k', choices=['full', '2k', '1k', '512'],
                        help='Texture scaling (default: 1k)')
    parser.add_argument('--liveries', help='Comma-separated list of livery titles to convert. If not specified, converts all liveries.')
    parser.add_argument('--liveries-file', help='Path to file containing livery titles (one per line)')
    parser.add_argument('--progress-file', help='Path to write progress JSON')
    parser.add_argument('--workers', type=int, default=0, help='Number of parallel workers (0=auto)')
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

    # Parse requested liveries FIRST (before discovery) so we can enable early stopping
    if args.liveries_file:
        liveries_file_path = Path(args.liveries_file)
        requested_titles = set(
            line.strip() for line in liveries_file_path.read_text().splitlines()
            if line.strip() and not line.startswith('#')
        )
    elif args.liveries:
        requested_titles = set(title.strip() for title in args.liveries.split(',') if title.strip())
    else:
        requested_titles = None

    # Discover liveries (auto-detects batch vs on-demand based on source path)
    # Pass requested_titles for early stopping optimization if specified
    print(f"Discovering liveries in {source_path}...")
    all_liveries = discover_liveries_in_source(source_path, requested_titles)

    if not all_liveries:
        print("ERROR: No liveries found in source directory")
        return 1

    folder_name = source_path.name
    if folder_name.startswith("FSLTL_") or folder_name.startswith("AIGAIM_"):
        print(f"Found {len(all_liveries)} liveries in {folder_name}")
    else:
        print(f"Found {len(all_liveries)} total liveries")

    # Filter by requested liveries if specified
    if requested_titles:
        liveries_to_convert = [l for l in all_liveries if l['livery_title'] in requested_titles]
        print(f"Filtering to {len(liveries_to_convert)} requested liveries")

        # If specific liveries were requested but none found, that's an error
        if not liveries_to_convert:
            not_found = requested_titles - {l['livery_title'] for l in all_liveries}
            print(f"ERROR: None of the requested liveries were found in source", file=sys.stderr)
            print(f"Requested: {requested_titles}", file=sys.stderr)
            if not_found:
                print(f"Not found: {not_found}", file=sys.stderr)
            # Show some available liveries for debugging
            available = [l['livery_title'] for l in all_liveries[:10]]
            print(f"Available (first 10): {available}", file=sys.stderr)
            return 1
    else:
        liveries_to_convert = all_liveries
        print(f"Converting all {len(liveries_to_convert)} liveries")

    # Determine worker count
    if args.workers <= 0:
        # Auto: use CPU count, but cap at 8 to avoid memory issues
        num_workers = min(os.cpu_count() or 4, 8)
    else:
        num_workers = args.workers

    print(f"Converting using {num_workers} workers...\n")

    # Thread-safe progress tracking
    progress_lock = threading.Lock()
    progress = {
        'status': 'converting',
        'total': len(liveries_to_convert),
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
        (livery_info, output_path, texture_scale, args.texture_scale)
        for livery_info in liveries_to_convert
    ]

    # Process in parallel
    completed_count = 0
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        # Submit all tasks
        future_to_livery = {
            executor.submit(convert_livery_task, task): task[0]['livery_title']
            for task in tasks
        }

        # Process results as they complete
        for future in as_completed(future_to_livery):
            livery_title = future_to_livery[future]
            completed_count += 1

            try:
                result = future.result()

                with progress_lock:
                    progress['completed'] = completed_count
                    progress['current'] = livery_title

                    if result.get('success'):
                        progress['converted'].append({
                            'liveryTitle': result['livery_title'],
                            'aircraftType': result['aircraft_type'],
                            'airlineCode': result['airline_code'],
                            'modelPath': result.get('output_path'),
                            'textureSize': result.get('texture_scale_name'),
                            'hasAnimations': result.get('has_animations', False),
                            'fileSize': result.get('output_size', 0),
                            'convertedAt': int(time.time() * 1000)
                        })
                        size_mb = result.get('output_size', 0) / 1024 / 1024
                        print(f"[{completed_count}/{len(liveries_to_convert)}] {livery_title} ({size_mb:.2f} MB)")
                    else:
                        error_msg = f"{livery_title}: {result.get('error', 'Unknown error')}"
                        progress['errors'].append(error_msg)
                        print(f"[{completed_count}/{len(liveries_to_convert)}] ERROR: {error_msg}")
                        if result.get('traceback'):
                            print(result['traceback'])

                update_progress()

            except Exception as e:
                with progress_lock:
                    progress['completed'] = completed_count
                    progress['errors'].append(f"{livery_title}: {str(e)}")
                print(f"[{completed_count}/{len(liveries_to_convert)}] EXCEPTION: {livery_title}: {e}")
                traceback.print_exc()
                update_progress()

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

    # Return error if nothing was successfully converted
    if successful == 0:
        print("ERROR: No models were successfully converted", file=sys.stderr)
        return 1

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
