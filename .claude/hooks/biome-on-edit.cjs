#!/usr/bin/env node
// PostToolUse Edit|Write hook: run Biome on the changed TS/TSX file.
//
// Biome is fast (~50ms/file) so running inline beats deferring to commit time.
// Surfaces lint errors to Claude immediately via non-zero exit + stderr.
// Does NOT auto-fix — the user should review changes Claude made deliberately.

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const filePath = input?.tool_input?.file_path ?? ''
if (!/\.(ts|tsx)$/.test(filePath)) process.exit(0)

// The repo root is two levels above this script, whatever the session's cwd is.
const repoRoot = path.resolve(__dirname, '..', '..').replace(/\\/g, '/')

// Only lint files inside this repo's src/ — Biome config is scoped there.
const normalized = path.resolve(filePath).replace(/\\/g, '/')
const srcPrefix = `${repoRoot}/src/`
if (!normalized.toLowerCase().startsWith(srcPrefix.toLowerCase())) process.exit(0)

const rel = normalized.slice(repoRoot.length + 1)

const result = spawnSync('pnpm', ['biome', 'check', rel], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  cwd: repoRoot,
})

const stdout = result.stdout?.toString() ?? ''
const stderr = result.stderr?.toString() ?? ''

if (result.status !== 0) {
  // Surface diagnostics to Claude. PostToolUse hooks must exit 2 — not 1 —
  // to route stderr back to the model. Exit 1 is shown to the user only.
  if (stdout) process.stderr.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exit(2)
}

process.exit(0)
