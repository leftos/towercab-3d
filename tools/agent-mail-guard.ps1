#requires -Version 7
<#
.SYNOPSIS
The prek hook `agent-mail-guard`: hands the staged paths to the user-level Agent Mail lease guard when the machine
has one, and passes when it does not.

.DESCRIPTION
tools/sync-launchers.ps1 publishes this file into a repo as tools/agent-mail-guard.ps1, and a repo carries this
launcher rather than a copy of the guard: the canonical guard, at
`$env:CLAUDE_CONFIG_DIR\tools\agent-mail\guard-check.ps1`, or the user's `~/.claude\tools\agent-mail\guard-check.ps1`
when that variable is unset, blocks a commit whose staged paths sit under another Claude Code session's exclusive
Agent Mail lease, and a change to it reaches every repo at once.

A clone on a machine without it has no sessions to collide with, so its commits pass; the hook says so on standard
error, one line, `agent-mail-guard: <path> not found; no lease check on this machine`, so a skipped check is never
read as a passed one.

When the guard is there, every word is handed to it in this same process, so the call is the guard's own and the
working directory is unchanged: the guard resolves the project from `git rev-parse` in the caller's directory.

Usage: pwsh -NoProfile -File tools/agent-mail-guard.ps1 <path>...
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$guardPath = Join-Path ($env:CLAUDE_CONFIG_DIR ?? (Join-Path $HOME '.claude')) 'tools/agent-mail/guard-check.ps1'

if (-not (Test-Path -LiteralPath $guardPath)) {
    [Console]::Error.WriteLine("agent-mail-guard: $guardPath not found; no lease check on this machine")
    exit 0
}
& $guardPath @args
exit ([int]$LASTEXITCODE)
