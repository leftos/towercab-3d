# TowerCab 3D driving conventions

These are the rules for letting an agent drive the running TowerCab 3D app. Agents drive it through three third-party `@playwright/mcp` servers declared in `.mcp.json`: `tauri-app` attaches to the desktop app's WebView2 over CDP (port 9222), `playwright` launches Edge against the Vite frontend alone, and `playwright-headless` runs headless Edge against `pnpm run vite:headless`, whose dev server answers `/api/*` itself.

Inside the page they call the dev-only `window.__tc3d` hook, installed by `src/renderer/hooks/useAgentHarness.ts` and typed in `src/renderer/types/harness.ts`.

The launch recipe, the hook's calls and the standing driving notes live in `CLAUDE.md`, section "E2E testing via Playwright MCP"; this file holds the lessons behind them.

The comment under each heading (`<!-- rule: slug -->`, with `scope: project` when the rule means nothing outside this repo) is the rule's identity for the user-level `conventions-sync` skill, which trades driving lessons with the owner's other projects. A rule that describes something this repo does not do yet says so, and its work is in the plan.

This repo declines the whole Server plumbing section, because it builds no MCP server of its own; it also declines the rules about OS-level input (all its input is Playwright's CDP input) and those about hooks that are injected per run, served over a pipe or socket, or answer through a request dispatcher, because its hook is compiled into dev builds and called through CDP evaluate.

## Driving an app

### Drive the app from inside its webview
<!-- rule: drive-owned-app-in-process -->

Driving a desktop app from outside its process brings the window forward or moves the cursor: a survey in another project found no desktop-automation MCP server that drives from outside and fully avoids stealing focus, while the ones that never do run a hook inside the app.

TowerCab 3D is driven from inside: the `tauri-app` server attaches to the app's WebView2 over CDP, input is dispatched to the page through CDP rather than through the OS cursor and keyboard, and state is read and set through the dev-only `window.__tc3d` hook from `browser_evaluate`. An app started without the debugging port cannot be attached; relaunch it with the port (see launch-isolated-lifecycle) rather than reaching for OS-level automation. A third-party app a check needs beside it (CRC, for vNAS work) is driven through its own startup hook the same way (see fenced-hook-for-third-party-app). The route is chosen per process by whether its hook answers.

The one check worth making outside the hook is on the app's own output: the unified log file (see unified-log-tail) is read from the shell, which still works while the page is paused in a debugger or before the hook has installed.
Source: .mcp.json:7-10; src/renderer/hooks/useAgentHarness.ts:32-84; src-tauri/src/lib.rs:789-797; CLAUDE.md:31-34; a survey of desktop-automation MCP servers in another project. Seen: 0 here (seeded from yaat).

### Attach to the real app, and know what a frontend-only browser cannot see
<!-- rule: real-app-over-frontend-only -->

Drive the desktop app itself (WebView2 over CDP) for anything that touches the backend; a plain browser pointed at the dev frontend is a different app.

In towercab-3d the frontend-only server gets the SPA's HTML for every `/api/*` request, so mods, tower positions, METAR and saved global settings are missing and the Cesium token lasts only until reload; worse, a plain browser counts as remote mode (`isRemoteMode()`), so the app waits for a host and never polls VATSIM, and no aircraft appear until polling is started by hand from `browser_evaluate`.

The no-polling fact reached CLAUDE.md (commit 46a4598, 2026-10-02) five months after the frontend-only route was first documented (commit 66062dd, 2026-05-02), in the commit that fixed a bug found while driving. Write down, per driving route, exactly which subsystems are absent, so a run that "shows nothing" is not mistaken for a bug. CLAUDE.md "E2E testing via Playwright MCP" holds that list for each of the three routes here (`playwright-headless` has no host WebSockets or aircraft feed; `playwright` lacks every `/api/*`).

TowerCab has no UI Automation route. Measured in another project, one would return none of the app's errors with the call (read its log instead), could not fill a native file picker, would reach only the app's own windows with posted input and no cloaked window, and would see nothing drawn on the WebGL canvas.
Source: CLAUDE.md:29-40; .mcp.json:3-10; commits 0275468 (tauri-app server added), 46a4598 (remote-mode/no-polling note). Seen: twice (Wave 1 run moved to the real app; TC3D-5 fix).

### Run render-only checks headless against the dev server's `/api/*`, and keep the ion token out of the transcript
<!-- rule: headless-first-render-checks scope: project -->

A check that needs only the rendered scene runs in the `playwright-headless` server against `pnpm run vite:headless` (port 5174), which opens no window on the user's desktop and answers `/api/*` with the dev build's settings, mods and METAR. Use `tauri-app` only for what needs the real app: the Rust backend, host WebSockets, the tray, native dialogs. The headless page shows the host disconnected and drops writes.

The browser never holds the Cesium ion token (a placeholder plus a dev-server forwarder), and the agent never reads or prints the token, the Google Maps key or the settings file: no `/api/global-settings` read, no unfiltered network listing; `/api/dev-health` says whether a token is loaded. The recipe, defaults and the full list are in `CLAUDE.md`, section "E2E testing via Playwright MCP".
Source: CLAUDE.md "E2E testing via Playwright MCP"; scripts/dev/devApi.ts; .mcp.json. Seen: documented.

### Launch in the background with the debug port, start when the hook answers, and stop what you started
<!-- rule: launch-isolated-lifecycle -->

The agent may start the dev app itself, in the background, with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'` (`pnpm --dir <tree> run dev -- --agent`, or `pnpm run dev:vnas -- --agent` the same way), and must stop it when finished. Name the tree with `--dir`: a Bash or PowerShell tool shell's working folder resets to the main checkout between calls, which once launched the main checkout's app instead of the worktree's.

Before this, app checks were listed in the plan as "Human: the user runs pnpm run dev"; the CDP attach turned them into agent-run "App check (tauri-app MCP)" lines. The app is ready when `window.__tc3d` exists on the attached page (the hook installs once the Cesium viewer exists), not when the process starts.

The app is single-instance, so a second launch only focuses the first window, and the debugging port is fixed: one driving agent at a time, and an app the user already had running is left alone. Isolated app data is not met yet: the dev build's own identifier (`com.towercab.viewer.dev`) keeps it apart from an installed release, but a driven run reads and writes the developer's own dev settings, bookmarks and WebView2 storage.

The rule is to point the app's data folder at a scratch folder through an environment variable the app honours, and to write what the session needs into that folder's settings before the launch, so the developer's own data stays untouched.

A stop has two traps. `CloseMainWindow()` cannot find a hidden window, so close a hidden agent app with `PostMessage(hwnd, WM_CLOSE)` or stop its process tree. And without `--agent` the window-state plugin saves the window's visible flag, so closing a window hidden with `SW_HIDE` makes the next launch start hidden: show it (`SW_SHOWNOACTIVATE`) before closing. With `--agent` no show step is needed, since the plugin does not save that window (see hidden-window-keeps-rendering).
Source: CLAUDE.md:31-35, CLAUDE.md:109; .claude/skills/towercab-3d-nextup/SKILL.md:35; commit b39260a (plan wave lines rewritten from "Human:" to "App check"); src/renderer/hooks/useAgentHarness.ts:29-30; src-tauri/src/lib.rs:857-863; src-tauri/tauri.dev.conf.json:4; src-tauri/src/settings.rs:589. Seen: documented.

### Build before launch, and build before stopping on a restart
<!-- rule: build-before-launch -->

A launch builds what is stale before the app starts, and a red build refuses the launch. `pnpm run dev` does this for a launch: `scripts/shipping/build/dev-wrapper.js` rebuilds the frontend when a file under `src/renderer` or a build config is newer than `dist/index.html` (or the build mode changed), builds the model converter when it is missing, and exits non-zero on a failed build; `tauri dev` then compiles the Rust side before it opens a window.

A restart is not covered yet: the documented route stops the app and runs `pnpm run dev` again, so a red build leaves no app running at all. The rule is build first, then stop, then launch, so a red build leaves the old app running and its errors are read while it still runs.
Source: scripts/shipping/build/dev-wrapper.js:41-77, 132-174; CLAUDE.md:31-34; another project's decision record and changelog fixes. Seen: 0 here (seeded from godot-mcp).

### Start the app quiet and out of the user's way, set at window creation
<!-- rule: quiet-by-default -->

A default driving run should be unfocused, out of sight, silent and frame-capped, with a visible run only when the user wants to watch. This is met for agent runs: `pnpm run dev -- --agent` creates the window hidden and unfocused and keeps it frame-capped (see hidden-window-keeps-rendering). Sound is not handled yet.

Without `--agent`, `pnpm run dev` opens the window visible and focused on the user's desktop at 1600x900 (the `windows` entry in `src-tauri/tauri.conf.json` sets neither `focus` nor `visible`, and the window-state plugin restores the saved window with `show()` then `set_focus()`), so a visible run still starts with "hands off".

`--agent` adds `--config src-tauri/tauri.agent.conf.json` (the window entry with `visible: false, focus: false`; Tauri merges `--config` files in order) and sets `TC3D_AGENT_RUN=1`, which in debug builds keeps the window-state plugin off the main window (`window_state_plugin()` in `src-tauri/src/lib.rs`).

Each part has to be set when the window is created, because later is too late: measured in another project, Windows shows a new window about 0.9 s after start, before any app code runs, and clamps an off-screen initial position onto the primary screen, and un-focusing a window created focused did not give the focus back.

Showing a window without activating it still leaves it activatable: when the window in front of it is minimised, Windows hands the foreground to the next window in Z order, which can be the app, and only the `WS_EX_NOACTIVATE` style stops that; a window launched from a process that holds the foreground right (an agent's shell under the user's focused app) also paints above every window, so it goes to the bottom of the Z order before its first show.

Turn sound off through the platform rather than the app's own mute, so the mute stays testable and nothing leaks into saved settings, and cap the frame rate: a hidden window in another project kept VSync and drew at the monitor's 239 Hz. Out of sight must still render; the host already passes `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows` among its WebView2 flags.
Source: src-tauri/tauri.conf.json:13-23; src-tauri/src/lib.rs:777-778; CLAUDE.md:31, 53; other projects' decision records and window timings measured with a 5 ms poller; Windows docs for WS_EX_NOACTIVATE. Seen: 0 here (seeded from godot-mcp, yaat).

### A hidden desktop window keeps rendering: launch with --agent and drive it over CDP
<!-- rule: hidden-window-keeps-rendering scope: project -->

The desktop dev app keeps drawing at its frame cap (60 fps measured; `__tc3d.perf().window.frameInterval` median about 17 ms) while its window is hidden: created hidden by `--agent`, hidden with `ShowWindow(hwnd, SW_HIDE)`, minimized, moved off-screen past every monitor, or covered.

Recipe: launch with `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; pnpm --dir <tree> run dev -- --agent`, drive over CDP and never call `page.bringToFront()`. Measured over 4023 samples at 10 ms from launch to the end of the run, the window was never visible and never foreground; `frameInterval` median 16.70 ms, p95 17.10 at KOAK; CDP screenshots and input worked; the saved `.window-state.json` was byte-identical afterwards. Close it with `PostMessage(hwnd, WM_CLOSE)` or by stopping its process tree: `CloseMainWindow()` cannot find a hidden window. No show-before-close step is needed.

The rest of this rule is for hiding a window launched without `--agent`.

`document.visibilityState` stays `visible`, 100 ms timers keep pace, and CDP screenshots and CDP input (click, Escape) work without showing or focusing the window. No extra WebView2 flag is needed: the app already passes `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows` (`src-tauri/src/lib.rs:777-778`) and wry never tells WebView2 the window is hidden; `--disable-features=CalculateNativeWinOcclusion` made no difference.

Use `SW_HIDE` (0): it is the only state with nothing on screen and no taskbar button. Recipe without `--agent`:
1. Check ports 9222 and 5173 are free.
2. Start a background poller (PowerShell) that finds the app's window and sends `ShowWindow(hwnd, SW_HIDE)` the moment it is visible. Find it by process, not by title alone: take the processes whose `Path` is under this tree's `src-tauri\target\`, enumerate the top-level windows (`EnumWindows`, `GetWindowThreadProcessId` equal to the process id, `GetWindow(hwnd, GW_OWNER)` null) and take the one whose `GetWindowText` starts with `TowerCab`.

   Import `user32.dll` through `Add-Type` (`EnumWindows`, `GetWindowThreadProcessId`, `GetWindow`, `GetWindowText`, `IsWindowVisible`, `ShowWindow`).
3. Launch with `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; pnpm run dev`.
4. Drive over CDP and never call `page.bringToFront()`.
5. Before closing, `ShowWindow(hwnd, SW_SHOWNOACTIVATE)` (4) then `CloseMainWindow()`: the window-state plugin saves the visible flag, so closing while hidden makes the next launch start hidden.

The other `ShowWindow` states, if a run wants one: `SW_SHOWMINNOACTIVE` (7) minimizes without activating; `SetWindowPos(hwnd, 0, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)` with `x` past the virtual screen's right edge (`GetSystemMetrics` `SM_XVIRTUALSCREEN` 76 plus `SM_CXVIRTUALSCREEN` 78) moves it off-screen.

Make the process per-monitor DPI aware first (`SetProcessDpiAwarenessContext(-4)`) so rectangles are physical pixels. Save `GetWindowPlacement` before moving it, and restore it afterwards.

Without `--agent` this still needs "hands off" at launch: the window shows for a moment and can take the keyboard focus (3.9 s measured) until the poller hides it, because the window-state plugin restores the saved window with `show()` then `set_focus()`.

Wall time to budget: a fresh worktree takes about 5 minutes to set up (`pnpm install` 11 s, `vite:build` 31 s, a cold cargo build about 220 s through the gate); a launch to a responding `__tc3d` with KOAK selected takes 32 to 64 s.

This is the opposite of headless Edge over raw CDP, which needs `page.bringToFront()` to render (see headless-edge-quirks).
Source: spike TC3D-244 measurements; src-tauri/src/lib.rs:777-778; the spike's Win32 helper (FindWindow by process, ShowWindow constants) now described here. Seen: spike TC3D-244.

### Say "hands off" before driving the user's window
<!-- rule: say-hands-off-first -->

Tell the user "hands off" before driving the app window: the app runs on the user's own desktop and any mouse or keyboard input from them breaks a run. The nextup profile repeats it as a step of every app check. A run the user's input cannot reach needs no warning: a `--agent` launch never shows or focuses the window (see quiet-by-default, hidden-window-keeps-rendering). A launch without `--agent` shows the window and can take the focus, so the warning stands until it is hidden; a launch that shows the window even briefly before hiding it still needs the warning.

Real OS input (`SendInput`, SendKeys) is where it bites: in another project a field's value gained stray letters in front of it because the user was typing during the run. CDP input never goes through the OS, but posted input is not fully out of reach either, since a UI framework may read Shift and Ctrl from the real keyboard (Avalonia does; it matters for CRC through the yaat client driver).
Source: CLAUDE.md:53; .claude/skills/towercab-3d-nextup/SKILL.md:35; commit b39260a (Wave 1 friction list). Seen: Wave 1 run (2026-09-27).

### Project world points to the page CSS pixels the input tools take, and judge visibility by that projection
<!-- rule: one-coordinate-space -->

Finding an object on screen took hand-written `Vector3.Project` math in Wave 1. The hook's `project(lat, lon, heightM)` returns a page CSS-pixel point (Cesium window coordinates offset by the canvas's `getBoundingClientRect()`), which feeds `browser_click` and friends directly, or null when the point cannot be projected.

Return the coordinates the input tool consumes, in the space it consumes them, not engine-local ones. Judge whether something is on screen by that projection and the pixels there, not by an engine's own visibility test: Babylon's `camera.isInFrustum` reported the on-screen tower as not visible during Wave 1, so it was dropped as evidence of visibility.
Source: src/renderer/hooks/useAgentHarness.ts:58-65; src/renderer/types/harness.ts:63-69; CLAUDE.md:48; commit b39260a (MAIN.md friction list). Seen: Wave 1 run.

### Judge an action by its effect: read the value back
<!-- rule: check-action-effects -->

A tool that reported success is not proof the action worked. In another project a set-text call reported success on a folder box that reverted the path, and two save confirmations stacked up unseen while the agent concluded "save did nothing".

After an input, read the result back before judging it: the store value through `window.__tc3d.stores` or `camera.get()`, and a fresh accessibility snapshot for any dialog or panel the action may have opened. A target that vanished because the action closed it may be success. Not met: the driving notes and the app-check step do not ask for the read-back yet.
Source: CLAUDE.md:43-58; .claude/skills/towercab-3d-nextup/SKILL.md:35; another project's driving friction log over three sessions. Seen: 0 here (seeded from yaat).

### Wait on a condition after every action, never a sleep, and batch fixed sequences
<!-- rule: wait-for-conditions -->

After each action, wait for one condition that names the effect (a store value, a hook value, an element), polled inside the app, with a timeout that returns the last value seen rather than an error; never a fixed sleep. Not met: the hook has no wait primitive, so a run has only Playwright's `browser_wait_for` and the measured ~10 s airport-switch stall.

In another project, without such waits, hitting a given simulated second depended on tool-call latency, and a hand-written runner carried hard-coded 500 ms, 3000 ms and 8000 ms sleeps. Wait on the value needed, not "not empty" (a placeholder holds too early), and since timeouts stretch under load, hold for app time by counting the app's own frames, never by a timeout.

A wait on the app's output is checked outside the page, from the unified log (see unified-log-tail), so it works while the page is paused, and it starts from a point taken before the action (the log's length then), so a line written just before the wait still counts. Not met either: nothing waits on the log yet, so a run reads it after the fact.

A fixed sequence goes through one call, so nothing goes stale between round trips: one `browser_evaluate` or `browser_run_code_unsafe` call can run several hook calls with their waits.
Source: src/renderer/types/harness.ts:29-81; CLAUDE.md:57-58; other projects' wait and batch tools and a driving friction log. Seen: 0 here (seeded from godot-mcp, yaat).

### Wait out heavy transitions before reading state
<!-- rule: wait-after-heavy-transition -->

An airport switch stalls page timers for about 10 s; wait before reading state, or the reads describe the old scene or a half-loaded one. The number is a measured stall from the Wave 1 run, not a settle time the app guarantees.
Source: CLAUDE.md:58; commit b39260a. Seen: Wave 1 run.

### Read and set state through the hook, never by scraping text, timed key presses or hashed module URLs
<!-- rule: hook-over-scraping -->

Before the hook existed, the Wave 1 run read the camera heading by scraping the `HDG` status-bar text and aimed the camera with timed arrow-key presses in a loop, which is slow and imprecise. The fix was a dev-only `camera.get()` / `camera.set({ heading, pitch, fov })` / `lookAt(lat, lon, altFt)` over the same store the UI uses. When a driving run needs a value the UI only renders as text, or a pose it can only reach by holding keys, that is a missing hook call, not a scripting problem.

Do not reach app internals by their bundler-hashed module URL either. In Wave 1 the Babylon engine was reachable only by `import()` of `engineStore.js` at its exact Vite URL including `?v=<hash>`; the hash changes on every dependency re-optimize, and `performance.getEntriesByType('resource')` caps at 250 entries, so the URL had to be dug out of the console log each time.

Put live engine objects on the hook instead. (Importing a source module by its dev-server source path, such as `/stores/vatsimStore.ts`, is stable and is still the documented way to start VATSIM polling in the frontend-only browser.)
Source: commit b39260a (docs/plans/MAIN.md Wave 1 friction list, "Babylon was reachable only by import()…"); src/renderer/hooks/useAgentHarness.ts:41-57; CLAUDE.md:36. Seen: Wave 1 run; led to commit 20ccd0b.

### Force rare conditions through a dev-only control, and know what it replaces
<!-- rule: force-conditions-dev-panel -->

Do not wait for real weather to test weather rendering: the dev-only `WeatherDebugPanel` forces rain, snow and cloud coverage, and `stores.weather.setState` does the same from `browser_evaluate`. Its Apply replaces all weather, clouds included, so a run that applies rain over an existing overcast loses the clouds.
Source: CLAUDE.md:41, CLAUDE.md:56; docs/plans/rendering-opportunities-design.md:214. Seen: Wave 1 run.

### Screenshots miss additive, zero-alpha effects: read the render buffer
<!-- rule: what-capture-misses -->

Rain in the Babylon overlay is drawn additively with alpha 0, so CDP screenshots and canvas `drawImage` both miss it. Verify such effects with the hook's `readPixels(x, y, w, h)` on the Babylon canvas (RGBA, bottom-left row order) or a video, never a still screenshot.

The converse also holds: `readPixels` covers only the Babylon canvas, so Cesium pixels, including the clouds and fog of the Cesium weather stage (the default renderer in a view with a logarithmic depth buffer; `weatherStage.renderer = 'babylon'` brings back the Babylon meshes), are still judged from page screenshots. The plan's standing verification line says "particles and other additive effects need a video or engine.readPixels, not a screenshot".
Source: CLAUDE.md:49; src/renderer/hooks/useAgentHarness.ts:66-81; docs/plans/rendering-opportunities-design.md:109, 214; commit 8d672dc (MAIN.md "Verification, every wave"). Seen: Wave 1 run.

### CDP emulation overrides last only for the call that sets them
<!-- rule: emulation-per-call -->

CDP `Emulation.*` overrides (for example `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor: 2` to test high-DPI) last only for the `browser_run_code_unsafe` call that sets them. Set the override and take every measurement that depends on it inside that one call.
Source: CLAUDE.md:57; docs/plans/rendering-opportunities-design.md:296; commit b39260a. Seen: Wave 1 run (DPR 2 label bug verification).

### Record in app time with marks, and keep every drive replayable
<!-- rule: record-and-replay -->

The plan asks for a video to verify additive effects, but nothing here records a drive or replays one.

The rule from another project: record on the app's own clock rather than wall time (its fixed-rate movie writer recorded a light scene at about 240 fps of wall time and a heavy one below 60), so gesture durations and waits count clip time; and cut start and stop marks into clips.

Record injected input on the app's single clock too (merging server-logged gestures with app-logged events put two clocks a round trip apart), streamed in small batches so a capture survives a crash and replays through the input tool.

A random run draws from a seeded generator that is stable across runtime versions, so a failing seed replays exactly.
Source: CLAUDE.md:49; commit 8d672dc (MAIN.md "Verification, every wave"); another project's architecture doc and changelog fixes. Seen: 0 here (seeded from godot-mcp).

### Record the window on a steady clock, never minimise it, and mark with the app's clock
<!-- rule: record-steady-never-minimize -->

There is no recorder here yet. When the window is recorded: Windows Graphics Capture delivers a frame only when the window redraws (one in 20 s on a static tab in another project), so write frames on the recorder's own steady timer and let ffmpeg stamp each with its arrival time (`-fps_mode vfr`), so a clip whose recorder fell behind still plays in real time, and report the dropped frames at stop.

A minimised window stopped rendering in that project and restoring it took the foreground, so hide a recorded window by DWM cloaking instead (still captured at 30 fps there), never minimise it.

(This app's WebView2 keeps rendering when minimized or `SW_HIDE`-hidden, see hidden-window-keeps-rendering; whether Windows Graphics Capture can record it is not measured.) Each mark stores wall time, clip seconds and the app's own clock read through the hook, because live playback shifted the app's events 1-2 s against the wall clock in that project.
Source: CLAUDE.md:49; another project's recording code and measurements; Windows Graphics Capture and DWM cloaking docs. Seen: 0 here (seeded from yaat).

### Answer file dialogs before the action that opens them
<!-- rule: queue-file-answers -->

The folder and file pickers (`pick_folder` and `pick_files` through the Tauri dialog plugin) open native dialogs outside the webview, so a CDP attach cannot reach them and a run that hits one stops there. In another project posted typing left the native picker empty and real keys were refused because the picker held the foreground.

The rule: while an agent drives a dev build, the app opens no picker; the agent queues one answer (a path or a cancel) per dialog through the hook before the action, each dialog takes the oldest, and one opened on an empty queue fails at once. Not met yet.
Source: src-tauri/src/files.rs:21-45; CLAUDE.md:35; another project's driving friction log and dialog-queue tool. Seen: 0 here (seeded from yaat).

### Name what the webview cannot reach, and the shell route for each
<!-- rule: name-out-of-reach-ui -->

A CDP attach reaches only the page. Say so explicitly for each native surface: the tray menu and native file dialogs are out of reach; deep links (`start tc3d://…`), single-instance behaviour and window state are exercised from the shell instead. An agent that does not know this burns turns trying to click a native dialog.

Where the app can avoid opening a native surface while an agent drives it, it does, and the hook answers in its place: a queued file pick for the folder and file pickers (see queue-file-answers, not met yet).
Source: CLAUDE.md:35. Seen: documented.

### Read the app's errors from the unified log, not the whole file
<!-- rule: unified-log-tail -->

Launched with a log path (`pnpm run dev -- temp/console.log`, which is resolved relative to `src-tauri/`, not the repo root, or `TOWERCAB_LOG_FILE`), the app writes Rust logs and the webview's console (forwarded through `log_from_frontend`, buffered to 50 lines or 2 s) into one file.

Agents read `temp/console.log` without pulling it all into context, and the app logs a `[Perf]` frame-timing line there only when FPS drops below 50, so a slowdown is diagnosable from the file. Allow for the 2 s flush before concluding a line is absent.
Source: CLAUDE.md:23-25; scripts/shipping/build/dev-wrapper.js:16-27; src/renderer/utils/fileLogger.ts:11-12, 21-30; src-tauri/src/lib.rs:119-131, 195; src/renderer/components/CesiumViewer/CesiumViewer.tsx:1001-1014; scripts/debugging/denoise-logs.cjs:10-20. Seen: documented.

### Build the hook from a real run's friction list
<!-- rule: friction-log-per-session -->

The harness was specified line by line from the friction the first agent-driven app run hit (hash-pinned imports, scraped heading text, key-press steering, hand-written projection, screenshots missing rain), and those notes first lived only in a gitignored scratch file before being folded into the tracked plan item.

Record driving friction in the plan as it happens (an **add**, so it lands as a TC3D issue), with the tool, what happened against what was needed, and the workaround, and turn each item into a hook call or a documented driving note.
Source: commit b39260a ("fold the Wave 1 MCP friction notes (until now only in a gitignored scratch file) into the harness item"); commit 20ccd0b; CLAUDE.md:13. Seen: once, led to the harness.

### Headless Edge over raw CDP: bring it to front, drop extensions, leave Vite alone
<!-- rule: headless-edge-quirks scope: project -->

Measured in headless checks driven over raw CDP (or `playwright-headless`):
- Headless Edge renders at 1 fps until `page.bringToFront()` is called (headless only; a hidden desktop window is the opposite, see hidden-window-keeps-rendering).
- Launch it with `--disable-extensions`: even a fresh profile loaded extensions and logged about 88,000 "Unchecked runtime.lastError" lines in two minutes.
- Do not restart Vite while the page is open: its client threw "send was called before connect" about 295,000 times in seven minutes. Close the page first.
- `npm i` in a driver folder fails without a `package.json`; add one first.
- The sun direction is `viewer.scene.context.uniformState.sunDirectionWC`, not `scene.light.direction`.
Source: headless checks of TC3D-244's session. Seen: once.

### Reset one-time UI flags through persisted state, then reload
<!-- rule: reset-flags-via-storage scope: project -->

First-launch tips and dismissed prompts are reset by editing the persisted Zustand blob (`localStorage['settings-store']`, `parsed.state.ui.<flag>`) from `browser_evaluate` and reloading with `browser_navigate`, not by wiping the profile.
A reload also forgets the selected airport (it is not restored), so select it again before reading scene state.
Source: CLAUDE.md:39; commit 66062dd. Seen: documented, used for the keyboard cheatsheet tip.

### Know the two camera resets apart
<!-- rule: camera-reset-paths scope: project -->

Shift+Home resets the camera to the app default; the "Defaults" button restores the user's saved default. A run that wants a known pose uses Shift+Home (or `camera.set`), never "Defaults".
Source: CLAUDE.md:54; commit b39260a. Seen: Wave 1 run.

### The dev build reads its fixtures from the build folder
<!-- rule: dev-mods-in-target scope: project -->

The dev build reads mods from `src-tauri/target/debug/mods`; a tower model comes from cloning `github.com/leftos/tc3d-mod-koak-tower` into its `towers/`. Without it a tower-related check has nothing to look at.

The mod repo nests the mod one level down (`KOAK/`), while the app wants `<folder>\towers\KOAK\{manifest.json, model.glb}`: lay it out that way and, for a headless run, point `TC3D_MODS_DIR` at `<folder>`.

A tower-cab check also needs 3D buildings on, because the mod draws no shaft. The mod's camera sits about 225 m NNE of the cab facing about 075, so the cab is behind the default view; aim at bearing about 203 to see it. Read the OSM shaft centroid live from the feature's `cesium#latitude` / `cesium#longitude` rather than hard-coding it.
Source: CLAUDE.md:55; commit b39260a. Seen: Wave 1 run; TC3D-244 checks.

### Drive a third-party app through a hook that fences itself, never through the owner's input
<!-- rule: fenced-hook-for-third-party-app -->

CRC, the controller client vNAS work checks against, is not ours: driven through UI Automation it would take the real mouse and keyboard from the user. The `yaat-client-driver` MCP's `crc_*` tools instead launch CRC with yaat's .NET startup hook, which drives it over a pipe: no real input, windows visible but never brought to the foreground, and the user's cursor snapshotted and restored around every input.

CRC can reach the live VATSIM network, so the hook checks before each input, in the same UI-thread operation, that CRC is connected only to a local test server (a local YAAT server), and refuses otherwise, so a driver can never type into a live session; if the check ever finds otherwise it breaches loudly (every window brought forward, every call refused). A local server port only one process can hold is checked before a server is started for a run, and another session's server is left alone.
Source: the yaat-client-driver MCP (`yaat/docs/client-driver-mcp.md`); .claude/skills/towercab-3d-nextup/SKILL.md "App checks". Seen: 0 here (seeded from yaat).

## App-side hook

### Gate the whole hook behind the bundler's dev flag
<!-- rule: dev-flag-gates-hook -->

The entire install body sits inside `if (import.meta.env.DEV)`, so Vite drops it from production bundles; there is no runtime setting or query parameter that turns it on in a release. Every extension (`perf()` exists; `settings`, `cinematic` are planned) is specified as "dev-only like the rest".
Source: src/renderer/hooks/useAgentHarness.ts:17-18, 32; src/renderer/types/harness.ts:7-8; docs/plans/rendering-opportunities-design.md:20. Seen: documented.

### Put every path that activates the window behind one gate, pinned by source tests
<!-- rule: one-gate-source-pinned -->

The app brings its window forward from several places: the single-instance callback and the tray's Show item and left click each call `unminimize` and `set_focus`.

A driven run needs one gate that suppresses them all while an agent drives, and a source-scanning test that fails on any raw activate call outside it, because a UI framework activates windows too (in another project the framework activated a modal's owner after it closed and on any visible window-state change, found only by decompiling it). Not met: there is no gate and no such test; it follows quiet-by-default.
Source: src-tauri/src/lib.rs:857-863, 915-920, 935-940; another project's background-driving design and its source tests. Seen: 0 here (seeded from yaat).

### Install from the component that owns the engines, and remove only your own instance
<!-- rule: install-owner-cleanup-own -->

The hook is installed by the viewer component that creates the Cesium viewer and Babylon overlay, keyed on their identity, and its cleanup deletes the global only if it is still the same object (`if (window.__tc3d === harness)`), so a remount or a second instance never deletes a newer harness.
Source: src/renderer/hooks/useAgentHarness.ts:29-30, 84-90; src/renderer/components/CesiumViewer/CesiumViewer.tsx:430-431. Seen: documented.

### Merge inherited browser arguments in the native host instead of overwriting them
<!-- rule: merge-inherited-webview-args -->

The Tauri host set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` for its own GPU flags and discarded whatever the launching shell had set, so `--remote-debugging-port` never reached WebView2 and CDP attach was impossible. The host now appends the inherited value to its own flags. Any app that sets its webview's browser arguments must preserve the caller's.
Source: src-tauri/src/lib.rs:767-797 (comment at 789); commit 0275468. Seen: once, blocked the first CDP attach.

### Expose one typed window global, declared on Window
<!-- rule: one-typed-window-global -->

The hook is a single `window.__tc3d` object typed by an `AgentHarness` interface with a `declare global { interface Window { __tc3d?: AgentHarness } }`, so the shape is checked by the compiler, documented in one file, and reached from any CDP `browser_evaluate` without imports. It hands over the live engine objects (Cesium viewer, Babylon engine and scene) and the store hooks themselves (`.getState()` / `.setState()`), plus a few task helpers, rather than wrapping every engine call.
Source: src/renderer/types/harness.ts:29-88; CLAUDE.md:43-49. Seen: documented.

### Specify each feature's hook surface in its design
<!-- rule: design-names-hook-surface -->

New feature designs name the `window.__tc3d` calls that will let an agent verify them (`settings.list/get/set/reset` validated against the control's range, `cinematic.start/stop/state`, `camera.follow`; `perf()` is the model for a measurement call), with the type going into `types/harness.ts`; the hook grows with the features instead of after them.
Source: docs/plans/settings-drawer.md:82; docs/plans/cinematic-camera.md:70; docs/plans/on-plane-cameras.md:70; docs/plans/rendering-opportunities-design.md:20; docs/plans/MAIN.md:108, 147. Seen: four designs.

### Fail loudly when the hook's target is not ready
<!-- rule: hook-throws-when-unready -->

A helper whose engine is absent throws a named error ("TowerCab agent harness: Babylon engine or canvas is not available") instead of returning empty data, so an agent reading pixels too early gets a cause, not a black rectangle.
Source: src/renderer/hooks/useAgentHarness.ts:67-70. Seen: documented.

### Convert every hook write by its declared type and read it back
<!-- rule: verify-writes-read-back -->

`camera.set` hands its fields to the viewport store's `setHeading`, `setPitch` and `setFov` and returns nothing, and those setters normalise the heading and clamp pitch and FOV to their limits, so a value out of range is changed with no word to the caller; writes through `stores.*.setState` are not read back either.

The rule from another project, where setters given the wrong type changed nothing and logged nothing: the hook converts each value by its declared type, sets it, reads it back, and when the read-back differs puts the old value back and fails with the before and after values. Not met; the planned `settings.set`, validated against the control's range, is the natural first place.
Source: src/renderer/hooks/useAgentHarness.ts:48-53; src/renderer/stores/viewportStore.ts:534-560; docs/plans/settings-drawer.md:82; another project's decision record. Seen: 0 here (seeded from godot-mcp).

### Convert page pixels with the canvas's own backing-store ratio, not devicePixelRatio
<!-- rule: backing-store-ratio -->

`readPixels` maps page CSS pixels to buffer pixels with `canvas.width / canvas.clientWidth`, because the engine sizes the canvas and that ratio can differ from `window.devicePixelRatio`. The repo measured exactly that mismatch at DPR 2: canvas 1596×800 against a GUI texture of 3192×1600, which drew datablocks at half size and position.
Source: src/renderer/hooks/useAgentHarness.ts:71-78; commit b39260a (MAIN.md DPR 2 item, "measured: canvas 1596×800, GUI 3192×1600"). Seen: once (DPR 2 bug).
