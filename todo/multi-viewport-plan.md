# Multi-Viewport Feature Implementation Plan

## Overview

Add inset viewports that overlay on the main viewport, each functioning as an independent view with full camera controls. Users activate a viewport by clicking it (bright border indicates active state), and all controls then affect only that viewport. Bookmarks are shared per-airport across all viewports.

## Requirements Summary

- **Unlimited insets** - User can add as many viewports as desired (with performance warnings)
- **Fully flexible** - Insets are resizable and repositionable via drag
- **Per-airport persistence** - Full viewport configuration saved per airport:
  - **Auto-save**: All viewport layouts AND camera states saved automatically during runtime
  - **Save Default**: Saves complete multi-viewport configuration as the airport default
  - **Reset to Default**: Restores all viewports to the saved default configuration
- **Independent follow** - Each viewport can follow different aircraft
- **Shared bookmarks** - Save from any viewport, load into any viewport

---

## Architecture

### New Store: `viewportStore.ts`

Manages viewport collection, layout, and per-viewport camera state.

```typescript
interface ViewportLayout {
  x: number      // 0-1 normalized position
  y: number
  width: number  // 0-1 normalized size
  height: number
  zIndex: number
}

interface ViewportCameraState {
  viewMode: '3d' | 'topdown'
  heading: number
  pitch: number
  fov: number
  positionOffsetX/Y/Z: number
  topdownAltitude: number
  followingCallsign: string | null
  followMode: 'tower' | 'orbit'
  followZoom: number
  orbitDistance/Heading/Pitch: number
  preFollowState: PreFollowState | null
}

interface Viewport {
  id: string
  layout: ViewportLayout
  cameraState: ViewportCameraState
  label?: string
}

interface ViewportStore {
  viewports: Viewport[]           // Index 0 = main viewport (full screen)
  activeViewportId: string

  // Per-airport persistence - includes ALL viewport state
  airportViewportConfigs: Record<string, {
    viewports: Viewport[]         // Layout + camera state for all viewports
    activeViewportId: string
    defaultConfig?: {             // User-saved "default" configuration
      viewports: Viewport[]
      activeViewportId: string
    }
  }>

  // Viewport management
  addViewport: (layout?: Partial<ViewportLayout>) => string
  removeViewport: (id: string) => void
  updateViewportLayout: (id: string, layout: Partial<ViewportLayout>) => void
  setActiveViewport: (id: string) => void

  // Camera actions (operate on active viewport)
  setHeading/setPitch/setFov/adjustHeading/etc...
  followAircraft/stopFollowing/setFollowMode/etc...

  // Airport switching - loads/saves full viewport config
  setCurrentAirport: (icao: string) => void

  // Default management (like current "Save as Default" / "Reset to Default")
  saveCurrentAsDefault: () => void      // Saves all viewports as default for current airport
  resetToDefault: () => void            // Restores all viewports to saved default
  hasCustomDefault: () => boolean       // Check if airport has a saved default
}
```

### Modified: `cameraStore.ts`

Reduced scope - only manages shared bookmarks:

```typescript
interface CameraStore {
  currentAirportIcao: string | null
  airportSettings: { [icao]: { bookmarks: {...} } }

  saveBookmark: (slot: number) => void   // Reads from active viewport
  loadBookmark: (slot: number) => boolean // Applies to active viewport
}
```

---

## Component Structure

```
App.tsx
├── TopBar
├── ViewportManager (NEW)
│   ├── main-content
│   │   ├── CommandInput
│   │   ├── ViewportContainer (main, isActive border)
│   │   │   └── CesiumViewer + BabylonOverlay
│   │   ├── AircraftPanel
│   │   └── InsetViewportLayer (z-index: 50)
│   │       └── InsetViewport[] (draggable/resizable)
│   │           └── ViewportContainer
│   │               └── CesiumViewer + BabylonOverlay
│   └── AddInsetButton
├── ControlsBar
└── Modals
```

### New Components

| Component | Purpose |
|-----------|---------|
| `ViewportManager.tsx` | Orchestrates all viewports, provides context |
| `ViewportContainer.tsx` | Wrapper with activation border, drag/resize handles |
| `InsetViewport.tsx` | Self-contained inset with its own Cesium/Babylon |
| `InsetViewportLayer.tsx` | Container for all insets with z-index management |
| `AddInsetButton.tsx` | Floating button to create new insets |

---

## Controls Routing

### Activation System

- **Click-to-activate**: Any mouse button on viewport canvas activates it
- **Visual indicator**: Cyan border + glow on active viewport
- **Keyboard always routes to active viewport**

### Hook Modifications

The current architecture splits camera logic into two hooks:
- **`useCesiumCamera.ts`** (637 lines): Camera positioning, following, animations
- **`useCameraInput.ts`** (398 lines): Keyboard/mouse input handling

**`useCesiumCamera.ts`** - New signature:
```typescript
useCesiumCamera(
  viewer: Cesium.Viewer | null,
  viewportId: string,           // NEW
  interpolatedAircraft?: Map<string, InterpolatedAircraftState>
)
```

**`useCameraInput.ts`** - New signature:
```typescript
useCameraInput(
  viewer: Cesium.Viewer | null,
  viewportId: string,           // NEW
  options: { onBreakTowerFollow?: () => void }
)
```

Key changes to `useCameraInput`:
1. Keyboard handlers (currently `window.addEventListener`) check `activeViewportId === viewportId` before processing
2. Mouse handlers (already canvas-scoped via `ScreenSpaceEventHandler`) call `setActiveViewport(viewportId)` on mouse down
3. All store actions become scoped: read/write via viewportStore instead of cameraStore

Key changes to `useCesiumCamera`:
1. Pass `viewportId` to `useCameraInput`
2. Read camera state from `viewportStore.getViewport(viewportId).cameraState` instead of `cameraStore`
3. Apply camera to the viewport's Cesium viewer

### Bookmark Flow

- **Save (.XX.)**: Captures active viewport's camera state → stores in cameraStore per airport
- **Load (.XX)**: Reads from cameraStore → applies to active viewport's camera state

---

## Drag/Resize Implementation

Custom implementation using pointer events (no external library):

```typescript
// hooks/useDragResize.ts
interface UseDragResizeReturn {
  position: { x: number; y: number }
  size: { width: number; height: number }
  isDragging: boolean
  isResizing: boolean
  dragHandleProps: { onPointerDown: (e) => void }
  resizeHandleProps: (direction) => { onPointerDown: (e) => void }
}
```

Features:
- Title bar for dragging
- Corner/edge handles for resizing
- Pointer capture for reliable tracking
- Bounds constraints to parent
- Minimum size: 200x150px

---

## Styling

```css
.viewport-container {
  border: 2px solid transparent;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.viewport-container.active {
  border-color: #00ffff;
  box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
}

.viewport-container.inset {
  position: absolute;
  border-radius: 4px;
  overflow: hidden;
}

.viewport-container.inset .drag-handle {
  height: 24px;
  background: linear-gradient(rgba(40, 40, 60, 0.9), rgba(20, 20, 30, 0.8));
  cursor: move;
}
```

Z-index hierarchy:
- 100: TopBar, ControlsBar
- 60: Modals
- 50+: Inset viewports (incremented when brought to front)
- 10: Babylon overlay (per viewport)
- 0: Main viewport / Cesium

---

## Persistence Behavior

### Auto-Save (Implicit)
- Debounced save (5 seconds after last change) - same as current behavior
- Saves to `airportViewportConfigs[icao].viewports`:
  - All viewport layouts (position, size, zIndex)
  - All viewport camera states (heading, pitch, fov, position offsets, etc.)
  - Active viewport ID
- Triggered by: camera changes, viewport resize/move, viewport add/remove

### Save Default (Explicit - "Save as Default" button)
- Currently: `cameraStore.saveCurrentAsDefault()` saves per view mode (3d/topdown separately)
- New behavior: Saves complete snapshot to `airportViewportConfigs[icao].defaultConfig`
- Includes ALL viewports with their layouts and camera states
- User explicitly saves their preferred multi-viewport setup for an airport
- Note: This changes the current per-viewmode default to a unified multi-viewport default

### Reset to Default
- Restores `viewports` from `defaultConfig` if it exists
- Falls back to single main viewport with default camera if no custom default
- Recreates all insets with their saved layouts and camera states

### Airport Switch
1. **Save current**: Auto-saves current viewport config to old airport
2. **Load new**: Loads saved config for new airport (or creates default single viewport)
3. All insets from previous airport are removed, new airport's insets are created

---

## Performance Considerations

Each Cesium viewer consumes significant memory. Mitigations:

1. **Reduced tile cache for insets**: `tileCacheSize: 50` (vs 100-200 main)
2. **Higher screen space error**: `maximumScreenSpaceError: 16` (vs 4 main)
3. **Optional shadow disable** for insets
4. **Shared aircraft data**: All viewports use same `vatsimStore` (no duplicate polling)
5. **Performance warning**: Show at 3+ viewports, suggest limit at 6

---

## Implementation Phases

### Phase 1: Foundation (Core Store & Components) - COMPLETED
- [x] Create `viewportStore.ts` with viewport CRUD and per-viewport camera state
- [x] Create `ViewportContainer.tsx` with activation border (no drag yet)
- [x] Create `ViewportManager.tsx` to wrap main content
- [x] Modify `App.tsx` to use ViewportManager
- [x] Wrap existing CesiumViewer in ViewportContainer

### Phase 2: Controls Routing
- [ ] Modify `useCesiumCamera.ts` to accept viewportId, check active state
- [ ] Add viewport activation on mouse down in Cesium handlers
- [ ] Update `ControlsBar.tsx` to read/write active viewport state
- [ ] Update `CommandInput.tsx` to save/load bookmarks via active viewport
- [ ] Update `AircraftPanel.tsx` follow functionality for active viewport

### Phase 3: Inset Viewports
- [ ] Create `InsetViewport.tsx` component (Cesium + Babylon instance)
- [ ] Create `InsetViewportLayer.tsx` container
- [ ] Create `AddInsetButton.tsx` with creation UI
- [ ] Implement inset creation with default position/size

### Phase 4: Drag & Resize
- [ ] Create `useDragResize.ts` hook
- [ ] Add drag handle to inset title bar
- [ ] Add resize handles (corners + edges)
- [ ] Implement bounds constraints and minimum size
- [ ] Persist layout changes to store

### Phase 5: Persistence & Polish
- [ ] Implement auto-save for all viewport states (debounced, per-airport)
- [ ] Update "Save as Default" to save complete multi-viewport configuration
- [ ] Update "Reset to Default" to restore all viewports from saved default
- [ ] Handle airport switching (save current config, load new airport's config)
- [ ] Add performance warnings for many viewports
- [ ] Polish animations and transitions
- [ ] Edge case handling (no active viewport, unmount during animation)

---

## Critical Files to Modify

| File | Changes |
|------|---------|
| `src/renderer/stores/viewportStore.ts` | **NEW** - Core viewport state management |
| `src/renderer/stores/cameraStore.ts` | Reduce to bookmark-only, integrate with viewportStore |
| `src/renderer/hooks/useCameraInput.ts` | Add viewportId param, check active state before processing input |
| `src/renderer/hooks/useCesiumCamera.ts` | Add viewportId param, read camera state from viewportStore |
| `src/renderer/hooks/useBabylonOverlay.ts` | Minor - pass viewportId through |
| `src/renderer/components/CesiumViewer/CesiumViewer.tsx` | Accept viewportId, pass to hooks |
| `src/renderer/components/UI/ControlsBar.tsx` | Read/write active viewport state via viewportStore |
| `src/renderer/components/UI/CommandInput.tsx` | Route bookmarks through active viewport |
| `src/renderer/components/UI/AircraftPanel.tsx` | Follow aircraft in active viewport |
| `src/renderer/App.tsx` | Wrap with ViewportManager |

## New Files to Create

| File | Purpose |
|------|---------|
| `src/renderer/stores/viewportStore.ts` | Viewport collection and per-viewport camera state |
| `src/renderer/components/Viewport/ViewportManager.tsx` | Orchestrates all viewports, provides context |
| `src/renderer/components/Viewport/ViewportContainer.tsx` | Wrapper with activation border and drag/resize handles |
| `src/renderer/components/Viewport/InsetViewport.tsx` | Self-contained inset (Cesium + Babylon instance) |
| `src/renderer/components/Viewport/InsetViewportLayer.tsx` | Container for all insets with z-index management |
| `src/renderer/components/Viewport/AddInsetButton.tsx` | Floating button to create new insets |
| `src/renderer/hooks/useDragResize.ts` | Custom pointer event handling for drag/resize |
| `src/renderer/components/Viewport/ViewportContainer.css` | Styles for activation border, drag handles |
