# Settings drawer

Status: design agreed, not started. Linear project `Settings drawer`, on the feature branch `feat/settings-drawer`. The seven-tab Settings modal becomes a resizable drawer on the right edge, built from a settings registry and shared row components. Mods moves to its own screen.

## Where it stands

- `SettingsModal.tsx` (297 lines) hosts seven tabs, about 4,700 lines in all: Configuration (1,011), Aircraft & Labels (476), Graphics & Weather (1,042), Controls & Camera (389), Performance (272), Mods (444), Advanced (255). It is a 736 px draggable dialog, `max-height: 80vh`, with a wrapping tab strip; its offset persists in `ui.settingsModalPosition` (`types/settings.ts:1003`).
- About 120 settings. Every section is a `CollapsibleSection`, collapsed by default (`settings/CollapsibleSection.tsx:10`), and the open state is lost when the tab changes.
- Only one shared component exists, `CollapsibleSection`. Every row, slider, toggle and select is hand-written JSX over `ControlsBar.css` classes. Labels, ranges, units, hints and store paths live in the JSX.
- No search, no reset (except imagery adjustments and the aircraft panel position), no marker for "needs restart", no marker for "shared across devices" versus "this device only".
- The Graphics tab drops the backdrop blur and passes pointer events through (`no-blur`, `SettingsModal.tsx:201`), so the scene can be watched while tuning.
- Remote mode replaces Configuration with a notice and hides shared rows one by one in Aircraft & Labels.
- The modal registers on the modal stack, so `isInputBlocked()` (`stores/uiFeedbackStore.ts:54`) blocks every camera shortcut while it is open.
- No tests touch the settings UI beyond `tests/jsxNesting.test.ts`.

## Pain points it fixes

1. Every tab opens as a wall of collapsed headings; finding a setting means opening sections one by one.
2. Expert knobs (shadow depth bias, polygon offset factor and units, camera near plane, log depth buffer, HDR, FXAA) sit beside framerate and MSAA.
3. Misplaced settings: outlines, brightness and tint under Aircraft; Theme under Advanced; replay import/export under Performance; a "UI" section that holds only Aircraft Panel settings; the per-device YAAT Local URL inside the shared Configuration tab; read-only shortcut lists in Controls duplicating `KeyboardCheatsheet.tsx`.
4. One setting with two controls: in-memory tile cache (TC3D-78).
5. Inconsistent controls: three on/off/scope patterns (`.three-way-toggle`, `.button-group`, radios), two Main/Insets patterns, dependent settings sometimes hidden and sometimes disabled, unstyled selects, classes used but never defined (`.setting-row`, `.setting-label`, `.button-group`), inline hex colours, `alert()` for import errors.
6. Uneven units and hints: Leader Line Length has none, percentages shown over stored fractions, defaults written in prose ("Default: 170%").
7. Per-device settings with no control in the modal: `ui.dockRunwayPanel`, `ui.askToContributePositions`.

## Decisions

| Question | Decision |
|---|---|
| Scope | Registry, row primitives and a new information architecture. Custom panels stay hand-written. |
| Container | A drawer docked to the right edge. The scene stays visible and takes the mouse, for every category. |
| Navigation | An icon rail (`lucide-react` icons, tooltips) beside one scrolling page per category; search above both. |
| Width | Resizable by dragging the drawer's left edge; width persisted per device in `settingsStore.ui`, replacing `settingsModalPosition`. Full width on narrow screens. |
| Keyboard | The drawer leaves the modal stack. Camera shortcuts work unless focus is in a drawer control; Escape closes the drawer. |
| Expert knobs | Hidden behind one "Show advanced" switch at the top of the drawer, per device. Search still finds them and offers to reveal. |
| Remote browsers | Shared settings render read-only with a "set on the host" badge, never hidden. |
| Cross-cutting | Search, reset per row and per section, a "changed from default" filter, scope and restart badges, an agent handle. |
| Mods | Its own screen opened from the controls bar. MSFS model sources and cache stay in the drawer. |
| Rollout | Registry and primitives, then the shell, then one category per commit, then the cross-cutting features, then deleting the old code. The app is usable after every commit. |

## Design

### Registry

One `SettingDef` per setting, in `components/UI/settings/registry/<category>.ts`:

- `id` (stable, dotted: `scene.shadows.mapSize`), `label`, `hint`, `keywords`.
- `scope: 'device' | 'shared'`, which picks `settingsStore` or `globalSettingsStore`.
- `get(state)` and `set(actions, value)`: typed accessors over the store slice, never string paths, so the compiler checks every entry. The default is `get(DEFAULT_SETTINGS)` or `get(DEFAULT_GLOBAL_SETTINGS)`, so defaults are never written twice.
- `control`: `toggle`, `slider` (min, max, step, unit, display scale such as fraction-to-percent), `select` (options), `segmented` (options; covers On / Main Only / Off), `text`, or `panel` (a hand-written component, still listed so search finds it).
- `pair`: a Main/Insets pair renders as one row with two controls.
- `restart`, `advanced`, `tauriOnly`, `dependsOn` (a predicate plus the reason shown when the row is disabled; dependent rows are disabled, never hidden).

Each category file exports its sections in order; `registry/index.ts` builds the flat list that search, reset, the agent handle and the export tree read.

### Row primitives

`SettingRow` (label, hint, unit, badges, reset button when changed) wraps `ToggleControl`, `SliderControl`, `SelectControl`, `SegmentedControl`, `TextControl`, `PairControl`. Styles in a new `SettingsDrawer.css` using `global.css` tokens only.

### Shell

`SettingsDrawer.tsx` replaces `SettingsModal.tsx`: rail, search field, advanced switch, the category page with sticky section headers. The open request stays the `settingsOpenRequested` pair on `uiFeedbackStore`. Keyboard: a `settingsFieldFocused` flag (set on focus-in, cleared on focus-out within the drawer) joins `isInputBlocked()` in place of the modal-stack entry. The graphics backend and Main MSAA restart dialog moves into the shell.

### Information architecture

- General: theme, auto-switch to nearest airport, aircraft panel (show, dock side, reset position, runway panel dock), updates, repair settings, import/export.
- Connections: Cesium token, imagery provider and adjustments, traffic source, RealTraffic, vNAS (YAAT Local URL with a device badge), remote browser server.
- Traffic & Labels: visibility, display limits (max aircraft, data radius), datablocks, inset datablocks.
- Aircraft Models: orientation, brightness, tint, outlines, MSFS models panel.
- Scene: quality, terrain and buildings, lighting, shadows, post-processing.
- Weather: METAR, fog, clouds, precipitation, lightning.
- Camera & Input: FOV, sensitivity, orbit lag, an invert-axes table; the shortcut lists become a link to the cheatsheet.
- Storage & Replay: one tile-cache control, disk cache, clear terrain cache, replay buffer, replay import/export.
- Developer: debug logs, coordinate overlay, diagnostics import and clear.

### Mods screen

`SettingsModsTab.tsx` becomes `ModsModal.tsx`, opened from a controls-bar button, on the modal stack like any modal. The tower Position button still hands off to the positioning wizard.

### Agent handle

`window.__tc3d.settings` in dev builds: `list()` (ids, labels, scope, current values), `get(id)`, `set(id, value)` validated against the control's range or options, `reset(id)`. Type in `types/harness.ts`.

## Steps

Each step is one issue and one commit on `feat/settings-drawer`.

1. TC3D-76: add `lucide-react` (1.51.0 is current; peer `react ^19` is covered). Registry types, row primitives, `SettingsDrawer.css`. Tests: every id unique; every default inside its range and options; primitives show reset only when changed and reset writes the default.
2. TC3D-79: drawer shell with rail, resize and keyboard rules, hosting the old tab bodies under a temporary rail. Settings migration: drop `settingsModalPosition`, add the drawer width and the advanced switch.
3. TC3D-80: the Mods screen.
4. TC3D-81 to TC3D-89: one per category (General, Connections, Traffic & Labels, Aircraft Models, Scene, Weather, Camera & Input, Storage & Replay, Developer), each moving its rows to the registry and deleting the migrated JSX. Storage & Replay (TC3D-88) removes the duplicate tile-cache control unless TC3D-78 fixed it on `main` first.
5. TC3D-90: search and the changed-from-default filter.
6. TC3D-91: the advanced switch, scope and restart badges, remote read-only.
7. TC3D-92: the agent handle.
8. TC3D-93: `SettingsTreeBuilder` reads the registry; delete the old tabs, `SettingsModal.tsx`, `CollapsibleSection` if unused and the dead `ControlsBar.css` classes.
9. TC3D-94: docs: `docs/architecture.md` Settings section (with TC3D-77), CLAUDE.md "Adding a New Setting" and the `add-setting` skill (a new setting is a registry entry), USER_GUIDE, `docs/testing/keyboard-nav.md`, CHANGELOG, glossary entries for registry, drawer and rail.

## Risks

- The feature branch lives through about 17 commits while `main` keeps changing the same tabs (new settings, fixes such as TC3D-78). Rebase it onto `main` between steps, and port any setting added on `main` into the registry when its category migrates.
- A slider with focus takes arrow keys; the focus rule must cover range inputs and selects, or arrows move both the slider and the camera.
- The drawer covers the right part of the scene; the Babylon label layer and the aircraft panel when docked right need checking against it.
