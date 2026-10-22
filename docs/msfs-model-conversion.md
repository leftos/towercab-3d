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
│  conversion.rs (Rust/Tauri Backend)                             │
│  - ConversionOwner: the only place a converter is started       │
│  - Limits, timeout, shared jobs (see "Conversion Owner")        │
├─────────────────────────────────────────────────────────────────┤
│  msfs.rs (Rust/Tauri Backend)                                   │
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
   - Decode with Pillow, which handles the DDS formats MSFS uses (BC1/BC3/BC5/BC7 and DX10)
   - Create a neutral placeholder if Pillow can't decode the format
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

### FSLTL Model.cfg Path Resolution (Fixed)

**Problem**: FSLTL livery folders that reference a base model via `model.cfg` showed white/untextured aircraft or used wrong engine variant textures.

**Root Cause**: The Python converter's discovery logic for finding GLTF files was inconsistent:
1. Some livery folders don't contain GLTF directly - they have a `model.XXX/model.cfg` that points to a base model's XML
2. The XML file contains the actual GLTF filename (which varies by engine variant)
3. Python was sometimes deriving the GLTF name incorrectly or using the wrong variant

**MSFS Model Reference Structure**:
```
FSLTL_A321_DAL/              (livery folder)
├── aircraft.cfg             (defines liveries)
└── model.iae/               (model variant folder)
    └── model.cfg            (references base model)
        [models]
        normal=..\..\FSLTL_A321\model.iae\FAIB_A321_IAE.xml

FSLTL_A321/                  (base model folder)
├── model.iae/
│   ├── FAIB_A321_IAE.xml    (model XML - contains GLTF filename)
│   └── FAIB_A321_IAE_LOD0.gltf
└── TEXTURE/
    └── (shared textures)
```

**Fix**: Moved model.cfg parsing to Rust backend with two new functions:

```rust
/// Parse model XML to find GLTF filename from LODS section
fn parse_model_xml(xml_path: &Path) -> Option<String> {
    // Parse XML, find LOD with highest minSize
    // Return path to that GLTF file
}

/// Parse model.cfg to find referenced base GLTF
fn parse_model_cfg(model_cfg_path: &Path) -> Option<String> {
    // Find "normal=..." line
    // Resolve relative path to XML
    // Call parse_model_xml() to get actual GLTF filename
}

/// Resolve GLTF by checking model.cfg files in aircraft directory
fn resolve_gltf_via_model_cfg(aircraft_dir: &Path) -> Option<(String, PathBuf)> {
    // Find all model.* directories
    // Check each for model.cfg
    // Return (gltf_path, base_model_dir)
}
```

**Job file**: The converter does no discovery; Rust hands it every resolved path in a JSON job (`--job job.json --result result.json`, see "Conversion Owner"):
- `gltf_path`: The exact GLTF file to convert (resolved via model.cfg)
- `texture_dirs`: Pre-computed texture directories including base model's textures
- `liveries`: each livery's `title` and the absolute `output` path of its GLB
- Python converter uses these paths instead of doing its own discovery, but still checks that each one resolves (junctions and symlinks followed) inside the model's MSFS package, the folder holding `SimObjects/Airplanes`; a texture folder outside it is dropped with a warning, and a `gltf_path` outside its package fails the livery
- The converter reads no `aircraft.cfg`. Every glTF buffer and image URI must be a single plain file name beside the glTF (no path separators, drive colon, URI scheme including `data:`, `.`/`..`, trailing dot or space, device names, or `< > " | ? *`); otherwise that livery fails

This ensures consistent behavior - Rust is the single source of truth for path resolution.

**Texture Directory Resolution**: When resolving via model.cfg into another aircraft folder, that folder's texture directories are added as fallback (the full order is in "Livery Texture Folder Order"):
```rust
// Add model.cfg base directory texture directories
if let Some(ref cfg_base) = model_cfg_base_dir {
    let cfg_texture_dirs = collect_texture_dirs(cfg_base);
    for cfg_dir in cfg_texture_dirs {
        if !dirs.contains(&cfg_dir) {
            dirs.push(cfg_dir);
        }
    }
}
```

**Result**: FSLTL liveries now correctly use:
- The exact GLTF file specified in the XML (correct engine variant)
- Textures from both the livery folder and the base model folder

### MSFS 2024 FROST Material (Fixed)

**Problem**: MSFS 2024 aircraft models have a "FROST" material that creates ice/frost effects on surfaces. After conversion, these areas render as magenta (missing texture placeholder).

**Root Cause**: The FROST material uses `ASOBO_material_blend_gbuffer` extension for blending frost effects onto underlying surfaces. When ASOBO extensions are stripped during conversion, the material becomes invalid.

**Investigation**:
```
Analysis of C208B GLTF materials:
  Material 11 "FROST":
    - ASOBO_material_blend_gbuffer (blend factors for frost effect)
    - ASOBO_material_detail_map (frost texture detail)
    - ASOBO_material_draw_order

Other materials also use blend_gbuffer but for different purposes:
  - DECALS: registration decals
  - LIVERY: airline paint scheme
  - FUELCAP: fuel cap details
  - $RegistrationNumber: tail number

Cannot simply make all blend_gbuffer materials transparent!
```

**Fix**: Detect materials named "FROST" specifically and replace with a solid color sampled from the livery texture:

```python
# Sample dominant light color from LIVERY texture for FROST replacement
frost_replacement_color = None
for mat in gltf['materials']:
    if mat.get('name', '').upper() == 'LIVERY':
        # Get base color texture, sample dominant white/light color
        frost_replacement_color = sample_dominant_light_color(livery_texture)
        break

# Apply to FROST materials
for mat in gltf['materials']:
    if mat.get('name', '').upper() == 'FROST':
        r, g, b = frost_replacement_color or (0.95, 0.95, 0.95)
        mat['alphaMode'] = 'OPAQUE'
        mat['pbrMetallicRoughness'] = {
            'baseColorFactor': [r, g, b, 1.0],
            'metallicFactor': 0.0,
            'roughnessFactor': 1.0
        }
```

The `sample_dominant_light_color()` function:
1. Resizes texture to 128px for fast sampling
2. Filters pixels to those with brightness > 200 (light colors)
3. Quantizes to 10-unit buckets and finds most common
4. Returns normalized RGB or default off-white (0.95, 0.95, 0.95)

**Result**: FROST areas now render with a solid color matching the aircraft's paint scheme instead of magenta placeholders.

### Livery Texture Folder Order (Fixed)

**Problem**: AIG aircraft displayed wrong airline liveries. For example, Alaska Airlines EMB-175 showed American Airlines colors, and the model index cache file grew very large.

**Root Cause**: Every livery's `texture_dirs` listed every `texture.*` folder of its aircraft folder (and of the first folder of its ICAO type). The converter takes a texture from the first folder holding the file, so `texture.AAL-American Airlines` came before `texture.ASA-Alaska Airlines` for both liveries.

```
aircraft.cfg for AIG EMB-175:
  [FLTSIM.0] - Alaska Airlines       texture=ASA-Alaska Airlines
  [FLTSIM.1] - American Airlines     texture=AAL-American Airlines

Texture folders in the aircraft directory:
  texture.AAL-American Airlines/
  texture.ASA-Alaska Airlines/
```

**Fix**: `list_models_unified` in `msfs.rs` builds each livery's `texture_dirs` in this order, the converter searching them first to last (a folder listed twice is kept once, compared case-insensitively):

1. The livery's own texture folder: `texture.<texture=>` in the aircraft folder, matched case-insensitively (`texture` for an empty `texture=`), then the folders its `texture.cfg` names.
2. The aircraft folder's own `oci*` folders.
3. Every `texture*` and `oci*` folder of the `base_container` folder (FSLTL freighter variants).
4. When the livery's `model.cfg` resolves into another folder, every `texture*` and `oci*` folder of that folder. When it resolves into the livery's own aircraft folder, only that folder's plain `texture` folder with its fallbacks, then its `oci*` folders: never the other liveries' folders.
5. The base model's folders: the plain `texture` folder with its fallbacks, then the `oci*` folders, of the base folder of the same ICAO type whose name shares the longest prefix with the livery's folder name.
6. As the last resort, the `oci*` folders of the other aircraft folders of the same ICAO type, closest folder name first. Their `texture.*` livery folders are never listed.

A folder with no `[fltsim]` liveries gets one entry per `texture.*` folder (the same order, that folder first), or one entry with its plain `texture` folder and `oci*` folders when it has none.

**texture.cfg fallbacks**: a texture folder's `texture.cfg` (name matched case-insensitively) lists `fallback.N=<relative path>` in its `[fltsim]` section. They are followed in N order, each relative to the folder holding the cfg, with `\` or `/` separators; when that folder does not exist, the same path is tried relative to its parent, the aircraft folder. A fallback folder's own `texture.cfg` is followed depth-first, up to 4 cfgs deep, and a folder already listed (cycles included) is skipped. A fallback that is not a folder, or that lies outside the package (the folder holding `SimObjects/Airplanes`, junctions resolved), is dropped with a warning in the host log. AIG liveries name `..\..\..\texture`, which resolves to no folder and is dropped.

**Model choice per livery**: each `[fltsim]` entry's own `model=` picks the glTF. An empty `model=` is the plain `model` folder. An entry with no `model=` uses the first non-empty `model=` of the file. When `model.<value>` exists in the aircraft folder only it is searched, its glTF first and then its `model.cfg`; otherwise every `model*` folder is. Then the `base_container` folder's glTF, then for AIG the folder offering `model.<value>` for the same ICAO type, then the base model of the type. Among candidate folders the one whose name shares the longest prefix with the livery's folder name wins, then the smallest name.

**Order and encoding**: aircraft folders and their child folders are visited sorted by lower-case name, so the index does not depend on directory order. An `aircraft.cfg` that is not valid UTF-8 is read as Windows-1252; a UTF-8 BOM is dropped.

**Result**: Each livery lists a handful of folders (its own, its fallbacks and the shared ones) instead of every texture folder of its aircraft folder, so Alaska Airlines aircraft display the Alaska livery and the index stays small.

**Cache Invalidation**: `MODEL_CACHE_VERSION` changes force re-indexing whenever the indexed contents change.

### AIG Attachment GLTF Selected Instead of Main Model (Fixed)

**Problem**: Some AIG freighter models (e.g., B757-200F) appeared with invisible/missing hulls — only cargo doors were visible.

**Root Cause**: Two bugs in `find_gltf_in_dir` and `find_gltf_in_model_dir` (Rust):

1. **LOD matching only checked double-digit patterns** (`lod00`, `lod01`, etc.) but AIG models use single-digit LOD suffixes (`LOD0`, `LOD1`). Files like `AIG_B757-200_PW_LOD0.gltf` didn't match `"lod00"` and got the same fallback priority (5) as non-LOD files.

2. **Attachment GTLFs weren't excluded**. MSFS uses separate GLTF files for cargo doors (`cargoF.gltf`), cockpit, etc. that are composited at runtime via `<ModelAttachments>` in the XML. When both `cargoF.gltf` and `LOD0.gltf` had the same priority, `min_by_key` picked whichever came first alphabetically — `cargoF.gltf` (cargo doors only, no hull).

**Investigation**:
```
GLB contained only 6 meshes — all cargo doors:
  x0_cargo_door_aft, x0_cargo_door_forward, x0_cargo_door_main (+ _fake variants)

No fuselage, wings, engines, or tail geometry present.

Model directory structure:
  model.PW/AIG_B757-200_PW.xml          → Main XML (10 LODs + AttachModel for CargoDoors)
  model.PW/AIG_B757-200_PW_cargoF.xml   → Cargo door attachment XML
  model.PW/AIG_B757-200_PW_LOD0.gltf    → Main aircraft (correct)
  model.PW/AIG_B757-200_PW_cargoF.gltf  → Cargo doors only (selected by bug)

Priority assignment (old code):
  "lod00" check → LOD0.gltf has "lod0" not "lod00" → priority 5
  cargoF.gltf → no LOD pattern → priority 5
  Both priority 5 → alphabetical: "cargo" < "LOD0" → cargoF selected!
```

**Fix**: Two changes to both `find_gltf_in_dir` and `find_gltf_in_model_dir`:

1. **Regex-style LOD matching**: Extract LOD number from any `LOD\d+` pattern (handles both `LOD0` and `LOD00`)
2. **Attachment filtering**: Exclude files containing `cargo`, `cockpit`, or `interior` in the filename

```rust
fn gltf_lod_priority(filename: &str) -> i32 {
    let lower = filename.to_lowercase();
    if let Some(lod_pos) = lower.find("lod") {
        let after_lod = &lower[lod_pos + 3..];
        let digit_str: String = after_lod.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digit_str.parse::<i32>() {
            return n;  // LOD0 → 0, LOD1 → 1, etc.
        }
    }
    100  // Non-LOD files get lowest priority
}

fn is_attachment_gltf(filename: &str) -> bool {
    let lower = filename.to_lowercase();
    lower.contains("cockpit") || lower.contains("interior") || lower.contains("cargo")
}
```

**Result**: Freighter models now correctly select the main aircraft GLTF (LOD0) instead of cargo door attachments. The UPS 757-200F renders with full fuselage, wings, and engines.

**Cache Invalidation**: Bumped `MODEL_CACHE_VERSION` to 9 and `CONVERTER_VERSION` to 8 to force re-indexing and re-conversion of affected models.

## Animation Clips the Viewer Drives

The converter keeps the glTF animation clips; the viewer picks which ones to play by name (`classifyAnimationClip` in `utils/gltfAnimationParser.ts`). Gear progress drives gear clips, and the surface controller (`utils/surfaceAnimationController.ts`) drives spoiler, reverser and wheel-spin clips.

- **Excluded first** (driven by nothing): any name containing `STEER`, `custom_anim_C_WHEEL_LR`, `c_wheel` and `c_wheel_key`, `custom_anim_ROTATION_VELOCITY_BODY_Y_*`, `custom_anim_{LEFT,RIGHT,CENTER}_WHEEL_RPM_*`, `fx_tire_contactPoint_*`, `custom_anim_GROUND_VELOCITY_*` and `spoiler_UTT787_aileron`.
- **Wheel spin**: `custom_anim_{CENTER,LEFT,RIGHT}_WHEEL_ROTATION_ANGLE_*`, `WHEEL_ROLL_{center,left,right}`, `{c,l,r}_tire` with the suffixes `_anim`, `_blurred_key`, `_still_key`, `_roll` or `_key`, `center_tire_roll`, `tire_anim` and `GEAR_{Center,Left,Right}_Tire`.
- **Spoiler**: `custom_anim_SPOILERS_{LEFT,RIGHT}_POSITION_*`, `{l,r}_spoiler_key`, `SPOILERS` (also spelled `SPOLIERS`, with an optional `_left` or `_right`), `HANDLING_Spoilers_{Ground,l,r}`, `*_Spoiler_{L,R,LR}[n]`, `Spoiler_{L,R}n`, `spoiler_Q_new`, the `TFS_777`, `TFS_A380` and `UTT_787` spoiler sets, and `AIA_Fokker_TailSpeedBrake`.
- **Reverser**: `custom_anim_REV_THRUST`, `reverse_thrust`, `REVERSER` and `REVERSERS`, `thrust_rev_n`, `engine_rev` and `custom_anim_TURB_ENG_REVERSE_NOZZLE_PERCENT_*`.
- **Gear**: every other clip with `GEAR` in its name (case-insensitive).

The patterns are an allowlist checked against the converted FSLTL and AIG models, so a new model family adds its names to the pattern lists in `gltfAnimationParser.ts`.

A wheel-spin clip plays only when every rotation track turns exactly one revolution (within 4 degrees), monotonic about one axis with no half-turn step; a clip that does not is left out. A wheel clip that targets a node a gear clip of the same model moves is dropped and logged once, since the two would overwrite each other's pose.

## Embedded Source Metadata

Converted GLB files contain embedded source metadata in `asset.extras.towercab3d`:

```json
{
  "asset": {
    "version": "2.0",
    "extras": {
      "towercab3d": {
        "converterVersion": 9,
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

This metadata allows tracing a converted GLB back to its source files without needing filesystem access. The host source paths (`source`, `liveryTitle`, `gltfPath`, `textureDirs`) are what the app and `lookup_glb_source.py` read; the file name is only a name.

### Converter Version System

The `converterVersion` field tracks which version of the conversion logic was used. When conversion bugs are fixed (e.g., animation baking for misaligned parts), this version is incremented to invalidate old cached models:

**Version History:**
- **Version 1**: Initial version with source metadata embedding
- **Version 2**: Added animation baking for MSFS models (fixes misaligned flaps, slats, gear, spoilers, etc.)
- **Version 3**: Fixed steering animations by using identity quaternion frame instead of frame 0
- **Version 4**: Fixed model.cfg parsing to read GLTF filename from XML (fixes wrong engine variant textures causing white models)
- **Version 5**: Fixed base_container resolution for FSLTL freighter variants (e.g., B77LF, B744F)
- **Version 6**: Rust handles model.cfg parsing and hands the converter its resolved paths (fixes wrong engine variant for liveries)
- **Version 7**: FROST materials (MSFS 2024 GeoDecalFrosted) replaced with solid color sampled from livery texture
- **Version 8**: Exclude cargo/attachment GTLFs from model selection; fix single-digit LOD matching (fixes invisible hulls on freighter models)
- **Version 9**: The app hands over a JSON job; output names are a sanitized title plus a hash of it (every GLB converted earlier is converted again once)

**Implementation:**
- Python converter: `CONVERTER_VERSION` constant in `convert_fsltl_batch.py`
- TypeScript frontend: `CONVERTER_VERSION` constant in `MSFSModelConversionService.ts`

Both must match; the Rust test `conversion::tests::converter_versions_match` checks it. When loading cached models on startup, the frontend deletes GLBs with an old or missing converter version, or with no `source` or `liveryTitle` in their extras, so the model is converted again once when it is next requested.

### Cache Integrity

- **Atomic GLB writes**: the converter writes each GLB to `.{name}.{pid}.tmp` beside the final name and renames it into place, so a failed or killed conversion never leaves a truncated GLB under the loaded name. At start the converter removes `.*.tmp` files older than one hour from its output folder.
- **Atomic index writes**: `save_model_cache` in `msfs.rs` writes the model index to a temp file in the cache folder and renames it over `{source}_model_cache.json`.
- **Damaged GLBs**: `scan_cache_directory` compares the length in each GLB's header with its file size. A mismatch, or a header that cannot be read, lists the GLB with no converter version (and logs a warning), so the app deletes it and converts the model again.
- **Index cache version**: `MODEL_CACHE_VERSION` is 11; aircraft.cfg keys are matched exactly (`atc_id_enable` does not overwrite `atc_id`, and `model = "X"` with spaces is read), and each livery lists only its own texture folders (see "Livery Texture Folder Order"), so older index caches are rebuilt once.

## Conversion Owner

Every conversion, from the host window (`convert_msfs_model`) or a remote browser (`POST /api/msfs/convert`), runs through `ConversionOwner` in `src-tauri/src/conversion.rs`, held in Tauri managed state. It owns the converter lookup (`find_converter`), the job writer, the output-name function, and the Windows job object that kills the converter's whole process tree. There is no other way to start a converter: the batch start, cancel and progress commands, `get_converter_path` and their TypeScript wrappers are gone.

- **Job and result**: the owner writes a JSON job (`job.json`: version, source, texture scale, `gltf_path`, `texture_dirs`, and each livery's title and absolute output path) into a fresh `tc3d-convert-*` folder under the system temp folder and runs `fsltl_converter --job <job> --result <result>`. The converter writes a JSON result (a `title`, `path`, `ok` and `error` per livery, plus `errors`) and exits 0 when every livery converted, 1 when one failed, 2 when the job is invalid. The folder is removed after the run; a folder older than a day, left by a crash, is swept when an owner starts. The converter reconfigures stdout and stderr to UTF-8, so a title outside the ANSI code page does not fail a finished conversion.
- **Output names**: `conversion::output_file_name` is the one function naming a GLB: `{fsltl|aig}_{sanitized title}-{hash}.glb`. The title keeps `[A-Za-z0-9._-]`, every other character becomes `_`, runs of `_` collapse, edge `.`, `_` and `-` go, and it is cut at 80 characters; `hash` is the FNV-1a 32-bit hash of the unsanitized title as 8 hex digits, so titles that sanitize alike stay apart. The Python never names a file; it writes the `output` path it is given.
- **Finding a cached GLB**: the file name cannot be read back as the title, so the app reads each GLB's embedded `source` and `liveryTitle`: `scan_cache_directory` lists the key `{source}_{liveryTitle}` from them, and `find_cached_model` (Tauri command; `source` must be `fsltl` or `aig`, else null) returns the GLB `output_file_name` names, or null.

- **Limits**: at most 2 converters at once in all; remote browsers share 1 of them, so the host always has a slot. A remote caller is allowed 1 conversion in flight per device (IP) and at most 8 remote requests waiting; a request past either is refused at once.
- **Timeouts**: a converter running past 5 minutes is killed with its process tree and its callers get "timed out". A remote request waiting past 2 minutes for a slot is refused. The host has no queue wait, since its queue is the frontend's (2 at a time).
- **Shared jobs**: callers asking for the same output file (cache directory plus file name), host or remote, share one job; a job runs on a task the owner spawns, so a caller going away never cancels it. A host joining a remote browser's job promotes it and is never refused; a joining remote takes no remote slot.
- **Verified output**: a conversion succeeds only when the output file exists and passes the cache scan's GLB check (`is_accepted_glb` in `msfs.rs`: the header length matches the file size). A verified file found after a kill counts as success.
- **Remote requests**: the model is looked up in the host's index first (honouring `enableFsltl` / `enableAig`), and a GLB already in the cache that passes the check is answered without a converter. A refusal for load is HTTP 503 with `Retry-After: 30`. Remote conversions always use the host's `msfsModels.textureScale`, whatever the request says.
- **Browser retries**: on a 503 the frontend re-queues that model after `Retry-After` seconds (30 when absent), up to 3 times, then gives up for now without marking the model failed. A remote browser converts 1 model at a time; the desktop converts 2.

## File Locations

| File | Purpose |
|------|---------|
| `scripts/shipping/conversion/convert_fsltl_batch.py` | Python converter source |
| `scripts/shipping/conversion/test_lookup_glb_source.py` | Tests of the GLB source lookup utility |
| `scripts/debugging/lookup_glb_source.py` | GLB source file lookup utility |
| `scripts/shipping/build/build_converter.py` | PyInstaller build script |
| `scripts/shipping/build/converter-requirements.txt` | Python dependencies |
| `scripts/shipping/build/fsltl_converter.spec` | PyInstaller spec file |
| `src-tauri/resources/fsltl_converter[.exe]` | Bundled converter (`.exe` on Windows) |
| `src-tauri/src/conversion.rs` | Conversion owner: converter lookup, job file, output names, limits, timeout, job object |
| `src-tauri/src/msfs.rs` | Rust backend: detection, indexing, the `convert_msfs_model` command, cache scan |
| `src/renderer/services/MSFSModelConversionService.ts` | Frontend service |

## Debugging

### Lookup GLB Source Files
```bash
# The source and livery title come from the GLB's embedded extras, never from its file name:
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
