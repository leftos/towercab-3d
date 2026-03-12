#!/usr/bin/env node

/**
 * Development wrapper script that builds the frontend and starts Tauri dev.
 *
 * This script:
 * 1. Checks if frontend rebuild is needed (compares source file timestamps)
 *    - Skips build entirely if no source files changed (~instant startup)
 *    - Only rebuilds when src/renderer or vite.config.ts are modified
 * 2. When rebuilding:
 *    - Skips Cesium asset copy if already in dist (~2s savings)
 *    - Uses fast build mode (no minification for dev)
 * 3. Optionally updates vNAS if --vnas flag is passed
 * 4. Starts tauri dev with the appropriate configuration
 *
 * Usage: node scripts/shipping/build/dev-wrapper.js [LOG_PATH] [--vnas] [--release] [--force]
 * Examples:
 *   pnpm run dev
 *   pnpm run dev -- temp/console.log
 *   pnpm run dev:vnas
 *   pnpm run dev:vnas -- temp/console.log
 *   pnpm run dev -- --force              # Force rebuild even if no changes
 *   pnpm run release                     # Optimized Rust + minified frontend
 *   pnpm run release:vnas                # Same with vNAS
 *
 * Or use environment variable:
 *   set TOWERCAB_LOG_FILE=temp/console.log && pnpm run dev
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const BUILD_MODE_MARKER = 'dist/.build-mode'

/**
 * Check if source files are newer than dist output
 * Returns true if rebuild is needed
 */
function needsRebuild() {
  const distIndex = path.resolve('dist/index.html')
  if (!fs.existsSync(distIndex)) {
    return true
  }

  // Check if last build mode matches current mode - rebuild if switching
  const expectedMode = useRelease ? 'prod' : 'dev'
  const markerPath = path.resolve(BUILD_MODE_MARKER)
  if (!fs.existsSync(markerPath) || fs.readFileSync(markerPath, 'utf8').trim() !== expectedMode) {
    const label = useRelease ? 'release (minified)' : 'dev (unminified)'
    console.log(`[dev-wrapper] Switching to ${label} build...`)
    return true
  }

  const distTime = fs.statSync(distIndex).mtimeMs

  // Check key source directories for any file newer than dist
  const srcDirs = ['src/renderer']
  for (const dir of srcDirs) {
    const dirPath = path.resolve(dir)
    if (hasNewerFiles(dirPath, distTime)) {
      return true
    }
  }

  // Also check config files that affect the build
  const configFiles = ['vite.config.ts', 'package.json', 'tsconfig.json']
  for (const file of configFiles) {
    const filePath = path.resolve(file)
    if (fs.existsSync(filePath) && fs.statSync(filePath).mtimeMs > distTime) {
      return true
    }
  }

  return false
}

/**
 * Recursively check if any file in directory is newer than given time
 */
function hasNewerFiles(dirPath, compareTime) {
  if (!fs.existsSync(dirPath)) return false

  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      if (hasNewerFiles(fullPath, compareTime)) return true
    } else {
      if (fs.statSync(fullPath).mtimeMs > compareTime) return true
    }
  }
  return false
}

// Parse arguments
const args = process.argv.slice(2)
let logFile = process.env.TOWERCAB_LOG_FILE || null
let useVnas = false
let useRelease = false
let forceRebuild = false

// Parse all arguments (order-independent)
for (const arg of args) {
  if (arg === '--vnas') {
    useVnas = true
  } else if (arg === '--release') {
    useRelease = true
  } else if (arg === '--force') {
    forceRebuild = true
  } else if (!arg.startsWith('--')) {
    // Positional argument is the log file path
    logFile = arg
  }
}

// Set environment variable for the Tauri backend to read
if (logFile) {
  // Resolve to absolute path (relative to project root, where package.json is)
  const absolutePath = path.resolve(logFile)
  process.env.TOWERCAB_LOG_FILE = absolutePath
  console.log(`[dev-wrapper] Logging to: ${absolutePath}`)

  // Create directory if it doesn't exist
  const logDir = path.dirname(absolutePath)
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

// Build the frontend first (ensures dist/ is up to date for remote browser clients)
// Skip build entirely if no source files changed (instant startup)
if (forceRebuild || needsRebuild()) {
  const cesiumExists = fs.existsSync(path.resolve('dist/cesium-package/Workers'))
  if (cesiumExists) {
    console.log('[dev-wrapper] Building frontend (Cesium cached)...')
  } else {
    console.log('[dev-wrapper] Building frontend (full build, copying Cesium)...')
  }
  try {
    const buildEnv = useRelease
      ? process.env
      : { ...process.env, VITE_FAST_BUILD: '1' }
    execSync('pnpm run vite:build', {
      stdio: 'inherit',
      env: buildEnv
    })
    // Mark build mode so we detect switches and rebuild when needed
    fs.writeFileSync(path.resolve(BUILD_MODE_MARKER), useRelease ? 'prod' : 'dev')
  } catch (error) {
    console.error('Failed to build frontend')
    process.exit(error.status || 1)
  }
} else {
  console.log('[dev-wrapper] Frontend up to date, skipping build')
}

// Build the command
let command = 'tauri dev --config src-tauri/tauri.dev.conf.json'
if (useRelease) {
  command += ' --release'
}
if (useVnas) {
  // First update vNAS, then run with vnas features
  try {
    execSync('pnpm run update:vnas', {
      stdio: 'inherit',
      env: process.env
    })
  } catch (error) {
    console.error('Failed to update vNAS')
    process.exit(error.status || 1)
  }
  command += ' --features vnas'
}

// Execute tauri dev with environment variable
try {
  execSync(command, {
    stdio: 'inherit',
    env: { ...process.env, ...(logFile && { TOWERCAB_LOG_FILE: logFile }) }
  })
} catch (error) {
  // execSync throws on non-zero exit, but we want to exit with the same code
  process.exit(error.status || 1)
}
