#requires -Version 7
<#
.SYNOPSIS
The gate a repo runs: it hands every word to the user-level gate when the machine has one, and otherwise runs the
command under a smaller wrapper that keeps the log, the tail and the exit status.

.DESCRIPTION
sync-gate.ps1 publishes this file into a repo as tools/gate.ps1, and a repo carries this launcher rather than a copy of
the gate: a change to the canonical gate, at `$env:CLAUDE_CONFIG_DIR\tools\gate\gate.ps1`, or the user's
`~/.claude\tools\gate\gate.ps1` when that variable is unset, reaches every repo at once, and a caller keeps invoking
tools/gate.ps1 as it always did, `pwsh -NoProfile -File tools/gate.ps1 ...` or `& tools/gate.ps1 ...`.

When the canonical gate is there, every word is handed to it in this same process, so the call is the gate's own:
-StopTree and the exit status included.

When it is not, as on another developer's clone, the fallback runs the command itself. It keeps the whole output in the
log, the last -Tail lines on the screen, the command's own exit status, the failure markers that make a zero exit whose
output reports a failure a failure, below-normal priority for the command, and -StopTree, which stops the processes one
Win32_Process snapshot shows under the pid, a process whose parent has already exited being beyond it, since only a job
holds that one. It drops the parts that need the gate's machine: the slot pools, the watchdog's stall kill and ceiling,
its wall-time backstop, and the handling of build servers. It says so on standard error before the command starts, one
line, `gate: <path> not found; running without slots or watchdog`, so a run with no watchdog is never read as one with.

Like the gate, and for the same reason, the options are read by hand out of $args rather than declared in a param
block: a declared block sends the bare -- of a caller's command through PowerShell's parameter binder, which reads it
as a parameter name and stops. The command is every word after a --, or, when the caller's session ate the separator,
every word from the first that is not one of the options.

Usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light [-StallSeconds <n>] [-Tail <n>] [-NoMarkers] -- <command> [args...]
       pwsh tools/gate.ps1 -StopTree <pid>
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The failure markers a zero exit must not hide: copied from gate.ps1, which the self-test proves by comparing the two
# assignments in their parse trees.
$markers = '^Build FAILED\.|error CS\d+|: error |Test run summary: Failed!|^\s*failed: [1-9]|gate: (TIMED OUT|STALLED|BACKSTOP)'
$usage = @(
    'usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light [-StallSeconds <n>] [-Tail <n>] [-NoMarkers] ' +
    '-- <command> [args...]'
    '       pwsh tools/gate.ps1 -StopTree <pid>'
)
# The priority classes the fallback lowers for the command: a gate already at below normal or idle is left as it is.
$aboveBelowNormal = @('Normal', 'AboveNormal', 'High', 'RealTime')
# The canonical gate: under CLAUDE_CONFIG_DIR when that names a tree, else under the user's own ~/.claude.
$gatePath = Join-Path ($env:CLAUDE_CONFIG_DIR ?? (Join-Path $HOME '.claude')) 'tools/gate/gate.ps1'

# One line on standard error, the way the gate writes its own.
function Write-Gate {
    param([string]$Line)
    [Console]::Error.WriteLine($Line)
}

# The usage, one line at a time, on standard error.
function Write-Usage {
    foreach ($line in $usage) { Write-Gate $line }
}

# True for a whole number above 0, the gate's own test for a process id in -StopTree and for -Tail here.
function Test-WholeNumber {
    param([string]$Value)
    $number = 0
    $style = [System.Globalization.NumberStyles]::None
    return [int]::TryParse($Value, $style, [cultureinfo]::InvariantCulture, [ref]$number) -and $number -gt 0
}

# Reads the option at $At into $Options; returns how many words it took, or 0 having said why it could not.
function Read-Option {
    param([hashtable]$Options, [object[]]$Words, [int]$At)
    $word = [string]$Words[$At]
    $name = $word.Substring(1)
    if ($name -eq 'NoMarkers') {
        $Options['NoMarkers'] = $true
        return 1
    }
    if (-not $Options.ContainsKey($name)) {
        Write-Gate "gate: cannot read the option $word"
        return 0
    }
    if ($At + 1 -ge $Words.Count) {
        Write-Gate "gate: $word needs a value"
        return 0
    }
    $Options[$name] = [string]$Words[$At + 1]
    return 2
}

# Splits the words into this launcher's options and the command, exactly as gate.ps1 splits them; $null, having said
# why, for an option it cannot read.
function Read-Argument {
    param([object[]]$Words)
    $options = @{ Log = ''; TimeoutSeconds = ''; Slot = ''; StallSeconds = '120'; Tail = '20'; NoMarkers = $false }
    $read = 0
    while ($read -lt $Words.Count) {
        $word = [string]$Words[$read]
        if ($word -eq '--') {
            return @{ Options = $options; Command = @($Words | Select-Object -Skip ($read + 1)) }
        }
        # A caller in its own session had the -- eaten by PowerShell's parser, so the command starts at the first word
        # that is not one of this launcher's options.
        if (-not $word.StartsWith('-')) {
            return @{ Options = $options; Command = @($Words | Select-Object -Skip $read) }
        }
        $taken = Read-Option -Options $options -Words $Words -At $read
        if ($taken -eq 0) { return $null }
        $read += $taken
    }
    return @{ Options = $options; Command = @() }
}

# What the fallback must be given and cannot run without: the log, the command, and a -Tail it can read as a number.
# The options it drops, -TimeoutSeconds and -Slot among them, are read and take their value without being checked.
function Get-InputProblem {
    param([hashtable]$Options, [object[]]$Command)
    $problems = [System.Collections.Generic.List[string]]::new()
    if (-not $Options['Log']) {
        $problems.Add('gate: missing -Log <path>: every gate writes its whole output to a log, e.g. -Log .tmp/test.log')
    }
    if ($Command.Count -lt 1) {
        $problems.Add('gate: missing the command: put it after --, e.g. -- dotnet test')
    }
    $tail = $Options['Tail']
    if ($tail -and -not (Test-WholeNumber $tail)) {
        $problems.Add("gate: -Tail must be a whole number above 0, got '$tail'")
    }
    return , $problems
}

# The command run with & in this process: its output to $Log, its errors to $ErrLog, which is appended to the log and
# removed once the command has ended. Returns the status, and 1 for a command that threw without a status of its own.
function Invoke-GateCommand {
    param([string]$Command, [object[]]$Rest, [string]$Log, [string]$ErrLog)
    # A program and a script file both set the global $LASTEXITCODE, while an assignment in this scope would be
    # shadowed by a variable of its own, so both sides of the run name that scope. A cmdlet or a function never sets
    # one, and leaves the 0 it is given, or the 1 below when it threw.
    $status = 0
    $started = [bool](Get-Command -Name $Command -CommandType Application, ExternalScript -ErrorAction SilentlyContinue)
    $global:LASTEXITCODE = 0
    try {
        & $Command @Rest > $Log 2> $ErrLog
        if ($started) { $status = [int]$global:LASTEXITCODE }
    }
    catch {
        $status = 1
        Add-Content -Path $ErrLog -Value $_.Exception.Message
    }
    if (Test-Path -LiteralPath $ErrLog) {
        $errors = Get-Content -Path $ErrLog -Raw
        if ($errors) { Add-Content -Path $Log -Value $errors }
        Remove-Item -LiteralPath $ErrLog -ErrorAction SilentlyContinue
    }
    return $status
}

# The failure markers with their line numbers, the log's last -Tail lines and the verdict, as the gate prints them;
# returns the status, 1 for a zero exit whose log reports a failure unless -NoMarkers asked for the exit status alone.
function Write-Verdict {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'The tail and the verdict are for the console; the fallback''s output is the log, not the pipeline.')]
    param([hashtable]$Options, [int]$Status, [string]$Log, [double]$Wall)
    $there = Test-Path -LiteralPath $Log
    if ($there -and -not $Options['NoMarkers']) {
        if ($Status -eq 0 -and (Select-String -Path $Log -Pattern $markers -Quiet)) { $Status = 1 }
        if ($Status -ne 0) {
            Select-String -Path $Log -Pattern $markers | Select-Object -First 40 |
                ForEach-Object { Write-Host "$($_.LineNumber):$($_.Line)" }
        }
    }
    if ($there) { Get-Content -Path $Log -Tail ([int]$Options['Tail']) | ForEach-Object { Write-Host $_ } }
    if ($Status -eq 0) { Write-Host "gate: passed in $([math]::Round($Wall)) s. Full output: $Log" }
    else { Write-Gate "gate: FAILED (status $Status). Full output: $Log" }
    return $Status
}

# The command run without the canonical gate: the log, the tail, the status and the markers are kept, the slots and the
# watchdog are not. Returns the status.
function Invoke-Fallback {
    param([hashtable]$Options, [object[]]$Command)
    Write-Gate "gate: $gatePath not found; running without slots or watchdog"
    # Read against the caller's location once, before the command runs, as the gate reads its own -Log.
    $log = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Options['Log'])
    $logDir = Split-Path -Parent $log
    if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
    Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
    $self = Get-Process -Id $PID
    $was = $self.PriorityClass
    $lower = $aboveBelowNormal -contains [string]$was
    try {
        if ($lower) { $self.PriorityClass = 'BelowNormal' }
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        $status = Invoke-GateCommand -Command ([string]$Command[0]) -Rest @($Command | Select-Object -Skip 1) -Log $log `
            -ErrLog "$log.err"
        $wall = $clock.Elapsed.TotalSeconds
    }
    finally {
        if ($lower) { $self.PriorityClass = $was }
    }
    return Write-Verdict -Options $Options -Status $status -Log $log -Wall $wall
}

# The root's descendants deepest first and then the root, read from one Win32_Process snapshot as a chain of parent
# process ids, so a process whose parent has already exited is not among them.
function Get-TreeOrder {
    param([int]$Root)
    $children = @{}
    foreach ($entry in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId)) {
        $parent = [int]$entry.ParentProcessId
        $child = [int]$entry.ProcessId
        if ($children.ContainsKey($parent)) { $children[$parent] = @($children[$parent]) + $child }
        else { $children[$parent] = @($child) }
    }
    $order = [System.Collections.Generic.List[int]]::new()
    Add-Descendant -Node $Root -Children $children -Order $order
    $order.Add($Root)
    return $order
}

# Adds $Node's children to $Order, each after its own children, so the deepest comes first.
function Add-Descendant {
    param([int]$Node, [hashtable]$Children, [System.Collections.Generic.List[int]]$Order)
    if (-not $Children.ContainsKey($Node)) { return }
    foreach ($child in $Children[$Node]) {
        Add-Descendant -Node $child -Children $Children -Order $Order
        $Order.Add($child)
    }
}

# The processes of the tree stopped deepest first, the ones still running named in $Failures; returns how many were
# stopped, a process that was already gone counting as neither.
function Invoke-TreeStop {
    param([int]$Root, [System.Collections.Generic.List[string]]$Failures)
    $stopped = 0
    foreach ($id in (Get-TreeOrder -Root $Root)) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            $stopped++
        }
        catch {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $Failures.Add("$($process.ProcessName) $id") }
        }
    }
    return $stopped
}

# -StopTree <pid>, the whole of the words: the target and the descendants one snapshot shows, stopped deepest first;
# returns the exit status.
function Invoke-StopTree {
    param([object[]]$Words)
    $value = if ($Words.Count -ge 2) { [string]$Words[1] } else { '' }
    $problem = if ($Words.Count -ne 2) { 'gate: -StopTree takes one process id and nothing else' }
    elseif (-not (Test-WholeNumber $value)) { "gate: -StopTree needs a process id, got '$value'" }
    elseif (-not (Get-Process -Id ([int]$value) -ErrorAction SilentlyContinue)) { "gate: -StopTree: no live process has the id $value" }
    if ($problem) {
        Write-Gate $problem
        Write-Usage
        return 2
    }
    $root = [int]$value
    $failures = [System.Collections.Generic.List[string]]::new()
    $stopped = Invoke-TreeStop -Root $root -Failures $failures
    foreach ($failure in $failures) { Write-Gate "gate: could not stop: $failure" }
    [Console]::Out.WriteLine("gate: stopped 0 gate job(s) and $stopped process(es) under $root")
    if ($failures.Count -gt 0) { return 1 }
    return 0
}

# The words of one call: -StopTree alone, or the options, the checks on them and the fallback; returns the exit status.
function Invoke-Main {
    param([object[]]$Words)
    if ($Words.Count -gt 0 -and [string]$Words[0] -eq '-StopTree') { return Invoke-StopTree $Words }
    $parsed = Read-Argument $Words
    $problems = if ($parsed) { Get-InputProblem -Options $parsed.Options -Command $parsed.Command } else { @() }
    if (-not $parsed -or $problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-Gate $problem }
        Write-Usage
        return 2
    }
    return Invoke-Fallback -Options $parsed.Options -Command $parsed.Command
}

# The canonical gate when the machine has one: every word, -StopTree and the separator included, is handed to it in
# this same process, so nothing about the call changes.
if (Test-Path -LiteralPath $gatePath) {
    & $gatePath @args
    exit ([int]$LASTEXITCODE)
}
exit (Invoke-Main -Words $args)
