#!/usr/bin/env python3
"""Convert FSLTL GLTF with DDS textures to a self-contained GLB file.

Handles MSFS-specific extensions and float16 UV coordinates stored as SHORT.
"""

import json
import struct
from pathlib import Path
from PIL import Image
import numpy as np
import io
import sys

def convert_dds_to_png(dds_path: Path) -> bytes:
    """Convert DDS file to PNG bytes."""
    img = Image.open(dds_path)
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

def main():
    if len(sys.argv) < 3:
        print("Usage: convert_fsltl_glb.py <input.gltf> <output.glb> [texture_dir]")
        sys.exit(1)

    gltf_path = Path(sys.argv[1])
    glb_path = Path(sys.argv[2])

    model_dir = gltf_path.parent
    aircraft_dir = model_dir.parent

    # Find texture directories
    texture_dirs = []
    if len(sys.argv) > 3:
        override_tex = Path(sys.argv[3])
        if override_tex.exists():
            texture_dirs.append(override_tex)
            print(f"Using override texture dir: {override_tex}")

    texture_dirs.extend(list(aircraft_dir.glob("TEXTURE*")))
    texture_dirs.extend(list(aircraft_dir.glob("texture*")))
    print(f"Texture directories: {[d.name for d in texture_dirs]}")

    # Load GLTF
    with open(gltf_path, 'r') as f:
        gltf = json.load(f)

    # Load binary buffer
    bin_file = model_dir / gltf['buffers'][0]['uri']
    with open(bin_file, 'rb') as f:
        bin_data = bytearray(f.read())

    # Process images - convert DDS to PNG
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
                    print(f"Converting texture {i}: {texture_path.name}")
                    png_data = convert_dds_to_png(texture_path)
                    image_buffers.append(png_data)
                else:
                    print(f"Warning: Could not find texture: {uri}")
                    img = Image.new('RGBA', (1, 1), (255, 0, 255, 255))
                    buffer = io.BytesIO()
                    img.save(buffer, format='PNG')
                    image_buffers.append(buffer.getvalue())

    # Convert float16 UVs to float32
    # MSFS stores UVs as float16 but declares them as SHORT (5122)
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

            # Remove COLOR_0 - MSFS stores these as float16 which causes color issues
            if 'COLOR_0' in attrs:
                del attrs['COLOR_0']

            # Remove TEXCOORD_1 if not needed (often unused)
            if 'TEXCOORD_1' in attrs:
                del attrs['TEXCOORD_1']

            # Remove NORMAL and TANGENT - MSFS uses VEC4 normals which cause shader errors
            if 'NORMAL' in attrs:
                del attrs['NORMAL']
            if 'TANGENT' in attrs:
                del attrs['TANGENT']

    print(f"Converting {len(uv_accessors)} UV accessors from float16 to float32")

    # Build new buffer with float32 UVs
    new_uv_data = bytearray()
    uv_accessor_mapping = {}  # old_idx -> new buffer view info

    for acc_idx, acc in uv_accessors.items():
        if acc['componentType'] != 5122:  # Only convert SHORT (which is actually float16)
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

    # Create new buffer views and update accessors for UVs
    # First, add image data to bin_data
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

    # Add float32 UV data as a new buffer view
    uv_bv_start = current_offset
    bin_data += new_uv_data
    current_offset += len(new_uv_data)

    padding_needed = (4 - (current_offset % 4)) % 4
    bin_data += b'\x00' * padding_needed
    current_offset = len(bin_data)

    # Create buffer view for all UV data
    uv_buffer_view_idx = len(gltf['bufferViews'])
    gltf['bufferViews'].append({
        'buffer': 0,
        'byteOffset': uv_bv_start,
        'byteLength': len(new_uv_data)
    })

    # Update UV accessors to point to new float32 data
    for acc_idx, mapping in uv_accessor_mapping.items():
        acc = accessors[acc_idx]
        acc['bufferView'] = uv_buffer_view_idx
        acc['byteOffset'] = mapping['offset']
        acc['componentType'] = 5126  # FLOAT
        acc['normalized'] = False
        if 'min' in acc:
            del acc['min']
        if 'max' in acc:
            del acc['max']

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

            # Fix PBR settings - MSFS _M textures use different channel layout
            # Remove metallicRoughnessTexture and set factors for a basic diffuse look
            pbr = mat.get('pbrMetallicRoughness', {})
            if 'metallicRoughnessTexture' in pbr:
                del pbr['metallicRoughnessTexture']
            pbr['metallicFactor'] = 0.0  # Non-metallic
            pbr['roughnessFactor'] = 1.0  # Fully rough (diffuse)
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

    # Write GLB
    with open(glb_path, 'wb') as f:
        f.write(header)
        f.write(json_chunk_header)
        f.write(json_bytes)
        f.write(bin_chunk_header)
        f.write(bytes(bin_data))

    print(f"Created {glb_path} ({total_length / 1024 / 1024:.2f} MB)")

if __name__ == '__main__':
    main()
