---
name: add-setting
description: Add a new app setting (per-browser via settingsStore, or global via globalSettingsStore + Rust bridge). Walks through type definition, default value, version bump, UI control placement, and Rust struct sync — making sure the easy-to-miss steps aren't missed.
---

# Add a New Setting

TowerCab 3D has two distinct settings systems with different procedures. Pick the right one before scaffolding edits.

## Step 1: Determine which type

Ask the user (or infer from context) which kind of setting this is:

| Type | Use when… | Stored where | Persists across devices? |
|------|-----------|--------------|--------------------------|
| **Per-browser** (Settings) | User's UI/graphics/camera preferences for *this* browser/device | `localStorage` via Zustand persist | No — local to the device |
| **Global** (GlobalSettings) | Cesium token, MSFS paths, bookmarks, datablock positions | Rust backend → disk JSON | Yes — synced across devices |

If unsure, default to per-browser. Global is for things that *must* be shared (like the user's API tokens or hand-placed bookmarks).

## Step 2 (Per-browser): Simple path

For most cases, only these four edits are needed — the migration system's "repair step" auto-merges new fields with `DEFAULT_SETTINGS`:

1. Add the field to the relevant interface in `src/renderer/types/settings.ts` (e.g., `CesiumSettings`, `GraphicsSettings`, `CameraSettings`, `WeatherSettings`, `UISettings`).
2. Add the default value to `DEFAULT_SETTINGS` in the same file.
3. Increment the `version` number in `src/renderer/stores/settingsStore.ts`.
4. Add a UI control in the appropriate `Settings*Tab.tsx` (e.g., `SettingsCesiumTab.tsx`, `SettingsGraphicsTab.tsx`).

**You DO need a custom migration only if:**
- Renaming an existing field (the repair step doesn't migrate values)
- Changing defaults for existing users
- Conditional migration logic

Migration block goes in `settingsStore.ts`:
```typescript
if (version < 7) {
  const oldValue = state.graphics?.oldFieldName ?? 1.0
  state = { ...state, graphics: { ...state.graphics, newFieldName: oldValue } }
}
```

## Step 2 (Global): Five-edit path with Rust bridge

This is the path with the well-known footgun. **Skipping step 4 silently drops the field on save.**

1. Add the field to `GlobalSettings` (or a nested interface) in `src/renderer/types/settings.ts`.
2. Update `DEFAULT_GLOBAL_SETTINGS` in the same file.
3. Add an updater function in `src/renderer/stores/globalSettingsStore.ts` (e.g., `setMyNewField(value)`).
4. **CRITICAL: Update the Rust struct in `src-tauri/src/settings.rs`.**
   - Add the field with snake_case naming (or `#[serde(rename = "camelCaseName")]`).
   - Mark optional fields with `#[serde(default)]` so legacy settings files still load.
   - Match the TS type: `string` → `String`, `number` → `f64` or `i64`, `boolean` → `bool`, optional → `Option<T>`.
5. Add the UI control in the appropriate settings tab (often `SettingsModsTab.tsx`, `SettingsCesiumTab.tsx`, etc.).

After editing, `pnpm run typecheck` (TS) and `cargo check` in `src-tauri/` (Rust) will both surface mistakes, but the silent-drop bug only fails at runtime when a user saves and reloads.

## Step 3: Verify

- Run `pnpm run typecheck` to verify TS-side correctness.
- For global settings, run `cd src-tauri && cargo check` to verify Rust-side correctness.
- For migrations, manually load a settings file from a previous version and verify the new field gets its default.
- Optional: invoke the `tauri-settings-bridge-reviewer` agent to diff the TS interface against the Rust struct.

## Common mistakes to call out

- Forgetting to bump `version` in `settingsStore.ts` after adding a per-browser field — existing users' settings will never get the new default.
- Forgetting `#[serde(default)]` in Rust — legacy settings files fail to deserialize entirely.
- Mismatched serde rename — Rust field exists, but `#[serde(rename = "xxx")]` doesn't match the TS field name, so the field round-trips through `null`.
- Adding the UI control in the wrong tab — when in doubt, check which `Settings*Tab.tsx` other related controls live in.
