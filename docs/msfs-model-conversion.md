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

## File Locations

| File | Purpose |
|------|---------|
| `scripts/convert_fsltl_batch.py` | Python converter source |
| `scripts/build_converter.py` | PyInstaller build script |
| `scripts/converter-requirements.txt` | Python dependencies |
| `scripts/fsltl_converter.spec` | PyInstaller spec file |
| `scripts/texconv.exe` | Microsoft texture converter |
| `src-tauri/resources/fsltl_converter.exe` | Bundled converter |
| `src-tauri/src/msfs.rs` | Rust backend |
| `src/renderer/services/MSFSModelConversionService.ts` | Frontend service |

## Debugging

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
