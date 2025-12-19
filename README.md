# TowerCab 3D

A 3D tower cab view application for VATSIM air traffic controllers. View real-time aircraft positions on a 3D globe with satellite imagery and terrain.

## Features

- **Live VATSIM Data**: Real-time aircraft positions updated every 15 seconds
- **3D Globe**: Satellite imagery and terrain powered by Cesium
- **Tower View Camera**: Pan, tilt, and zoom from tower perspective
- **Aircraft Display**: Cone-shaped aircraft with callsign labels
- **Smooth Interpolation**: Aircraft move smoothly between updates
- **Airport Search**: Search 28,000+ airports by ICAO, IATA, name, or city
- **Modding Support**: Load custom aircraft and tower models (glTF/GLB)

## Requirements

- Windows 10/11
- Node.js 18 or later (for development)
- Cesium Ion account (free tier) for terrain and imagery

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Get a Cesium Ion Token

1. Create a free account at [cesium.com/ion](https://cesium.com/ion)
2. Create an access token with default permissions
3. Copy the token

### 3. Run in Development Mode

```bash
npm run dev
```

### 4. Configure Cesium Token

1. Click the Settings icon (gear) in the bottom right
2. Paste your Cesium Ion token
3. Click outside the modal to save

### 5. Select an Airport

1. Click the airport button in the top left (or the "Select Airport" placeholder)
2. Search for an airport by ICAO code, name, or city
3. Click an airport to fly there

## Controls

| Control | Action |
|---------|--------|
| Arrow Keys | Pan/tilt camera |
| Scroll Wheel | Zoom in/out |
| R or Home | Reset view |
| + / - | Zoom in/out |
| Right-click + Drag | Look around |

## Building for Production

```bash
npm run build
```

The built application will be in the `dist` folder.

## Project Structure

```
towercab-3d/
├── src/
│   ├── main/           # Electron main process
│   ├── preload/        # Preload scripts
│   └── renderer/       # React frontend
│       ├── components/ # React components
│       ├── hooks/      # Custom React hooks
│       ├── services/   # API services
│       ├── stores/     # Zustand state stores
│       ├── types/      # TypeScript types
│       └── utils/      # Utility functions
├── resources/          # Static assets
└── mods/               # Custom models (see MODDING.md)
```

## Technology Stack

- **Electron** - Desktop application framework
- **React 18** - UI framework
- **TypeScript** - Type safety
- **CesiumJS** - 3D globe rendering
- **Zustand** - State management
- **Vite** - Build tool

## Data Sources

- **VATSIM**: Real-time flight data from [data.vatsim.net](https://data.vatsim.net/v3/vatsim-data.json)
- **Airports**: Database from [github.com/mwgg/Airports](https://github.com/mwgg/Airports)
- **Terrain/Imagery**: Cesium Ion World Terrain and Imagery

## Keyboard Shortcuts

- `Arrow Left/Right`: Rotate camera horizontally
- `Arrow Up/Down`: Tilt camera vertically
- `+` or `=`: Zoom in
- `-`: Zoom out
- `R` or `Home`: Reset view to default
- `Esc`: Close modals/dialogs

## License

MIT License - See LICENSE file for details.

## Acknowledgments

- [VATSIM](https://vatsim.net) for the network data API
- [Cesium](https://cesium.com) for the 3D globe technology
- [mwgg/Airports](https://github.com/mwgg/Airports) for the airport database
