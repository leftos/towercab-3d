# TowerCab 3D - Modding Guide

This guide explains how to create custom aircraft and tower models for TowerCab 3D.

## Overview

TowerCab 3D supports loading custom 3D models in multiple formats. You can create:
- **Aircraft models**: Add custom aircraft models with airline-specific liveries
- **Tower models**: Add custom control tower models for specific airports

Additionally, TowerCab 3D can automatically use models from:
- **FSLTL (FS Live Traffic Liveries)**: High-quality airline liveries for MSFS
- **AIG (AI Ground)**: Additional AI traffic models for MSFS

FSLTL and AIG models are converted on-demand when aircraft appear. See the **Settings > Configuration** tab to configure model sources and priorities.

### Supported Formats

| Format | Extension | Recommended | Notes |
|--------|-----------|-------------|-------|
| glTF Binary | `.glb` | ✅ Best | Smallest file size, fastest loading |
| glTF | `.gltf` | ✅ Good | JSON format with separate assets |
| Collada | `.dae` | Good | Native SketchUp export format |
| Wavefront OBJ | `.obj` | Good | Universal format, widely supported |
| STL | `.stl` | Limited | Geometry only, no textures/materials |

## File Structure

Mods are placed in the `mods` folder in the application directory. TowerCab 3D recursively scans for `manifest.json` files, so you can organize mods however you prefer:

### Traditional Structure

```
mods/
├── aircraft/
│   ├── B738/
│   │   ├── model.glb
│   │   └── manifest.json
│   └── A320/
│       ├── model.glb
│       └── manifest.json
└── towers/
    ├── KJFK/
    │   ├── model.glb
    │   └── manifest.json
    └── EGLL/
        ├── model.glb
        └── manifest.json
```

### Git Repository Structure

You can clone GitHub repositories directly into the mods folder:

```
mods/
├── community-towers/           # Git repo
│   ├── .git/
│   ├── KJFK/
│   │   ├── manifest.json
│   │   └── model.glb
│   └── KLAX/
│       ├── manifest.json
│       └── model.glb
├── my-aircraft-pack/           # Git repo
│   ├── .git/
│   ├── boeing/
│   │   └── 737-800/
│   │       ├── manifest.json
│   │       └── model.glb
│   └── airbus/
│       └── a320/
│           ├── manifest.json
│           └── model.glb
└── single-tower-mod/           # Git repo (single mod)
    ├── .git/
    ├── manifest.json
    └── model.glb
```

## Using Git Repositories for Mods

TowerCab 3D makes it easy to use mods shared on GitHub:

### Cloning a Mod Repository

```bash
cd path/to/mods
git clone https://github.com/username/tower-mod.git
```

The mod will be loaded automatically on next app restart.

### Updating All Mods

Use the included PowerShell script to update all git repositories in your mods folder:

```powershell
.\scripts\update-mods.ps1
```

This finds all git repos in the mods folder and runs `git pull` on each.

### Creating Your Own Mod Repository

1. Create a new folder in `mods/` with your mod content
2. Initialize git: `git init`
3. Add your manifest.json and model files
4. Push to GitHub: `git remote add origin https://github.com/you/my-mod.git && git push -u origin main`

Share the repository URL with others so they can clone it!

### Important Notes

- The folder name doesn't matter - TowerCab 3D reads the `manifest.json` to determine mod type
- Git repos can contain multiple mods at any folder depth
- The `manifest.json` file determines the mod type (in priority order):
  1. Explicit `"type": "aircraft"` or `"type": "tower"` field (recommended)
  2. Presence of `aircraftTypes` field → aircraft mod
  3. Presence of `airports` field → tower mod
- Restart TowerCab 3D after cloning new repos or updating mods

## Aircraft Mods

### Manifest Format

Create a `manifest.json` file in your aircraft mod folder:

```json
{
  "name": "Boeing 737-800",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "Detailed Boeing 737-800 model",
  "type": "aircraft",
  "modelFile": "model.glb",
  "aircraftTypes": ["B738", "B737", "B73H"],
  "scale": 1.0,
  "rotationOffset": {
    "x": 0,
    "y": 0,
    "z": 0
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name of the mod |
| `author` | string | Yes | Creator's name |
| `version` | string | Yes | Semantic version (e.g., "1.0.0") |
| `description` | string | No | Brief description |
| `type` | string | No | Explicit mod type: `"aircraft"` (recommended for clarity) |
| `modelFile` | string | Yes | Path to the 3D model file (relative to manifest) |
| `aircraftTypes` | string[] | Yes | ICAO aircraft type codes this model applies to |
| `scale` | number | Yes | Scale factor (1.0 = original size) |
| `rotationOffset` | object | No | Rotation adjustments in degrees |

### Aircraft Type Codes

Aircraft are matched using the ICAO type designator from the flight plan. Common examples:
- `B738` - Boeing 737-800
- `A320` - Airbus A320
- `B77W` - Boeing 777-300ER
- `A388` - Airbus A380-800
- `C172` - Cessna 172

One mod can match multiple aircraft types by listing them in `aircraftTypes`.

### Model Guidelines

1. **Orientation**: Aircraft should point along the +Y axis (forward)
2. **Origin**: Place the origin at the aircraft's center
3. **Scale**: Model should be in meters (1 unit = 1 meter)
4. **File Size**: Keep models under 5MB for best performance
5. **Format**: GLB recommended; DAE and OBJ also supported

## Tower Mods

### Manifest Format

Create a `manifest.json` file in your tower mod folder:

```json
{
  "name": "JFK Tower",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "Realistic JFK control tower",
  "type": "tower",
  "modelFile": "model.glb",
  "airports": ["KJFK"],
  "scale": 1.0
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name of the mod |
| `author` | string | Yes | Creator's name |
| `version` | string | Yes | Semantic version |
| `description` | string | No | Brief description |
| `type` | string | No | Explicit mod type: `"tower"` (recommended for clarity) |
| `modelFile` | string | Yes | Path to the 3D model file |
| `airports` | string[] | Yes | ICAO airport codes this tower applies to |
| `scale` | number | Yes | Scale factor |
| `modelPosition` | object | No | 3D model placement (lat, lon, height, rotation) |
| `cameraPosition` | object | No | Camera/tower cab viewpoint (lat, lon, height, heading) |

### 3D Tower Model Rendering

When a tower mod is installed for an airport, TowerCab 3D will render the 3D model in the scene. The tower model is placed using this fallback chain:

1. **manifest.modelPosition** - If `modelPosition.lat` and `modelPosition.lon` are specified in the manifest
2. **tower-positions** - Falls back to the bundled tower position data (from `mods/tower-positions/` or bundled FAA data)
3. **Not rendered** - If no position is available

The model is placed at terrain height plus the `modelPosition.height` value from the manifest.

### Model Position Configuration

Tower mods can specify an explicit model position using absolute lat/lon coordinates:

```json
{
  "modelPosition": {
    "lat": 40.6413111,
    "lon": -73.7781234,
    "height": 0,
    "rotation": 45
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lat` | number | Yes | Latitude of 3D model position (double precision) |
| `lon` | number | Yes | Longitude of 3D model position (double precision) |
| `height` | number | No | Height offset in meters above terrain (default 0) |
| `rotation` | number | No | Model rotation in degrees (0=north, 90=east, default 0) |

**Note:** The `modelPosition` field controls where the 3D tower model renders. The `cameraPosition` field (separate) controls where the camera viewpoint is located. These can be different positions.

### Camera Position Configuration

You can specify where the tower cab (camera viewpoint) should be positioned independently of the 3D model:

```json
{
  "cameraPosition": {
    "lat": 40.6413,
    "lon": -73.7781,
    "height": 97,
    "heading": 45
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lat` | number | Yes | Latitude of camera position |
| `lon` | number | Yes | Longitude of camera position |
| `height` | number | Yes | Height above ground level in meters |
| `heading` | number | No | Default camera heading in degrees (0=north, default 0) |

When these are set, they become the default camera position for that airport (used on first visit or when pressing Shift+Home).

### Model Guidelines

1. **Orientation**: Tower should be upright with entrance facing +Y
2. **Origin**: Place at ground level, center of the tower base
3. **Scale**: Model should be in meters
4. **Detail**: Include cab windows and basic structure

### Repositioning Tower Models (In-App)

TowerCab 3D includes a built-in tool to reposition tower models without manually editing the manifest. This is useful for fine-tuning placement after installation.

**To reposition a tower mod:**

1. Open **Settings > Mods** tab
2. Find your tower mod and click **Reposition**
3. The app enters a two-step positioning wizard:

**Step 1 - Model Positioning:**
- Use **WASD** to move the tower model north/south/east/west
- Use **Q/E** to adjust height
- Use **Z/X** to rotate the model
- Hold **Shift** for faster movement (10m), **Ctrl** for fine movement (0.1m)
- Press **Tab** to toggle between model controls and camera controls (so you can adjust your viewing angle)
- Press **R** to reset to original position
- Press **Enter** to proceed to Step 2, or **Escape** to cancel

**Step 2 - Camera Positioning:**
- Use normal camera controls to fly to where you want the default cab viewpoint
- The overlay shows current lat/lon/height/heading/pitch
- Press **Enter** to save both positions to the manifest
- Press **Escape** to go back to Step 1

The updated `modelPosition` and `cameraPosition` are saved directly to your manifest.json file.

## Custom Tower Positions

TowerCab 3D includes bundled tower positions for **536 US airports** based on FAA obstruction data. These provide accurate tower cab locations and heights, with default headings pointing toward the primary runway approach.

You can override or supplement these bundled positions by creating custom JSON files. This is useful for:
- Correcting inaccurate bundled positions
- Adding positions for airports not in the bundled data
- Customizing view settings for your preferences

### File Location and Format

Create individual JSON files for each airport in the `mods/tower-positions/` directory:

```
mods/
├── tower-positions/
│   ├── KJFK.json
│   ├── KLAX.json
│   └── EGLL.json
└── towers/
    └── ...
```

Each file is named after the ICAO code (case-insensitive).

### Tower Position File Format

Each airport file supports separate 3D and 2D view settings:

```json
{
  "view3d": {
    "lat": 40.6413111,
    "lon": -73.7781234,
    "height": 97,
    "heading": 45
  },
  "view2d": {
    "lat": 40.6413111,
    "lon": -73.7781234,
    "altitude": 5000,
    "heading": 0
  }
}
```

Both `view3d` and `view2d` are optional. If only one is provided, the other uses defaults.

### 3D View Fields (`view3d`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lat` | number | Yes | Latitude of the tower cab position (double precision) |
| `lon` | number | Yes | Longitude of the tower cab position (double precision) |
| `height` | number | Yes | Height above ground level in meters |
| `heading` | number | No | Default camera heading in degrees (0=north). Defaults to 0 |

### 2D View Fields (`view2d`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lat` | number | No | Latitude of view center (defaults to airport center) |
| `lon` | number | No | Longitude of view center (defaults to airport center) |
| `altitude` | number | Yes | Altitude above ground in meters (controls zoom, 500-50000) |
| `heading` | number | No | View rotation in degrees (0=north-up). Defaults to 0 |

### Saving Positions from the App

The easiest way to create position files is using the app:

1. Navigate to an airport and position the camera
2. **Shift+Click "Save My Default"** to save to `mods/tower-positions/{ICAO}.json`
3. The file is saved based on current view mode (3D or 2D)
4. Repeat in both view modes to save both 3D and 2D positions

### Fallback Behavior

- If only `view3d` is defined and you're in 2D mode: Uses 3D heading with default altitude
- If only `view2d` is defined and you're in 3D mode: Uses built-in 3D defaults
- If neither is defined: Uses built-in app defaults

### When Custom Positions Are Applied

Custom positions are applied as "app defaults" for the camera viewpoint:

1. **First visit to airport**: Custom position is used for that view mode
2. **Shift+Home reset**: Custom position for current view mode is restored
3. **User data takes priority**: User-saved defaults and auto-saved positions take precedence

### Priority Order

For camera position, the system uses this priority (highest to lowest):

1. **User-saved default** - Explicitly saved by clicking "Save My Default"
2. **Last position** - Auto-saved every 5 seconds
3. **Tower mod cabPosition** - From a tower mod manifest.json
4. **User tower-positions** - From `mods/tower-positions/{ICAO}.json`
5. **Bundled tower-positions** - Pre-installed data for 536 US airports
6. **Estimated default** - Calculated based on airport classification

### Examples

**KJFK.json - JFK Tower with both views:**

```json
{
  "view3d": {
    "lat": 40.6413,
    "lon": -73.7781,
    "height": 97,
    "heading": 45
  },
  "view2d": {
    "altitude": 3000,
    "heading": 0
  }
}
```

**KLAX.json - LAX Tower with 3D only:**

```json
{
  "view3d": {
    "lat": 33.9416234,
    "lon": -118.4085567,
    "height": 84,
    "heading": 270
  }
}
```

**Determining heading values:**

- `0` or `360` = North (default)
- `90` = East
- `180` = South
- `270` = West

Use values between 0-360 for intermediate directions (e.g., `45` for northeast).

### Backward Compatibility

The legacy single-file format (`mods/tower-positions.json`) is still supported but deprecated. If both exist, individual files in `tower-positions/` take priority over entries in the legacy file.

### Contributing Tower Positions

You can easily share your tower positions with the community:

1. **From the app**: After saving with Shift+Click, you'll be asked if you want to contribute to GitHub
2. **Type "yes"** to open your browser to GitHub's file creation page
3. **The file content is pre-filled** - just review and click "Propose new file"
4. GitHub will automatically create a fork and pull request for you

No Git knowledge required! The app handles everything for you.

**Tip**: Type "never" to disable this prompt permanently. You can re-enable it in Settings later.

**Manual contribution**: If you prefer, you can also:
1. Copy your `mods/tower-positions/{ICAO}.json` file
2. Go to the [GitHub repository](https://github.com/leftos/towercab-3d)
3. Navigate to `contributions/tower-positions/`
4. Click "Add file" → "Upload files"
5. Submit a pull request

## Creating Models

### Recommended Tools

- **Blender** (free): Full-featured 3D modeling with excellent export options
- **SketchUp** (free/paid): Easy to use, great for buildings and towers
- **3ds Max** / **Maya**: Professional tools

### Export Settings (SketchUp)

SketchUp is excellent for creating tower models due to its intuitive building tools. Here's how to export for TowerCab 3D:

#### Option 1: Collada (.dae) - Recommended for SketchUp

1. File → Export → 3D Model...
2. Select "COLLADA File (*.dae)" as the format
3. Click "Options..." and configure:
   - ✅ Export Two-Sided Faces
   - ✅ Export Edges (optional, for sharp edges)
   - ✅ Triangulate All Faces
   - ✅ Export Texture Maps
   - Export only: Current Selection (if exporting specific objects)
4. Save as `model.dae` in your mod folder

#### Option 2: OBJ (.obj) - Alternative Format

1. File → Export → 3D Model...
2. Select "OBJ File (*.obj)" as the format
3. Click "Options..." and configure:
   - ✅ Triangulate All Faces
   - ✅ Export Texture Maps
   - Swap YZ coordinates: Check if model appears sideways
4. Save as `model.obj` in your mod folder

#### Option 3: GLB via Blender (Best Quality)

For best results, convert SketchUp models to GLB:

1. Export from SketchUp as .dae (Collada)
2. Open Blender and import the .dae file (File → Import → Collada)
3. Adjust materials if needed
4. Export as .glb (File → Export → glTF 2.0)

#### SketchUp Tips

- **Scale**: SketchUp uses inches by default. Set units to Meters (Window → Model Info → Units)
- **Origin**: Position your model at the origin (0,0,0) for proper placement
- **Orientation**: Tower entrance should face the green axis (+Y)
- **Textures**: Use simple, low-resolution textures for better performance
- **Components**: Flatten components before export (Edit → Component → Explode)

### Export Settings (Blender)

1. File → Export → glTF 2.0 (.glb/.gltf)
2. Settings:
   - Format: glTF Binary (.glb)
   - Include: Selected Objects (optional)
   - Transform: +Y Up
   - Geometry: Apply Modifiers
   - Compression: Draco (optional, for smaller files)

### Optimization Tips

1. **Polygon Count**: Keep under 10,000 triangles for aircraft, 50,000 for towers
2. **Textures**: Use power-of-2 dimensions (512x512, 1024x1024)
3. **Materials**: Use PBR materials for best results
4. **LOD**: Consider creating multiple detail levels for complex models

## Managing Mods

### Mods Tab in Settings

Open **Settings > Mods** to view all installed mods and their status:

- **Tower Models**: Lists all tower mods with their ICAO code, name, author, and position source
- **Aircraft Models**: Lists all aircraft mods with their aircraft types
- **VMR Files**: Shows loaded VMR files and rule counts
- **Tower Positions**: Shows counts of bundled and custom tower positions
- **Errors**: Lists any mods that failed to load (missing manifest, invalid model file, etc.)

### Enabling/Disabling Mods

You can disable individual mods from the Mods tab:

1. Open **Settings > Mods**
2. Uncheck the checkbox next to any mod you want to disable
3. Click **Save Changes**
4. Restart the application for changes to take effect

Disabled mods will be skipped during loading. This is useful for troubleshooting conflicts or temporarily disabling mods without deleting them.

## Testing Mods

1. Place your mod folder in the appropriate `mods/aircraft` or `mods/towers` directory
2. Restart TowerCab 3D
3. The application will load your mod automatically
4. Open **Settings > Mods** to verify your mod was loaded correctly
5. Check the Errors section for any loading issues

## Troubleshooting

### Model Not Loading

- Verify `manifest.json` is valid JSON
- Check that `modelFile` path is correct
- Ensure the model file exists and is a valid format (.glb, .gltf, .dae, .obj, .stl)
- For OBJ files, ensure the .mtl material file is in the same folder

### Model Appears Wrong Size

- Adjust the `scale` value in manifest.json
- Check that your model is in meters

### Model Orientation Wrong

- Use `rotationOffset` to adjust rotation
- Values are in degrees (0-360)

### Model Not Matching Aircraft

- Verify `aircraftTypes` includes the correct ICAO codes
- Check that the folder name matches an aircraft type code

### SketchUp Export Issues

- **Model appears huge**: SketchUp defaults to inches; set Model Info → Units to Meters
- **Model is sideways**: Enable "Swap YZ coordinates" in OBJ export options, or adjust `rotationOffset` in manifest
- **Missing textures**: Ensure "Export Texture Maps" is checked; keep texture files in same folder
- **Dark or black model**: Enable "Export Two-Sided Faces" for Collada exports
- **Jagged edges**: Enable "Triangulate All Faces" in export options

## Examples

### Basic Aircraft Mod

```
mods/aircraft/B738/
├── model.glb
└── manifest.json
```

manifest.json:
```json
{
  "name": "Boeing 737-800",
  "author": "Community",
  "version": "1.0.0",
  "modelFile": "model.glb",
  "aircraftTypes": ["B738", "B737"],
  "scale": 0.01
}
```

### Tower Mod with Custom Position

```
mods/towers/KLAX/
├── model.glb
└── manifest.json
```

manifest.json:
```json
{
  "name": "LAX Tower",
  "author": "Community",
  "version": "1.0.0",
  "modelFile": "model.glb",
  "airports": ["KLAX"],
  "scale": 1.0,
  "modelPosition": {
    "lat": 33.9416234,
    "lon": -118.4085567,
    "height": 5,
    "rotation": 0
  },
  "cameraPosition": {
    "lat": 33.9416234,
    "lon": -118.4085567,
    "height": 84,
    "heading": 270
  }
}
```

The `modelPosition` field specifies where the 3D model renders, and `cameraPosition` specifies where the camera views from.

### SketchUp Tower Mod (Collada)

```
mods/towers/KSFO/
├── model.dae
├── textures/
│   ├── glass.png
│   └── concrete.png
└── manifest.json
```

manifest.json:
```json
{
  "name": "SFO Tower",
  "author": "Community",
  "version": "1.0.0",
  "modelFile": "model.dae",
  "airports": ["KSFO"],
  "scale": 1.0,
  "rotationOffset": {
    "x": 0,
    "y": 90,
    "z": 0
  }
}
```

## VMR Model Matching Rules

For advanced users, VMR (Visual Model Rules) files allow you to define custom model matching rules. This is the same format used by Microsoft Flight Simulator for traffic liveries.

VMR files enable:
- Mapping specific airlines to specific livery models
- Creating type aliases (e.g., B38M MAX 8 uses your B738 model)
- Defining fallback alternatives for random selection

### Creating a VMR File

1. Create a file with `.vmr` extension in `mods/` or `mods/aircraft/`
2. Use XML format with `<ModelMatchRule>` elements
3. Reference model folders by name (folders in `mods/aircraft/`)
4. Restart the application to load new VMR rules

### VMR Format

```xml
<?xml version="1.0" encoding="utf-8"?>
<ModelMatchRuleSet>
  <!-- Base livery for B738 (no airline specified) -->
  <ModelMatchRule TypeCode="B738" ModelName="MyB738_Base" />

  <!-- Airline-specific liveries -->
  <ModelMatchRule CallsignPrefix="AAL" TypeCode="B738" ModelName="MyB738_American" />
  <ModelMatchRule CallsignPrefix="UAL" TypeCode="B738" ModelName="MyB738_United" />
  <ModelMatchRule CallsignPrefix="SWA" TypeCode="B738" ModelName="MyB738_Southwest" />

  <!-- Type alias: B38M (737 MAX 8) uses B738 model -->
  <ModelMatchRule TypeCode="B38M" ModelName="MyB738_Base" />

  <!-- Multiple alternatives (first available is used) -->
  <ModelMatchRule CallsignPrefix="DAL" TypeCode="B738" ModelName="MyB738_Delta_New//MyB738_Delta_Old" />
</ModelMatchRuleSet>
```

### Attributes

| Attribute | Required | Description |
|-----------|----------|-------------|
| `TypeCode` | Yes | ICAO aircraft type code (e.g., "B738", "A320", "CRJ9") |
| `ModelName` | Yes | Model folder name in `mods/aircraft/`. Use `//` to specify alternatives |
| `CallsignPrefix` | No | ICAO airline code (e.g., "AAL", "UAL"). Omit for default/base livery |

### Model Matching Priority

When VMR rules are present, they take **highest priority** over other model sources:

1. **Custom VMR** - Airline+type specific match
2. **Custom VMR** - Type-only (base livery)
3. **FSLTL/AIG** - Converted airline models (priority order configurable in Settings)
4. **FSLTL/AIG** - Base liveries
5. **Custom Mods** - manifest.json based (no VMR)
6. **Built-in** - Default models

**Note:** You can configure whether FSLTL or AIG takes priority in **Settings > Configuration > Model Priority**.

### Example Folder Structure

```
mods/
├── my_liveries.vmr           # Your custom VMR rules
└── aircraft/
    ├── MyB738_Base/
    │   └── model.glb
    ├── MyB738_American/
    │   └── model.glb
    ├── MyB738_United/
    │   └── model.glb
    └── MyB738_Southwest/
        └── model.glb
```

### VMR Model Folders

Each model folder referenced in your VMR file should contain:
- A model file named `model.glb` (or other supported format)
- Optionally, a `manifest.json` for scale/rotation adjustments

**Minimal folder (just the model):**
```
MyB738_American/
└── model.glb
```

**With manifest for customization:**
```
MyB738_American/
├── model.glb
└── manifest.json
```

**manifest.json** (optional - used by VMR models for scale and rotation adjustments):
```json
{
  "name": "American Airlines B738",
  "author": "Your Name",
  "version": "1.0.0",
  "modelFile": "model.glb",
  "aircraftTypes": ["B738"],
  "scale": 1.0,
  "rotationOffset": {
    "x": 0,
    "y": 180,
    "z": 0
  }
}
```

**Manifest Fields for VMR Models:**
- `scale` (number): Scale factor applied to the model (1.0 = original size)
- `rotationOffset` (object): Rotation adjustments in degrees:
  - `x`: Pitch (nose up/down)
  - `y`: Yaw (heading rotation)
  - `z`: Roll (bank angle)

All other fields are informational and don't affect rendering. If `manifest.json` is missing, the model uses default scale (1.0) and no rotation offset.

### Tips

- Model folders only need a `model.glb` file - manifests are optional
- **Load Order**: VMR files are discovered and loaded alphabetically by filename. When multiple files define rules for the same aircraft type, the first file (alphabetically) takes priority. Within a single VMR file, rules are matched in order: airline-specific rules first, then type-only rules.
- **Multiple VMR Files**: You can organize rules across multiple `.vmr` files. Use numeric prefixes if you need explicit priority (e.g., `00_base_models.vmr`, `10_overrides.vmr`)
- **Manifest Support**: Each model folder can optionally include a `manifest.json` with `scale` and `rotationOffset` properties for fine-tuning model appearance
- Use the F3 debug overlay to verify which model is being matched
- Airline codes are 3-letter ICAO codes (e.g., "AAL" not "AA")

### Common Airline Codes

| Code | Airline |
|------|---------|
| AAL | American Airlines |
| UAL | United Airlines |
| DAL | Delta Air Lines |
| SWA | Southwest Airlines |
| JBU | JetBlue Airways |
| ASA | Alaska Airlines |
| BAW | British Airways |
| DLH | Lufthansa |
| AFR | Air France |

## Community Resources

- Share your mods with the VATSIM community
- Report issues or request features on the project's GitHub page
- Join the discussion on VATSIM forums
