# Remote server security (TC3D-129 and its Urgent sibling)

The design for closing the remote server's credential leak, from a read-only invariant pass over `d470aa6`. Line numbers are hints; re-resolve them with `rg -n` before a brief. The server is `src-tauri/src/server.rs` (axum, port 8765), the settings bridge `src-tauri/src/settings.rs`, the shared store `src/renderer/stores/globalSettingsStore.ts`.

## What is wrong today

- `GET /api/global-settings` (`server.rs` ~:549-575) and the `POST` echo (~:623) return every secret: Cesium ion token, Google Maps key, RealTraffic licence key, vNAS OAuth tokens, the server's own bearer token.
- `serve_static` joins the raw URL path onto `dist_path` with no containment (~:1775, served ~:1786-1788), and non-`/api/` paths skip the auth check (~:209-219): an absolute path such as `/C:/Users/<u>/AppData/Roaming/com.towercab.viewer/global-settings.json` returns the file. `PathBuf::push` with an absolute argument replaces the base.
- `POST /api/diagnostic` writes `diag_dir.join(&req.filename)` (~:1133): an absolute filename writes anywhere, a `.cmd` in the Startup folder runs at the next login.
- `POST /api/global-settings` replaces every field, `server.*`, host paths and `msfsModels.cacheDirectory` included; the last steers `GET /api/msfs/*path` (~:840, 852-864) at any folder.
- Every remote browser POSTs the full object on each load: `repairSettingsMigration` clears the migration flags every startup (`globalSettingsStore.ts` ~:876-885, called ~:814) and `migrateDisplaySettings` then writes (~:400-411). A redacting GET with today's replace-style POST would wipe the host's secrets the first time an iPad loads.
- The Host header is never checked (`auth_middleware`, ~:176-224) and the WebSockets (~:1521, ~:1728) don't check `Origin`, so a DNS-rebound web page talks to the server from the victim's own address.
- `require_local_network` (~:137, ~:183; local = 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fe80::/10, fc00::/7) is off by default, and Rust always writes the field, so every existing file holds an explicit `false`; global settings have no schema version.
- The bearer token can never work: no client sends `Authorization`, browsers cannot add headers to WebSocket upgrades, and there is no UI to set it.
- `write_global_settings` (`settings.rs` ~:627-658) keeps tokens only when the incoming value is `None`, and the host webview writes back the `vnasTokens` it loaded at startup, so a host save overwrites the crate's rotated refresh token (`towercab-3d-vnas/src/lib.rs` ~:129), and `clear_tokens` (`vnas.rs` ~:438-444) clears nothing on disk.

## Which secrets a remote client uses

| Field | Remote use |
|---|---|
| `cesiumIonToken` | Required: the viewer never starts without it (`useCesiumViewer.ts` ~:183,220, `App.tsx` ~:214-218). |
| `imagery.googleMapsApiKey` | Only when the provider is Google; empty key means no imagery (`useImageryProvider.ts` ~:81-105). |
| `realtraffic.licenseKey` | None: RealTraffic is host-only. |
| `server.authToken` | None (removed by the ruling below). |
| `vnasTokens` | None, and the host webview doesn't need them either (only reader `globalSettingsStore.ts` ~:752). |

## Owner rulings (2026-10-21)

- **Local network only:** the field becomes `allowNonLocalClients`, default off (`#[serde(default)]` in Rust, the same default in TS; the old `requireLocalNetwork` key is ignored and dropped on the next write), so every install, existing ones included, refuses non-private addresses. It gets a UI control in the host's server settings. The Host header is checked (IP literals, `localhost`, `*.local`) and WebSocket upgrades check `Origin`.
- **Bearer token:** removed, field and check, and from the settings export (`SettingsTreeBuilder.ts` ~:202).
- **Path containment** (static files, diagnostic writes, tower positions ~:955, the MSFS cache root) is its own Urgent issue in `vNext`, fixed first.
- **Cesium ion token:** a remote device may set it only when the host's token is empty; it never overwrites one.

## Invariants

1. Only `cesiumIonToken`, and `googleMapsApiKey` when the provider is Google, leave the host over HTTP; `licenseKey` and `vnasTokens` never do. Sites: the GET, the POST echo, static containment, the MSFS cache root.
2. A remote write never changes a host-owned field: every secret (the ion token except when the host's is empty), the whole `server` block, `msfsModels.communityPath`/`cacheDirectory`/`vmrFiles`, `fsltl.sourcePath`/`outputPath`, `renderingBackend`, `vnasTokens`. The server enforces it.
3. The host webview reads and edits everything except `vnasTokens`. An HTTP peer on loopback is never treated as the host (tunnels and rebound pages arrive from 127.0.0.1).
4. Only Rust writes `vnasTokens`, and clearing them clears the file.
5. Fresh and upgraded installs refuse non-local clients before any handler runs; the autostart (`lib.rs` ~:948-1001) runs before the webview, so the default lives in Rust.
6. Requests with an unexpected Host are refused; WebSocket upgrades check `Origin`.
7. Every path built from a request stays inside its root (containment issue).

## Fix shape

- **Read:** one `remote_view(&GlobalSettings) -> GlobalSettings` for the GET and the POST echo: blank `licenseKey`, blank `googleMapsApiKey` unless the provider is Google, clear `vnasTokens`. Blank strings rather than dropping fields (several have no serde default, `settings.rs` ~:512-523). A classification test serialises a fully populated `GlobalSettings`, walks every JSON path and requires each to be listed public, host-owned or secret, so a new field turns it red until classified.
- **Write:** `merge_remote_write(existing, incoming)` takes the incoming object, then copies every host-owned field from `existing` (the ion token kept unless `existing`'s is empty). The same classification list drives it.
- **Remote load writes nothing:** `initializeGlobalSettings()` in remote mode sends no POST.
- **vNAS tokens:** an exact internal read/write for `vnas.rs` (so `clear_tokens` clears) and a command wrapper that never returns `vnas_tokens` and always keeps them on write; `vnasTokens` leaves the TS type and `getSettings`.

Rejected: a separate typed `RemoteGlobalSettings` (new non-secret fields silently never reach remotes, a parallel TS type); proxying ion and Google tiles through the host (large, and anyone on the LAN still fetches what the token allows); per-section PATCH endpoints (fixes lost updates too, but a rewrite); a read-only remote (breaks shared bookmarks and datablock positions, `USER_GUIDE.md` ~:66).

## Tests red today

- `src-tauri/src/settings.rs` (inline `#[cfg(test)]`, as `vnas.rs` ~:1374): default server settings refuse non-local clients and `{"port":8765,"enabled":true}` deserialises restricted; `remote_view` holds no sentinel secret but keeps the ion token; the classification test.

  `merge_remote_write` keeps every secret across a redacted round trip with a display change. It ignores incoming `vnasTokens`, `licenseKey` and `cacheDirectory: "C:/"`, and takes the ion token only when the host's is empty; a host write keeps missing tokens and an internal clear removes them.
- `src-tauri/src/server.rs`: host check (`192.168.1.5:8765`, `localhost`, `pc.local` pass; `evil.example` refused); `is_local_network_ip` table. Containment tests belong to the Urgent issue: `resolve_static_path(dist, "C:/Users/x/global-settings.json")` and `"../x"` are `None`, `"assets/app.js"` stays inside; the diagnostic filename refuses `../x`, `C:/x`, `a/b`. For each, move today's logic into the function unchanged first so the test fails on its assertion.
- `tests/globalSettingsStore.remote.test.ts` (new; mock `@/utils/tauriApi` with `isTauri` false, `@/services/fsltlApi`, stub `localStorage`): `getSettings()` has no `vnasTokens`; `initializeGlobalSettings()` in remote mode sends no write; no remote write body holds `vnasTokens`.

## Doc drift for the docs sweep

`CLAUDE.md` ~:9 and `docs/architecture.md` ~:7,16,23-28; `docs/remote-access-architecture.md` ~:43,194,199,236-238,521,542-566,693,738; `USER_GUIDE.md` ~:63,77 (the server is off by default); comments at `tauriApi.ts` ~:352, `settings.rs` ~:60, `types/settings.ts` ~:1573,1578,1638.
