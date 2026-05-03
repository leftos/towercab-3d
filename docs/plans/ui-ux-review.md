# TowerCab 3D — UI/UX Review & Improvement Plan

This document captures findings from a UI/UX review of TowerCab 3D across three contexts (Tauri desktop, remote browser, touch devices) and breaks them into actionable phases for implementation.

## Source review summary

The app is **functional and clearly shipped under pressure**. Touch/responsive coverage is thorough. But:

- Visual identity is generic ("rgba(20,20,30,0.95) on cyan everywhere") with no shared design tokens.
- First-impressions (Cesium token prompt, loading screen) underdeliver for the product's sophistication.
- Power-user features (keyboard shortcuts, `.NN` command grammar, globe gestures) have no discoverable surface.
- Touch is well-retrofitted but still feels like a port — pinch-to-zoom support is unsignaled, joystick blocks the globe, no onboarding for tablet users.

This plan is organized so each phase can be implemented and shipped independently. Phase 1 unblocks every subsequent phase.

---

## Phase 1: Design token layer (foundation) — ✅ COMPLETE

**Goal:** Eliminate hardcoded color/spacing literals scattered across 40+ CSS files. Unblocks every subsequent visual change.

**Estimated effort:** 0.5 day (actual: ~1 day across 11 commits)

### Tasks

- [x] Add `:root` CSS custom properties to `src/renderer/assets/styles/global.css`:
  - Backgrounds: `--bg-app`, `--bg-panel`, `--bg-panel-strong`, `--bg-overlay`
  - White-alpha steps (borders/hover/subtle bg): `--white-a05`, `--white-a08`, `--white-a10`, `--white-a15`, `--white-a20`, `--white-a30`
  - Text: `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-muted`
  - Accents: `--accent` (#4fc3f7), `--accent-warn` (#ffb74d), `--accent-danger` (#ef5350), `--accent-ok` (#81c784), `--accent-pending` (#fff176)
  - Layout: `--topbar-h`, `--topbar-h-compact`, `--topbar-h-mobile`, `--controls-h`, `--controls-h-compact`
  - Radii: `--radius-sm`, `--radius-md`, `--radius-lg`
  - Effects: `--blur`, `--blur-strong`
  - Fonts: `--font-sans`, `--font-mono`
- [x] Migrate `TopBar.css`, `ControlsBar.css`, `AircraftPanel.css` to consume the tokens (commit `226a9e4`)
- [x] Extract inline `<style>` block in `App.tsx:690-779` into `TokenPrompt.tsx` + `TokenPrompt.css` (commit `6c206c7`)
- [x] Resolve cyan inconsistency in `TouchControls.css` and `DeviceOptimizationPrompt.css` + rename FSLTL orphan vars (commit `9e125be`)
- [x] Migrate modal/dialog group: 8 files (commit `855c936`)
- [x] Migrate indicator/status group: 6 files (commit `8a07802`)
- [x] Migrate tools/overlay group: 12 files (commit `f9f6779`)
- [x] Replace magic-number `top: 58px` in `AircraftPanel.css:2` with `calc(var(--topbar-h) + 10px)` (part of `226a9e4`)
- [x] Extract two additional inline `<style>` blocks discovered mid-work: `SettingsModsTab.tsx` and `TowerPositioningOverlay.tsx` (commit `8d30346`)
- [x] Document the convention in `CLAUDE.md` (commit `0bc9f28`)
- [x] Final grep sweep: zero `#4fc3f7` / `rgba(0, 200, 255` / `rgba(20, 20, 30, 0.95)` / `rgba(30, 30, 40, 0.98)` literals outside `:root`; zero `<style>` blocks in any `.tsx`
- [x] Side fix: `vite.config.ts` excludes `@babylonjs/core` from esbuild pre-bundling so dev mode boots (commit `1ab5bcc`)

### Out of scope for this phase

- Light/high-contrast themes (tokens enable this later but don't ship them yet)
- Color palette changes — current values preserved exactly

---

## Phase 2: Discoverability (highest user-facing leverage)

**Goal:** Surface the power-user features that currently require reading docs.

**Estimated effort:** 1-2 days

### Background

The following features have no discoverable surface:

- `Ctrl+0–9` quick-load bookmarks (`App.tsx:559-575`)
- `F1` performance HUD, `F3` model matching, `F4` timeline debug (`App.tsx:547-555`)
- `Ctrl+M` METAR overlay (`App.tsx:556-558`)
- `.NN` load-bookmark, `.NN.` save-bookmark, `.NN.NAME.` save-named-bookmark — only documented inside `TouchControls.tsx:173-183`
- Globe gestures (right-click, shift+drag, middle-mouse) — undocumented in-app

### Tasks

- [x] Build a `?`-key cheatsheet overlay component (`KeyboardCheatsheet.tsx`)
  - Lists every keyboard shortcut with action description
  - Documents `.NN` command grammar with examples
  - Documents globe gestures (mouse + touch)
  - Triggered by `?` key, dismissible by `Esc` or click-outside
  - Search/filter input at top for quick lookup
- [x] Add `?` button to TopBar (right side) that opens the cheatsheet
- [x] Add tooltips with keyboard shortcut hints to ControlsBar buttons (currently buttons hide their label below 1200px in `ControlsBar.css:1242-1244` with no tooltip fallback — users see only icons)
- [x] Add empty-state hint to CommandInput: "Type `.` for commands · Press `?` for help"
- [x] First-launch toast: "Press `?` to see keyboard shortcuts" (one-time, dismissible, stored in settings)
- [x] Bind `Ctrl+,` to open Settings (added during tooltip work — fills idiomatic gap)

### Out of scope for this phase

- Full guided tour / coachmark walkthrough (deferred to Phase 5)
- Customizable shortcuts

---

## Phase 3: First-run & loading polish

**Goal:** Make the first 30 seconds of the app feel like the rest of it.

**Estimated effort:** 1 day

### Background

- The Cesium token prompt is the literal first-run experience and is implemented as inline CSS-in-JSX (`App.tsx:690-779`). The "Skip for now" and "Save Token" buttons have no visual weight differentiation despite vastly different consequences (skipping = broken app).
- "Create a free Cesium Ion account" and "Go to Access Tokens" are `<button>` elements styled as links inside `<li>` — confusing on touch.
- The loading screen (`LoadingScreen.css`) is generic; misses an aviation identity moment.

### Tasks

- [ ] Redesign `TokenPrompt.tsx` (extracted in Phase 1):
  - Strong primary CTA, de-emphasized "Skip" with warning subtext ("App will not function without a token")
  - Replace styled-button-as-link pattern with proper `<a>` elements that open externally via `shellApi.openExternal`
  - Inline validation: "✓ Token validated" or "✗ Invalid token" after Save
  - Touch-friendly button sizes (min 44px)
- [ ] Polish `LoadingScreen.tsx`:
  - Add subtle aviation motif behind logo (compass rose, runway numbering, or radar sweep — pick one)
  - "This is taking longer than usual…" hint after 10s on stalled steps
  - Respect `prefers-reduced-motion` — disable shimmer animation
- [ ] Verify token-prompt and loading-screen contrast/sizing on iPad portrait/landscape

### Out of scope for this phase

- Full ATIS-letter style step labels (cute but optional)
- Replacing the logo

---

## Phase 4: Touch experience upgrade

**Goal:** Make tablet usage first-class instead of "desktop UI on a smaller screen."

**Estimated effort:** 2-3 days

### Background

The touch retrofit is solid (virtual joystick with proper dead zone in `TouchControls.tsx:204`, 52px zoom buttons clearing iOS minimums, enlarged resize handles via `@media (pointer: coarse)` in `AircraftPanel.css:693-731`, the `DeviceOptimizationPrompt` on first touch-device load). But:

- Pinch-to-zoom support is **unsignaled** — touch users will instinctively try it; if it works (likely via Cesium), they need to know; if it doesn't, that's a major gap.
- The joystick is permanently positioned at `bottom: 80px; left: 20px` (`TouchControls.css:36-41`), overlaying the apron/threshold area users want to see.
- Two-finger pan vs orbit isn't documented anywhere visible.
- The `−` zoom button stroke (`TouchControls.tsx:391-394`) doesn't visually match the `+` button.
- `controls-center` (follow status) is hidden below 800px (`ControlsBar.css:1333-1335`) — primary feedback disappears on iPad portrait.
- The 736px-wide settings modal supports drag-to-reposition (`SettingsModal.tsx:33-100`), which is irrelevant and possibly annoying on touch.

### Tasks

- [ ] Verify Cesium pinch-to-zoom and two-finger orbit/pan behavior; document expected behavior in CLAUDE.md
- [ ] Add a one-time touch onboarding sequence after `DeviceOptimizationPrompt` accepts:
  - Step 1: "Pinch to zoom" with animated demo
  - Step 2: "Two-finger drag to orbit" with animated demo
  - Step 3: Point at the joystick + command button + airport selector
  - Stored as completed in settings; never shown again
- [ ] Make joystick draggable to a stash position; remember position in settings
- [ ] Match `−` button visual weight to `+` (same stroke width, same line length) in `TouchControls.tsx`
- [ ] Add long-press-to-look-at gesture on aircraft list items (replaces missing right-click on touch)
- [ ] Disable settings modal drag handle on `pointer: coarse` to prevent accidental repositioning
- [ ] Restore at least the follow indicator dot (not full status) at < 800px breakpoint

### Out of scope for this phase

- Full d-pad alternative for very small screens (<500px)
- Per-app touch sensitivity calibration

---

## Phase 5: Tablet-specific layout

**Goal:** Add a dedicated tablet breakpoint so iPads don't get "compact desktop" treatment.

**Estimated effort:** 1-2 days

### Background

Current responsive breakpoints (`ControlsBar.css:1218-1369`) are: 1199px → hide labels, 1049px → hide camera info, 799px → hide center, 499px → phone mode. Real iPads in landscape (1024-1366px) fall into the "compact desktop" zone but should be treated as a distinct context.

The `AircraftPanel` at fixed `top: 58px; right: 10px` covers ~30% of the visible airport on iPad landscape, with no minimize-to-edge gesture beyond the collapse button.

### Tasks

- [ ] Define a new `--tablet` breakpoint range (900-1100px) in CSS
- [ ] Auto-narrow `AircraftPanel` to ~280px in tablet range
- [ ] Add edge-dock collapse mode for `AircraftPanel`: a vertical strip on the right edge with icon + count, tap to expand
- [ ] Optional: drag-to-reposition for `AircraftPanel` (resize handles already exist at `AircraftPanel.css:602-731`, drag handle is incremental)
- [ ] Restore airport name display below 600px (currently `display: none` at `TopBar.css:238-240`) — too aggressive, even ICAO + truncated name fits

### Out of scope for this phase

- Multi-viewport layout changes for tablet (keep current behavior)
- Reflowable AircraftPanel that re-docks based on follow state

---

## Phase 6: Motion & accessibility hygiene

**Goal:** Polish the long-session experience and basic accessibility.

**Estimated effort:** 0.5 day

### Tasks

- [ ] Audit all animations for `prefers-reduced-motion: reduce` support; currently zero handlers exist. Affected animations:
  - `pulse-orange` (`ControlsBar.css:588-596`)
  - `pulse-live` (`ControlsBar.css:830-840`)
  - `shimmer` (`LoadingScreen.css:42-49`)
  - `dropdownSlideUp` (`ControlsBar.css:1057-1066`)
  - `slideDown` (`ControlsBar.css:842-851`)
  - `fadeIn`, `slideUp` (`global.css:94-112`)
- [ ] Reconsider `:focus { outline: none }` blanket rule in `global.css:67-69`; restrict outline removal to mouse interactions only, keep `:focus-visible` styling intact
- [ ] Add explicit comment in `global.css` noting the app is intentionally dark-only (no `prefers-color-scheme` support) so future contributors don't accidentally add light-theme partials
- [ ] Verify keyboard-only navigation through TopBar → ControlsBar → AircraftPanel works without traps

### Out of scope for this phase

- Full WCAG 2.2 audit
- Light theme

---

## Phase 7: Aesthetic identity (optional, larger scope)

**Goal:** Give the app a distinctive visual point of view beyond "competent dark UI."

**Estimated effort:** 2-3 days

This phase is **optional** and should only be undertaken after Phases 1-6 ship and stabilize. It is the highest risk for breaking trust with existing users via gratuitous change.

### Tasks (pick selectively)

- [ ] Typography upgrade: pair a distinctive sans (Geist / General Sans / Söhne) with a high-quality monospace (JetBrains Mono / Berkeley Mono / IBM Plex Mono). Already half-using JetBrains Mono in `AircraftPanel.css:772` — commit fully.
- [ ] Aviation-specific accent calibration: shift secondary accent from generic MUI orange to a calibrated taxiway-light amber, or runway-edge-light white-amber
- [ ] Subtle background texture/atmosphere on panels (very low opacity grain or scanline) to feel less "Tailwind default"
- [ ] Reconsider 12px panel radius — current rounding is "modern web app"; aviation tools tend toward sharper edges

### Out of scope for this phase

- Full rebrand
- Logo redesign
- Color theme variants

---

## Implementation notes

- **Phase 1 must ship first.** Every other phase references the design tokens. ✅ shipped.
- Phases 2, 3, 4, 5, 6 are independent of each other after Phase 1.
- Phase 7 is optional and gated on user feedback after the functional improvements ship.
- Each phase is small enough to ship as a single PR (or a small handful of slices). Do not bundle phases.
- All file paths in this doc are absolute references that should still be valid; verify before editing.
- This review explicitly did NOT cover: VR mode (`VRScene.css`), settings tabs internals (`SettingsAdvancedTab` etc.), modding system UI (`MSFSModelSettingsPanel`), or replay controls polish — these may need separate reviews.

## Kickoff prompts for re-planning each remaining phase

Hand any of these to a planning agent (`/plan` or the `Plan` subagent) to generate a detailed execution plan for that phase. Each prompt is self-contained.

**Phase 2 — Discoverability:** *"Plan Phase 2 of `docs/plans/ui-ux-review.md`. Audit `App.tsx` and `useCameraInput.ts` for the full keyboard shortcut list. Inventory current uses of `title=` attributes on ControlsBar buttons. Decide whether to use a Portal-based modal or an inline fullscreen overlay for the cheatsheet. Plan the toast persistence storage (settings flag or localStorage)."*

**Phase 3 — First-run & loading polish:** *"Plan Phase 3 of `docs/plans/ui-ux-review.md`. The `TokenPrompt` component already exists (Phase 1, slice 2) — read it. Decide on the validation approach: client-side regex check, or async hit to Cesium Ion `/v1/me` endpoint? Pick one aviation motif (compass rose / runway numbering / radar sweep) — bias toward the simplest SVG."*

**Phase 4 — Touch experience upgrade:** *"Plan Phase 4 of `docs/plans/ui-ux-review.md`. First action: verify what gestures Cesium's `ScreenSpaceEventHandler` actually responds to on touch — look at `CesiumViewer.tsx` and Cesium docs via Context7. Decide whether the touch onboarding sequence should be a modal series, a coachmark overlay, or a side-swipeable carousel."*

**Phase 5 — Tablet-specific layout:** *"Plan Phase 5 of `docs/plans/ui-ux-review.md`. Audit current responsive behaviour at 1024×768 (iPad portrait) and 1366×1024 (iPad Pro landscape). Decide whether the edge-dock should use `position: fixed` strip or transform-based slide. Confirm whether `AircraftPanel`'s width is currently controlled by inline style (per `AircraftPanel.css:7` comment)."*

**Phase 6 — Motion & accessibility hygiene:** *"Plan Phase 6 of `docs/plans/ui-ux-review.md`. List all `@keyframes` and `animation:` declarations across the codebase. Decide between disabling animations (`animation: none`) or shortening them to instant transitions for reduced-motion users. Plan a manual keyboard navigation test script."*

**Phase 7 — Aesthetic identity (optional):** *"Plan Phase 7 of `docs/plans/ui-ux-review.md`. Confirm with user: (a) which typeface pairing? (b) self-host or CDN? Tauri prefers self-hosted. Audit how many `font-family` declarations the new `--font-sans` token needs to flow through. Pick the smallest possible aesthetic change set — this phase has highest risk for breaking existing-user trust."*

## References

- Source review captured in conversation on 2026-05-02
- Reviewed files: `App.tsx`, `global.css`, `TopBar.css`, `ControlsBar.css`, `AircraftPanel.css`, `TouchControls.tsx/.css`, `LoadingScreen.css`, `MoreMenu.css`, `SettingsModal.tsx`, `DeviceOptimizationPrompt.css`, `SettingsTreeView.css`
