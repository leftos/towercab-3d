---
name: validate-design-tokens
description: Quick check for design-token regressions across CSS and TSX — orphan var(--*) references, inline <style> blocks in TSX, and hardcoded literals that should use tokens. Run before CSS-heavy commits.
---

# Validate Design Tokens

A fast, one-shot audit of the TowerCab 3D design-token system. For deeper review across many files, use the `css-token-auditor` subagent instead.

## What to check

### 1. Orphan `var(--*)` references

The canonical token set is defined in the `:root` block of `src/renderer/assets/styles/global.css`. Any `var(--name)` not defined there silently resolves to inherited/unset — a visual bug.

```bash
# Extract defined tokens from :root
# (Read src/renderer/assets/styles/global.css and parse :root { ... } block.)

# Find all var() references in CSS
```

Use `Grep` with pattern `var\(--[a-z0-9-]+\)` across `src/**/*.css`. For each unique token name found, verify it's either:
- Defined in `global.css` `:root`, or
- Defined locally in the same file (component-scoped custom properties are allowed).

Report any unresolved references with file:line.

### 2. Inline `<style>` blocks in `.tsx`

CLAUDE.md forbids `<style>{...}</style>` blocks in TSX. Use `Grep` to find them:

```
pattern: <style[^>]*>
glob: src/**/*.tsx
```

Each match should be extracted to a sibling `.css` file and imported. Note: `style={{...}}` props (object form) are *allowed* for genuinely dynamic values like camera transforms — only flag literal `<style>` element usage.

### 3. Tokenable hardcoded literals (optional)

Scan for hex colors and font-families in CSS that match defined tokens. Examples to flag:
- `#3FE0FF` or similar accent-cyan literals → suggest `var(--accent)`
- `'Inter', sans-serif` → suggest `var(--font-sans)`
- Border radius literals matching `--radius-sm/md/lg`

CLAUDE.md explicitly allows bespoke per-component palettes (e.g. `SettingsModsTab.css`) to keep literals — use judgment and skip those.

## Output format

```
## Design Token Validation

### ❌ Orphan var() references (P0)
- src/renderer/components/X.css:42 — `var(--undefined)` not in :root

### ❌ Inline <style> in TSX (P0)
- src/renderer/components/Y.tsx:80 — extract to Y.css

### ⚠️ Tokenable literals (P1)
- src/renderer/components/Z.css:15 — `#3FE0FF` matches `--accent`

### ✅ Clean
- N CSS files, M TSX files audited.
```

If nothing is found, just say "Clean — no design token violations."

## When to use which

| Situation | Use |
|-----------|-----|
| Pre-commit quick check on a few changed files | This skill |
| Cross-cutting audit across the whole `src/renderer/`, or onboarding into the migration | `css-token-auditor` subagent |
