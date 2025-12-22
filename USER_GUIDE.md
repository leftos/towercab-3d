# TowerCab 3D User Guide

Welcome to TowerCab 3D, a real-time 3D tower visualization tool for VATSIM air traffic controllers. This guide covers all features and controls available in the application.

## Table of Contents

1. [Getting Started](#getting-started)
2. [User Interface Overview](#user-interface-overview)
3. [Camera Controls](#camera-controls)
4. [Aircraft Following](#aircraft-following)
5. [Airport Selection](#airport-selection)
6. [Aircraft Panel](#aircraft-panel)
7. [Global Aircraft Search](#global-aircraft-search)
8. [Bookmark System](#bookmark-system)
9. [Multi-Viewport System](#multi-viewport-system)
10. [Replay System](#replay-system)
11. [Measuring Tool](#measuring-tool)
12. [Weather Effects](#weather-effects)
13. [VR Support](#vr-support)
14. [Settings](#settings)
15. [Modding](#modding)
16. [Keyboard Shortcuts Reference](#keyboard-shortcuts-reference)
17. [Troubleshooting](#troubleshooting)

---

## Getting Started

### First-Time Setup

1. **Launch the application** - Run `npm run dev` for development or use the installed application.

2. **Configure Cesium Ion Token**
   - Click the **Settings** button (gear icon) in the bottom-right corner
   - Enter your Cesium Ion access token (get one free at [cesium.com/ion](https://cesium.com/ion))
   - The globe will load once a valid token is entered

3. **Select an Airport**
   - Click the airport button in the top-left corner
   - Search for an airport by ICAO code, IATA code, name, or city
   - Click an airport to fly there and start viewing traffic

### Understanding the Display

Once configured, you'll see:
- A 3D globe with satellite imagery and terrain
- Aircraft displayed as 3D models with callsign labels (datablocks)
- Aircraft physics emulation: pitch during climbs/descents, banking in turns, landing flare
- Weather effects: fog at visibility limits, cloud layers at ceilings
- A panel on the right showing nearby aircraft
- Status information in the top bar

---

## User Interface Overview

### Top Bar

| Element | Description |
|---------|-------------|
| **Airport Button** | Shows current airport ICAO. Click to change airports |
| **Zulu Time** | Current UTC time (updates every second) |
| **Aircraft Count** | Number of pilots currently online on VATSIM |
| **Compass** | Camera heading direction (N/NE/E/SE/S/SW/W/NW) |
| **Connection Status** | Green "Connected" or red "Disconnected" indicator |

### Controls Bar (Bottom)

The bottom bar has two modes, toggled by the button on the far left:

#### Main Controls Mode (default)

**Left Section:**
- **Mode Toggle**: Switch to replay controls
- **Reset View** (Shift+R): Returns camera to default position
- **View Toggle** (T): Switches between 3D and top-down views
- **Set Default**: Saves current view as default for this airport
- **Reset to Default**: Returns to saved default view
- **Global Search**: Opens aircraft search (Ctrl+K)
- **Camera Info**: Shows current HDG/PIT/FOV (3D) or ALT (top-down)

**Center Section:**
- **FOV Slider**: Adjusts field of view (10-120 degrees)
- **Following Status**: Shows which aircraft you're following and hints

**Right Section:**
- **Measure**: Activates distance measuring tool
- **Add Inset**: Creates a new inset viewport
- **VR Button**: Enters VR mode (only visible when VR headset detected)
- **Settings Button**: Opens configuration modal

#### Replay Controls Mode

Switch to this mode to scrub through recorded traffic history:

**Left Section:**
- **Mode Toggle**: Switch back to main controls
- **Step Back**: Jump 15 seconds into the past
- **Play/Pause**: Start or pause playback
- **Step Forward**: Jump 15 seconds forward

**Center Section:**
- **Timeline Scrubber**: Drag to seek through the replay buffer
- **Time Display**: Shows relative time (e.g., "2m 30s ago") and UTC timestamp
- **Buffer Duration**: Total recording time available

**Right Section:**
- **Speed Selector**: 0.5x, 1x, 2x, or 4x playback speed
- **LIVE Button**: Return to real-time data
- **Settings Button**: Opens configuration modal

### Aircraft Panel (Right Side)

The collapsible panel on the right shows:
- Nearby aircraft sorted by distance (default)
- Search/filter input
- Sort dropdown (Distance, Callsign, Altitude, Speed)
- Aircraft cards with callsign, type, altitude, speed, heading, distance, and route
- Target button to follow each aircraft

---

## Camera Controls

### View Modes

TowerCab 3D offers two primary view modes:

#### 3D Tower View (Default)
- Camera positioned at the control tower
- Full 360-degree rotation with pitch control
- Adjustable field of view for zoom effect
- WASD movement to reposition within the tower area

#### Top-Down View
- Overhead bird's-eye perspective
- Camera looks straight down at the airport
- Pan by dragging or using WASD
- Altitude adjustable for zoom level
- Press **T** to toggle between views

### Movement Controls

| Control | 3D View | Top-Down View |
|---------|---------|---------------|
| **W** | Move forward | Pan up |
| **S** | Move backward | Pan down |
| **A** | Strafe left | Pan left |
| **D** | Strafe right | Pan right |
| **Q** | Move down | - |
| **E** | Move up | - |
| **Shift + WASD** | Sprint (3x speed) | Fast pan |

### Rotation Controls

| Control | Action |
|---------|--------|
| **Arrow Left** | Rotate camera left (decrease heading) |
| **Arrow Right** | Rotate camera right (increase heading) |
| **Arrow Up** | Tilt camera up (increase pitch) |
| **Arrow Down** | Tilt camera down (decrease pitch) |
| **Right-click + Drag** | Freeform look-around |

### Zoom Controls

| Control | 3D View | Top-Down View |
|---------|---------|---------------|
| **Mouse Wheel Up** | Zoom in (decrease FOV) | Increase altitude |
| **Mouse Wheel Down** | Zoom out (increase FOV) | Decrease altitude |
| **+ or =** | Zoom in | Increase altitude |
| **-** | Zoom out | Decrease altitude |
| **FOV Slider** | Precise FOV adjustment | - |

### Reset Controls

| Control | Action |
|---------|--------|
| **R** | Reset heading, pitch, and FOV |
| **r** (lowercase) | Reset position offset only |
| **Home** | Full reset (same as R) |
| **Shift+R** | Full reset with position |

---

## Aircraft Following

TowerCab 3D provides two modes for following aircraft:

### Tower Mode

In Tower mode, the camera stays at the tower position and rotates to keep the selected aircraft in view.

**Features:**
- Camera remains at tower location
- Heading and pitch automatically track the aircraft
- Zoom adjusts the magnification (0.5x to 5.0x)
- Best for monitoring traffic patterns from tower perspective

**Controls while in Tower Mode:**
- **Mouse Wheel**: Adjust zoom level
- **+/-**: Adjust zoom level
- **Arrow Keys**: Breaks follow (returns to manual control)
- **Right-click Drag**: Breaks follow (returns to manual control)
- **Escape**: Stop following

### Orbit Mode

In Orbit mode, the camera circles around the aircraft, keeping it centered in view.

**Features:**
- Camera orbits the followed aircraft
- Adjustable distance (50-5000 meters)
- Adjustable orbit heading (view from any angle)
- Adjustable orbit pitch (view from above or below)
- Works globally without needing an airport selected

**Controls while in Orbit Mode:**
- **Mouse Wheel**: Adjust orbit distance
- **+/-**: Adjust orbit distance
- **Arrow Left/Right**: Adjust orbit heading (circle around)
- **Arrow Up/Down**: Adjust orbit pitch (view angle)
- **Escape**: Stop following

### Following an Aircraft

**Method 1: Click the Label**
- Click on any aircraft's callsign label in the 3D view

**Method 2: Aircraft Panel**
- Click the target icon on any aircraft in the right panel

**Method 3: Global Search**
- Press **Ctrl+K** to open global search
- Search for any aircraft on VATSIM
- Press Enter to follow the first result in Orbit mode

### Switching Follow Modes

- Press **O** to toggle between Tower and Orbit modes while following
- The mode indicator shows "Tower" or "Orbit" in the controls bar
- You can also click the mode button in the Aircraft Panel when following

---

## Airport Selection

### Opening the Airport Selector

Click the airport button in the top-left corner of the screen. This shows the current airport ICAO code, or "Select Airport" if none is selected.

### Searching for Airports

The search supports multiple query types:
- **ICAO Code**: `KJFK`, `EGLL`, `RJTT`
- **IATA Code**: `JFK`, `LHR`, `HND`
- **Airport Name**: `John F Kennedy`, `Heathrow`
- **City Name**: `New York`, `London`, `Tokyo`

Results appear as you type, showing up to 50 matches.

### Recent Airports

The selector remembers your last 10 selected airports for quick access. Recent airports appear at the top of the modal.

### Popular Airports

Quick-access buttons for major international hubs:
- KJFK (New York JFK)
- KLAX (Los Angeles)
- EGLL (London Heathrow)
- EDDF (Frankfurt)
- LFPG (Paris CDG)
- RJTT (Tokyo Haneda)
- VHHH (Hong Kong)
- YSSY (Sydney)

### Changing Airports

When you select a new airport:
1. The camera smoothly animates to the new location (2 seconds)
2. Your camera settings for that airport are restored (if previously saved)
3. The aircraft panel updates to show traffic near the new airport

---

## Aircraft Panel

### Panel Header

The header shows:
- "Nearby Aircraft" when not following, or "Near [CALLSIGN]" when following in Orbit mode
- Total count of aircraft in range
- Collapse/expand button (chevron icon)

### Filtering Aircraft

**Search Box:**
Use the search box to filter by:
- Callsign (e.g., `UAL`, `BAW123`)
- Aircraft type (e.g., `B738`, `A320`)
- Departure airport (e.g., `KJFK`)
- Arrival airport (e.g., `EGLL`)

**Quick Filters:**
| Filter | Description |
|--------|-------------|
| **Visible** | Show only aircraft visible through weather (not hidden by fog/clouds) |
| **Airport** | Show only aircraft departing from or arriving at the current airport |

### Sorting Aircraft

Click the sort dropdown to change order:
| Sort Option | Description |
|-------------|-------------|
| **Distance** | Closest aircraft first (default) |
| **Callsign** | Alphabetical by callsign |
| **Altitude** | Highest altitude first |
| **Speed** | Fastest groundspeed first |

### Aircraft Cards

Each aircraft card displays:
- **Callsign**: Airline code + flight number
- **Aircraft Type**: ICAO type designator
- **ALT**: Altitude in feet
- **GS**: Ground speed in knots
- **HDG**: Magnetic heading (0-360)
- **Distance**: Nautical miles from reference point
- **Bearing**: Direction from reference point
- **Route**: DEP → ARR if flight plan filed
- **Target Button**: Click to follow (filled = currently following)

### Following Status

When following an aircraft, the panel shows:
- Current followed aircraft callsign
- Mode toggle button (Tower/Orbit)
- Zoom or distance indicator
- Stop button with (Esc) hint

---

## Global Aircraft Search

Press **Ctrl+K** (or **Cmd+K** on Mac) to open the global search panel.

### Searching

- Search across ALL pilots on the VATSIM network
- Search by callsign, aircraft type, or route
- Results update as you type
- Shows up to 20 matching aircraft

### Result Information

Each result shows:
- Callsign and aircraft type
- Route (departure → arrival)
- Flight level and ground speed
- Highlighted if you're already following

### Quick Follow

- Press **Enter** to follow the first result in Orbit mode
- Click any result to follow it
- Results that you're currently following are highlighted

---

## Bookmark System

Save and restore camera positions using the bookmark system. Each airport has 99 bookmark slots (numbered 00-99).

### Saving a Bookmark

1. Position your camera exactly as desired
2. Type `.XX.` where XX is a number from 00-99 (e.g., `.00.`, `.15.`, `.99.`)
3. Press **Enter**
4. A confirmation message appears briefly

**Example:** Type `.00.` and press Enter to save to slot 00.

### Loading a Bookmark

1. Type `.XX` where XX is the slot number (e.g., `.00`, `.15`, `.99`)
2. Press **Enter**
3. Camera instantly moves to the saved position

**Example:** Type `.00` and press Enter to load slot 00.

### What Gets Saved

Bookmarks store the complete camera state:
- Heading (rotation)
- Pitch (tilt angle)
- Field of view
- Position offset (X, Y, Z from tower)
- View mode (3D or top-down)

### Bookmark Tips

- Use meaningful slot numbers (e.g., runways: .27., .09.)
- Bookmarks are saved per-airport
- Bookmarks persist between sessions
- Press **Escape** to cancel bookmark input

---

## Multi-Viewport System

TowerCab 3D supports multiple simultaneous views through inset viewports.

### Creating Inset Viewports

1. Click the **Add Inset** button in the controls bar
2. A new viewport window appears overlaid on the main view
3. Each inset has independent camera controls and follow modes

### Managing Viewports

**Activating a Viewport:**
- Click anywhere inside a viewport to activate it
- The active viewport has a cyan border
- Keyboard and mouse controls affect only the active viewport

**Moving and Resizing:**
- Drag the title bar to move an inset viewport
- Drag any edge or corner to resize
- Minimum size is enforced for usability

**Closing Viewports:**
- Click the × button in the top-right corner of an inset
- The main viewport cannot be closed

### Independent Camera Control

Each viewport maintains its own:
- Heading, pitch, and field of view
- Follow target and follow mode (Tower/Orbit)
- Top-down vs 3D view setting

### Performance Considerations

- Inset viewports use reduced quality settings for performance
- A warning appears at 3+ insets, severe warning at 6+
- Consider closing unused insets to improve frame rate

### Viewport Persistence

Inset viewport positions and sizes are saved per-airport. When you return to an airport, your viewport layout is restored.

---

## Replay System

TowerCab 3D continuously records VATSIM traffic data, allowing you to scrub back in time and review past events.

### How It Works

- Traffic snapshots are captured every 15 seconds automatically
- The replay buffer stores up to 25 minutes of history (configurable in Settings > Performance)
- All aircraft within VATSIM's coverage are recorded, not just those near your current airport
- You can switch airports while viewing a replay to see traffic at a different location

### Using Replay Controls

1. Click the **mode toggle button** (far left of bottom bar) to switch to Replay mode
2. Use the playback controls:
   - **Step Back/Forward**: Jump 15 seconds at a time
   - **Play/Pause**: Start or pause automatic playback
   - **Timeline Scrubber**: Drag to seek to any point
   - **Speed Selector**: Choose 0.5x, 1x, 2x, or 4x speed
3. Click **LIVE** to return to real-time data

### Keyboard Shortcuts (Replay Mode)

| Key | Action |
|-----|--------|
| **Space** | Play/Pause |
| **Left Arrow** | Step backward 15 seconds |
| **Right Arrow** | Step forward 15 seconds |

### Export and Import Replays

In Settings > Performance, you can:
- **Export Replay**: Save the current buffer to a JSON file
- **Import Replay**: Load a previously saved replay file
- **Clear Imported**: Return to live recording after importing

### Tips

- The bar border turns orange when viewing historical data (not live)
- The mode toggle button pulses when you're not viewing live data
- Replays are filtered by your "Max Nearby Aircraft Range" setting
- Switching airports during replay shows traffic at the new location

---

## Measuring Tool

The measuring tool allows you to measure distances on the terrain.

### Activating the Tool

1. Click the **Measure** button in the controls bar, or press **M**
2. The cursor changes to indicate measuring mode
3. Click to place measurement points

### Taking Measurements

1. **First click**: Sets the starting point
2. **Move cursor**: See a live preview of the distance
3. **Second click**: Locks in the measurement line

### Multiple Measurements

- Continue clicking to add more measurement points
- Each pair of consecutive clicks creates a separate measurement
- All measurements remain visible on screen

### Removing Measurements

- **Right-click** on any measurement endpoint to remove that measurement
- Click the Measure button again to exit measuring mode and clear all measurements

### Distance Display

- **Short distances**: Shown in meters and feet
- **Long distances**: Shown in kilometers and nautical miles
- Distance labels appear at the midpoint of each measurement line

---

## Weather Effects

TowerCab 3D displays real-time weather based on METAR reports.

### Weather Features

**Fog Effects:**
- Visibility-based fog that limits terrain draw distance
- Visual fog dome at the visibility boundary
- Adjustable intensity and visibility scale

**Cloud Layers:**
- Cloud planes positioned at METAR-reported ceiling altitudes
- Scattered (SCT), broken (BKN), and overcast (OVC) layers shown
- Aircraft behind clouds may have hidden datablocks

### Weather-Based Visibility

When weather effects are enabled:
- Aircraft beyond the reported visibility have hidden labels
- Aircraft above broken or overcast cloud layers have hidden labels
- Followed aircraft are always visible regardless of weather
- Use the "Visible" filter in Aircraft Panel to show only weather-visible aircraft

### Weather Settings

| Setting | Description |
|---------|-------------|
| Enable Fog | Toggle fog effects on/off |
| Fog Intensity | Opacity of the fog dome (0.5x-2x) |
| Visibility Scale | Multiplier for fog distance (2x = see twice as far as METAR) |
| Enable Clouds | Toggle cloud layer display on/off |

### Automatic Weather Updates

- Weather updates every 5 minutes from Aviation Weather API
- When orbit-following without an airport, weather is based on camera position
- Weather station is automatically selected based on nearest METAR

---

## VR Support

TowerCab 3D includes experimental WebXR support for VR headsets.

### Requirements

- VR headset connected via Quest Link, SteamVR, or similar
- WebXR-compatible browser runtime
- The VR button only appears when a headset is detected

### Entering VR Mode

1. Connect your VR headset and launch the headset runtime
2. Look for the **VR** button in the controls bar
3. Click the button to enter VR mode
4. UI automatically hides for an immersive experience

### VR Controls

- Look around naturally with head tracking
- Camera position follows your current tower/airport location
- Stereo rendering provides depth perception

### Exiting VR Mode

- Remove headset or use the VR runtime's exit function
- UI returns when VR mode ends

### IPD Configuration

Interpupillary distance (IPD) can be adjusted in settings for proper stereo separation.

---

## Settings

Access settings by clicking the gear icon in the bottom-right corner. Settings are organized into five tabs.

### General Tab

| Setting | Description | Default |
|---------|-------------|---------|
| **Cesium Ion Token** | API key for terrain/imagery (required) | - |
| **Theme** | Light or dark interface | Dark |
| **Default FOV** | Starting field of view | 60° |
| **Camera Speed** | WASD movement speed multiplier | 1x |
| **Mouse Sensitivity** | Right-click drag rotation speed | 1x |

**Getting a Cesium Ion Token:**
1. Create a free account at [cesium.com/ion](https://cesium.com/ion)
2. Go to Access Tokens
3. Create a new token with default permissions
4. Paste the token in the settings field

### Display Tab

| Setting | Description | Default |
|---------|-------------|---------|
| **Label Visibility Distance** | How far aircraft labels appear | 30 nm |
| **Datablock Display** | Label detail level | Full |
| **Show Aircraft Panel** | Toggle the right-side aircraft list | On |
| **Show Ground Traffic** | Display aircraft on ground | On |
| **Show Airborne Traffic** | Display flying aircraft | On |
| **Max Aircraft** | Limit displayed aircraft count | 100 |

**Datablock Display Modes:**
- **Full**: Shows callsign, aircraft type, altitude, and speed
- **Airline Codes Only**: Shows only the airline ICAO code (e.g., "UAL" instead of "UAL123")
- **None**: Hides labels entirely, showing only aircraft models

### Graphics Tab

| Setting | Description | Default |
|---------|-------------|---------|
| **Terrain Quality** | Level of terrain detail | High |
| **Show 3D Buildings** | OpenStreetMap building models | Off |
| **Time of Day** | Real-time or fixed local hour | Real |
| **Enable Fog** | METAR-based fog effects | On |
| **Fog Intensity** | Fog opacity multiplier | 1x |
| **Visibility Scale** | Fog distance multiplier | 1x |
| **Enable Clouds** | Cloud layers at METAR ceilings | On |
| **Ambient Occlusion** | HBAO screen-space shading | Off |
| **Orientation Emulation** | Aircraft pitch/roll physics simulation | On |
| **Emulation Intensity** | Strength of pitch/roll effects | 100% |

**Terrain Quality Levels:**
1. **Low**: Fastest loading, minimal detail
2. **Medium**: Balanced performance
3. **High**: Good detail (default)
4. **Very High**: Detailed terrain
5. **Ultra**: Maximum detail (may impact performance)

**Time of Day Options:**
- **Real Time**: Uses current UTC time for sun position
- **Fixed Time**: Set a specific local hour (0-24) at the tower location

Fixed time is useful for consistent lighting, viewing dawn/dusk conditions, or avoiding harsh midday shadows.

### Performance Tab

| Setting | Description | Default |
|---------|-------------|---------|
| **In-Memory Tile Cache** | Cached terrain tiles in memory | 150 tiles |
| **Disk Cache Size** | Persistent tile cache on disk | 1 GB |
| **Aircraft Data Radius** | VATSIM data fetch radius | 100 nm |

**Performance Tips:**
- Lower terrain quality for smoother performance on older hardware
- Disable 3D buildings if experiencing frame drops
- Reduce label visibility distance to decrease rendered aircraft
- Close unused inset viewports

### Help Tab

The Help tab includes:
- Complete keyboard shortcuts reference
- Follow mode controls
- Mouse controls overview
- Links to documentation

---

## Modding

TowerCab 3D supports custom 3D models for aircraft and towers.

### Installing Mods

1. Place mod folders in the `mods/` directory:
   - Aircraft: `mods/aircraft/{TYPE}/`
   - Towers: `mods/towers/{ICAO}/`
2. Each mod needs a `manifest.json` and a `model.glb` file
3. Restart the application to load new mods

### Aircraft Mods

Replace the default cone mesh with realistic aircraft models. Mods match by ICAO aircraft type code (e.g., B738, A320).

### Tower Mods

Add custom control tower models for specific airports. Mods match by ICAO airport code (e.g., KJFK, EGLL).

### Full Documentation

See [MODDING.md](MODDING.md) for complete modding instructions including:
- Manifest file format
- Model requirements and guidelines
- Blender export settings
- Troubleshooting tips

---

## Keyboard Shortcuts Reference

### Camera Movement

| Key | Action |
|-----|--------|
| W | Move forward |
| S | Move backward |
| A | Strafe left |
| D | Strafe right |
| Q | Move down |
| E | Move up |
| Shift + WASD | Sprint (3x speed) |

### Camera Rotation

| Key | Action |
|-----|--------|
| Arrow Left | Rotate left |
| Arrow Right | Rotate right |
| Arrow Up | Tilt up |
| Arrow Down | Tilt down |

### Zoom

| Key | Action |
|-----|--------|
| + or = | Zoom in |
| - | Zoom out |
| Mouse Wheel | Smooth zoom |

### View Controls

| Key | Action |
|-----|--------|
| T | Toggle 3D / top-down view |
| R | Reset view (heading, pitch, FOV) |
| r | Reset position offset only |
| Home | Full reset |
| Shift+R | Full reset with position |

### Following

| Key | Action |
|-----|--------|
| O | Toggle Tower / Orbit mode |
| Escape | Stop following |

### Tools

| Key | Action |
|-----|--------|
| M | Toggle measuring tool |
| Ctrl+K | Open global aircraft search |
| F1 | Toggle performance HUD |

### Replay (when in Replay mode)

| Key | Action |
|-----|--------|
| Space | Play/Pause |
| Left Arrow | Step backward 15 seconds |
| Right Arrow | Step forward 15 seconds |

### Global

| Key | Action |
|-----|--------|
| Escape | Close modals, stop following, exit measuring mode |

---

## Troubleshooting

### Globe Not Loading

**Symptom:** Black screen or no terrain/imagery

**Solutions:**
1. Check that your Cesium Ion token is entered correctly in Settings
2. Ensure the token has default permissions (terrain, imagery)
3. Check your internet connection
4. Try refreshing (Ctrl+R in dev mode)

### No Aircraft Visible

**Symptom:** Globe loads but no aircraft appear

**Solutions:**
1. Ensure you've selected an airport
2. Check the "Connected" status in the top bar
3. Increase the Label Visibility Distance in settings
4. Verify VATSIM network is online
5. Some airports may have no nearby traffic

### Aircraft Labels at Wrong Position

**Symptom:** Labels appear in wrong locations initially

**Solutions:**
1. Wait a few seconds for the camera to sync
2. Move the camera slightly to trigger an update
3. This typically resolves after the first camera movement

### Low Frame Rate / Performance Issues

**Symptom:** Choppy movement, slow response

**Solutions:**
1. Reduce Terrain Quality in settings
2. Disable 3D Buildings
3. Reduce Label Visibility Distance
4. Close other GPU-intensive applications
5. Ensure your graphics drivers are up to date

### Camera Stuck or Unresponsive

**Symptom:** Camera controls don't work

**Solutions:**
1. Click on the 3D view to ensure it has focus
2. Press Escape to clear any active states
3. Press R to reset the camera
4. Check if a modal or input field has focus

### Mods Not Loading

**Symptom:** Custom models don't appear

**Solutions:**
1. Verify folder structure: `mods/aircraft/{TYPE}/manifest.json`
2. Check that `manifest.json` is valid JSON
3. Ensure `modelFile` path is correct
4. Verify the model file is a valid GLB/glTF
5. Restart the application after adding mods
6. Check browser console for loading errors

### Search Not Finding Aircraft

**Symptom:** Global search returns no results

**Solutions:**
1. Try searching by full or partial callsign
2. Try searching by aircraft type (e.g., "B738")
3. Try searching by airport code in the route
4. Ensure you're connected (check top bar status)

---

## Tips and Best Practices

### For Beginners

1. Start with a busy airport (KJFK, EGLL, KLAX) to see traffic
2. Use the Aircraft Panel to find and follow aircraft
3. Experiment with both Tower and Orbit follow modes
4. Save your preferred views as bookmarks

### For Controllers

1. Set up bookmarks for each runway approach view
2. Use top-down view for overall traffic awareness
3. Follow aircraft in Tower mode to monitor approaches
4. Use Global Search (Ctrl+K) to find specific callsigns

### For Performance

1. Use terrain quality "Medium" or "High" for best balance
2. Disable 3D buildings unless needed
3. Keep label visibility at 30nm or less
4. The application caches tiles, so revisited areas load faster

---

## Getting Help

- Check the [README.md](README.md) for quick reference
- See [MODDING.md](MODDING.md) for custom model creation
- Report issues on the project's GitHub page
- Join VATSIM community forums for discussion

---

*TowerCab 3D - Bringing the tower view to life*
