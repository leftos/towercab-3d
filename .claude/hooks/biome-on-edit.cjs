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

// Only lint files inside the repo's src/ — Biome config is scoped there.
const normalized = filePath.replace(/\\/g, '/')
if (!/\/src\//.test(normalized)) process.exit(0)

// Resolve a path relative to repo root for clean Biome output.
const repoRoot = process.cwd().replace(/\\/g, '/')
const rel = normalized.startsWith(repoRoot)
  ? normalized.slice(repoRoot.length + 1)
  : normalized

const result = spawnSync('pnpm', ['biome', 'check', rel], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  cwd: process.cwd(),
})

const stdout = result.stdout?.toString() ?? ''
const stderr = result.stderr?.toString() ?? ''

if (result.status !== 0) {
  // Surface the diagnostics to Claude on non-zero exit.
  if (stdout) process.stderr.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exit(1)
}

process.exit(0)
