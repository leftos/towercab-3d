# Keyboard Navigation Test Script

A manual procedure for verifying keyboard-only navigation works without focus traps or unreachable controls. Run before any UI release; rerun after touching `App.tsx`, `TopBar.tsx`, `ControlsBar.tsx`, `AircraftPanel.tsx`, or any modal component.

## Setup

1. `pnpm run vite:dev` (or launch the desktop app via `pnpm run dev`).
2. Dismiss the Cesium token prompt with the **Skip for now** button (mouse) so the airport list loads.
3. Pick any airport from the selector. Wait for the loading screen to clear.
4. Click somewhere harmless (e.g. an empty area of the topbar) so focus is reset, then **press Tab once** to enter the focusable surface.

You should see a 2 px cyan accent outline on the first focusable control. If you do not, the `:focus-visible` rule has regressed — check `src/renderer/assets/styles/global.css`.

## Pass 1 — TopBar

Tab forward. Expected order:

1. Airport button (ICAO + airport name).
2. Help button (`?` icon).
3. vNAS indicator button (only if vNAS feature is built in).
4. Remote clients indicator (only if remote browsers are connected).

Each step must show the focus outline. Press `Enter` on the airport button — the airport selector modal opens. Press `Escape` — the modal closes and focus returns to a sensible spot (no requirement for full focus restoration in this phase).

Press `Shift+Tab` repeatedly from any TopBar element — it must walk back through earlier elements without skipping or trapping.

## Pass 2 — ControlsBar

Continue tabbing forward from TopBar. Expected order through controls-left:

1. View mode toggle (`3D` / `2D`).
2. Defaults dropdown button.
3. Look-at-runway dropdown button.
4. Global search panel input (only on widths above the mobile breakpoint).
5. Measuring tool button.
6. Bookmark manager button (hidden below mobile breakpoint).
7. Add inset viewport button (hidden below mobile breakpoint).
8. VR button.
9. Settings button.
10. Exit airport button.

Verify each `<button>` is reachable and shows the focus outline. Press `Enter` or `Space` on the Defaults dropdown — the menu opens.

**Known gap (do not fix here):** the dropdown items are not arrow-key navigable. Tab does not move into the open dropdown. Confirm this matches expectation; do not block on it.

Press `Escape` from inside an open dropdown — the dropdown closes (via outside-click logic).

## Pass 3 — AircraftPanel

Continue tabbing. Expected order:

1. Search input (text field).
2. Filter buttons ("Visible", airport filter).
3. Sort `<select>` — press the down-arrow to confirm options cycle through Smart / Distance (Airport) / Distance (Camera) / Callsign / Altitude / Speed.
4. Follow-mode toggle button (Tower / Orbit).
5. Stop-following button (only when actively following).
6. First aircraft row (renders as `<button type="button">`).
7. Nested follow-toggle button inside the aircraft row.
8. Next aircraft row, and so on.

Press `Enter` on an aircraft row — the camera should look at that aircraft. The nested follow-toggle button must still be reachable via Tab without being swallowed by its parent button.

## Pass 4 — Modals

For each modal, confirm: open via shortcut → focus is sensible inside → Escape closes the modal.

| Modal | Open with | Expected close behaviour |
|-------|-----------|--------------------------|
| KeyboardCheatsheet | `?` | Escape closes (handler at `KeyboardCheatsheet.tsx`). Search input auto-focuses on open. |
| SettingsModal | `Ctrl+,` | Escape closes. Tabs are reachable via Tab. |
| AirportSelector | Click airport button or `Enter` on airport button | Escape or click-outside closes. Search input auto-focuses. |
| BookmarkManager | `Ctrl+B` | Input auto-focuses. `Enter` saves; `Escape` closes. |
| TokenPrompt | First launch only (or clear `globalSettings.cesiumIonAccessToken`) | **Known gap — no Escape handler.** Clicking "Skip for now" or "Save Token" closes. |

**Known gap (do not fix here):** modals do not implement focus traps. Tab past the last element will escape into the page background. Note any drift but do not block on it.

## Pass 5 — Shortcut blocking

Open any modal (e.g. press `?` to open KeyboardCheatsheet). With the modal still open, press:

- `?` — must not re-open the cheatsheet or stack a second modal.
- `Ctrl+M` — must not toggle the METAR overlay.
- `Ctrl+0`–`Ctrl+9` — must not jump to bookmarks.

These shortcuts are gated by `useUIFeedbackStore.isInputBlocked()` in `App.tsx:545-599`. If any shortcut fires while a modal is open, the gate has regressed.

Also test: focus the search input inside `AircraftPanel`, type a normal character (`a`). It must appear in the input, not trigger the runway-look-at action keyed to the same letter.

## Pass 6 — Reduced motion

In Chrome DevTools → Rendering → "Emulate CSS media feature prefers-reduced-motion" → set to `reduce`. Reload the page. Confirm:

- Loading screen compass is static (no rotation).
- Loading progress bar shows no shimmer.
- Live data indicator dot does not pulse.
- Follow indicator dot does not pulse.
- Dropdown menus appear instantly with no slide.
- Keyboard cheatsheet appears instantly with no fade.

Toggle the setting back to "no preference" — animations resume.

## Playwright regression script

The same Tab walkthrough can be scripted via the Playwright MCP for regression purposes. Outline:

1. `mcp__playwright__browser_navigate` to `http://localhost:5173`, then `mcp__playwright__browser_click` "Skip for now".
2. Pick an airport with `mcp__playwright__browser_click`, wait for `mcp__playwright__browser_wait_for` an aircraft-list element.
3. Loop: `mcp__playwright__browser_press_key Tab`, then `mcp__playwright__browser_evaluate` returning `document.activeElement?.tagName + " " + document.activeElement?.className + " " + (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 40))`.
4. Compare the captured sequence against the expected order above.

For reduced-motion verification: `mcp__playwright__browser_run_code_unsafe` with `await page.emulateMedia({ reducedMotion: 'reduce' })`, reload, then evaluate `getComputedStyle(document.querySelector('.follow-indicator-dot')).animationDuration` — expect `0.01ms`.

## Known follow-up gaps

These are documented here so they are not lost; they are out of scope for the current motion / accessibility hygiene pass.

- ControlsBar dropdowns (Defaults, Look-at-Runway) are not arrow-key navigable.
- Modals do not trap focus; Tab past the last element escapes into the background.
- Modals do not restore focus to the previously focused element on close.
- TokenPrompt has no Escape handler.
- No semantic landmarks (`<header>`, `<main>`, `<aside>`) — screen readers cannot navigate by region.
- `AircraftPanel` resize handles are pointer-only (no keyboard equivalent).
