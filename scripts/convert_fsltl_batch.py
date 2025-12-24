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

import argparse
import json
import struct
from pathlib import Path
from PIL import Image
import numpy as np
import io
import sys
import traceback

# Texture scale limits
TEXTURE_SCALE_MAP = {
    'full': None,   # No scaling
    '2k': 2048,
    '1k': 1024,
    '512': 512
}


def convert_dds_to_png(dds_path: Path, target_size: int | None = None) -> bytes:
    """Convert DDS file to PNG bytes, optionally resizing."""
    img = Image.open(dds_path)

    # Convert to RGBA if needed
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    # Resize if target_size is specified and image is larger
    if target_size is not None and max(img.size) > target_size:
        ratio = target_size / max(img.size)
        new_size = (int(img.width * ratio), int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)

    buffer = io.BytesIO()
    img.save(buffer, format='PNG', optimize=True)
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


def find_model_gltf(aircraft_dir: Path) -> tuple[Path | None, list[Path]]:
    """
    Find the GLTF file and texture directories for an aircraft.
    Returns (gltf_path, texture_dirs)
    """
    # Find model directory (usually model.* or MODEL.*)
    model_dirs = list(aircraft_dir.glob("model*")) + list(aircraft_dir.glob("MODEL*"))

    for model_dir in model_dirs:
        if model_dir.is_dir():
            # Look for LOD0 GLTF file
            gltf_files = list(model_dir.glob("*LOD0.gltf")) + list(model_dir.glob("*LOD0.GLTF"))
            if gltf_files:
                # Find texture directories
                texture_dirs = list(aircraft_dir.glob("TEXTURE*")) + list(aircraft_dir.glob("texture*"))
                return gltf_files[0], texture_dirs

    return None, []


def parse_model_name(model_name: str) -> tuple[str, str | None]:
    """
    Parse FSLTL model name into aircraft type and airline code.
    e.g., "FSLTL_B738_AAL" -> ("B738", "AAL")
          "FSLTL_B738_ZZZZ" -> ("B738", None)  # base livery
    """
    parts = model_name.split('_')
    if len(parts) >= 2:
        aircraft_type = parts[1]
        airline_code = parts[2] if len(parts) > 2 else None
        # ZZZZ is the generic/base livery code
        if airline_code == 'ZZZZ':
            airline_code = None
        return aircraft_type, airline_code
    return model_name, None


def write_progress(progress_file: Path, progress: dict):
    """Write progress to JSON file."""
    with open(progress_file, 'w') as f:
        json.dump(progress, f)


def main():
    parser = argparse.ArgumentParser(description='Convert FSLTL models to GLB')
    parser.add_argument('--source', required=True, help='Path to fsltl-traffic-base')
    parser.add_argument('--output', required=True, help='Output directory for converted models')
    parser.add_argument('--texture-scale', default='1k', choices=['full', '2k', '1k', '512'],
                        help='Texture scaling (default: 1k)')
    parser.add_argument('--progress-file', help='Path to write progress JSON')
    parser.add_argument('--models', help='Comma-separated list of model names to convert')
    args = parser.parse_args()

    source_path = Path(args.source)
    output_path = Path(args.output)
    texture_scale = TEXTURE_SCALE_MAP[args.texture_scale]
    progress_file = Path(args.progress_file) if args.progress_file else None

    # Parse model list
    if args.models:
        models_to_convert = [m.strip() for m in args.models.split(',') if m.strip()]
    else:
        # Convert all models if none specified
        airplanes_path = source_path / "SimObjects" / "Airplanes"
        models_to_convert = [
            d.name for d in airplanes_path.iterdir()
            if d.is_dir() and d.name.startswith('FSLTL_')
        ]

    progress = {
        'status': 'scanning',
        'total': len(models_to_convert),
        'completed': 0,
        'current': None,
        'errors': []
    }

    if progress_file:
        write_progress(progress_file, progress)

    progress['status'] = 'converting'
    results = []

    for i, model_name in enumerate(models_to_convert):
        progress['current'] = model_name
        if progress_file:
            write_progress(progress_file, progress)

        try:
            # Find aircraft directory
            aircraft_dir = source_path / "SimObjects" / "Airplanes" / model_name
            if not aircraft_dir.exists():
                raise FileNotFoundError(f"Aircraft directory not found: {aircraft_dir}")

            # Find GLTF and textures
            gltf_path, texture_dirs = find_model_gltf(aircraft_dir)
            if gltf_path is None:
                raise FileNotFoundError(f"No GLTF file found in {aircraft_dir}")

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
            results.append(result)

            print(f"[{i+1}/{len(models_to_convert)}] Converted {model_name} -> {model_output.name} "
                  f"({result['output_size'] / 1024 / 1024:.2f} MB)")

        except Exception as e:
            error_msg = f"{model_name}: {str(e)}"
            progress['errors'].append(error_msg)
            results.append({
                'model_name': model_name,
                'success': False,
                'error': str(e)
            })
            print(f"[{i+1}/{len(models_to_convert)}] Error converting {model_name}: {e}")
            traceback.print_exc()

        progress['completed'] = i + 1
        if progress_file:
            write_progress(progress_file, progress)

    # Final status
    progress['status'] = 'complete' if not progress['errors'] else 'error'
    progress['current'] = None
    if progress_file:
        write_progress(progress_file, progress)

    # Summary
    successful = sum(1 for r in results if r.get('success'))
    failed = len(results) - successful
    print(f"\nConversion complete: {successful} successful, {failed} failed")

    if progress['errors']:
        print("\nErrors:")
        for error in progress['errors']:
            print(f"  - {error}")

    return 0 if not failed else 1


if __name__ == '__main__':
    sys.exit(main())
