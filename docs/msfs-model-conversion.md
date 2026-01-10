# MSFS Model Conversion Pipeline

This document describes the complete pipeline for converting Microsoft Flight Simulator (MSFS) aircraft models from FSLTL and AIG traffic add-ons into GLB format usable by TowerCab 3D.

## Overview

MSFS uses a modified glTF format with:
- Separate `.gltf` (JSON) and `.bin` (binary) files
- DDS textures (including BC7/DXT10 compressed formats)
- MSFS-specific extensions (ASOBO_*, MSFT_texture_dds)
- Non-standard data encoding (float16 UVs stored as SHORT)

Our converter transforms these into self-contained GLB files with embedded PNG textures.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TowerCab 3D Application                       │
├─────────────────────────────────────────────────────────────────┤
│  MSFSModelConversionService.ts (TypeScript)                     │
│  - Detects FSLTL/AIG installations                              │
│  - Builds model indexes from aircraft.cfg                       │
│  - Manages conversion queue and caching                         │
│  - Calls Rust backend for conversion                            │
├─────────────────────────────────────────────────────────────────┤
│  msfs.rs (Rust/Tauri Backend)                                   │
│  - Spawns Python converter as sidecar process                   │
│  - Handles file I/O and path resolution                         │
│  - Caches model indexes as JSON                                 │
├─────────────────────────────────────────────────────────────────┤
│  fsltl_converter.exe (Python/PyInstaller)                       │
│  - Parses GLTF JSON structure                                   │
│  - Converts DDS textures to PNG                                 │
│  - Transforms data formats (float16 → float32)                  │
│  - Assembles GLB binary                                         │
└─────────────────────────────────────────────────────────────────┘
```

## Source Model Differences

### FSLTL Models
- **Skinning**: None (no `skins` array)
- **Animations**: Node-based only (gear rotation/translation)
- **Attributes**: POSITION, TEXCOORD_0, TEXCOORD_1, NORMAL, TANGENT, COLOR_0
- **Complexity**: Simpler, designed for AI traffic performance

### AIG Models
- **Skinning**: Yes in source (wing flex, stabilizer flex via GPU skinning)
  - **Note**: Skinning is stripped during conversion due to MSFS/glTF incompatibility
  - Wings render correctly without skinning (vertices already in model space)
  - Slats use non-skinned bone-parented meshes (r_slats1/l_slats1)
- **Animations**: Both node-based and skeletal (Wingflex_L/R, Stabilizer_Flex)
- **Attributes**: POSITION, TEXCOORD_0, TEXCOORD_1, NORMAL, TANGENT, COLOR_0, JOINTS_0, WEIGHTS_0
  - **Note**: JOINTS_0 and WEIGHTS_0 are removed during conversion (skinning stripped)
- **Complexity**: Higher fidelity, more detailed models

## Conversion Steps

### 1. GLTF Parsing
```python
with open(gltf_path, 'r', encoding='utf-8') as f:
    gltf = json.load(f)
```

Load the source GLTF JSON and binary buffer.

### 2. Animation Detection
```python
def detect_animations(gltf: dict) -> bool:
    animations = gltf.get('animations', [])
    for anim in animations:
        name = anim.get('name', '').lower()
        if 'gear' in name or 'landing' in name or 'wheel' in name:
            return True
    return False
```

Check for landing gear animations (used for metadata).

### 2b. Model Discovery (Livery-Only Folders)

Some MSFS liveries are "texture-only" folders that reference a base model via `model.cfg`:

```ini
[models]
normal=..\..\FSLTL_A320\model.iae\FAIB_A320_IAE.xml
```

Or via `aircraft.cfg` with `base_container`:

```ini
base_container="..\FSLTL_A320"
```

The converter handles both patterns:
1. Parse `model.cfg` to extract relative path to base model's XML
2. Fall back to `aircraft.cfg` `base_container` reference
3. Derive GLTF path from the base model folder

Texture directories are discovered case-insensitively, matching any folder containing "texture" (e.g., `TEXTURE`, `texture.AAL`, `oci.texture_772er`).

### 3. Texture Conversion (DDS → PNG)

For each image in the GLTF:

1. **Find texture file**: Search model directory and texture directories for `.DDS`, `.dds`, `.PNG`, `.png` variants
2. **Convert DDS**:
   - Try PIL first (fast, handles common DDS formats)
   - Fall back to `texconv.exe` for BC7/DXT10 formats
   - Create placeholder if both fail
3. **Resize** (optional): Scale to target size (512, 1k, 2k, or full)
4. **Convert to RGB**: Drop alpha channel before resize to avoid premultiplied alpha artifacts

```python
# IMPORTANT: Convert to RGB before resize
# MSFS uses alpha for day/night switching, not transparency
# LANCZOS resize with alpha destroys RGB values in "transparent" areas
if img.mode != 'RGB':
    img = img.convert('RGB')
```

### 4. UV Coordinate Conversion (float16 → float32)

MSFS stores UV coordinates as float16 values but declares them as `componentType: 5122` (SHORT).

### 4a. SCALAR WEIGHTS_0 Expansion (AIG models)

Some AIG models use non-standard `type: SCALAR` for WEIGHTS_0 instead of the required VEC4. The converter expands these to VEC4 format:

```python
# MSFS non-standard: WEIGHTS_0 as SCALAR FLOAT
# glTF spec requires: WEIGHTS_0 as VEC4

# Read single weight value
w = struct.unpack('<f', bin_data[pos:pos+4])[0]

# Expand to VEC4 (w, 0, 0, 0) as normalized UNSIGNED_SHORT
w_ushort = min(65535, max(0, int(w * 65535)))
new_weights_data.extend(struct.pack('<4H', w_ushort, 0, 0, 0))
```

### 4b. UV float16 Details

```python
# glTF componentType 5122 = SHORT, but MSFS uses it for float16
if acc['componentType'] != 5122:
    continue

# Read as float16, write as float32
for i in range(count):
    pos = offset + i * stride
    raw_bytes = bytes(bin_data[pos:pos+4])
    u = float(np.frombuffer(raw_bytes[0:2], dtype=np.float16)[0])
    v = float(np.frombuffer(raw_bytes[2:4], dtype=np.float16)[0])
    new_uv_data.extend(struct.pack('<ff', u, v))
```

The accessor is then updated:
```python
acc['componentType'] = 5126  # FLOAT
acc['normalized'] = False
```

### 5. Attribute Removal

The following mesh primitive attributes are removed:

| Attribute | Reason |
|-----------|--------|
| `COLOR_0` | Vertex colors not needed for traffic display |
| `TEXCOORD_1` | Secondary UVs (lightmaps) not used |
| `NORMAL` | Normals removed (simplified lighting) |
| `TANGENT` | Tangents removed (no normal mapping) |
| `JOINTS_0` | Bone indices removed (skinning stripped from AIG models) |
| `WEIGHTS_0` | Bone weights removed (skinning stripped from AIG models) |

**Preserved attributes:**
- `POSITION` - Vertex positions (required)
- `TEXCOORD_0` - Primary UV coordinates (required for textures)

### 6. Extension Removal

#### Removed Extensions
All MSFS-specific extensions are stripped:

| Extension | Purpose in MSFS |
|-----------|-----------------|
| `MSFT_texture_dds` | DDS texture references |
| `ASOBO_normal_map_convention` | Normal map format |
| `ASOBO_unique_id` | Asset identification |
| `ASOBO_material_glass` | Glass material properties |
| `ASOBO_material_kitty_glass` | Cockpit glass |
| `ASOBO_animation_retargeting` | Animation system |
| `ASOBO_asset_optimized` | Optimization flags |

Extensions are removed from:
- `extensionsUsed` / `extensionsRequired` arrays
- `asset.extensions`
- `materials[].extensions`
- `textures[].extensions`
- `nodes[].extensions`
- `meshes[].extensions`
- `meshes[].primitives[].extensions`
- `animations[].extensions`
- Root `extensions` object

### 7. Material Simplification

All materials are converted to simple opaque PBR:

```python
mat['alphaMode'] = 'OPAQUE'
mat['doubleSided'] = True

pbr = mat.get('pbrMetallicRoughness', {})
if 'metallicRoughnessTexture' in pbr:
    del pbr['metallicRoughnessTexture']
pbr['metallicFactor'] = 0.0
pbr['roughnessFactor'] = 1.0

# Remove emissive (MSFS uses _L textures for day/night, not glow)
if 'emissiveTexture' in mat:
    del mat['emissiveTexture']
mat['emissiveFactor'] = [0, 0, 0]

# Remove normal/occlusion textures (MSFS uses DirectX format normals,
# standard loaders expect OpenGL format - causes incorrect lighting)
if 'normalTexture' in mat:
    del mat['normalTexture']
if 'occlusionTexture' in mat:
    del mat['occlusionTexture']
```

### 8. Texture Reference Fixup

MSFS uses `MSFT_texture_dds` extension for texture sources. We migrate these to standard glTF:

```python
if 'extensions' in tex and 'MSFT_texture_dds' in tex['extensions']:
    dds_ext = tex['extensions']['MSFT_texture_dds']
    if 'source' in dds_ext and 'source' not in tex:
        tex['source'] = dds_ext['source']
```

### 9. Buffer Assembly

The final GLB buffer contains:

1. **Original binary data** (positions, indices, skinning data)
2. **Padding** (4-byte alignment)
3. **Converted PNG images** (each with its own bufferView)
4. **Converted float32 UV data** (new sequential bufferView, no byteStride)

### 10. GLB Output

```python
# GLB structure:
# [12-byte header] [JSON chunk] [BIN chunk]

header = struct.pack('<4sII', b'glTF', 2, total_length)
json_chunk = struct.pack('<II', len(json_bytes), 0x4E4F534A) + json_bytes
bin_chunk = struct.pack('<II', len(bin_data), 0x004E4942) + bin_data
```

## Data Format Reference

### glTF Component Types
| Value | Name | Size |
|-------|------|------|
| 5120 | BYTE | 1 |
| 5121 | UNSIGNED_BYTE | 1 |
| 5122 | SHORT | 2 |
| 5123 | UNSIGNED_SHORT | 2 |
| 5125 | UNSIGNED_INT | 4 |
| 5126 | FLOAT | 4 |

### Skinning Data Format (AIG Models)

AIG models use interleaved vertex data with `byteStride`:

```
Offset  Size  Attribute
0       12    POSITION (VEC3 FLOAT)
12      8     TEXCOORD_0 (VEC2 FLOAT, after conversion)
20      8     TEXCOORD_1 (VEC2, removed)
28      8     JOINTS_0 (VEC4 UNSIGNED_SHORT)
36      8     WEIGHTS_0 (VEC4 UNSIGNED_SHORT, normalized)
44      4     (padding to 48-byte stride)
```

**JOINTS_0**: Indices into the skin's `joints` array (0-based)
**WEIGHTS_0**: Normalized weights (0-65535 → 0.0-1.0), must sum to 1.0

### Skin Structure
```json
{
  "name": "skeleton #0",
  "skeleton": 91,           // Root node index
  "joints": [91, 92, 103],  // Node indices for bones
  "inverseBindMatrices": 0  // Accessor for MAT4 array
}
```

## Known Issues

### 1. Interleaved Buffer Views
The converter preserves interleaved data but doesn't de-interleave. Some renderers may have issues with `byteStride` on certain attributes.

## Fixed Issues

### MSFS Skinning Incompatibility (Fixed)

**Problem**: AIG models with GPU skinning (wings, slats) rendered incorrectly in standard glTF loaders:
- Left wing detached and positioned far from fuselage
- Right wing flipped both horizontally and vertically
- Slats positioned incorrectly or forming an X pattern

**Root Cause**: MSFS interprets glTF skinning differently than the specification:

1. **inverseBindMatrices ignored**: MSFS doesn't apply these matrices. Standard loaders do, causing double-transformation of vertices already in model space.

2. **Node transforms applied differently**: Skinned mesh nodes in AIG models have non-zero translations (e.g., `wing_r: [20.3, 1.28, 1.46]`) but the vertices are already positioned correctly in model space. Standard loaders apply both skinning AND node transforms.

3. **Skeleton hierarchy differences**: MSFS uses skeleton bones for different purposes:
   - Wing bones position wings for wing-flex animation
   - Slat bones (Bone002) position slats relative to wing leading edge

**Investigation Process**:
```
Vertex analysis showed:
  wing_r: X center = 17.1 (correct position in model space)
  wing_l: X center = -17.1 (correct position in model space)

But node transforms:
  wing_r: translation [20.3, 1.28, 1.46] → standard loaders add this!
  wing_l: translation [-20.3, 1.28, 1.46] with 180° Y rotation

Two types of slat meshes:
  r_slats/l_slats: SKINNED, parented to ROOT → in skeleton-local space
  r_slats1/l_slats1: NOT skinned, parented to Bone002 → correctly positioned
```

**Fix**: The converter now strips MSFS skinning and fixes geometry:

```python
# For each skinned node:
for node in gltf.get('nodes', []):
    if 'skin' in node:
        del node['skin']  # Remove skin reference

        if 'slat' in node_name.lower():
            # Hide skinned slats (skeleton-local space, can't position)
            # Non-skinned slat meshes in bone hierarchy render correctly
            del node['mesh']
        else:
            # Wings: zero transforms (vertices already in model space)
            node['translation'] = [0.0, 0.0, 0.0]
            if 'rotation' in node:
                del node['rotation']

        # Auto-detect left meshes needing mirror
        if is_left and x_center > 1.0:
            node['scale'] = [-1.0, 1.0, 1.0]

# Remove skins array and JOINTS_0/WEIGHTS_0 attributes
del gltf['skins']
```

**Result**: Wings now render in correct positions. Slats use the non-skinned bone-parented meshes (r_slats1/l_slats1) which render correctly.

**Compatibility**: This fix is safe for all MSFS models:
- FSLTL models: No skinning, this section is a no-op
- AIG models: Skinning stripped, geometry fixed

### AIG SCALAR WEIGHTS_0 (Fixed)
**Problem**: Some AIG models use `type: SCALAR` for WEIGHTS_0 instead of the required VEC4. This caused:
- Broken wing geometry (wings misplaced, rotated incorrectly)
- Wing pieces rendering in wrong positions
- Standard glTF loaders (Babylon.js, Cesium) misinterpreting the data

**Root Cause**: BufferView stride=44 with:
- POSITION at offset 0 (12 bytes)
- JOINTS_0 at offset 28 (8 bytes, VEC4 USHORT)
- WEIGHTS_0 at offset 36 (4 bytes, SCALAR FLOAT - **non-standard!**)

The SCALAR weight value was always 1.0, meaning "100% bound to first joint".

**Fix**: Converter now detects SCALAR WEIGHTS_0 and expands to VEC4:
- Input: SCALAR FLOAT `1.0`
- Output: VEC4 UNSIGNED_SHORT normalized `(65535, 0, 0, 0)` = `(1.0, 0.0, 0.0, 0.0)`

**Note**: This conversion happens before the skinning fix strips the WEIGHTS_0 attributes, so it's technically redundant for AIG models. However, keeping it ensures the buffer data is valid if we ever need to re-enable skinning for specific models.

### Animation Baking for Static Display (Fixed)

**Problem**: AIG models have animated parts (flaps, spoilers, slats, gear) rendering misaligned - standing up vertically instead of lying flat, clipping through the wing.

**Root Cause**: MSFS models are designed to look correct WITH animations at their first keyframe (t=0). The animations compensate for the coordinate system differences between the main body and animated parts:
- Main body meshes: Direct children of scene root, in glTF Y-up coordinates
- Animated parts: Under `node_36` with rotation `[0, 0.707, 0.707, 0]` (Z-up to Y-up conversion)
- Animations: Contain transforms at t=0 that position parts correctly relative to the rotated coordinate system

Standard glTF loaders render animated parts incorrectly in static state (without animation playback).

**Investigation Process**:
```
User testing revealed:
1. Removing node_36 rotation made it WORSE (wrong approach!)
2. Playing specific animations fixed positioning:
   - custom_anim_FLAPS_AIRLINER
   - custom_anim_SLATS_AIRLINER
   - l_spoiler_key / r_spoiler_key
3. After running all animations, nothing was misaligned anymore
4. Conclusion: Need to bake first keyframe of ALL animations
```

**MSFS Landing Gear Animation Structure**: According to MSFS docs, landing gear animations are split 50/50:
- **Frame 0 (neutral position)**: The "rest state" for static display
- **Frames 0-50%**: Extension/retraction (or static neutral for non-retractable)
- **Frames 50-100%**: Compression animation

This confirms that baking frame 0 gives us the correct static display state.

**Fix**: Bake the first keyframe (t=0) of ALL animations into static node transforms:

```python
# Bake first frame of ALL animations into node transforms
if 'animations' in gltf and 'accessors' in gltf and 'bufferViews' in gltf:
    for anim in gltf['animations']:
        for channel in anim.get('channels', []):
            target_node = channel['target']['node']
            target_path = channel['target']['path']  # 'translation', 'rotation', or 'scale'
            sampler = anim['samplers'][channel['sampler']]

            # Read the output accessor (animation data)
            output_acc = gltf['accessors'][sampler['output']]
            output_bv = gltf['bufferViews'][output_acc['bufferView']]
            offset = output_bv.get('byteOffset', 0) + output_acc.get('byteOffset', 0)

            # Read first keyframe value and apply to node
            if target_path == 'translation':
                first_value = struct.unpack_from('<3f', bin_data, offset)
                gltf['nodes'][target_node]['translation'] = list(first_value)
            elif target_path == 'rotation':
                first_value = struct.unpack_from('<4f', bin_data, offset)
                gltf['nodes'][target_node]['rotation'] = list(first_value)
            elif target_path == 'scale':
                first_value = struct.unpack_from('<3f', bin_data, offset)
                gltf['nodes'][target_node]['scale'] = list(first_value)
```

**Result**: All animated parts (flaps, slats, spoilers, gear, doors, etc.) now render in correct positions for static display. The node_36 rotation is preserved and the animations compensate for it.

**Compatibility**: Safe for all MSFS models:
- **FSLTL models**: May have animations that benefit from baking
- **AIG models**: Critical fix for correct rendering
- **Models without animations**: No-op, no animations to bake

### Steering Animation Neutral Position (Fixed)

**Problem**: Front landing gear steering wheels render rotated 90 degrees sideways, clipping through the fuselage, instead of pointing straight forward.

**Root Cause**: Steering animations (e.g., `custom_anim_C_WHEEL_LR`) have their neutral/straight-ahead position at a middle keyframe, not at frame 0:
- **Frame 0**: Quaternion `[0, 0.707, 0, 0.707]` = 90° left turn
- **Frame 1**: Quaternion `[0, 0, 0, 1]` = IDENTITY = straight forward (neutral)
- **Frame 2**: Quaternion `[0, -0.707, 0, 0.707]` = 90° right turn

This is different from extension/retraction animations where frame 0 is the correct neutral position.

**Investigation**:
```
Analysis of custom_anim_C_WHEEL_LR (3 keyframes):
  Frame 0 (t=100s): 90° from identity (wheel turned left)
  Frame 1 (t=150s):  0° from identity (wheel straight) ← NEUTRAL
  Frame 2 (t=200s): 90° from identity (wheel turned right)

Landing gear extension (c_gear) has no identity keyframe:
  Frame 0: 189° from identity (rotated for extension mechanism)
  All frames are far from identity - this is correct behavior
```

**Fix**: For rotation channels, scan all keyframes to find the one closest to identity quaternion `[0,0,0,1]`. If a near-identity keyframe exists (angle < 5°), use that instead of frame 0:

```python
# For rotations, find the keyframe closest to identity quaternion
if target_path == 'rotation' and keyframe_count > 1:
    min_angle = float('inf')
    best_frame = 0

    for i in range(keyframe_count):
        quat = struct.unpack_from('<4f', bin_data, frame_offset)
        # Angle from identity = 2 * acos(w)
        angle = 2 * math.acos(max(-1.0, min(1.0, quat[3])))

        if angle < min_angle:
            min_angle = angle
            best_frame = i

    # Use identity frame if close enough (< 5°)
    if min_angle < 0.087:  # 5 degrees in radians
        keyframe_to_use = best_frame
```

**Result**:
- **Steering wheels**: Point straight forward (identity quaternion used)
- **Landing gear**: Still use frame 0 (no identity keyframe exists)
- **Other animations**: Automatically select correct neutral position

**Compatibility**: Safe for all animations:
- Animations with identity keyframes use the neutral position
- Animations without identity keyframes use frame 0 (existing behavior)

## Embedded Source Metadata

Converted GLB files contain embedded source metadata in `asset.extras.towercab3d`:

```json
{
  "asset": {
    "version": "2.0",
    "extras": {
      "towercab3d": {
        "converterVersion": 2,
        "source": "aig",
        "liveryTitle": "AIGAIM_United Airlines Boeing 737 MAX 8",
        "folderName": "AIGAIM_AIA_B737-MAX8",
        "aircraftType": "B38M",
        "icaoAirline": "UAL",
        "gltfPath": "X:/Games/.../AIA_737-8_MAX_MSFS_LOD0.gltf",
        "textureDirs": ["X:/Games/.../texture.UAL-United Airlines", ...],
        "aircraftFolder": "X:/Games/.../AIGAIM_AIA_B737-MAX8"
      }
    }
  }
}
```

This metadata allows tracing a converted GLB back to its source files without needing filesystem access.

### Converter Version System

The `converterVersion` field tracks which version of the conversion logic was used. When conversion bugs are fixed (e.g., animation baking for misaligned parts), this version is incremented to invalidate old cached models:

**Version History:**
- **Version 1**: Initial version with source metadata embedding
- **Version 2**: Added animation baking for MSFS models (fixes misaligned flaps, slats, gear, spoilers, etc.)
- **Version 3**: Fixed steering animations by using identity quaternion frame instead of frame 0
- **Version 4**: Fixed model.cfg parsing to read GLTF filename from XML (fixes wrong engine variant textures causing white models)

**Implementation:**
- Python converter: `CONVERTER_VERSION` constant in `convert_fsltl_batch.py`
- TypeScript frontend: `CONVERTER_VERSION` constant in `MSFSModelConversionService.ts`

Both must match. When loading cached models on startup, the frontend skips GLBs with old/missing converter versions, forcing automatic re-conversion when the model is next requested.

## File Locations

| File | Purpose |
|------|---------|
| `scripts/shipping/conversion/convert_fsltl_batch.py` | Python converter source |
| `scripts/debugging/lookup_glb_source.py` | GLB source file lookup utility |
| `scripts/shipping/build/build_converter.py` | PyInstaller build script |
| `scripts/shipping/build/converter-requirements.txt` | Python dependencies |
| `scripts/shipping/build/fsltl_converter.spec` | PyInstaller spec file |
| `scripts/shipping/conversion/texconv.exe` | Microsoft texture converter |
| `src-tauri/resources/fsltl_converter.exe` | Bundled converter |
| `src-tauri/src/msfs.rs` | Rust backend |
| `src/renderer/services/MSFSModelConversionService.ts` | Frontend service |

## Debugging

### Lookup GLB Source Files
```bash
# If GLB has embedded metadata (newer conversions):
python scripts/debugging/lookup_glb_source.py model.glb

# With custom Community folder:
python scripts/debugging/lookup_glb_source.py --community "D:/MSFS/Community" model.glb

# Dump node hierarchy:
python scripts/debugging/lookup_glb_source.py --dump-nodes model.glb

# Inspect specific node:
python scripts/debugging/lookup_glb_source.py --node 28 model.glb
```

### Inspect Source GLTF
```python
import json
with open('model.gltf', 'r') as f:
    gltf = json.load(f)
print(f"Has skins: {'skins' in gltf}")
print(f"Has animations: {'animations' in gltf}")
print(f"Extensions: {gltf.get('extensionsUsed', [])}")
```

### Inspect Converted GLB
```python
import json, struct
with open('model.glb', 'rb') as f:
    f.read(12)  # header
    json_len = struct.unpack('<I', f.read(4))[0]
    f.read(4)   # chunk type
    gltf = json.loads(f.read(json_len))
```

### Validate in Babylon.js
Drag GLB into https://sandbox.babylonjs.com/ to visually inspect.

### Validate in glTF Validator
Use https://github.khronos.org/glTF-Validator/ for spec compliance.
