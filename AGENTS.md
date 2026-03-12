# AGENTS.md

Quick reference for AI coding agents working in TowerCab 3D.

## Build, Lint & Test Commands

```bash
# Development
pnpm run dev             # Start Tauri app (GUI - ask user to run)
pnpm run serve           # Frontend-only in browser (no Tauri)

# Type checking & linting (CRITICAL before commits)
pnpm run typecheck       # TypeScript type checking (MUST pass)
pnpm run lint            # Check for Biome errors
pnpm run lint:fix        # Auto-fix Biome issues

# Validation (run ALL checks before committing)
pnpm run check           # Run all: lint, types, Rust checks
pnpm run check:lint      # Biome only
pnpm run check:types     # TypeScript only
pnpm run check:rust      # Rust/Cargo only

# Testing
pnpm test                # Run all tests with Vitest
pnpm run test:ui         # Run tests with UI
pnpm run test:matching   # Run specific test file (model-matching.test.ts)
vitest run <path>        # Run a single test file

# Build
pnpm run build           # Production build (includes typecheck + converter)
pnpm run build:vnas      # Build with vNAS (private repo access required)
```

**CRITICAL:** Always run `pnpm run typecheck` before committing. Vite does NOT type-check during builds - it only transpiles. Type errors can slip through without explicit `tsc` checks.

## File Paths on Windows

**CRITICAL:** When using Edit/Write tools on Windows, use absolute paths with backslashes:

```
✅ CORRECT:  X:\dev\towercab-3d\package.json
❌ WRONG:    package.json
❌ WRONG:    X:/dev/towercab-3d/package.json
```

**Never use `2>nul` in terminal commands on Windows** - it creates an undeletable file. Use `2>$null` or omit stderr redirection.

## Project Architecture

- **Framework:** Tauri 2 desktop app with React 19 frontend
- **Rendering:** Dual rendering system
  - CesiumJS: 3D globe, terrain, aircraft models
  - Babylon.js: 2D overlay for labels, weather effects
- **State:** 18 Zustand stores (see CLAUDE.md for full list)
- **Path Alias:** `@/` → `src/renderer/`
- **TypeScript:** Strict mode, use `import type` for type-only imports

See `docs/architecture.md` for detailed data flow, store relationships, and rendering pipeline.

## Code Style Guidelines

### Imports

```typescript
// React imports first
import { useState, useEffect, useCallback } from 'react'

// Third-party libraries
import { create } from 'zustand'
import * as Cesium from 'cesium'

// Local imports - use @ alias, type-only imports with 'type' keyword
import type { Airport, AirportData } from '@/types/airport'
import { useAirportStore } from '@/stores/airportStore'
import { VatsimService } from '@/services/VatsimService'
import './ComponentName.css'
```

### Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Constants | `SCREAMING_SNAKE_CASE` | `FOV_DEFAULT`, `ORBIT_DISTANCE_MAX` |
| Types/Interfaces | `PascalCase` | `Airport`, `CesiumSettings` |
| Functions/Variables | `camelCase` | `fetchData`, `isAirportSelectorOpen` |
| Components | `PascalCase` | `AirportSelector`, `CesiumViewer` |
| Files (types) | `kebab-case.ts` | `aircraft-timeline.ts`, `camera.ts` |
| Files (components) | `PascalCase.tsx` | `AirportSelector.tsx` |
| Stores | `camelCaseStore.ts` | `airportStore.ts`, `settingsStore.ts` |
| Services | `PascalCaseService.ts` | `VatsimService.ts`, `MetarService.ts` |

### TypeScript

- **Strict mode enabled** - no implicit any, null checks required
- **Use type imports:** `import type { ... }` for types only
- **Unused vars:** Prefix with `_` if intentionally unused (e.g., `_event`)
- **Explicit types:** Prefer explicit return types for functions
- **No `any`:** Warn-level only, avoid when possible

### React Components

```typescript
// Functional components with named function (not arrow)
function AirportSelector() {
  // Hooks at top
  const isOpen = useAirportStore((state) => state.isAirportSelectorOpen)
  const [query, setQuery] = useState('')
  
  // Callbacks with useCallback when passed as props
  const handleSelect = useCallback((airport: Airport) => {
    selectAirport(airport)
  }, [selectAirport])
  
  // useMemo for expensive computations
  const filteredList = useMemo(() => {
    return airports.filter(a => a.icao.includes(query))
  }, [airports, query])
  
  return (
    <div className="airport-selector">
      {/* JSX content */}
    </div>
  )
}
```

**React-specific rules:**
- No `import React` needed (React 19 with new JSX transform)
- No prop-types (TypeScript handles it)
- React hooks rules enforced (`rules-of-hooks`: error, `exhaustive-deps`: warn)

### Error Handling

```typescript
// Service methods - throw descriptive errors
async fetchData(): Promise<VatsimData> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`VATSIM API error: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

// UI components - catch and display errors
try {
  await someOperation()
} catch (error) {
  console.error('[ComponentName] Operation failed:', error)
  // Use uiFeedbackStore for user-facing errors
}
```

### Comments & Documentation

```typescript
/**
 * Service-level JSDoc for classes/functions
 * 
 * @param icao - Airport ICAO code
 * @returns Airport data or null if not found
 */
async function getAirport(icao: string): Promise<Airport | null> {
  // Inline comments for non-obvious logic
  // Normalize to uppercase (VATSIM uses mixed case)
  const normalized = icao.toUpperCase()
  return airports.get(normalized)
}
```

**Comment guidelines:**
- Use JSDoc for public APIs, services, complex functions
- Inline comments for "why" not "what"
- Section dividers for long files (see `settingsStore.ts`)

## Code Organization

```
src/renderer/
├── types/           # Centralized TypeScript types (import via '@/types')
├── constants/       # Configuration values, thresholds (SCREAMING_SNAKE_CASE)
├── stores/          # Zustand state management (18 stores)
├── services/        # Business logic, API clients (PascalCaseService.ts)
├── components/      # React components
│   ├── UI/          # UI components
│   ├── CesiumViewer/ # Cesium-specific
│   ├── Viewport/    # Viewport system
│   └── VR/          # WebXR VR components
├── hooks/           # Custom React hooks
└── utils/           # Helper functions
```

**Key files to understand:**
- `types/settings.ts` - All settings interfaces
- `stores/viewportStore.ts` - Primary camera state (NOT deprecated cameraStore)
- `services/MSFSModelConversionService.ts` - FSLTL/AIG model conversion

## Settings Changes

**Adding a new local setting (most common):**
1. Add field to interface in `types/settings.ts` (e.g., `GraphicsSettings`)
2. Add default to `DEFAULT_SETTINGS` in `types/settings.ts`
3. Increment `version` in `settingsStore.ts`
4. Add UI control in appropriate settings tab
5. **Done!** Migrations auto-merge defaults

**Adding a global setting (shared across devices):**
1. Add to `GlobalSettings` in `types/settings.ts`
2. Add default to `DEFAULT_GLOBAL_SETTINGS`
3. Add update function in `globalSettingsStore.ts`
4. **CRITICAL:** Update Rust struct in `src-tauri/src/settings.rs` (add `#[serde(default)]`)

## Changelog Maintenance

**Update `CHANGELOG.md` for user-facing changes only:**

✅ **DO include:** New features, bug fixes, behavior changes, removed features
❌ **DON'T include:** Refactoring, type fixes, build changes, dependency updates

**Format:**
```markdown
## [Unreleased]
### Added
- New feature description in user-friendly language

### Fixed
- Bug fix description (what users will notice)

### Changed
- Behavior change description
```

Move to version header on release. Don't list fixes for unreleased features (part of "Added").

## Common Pitfalls

1. **Type checking:** `pnpm run build` DOES NOT type-check. Run `pnpm run typecheck` explicitly.
2. **Camera state:** Use `viewportStore`, not deprecated `cameraStore`
3. **File paths:** Windows requires absolute paths with backslashes in Edit/Write tools
4. **Imports:** Use `@/` alias, `import type` for types
5. **Tauri detection:** Use `isTauri()` from `@/utils/tauriApi`, not manual checks
6. **Global settings:** Must update both TypeScript AND Rust structs or fields get dropped

## Release Process

1. Update versions in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
2. Move `[Unreleased]` in CHANGELOG.md to version header
3. `pnpm run check` (all validations)
4. `git commit -m "Release vX.X.X-alpha"`
5. `git tag vX.X.X-alpha && git push --tags`

CI automatically builds and uploads installer on tag push.
