---
name: prepare-release
description: Prepare a new TowerCab 3D release. Walks through version bump, CHANGELOG promotion, pre-release checks, signed build, commit/tag/push, and post-release notes editing. Interactive — asks for confirmation at the draft-review checkpoint before any push.
---

# Prepare a TowerCab 3D Release

Walk through these steps interactively. Pause at the draft checkpoint (Step 6) for user approval — do not push, tag, or commit before that approval.

The TowerCab 3D release is driven by `.github/workflows/release.yml`, which fires on `v*` tags. The workflow currently uses `generate_release_notes: true` (auto-generated from PR titles) and creates a **draft** release. After CI publishes the build artifacts, this skill overwrites the auto-generated body with curated highlights + the full CHANGELOG section via `gh release edit`.

## Step 0: Pre-flight

Run these checks before touching anything. If any fail, stop and surface the issue to the user.

1. **Branch + clean tree** — `git status -sb` and `git rev-parse --abbrev-ref HEAD`. Must be on `main`. The only modifications allowed at this point are `src-tauri/Cargo.lock` (the signed build will refresh it) — anything else means uncommitted feature work that should land first.
2. **Signing key present** — `Test-Path x:\dev\.tauri\towercab-3d.key`. The signed build script (`build-signed.ps1`) reads this file. If missing, warn the user; they can either generate one (`npx tauri signer generate -w x:\dev\.tauri\towercab-3d.key`) or skip the signed-build step (Step 7.4) and let CI handle signing.
3. **vNAS source preference** — ask: build with vNAS (private repo, default) or `-NoVnas` (public). This is only relevant for the local pre-flight build; CI builds use whatever the workflow configures.

## Step 1: Read current version

Read these three files and confirm they all match (release-blocking if they don't):

- `package.json` — top-level `"version"` field
- `src-tauri/tauri.conf.json` — top-level `"version"` field
- `src-tauri/Cargo.toml` — `[package].version`

If they're out of sync, that's a prior release-prep mistake. Surface it; the user decides whether to repair before continuing.

## Step 2: Find previous release

Run `git tag --sort=-v:refname | head -5` to show the recent tag history. This grounds the version suggestion in actual practice (the project has been bumping patch on `0.0.X-alpha`).

## Step 3: Ask for new version

Suggest the next version (typically a patch bump, e.g. `0.0.46-alpha` → `0.0.47-alpha`). Ask the user to confirm or override. Strip any leading `v` from user input — the version field uses `0.0.47-alpha`, the git tag uses `v0.0.47-alpha`.

## Step 4: Locate the unreleased CHANGELOG section

Read `CHANGELOG.md`. Find the topmost `## ` heading (ignoring the `# Changelog` file title). Cross-check against `git tag --sort=-creatordate | head -10`:

- **Topmost heading matches a released tag** (e.g. `## [0.0.46-alpha] - 2026-04-04` and `v0.0.46-alpha` exists) → CHANGELOG is stale relative to HEAD. **Offer to run the `update-changelog` skill inline now**, then re-read the file. Do not proceed past this step until the topmost section is unreleased. Do not fall back to scraping `git log`.
- **Topmost heading is `[Unreleased]`** → that is the unreleased section. Capture its full body (everything from the heading up to but not including the next `## ` heading).
- **Topmost heading is an untagged version** (e.g. `## [0.0.47-alpha]` with no matching tag) → treat it as the unreleased section.

## Step 5: Pick highlights from the CHANGELOG section

Read the unreleased section captured in Step 4. Select **3-4 user-impactful items** to surface as highlights:

- Prefer items from `### Added` and `### Changed`. `### Fixed` items only if a fix is something users were waiting on.
- Skip purely internal items even if they made it into the changelog (refactors, test infra, build plumbing).
- Tighten each chosen bullet to a short, scannable one-liner — drop sub-clauses about how it works internally. The full detail stays in the Changelog section below the Highlights.
- No marketing language (no "significantly", "robust", "comprehensive", etc.). State the change.
- **Write for users, not developers.** The audience is VATSIM controllers running TowerCab 3D, not contributors. Drop implementation jargon: framework/library names (Cesium, Babylon, Zustand, Tauri), class/method names, exception types, internal subsystem names. Lead with what the user sees and does. Keep user-vocabulary names for actual UI elements (e.g. the "Settings" modal, the bookmark manager).
  - Bad: *"useBabylonOverlay now syncs ENU transforms each frame, fixing label drift on tilt change."*
  - Good: *"Aircraft labels stay glued to their aircraft when you tilt the camera."*

## Step 6: Present draft release notes (CHECKPOINT)

Show the user the draft — the highlights you derived **plus the full unreleased CHANGELOG section verbatim**:

```
## Highlights
- [3-4 derived bullets]

## Changelog
[full body of the unreleased section from CHANGELOG.md, sub-headings included]
```

Also show the **CHANGELOG heading promotion** that will happen on commit. Match the existing file style by inspecting an already-released sibling section (e.g. `## [0.0.46-alpha] - 2026-04-04`). The towercab-3d convention is `## [VERSION] - YYYY-MM-DD` with bracketed version and a date suffix.

```
CHANGELOG.md heading change:
  before: ## [Unreleased]
  after:  ## [0.0.47-alpha] - 2026-05-03
```

If the current heading is `## [Unreleased]`, replace it entirely with the new version heading; do **not** keep an `[Unreleased]` placeholder in this commit (the user will reintroduce one when they next start logging changes).

**Ask the user to review.** Apply any requested edits to the highlights or to the unreleased section in CHANGELOG.md before continuing. Do not proceed to Step 7 without explicit approval.

## Step 7: Ship it (after user approval)

Once the user approves, execute these steps in order. Stop on any failure.

### 7.1 Bump version in three files

Update the version string in all three files. They must match exactly (no leading `v`, no quotes around the number, etc.):

- `package.json` — `"version": "X.X.X-alpha"` (top-level field, around line 3)
- `src-tauri/tauri.conf.json` — `"version": "X.X.X-alpha"` (top-level field, around line 4)
- `src-tauri/Cargo.toml` — `version = "X.X.X-alpha"` (in `[package]`, around line 3)

### 7.2 Update CHANGELOG.md

1. **Promote the heading** — `Edit` the `## [Unreleased]` line to `## [X.X.X-alpha] - YYYY-MM-DD` (today's date, ISO format).
2. **Insert the approved highlights** as a `### Highlights` subsection at the top of the version's section, immediately after the heading and before the first existing subsection (typically `### Added`). Use the bullets verbatim as approved in Step 6.

### 7.3 Run pre-release checks

Run `pnpm run check`. This runs Biome, TypeScript, and Rust (`cargo check` / `clippy` / `fmt --check`). If issues surface:

- Auto-fixable lints/format → run `pnpm biome check src/ --fix` and `cargo fmt`, then re-run `pnpm run check`.
- Anything else → stop and surface the failure to the user. Do not commit a release with failing checks.

### 7.4 Run the signed build (optional but recommended)

Run `.\build-signed.ps1` (or `.\build-signed.ps1 -NoVnas` per Step 0.3). This:

- Verifies the release builds cleanly with the signing key
- Refreshes `src-tauri/Cargo.lock` to embed the new version
- Confirms the installer is created locally before the tag fires CI

If the build fails, stop. Investigating locally is much faster than waiting for CI to fail.

If the user opted to skip this step in Step 0, note that `Cargo.lock` will be regenerated by CI and skip ahead.

### 7.5 Commit, tag, push

Stage **only** the files this release touched — do not `git add -A`:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` (if 7.4 ran)
- `CHANGELOG.md`

Then:

```
git commit -m "release: vX.X.X-alpha"
git tag vX.X.X-alpha
git push origin main
git push origin vX.X.X-alpha
```

The tag push triggers `release.yml`.

## Step 8: Watch CI, then patch the release notes

The workflow creates a **draft** release with auto-generated notes (PR-title-derived). To replace those with the curated highlights from Step 6:

1. **Wait for the workflow to finish.** Poll `gh run list --workflow=release.yml --limit=1` until the run completes. The Windows installer build typically takes 10–20 minutes. If it crosses 25 minutes without finishing, surface the run URL (`gh run view <id> --web`) so the user can investigate, and stop.
2. **If the run failed**, surface the failed step and the run URL. Do not retry automatically — release failures usually indicate something the user needs to look at.
3. **If the run succeeded**, build the release body locally:

   ```
   ## Highlights

   - [highlight 1]
   - [highlight 2]
   - ...

   ---

   ## Changelog

   [full unreleased-section body verbatim, preserving sub-headings]

   ---

   ### Installing on macOS (Apple Silicon)

   This build isn't notarized by Apple yet, so on first launch macOS reports it as **"damaged and can't be opened."** It isn't damaged — this is how macOS treats unsigned apps downloaded from the internet. To open it, drag TowerCab 3D to Applications, then run this in Terminal and launch the app normally:

   ```
   xattr -dr com.apple.quarantine "/Applications/TowerCab 3D.app"
   ```
   ```

   The **Installing on macOS** footer is mandatory on every release (the build is unsigned); include it verbatim. Apply the body via `gh release edit vX.X.X-alpha --notes-file <path>` (write to a temp file under `.tmp/` to avoid quoting issues).
4. **Mark the release published if it's still a draft.** The workflow creates `draft: true`; it may already be undrafted by an upload step. Check with `gh release view vX.X.X-alpha --json isDraft`. If still draft, `gh release edit vX.X.X-alpha --draft=false`.

## Errors and recovery

- **Pre-flight fails (Step 0):** Stop, report, don't proceed. No state mutated yet.
- **Checks fail (Step 7.3):** Stop. Auto-fix what you can; surface the rest. Nothing has been committed yet.
- **Signed build fails (Step 7.4):** Stop. Nothing has been committed yet. The version-file edits and CHANGELOG promotion are still on disk — the user can inspect, fix, and re-run from Step 7.3.
- **Tag push succeeds but CI fails:** The git tag is now on the remote. Do not delete it without user approval — re-tagging after a fix is the cleaner path. Surface the failure and let the user decide.
- **Tag already exists locally or remote:** Likely the previous attempt half-shipped. Inspect `git tag` and `git ls-remote --tags origin` to see where the inconsistency is, then ask the user how to proceed (delete and re-tag, or bump version).

## Notes

- Use Windows-absolute paths with backslashes for `Edit`/`Write` (e.g. `X:\dev\towercab-3d\package.json`). Forward slashes or relative paths cause "File has been unexpectedly modified" errors.
- Never `git push --force` to `main`. If something needs to be undone, talk to the user first.
- The `src-tauri/Cargo.lock` modification you may see in pre-flight is normal — it's commonly modified by the local cargo patch redirect for the private vNAS crate. The signed build will refresh it; commit it as part of the release.
