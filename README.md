# TowerCab 3D

A 3D tower cab view application for VATSIM air traffic controllers. View real-time aircraft positions on a 3D globe with satellite imagery and terrain.

![TowerCab 3D](resources/screenshot.png)

## Features

### Live VATSIM Integration
- Real-time aircraft positions from VATSIM network (updated every ~15 seconds)
- Smooth interpolation between updates for fluid aircraft movement
- Global aircraft search (Ctrl+K) to find and follow any aircraft on the network
- Connection status indicator with pilot count

### 3D Visualization
- High-fidelity 3D globe with Cesium Ion satellite imagery
- Configurable terrain quality (5 levels from Low to Ultra)
- Optional 3D OpenStreetMap buildings
- Dynamic time-of-day lighting (real-time or fixed hour)
- Aircraft rendered as 3D models with realistic type-based sizing

### Camera System
- **3D Tower View**: Look around from tower perspective with smooth controls
- **Top-Down View**: Bird's-eye view with pan and zoom (press T to toggle)
- **Aircraft Following**: Two modes - Tower (camera stays at tower) or Orbit (camera circles aircraft)
- **WASD Movement**: Move camera position relative to tower
- **Bookmark System**: Save up to 99 camera positions per airport

### Aircraft Panel
- Nearby aircraft list with real-time updates
- Filter by callsign, aircraft type, or route
- Sort by distance, callsign, altitude, or speed
- One-click following with mode selection

### Airport Selection
- Search 28,000+ airports by ICAO, IATA, name, or city
- Recent airports history
- Quick access to popular international hubs
- Smooth camera animation when changing airports

### Modding Support
- Custom aircraft 3D models (glTF/GLB format)
- Custom tower models for specific airports
- See [MODDING.md](MODDING.md) for details

## Requirements

- Windows 10/11 (64-bit)
- Cesium Ion account (free tier) for terrain and imagery
- Node.js 18+ (only for development)

## Quick Start

### Option A: Download the Installer (Recommended)

1. Download the latest Windows installer from [GitHub Releases](https://github.com/leftos/towercab-3d/releases)
2. Run the installer and follow the prompts
3. Launch TowerCab 3D from the Start Menu or desktop shortcut
4. Continue to [Get a Cesium Ion Token](#2-get-a-cesium-ion-token) below

### Option B: Run from Source (Development)

#### 1. Install Dependencies

```bash
npm install
```

#### 2. Run in Development Mode

```bash
npm run dev
```

### 2. Get a Cesium Ion Token

1. Create a free account at [cesium.com/ion](https://cesium.com/ion)
2. Go to Access Tokens and create a new token with default permissions
3. Copy the token

### 3. Configure the Application

1. Click the **Settings** button (gear icon) in the bottom-right corner
2. Paste your Cesium Ion token in the token field
3. Adjust terrain quality and other settings as desired
4. Close the settings modal

### 4. Select an Airport

1. Click the airport button in the top-left (shows "Select Airport" initially)
2. Search for an airport by ICAO code (e.g., "KJFK"), IATA code (e.g., "JFK"), name, or city
3. Click an airport to fly there

## Controls

### Keyboard Controls

| Key | Action |
|-----|--------|
| **W/A/S/D** | Move camera position (forward/left/back/right) |
| **Q/E** | Move camera down/up |
| **Shift** | Sprint (3x movement speed with WASD) |
| **Arrow Keys** | Rotate camera (heading/pitch) |
| **+/-** | Zoom in/out |
| **T** | Toggle 3D / top-down view |
| **R** or **Home** | Reset camera view |
| **Shift+R** | Full reset (position and orientation) |
| **O** | Toggle follow mode (Tower/Orbit) when following |
| **Escape** | Stop following / close modals |
| **Ctrl+K** | Open global aircraft search |

### Mouse Controls

| Action | Effect |
|--------|--------|
| **Right-click + Drag** | Look around (rotate camera) |
| **Left-click + Drag** | Pan camera (top-down mode only) |
| **Scroll Wheel** | Zoom in/out |
| **Click Aircraft Label** | Follow that aircraft |

### Bookmark System

Save and restore camera positions quickly:
- Type `.00.` through `.99.` and press Enter to **save** to a slot
- Type `.00` through `.99` and press Enter to **load** from a slot
- Bookmarks are saved per-airport

## Building for Production

### Development Build
```bash
npm run build
```

### Windows Installer
```bash
npm run dist
```

The installer will be created in the `dist/` folder. This is the same installer distributed via [GitHub Releases](https://github.com/leftos/towercab-3d/releases).

## Project Structure

```
towercab-3d/
├── src/
│   ├── main/           # Electron main process
│   ├── preload/        # Preload scripts (context bridge)
│   └── renderer/       # React frontend
│       ├── components/ # React UI components
│       ├── hooks/      # Custom React hooks
│       ├── services/   # API services (VATSIM, airports)
│       ├── stores/     # Zustand state stores
│       ├── types/      # TypeScript type definitions
│       └── utils/      # Utility functions
├── resources/          # Static assets (icons, etc.)
└── mods/               # Custom models directory
    ├── aircraft/       # Aircraft model mods
    └── towers/         # Tower model mods
```

## Technology Stack

| Technology | Purpose |
|------------|---------|
| **Electron 39** | Desktop application framework |
| **React 19** | UI framework |
| **TypeScript 5** | Type-safe development |
| **CesiumJS 1.136** | 3D globe rendering |
| **Babylon.js 8** | GUI overlay (labels, leader lines, weather effects) |
| **Zustand 5** | State management |
| **Vite 7** | Build tool |

## Data Sources

- **VATSIM**: Real-time flight data from [data.vatsim.net](https://data.vatsim.net/v3/vatsim-data.json)
- **Airports**: Database from [github.com/mwgg/Airports](https://github.com/mwgg/Airports)
- **Terrain/Imagery**: Cesium Ion World Terrain and Bing Maps Aerial
- **Aircraft Dimensions**: Wingspan and length data from [FAA Aircraft Characteristics Database](https://www.faa.gov/airports/engineering/aircraft_char_database)
- **Aircraft 3D Models**: 39 aircraft models from [Flightradar24/fr24-3d-models](https://github.com/Flightradar24/fr24-3d-models) (GPL-2.0, originally from FlightGear) - includes A320 family, B737/747/757/767/777/787, CRJ, E-Jets, Q400, and more

### Refreshing Aircraft Dimensions Data

The aircraft dimensions data (used for realistic model sizing) is bundled with the app. To update it with the latest FAA data:

```bash
# Requires Python 3 with pandas and openpyxl
pip install pandas openpyxl
python scripts/convert-aircraft-data.py
```

This downloads the latest FAA Excel file and converts it to `src/renderer/public/aircraft-dimensions.json`.

## Settings Reference

| Setting | Description | Range |
|---------|-------------|-------|
| Cesium Ion Token | API key for terrain/imagery | Required |
| Label Visibility | Distance for showing aircraft labels | 5-100 nm |
| Show Aircraft Panel | Toggle nearby aircraft list | On/Off |
| Terrain Quality | Level of terrain detail | Low to Ultra (5 levels) |
| Show 3D Buildings | OpenStreetMap 3D buildings | On/Off |
| Time of Day | Real-time or fixed local hour | Real/0-24h |

## Performance Tips

- Lower terrain quality for smoother performance on older hardware
- Disable 3D buildings if experiencing frame drops
- Reduce label visibility distance to decrease rendered aircraft
- The application uses Service Worker caching for tile persistence

## Troubleshooting

### Globe Not Loading
- Verify your Cesium Ion token is correct and has default permissions
- Check your internet connection

### No Aircraft Showing
- Ensure you've selected an airport
- Check the connection status in the top bar
- Verify VATSIM network is online

### Low Frame Rate
- Reduce terrain quality in settings
- Disable 3D buildings
- Close other GPU-intensive applications

## License

MIT License - See [LICENSE](LICENSE) file for details.

## Acknowledgments

- [VATSIM](https://vatsim.net) - Virtual Air Traffic Simulation Network
- [Cesium](https://cesium.com) - 3D geospatial platform
- [mwgg/Airports](https://github.com/mwgg/Airports) - Airport database
- [Babylon.js](https://babylonjs.com) - 3D rendering engine
- [FlightGear](https://www.flightgear.org/) / [FGMEMBERS](https://github.com/FGMEMBERS) - Aircraft 3D model (via [Flightradar24](https://github.com/Flightradar24/fr24-3d-models))
