# Plan: iFrame Isolation for Inset Viewports

## Problem
**Confirmed Cesium bug** prevents 3D buildings from rendering correctly in multiple viewers. Despite each `Cesium.Viewer` having its own WebGL context (separate canvases), Cesium shares internal resources (static caches, workers, primitives) that cause conflicts when multiple viewers try to render 3D Tiles simultaneously.

## Requirements (Confirmed)
- ✅ 3D buildings must render in ALL viewports (main + insets)
- ✅ Full interactivity in insets (camera control, aircraft selection, follow mode)
- ✅ iFrame isolation required (no simpler fix available)

## Proposed Solution
Render inset viewports in iFrames with a lightweight version of the app, using SharedWorker for data sharing and postMessage for settings/interaction synchronization.

---

## Architecture

```
Main Window (towercab-3d)
├─ Full React App
│   ├─ Main CesiumViewer (with 3D buildings)
│   ├─ All UI (settings, panels, command input)
│   ├─ Data fetching (VATSIM, weather, airports)
│   └─ Settings management
│
├─ SharedWorker: "towercab-shared"
│   ├─ VATSIM interpolated aircraft state (broadcast)
│   ├─ Weather data (broadcast)
│   ├─ Settings snapshot (broadcast on change)
│   └─ Viewport-specific camera state (per-viewport channels)
│
└─ Inset iFrames (one per inset viewport)
    └─ inset.html?viewportId=inset-1&parentOrigin=...
        ├─ Minimal React app
        │   ├─ Single CesiumViewer (isInset=true)
        │   ├─ No UI chrome (no settings panels, no command input)
        │   └─ Babylon overlay (labels only)
        │
        ├─ SharedWorker connection
        │   ├─ Receives: aircraft, weather, settings
        │   └─ No sends (read-only consumer)
        │
        └─ postMessage to parent
            ├─ Camera changes (if user interacts with inset)
            ├─ Aircraft selection events
            └─ Ready/error status
```

---

## Implementation Steps

### Phase 1: SharedWorker Infrastructure

**Files to create:**
- `src/renderer/workers/shared-data.worker.ts` - SharedWorker for data broadcasting

**SharedWorker responsibilities:**
```typescript
interface SharedWorkerMessage {
  type: 'aircraft-update' | 'weather-update' | 'settings-update' | 'viewport-camera'
  payload: unknown
  viewportId?: string  // For viewport-specific messages
}
```

**Main app changes:**
- Post aircraft state to SharedWorker on each interpolation frame
- Post settings changes to SharedWorker
- Post weather updates to SharedWorker

### Phase 2: Inset App Variant

**New entry point:**
- `src/renderer/inset-main.tsx` - Minimal React entry for insets
- `inset.html` - HTML shell (copy of index.html, different entry)

**Inset app includes:**
- CesiumViewer component (with isInset=true)
- Babylon overlay for labels
- SharedWorker consumer hooks
- postMessage bridge to parent

**Inset app excludes:**
- Settings UI
- Command input
- Aircraft panels
- Data fetching (receives via SharedWorker)
- All store persistence

### Phase 3: iFrame Container

**Modify:**
- `InsetCesiumViewer.tsx` → Render iFrame instead of CesiumViewer

```tsx
// InsetCesiumViewer.tsx (new implementation)
const InsetCesiumViewer = ({ viewportId }: Props) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Build iframe URL with viewport ID
  const iframeSrc = useMemo(() => {
    const base = import.meta.env.DEV ? '/inset.html' : 'inset.html'
    return `${base}?viewportId=${viewportId}&parentOrigin=${window.location.origin}`
  }, [viewportId])

  // postMessage handlers for camera sync, selection, etc.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      // Handle messages from inset
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      style={{ width: '100%', height: '100%', border: 'none' }}
      sandbox="allow-scripts allow-same-origin"
    />
  )
}
```

### Phase 4: Vite Build Configuration

**Modify `vite.config.ts`:**
```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        inset: resolve(__dirname, 'inset.html'),
      },
    },
  },
})
```

### Phase 5: Settings Synchronization

**Main → Inset (via SharedWorker):**
- Graphics settings (inset-specific)
- Cesium Ion token
- Imagery provider settings
- Label/datablock settings
- Aircraft filter settings

**Inset → Main (via postMessage):**
- Camera state changes (position, heading, pitch, roll, altitude)
- View mode changes (orbit, free, follow requests)
- Aircraft selection (click on aircraft in inset)
- Aircraft follow requests (double-click to follow)
- Keyboard input forwarding (if inset has focus)
- Error/status reporting (ready, error, WebGL context lost)

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN WINDOW                               │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────────┐  │
│  │ VATSIM/vNAS  │───▶│ Aircraft      │───▶│ SharedWorker     │  │
│  │ Data Fetch   │    │ Interpolation │    │ .postMessage()   │  │
│  └──────────────┘    └───────────────┘    └────────┬─────────┘  │
│                                                     │            │
│  ┌──────────────┐    ┌───────────────┐             │            │
│  │ Settings UI  │───▶│ Zustand       │─────────────┤            │
│  │              │    │ Stores        │             │            │
│  └──────────────┘    └───────────────┘             │            │
│                                                     │            │
│  ┌──────────────────────────────────┐              │            │
│  │ Main CesiumViewer                │              │            │
│  │ (full features, 3D buildings)   │              │            │
│  └──────────────────────────────────┘              │            │
│                                                     │            │
│  ┌──────────────────────────────────┐              │            │
│  │ Inset iFrame Container           │◀─postMessage─┘            │
│  │ (handles camera/selection sync) │                            │
│  └──────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
         ┌─────────────────┐  ┌─────────────────┐
         │ INSET iFrame #1 │  │ INSET iFrame #2 │
         │                 │  │                 │
         │ SharedWorker    │  │ SharedWorker    │
         │ connection      │  │ connection      │
         │       ↓         │  │       ↓         │
         │ Local state     │  │ Local state     │
         │ (mirror)        │  │ (mirror)        │
         │       ↓         │  │       ↓         │
         │ CesiumViewer    │  │ CesiumViewer    │
         │ (isolated ctx)  │  │ (isolated ctx)  │
         └─────────────────┘  └─────────────────┘
```

---

## Key Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `inset.html` | Create | HTML entry for inset iframes |
| `src/renderer/inset-main.tsx` | Create | React entry point for insets |
| `src/renderer/workers/shared-data.worker.ts` | Create | SharedWorker for data broadcast |
| `src/renderer/hooks/useSharedWorkerProvider.ts` | Create | Main app: push data to worker |
| `src/renderer/hooks/useSharedWorkerConsumer.ts` | Create | Inset app: receive data from worker |
| `src/renderer/components/InsetApp.tsx` | Create | Minimal inset React app |
| `src/renderer/components/Viewport/InsetCesiumViewer.tsx` | Modify | Render iFrame instead of viewer |
| `vite.config.ts` | Modify | Multi-entry build |

---

## Performance Considerations

1. **SharedWorker efficiency**
   - Use structured clone for large data (aircraft map)
   - Consider transferable objects for typed arrays
   - Throttle settings updates (debounce 100ms)

2. **iFrame overhead**
   - Each iFrame = separate JS runtime
   - But: Cesium/Babylon bundle loaded once (browser cache)
   - Consider lazy-loading inset.html only when inset created

3. **Memory**
   - Each iFrame has own heap
   - Aircraft data duplicated (once per iFrame)
   - Mitigate: Only send visible aircraft to each inset based on camera bounds

---

## Alternative: Web Workers with OffscreenCanvas

If iFrame approach has issues, could explore OffscreenCanvas:
- Requires Cesium patches (not officially supported)
- Each inset rendered in dedicated Worker
- Canvas transferred to main thread for display
- Much higher implementation effort

---

## Testing Strategy

1. **Unit tests**
   - SharedWorker message serialization
   - postMessage handlers

2. **Integration tests**
   - iFrame loading and initialization
   - Settings sync round-trip
   - Camera state sync

3. **Manual testing**
   - 3D buildings visible in main AND insets simultaneously
   - Performance with 3+ insets
   - Settings changes propagate correctly
   - Aircraft selection in inset updates main

---

## Open Questions (Resolved)

1. ~~Should insets support 3D buildings at all?~~ → **Yes, confirmed**
2. ~~How to handle Cesium Ion token?~~ → **SharedWorker** (avoids URL exposure, more secure)
3. ~~Should camera changes in inset propagate back to main?~~ → **Yes** - Follow mode and manual 6DOF camera changes must persist in the main app's viewport store for that airport
4. ~~What happens when main window refreshes?~~ → **Insets recreate** - No special state preservation; they rebuild from SharedWorker data
5. ~~Lazy or preloaded iFrames?~~ → **Lazy loading** - Only load iframe when user creates an inset (don't burden users who don't use insets)

---

## Implementation Complexity

**High complexity areas:**
1. **SharedWorker setup** - Need to handle worker initialization, connection lifecycle, and message routing
2. **Inset app variant** - Extracting minimal React app that can run standalone
3. **Full interactivity sync** - Camera, selection, follow mode all need bidirectional sync
4. **Build configuration** - Multi-entry Vite build with shared chunks

**Lower complexity areas:**
1. **iFrame container** - Straightforward iframe rendering with postMessage
2. **Settings sync** - One-way broadcast from main to insets
3. **Aircraft data broadcast** - Already have interpolation; just need to broadcast

**Recommended implementation order:**
1. SharedWorker infrastructure (foundation)
2. Basic inset app that receives aircraft data
3. postMessage bridge for camera sync
4. Full interactivity (selection, follow mode)
5. Settings sync refinement
6. Testing and edge cases

---

## Verification Plan

1. Create test with main viewport + 2 insets, all showing 3D buildings
2. Verify no WebGL errors in console
3. Verify buildings render correctly in all viewports
4. Verify aircraft interpolation stays smooth across all viewports
5. Verify settings changes in main propagate to insets within 200ms
6. Verify memory usage is acceptable (< 2GB total for main + 2 insets)
