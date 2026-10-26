#!/usr/bin/env python3
"""
FSLTL/AIG Model Converter

Converts MSFS aircraft models from glTF with DDS textures to self-contained GLB files.

The app hands over one JSON job naming the glTF, its texture folders, the texture scale and,
for each livery, its title and the absolute path of the GLB to write; the converter writes each
GLB at exactly that path and reports per livery in a JSON result file.

Usage:
    python convert_fsltl_batch.py --job job.json --result result.json

    # Check that the bundled dependencies load:
    python convert_fsltl_batch.py --self-test

Job (UTF-8 JSON):
    {"version": 1, "source": "fsltl" | "aig", "texture_scale": "full" | "2k" | "1k" | "512",
     "gltf_path": "...", "texture_dirs": ["..."],
     "liveries": [{"title": "...", "output": "<absolute path ending .glb>"}]}

Result (UTF-8 JSON):
    {"version": 1, "outputs": [{"title": "...", "path": "...", "ok": true, "error": null}],
     "errors": ["..."]}

Exit codes: 0 every livery converted, 1 at least one failed, 2 the job is invalid.
"""

import sys
import json
import traceback  # Safe stdlib import - needed for error handling
from pathlib import Path


def _startup_error(error_msg: str, details: str) -> None:
    """Print an error that stopped the converter before it could start."""
    print(f"STARTUP ERROR: {error_msg}\n{details}", file=sys.stderr)


# Import everything else, catching any failures
try:
    import argparse
    import struct
    from PIL import Image
    import numpy as np
    import io
    import time
    import os
except ImportError as e:
    _startup_error(
        f"Failed to import required module: {e.name}",
        f"Full error: {e}\n\nThis usually means the converter was not built correctly.\nPlease run 'pnpm run build:converter' to rebuild."
    )
    sys.exit(1)
except Exception as e:
    _startup_error(f"Unexpected error during startup: {type(e).__name__}", traceback.format_exc())
    sys.exit(1)

# Converter version - increment when conversion logic changes to invalidate cached models
# Version history:
#   1: Initial version with source metadata embedding
#   2: Added animation baking for MSFS models (fixes misaligned flaps, slats, gear, etc.)
#   3: Fixed steering animations by using identity quaternion frame instead of frame 0
#   4: Fixed model.cfg parsing to read GLTF filename from XML (fixes wrong engine variant textures)
#   5: Fixed base_container resolution for FSLTL freighter variants (e.g., B77LF, B744F)
#   6: Added --no-discovery mode; Rust now handles model.cfg parsing (fixes wrong engine variant for liveries)
#   8: Exclude cargo/attachment GLTFs from model selection
#   9: The app hands over a JSON job; output names are a sanitized title plus a hash of it
CONVERTER_VERSION = 9  # Bump when converter output changes

# The job format version this converter reads
JOB_VERSION = 1


# Texture scale limits
TEXTURE_SCALE_MAP = {
    'full': None,   # No scaling
    '2k': 2048,
    '1k': 1024,
    '512': 512
}

# Suffixes tried, in order, after a texture name when looking for its file
TEXTURE_EXTENSIONS = ['.DDS', '.dds', '.PNG', '.png', '.png.dds', '.PNG.DDS', '']

# Windows device names, refused as file names with or without an extension
DOS_DEVICE_NAMES = frozenset(
    ['CON', 'PRN', 'AUX', 'NUL']
    + [f'COM{n}' for n in range(1, 10)]
    + [f'LPT{n}' for n in range(1, 10)]
)

# Characters a plain file name may not hold: separators, a drive or stream colon, and Windows wildcards
RESERVED_NAME_CHARS = frozenset('/\\:<>"|?*')


def warn(message: str) -> None:
    """Print a conversion warning on stderr."""
    print(f"  Warning: {message}", file=sys.stderr)


def is_plain_name(name: str) -> bool:
    """Whether `name` is one plain file name that can only mean an entry in the folder it is joined to.

    Refuses an empty name, `.` and `..`, a name ending in a dot or a space (Windows strips them, so
    `t.bin.` opens `t.bin`), separators, a colon (a drive, an NTFS stream or any URI scheme, `data:`
    included), NUL and other control characters, Windows wildcards, and device names such as `CON`
    or `com1.bin`.
    """
    if name in ('', '.', '..') or name[-1] in '. ':
        return False
    if any(ch in RESERVED_NAME_CHARS or ord(ch) < 32 or ord(ch) == 127 for ch in name):
        return False
    return name.split('.')[0].rstrip(' ').upper() not in DOS_DEVICE_NAMES


def find_package_root(path: Path) -> Path:
    """The MSFS package `path` belongs to: the parent of its nearest `SimObjects/Airplanes` ancestor.

    Raises:
        ValueError: When no ancestor of `path` is an `Airplanes` folder inside a `SimObjects` folder.
    """
    absolute = Path(os.path.abspath(path))
    for folder in (absolute, *absolute.parents):
        if folder.name.lower() == 'airplanes' and folder.parent.name.lower() == 'simobjects':
            return folder.parent.parent
    raise ValueError(
        f"{path} is not inside a SimObjects/Airplanes folder, so the package it belongs to is unknown; "
        "models are converted only from an MSFS package"
    )


def _without_extended_prefix(path: str) -> str:
    """`path` without a Windows `\\\\?\\` or `\\\\?\\UNC\\` prefix, for comparing with paths that lack it."""
    if path.startswith('\\\\?\\UNC\\'):
        return '\\\\' + path[8:]
    if path.startswith('\\\\?\\'):
        return path[4:]
    return path


def resolve_inside(package_root: Path, path: Path) -> Path | None:
    """The real path of `path` when it lies inside the real path of `package_root`, else None.

    Both sides go through `os.path.realpath`, which follows junctions and symlinks, so a link
    inside the package that leads out of it is refused. The returned path is the one to open.
    """
    real_root = os.path.normcase(_without_extended_prefix(os.path.realpath(package_root)))
    real_path = os.path.realpath(path)
    comparable = os.path.normcase(_without_extended_prefix(real_path))
    try:
        common = os.path.commonpath([real_root, comparable])
    except ValueError:
        return None  # different drives, so the path cannot be inside the root
    return Path(real_path) if common == real_root else None


def texture_dirs_inside(package_root: Path, texture_dirs: list[Path]) -> list[Path]:
    """The resolved texture folders that lie inside the package; each one outside it is dropped with a warning."""
    kept = []
    for folder in texture_dirs:
        resolved = resolve_inside(package_root, folder)
        if resolved is None:
            warn(f"texture folder {folder} is outside the package {package_root}; not searching it")
        else:
            kept.append(resolved)
    return kept


def check_gltf_uris(gltf: dict) -> None:
    """Refuse a glTF whose buffer or image URI is anything but a plain file name.

    Raises:
        ValueError: Naming the URI's role and index (`buffer 0`, `image 3`) and the refused value.
    """
    for role, key in (('buffer', 'buffers'), ('image', 'images')):
        for index, entry in enumerate(gltf.get(key, [])):
            uri = entry.get('uri', '')
            if not isinstance(uri, str) or (uri and not is_plain_name(uri)):
                raise ValueError(
                    f"{role} {index} URI {uri!r} is not a plain file name beside the glTF; "
                    "paths, URI schemes and device names are refused"
                )


def convert_dds_to_png(dds_path: Path, target_size: int | None = None) -> bytes:
    """Convert DDS file to PNG bytes, optionally resizing.

    Pillow decodes the DDS pixel formats MSFS uses (BC1/BC3/BC5/BC7 and DX10);
    any format Pillow can't decode falls back to a neutral placeholder.

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
        # Pillow can't decode this DDS pixel format (rare — modern Pillow handles
        # BC1/BC3/BC5/BC7 and DX10). Emit a neutral placeholder so the rest of the
        # model still converts.
        print(f"  Warning: Could not decode {dds_path.name} (unsupported DDS format), using placeholder")
        img = Image.new('RGBA', (64, 64), (128, 128, 128, 255))
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        return buffer.getvalue()


def find_texture_file(texture_name: str, model_dir: Path, texture_dirs: list[Path], package_root: Path) -> Path | None:
    """Find a texture file by name in the model folder, then in each texture folder.

    Returns the resolved path of the first file found inside the package; a file that resolves
    outside it (a link) is passed over with a warning.
    """
    for folder in [model_dir, *texture_dirs]:
        for ext in TEXTURE_EXTENSIONS:
            candidate = folder / f"{texture_name}{ext}"
            if not candidate.is_file():
                continue
            resolved = resolve_inside(package_root, candidate)
            if resolved is not None:
                return resolved
            warn(f"texture {candidate} resolves outside the package {package_root}; not reading it")

    return None


def sample_dominant_light_color(png_data: bytes) -> tuple[float, float, float] | None:
    """Sample the dominant light/white color from PNG image data.

    Analyzes the brightest pixels in the image to find the most common
    light color, which can be used for FROST material replacement.

    Returns RGB values as floats in [0, 1] range, or None if sampling fails.
    """
    try:
        img = Image.open(io.BytesIO(png_data))
        img = img.convert('RGB')

        # Resize for faster sampling (we don't need full resolution)
        sample_size = 128
        if max(img.size) > sample_size:
            ratio = sample_size / max(img.size)
            new_size = (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            img = img.resize(new_size, Image.NEAREST)

        # Get all pixels
        pixels = list(img.getdata())

        # Filter to light pixels (brightness > 200 out of 255)
        # This captures whites and near-whites
        light_pixels = []
        for r, g, b in pixels:
            brightness = (r + g + b) / 3
            if brightness > 200:
                light_pixels.append((r, g, b))

        if not light_pixels:
            # No very light pixels found, lower the threshold
            for r, g, b in pixels:
                brightness = (r + g + b) / 3
                if brightness > 150:
                    light_pixels.append((r, g, b))

        if not light_pixels:
            # Still nothing, return a default off-white
            return (0.95, 0.95, 0.95)

        # Find the most common light color (simple mode)
        # Group similar colors (within 10 units)
        from collections import Counter
        quantized = [(r // 10 * 10, g // 10 * 10, b // 10 * 10) for r, g, b in light_pixels]
        most_common = Counter(quantized).most_common(1)[0][0]

        # Return normalized RGB
        return (most_common[0] / 255.0, most_common[1] / 255.0, most_common[2] / 255.0)

    except Exception:
        return None


def detect_animations(gltf: dict) -> bool:
    """Check if model has landing gear or other relevant animations."""
    animations = gltf.get('animations', [])
    for anim in animations:
        name = anim.get('name', '').lower()
        if 'gear' in name or 'landing' in name or 'wheel' in name:
            return True
    return False


TEMP_FILE_MAX_AGE_SECONDS = 3600  # Stale temp files left behind by a killed conversion


def sweep_stale_temp_files(folder: Path) -> None:
    """Remove the temp files an interrupted conversion left in the output folder."""
    cutoff = time.time() - TEMP_FILE_MAX_AGE_SECONDS
    try:
        entries = list(folder.iterdir())
    except OSError as e:
        print(f"WARNING: could not list {folder} to sweep temp files: {e}", file=sys.stderr)
        return
    for path in entries:
        if not (path.name.startswith('.') and path.name.endswith('.tmp')):
            continue
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
        except FileNotFoundError:
            continue  # its writer renamed it into place between the listing and the removal
        except OSError as e:
            print(f"WARNING: could not remove stale temp file {path}: {e}", file=sys.stderr)


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
    package_root = find_package_root(gltf_path)
    resolved_gltf = resolve_inside(package_root, gltf_path)
    if resolved_gltf is None:
        raise ValueError(f"glTF {gltf_path} resolves outside its package {package_root}")
    model_dir = resolved_gltf.parent
    search_dirs = texture_dirs_inside(package_root, texture_dirs)

    # Load GLTF
    with open(resolved_gltf, 'r', encoding='utf-8') as f:
        gltf = json.load(f)
    check_gltf_uris(gltf)

    # Detect animations
    has_animations = detect_animations(gltf)

    # Load binary buffer
    buffer_uri = gltf['buffers'][0].get('uri', '')
    if buffer_uri:
        bin_file = resolve_inside(package_root, model_dir / buffer_uri)
        if bin_file is None:
            raise ValueError(f"buffer 0 URI {buffer_uri!r} resolves outside the package {package_root}")
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
                texture_path = find_texture_file(uri, model_dir, search_dirs, package_root)
                if texture_path is None:
                    base_name = Path(uri).stem
                    if base_name.endswith('.PNG') or base_name.endswith('.png'):
                        base_name = base_name[:-4]
                    if is_plain_name(base_name):
                        texture_path = find_texture_file(base_name, model_dir, search_dirs, package_root)

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
    # First, find the dominant light color from the LIVERY texture for FROST material replacement
    frost_replacement_color = None
    if 'materials' in gltf:
        textures = gltf.get('textures', [])
        for mat in gltf['materials']:
            mat_name = mat.get('name', '').upper()
            if mat_name == 'LIVERY':
                # Get the base color texture from LIVERY material
                pbr = mat.get('pbrMetallicRoughness', {})
                base_tex = pbr.get('baseColorTexture', {})
                tex_idx = base_tex.get('index')
                if tex_idx is not None and tex_idx < len(textures):
                    tex = textures[tex_idx]
                    # Get image index (check both standard and DDS extension)
                    img_idx = tex.get('source')
                    if img_idx is None and 'extensions' in tex:
                        dds_ext = tex['extensions'].get('MSFT_texture_dds', {})
                        img_idx = dds_ext.get('source')
                    if img_idx is not None and img_idx < len(image_buffers):
                        frost_replacement_color = sample_dominant_light_color(image_buffers[img_idx])
                break

    if 'materials' in gltf:
        for mat_idx, mat in enumerate(gltf['materials']):
            mat_name = mat.get('name', '').upper()

            # Detect FROST materials by name - these are MSFS 2024 ice/frost effects that
            # don't render correctly without MSFS-specific extensions (show as magenta).
            # Note: ASOBO_material_blend_gbuffer is used by many materials (decals, liveries,
            # registration numbers) so we can't just check for that extension.
            is_frost_material = mat_name == 'FROST'

            if 'extensions' in mat:
                keys_to_remove = [k for k in mat['extensions']
                                  if k in extensions_to_remove or k.startswith(asobo_prefix)]
                for ext in keys_to_remove:
                    mat['extensions'].pop(ext, None)
                if not mat['extensions']:
                    del mat['extensions']

            # FROST materials: use dominant light color from LIVERY texture (or default off-white)
            # This makes the frost blend with the aircraft's paint scheme
            if is_frost_material:
                mat['alphaMode'] = 'OPAQUE'
                mat['doubleSided'] = True
                # Use sampled color or default off-white
                r, g, b = frost_replacement_color or (0.95, 0.95, 0.95)
                pbr = mat.get('pbrMetallicRoughness', {})
                pbr['baseColorFactor'] = [r, g, b, 1.0]
                # Remove any texture - use solid color
                if 'baseColorTexture' in pbr:
                    del pbr['baseColorTexture']
                pbr['metallicFactor'] = 0.0
                pbr['roughnessFactor'] = 1.0
                mat['pbrMetallicRoughness'] = pbr
                continue  # Skip normal material processing for FROST materials

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

    # Write beside the final name, then rename into place: a failed or killed conversion
    # never leaves a truncated GLB under the name the app loads
    temp_path = output_path.with_name(f'.{output_path.name}.{os.getpid()}.tmp')
    try:
        with open(temp_path, 'wb') as f:
            f.write(header)
            f.write(json_chunk_header)
            f.write(json_bytes)
            f.write(bin_chunk_header)
            f.write(bytes(bin_data))
        os.replace(temp_path, output_path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    return {
        'success': True,
        'has_animations': has_animations,
        'output_size': total_length
    }


class JobError(ValueError):
    """A job the converter cannot run: unreadable, of another version, or missing a field."""


# Every job field with the type its value must have
JOB_FIELDS = {
    'version': int,
    'source': str,
    'texture_scale': str,
    'gltf_path': str,
    'texture_dirs': list,
    'liveries': list,
}

JOB_SOURCES = ('fsltl', 'aig')


def _check_field_types(job: dict) -> None:
    """Raise JobError for the first job field that is missing or holds the wrong type."""
    for field, kind in JOB_FIELDS.items():
        if field not in job:
            raise JobError(f"job field {field!r} is missing")
        value = job[field]
        if not isinstance(value, kind) or isinstance(value, bool):
            raise JobError(f"job field {field!r} must be a {kind.__name__}")


def _check_values(job: dict) -> None:
    """Raise JobError for the first of source, texture_scale and texture_dirs outside its allowed values."""
    if job['source'] not in JOB_SOURCES:
        raise JobError(f"job source {job['source']!r} is not one of {', '.join(JOB_SOURCES)}")
    if job['texture_scale'] not in TEXTURE_SCALE_MAP:
        raise JobError(f"job texture_scale {job['texture_scale']!r} is not one of {', '.join(TEXTURE_SCALE_MAP)}")
    if not all(isinstance(folder, str) for folder in job['texture_dirs']):
        raise JobError("job field 'texture_dirs' must hold only strings")


def _check_liveries(liveries: list) -> None:
    """Raise JobError unless `liveries` is a non-empty list of {title, output} string pairs."""
    if not liveries:
        raise JobError("job field 'liveries' is empty")
    for index, livery in enumerate(liveries):
        if not isinstance(livery, dict):
            raise JobError(f"livery {index} must be an object")
        for field in ('title', 'output'):
            if not isinstance(livery.get(field), str):
                raise JobError(f"livery {index} field {field!r} is missing or not a string")


def read_job(job_path: Path) -> dict:
    """The job at `job_path`, checked against the job format.

    Raises:
        JobError: When the file cannot be read or parsed, its version is not JOB_VERSION, or a
            field is missing, of the wrong type or outside its allowed values.
    """
    try:
        job = json.loads(job_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        raise JobError(f"cannot read job {job_path}: {e}") from e
    if not isinstance(job, dict):
        raise JobError(f"job {job_path} is not a JSON object")
    version = job.get('version')
    if version != JOB_VERSION or isinstance(version, bool):
        raise JobError(f"job version {version!r} is not supported; this converter reads version {JOB_VERSION}")
    _check_field_types(job)
    _check_values(job)
    _check_liveries(job['liveries'])
    return job


def output_refusal(output: str) -> str | None:
    """Why the job's `output` path is refused, or None when it may be written.

    The path must be absolute with no `..` step, and its file name a plain name that does not
    start with a dot and ends `.glb`.
    """
    path = Path(output)
    if not path.is_absolute():
        return f"output {output!r} is not an absolute path"
    if '..' in path.parts:
        return f"output {output!r} steps out of its folder with '..'"
    name = path.name
    if not is_plain_name(name) or name.startswith('.') or not name.lower().endswith('.glb'):
        return f"output file name {name!r} is not a plain name ending .glb"
    return None


def aircraft_type_of(folder_name: str) -> str:
    """The aircraft type in an aircraft folder name: `B738` in `FSLTL_B738_AAL`, `A320` in `AIGAIM_Airbus_A320-200_CFM`."""
    parts = folder_name.split('_')
    if folder_name.startswith('FSLTL_'):
        return parts[1] if len(parts) > 1 else ''
    if folder_name.startswith('AIGAIM_'):
        return parts[2].split('-')[0] if len(parts) > 2 else ''
    return parts[1] if len(parts) > 1 else folder_name


def convert_livery(job: dict, livery: dict) -> dict:
    """Convert one livery of `job` to its output path; returns its result entry."""
    title, output = livery['title'], livery['output']
    entry = {'title': title, 'path': output, 'ok': False, 'error': None}
    refusal = output_refusal(output)
    if refusal:
        entry['error'] = refusal
        return entry
    output_path = Path(output)
    gltf_path = Path(job['gltf_path'])
    texture_dirs = [Path(folder) for folder in job['texture_dirs']]
    # The folder holding the glTF's model folder: the aircraft the model belongs to
    folder_name = gltf_path.parent.parent.name
    source_metadata = {
        'source': job['source'],
        'livery_title': title,
        'folder_name': folder_name,
        'aircraft_type': aircraft_type_of(folder_name),
        'icao_airline': None,
        'gltf_path': str(gltf_path),
        'texture_dirs': [str(folder) for folder in texture_dirs],
        'aircraft_folder': None,
    }
    try:
        if output_path.parent.is_dir():
            sweep_stale_temp_files(output_path.parent)
        convert_single_gltf(gltf_path, output_path, texture_dirs, TEXTURE_SCALE_MAP[job['texture_scale']], source_metadata)
        entry['ok'] = True
    except Exception as e:
        entry['error'] = str(e) or type(e).__name__
        print(f"ERROR: {title}: {entry['error']}", file=sys.stderr)
        traceback.print_exc()
    return entry


def write_result(result_path: Path, outputs: list[dict], errors: list[str]) -> None:
    """Write the result file: one entry per livery and every error message."""
    result = {'version': JOB_VERSION, 'outputs': outputs, 'errors': errors}
    result_path.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')


def run_job(job_path: Path, result_path: Path) -> int:
    """Run the job at `job_path`, writing the result to `result_path`; returns the exit code."""
    try:
        job = read_job(job_path)
    except JobError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        try:
            write_result(result_path, [], [str(e)])
        except OSError as write_error:
            print(f"ERROR: could not write the result {result_path}: {write_error}", file=sys.stderr)
        return 2
    outputs = [convert_livery(job, livery) for livery in job['liveries']]
    errors = [f"{entry['title']}: {entry['error']}" for entry in outputs if not entry['ok']]
    write_result(result_path, outputs, errors)
    converted = len(outputs) - len(errors)
    print(f"Conversion complete: {converted} converted, {len(errors)} failed")
    return 0 if not errors else 1


def self_test() -> int:
    """Check that the bundled dependencies load and work."""
    print("Self-test: Checking bundled dependencies...")
    print(f"  Python: {sys.version}")
    print(f"  PIL: {Image.__version__ if hasattr(Image, '__version__') else 'OK'}")
    print(f"  NumPy: {np.__version__}")
    print("  Struct: OK")
    arr = np.array([1, 2, 3], dtype=np.float32)
    assert arr.sum() == 6.0, "NumPy operation failed"
    print("  NumPy operations: OK")
    print("Self-test PASSED: All dependencies working correctly.")
    return 0


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        # A test's captured stream is not a TextIOWrapper and takes any text as it is
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding='utf-8', errors='replace')

    # The self-test needs no job
    if '--self-test' in argv:
        return self_test()

    parser = argparse.ArgumentParser(
        description='Convert MSFS aircraft models to GLB',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Convert the liveries a job names, reporting in result.json
  python convert_fsltl_batch.py --job job.json --result result.json

  # Check that the bundled dependencies load
  python convert_fsltl_batch.py --self-test

Exit codes: 0 every livery converted, 1 at least one failed, 2 the job is invalid.
        '''
    )
    parser.add_argument('--job', required=True, help='The JSON job file to convert')
    parser.add_argument('--result', required=True, help='Where to write the JSON result file')
    parser.add_argument('--self-test', action='store_true', help='Test that all dependencies are bundled correctly')
    args = parser.parse_args(argv)
    return run_job(Path(args.job), Path(args.result))


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as e:
        _startup_error(f"Converter crashed: {type(e).__name__}: {e}", traceback.format_exc())
        sys.exit(1)
