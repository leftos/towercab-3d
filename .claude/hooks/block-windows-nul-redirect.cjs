#!/usr/bin/env node
// PreToolUse Bash hook: block `2>nul` on Windows.
//
// On Windows under bash/MSYS/Git-Bash, `2>nul` does NOT redirect to the NUL
// device — it creates a literal file named `nul` which is extremely difficult
// to delete (requires special tools or booting from another OS).
//
// CLAUDE.md documents this trap. This hook enforces it automatically.
// Use `2>$null` in PowerShell or omit stderr redirection entirely.

const fs = require('node:fs')

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const cmd = input?.tool_input?.command ?? ''

// Match `2>nul` where `nul` is followed by whitespace, end-of-string, pipe, or
// redirect chars. Avoid false-positives like `2>nullable.txt` or `2>$null`.
if (/2>\s*nul(\s|$|[|;&])/i.test(cmd) && !/2>\s*\$null/i.test(cmd)) {
  console.error(
    'Blocked: `2>nul` on Windows bash creates a literal file named `nul`. ' +
      'Use `2>$null` in PowerShell or omit stderr redirection.',
  )
  process.exit(2)
}

process.exit(0)
