#!/usr/bin/env python3
"""
Animation Analysis Tool

Analyzes glTF animations to understand keyframe structure and help identify
neutral positions for steering animations.

Usage:
    python analyze_animations.py "model.glb"
    python analyze_animations.py "model.glb" --animation "custom_anim_C_WHEEL_LR"
"""

import argparse
import json
import struct
import sys
import math
from pathlib import Path


def read_glb_gltf(glb_path: Path) -> dict | None:
    """Read the glTF JSON from a GLB file."""
    with open(glb_path, 'rb') as f:
        # Read GLB header (12 bytes)
        header = f.read(12)
        magic = struct.unpack('<I', header[0:4])[0]
        if magic != 0x46546C67:  # 'glTF'
            print(f"Error: Not a valid GLB file (magic: {magic:08x})")
            return None

        # Read JSON chunk header (8 bytes)
        chunk_header = f.read(8)
        json_length = struct.unpack('<I', chunk_header[0:4])[0]
        chunk_type = struct.unpack('<I', chunk_header[4:8])[0]

        if chunk_type != 0x4E4F534A:  # 'JSON'
            print(f"Error: First chunk is not JSON (type: {chunk_type:08x})")
            return None

        # Read JSON data
        json_bytes = f.read(json_length)
        gltf = json.loads(json_bytes.decode('utf-8'))

        return gltf


def read_glb_binary(glb_path: Path) -> bytes | None:
    """Read the binary buffer from a GLB file."""
    with open(glb_path, 'rb') as f:
        # Skip GLB header (12 bytes)
        f.seek(12)

        # Read JSON chunk header
        chunk_header = f.read(8)
        json_length = struct.unpack('<I', chunk_header[0:4])[0]

        # Skip JSON data
        f.seek(12 + 8 + json_length)

        # Read binary chunk header
        chunk_header = f.read(8)
        if len(chunk_header) < 8:
            return None

        bin_length = struct.unpack('<I', chunk_header[0:4])[0]
        chunk_type = struct.unpack('<I', chunk_header[4:8])[0]

        if chunk_type != 0x004E4942:  # 'BIN\0'
            print(f"Warning: Second chunk is not BIN (type: {chunk_type:08x})")
            return None

        # Read binary data
        return f.read(bin_length)


def quaternion_to_euler(quat):
    """Convert quaternion [x, y, z, w] to euler angles (roll, pitch, yaw) in degrees."""
    x, y, z, w = quat

    # Roll (x-axis rotation)
    sinr_cosp = 2 * (w * x + y * z)
    cosr_cosp = 1 - 2 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)

    # Pitch (y-axis rotation)
    sinp = 2 * (w * y - z * x)
    if abs(sinp) >= 1:
        pitch = math.copysign(math.pi / 2, sinp)
    else:
        pitch = math.asin(sinp)

    # Yaw (z-axis rotation)
    siny_cosp = 2 * (w * z + x * y)
    cosy_cosp = 1 - 2 * (y * y + z * z)
    yaw = math.atan2(siny_cosp, cosy_cosp)

    return (math.degrees(roll), math.degrees(pitch), math.degrees(yaw))


def quaternion_angle_from_identity(quat):
    """Calculate the angle (in degrees) between a quaternion and identity [0,0,0,1]."""
    x, y, z, w = quat
    # Angle from identity = 2 * acos(w), but clamp w to [-1, 1]
    w_clamped = max(-1.0, min(1.0, w))
    angle = 2 * math.acos(w_clamped)
    return math.degrees(angle)


def analyze_animation(gltf: dict, bin_data: bytes, anim_index: int, specific_anim: str | None = None):
    """Analyze a single animation and print keyframe information."""
    anim = gltf['animations'][anim_index]
    anim_name = anim.get('name', f'animation_{anim_index}')

    if specific_anim and anim_name != specific_anim:
        return

    print(f"\n{'='*80}")
    print(f"Animation: {anim_name}")
    print(f"{'='*80}")

    for channel_idx, channel in enumerate(anim.get('channels', [])):
        target_node = channel['target']['node']
        target_path = channel['target']['path']
        sampler_idx = channel['sampler']
        sampler = anim['samplers'][sampler_idx]

        node_name = gltf['nodes'][target_node].get('name', f'node_{target_node}')

        print(f"\nChannel {channel_idx}: {node_name} ({target_path})")

        # Read input accessor (timestamps)
        input_acc = gltf['accessors'][sampler['input']]
        input_bv = gltf['bufferViews'][input_acc['bufferView']]
        input_offset = input_bv.get('byteOffset', 0) + input_acc.get('byteOffset', 0)
        input_count = input_acc['count']

        # Read output accessor (values)
        output_acc = gltf['accessors'][sampler['output']]
        output_bv = gltf['bufferViews'][output_acc['bufferView']]
        output_offset = output_bv.get('byteOffset', 0) + output_acc.get('byteOffset', 0)
        output_count = output_acc['count']

        # Read all timestamps
        timestamps = []
        for i in range(input_count):
            offset = input_offset + i * 4  # FLOAT = 4 bytes
            timestamp = struct.unpack_from('<f', bin_data, offset)[0]
            timestamps.append(timestamp)

        # Read all values
        values = []
        if target_path == 'translation' or target_path == 'scale':
            # VEC3 FLOAT
            for i in range(output_count):
                offset = output_offset + i * 12  # 3 floats = 12 bytes
                value = struct.unpack_from('<3f', bin_data, offset)
                values.append(value)
        elif target_path == 'rotation':
            # VEC4 FLOAT (quaternion)
            for i in range(output_count):
                offset = output_offset + i * 16  # 4 floats = 16 bytes
                value = struct.unpack_from('<4f', bin_data, offset)
                values.append(value)

        print(f"  Keyframe count: {input_count}")
        print(f"  Duration: {timestamps[-1]:.3f}s")
        print(f"  Interpolation: {sampler.get('interpolation', 'LINEAR')}")

        # Show first, middle, and last keyframes
        if target_path == 'rotation':
            print(f"\n  Frame    Time      Quaternion [x, y, z, w]              Euler (r, p, y)           Angle from Identity")
            print(f"  {'-'*100}")

            # Find frame closest to identity
            min_angle = float('inf')
            min_angle_idx = 0
            for i, (t, v) in enumerate(zip(timestamps, values)):
                angle = quaternion_angle_from_identity(v)
                if angle < min_angle:
                    min_angle = angle
                    min_angle_idx = i

            # Show representative frames
            indices_to_show = [0, len(values) // 4, len(values) // 2, 3 * len(values) // 4, len(values) - 1]
            if min_angle_idx not in indices_to_show:
                indices_to_show.append(min_angle_idx)
            indices_to_show.sort()

            for i in indices_to_show:
                if i >= len(values):
                    continue
                t = timestamps[i]
                v = values[i]
                euler = quaternion_to_euler(v)
                angle = quaternion_angle_from_identity(v)
                marker = " <-- CLOSEST TO IDENTITY" if i == min_angle_idx else ""
                print(f"  {i:5d}    {t:7.3f}   [{v[0]:7.4f}, {v[1]:7.4f}, {v[2]:7.4f}, {v[3]:7.4f}]   ({euler[0]:7.2f}, {euler[1]:7.2f}, {euler[2]:7.2f})   {angle:7.2f} deg{marker}")

        else:
            print(f"\n  Frame    Time      Value")
            print(f"  {'-'*50}")
            indices_to_show = [0, len(values) // 2, len(values) - 1]
            for i in indices_to_show:
                if i >= len(values):
                    continue
                t = timestamps[i]
                v = values[i]
                if isinstance(v, tuple):
                    v_str = f"[{', '.join(f'{x:.4f}' for x in v)}]"
                else:
                    v_str = f"{v:.4f}"
                print(f"  {i:5d}    {t:7.3f}   {v_str}")


def main():
    parser = argparse.ArgumentParser(description='Analyze glTF animations')
    parser.add_argument('glb_file', help='Path to GLB file')
    parser.add_argument('--animation', '-a', help='Analyze specific animation by name')
    parser.add_argument('--list', '-l', action='store_true', help='List all animations and exit')

    args = parser.parse_args()
    glb_path = Path(args.glb_file)

    if not glb_path.exists():
        print(f"Error: File not found: {glb_path}")
        return 1

    print(f"Reading: {glb_path}")

    gltf = read_glb_gltf(glb_path)
    if not gltf:
        return 1

    bin_data = read_glb_binary(glb_path)
    if not bin_data:
        print("Warning: No binary data found")

    if 'animations' not in gltf:
        print("No animations found in file")
        return 0

    print(f"\nFound {len(gltf['animations'])} animations")

    if args.list:
        print("\nAnimations:")
        for i, anim in enumerate(gltf['animations']):
            name = anim.get('name', f'animation_{i}')
            channel_count = len(anim.get('channels', []))
            print(f"  {i}: {name} ({channel_count} channels)")
        return 0

    # Analyze animations
    for i in range(len(gltf['animations'])):
        analyze_animation(gltf, bin_data, i, args.animation)

    return 0


if __name__ == '__main__':
    sys.exit(main())
