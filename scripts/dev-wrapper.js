#!/usr/bin/env node

/**
 * Development wrapper script that parses command-line arguments
 * and passes them to the Tauri dev process.
 *
 * Usage: node scripts/dev-wrapper.js [LOG_PATH] [--vnas]
 * Examples:
 *   npm run dev
 *   npm run dev -- temp/console.log
 *   npm run dev -- temp/console.log --vnas
 *
 * Or use environment variable:
 *   set TOWERCAB_LOG_FILE=temp/console.log && npm run dev
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// Parse arguments
const args = process.argv.slice(2)
let logFile = process.env.TOWERCAB_LOG_FILE || null
let useVnas = false

// First positional argument is the log file path (if provided)
if (args.length > 0 && !args[0].startsWith('--')) {
  logFile = args[0]
  args.shift()
}

// Check for --vnas flag
if (args.includes('--vnas')) {
  useVnas = true
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

// Build the command
let command = 'tauri dev --config src-tauri/tauri.dev.conf.json'
if (useVnas) {
  // First update vNAS, then run with vnas features
  try {
    execSync('npm run update:vnas', {
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
