# TowerCab 3D - Modding Guide

This guide explains how to create custom aircraft and tower models for TowerCab 3D.

## Overview

TowerCab 3D supports loading custom 3D models in multiple formats. You can create:
- **Aircraft models**: Replace the default cone with realistic aircraft
- **Tower models**: Add custom control tower models for specific airports

### Supported Formats

| Format | Extension | Recommended | Notes |
|--------|-----------|-------------|-------|
| glTF Binary | `.glb` | ✅ Best | Smallest file size, fastest loading |
| glTF | `.gltf` | ✅ Good | JSON format with separate assets |
| Collada | `.dae` | Good | Native SketchUp export format |
| Wavefront OBJ | `.obj` | Good | Universal format, widely supported |
| STL | `.stl` | Limited | Geometry only, no textures/materials |

## File Structure

Mods are placed in the `mods` folder in the application directory:

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

## Aircraft Mods

### Manifest Format

Create a `manifest.json` file in your aircraft mod folder:

```json
{
  "name": "Boeing 737-800",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "Detailed Boeing 737-800 model",
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
  "modelFile": "model.glb",
  "airports": ["KJFK"],
  "scale": 1.0,
  "heightOffset": 0,
  "positionOffset": {
    "lat": 0,
    "lon": 0
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Display name of the mod |
| `author` | string | Yes | Creator's name |
| `version` | string | Yes | Semantic version |
| `description` | string | No | Brief description |
| `modelFile` | string | Yes | Path to the 3D model file |
| `airports` | string[] | Yes | ICAO airport codes this tower applies to |
| `scale` | number | Yes | Scale factor |
| `heightOffset` | number | No | Additional height offset in meters |
| `positionOffset` | object | No | Position offset in degrees lat/lon |

### Model Guidelines

1. **Orientation**: Tower should be upright with entrance facing +Y
2. **Origin**: Place at ground level, center of the tower base
3. **Scale**: Model should be in meters
4. **Detail**: Include cab windows and basic structure

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

## Testing Mods

1. Place your mod folder in the appropriate `mods/aircraft` or `mods/towers` directory
2. Restart TowerCab 3D
3. The application will load your mod automatically
4. Check the console for any loading errors

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

### Tower Mod with Position Offset

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
  "heightOffset": 5,
  "positionOffset": {
    "lat": 0.0001,
    "lon": -0.0002
  }
}
```

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

## Community Resources

- Share your mods with the VATSIM community
- Report issues or request features on the project's GitHub page
- Join the discussion on VATSIM forums
