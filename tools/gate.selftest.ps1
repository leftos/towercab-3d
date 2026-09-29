#requires -Version 7
<#
.SYNOPSIS
Runs tools/gate.ps1 through the cases its watchdog, job, slots, priority and usage have to get right, and exits 1 when
any case fails.

.DESCRIPTION
The canonical copy is ~/.claude/tools/gate/gate.selftest.ps1: change it there and run sync-gate.ps1, which copies it
and gate.ps1 into every repo that carries them.

Each case starts the gate as a caller would, `pwsh -NoProfile -File tools/gate.ps1 ... -Slot light ...`, every command
here being serial, with a log under .tmp/gate-selftest, and prints `ok <case>` or `FAIL <case>: <why>`. The gate samples
every second here (GATE_SAMPLE_SECONDS=1) so the stall and ceiling cases end in seconds. Every case but the slot cases
and the nesting case runs with GATE_SLOT_HELD=1, so the self-test never waits on, or holds up, the gates other sessions
are running; the slot cases and the nesting case set GATE_TEST_SLOT_PREFIX to a prefix of this run's own, so their
gates take slots no other session's gate can hold. The cases that leave a process behind on purpose write its pid to a
file, check it by pid and stop it by pid afterwards. Each gate started as its own process gets 90 s of wall time,
after which the case fails and the gate is killed with its tree. A case whose verdict rests on timing and fails while
its log says the machine was under 30% free prints `skip <case>: machine busy (free <p>%)` instead of failing: a kill
line gives the free share outright, a passed line as the load-adjusted time over the wall time.

The cases run side by side, each set in a pwsh of its own, so a case that changes its session's environment, location
or priority changes only its own. Most spend their time waiting rather than computing, and each of those runs in a
process of its own, at most half as many at once as there are logical processors, scaled down by the share of the
machine free when the self-test starts (measured over a second) and never fewer than two. The self-test runs below normal
priority while they do, so the processes it starts, which inherit that, do not starve the commands, which run below
normal too, while they start. The cases whose command keeps a core busy
and whose verdict rests on that CPU time (CPU, a grandchild's, a packaged child's, a nested job's, short-lived children's
and the ceiling) run one after another in a single process once those are done, so that none of them shares the machine
with another. The slot cases and the nesting case run one after another in a process of their own from the start, since
they take the machine's slots and wait rather than compute, and the failing-sampler case runs last in that process: its
gates cannot say how busy the machine was, so its timing gets no skip, and by then the waiting cases have ended. Each
process's lines are printed once it and every one before it in that order has finished, so the output reads the same
from run to run.

The backstop is reached only through GATE_TEST_SAMPLER_FAIL, the gate's one test hook: tripping it with a working
sampler takes a machine busy enough that five times the ceiling passes in wall time before the ceiling does on the
load-adjusted clock, which this script cannot arrange. The race between a command's own exit and a kill is not covered:
no case can make the command exit inside the few milliseconds between the sample and the kill every time.

A plain script rather than Pester: the Pester on this machine is the in-box 3.4.

.PARAMETER Case
Runs only the cases named, one after another in this process: Test-* functions of this script's list of cases, as an
array or as one comma-separated word. Without it every case runs, side by side as above.
#>
[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'Interactive dev script; one ok or FAIL line a case on the console is the UX.')]
param([string[]]$Case)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root
$dir = '.tmp/gate-selftest'
New-Item -ItemType Directory -Force $dir | Out-Null
$gate = Join-Path $PSScriptRoot 'gate.ps1'
$selfTest = $PSCommandPath
$script:failed = 0
# The wall time a process holding a set of cases gets before it is killed with its tree and its cases fail.
$caseSeconds = 600
# The cases that wait rather than compute, each in a process of its own, the longest first.
$waitingCases = @(
    'Test-QuickExit', 'Test-NestedKill', 'Test-Stall', 'Test-OldServer', 'Test-StopTree', 'Test-OrphanKill',
    'Test-PackagedKill', 'Test-OutputProgress', 'Test-RelativeLog', 'Test-StopJob', 'Test-BuildEnvironment',
    'Test-Status', 'Test-Argument', 'Test-Priority', 'Test-Usage', 'Test-OldNativeType', 'Test-NativeCache'
)
# The cases whose command keeps a core busy and whose verdict rests on it, one after another.
$cpuCases = @('Test-CpuProgress', 'Test-OrphanProgress', 'Test-PackagedProgress', 'Test-NestedJob', 'Test-ShortLivedChild', 'Test-Ceiling')
# The cases that take the machine's slots, one after another, and last the failing-sampler case: its gates cannot say
# how busy the machine was, so it has no skip to fall back on, and by then the waiting cases' processes have ended.
$slotCases = @('Test-Slot', 'Test-SlotPool', 'Test-Nesting', 'Test-SamplerFailure')
# The prefix every slot case's gates put in front of their mutex names (GATE_TEST_SLOT_PREFIX), so that no other
# session's gate holds the slots they use, and slot 0 of each kind under it, the one a gate of the kind takes first.
$slotPrefix = "selftest-$PID-"
$slotZero = @{ heavy = "Local\${slotPrefix}gate-slot-0"; light = "Local\${slotPrefix}gate-light-slot-0" }

function Write-Result {
    param([string]$Case, [string]$Why)
    if ($Why) {
        Write-Host "FAIL ${Case}: $Why" -ForegroundColor Red
        $script:failed++
        return
    }
    Write-Host "ok $Case" -ForegroundColor Green
}

# Starts pwsh with each word one argument of its own, in the self-test's root, without a window, its standard output
# and error read as it runs; returns the process, the two reads and a clock started with it.
function Start-Pwsh {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Starts a process of this run''s own; there is no system state for a caller to confirm.')]
    param([string[]]$Words)
    $info = [System.Diagnostics.ProcessStartInfo]::new('pwsh')
    foreach ($word in $Words) { $info.ArgumentList.Add($word) }
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $process = [System.Diagnostics.Process]::Start($info)
    return [pscustomobject]@{
        Process = $process
        Out     = $process.StandardOutput.ReadToEndAsync()
        Err     = $process.StandardError.ReadToEndAsync()
        Clock   = $clock
    }
}

# What a redirected stream held. A process the one that owned it started can hold it open after that one has ended,
# so the read is given 10 s past the end.
function Get-StreamText {
    param([System.Threading.Tasks.Task[string]]$Read)
    if ($Read.Wait(10000)) { return $Read.Result }
    return '(the stream was still open 10 s after the process ended)'
}

# Waits for a process Start-Pwsh started, until $Seconds after its start, and kills it with its tree past that; returns
# its status (-1 when killed), how long it ran, what it printed on each stream and whether it ran out of time.
function Complete-Pwsh {
    param($Started, [int]$Seconds)
    $process = $Started.Process
    $left = [math]::Max(0, $Seconds * 1000 - $Started.Clock.ElapsedMilliseconds)
    $finished = $process.WaitForExit([int]$left)
    if (-not $finished) {
        $process.Kill($true)
        $null = $process.WaitForExit(5000)
    }
    $ran = if ($finished) { ($process.ExitTime - $process.StartTime).TotalSeconds } else { $Started.Clock.Elapsed.TotalSeconds }
    $result = [pscustomobject]@{
        Status   = if ($finished) { $process.ExitCode } else { -1 }
        Seconds  = $ran
        Out      = Get-StreamText $Started.Out
        Err      = Get-StreamText $Started.Err
        TimedOut = -not $finished
    }
    $process.Dispose()
    return $result
}

function Start-Gate {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Starts a gate of this run''s own; there is no system state for a caller to confirm.')]
    param([string[]]$Arguments)
    return Start-Pwsh -Words (@('-NoProfile', '-File', $gate) + $Arguments)
}

# A gate Start-Gate started, run to its end or for 90 s of wall time at most; its status, how long it ran, what it
# wrote to standard error and whether it ran out of time.
function Complete-Gate {
    param($Started)
    return Complete-Pwsh -Started $Started -Seconds 90
}

function Invoke-Gate {
    param([string[]]$Arguments)
    return Complete-Gate (Start-Gate -Arguments $Arguments)
}

function Get-LogText {
    param([string]$Case)
    $log = Join-Path $dir "$Case.log"
    if (-not (Test-Path $log)) { return '' }
    return [string](Get-Content -Path $log -Raw)
}

# Why a finished run is wrong: its status is not the one expected, or its log lacks a line it must hold; $null when
# neither.
function Get-RunProblem {
    param([string]$Case, $Run, [int]$Expected, [string]$Holds)
    if ($Run.TimedOut) { return 'the gate did not return in 90 s' }
    if ($Run.Status -ne $Expected) { return "exit $($Run.Status), expected $Expected; see $dir/$Case.log" }
    if ($Holds -and (Get-LogText $Case) -notmatch $Holds) { return "the log has no '$Holds'; see $dir/$Case.log" }
    return $null
}

# The gate's words for a run with -Log, -TimeoutSeconds, -StallSeconds and a light slot set and a pwsh script after --.
function Get-RunArgument {
    param([string]$Case, [int]$Timeout, [int]$Stall, [string]$Script)
    return @('-Log', "$dir/$Case.log", '-TimeoutSeconds', "$Timeout", '-StallSeconds', "$Stall", '-Slot', 'light', '--',
        'pwsh', '-NoProfile', '-c', $Script)
}

# A run of Get-RunArgument's, checked for its status and, when given, a line its log must hold.
function Test-Run {
    [CmdletBinding(PositionalBinding = $false)]
    param([string]$Case, [int]$Timeout, [int]$Stall, [string]$Script, [int]$Expected, [string]$Holds)
    $run = Invoke-Gate -Arguments (Get-RunArgument -Case $Case -Timeout $Timeout -Stall $Stall -Script $Script)
    $why = Get-RunProblem -Case $Case -Run $run -Expected $Expected -Holds $Holds
    return [pscustomobject]@{ Why = $why; Seconds = $run.Seconds }
}

# The pid a case's process wrote to its file, or 0 when it never did.
function Read-Pid {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return 0 }
    $text = (Get-Content -Path $Path -Raw)
    if (-not $text) { return 0 }
    return [int]$text.Trim()
}

function Test-Alive {
    param([int]$Id)
    return $Id -gt 0 -and [bool](Get-Process -Id $Id -ErrorAction SilentlyContinue)
}

# The share of the machine free that a case's log gives last, or -1 when it gives none. A kill line gives it outright; a
# passed line, such as an inner gate's in the log of the gate around it, gives it as the load-adjusted time over the wall
# time.
function Get-LogFreeShare {
    param([string]$Case)
    $text = Get-LogText $Case
    $found = [regex]::Matches($text, 'machine free (\d+)% on average')
    if ($found.Count -gt 0) { return [int]$found[$found.Count - 1].Groups[1].Value }
    $passed = [regex]::Matches($text, 'gate: passed in (\d+) s \(load-adjusted (\d+) s')
    if ($passed.Count -eq 0) { return -1 }
    $last = $passed[$passed.Count - 1]
    $wall = [int]$last.Groups[1].Value
    if ($wall -le 0) { return -1 }
    return [int][math]::Round(100 * [int]$last.Groups[2].Value / $wall)
}

# A case whose verdict rests on timing: one that failed while its log says the machine was under 30% free is reported
# as skipped, since other sessions' load rather than the gate made it late.
function Write-TimedResult {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'Interactive dev script; one ok, skip or FAIL line a case on the console is the UX.')]
    param([string]$Case, [string]$LogCase, [string]$Why)
    $free = Get-LogFreeShare $LogCase
    if ($Why -and $free -ge 0 -and $free -lt 30) {
        Write-Host "skip ${Case}: machine busy (free $free%)" -ForegroundColor Yellow
        return
    }
    Write-Result $Case $Why
}

# Stops a process a case left running on purpose, by the pid it wrote.
function Stop-Leftover {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Stops only the process this self-test started, by the pid it wrote.')]
    param([int]$Id)
    if (Test-Alive $Id) { Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue }
}

function Test-Stall {
    $run = Test-Run -Case 'stall' -Timeout 60 -Stall 3 -Script 'Start-Sleep 30' -Expected 124 -Holds 'gate: STALLED'
    $why = $run.Why
    if (-not $why -and $run.Seconds -ge 12) { $why = "took $([math]::Round($run.Seconds)) s, expected under 12 s" }
    if (-not $why -and (Get-LogText 'stall') -notmatch 'gate: STALLED: .*\(machine free \d+% on average\)') {
        $why = "the STALLED line gives no share of the machine free; see $dir/stall.log"
    }
    Write-TimedResult -Case 'silent sleep is killed as stalled' -LogCase 'stall' -Why $why
}

# A build server left running by an earlier build keeps gaining CPU; it must not keep a hung command alive. The stand-in
# is cmd.exe copied under the server's name and spinning through a loop that ends on its own after about 30 s, started
# before the gate.
function Test-OldServer {
    $server = Join-Path $dir 'VBCSCompiler.exe'
    Copy-Item -Path (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $server -Force
    $spin = Start-Process -FilePath $server -ArgumentList '/d', '/c', '"for /l %i in (1,1,60000000) do @rem"' -PassThru -WindowStyle Hidden
    try {
        Start-Sleep -Seconds 1
        $run = Test-Run -Case 'old-server' -Timeout 60 -Stall 3 -Script 'Start-Sleep 30' -Expected 124 -Holds 'gate: STALLED'
    }
    finally {
        if (-not $spin.HasExited) { $spin.Kill() }
    }
    $why = $run.Why
    if (-not $why -and $run.Seconds -ge 12) { $why = "took $([math]::Round($run.Seconds)) s, expected under 12 s" }
    Write-TimedResult -Case 'a build server started before the gate does not count as progress' -LogCase 'old-server' -Why $why
}

function Test-OutputProgress {
    $script = '1..8 | ForEach-Object { [Console]::Out.WriteLine($_); Start-Sleep 1 }'
    $run = Test-Run -Case 'output' -Timeout 60 -Stall 3 -Script $script -Expected 0
    Write-TimedResult -Case 'output counts as progress' -LogCase 'output' -Why $run.Why
}

# The busy cases below keep their command busy for 6 s against a 3 s stall window sampled every second: a gate that did
# not count what the case counts would kill the command about 4 s after its last other progress, 2 s before it ends.
function Test-CpuProgress {
    $script = '$end = (Get-Date).AddSeconds(6); while ((Get-Date) -lt $end) { }'
    $run = Test-Run -Case 'cpu' -Timeout 60 -Stall 3 -Script $script -Expected 0
    Write-TimedResult -Case 'CPU time counts as progress' -LogCase 'cpu' -Why $run.Why
}

# The command starts a child that starts a silent, CPU-busy grandchild and exits, and the command then sleeps without a
# word: the grandchild, whose parent is gone, is still in the command's job. The grandchild writes its pid and ends on
# its own after 30 s, so a leak does not outlive the self-test by much.
function Invoke-OrphanRun {
    param([string]$Case, [int]$Timeout, [int]$Stall, [int]$Sleep)
    $grandchild = "$dir/$Case-grandchild.ps1"
    $child = "$dir/$Case-child.ps1"
    Set-Content -Path $grandchild -Value @(
        'param($PidFile)', 'Set-Content -Path $PidFile -Value $PID',
        '$end = (Get-Date).AddSeconds(30); while ((Get-Date) -lt $end) { }')
    Set-Content -Path $child -Value @(
        'param($PidFile)',
        "Start-Process -FilePath pwsh -ArgumentList '-NoProfile', '-File', '$grandchild', `$PidFile -WindowStyle Hidden")
    $pidFile = "$dir/$Case.pid"
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    $script = "pwsh -NoProfile -File '$child' '$pidFile'; Start-Sleep $Sleep"
    $run = Invoke-Gate -Arguments (Get-RunArgument -Case $Case -Timeout $Timeout -Stall $Stall -Script $script)
    return [pscustomobject]@{ Run = $run; Grandchild = (Read-Pid $pidFile) }
}

function Test-OrphanProgress {
    $result = Invoke-OrphanRun -Case 'orphan-progress' -Timeout 60 -Stall 3 -Sleep 6
    Stop-Leftover $result.Grandchild
    $why = Get-RunProblem -Case 'orphan-progress' -Run $result.Run -Expected 0
    if (-not $why -and $result.Grandchild -eq 0) { $why = 'the grandchild never wrote its pid' }
    Write-TimedResult -Case 'a grandchild whose parent exited still counts as progress' -LogCase 'orphan-progress' -Why $why
}

function Test-OrphanKill {
    $result = Invoke-OrphanRun -Case 'orphan-kill' -Timeout 3 -Stall 30 -Sleep 30
    $alive = Test-Alive $result.Grandchild
    Stop-Leftover $result.Grandchild
    $why = Get-RunProblem -Case 'orphan-kill' -Run $result.Run -Expected 124 -Holds "gate: terminated the job's \d+ processes"
    if (-not $why -and $result.Grandchild -eq 0) { $why = 'the grandchild never wrote its pid before the kill' }
    elseif (-not $why -and $alive) { $why = "the grandchild $($result.Grandchild) outlived the kill" }
    Write-TimedResult -Case 'a kill reaches a grandchild whose parent exited' -LogCase 'orphan-kill' -Why $why
}

# A silent, CPU-busy pwsh that writes its pid to the file given and ends on its own after the seconds given, so a leak
# does not outlive the self-test by much.
function Write-BusyScript {
    $busy = "$dir/busy.ps1"
    Set-Content -Path $busy -Value @(
        'param([int]$Seconds, [string]$PidFile)', 'if ($PidFile) { Set-Content -Path $PidFile -Value $PID }',
        '$end = (Get-Date).AddSeconds($Seconds); while ((Get-Date) -lt $end) { }')
    return $busy
}

# The command is a pwsh, which with the Store's pwsh is a packaged app, and it waits without a word on a busy child from
# outside its package: cmd.exe spinning through an endless loop, which the pwsh stops itself after the seconds given.
# Windows can put such a child outside the job unless the gate's desktop app policy keeps it in, so the child must count
# as progress and must die with a kill.
function Invoke-PackagedRun {
    param([string]$Case, [int]$Timeout, [int]$Stall, [int]$BusySeconds)
    $pidFile = "$dir/$Case.pid"
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    $script = "`$child = Start-Process -FilePath cmd.exe -ArgumentList '/d /c `"for /l %i in (0,0,1) do @rem`"' -NoNewWindow -PassThru; " +
        "Set-Content -Path '$pidFile' -Value `$child.Id; if (-not `$child.WaitForExit($($BusySeconds * 1000))) { `$child.Kill() }"
    $run = Invoke-Gate -Arguments (Get-RunArgument -Case $Case -Timeout $Timeout -Stall $Stall -Script $script)
    return [pscustomobject]@{ Run = $run; Child = (Read-Pid $pidFile) }
}

function Test-PackagedProgress {
    $result = Invoke-PackagedRun -Case 'packaged-progress' -Timeout 60 -Stall 3 -BusySeconds 6
    Stop-Leftover $result.Child
    $why = Get-RunProblem -Case 'packaged-progress' -Run $result.Run -Expected 0
    if (-not $why -and $result.Child -eq 0) { $why = 'the child never wrote its pid' }
    Write-TimedResult -Case 'a child of a packaged pwsh stays in the job' -LogCase 'packaged-progress' -Why $why
}

function Test-PackagedKill {
    $result = Invoke-PackagedRun -Case 'packaged-kill' -Timeout 3 -Stall 30 -BusySeconds 60
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ((Test-Alive $result.Child) -and $clock.Elapsed.TotalSeconds -lt 5) { Start-Sleep -Milliseconds 200 }
    $alive = Test-Alive $result.Child
    Stop-Leftover $result.Child
    $why = Get-RunProblem -Case 'packaged-kill' -Run $result.Run -Expected 124 -Holds "gate: terminated the job's \d+ processes"
    if (-not $why -and $result.Child -eq 0) { $why = 'the child never wrote its pid before the kill' }
    elseif (-not $why -and $alive) { $why = "the child $($result.Child) outlived the kill" }
    Write-TimedResult -Case 'a kill reaches the child of a packaged pwsh' -LogCase 'packaged-kill' -Why $why
}

# The command puts a silent busy child in a job of its own, nested in the gate's: the child's CPU time must count as
# progress. The child is started suspended, assigned and then resumed, so it never runs outside the nested job.
function Test-NestedJob {
    $source = "$dir/nested-job.cs"
    Set-Content -Path $source -Value @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class NestedJobRunner
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public static void Run(string commandLine)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation child;
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x4, IntPtr.Zero, null,
            ref startup, out child)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!AssignProcessToJobObject(job, child.hProcess)) throw new Win32Exception(Marshal.GetLastWin32Error());
        ResumeThread(child.hThread);
        WaitForSingleObject(child.hProcess, 0xFFFFFFFF);
        CloseHandle(child.hThread);
        CloseHandle(child.hProcess);
        CloseHandle(job);
    }
}
'@
    $busy = Write-BusyScript
    $script = "Add-Type -Path '$source'; [NestedJobRunner]::Run('pwsh -NoProfile -File $busy 6')"
    $run = Test-Run -Case 'nested-job' -Timeout 60 -Stall 3 -Script $script -Expected 0
    Write-TimedResult -Case 'a process in a nested job counts as progress' -LogCase 'nested-job' -Why $run.Why
}

# The command's CPU comes only from short-lived children: for about 6 s it runs one busy cmd.exe of about a second after
# another and waits on each without a word. A child that exited between two samples must still count.
function Test-ShortLivedChild {
    $script = '$end = (Get-Date).AddSeconds(6); while ((Get-Date) -lt $end) { ' +
        'Start-Process -FilePath cmd.exe -ArgumentList ''/d /c "for /l %i in (1,1,2000000) do @rem"'' -NoNewWindow -Wait }'
    $run = Test-Run -Case 'short-children' -Timeout 60 -Stall 3 -Script $script -Expected 0
    Write-TimedResult -Case 'CPU of children that have exited counts as progress' -LogCase 'short-children' -Why $run.Why
}

# On a machine other sessions keep busy, the load-adjusted clock runs slow enough that the wall-time backstop can come
# first; that is the gate working as meant, so it is reported as skipped rather than failed.
function Test-Ceiling {
    $case = 'a busy loop reaches the load-adjusted ceiling'
    $script = '$end = (Get-Date).AddSeconds(60); while ((Get-Date) -lt $end) { }'
    $run = Test-Run -Case 'ceiling' -Timeout 3 -Stall 30 -Script $script -Expected 124 -Holds 'gate: TIMED OUT'
    Write-TimedResult -Case $case -LogCase 'ceiling' -Why $run.Why
}

# With every sample failing, the gate still lets a command finish, and still kills a hung one at the backstop. The two
# gates run side by side; the variable is inherited when each is started, so it is set only for their start.
function Test-SamplerFailure {
    $env:GATE_TEST_SAMPLER_FAIL = '1'
    try {
        $finishing = Start-Gate -Arguments (Get-RunArgument -Case 'sampler-finish' -Timeout 30 -Stall 1 -Script 'Start-Sleep 3')
        $hanging = Start-Gate -Arguments (Get-RunArgument -Case 'sampler-kill' -Timeout 2 -Stall 1 -Script 'Start-Sleep 30')
    }
    finally {
        $env:GATE_TEST_SAMPLER_FAIL = $null
    }
    $finished = Complete-Gate $finishing
    $killed = Complete-Gate $hanging
    $why = Get-RunProblem -Case 'sampler-finish' -Run $finished -Expected 0 -Holds 'gate: sampler failed: '
    Write-Result 'a failing sampler leaves a command to finish' $why
    $why = Get-RunProblem -Case 'sampler-kill' -Run $killed -Expected 124 -Holds 'gate: BACKSTOP.*machine load unknown'
    if (-not $why -and $killed.Seconds -ge 20) { $why = "took $([math]::Round($killed.Seconds)) s, expected under 20 s" }
    Write-TimedResult -Case 'a failing sampler still kills a hung command at the backstop' -LogCase 'sampler-kill' -Why $why
}

# Three gates side by side: a failing status, a failure marker, and the same marker with -NoMarkers.
function Test-Status {
    $marker = '[Console]::Out.WriteLine(''Build FAILED.'')'
    $status = Start-Gate -Arguments (Get-RunArgument -Case 'status' -Timeout 30 -Stall 30 -Script 'exit 3')
    $marked = Start-Gate -Arguments (Get-RunArgument -Case 'marker' -Timeout 30 -Stall 30 -Script $marker)
    $unmarked = Start-Gate -Arguments @('-Log', "$dir/no-markers.log", '-TimeoutSeconds', '30', '-Slot', 'light', '-NoMarkers', '--',
        'pwsh', '-NoProfile', '-c', $marker)
    Write-Result 'the command''s own status is kept' (Get-RunProblem -Case 'status' -Run (Complete-Gate $status) -Expected 3)
    Write-Result 'a green exit with a failure marker is 1' (Get-RunProblem -Case 'marker' -Run (Complete-Gate $marked) -Expected 1)
    $why = Get-RunProblem -Case 'no-markers' -Run (Complete-Gate $unmarked) -Expected 0
    Write-Result 'with -NoMarkers a green exit is 0 whatever the log says' $why
}

# Arguments reach the command as they were given: one holding quotes and a space, one ending in a backslash, and one
# with a space that ends in a backslash.
function Test-Argument {
    $echo = "$dir/echo-args.ps1"
    Set-Content -Path $echo -Value '$args | ForEach-Object { [Console]::Out.WriteLine("[$_]") }'
    $given = @('say "hi" twice', 'C:\dir\', 'C:\a b\')
    $arguments = @('-Log', "$dir/arguments.log", '-TimeoutSeconds', '30', '-Slot', 'light', '--', 'pwsh', '-NoProfile', '-File', $echo) +
        $given
    $run = Invoke-Gate -Arguments $arguments
    $why = Get-RunProblem -Case 'arguments' -Run $run -Expected 0
    $lines = @((Get-LogText 'arguments') -split "`r?`n" | Where-Object { $_ -match '^\[' })
    $expected = @($given | ForEach-Object { "[$_]" })
    if (-not $why -and ($lines -join '|') -ne ($expected -join '|')) {
        $why = "the command got $($lines -join ' '), expected $($expected -join ' ')"
    }
    Write-Result 'quotes and trailing backslashes reach the command intact' $why
}

# Run from a normal-priority parent, so the child reads below-normal only when the gate lowered it.
function Test-Priority {
    $self = Get-Process -Id $PID
    $was = $self.PriorityClass
    $self.PriorityClass = 'Normal'
    try {
        $run = Test-Run -Case 'priority' -Timeout 30 -Stall 30 -Script '(Get-Process -Id $PID).PriorityClass' -Expected 0 `
            -Holds 'BelowNormal'
    }
    finally {
        $self.PriorityClass = $was
    }
    Write-Result 'the command runs below normal priority' $run.Why
}

# Run in this session with &, as a repo's entry-point script runs it, so the caller's own environment and priority can be checked after
# the gate.
function Test-BuildEnvironment {
    $env:MSBUILDDISABLENODEREUSE = 'caller'
    $env:DOTNET_CLI_USE_MSBUILD_SERVER = $null
    $priority = (Get-Process -Id $PID).PriorityClass
    $script = '$env:MSBUILDDISABLENODEREUSE; $env:DOTNET_CLI_USE_MSBUILD_SERVER'
    & $gate -Log "$dir/build-env.log" -TimeoutSeconds 30 -Slot light -- pwsh -NoProfile -c $script *> $null
    $status = $LASTEXITCODE
    $text = Get-LogText 'build-env'
    $after = (Get-Process -Id $PID).PriorityClass
    $why = $null
    if ($status -ne 0) { $why = "exit $status, expected 0; see $dir/build-env.log" }
    elseif ($text -notmatch '(?m)^1\r?$' -or $text -notmatch '(?m)^0\r?$') { $why = "the command did not see 1 and 0; see $dir/build-env.log" }
    elseif ($env:MSBUILDDISABLENODEREUSE -ne 'caller' -or $null -ne $env:DOTNET_CLI_USE_MSBUILD_SERVER) {
        $why = "the caller's environment was left changed: '$env:MSBUILDDISABLENODEREUSE', '$env:DOTNET_CLI_USE_MSBUILD_SERVER'"
    }
    elseif ($after -ne $priority) { $why = "the caller's priority was left at $after, was $priority" }
    Write-Result 'MSBuild starts its own nodes, and the caller''s environment and priority are restored' $why
}

# A caller in its own session that moved with Set-Location and gives a relative -Log: the gate must watch the file the
# command writes, so a command that prints slowly and uses little CPU is not killed as stalled.
function Test-RelativeLog {
    $sub = Join-Path $dir 'relative'
    New-Item -ItemType Directory -Force $sub | Out-Null
    Remove-Item (Join-Path $sub 'relative.log') -ErrorAction SilentlyContinue
    $script = '1..6 | ForEach-Object { [Console]::Out.WriteLine($_); Start-Sleep 1 }'
    Push-Location $sub
    try {
        & $gate -Log 'relative.log' -TimeoutSeconds 60 -StallSeconds 3 -Slot light -- pwsh -NoProfile -c $script *> $null
        $status = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    $why = $null
    if ($status -ne 0) { $why = "exit $status, expected 0; see $sub/relative.log" }
    elseif (-not (Test-Path (Join-Path $sub 'relative.log'))) { $why = "no log at $sub/relative.log" }
    Write-TimedResult -Case 'a relative -Log after Set-Location is watched where the command writes it' -LogCase 'relative/relative' -Why $why
}

# Each usage error, its gate started beside the others'.
function Test-Usage {
    $cases = @(
        @{ Case = 'no-log'; Arguments = @('-TimeoutSeconds', '5', '-Slot', 'light', '--', 'pwsh', '-c', 'exit 0'); Names = 'missing -Log' },
        @{ Case = 'no-timeout'; Arguments = @('-Log', "$dir/no-timeout.log", '-Slot', 'light', '--', 'pwsh', '-c', 'exit 0')
            Names = 'missing -TimeoutSeconds' },
        @{ Case = 'bad-timeout'
            Arguments = @('-Log', "$dir/bad-timeout.log", '-TimeoutSeconds', 'abc', '-Slot', 'light', '--', 'pwsh', '-c', 'exit 0')
            Names = "-TimeoutSeconds must be a whole number above 0, got 'abc'" },
        @{ Case = 'no-slot'; Arguments = @('-Log', "$dir/no-slot.log", '-TimeoutSeconds', '5', '--', 'pwsh', '-c', 'exit 0')
            Names = 'missing -Slot' },
        @{ Case = 'bad-slot'; Arguments = @('-Log', "$dir/bad-slot.log", '-TimeoutSeconds', '5', '-Slot', 'medium', '--', 'pwsh', '-c', 'exit 0')
            Names = "-Slot must be heavy or light, got 'medium'" },
        @{ Case = 'no-command'; Arguments = @('-Log', "$dir/no-command.log", '-TimeoutSeconds', '5', '-Slot', 'light', '--')
            Names = 'missing the command' },
        @{ Case = 'no-value'; Arguments = @('-Log', "$dir/no-value.log", '-Slot', 'light', '-TimeoutSeconds')
            Names = 'gate: -TimeoutSeconds needs a value' }
    )
    $started = @(foreach ($case in $cases) { Start-Gate -Arguments $case.Arguments })
    for ($index = 0; $index -lt $cases.Count; $index++) {
        $case = $cases[$index]
        $run = Complete-Gate $started[$index]
        $why = $null
        if ($run.TimedOut) { $why = 'the gate did not return in 90 s' }
        elseif ($run.Status -ne 2) { $why = "exit $($run.Status), expected 2" }
        elseif (-not $run.Err.Contains($case.Names)) { $why = "standard error does not say '$($case.Names)': $($run.Err)" }
        Write-Result "usage: $($case.Case)" $why
    }
}

# Starts a gate that takes a slot of this run's own: GATE_SLOT_HELD unset, GATE_TEST_SLOT_PREFIX set and each variable
# of $Counts set to its value while the process is created, which is when it takes its environment, and this session's
# put back straight after.
function Start-SlotGate {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Starts a gate of this run''s own; the environment it changes is put back before it returns.')]
    param([string[]]$Arguments, [hashtable]$Counts)
    $saved = @{ GATE_SLOT_HELD = $env:GATE_SLOT_HELD; GATE_TEST_SLOT_PREFIX = $env:GATE_TEST_SLOT_PREFIX }
    foreach ($name in $Counts.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        $env:GATE_SLOT_HELD = $null
        $env:GATE_TEST_SLOT_PREFIX = $slotPrefix
        foreach ($name in $Counts.Keys) { [Environment]::SetEnvironmentVariable($name, $Counts[$name]) }
        return Start-Gate -Arguments $Arguments
    }
    finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, ($saved[$name] ?? [NullString]::Value)) }
    }
}

function Get-Stamp {
    param([string]$Case)
    return @((Get-LogText $Case) -split "`r?`n" | Where-Object { $_ -match '^\d{10,}$' } | ForEach-Object { [long]$_ })
}

function Test-SlotOverlap {
    param([string]$Kind, [string[]]$Cases, [object[]]$Runs)
    $a = Get-Stamp $Cases[0]
    $b = Get-Stamp $Cases[1]
    if ($a.Count -eq 0 -or $b.Count -eq 0) { return 'a run printed no timestamps' }
    $apart = ($a[-1] -lt $b[0]) -or ($b[-1] -lt $a[0])
    if (-not $apart) { return 'the two runs overlapped' }
    $said = @($Runs | ForEach-Object { "$($_.Out)$($_.Err)" }) + @($Cases | ForEach-Object { Get-LogText $_ })
    if (-not (($said -join "`n") -match "waiting for a $Kind slot")) {
        return "neither gate said it was waiting for a $Kind slot"
    }
    return $null
}

# With one slot of the kind, two gates of that kind started together run one after the other. The slot is this run's
# own, so each gate needs about 5 s of it on an idle machine; the 90 s wait every gate here gets covers both on a machine
# other sessions keep busy, and costs nothing when the gates finish sooner.
function Test-SlotKind {
    param([string]$Kind)
    $variable = "GATE_$($Kind.ToUpperInvariant())_SLOTS"
    $script = '1..4 | ForEach-Object { [Console]::Out.WriteLine([DateTime]::UtcNow.Ticks); Start-Sleep 1 }'
    $cases = @("slot-$Kind-a", "slot-$Kind-b")
    $started = @(foreach ($case in $cases) {
            $arguments = @('-Log', "$dir/$case.log", '-TimeoutSeconds', '60', '-Slot', $Kind, '--', 'pwsh', '-NoProfile', '-c', $script)
            Start-SlotGate -Arguments $arguments -Counts @{ $variable = '1' }
        })
    $runs = @($started | ForEach-Object { Complete-Pwsh -Started $_ -Seconds 90 })
    $why = if (@($runs | Where-Object { $_.TimedOut }).Count -gt 0) {
        "a gate did not finish within 90 s with $variable=1 and $($slotZero[$Kind]) this run's own"
    }
    elseif ($runs[0].Status -ne 0 -or $runs[1].Status -ne 0) {
        "exits $($runs[0].Status) and $($runs[1].Status), expected 0 and 0"
    }
    else { Test-SlotOverlap -Kind $Kind -Cases $cases -Runs $runs }
    Write-TimedResult -Case "one $Kind slot runs two gates one after the other" -LogCase $cases[0] -Why $why
}

function Test-Slot {
    Test-SlotKind -Kind 'heavy'
    Test-SlotKind -Kind 'light'
}

# The named mutex, held by this thread once it could be taken within the seconds given, an abandoned one counting as
# taken; $null when another session held it throughout.
function Get-HeldMutex {
    param([string]$Name, [int]$Seconds)
    $mutex = [System.Threading.Mutex]::new($false, $Name)
    try {
        $taken = $mutex.WaitOne($Seconds * 1000)
    }
    catch [System.Threading.AbandonedMutexException] {
        $taken = $true
    }
    if ($taken) { return $mutex }
    $mutex.Dispose()
    return $null
}

# A gate of one kind runs, without waiting, while this run holds slot 0 of the other kind and each kind has one slot.
# Both slots are this run's own, so the gate never has cause to wait.
function Test-OtherPoolHeld {
    param([string]$Kind, [string]$Other)
    $label = "a $Kind gate does not wait on the other kind's slot"
    $case = "slot-pool-$Kind"
    $held = Get-HeldMutex -Name $Other -Seconds 10
    if (-not $held) { Write-Result $label "could not take $Other, which only this run uses, within 10 s"; return }
    try {
        $arguments = @('-Log', "$dir/$case.log", '-TimeoutSeconds', '30', '-Slot', $Kind, '--', 'pwsh', '-NoProfile', '-c', 'exit 0')
        $run = Complete-Pwsh -Started (Start-SlotGate -Arguments $arguments -Counts @{ GATE_HEAVY_SLOTS = '1'; GATE_LIGHT_SLOTS = '1' }) -Seconds 60
    }
    finally {
        $held.ReleaseMutex()
        $held.Dispose()
    }
    $why = if ($run.TimedOut) { "the gate did not finish within 60 s while this run held $Other" }
    else { Get-RunProblem -Case $case -Run $run -Expected 0 }
    if (-not $why -and "$($run.Out)$($run.Err)$(Get-LogText $case)" -match 'waiting for') {
        $why = "the gate waited for a slot while only $Other was held; see $dir/$case.log"
    }
    Write-Result $label $why
}

function Test-SlotPool {
    Test-OtherPoolHeld -Kind 'heavy' -Other $slotZero['light']
    Test-OtherPoolHeld -Kind 'light' -Other $slotZero['heavy']
}

# Two gates with the native cache redirected to a folder holding only an older version's dll: the first compiles the
# class into it and prunes the older dll, leaving one dll and no file of its own, and the second loads that dll without
# writing it again or falling back to memory.
function Test-NativeCache {
    $cache = Join-Path $root "$dir/native-cache"
    New-Item -ItemType Directory -Force $cache | Out-Null
    Get-ChildItem -LiteralPath $cache -File | Remove-Item
    $fake = 'GateNative_00000000.dll'
    Set-Content -LiteralPath (Join-Path $cache $fake) -Value 'an older version'
    $env:GATE_TEST_NATIVE_CACHE = $cache
    try {
        $first = Invoke-Gate -Arguments @('-Log', "$dir/native-cache-1.log", '-TimeoutSeconds', '30', '-Slot', 'light', '--', 'cmd', '/c', 'exit 0')
        $files = @(Get-ChildItem -LiteralPath $cache -File)
        $second = Invoke-Gate -Arguments @('-Log', "$dir/native-cache-2.log", '-TimeoutSeconds', '30', '-Slot', 'light', '--', 'cmd', '/c', 'exit 0')
    }
    finally {
        $env:GATE_TEST_NATIVE_CACHE = $null
    }
    $why = Get-RunProblem -Case 'native-cache-1' -Run $first -Expected 0
    if (-not $why -and ($files.Count -ne 1 -or $files[0].Name -notmatch '^GateNative_[0-9A-F]{8}\.dll$' -or $files[0].Name -eq $fake)) {
        $why = "the cache holds $(@($files | ForEach-Object Name) -join ', '), expected one GateNative_<hash>.dll and $fake gone"
    }
    if (-not $why) { $why = Get-RunProblem -Case 'native-cache-2' -Run $second -Expected 0 }
    if (-not $why -and "$($first.Err)$($second.Err)" -match 'native cache unusable') { $why = "a gate fell back: $($first.Err)$($second.Err)" }
    if (-not $why -and $files[0].LastWriteTimeUtc -ne (Get-Item -LiteralPath $files[0].FullName).LastWriteTimeUtc) {
        $why = 'the second gate wrote the dll again'
    }
    Write-Result 'the native class is compiled into the cache once and loaded from it after' $why
}

# The inner command sleeps 5 s so the inner gate's passed line, in the outer gate's log, gives a load figure the timed
# result can read. One light slot, so an inner gate that took a slot would wait on its parent's.
function Test-Nesting {
    $inner = @('pwsh', '-NoProfile', '-File', $gate, '-Log', "$dir/nest-inner.log", '-TimeoutSeconds', '20', '-Slot', 'light', '--',
        'pwsh', '-NoProfile', '-c', 'Start-Sleep 5; exit 0')
    $outer = @('-Log', "$dir/nest.log", '-TimeoutSeconds', '20', '-Slot', 'light', '--') + $inner
    $run = Complete-Gate (Start-SlotGate -Arguments $outer -Counts @{ GATE_LIGHT_SLOTS = '1' })
    $why = Get-RunProblem -Case 'nest' -Run $run -Expected 0
    if (-not $why -and $run.Seconds -ge 25) { $why = "took $([math]::Round($run.Seconds)) s, expected under 25 s" }
    Write-TimedResult -Case 'a gate inside a gate does not wait on its parent''s slot' -LogCase 'nest' -Why $why
}

# An outer gate whose command is an inner gate whose command sleeps without a word: the outer's kill must reach the
# sleeper through the inner gate's job, nested in its own.
function Test-NestedKill {
    $sleeper = "$dir/nest-sleeper.ps1"
    $pidFile = "$dir/nest-kill.pid"
    Set-Content -Path $sleeper -Value @('param($PidFile)', 'Set-Content -Path $PidFile -Value $PID', 'Start-Sleep 30')
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    $inner = @('pwsh', '-NoProfile', '-File', $gate, '-Log', "$dir/nest-kill-inner.log", '-TimeoutSeconds', '60',
        '-StallSeconds', '60', '-Slot', 'light', '--', 'pwsh', '-NoProfile', '-File', $sleeper, $pidFile)
    $outer = @('-Log', "$dir/nest-kill.log", '-TimeoutSeconds', '8', '-StallSeconds', '3', '-Slot', 'light', '--') + $inner
    $run = Invoke-Gate -Arguments $outer
    $sleeperId = Read-Pid $pidFile
    $alive = Test-Alive $sleeperId
    Stop-Leftover $sleeperId
    $why = Get-RunProblem -Case 'nest-kill' -Run $run -Expected 124 -Holds 'gate: (STALLED|TIMED OUT|BACKSTOP)'
    if (-not $why -and $sleeperId -eq 0) { $why = 'the sleeper never wrote its pid' }
    elseif (-not $why -and $alive) { $why = "the sleeper $sleeperId outlived the outer gate's kill" }
    Write-TimedResult -Case 'an outer gate''s kill reaches the command of a gate inside it' -LogCase 'nest-kill' -Why $why
}

# A command that exits the moment it is resumed keeps its own status, ten runs over, with no failure of the gate's. The
# runs go one after another: each gate compiles its native class, and ten compiling at once starve the other cases.
function Test-QuickExit {
    $failures = @()
    foreach ($index in 1..10) {
        $case = "quick-exit-$index"
        $run = Invoke-Gate -Arguments @('-Log', "$dir/$case.log", '-TimeoutSeconds', '30', '-Slot', 'light', '--', 'cmd', '/c', 'exit 0')
        $why = Get-RunProblem -Case $case -Run $run -Expected 0
        if (-not $why -and (Get-LogText $case) -match 'gate: the gate failed') { $why = "the gate failed; see $dir/$case.log" }
        if ($why) { $failures += "run ${index}: $why" }
    }
    Write-Result 'a command that exits at once keeps its own status' ($failures -join '; ')
}

# A gate run in a job's own session and stopped with Stop-Job terminates its command's job on the way out.
function Test-StopJob {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseUsingScopeModifierInNewRunspaces', '',
        Justification = 'The job reads its values from its own param block and -ArgumentList, which $using: cannot be combined with.')]
    param()
    $sleeper = "$dir/stop-sleeper.ps1"
    $pidFile = "$dir/stop-job.pid"
    Set-Content -Path $sleeper -Value @('param($PidFile)', 'Set-Content -Path $PidFile -Value $PID', 'Start-Sleep 30')
    Remove-Item $pidFile -ErrorAction SilentlyContinue
    $job = Start-Job -WorkingDirectory $root -ScriptBlock {
        param($gate, $log, $sleeper, $pidFile)
        & $gate -Log $log -TimeoutSeconds 60 -StallSeconds 60 -Slot light -- pwsh -NoProfile -File $sleeper $pidFile
    } -ArgumentList $gate, "$dir/stop-job.log", $sleeper, $pidFile
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ((Read-Pid $pidFile) -eq 0 -and $clock.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 200 }
    $sleeperId = Read-Pid $pidFile
    Stop-Job -Job $job
    Remove-Job -Job $job -Force
    $clock.Restart()
    while ((Test-Alive $sleeperId) -and $clock.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 200 }
    $alive = Test-Alive $sleeperId
    Stop-Leftover $sleeperId
    $why = if ($sleeperId -eq 0) { 'the sleeper never wrote its pid' }
    elseif ($alive) { "the sleeper $sleeperId outlived the Stop-Job by 10 s" }
    Write-Result 'a gate stopped with Stop-Job takes its command with it' $why
}

# Writes the scripts of the -StopTree case: the launcher runs a gate whose command is A; A writes its pid, runs B and
# sleeps 60 s; B starts a silent busy cmd.exe, C, writes C's pid and exits, so C's parent is gone.
function Write-StopTreeScript {
    $launcher = "$dir/stoptree-launcher.ps1"
    $a = "$dir/stoptree-a.ps1"
    $b = "$dir/stoptree-b.ps1"
    Set-Content -Path $launcher -Value @(
        'param($Gate, $Log, $A, $B, $APidFile, $CPidFile)',
        ('& pwsh -NoProfile -File $Gate -Log $Log -TimeoutSeconds 120 -StallSeconds 120 -Slot light -- ' +
        'pwsh -NoProfile -File $A $B $APidFile $CPidFile'))
    Set-Content -Path $a -Value @(
        'param($B, $APidFile, $CPidFile)', 'Set-Content -Path $APidFile -Value $PID',
        'pwsh -NoProfile -File $B $CPidFile', 'Start-Sleep 60')
    Set-Content -Path $b -Value @(
        'param($CPidFile)',
        '$c = Start-Process -FilePath cmd.exe -ArgumentList ''/d /c "for /l %i in (0,0,1) do @rem"'' -NoNewWindow -PassThru',
        'Set-Content -Path $CPidFile -Value $c.Id')
    return [pscustomobject]@{ Launcher = $launcher; A = $a; B = $b }
}

# Runs gate.ps1 -StopTree on the pid in a job bounded at 30 s; returns its status and what it printed.
function Invoke-StopTree {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseUsingScopeModifierInNewRunspaces', '',
        Justification = 'The job reads its values from its own param block and -ArgumentList, which $using: cannot be combined with.')]
    param([int]$Id)
    $job = Start-Job -WorkingDirectory $root -ScriptBlock {
        param($gate, $id)
        $text = & pwsh -NoProfile -File $gate -StopTree $id 2>&1 | Out-String
        [pscustomobject]@{ Status = $LASTEXITCODE; Text = $text }
    } -ArgumentList $gate, $Id
    $finished = [bool](Wait-Job -Job $job -Timeout 30)
    $result = if ($finished) { Receive-Job -Job $job } else { [pscustomobject]@{ Status = -1; Text = 'did not return in 30 s' } }
    Remove-Job -Job $job -Force
    return $result
}

function Wait-Gone {
    param([int[]]$Ids, [double]$Seconds)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while (@($Ids | Where-Object { Test-Alive $_ }).Count -gt 0 -and $clock.Elapsed.TotalSeconds -lt $Seconds) {
        Start-Sleep -Milliseconds 200
    }
    return @($Ids | Where-Object { Test-Alive $_ })
}

# -StopTree on the process that ran a gate reaches C, whose parent B has exited, through the gate's job, and A and the
# launcher through the tree.
function Test-StopTree {
    $scripts = Write-StopTreeScript
    $aPidFile = "$dir/stoptree-a.pid"
    $cPidFile = "$dir/stoptree-c.pid"
    Remove-Item $aPidFile, $cPidFile -ErrorAction SilentlyContinue
    $words = @('-NoProfile', '-File', $scripts.Launcher, $gate, "$dir/stoptree.log", $scripts.A, $scripts.B, $aPidFile, $cPidFile)
    $line = @($words | ForEach-Object { "`"$_`"" }) -join ' '
    $launcher = Start-Process -FilePath pwsh -ArgumentList $line -WorkingDirectory $root -WindowStyle Hidden -PassThru
    $cId = 0
    $aId = 0
    try {
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        while ((Read-Pid $cPidFile) -eq 0 -and -not $launcher.HasExited -and $clock.Elapsed.TotalSeconds -lt 60) {
            Start-Sleep -Milliseconds 200
        }
        $cId = Read-Pid $cPidFile
        $aId = Read-Pid $aPidFile
        $why = if ($cId -eq 0) { "C never wrote its pid; see $dir/stoptree.log" }
        if (-not $why) {
            $stop = Invoke-StopTree $launcher.Id
            $left = @(Wait-Gone -Ids @($cId, $aId, $launcher.Id) -Seconds 5)
            if ($stop.Status -ne 0) { $why = "-StopTree exited $($stop.Status): $($stop.Text)" }
            elseif ($left.Count -gt 0) { $why = "still alive 5 s after the stop: $($left -join ', ') (C $cId, A $aId, launcher $($launcher.Id))" }
            elseif ($stop.Text -notmatch "gate: stopped [1-9]\d* gate job\(s\) and \d+ process\(es\) under $($launcher.Id)") {
                $why = "-StopTree printed no stopped line naming a gate job: $($stop.Text)"
            }
        }
    }
    finally {
        Stop-Leftover (Read-Pid $cPidFile)
        Stop-Leftover $aId
        if (-not $launcher.HasExited) { $launcher.Kill($true) }
    }
    Write-Result '-StopTree stops a process whose parent has exited' $why
}

# Run in this session after a class named GateNative, as an older version of the gate defined it, is loaded here.
function Test-OldNativeType {
    if (-not ('GateNative' -as [type])) {
        Add-Type -TypeDefinition 'public static class GateNative { public static int Old() { return 1; } }'
    }
    & $gate -Log "$dir/old-native.log" -TimeoutSeconds 30 -Slot light -- pwsh -NoProfile -c 'exit 0' *> $null
    $status = $LASTEXITCODE
    $why = if ($status -ne 0) { "exit $status, expected 0; see $dir/old-native.log" }
    Write-Result 'a session that loaded an older GateNative still runs the gate' $why
}

# Runs the cases named, one after another, in this process.
function Invoke-Case {
    param([string[]]$Names)
    $known = $waitingCases + $cpuCases + $slotCases
    foreach ($name in $Names) {
        if ($known -notcontains $name) {
            Write-Result "case $name" "no such case; the cases are $($known -join ', ')"
            continue
        }
        & $name
    }
}

# Starts a pwsh running this script's cases of the group, a comma-separated list of their names.
function Start-CaseProcess {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Starts a process of this run''s own; there is no system state for a caller to confirm.')]
    param([string]$Group)
    $started = Start-Pwsh -Words @('-NoProfile', '-File', $selfTest, '-Case', $Group)
    $started | Add-Member -NotePropertyName Group -NotePropertyValue $Group
    return $started
}

# One line a case process printed, coloured as Write-Result colours it, a FAIL line counted as a failure.
function Write-ResultLine {
    param([string]$Line)
    if ($Line -match '^ok ') { Write-Host $Line -ForegroundColor Green }
    elseif ($Line -match '^skip ') { Write-Host $Line -ForegroundColor Yellow }
    elseif ($Line -match '^FAIL ') {
        Write-Host $Line -ForegroundColor Red
        $script:failed++
    }
    else { Write-Host $Line }
}

# Prints a case process's lines once it has ended, or kills it with its tree once it has run $caseSeconds; one that
# failed without a FAIL line of its own is a failure named after its group.
function Write-CaseOutput {
    param($Started)
    $run = Complete-Pwsh -Started $Started -Seconds $caseSeconds
    $lines = @($run.Out -split "`r?`n" | Where-Object { $_ })
    foreach ($line in $lines) { Write-ResultLine $line }
    if (@($lines | Where-Object { $_ -match '^FAIL ' }).Count -gt 0) { return }
    if ($run.TimedOut) { Write-Result $Started.Group "did not finish within $caseSeconds s" }
    elseif ($run.Status -ne 0) { Write-Result $Started.Group "exit $($run.Status): $($run.Err.Trim())" }
}

# Runs each group in a process of its own, at most $Limit at once, and prints each group's lines in the order given.
function Invoke-Group {
    param([string[]]$Groups, [int]$Limit)
    $started = [System.Collections.Generic.List[object]]::new()
    $printed = 0
    while ($printed -lt $Groups.Count) {
        $running = @($started | Select-Object -Skip $printed | Where-Object { -not $_.Process.HasExited }).Count
        while ($started.Count -lt $Groups.Count -and $running -lt $Limit) {
            $started.Add((Start-CaseProcess $Groups[$started.Count]))
            $running++
        }
        $first = $started[$printed]
        if ($first.Process.HasExited -or $first.Clock.Elapsed.TotalSeconds -ge $caseSeconds) {
            Write-CaseOutput $first
            $printed++
            continue
        }
        Start-Sleep -Milliseconds 200
    }
}

# The share of the machine's processor time that was idle over one second, read with GetSystemTimes.
function Measure-FreeShare {
    if (-not ('SelfTestSystemTimes' -as [type])) {
        Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class SelfTestSystemTimes
{
    [DllImport("kernel32.dll")]
    public static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
}
'@
    }
    $idle, $kernel, $user, $idleAfter, $kernelAfter, $userAfter = 0L, 0L, 0L, 0L, 0L, 0L
    $null = [SelfTestSystemTimes]::GetSystemTimes([ref]$idle, [ref]$kernel, [ref]$user)
    Start-Sleep -Seconds 1
    $null = [SelfTestSystemTimes]::GetSystemTimes([ref]$idleAfter, [ref]$kernelAfter, [ref]$userAfter)
    $total = ($kernelAfter - $kernel) + ($userAfter - $user)
    if ($total -le 0) { return 1.0 }
    return ($idleAfter - $idle) / $total
}

# Every case: the slot cases in a process of their own throughout, the waiting cases side by side, then the busy cases
# one after another. This process runs below normal meanwhile, so the case processes and their gates, which inherit
# its class, compete with the commands on equal terms instead of starving them while they start. The waiting cases run
# at most half as many at once as there are logical processors, scaled down by the share of the machine free at the
# start, and never fewer than two: on a machine other sessions already keep busy, more at once only slows each.
function Invoke-All {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Lowers only this run''s own priority, and puts it back before it returns.')]
    param()
    $self = Get-Process -Id $PID
    $was = $self.PriorityClass
    $self.PriorityClass = 'BelowNormal'
    try {
        $limit = [math]::Max(2, [math]::Floor([Environment]::ProcessorCount / 2 * (Measure-FreeShare)))
        $slots = Start-CaseProcess ($slotCases -join ',')
        Invoke-Group -Groups $waitingCases -Limit $limit
        Invoke-Group -Groups @($cpuCases -join ',') -Limit 1
        Write-CaseOutput $slots
    }
    finally {
        $self.PriorityClass = $was
    }
}

$saved = @{}
$names = 'GATE_SAMPLE_SECONDS', 'GATE_SLOT_HELD', 'GATE_HEAVY_SLOTS', 'GATE_LIGHT_SLOTS', 'GATE_TEST_SAMPLER_FAIL',
'GATE_TEST_SLOT_PREFIX', 'GATE_TEST_NATIVE_CACHE', 'MSBUILDDISABLENODEREUSE', 'DOTNET_CLI_USE_MSBUILD_SERVER'
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    $env:GATE_SAMPLE_SECONDS = '1'
    $env:GATE_SLOT_HELD = '1'
    $env:GATE_TEST_SAMPLER_FAIL = $null
    if ($Case) { Invoke-Case -Names @($Case | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }
    else { Invoke-All }
}
finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, ($saved[$name] ?? [NullString]::Value)) }
}

if ($Case) { exit ([int]($script:failed -gt 0)) }
if ($script:failed -gt 0) {
    Write-Host "$($script:failed) case(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host 'All cases passed.' -ForegroundColor Green
exit 0
