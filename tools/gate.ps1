#requires -Version 7.3

<#
.SYNOPSIS
The repo's pass-through to gate.exe: it hands every word to the installed gate when the machine has one, and on a clone
without it runs the command directly.

.DESCRIPTION
Callers run `pwsh -NoProfile -File tools/gate.ps1 ...` or `& tools/gate.ps1 ...`, in either spelling gate.exe reads:
the PowerShell form `-Log <path> -TimeoutSeconds <n> -Slot <kind> [...] -- <command>` or the CLI form
`run --log <path> --timeout <n> --slot <kind> [...] -- <command>`, and the other subcommands such as `stop-tree <pid>`.

The gate.exe it runs: `$env:GATE_BOX_EXE` when it is set and not empty (a command inside a routed run on a builder),
which must be a fully qualified path to a file; otherwise the launcher says `gate: GATE_BOX_EXE names <value>, which is
not a gate.exe here` on standard error and exits 127. With it unset or empty, the first that exists of
`<Program Files root>\gate\bin\gate.exe` (a builder's admin install) and `$env:LOCALAPPDATA\gate\bin\gate.exe` (the
user's install). The Program Files root is `$env:GATE_LAUNCHER_PROGRAM_FILES` when it is set and not empty, since
Windows sets `$env:ProgramFiles` afresh in every process, and `$env:ProgramFiles` otherwise. PATH is not searched.

Every word goes to gate.exe as the caller gave it, -StopTree included. A caller whose session ate the -- gets it put back
before the first command word, and the -name:value words the session split after it joined again; a call whose first
word is a subcommand goes as it came, except a `run` whose -- was eaten, which gets it back the same way. The launcher
prints nothing of its own: gate.exe's lines are the whole output. A Ctrl+C reaches gate.exe while the launcher ignores
it, waits for gate.exe to end and exits with its whole status.

With no gate.exe found it says `gate: no gate.exe found; running the command without slots or watchdog` on standard
error and runs the command itself, in this process. A leading `run` selects the CLI form. With a -- among the option
words the command is exactly the words after it; when the caller's session ate the --, it is every word from the first
that is neither an option nor an option's value, a -name: word split from its value joined back. Of the options only
-Cd/--cd, the command's working folder, and -Env/--env NAME=VALUE, a variable set for the command and restored after
it, are used; a GATE_ name is refused with exit 2. There is no log, no tail, no failure markers, no slot and no
watchdog. The launcher exits with the command's status: a program's own, 0 for a PowerShell command that succeeded and
1 for one that failed. -StopTree and stop-tree cannot run without gate.exe: they say so and exit 1. With no command
words the launcher prints its usage and exits 2. -Reason/--reason "<why>" is required by gate.exe with -Local/--local,
-Slot critical/--slot critical and -Alone/--alone; the launcher passes it through and checks nothing itself.

The options are read by hand out of $args rather than declared in a param block: a declared block sends the bare -- of
a caller's command through PowerShell's parameter binder, which reads it as a parameter name and stops. A caller that
starts this launcher with -File gives the binder a -name:value word to split in $args, where the process argv keeps it
whole, so the words are read from the argv in that case.

Usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light|critical|none [-StallSeconds <n>] [-Tail <n>]
           [-NoMarkers] [-Local] [-Alone] [-Reason "<why>"] [-Cd <folder>] [-Env NAME=value] -- <command> [args...]
       pwsh tools/gate.ps1 run --log <path> --timeout <n> --slot heavy|light|critical|none [--alone] [--reason "<why>"]
           [options] -- <command> [args...]
       pwsh tools/gate.ps1 -StopTree <pid>
       pwsh tools/gate.ps1 stop-tree <pid>
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A native command's status is the launcher's to report: a caller's $true must not turn a non-zero exit into a throw.
$PSNativeCommandUseErrorActionPreference = $false

$usage = @(
    'usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light|critical|none [-StallSeconds <n>] [-Tail <n>] ' +
    '[-NoMarkers] [-Local] [-Alone] [-Reason "<why>"] [-Cd <folder>] [-Env NAME=value] -- <command> [args...]'
    '       pwsh tools/gate.ps1 run --log <path> --timeout <n> --slot heavy|light|critical|none [--alone] [--reason "<why>"] ' +
    '[options] -- <command> [args...]'
    '       pwsh tools/gate.ps1 -StopTree <pid>'
    '       pwsh tools/gate.ps1 stop-tree <pid>'
)
# How the launcher reads each spelling's options when it must find the command itself: the PowerShell form's -Name and
# -Name:value, and the CLI form's --name and --name=value after a leading `run`. Option names compare as PowerShell
# compares strings, ignoring case.
$spellings = @{
    Compat = @{
        Prefix = '-'
        Joiner = ':'
        Values = @('Log', 'TimeoutSeconds', 'Slot', 'StallSeconds', 'Tail', 'Reason', 'Cd', 'Env')
        Flags = @('NoMarkers', 'Local', 'Alone')
    }
    Cli = @{
        Prefix = '--'
        Joiner = '='
        Values = @('log', 'timeout', 'slot', 'stall', 'tail', 'reason', 'cd', 'env', 'bring-tracked', 'state-dir')
        Flags = @('no-markers', 'local', 'alone')
    }
}

# One line on standard error, the way the gate writes its own.
function Write-Gate {
    param([string]$Line)
    [Console]::Error.WriteLine($Line)
}

# The usage, one line at a time, on standard error.
function Write-Usage {
    foreach ($line in $usage) { Write-Gate $line }
}

# The argv index of this process's own script file, or -1 when the call names none: the entry right after a -File form,
# or the first entry that is not one of pwsh's own switches when there is no -File. A -Command/-EncodedCommand call
# names no script file at all, and a switch pwsh gives a value of its own (an execution policy, a working directory, a
# configuration name) has that value skipped with it.
function Get-ScriptArgument {
    param([string[]]$Argv)
    $command = '^[-/](c(o(m(m(a(nd?)?)?)?)?)?|e(n(c(o(d(e(d(c(o(m(m(a(nd?)?)?)?)?)?)?)?)?)?)?)?)?|ec)$'
    $withValue = '^[-/](ex|executionpolicy|wd|workingdirectory|config|configurationname|settingsfile' +
        '|o|of|outputformat|if|inputformat|w|windowstyle|custompipename)$'
    $index = 1
    while ($index -lt $Argv.Count) {
        $word = [string]$Argv[$index]
        if ($word -match '^[-/]f(i(le?)?)?$') {
            if ($index + 1 -lt $Argv.Count) { return $index + 1 }
            return -1
        }
        if ($word -match $command) { return -1 }
        if ($word -notmatch '^[-/]') { return $index }
        if ($word -match $withValue) { $index += 2 } else { $index++ }
    }
    return -1
}

# The words this call was given. A caller that starts this script with `pwsh -File` has PowerShell's binder split a
# -name:value word of the call inside $args, so the process argv, which keeps every word whole, is read instead: the
# words are every argv entry after this script's own file argument. A call that never names this script as its file
# argument - an in-session `& script.ps1` call, an in-process call from another script, a caller whose own -File script
# holds this path as one of its arguments - gets $args as it always did.
function Get-RawWord {
    param([object[]]$Fallback)
    $argv = [Environment]::GetCommandLineArgs()
    $at = Get-ScriptArgument -Argv $argv
    if ($at -lt 0) { return @($Fallback) }
    $full = $null
    # An entry that is not a legal path resolves to nothing and is simply not this script's own file argument.
    try { $full = [System.IO.Path]::GetFullPath([string]$argv[$at], [Environment]::CurrentDirectory) }
    catch { $full = $null }
    $mine = [System.IO.Path]::GetFullPath($PSCommandPath)
    if ($full -and [string]::Equals($full, $mine, [System.StringComparison]::OrdinalIgnoreCase)) {
        return @($argv | Select-Object -Skip ($at + 1))
    }
    return @($Fallback)
}

# A caller that splats an array holding one array, as `& $gate ... -- @cmd` does, hands one word of the call a list of
# its own; the launcher passes it on the way a native call would, replacing every element that is itself a list, and not
# a string, by its elements, recursively, and dropping a null as a native call drops it, so a whole command is never
# joined into one program name. A string is one word and is never split.
function Expand-Word {
    param([object[]]$Words)
    $flat = [System.Collections.Generic.List[object]]::new()
    foreach ($word in $Words) {
        if ($null -eq $word) { continue }
        if ($word -is [string] -or $word -isnot [System.Collections.IEnumerable]) { $flat.Add($word); continue }
        foreach ($item in (Expand-Word -Words @($word))) { $flat.Add($item) }
    }
    return $flat.ToArray()
}

# Reads the option at $At into $Options; returns how many words it took, or 0 with the reason it could not added to
# $Problems. An option written -Name:value, as one word from the raw argv, is read as that option and its value in that
# one word.
function Read-Option {
    param([hashtable]$Options, [object[]]$Words, [int]$At, [System.Collections.Generic.List[string]]$Problems)
    $word = [string]$Words[$At]
    $name = $word.Substring(1)
    $value = $null
    $colon = $name.IndexOf(':')
    if ($colon -ge 0 -and $colon + 1 -lt $name.Length) {
        $value = $name.Substring($colon + 1)
        $name = $name.Substring(0, $colon)
    }
    if ($name -in 'NoMarkers', 'Local', 'Alone') {
        $Options[$name] = $true
        return 1
    }
    if (-not $Options.ContainsKey($name)) {
        $Problems.Add("gate: cannot read the option $word")
        return 0
    }
    if ($null -ne $value) {
        $Options[$name] = $value
        return 1
    }
    if ($At + 1 -ge $Words.Count) {
        $Problems.Add("gate: $word needs a value")
        return 0
    }
    $Options[$name] = [string]$Words[$At + 1]
    return 2
}

# Rejoins a word like `-p:` with the one after it, giving `-p:Foo=Bar`, because PowerShell itself splits a -name:value
# word that follows a bare -- in a session's own call into -name: and value before the launcher ever sees it. A word of
# fewer than three characters, one not starting with - or not ending with :, and a trailing one with nothing after it
# are left as they are, and one join is made per pair so a joined word is not joined again.
function Join-ColonWord {
    param([object[]]$Words)
    $joined = [System.Collections.Generic.List[string]]::new()
    $index = 0
    while ($index -lt $Words.Count) {
        $word = [string]$Words[$index]
        if ($word.Length -ge 3 -and $word.StartsWith('-') -and $word.EndsWith(':') -and $index + 1 -lt $Words.Count) {
            $joined.Add($word + [string]$Words[$index + 1])
            $index += 2
            continue
        }
        $joined.Add($word)
        $index++
    }
    return $joined.ToArray()
}

# Reads the PowerShell form's options from the front of the words, as gate.exe's compatibility layer reads them, up to
# where the command starts: Options, the options read; Dash, whether a -- is there; At, the index of that --, or, when
# the caller's session ate it, of the first word that is not one of the options, the word count when there is no
# command, and -1, with the reason added to $Problems, at an option it cannot read.
function Find-CommandStart {
    param([object[]]$Words, [System.Collections.Generic.List[string]]$Problems)
    $options = @{
        Log = ''; TimeoutSeconds = ''; Slot = ''; StallSeconds = '120'; Tail = '20'; NoMarkers = $false; Local = $false; Alone = $false
        Reason = ''; Cd = ''; Env = ''
    }
    $read = 0
    while ($read -lt $Words.Count) {
        $word = [string]$Words[$read]
        if ($word -eq '--') { return @{ Options = $options; Dash = $true; At = $read } }
        # A caller in its own session had the -- eaten by PowerShell's parser, so the command starts at the first word
        # that is not one of this launcher's options.
        if (-not $word.StartsWith('-')) { return @{ Options = $options; Dash = $false; At = $read } }
        $taken = Read-Option -Options $options -Words $Words -At $read -Problems $Problems
        if ($taken -eq 0) { return @{ Options = $options; Dash = $false; At = -1 } }
        $read += $taken
    }
    return @{ Options = $options; Dash = $false; At = $Words.Count }
}

# Reads the option at $At in $Spelling, adding a -Cd folder and an -Env word to $Found; returns how many words it took,
# or 0 when the word is not one of the spelling's options. A value option takes its value from the same word after the
# spelling's joiner, or, when that is empty, from the next word.
function Read-DirectOption {
    param([hashtable]$Found, [object[]]$Words, [int]$At, [hashtable]$Spelling)
    $word = [string]$Words[$At]
    if (-not $word.StartsWith($Spelling.Prefix) -or $word -eq '--') { return 0 }
    $name = $word.Substring($Spelling.Prefix.Length)
    $value = ''
    $cut = $name.IndexOf($Spelling.Joiner)
    if ($cut -ge 0) {
        $value = $name.Substring($cut + 1)
        $name = $name.Substring(0, $cut)
    }
    if ($name -in $Spelling.Flags) { return 1 }
    if ($name -notin $Spelling.Values) { return 0 }
    $taken = 1
    if (-not $value) {
        if ($At + 1 -ge $Words.Count) { return 0 }
        $value = [string]$Words[$At + 1]
        $taken = 2
    }
    if ($name -eq 'Cd') { $Found.Cd = $value }
    elseif ($name -eq 'Env') { $Found.Env.Add($value) }
    return $taken
}

# Where the command starts among the words read from $At in $Spelling: Dash, whether a -- ended the options; At, the
# index of the first command word; Cd, the last -Cd folder or $null; Env, the -Env words in order. A word the spelling
# does not know is skipped as a flag when $SkipUnknown is set or a -- follows it, and is otherwise the command's first
# word, as is the first word that is neither an option nor an option's value.
function Find-DirectStart {
    param([object[]]$Words, [int]$At, [hashtable]$Spelling, [bool]$SkipUnknown)
    $found = @{ Dash = $false; At = $Words.Count; Cd = $null; Env = [System.Collections.Generic.List[string]]::new() }
    $later = [array]::IndexOf([string[]]@($Words | ForEach-Object { [string]$_ }), '--', [Math]::Min($At, $Words.Count))
    $read = $At
    while ($read -lt $Words.Count) {
        $word = [string]$Words[$read]
        if ($word -eq '--') {
            $found.Dash = $true
            $found.At = $read + 1
            return $found
        }
        $taken = Read-DirectOption -Found $found -Words $Words -At $read -Spelling $Spelling
        if ($taken -eq 0 -and $word.StartsWith('-') -and ($SkipUnknown -or $later -gt $read)) { $taken = 1 }
        if ($taken -eq 0) {
            $found.At = $read
            return $found
        }
        $read += $taken
    }
    return $found
}

# A Ctrl+C handler that cancels the break for this process, compiled from an expression tree: Ctrl+C runs it on a
# thread with no runspace, where a script block cannot run and takes pwsh down.
function New-BreakIgnorer {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'It builds a handler and changes no state; the caller registers it.')]
    param()
    $breakArgs = [System.Linq.Expressions.Expression]::Parameter([ConsoleCancelEventArgs], 'e')
    $source = [System.Linq.Expressions.Expression]::Parameter([object], 'sender')
    $cancel = [System.Linq.Expressions.Expression]::Assign(
        [System.Linq.Expressions.Expression]::Property($breakArgs, 'Cancel'), [System.Linq.Expressions.Expression]::Constant($true))
    $parameters = [System.Linq.Expressions.ParameterExpression[]]@($source, $breakArgs)
    return [System.Linq.Expressions.Expression]::Lambda[ConsoleCancelEventHandler]($cancel, $parameters).Compile()
}

# The words gate.exe is given: the caller's as they came, or, when the caller's session ate the --, the same words with
# the -- put back before the first command word and the command's -name:value words the session split joined again. A
# call whose first word is a subcommand goes as it came, but for a `run` whose --, read in the CLI form, was eaten; a
# word that form does not know, such as one of gate.exe's hidden switches, is read as a flag.
function Get-HandOverWord {
    param([object[]]$Words)
    if ($Words.Count -eq 0) { return $Words }
    $first = [string]$Words[0]
    if ($first -eq 'run') { $found = Find-DirectStart -Words $Words -At 1 -Spelling $spellings.Cli -SkipUnknown $true }
    elseif ($first.StartsWith('-')) {
        $found = Find-CommandStart -Words $Words -Problems ([System.Collections.Generic.List[string]]::new())
    }
    else { return $Words }
    if ($found.Dash -or $found.At -lt 0 -or $found.At -ge $Words.Count) { return $Words }
    $options = @($Words | Select-Object -First $found.At)
    $command = @(Join-ColonWord @(Expand-Word -Words @($Words | Select-Object -Skip $found.At)))
    return $options + @('--') + $command
}

# The gate.exe to hand over to, or $null when there is none. A GATE_BOX_EXE that is set and not empty is the only one
# looked at, and one that is not a fully qualified path to a file ends the launcher with exit 127; otherwise the first
# file that exists of the Program Files root's install and LOCALAPPDATA's, an unset or empty variable skipped.
function Find-GateExe {
    $box = $env:GATE_BOX_EXE
    if ($box) {
        if ([System.IO.Path]::IsPathFullyQualified($box) -and (Test-Path -LiteralPath $box -PathType Leaf)) { return $box }
        Write-Gate "gate: GATE_BOX_EXE names $box, which is not a gate.exe here"
        exit 127
    }
    # Windows sets ProgramFiles afresh in every process, so a caller cannot move it; the override can.
    $programFiles = if ($env:GATE_LAUNCHER_PROGRAM_FILES) { $env:GATE_LAUNCHER_PROGRAM_FILES } else { $env:ProgramFiles }
    $candidates = @(
        if ($programFiles) { Join-Path $programFiles 'gate\bin\gate.exe' }
        if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'gate\bin\gate.exe' }
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

# The direct run's plan: Command, the command words; Cd, the folder to run it in or $null; Env, the -Env words. A
# leading `run` selects the CLI form. With a -- among the option words the command is exactly the words after it;
# without one, it starts at the first word that is neither an option nor an option's value, and a -name: word the
# caller's session split from its value is joined back.
function Read-DirectCommand {
    param([object[]]$Words)
    $cli = $Words.Count -gt 0 -and [string]$Words[0] -eq 'run'
    $spelling = if ($cli) { $spellings.Cli } else { $spellings.Compat }
    $found = Find-DirectStart -Words $Words -At ([int]$cli) -Spelling $spelling -SkipUnknown $false
    $rest = @($Words | Select-Object -Skip $found.At)
    $command = if ($found.Dash) { $rest } else { @(Join-ColonWord $rest) }
    return @{ Command = @($command); Cd = $found.Cd; Env = $found.Env }
}

# The pid word of a -StopTree <pid>, -StopTree:<pid> or stop-tree <pid> call, '' when it gives none; $null for any
# other call.
function Get-StopTreeTarget {
    param([object[]]$Words)
    if ($Words.Count -eq 0) { return $null }
    $first = [string]$Words[0]
    if ($first -match '^-StopTree:(.+)$') { return $Matches[1] }
    if ($first -notin '-StopTree', '-StopTree:', 'stop-tree') { return $null }
    if ($Words.Count -ge 2) { return [string]$Words[1] }
    return ''
}

# The name of the first -Env word that names a GATE_ variable, in any case, or $null: those are the gate's own.
function Find-RefusedName {
    param([System.Collections.Generic.List[string]]$Pairs)
    foreach ($pair in $Pairs) {
        $equals = $pair.IndexOf('=')
        $name = if ($equals -ge 0) { $pair.Substring(0, $equals) } else { $pair }
        if ($name -like 'GATE_*') { return $name }
    }
    return $null
}

# Sets each NAME=VALUE pair for the command in this process and returns each variable's earlier value, $null for one
# that was not set, in the order set. A pair with no name before its = sets nothing, and a bare NAME, the form that
# forwards the caller's own value, is already the command's.
function Add-CommandVariable {
    param([System.Collections.Generic.List[string]]$Pairs)
    $saved = [System.Collections.Generic.List[object]]::new()
    foreach ($pair in $Pairs) {
        $equals = $pair.IndexOf('=')
        if ($equals -le 0) { continue }
        $name = $pair.Substring(0, $equals)
        $saved.Add(@{ Name = $name; Value = [Environment]::GetEnvironmentVariable($name) })
        [Environment]::SetEnvironmentVariable($name, $pair.Substring($equals + 1))
    }
    return , $saved
}

# Puts back the variables Add-CommandVariable set, last first, so a name set twice gets its first earlier value.
function Restore-CommandVariable {
    param([System.Collections.Generic.List[object]]$Saved)
    for ($index = $Saved.Count - 1; $index -ge 0; $index--) {
        [Environment]::SetEnvironmentVariable($Saved[$index].Name, $Saved[$index].Value)
    }
}

# Runs the command words with & in this process, its output the launcher's own, and leaves its status in the global
# $LASTEXITCODE: a program's or a script file's own, 0 for any other command that succeeded and 1 for one that threw.
function Invoke-Direct {
    param([object[]]$Command)
    $first = [string]$Command[0]
    $rest = @($Command | Select-Object -Skip 1)
    $started = [bool](Get-Command -Name $first -CommandType Application, ExternalScript -ErrorAction SilentlyContinue)
    $global:LASTEXITCODE = 0
    try {
        & $first @rest
        if (-not $started) { $global:LASTEXITCODE = 0 }
    }
    catch {
        Write-Gate "gate: $($_.Exception.Message)"
        $global:LASTEXITCODE = 1
    }
}

# With no gate.exe: a stop-tree refused, the usage for a call with no command, a GATE_ -Env name refused, else the
# command run directly in its -Cd folder with its -Env pairs, which are put back after it; exits with the status.
function Invoke-WithoutGate {
    param([object[]]$Words)
    $target = Get-StopTreeTarget -Words $Words
    if ($null -ne $target) {
        Write-Gate "gate: no gate.exe found; cannot stop the tree of $target"
        exit 1
    }
    $plan = Read-DirectCommand -Words $Words
    if ($plan.Command.Count -lt 1) {
        Write-Gate 'gate: missing the command: put it after --, e.g. -- dotnet test'
        Write-Usage
        exit 2
    }
    $refused = Find-RefusedName -Pairs $plan.Env
    if ($refused) {
        Write-Gate "gate: -Env cannot set GATE_ names: $refused"
        exit 2
    }
    Write-Gate 'gate: no gate.exe found; running the command without slots or watchdog'
    if ($plan.Cd) {
        try { Push-Location -LiteralPath $plan.Cd }
        catch {
            Write-Gate "gate: cannot enter the -Cd folder $($plan.Cd): $($_.Exception.Message)"
            exit 2
        }
    }
    $saved = Add-CommandVariable -Pairs $plan.Env
    try { Invoke-Direct -Command $plan.Command }
    finally {
        Restore-CommandVariable -Saved $saved
        if ($plan.Cd) { Pop-Location }
    }
    exit $global:LASTEXITCODE
}

$words = @(Get-RawWord -Fallback $args)
$gateExe = Find-GateExe
if (-not $gateExe) { Invoke-WithoutGate -Words @(Expand-Word -Words $words) }
# Each word reaches gate.exe as itself, whatever quoting rule the caller's session set.
$PSNativeCommandArgumentPassing = 'Standard'
$ignoreBreak = New-BreakIgnorer
[Console]::add_CancelKeyPress($ignoreBreak)
try { & $gateExe @(Get-HandOverWord -Words $words) }
finally { [Console]::remove_CancelKeyPress($ignoreBreak) }
exit $LASTEXITCODE
