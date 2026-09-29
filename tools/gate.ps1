#requires -Version 7
<#
.SYNOPSIS
Runs one gate command with four things always given, the log, the ceiling, the slot kind and the command: the whole
output to the log, the last lines on the screen, the command's own exit status, and 124 when the watchdog killed it.

.DESCRIPTION
The canonical copy is ~/.claude/tools/gate/gate.ps1: change it there and run sync-gate.ps1, which copies it and
gate.selftest.ps1 into every repo that carries them.

Usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light [-StallSeconds <n>] [-Tail <n>] [-NoMarkers] -- <command> [args...]
       pwsh tools/gate.ps1 -StopTree <pid>

The log, the ceiling, the slot kind and the command are all required and none has a default: a gate run without a
ceiling is the one that holds its caller for an hour, and a caller that forgot one is told so, with the usage, and the
script exits 2 before anything runs. Each missing or unreadable input is named on a line of its own. The gate runs on Windows only.

Why this exists:
 - Every line a command prints lands in an agent's context and is re-read on every later turn, so a build or a test run
   prints its last lines on the screen and the rest stays in the log. Read or `rg` the log for the rest; never re-run
   the command to see its output again.
 - A pipeline reports the last command's status, so `cmd 2>&1 | Tee-Object log | Select-Object -Last 20` passes even
   when the build failed. This wrapper exits with the command's own status, and additionally fails when the log holds a
   known failure marker: a runner can print a green summary for stale binaries after "Build FAILED" and still exit 0.
 - A gate that hangs holds its caller until something else gives up, ten minutes and more. Every gate runs under a
   watchdog, and a run it kills is killed with every process it started and reported as 124, the status coreutils
   `timeout` uses, so no caller reads it as the command's own.

The command runs in a Windows job object of its own, and every process it starts, and every process those start, is
created in that job. The job is the command's tree: the watchdog measures it and a kill terminates it whole, so a
process whose parent has already exited is still watched and still killed. The gate creates the command suspended,
assigns it to the job and only then lets it run, so nothing the command starts can run outside the job. It creates the
command with the desktop app policy that keeps every process the command and its descendants create inside the
desktop app runtime: without it, every child of a packaged app, such as the pwsh the Microsoft Store installs, is
created outside the job however the job is set (measured 2026-09-27), and neither watched nor killed. The job does
not kill its processes when the gate ends: the compiler server a build starts is created inside the job (measured 2026-09-27: VBCSCompiler
was in the job and died with it when the job was set to kill on close), and a normal exit leaves it running to serve
the builds after this one. A process the command leaves running is therefore killed only when the watchdog kills the
run. The job lets a process that asks to break away do so, since without that its start fails; one that breaks away is
outside the tree. A gate inside a gate nests one job inside the other, so the outer gate's kill reaches the inner
gate's command too.

The job is named Local\gate-job-<the gate's own pid>, so a caller that must stop a gate from outside finds its job from
the gate's pid: `pwsh tools/gate.ps1 -StopTree <pid>` takes one snapshot of the processes under <pid>, <pid> included,
terminates the job of every gate among them, then terminates every process of the snapshot still running, deepest
first. A job holds what a parent chain loses: a process whose parent has already exited is missed by anything that
follows parent pids, such as `taskkill /T`, and only the gate's job still holds it. The name lives only while the gate
holds the job, so a gate already gone leaves nothing to find by it.

The watchdog samples the job every few seconds and kills it for the first of three reasons, each with its own line in
the log and on standard error:
 - `gate: STALLED`: nothing happened for -StallSeconds. Nothing is the log and <log>.err not growing, the job gaining
   no CPU time (its accounting, which counts the jobs nested in it and the processes that have exited), no new process
   appearing in it, and no build server (below) started since the command was gaining CPU time. A stalled run has
   hung: read the log for where it stopped.
 - `gate: TIMED OUT`: the ceiling ran out on the load-adjusted clock. That clock advances by the share of the machine
   the command could have had: each sample adds its wall time times the share of logical processors not busy with
   other work (never less than 5%), so on an idle machine it is wall time and on a machine that other sessions keep
   busy it runs slower. A run that times out kept working past its ceiling even allowing for load: a busy loop, or a
   ceiling set too tight. Read the log before raising it.
 - `gate: BACKSTOP`: five times the ceiling passed in plain wall time, whatever the load. The line gives the share of
   the machine that was free on average; a low one means the machine was busy rather than the command wrong, so run it
   once more alone before reading anything into it.
A kill adds `gate: terminated the job's <n> processes` to the log, n being the processes the job held at the kill. A
command that exits on its own between the sample that found a reason and the kill keeps its own status. The passed
line gives the wall time, the load-adjusted time and the ceiling side by side, so a ceiling that is getting tight
shows before it bites. When a sample throws, the gate says
`gate: sampler failed: <message>; watching by wall time only` once and takes no more samples: the stall and the
ceiling can no longer be told, and only the backstop, which needs nothing but a clock, still kills the run. A failure
anywhere else after the command has started terminates the job, adds the error to the log and ends the gate with it.

At most a few gates run at once across the machine, one to a slot, and a slot is heavy or light, as -Slot says. The
heavy slots are the named mutexes Local\gate-slot-0 to Local\gate-slot-<n-1>, n being $env:GATE_HEAVY_SLOTS or, unset,
a quarter of the logical processors after one is left for the user (at least one): a heavy gate is taken to keep about
four threads busy through its own parallelism. The light slots are Local\gate-light-slot-0 to
Local\gate-light-slot-<m-1>, m being $env:GATE_LIGHT_SLOTS or, unset, half the logical processors after one is left for
the user (at least one): a light gate is taken to keep one or two threads busy. The two pools are independent: a gate
takes one slot of its own kind and never waits on the other kind, so a serial test run does not queue behind builds,
nor builds behind it. The heavy slots bear the names a copy of the gate without -Slot takes, so such a copy shares the
heavy pool. A gate that finds every slot of its kind held says `gate: waiting for a heavy slot` (or a light one) once
and tries again every 2 s, and its clocks start once it holds one. Mutexes rather than a counting semaphore because a
killed gate abandons its mutex, which the next gate then takes, saying so, where a semaphore's count would be lost for
good. The command is started with GATE_SLOT_HELD=1, so a gate it runs in turn (a gate inside a gate) takes no slot of
either kind and does not wait on the one its parent holds, though it still needs -Slot; set that variable yourself to
run a gate outside the slots. GATE_SAMPLE_SECONDS sets the sampling interval, 5 s when unset.
GATE_TEST_SAMPLER_FAIL=1 is for the self-test only: it makes every sample throw, to prove the path above.
GATE_TEST_SLOT_PREFIX is for the self-test only: up to 32 letters, digits and dashes put in front of both pools' mutex
names (Local\<prefix>gate-slot-<i>, Local\<prefix>gate-light-slot-<i>), so its slot cases use slots no other session
holds. GATE_TEST_NATIVE_CACHE is for the self-test only: the folder used in place of the native cache below.

The gate's native calls are C# compiled with Add-Type into a class named after a hash of their source. The compiled
assembly is cached per user as $env:LOCALAPPDATA\gate\GateNative_<hash>.dll and loaded from there, since compiling it
costs every gate about a second of CPU. The first gate of a version compiles it to a file of its own in that folder and
moves it into place; a gate that loses that race to another deletes its own copy, so no gate loads a half-written file.
A gate that cannot write the folder or load the file compiles the class in memory as before, says
`gate: native cache unusable (<reason>); compiled in memory` once, and runs on. A new version of the source has a new
hash and so a new file; the gate that writes it deletes every other GateNative_*.dll in the folder, and any own copy a
gate left there over an hour ago. That is best effort: a dll a running gate has loaded is locked, stays, and goes with
the next new version, and a file that cannot be deleted costs the gate nothing and gets no line.

The command runs at below-normal priority, so the machine stays usable while it does: the gate creates it in that
class, or in the gate's own when the gate already runs at below-normal or idle, and everything it starts inherits the
class. A build server already running from an earlier build (VBCSCompiler, or an MSBuild node that dotnet leaves
running) is not started by the command and does not inherit it, so the watchdog lowers any it finds above below-normal,
once each; one it cannot lower is named once in the log and does not fail the gate. A build server outside the job
started after the command was counts as progress, because a build hands its compiling to it; one that was already
running does not, because the servers other sessions' builds left behind gain CPU all the time and would keep a hung
command from ever reading as stalled. A build that hands its work to an old server still shows progress through its
own output. Callers never wrap a gate in `nice` or set a priority of their own.

A gate's builds start MSBuild worker nodes of their own: the command runs with MSBUILDDISABLENODEREUSE=1 and
DOTNET_CLI_USE_MSBUILD_SERVER=0, so its nodes run inside the command's job, where their CPU is measured, they inherit
below-normal priority and they die with a kill, instead of being handed to nodes some earlier build left running. That
costs a build a few seconds of node start-up (0.4 s to 3 s, measured 2026-09-27 on two .NET repos). The compiler
server, VBCSCompiler, stays shared, because a build without it ran three to five times slower; it is covered by the
rules above. Like the priority, both variables are set only for the command: the gate takes the caller's values back
once it has started.

The command's standard output goes to -Log and its standard error to <log>.err, and its standard input is NUL; it
inherits those three handles and no other of the gate's, and it shares the gate's console, so Ctrl+C reaches it. Once
the process has ended the .err file is appended to the log and removed, so one file holds everything, the output first
and the errors after it, then the gate's own lines. The command runs in the caller's working directory, its PowerShell
location when it runs the gate in its own session, and a relative -Log is read from it too. A .cmd or .bat command runs
through cmd.exe /d /s /c.

The options are read by hand out of $args rather than declared in a param block: a declared block sends this script's
own arguments through PowerShell's parameter binder, which reads the bare -- of
`pwsh tools/gate.ps1 -Log x -TimeoutSeconds 5 -Slot heavy -- dotnet test -c Release` as a parameter name and stops with "the
parameter name '' is ambiguous" (PowerShell 7.5, 2026-09-14). A script with no param block is handed every word
untouched, separator and all, which is what lets the command keep its own -c. A caller in a session of its own
(`& tools/gate.ps1 ... -- dotnet build`) has the separator eaten by the parser before the script ever sees it, so the
command is read as everything past a --, or as the first word that is not one of the options above. It is then started
as it arrived, never through Invoke-Expression, so nothing in it is re-parsed by a shell.

.PARAMETER Log
Required. Where the whole output is written, its directory created when missing, and an earlier run's log replaced.
<log>.err holds the command's standard error until the process ends and it is appended here.

.PARAMETER TimeoutSeconds
Required, a whole number above 0. The ceiling on the load-adjusted clock, and a fifth of the wall-time backstop. A
ceiling is a few times what the command takes on an idle machine today.

.PARAMETER Slot
Required, heavy or light: the pool of slots the gate waits on (see above). heavy for a command that keeps many threads
busy, such as a build or a parallel test run; light for one that keeps one or two busy, such as a serial test run or
one headless engine run. When unsure, heavy: a light gate whose command keeps many threads busy takes cores the heavy
slots count on, where a heavy gate whose command keeps one busy only waits longer than it had to.

.PARAMETER StallSeconds
How long the command may go without output, CPU time or a new process before it is killed as stalled. Defaults to 120.

.PARAMETER Tail
How many of the log's last lines are printed. Defaults to 20.

.PARAMETER NoMarkers
A switch: the log is not scanned for failure markers, so the command's own exit status is the verdict. For a command
whose output can quote a failure that is not its own, such as a tool whose output quotes another program's error lines.

.PARAMETER StopTree
Used alone, as the only option: the pid of a process whose tree is stopped, gates' jobs first (see above). A pid that is
not a live process is a usage error.

.OUTPUTS
With -StopTree: `gate: stopped <n> gate job(s) and <m> process(es) under <pid>` on standard output, m counting the
processes still running once the jobs were terminated, and exit 0; a job or process that could not be stopped is named on
standard error with `gate: could not stop: ` and the exit status is 1.

Otherwise: on a failure, the log's failure marker lines with their line numbers (none with -NoMarkers); then the log's last -Tail
lines, then one verdict line: `gate: passed in <w> s (load-adjusted <a> s, ceiling <n> s). Full output: <log>` on
standard output, or `gate: FAILED (status <n>). Full output: <log>` on standard error. The exit status is the command's
own, 1 for a zero exit whose log reports a failure (never with -NoMarkers), 124 for any watchdog kill, and 2 for a usage
this script could not read or a machine that is not Windows.
#>

if (-not $IsWindows) {
    [Console]::Error.WriteLine('gate: this gate runs on Windows only (it uses kernel32 and Windows job objects)')
    exit 2
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# One regex for every line that means a gate failed even when the runner exited 0, plus this wrapper's own kill lines so
# that a gate wrapping a gate reports the inner one's kill.
$markers = '^Build FAILED\.|error CS\d+|: error |Test run summary: Failed!|^\s*failed: [1-9]|gate: (TIMED OUT|STALLED|BACKSTOP)'
$usage = @(
    'usage: pwsh tools/gate.ps1 -Log <path> -TimeoutSeconds <n> -Slot heavy|light [-StallSeconds <n>] [-Tail <n>] [-NoMarkers] ' +
    '-- <command> [args...]'
    '       pwsh tools/gate.ps1 -StopTree <pid>'
)
$requiredLine = 'all four of -Log, -TimeoutSeconds, -Slot and the command are required.'
# The two pools of slots: the mutex names' prefix, the variable that sets the count, and the threads a gate of the kind
# is taken to keep busy, which divide the logical processors left after one for the user into the default count.
$slotPools = [ordered]@{
    heavy = @{ Prefix = 'gate-slot-'; Variable = 'GATE_HEAVY_SLOTS'; Threads = 4 }
    light = @{ Prefix = 'gate-light-slot-'; Variable = 'GATE_LIGHT_SLOTS'; Threads = 2 }
}
$aboveBelowNormal = @('Normal', 'AboveNormal', 'High', 'RealTime')
# What the command is started with: the slot marked held for any gate it runs in turn, and MSBuild made to start worker
# nodes of its own rather than hand the build to reused nodes or the MSBuild server outside the job.
$commandEnvironment = [ordered]@{
    GATE_SLOT_HELD                = '1'
    MSBUILDDISABLENODEREUSE       = '1'
    DOTNET_CLI_USE_MSBUILD_SERVER = '0'
}

# The sampler's and the job's native calls, compiled once per version into the per-user cache (Get-NativeType) and
# loaded from it by every gate after. Nothing here goes through WMI: a CIM query can
# block for seconds or for good, and a watchdog whose sampler can hang is worse than none. The class is named after a
# hash of this source (Get-NativeType), so a session that ran another version of this gate, whose class of the same
# name lacks a member this one calls, compiles this version beside it instead of calling the old one.
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class __GATE_NATIVE__
{
    public sealed class Entry
    {
        public int Id;
        public int ParentId;
        public string Name;
    }

    // What StopTree did: the gate jobs it terminated, the processes it terminated itself, and each stop that failed.
    public sealed class StopResult
    {
        public int Jobs;
        public int Processes;
        public List<string> Failures = new List<string>();
    }

    private sealed class TreeNode
    {
        public int Id;
        public int Depth;
        public long Created;
    }

    // The command's process, as started by StartSuspended: its id, a wait on its end and its exit code, read through the
    // handle CreateProcessW returned.
    public sealed class Command : IDisposable
    {
        public int Id;
        internal IntPtr Process;
        internal IntPtr Thread;

        public bool WaitForExit(int milliseconds)
        {
            uint result = WaitForSingleObject(Process, (uint)milliseconds);
            if (result == WaitObject0)
            {
                return true;
            }
            if (result == WaitTimeout)
            {
                return false;
            }
            throw Failure("WaitForSingleObject", Marshal.GetLastWin32Error());
        }

        public bool HasExited
        {
            get { return WaitForExit(0); }
        }

        public int ExitCode
        {
            get
            {
                uint code;
                if (!GetExitCodeProcess(Process, out code))
                {
                    throw Failure("GetExitCodeProcess", Marshal.GetLastWin32Error());
                }
                return unchecked((int)code);
            }
        }

        public void Dispose()
        {
            Release(Thread);
            Thread = IntPtr.Zero;
            Release(Process);
            Process = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        public bool InheritHandle;
    }

    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (winnt.h).
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const uint SnapProcess = 0x2;
    private const uint ProcessTerminate = 0x1;
    private const uint QueryLimitedInformation = 0x1000;
    private const uint Synchronize = 0x100000;
    private const uint JobObjectQuery = 0x4;
    private const uint JobObjectTerminate = 0x8;
    private const int ErrorFileNotFound = 2;
    private const int ErrorInvalidParameter = 87;
    private const int ErrorAlreadyExists = 183;
    private const uint StopExitCode = 124;
    private const int JobEndMilliseconds = 2000;
    private const int ProcessCommandLineInformation = 60;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicProcessIdList = 3;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitBreakawayOk = 0x800;
    private const int ErrorMoreData = 234;
    private const uint CreateSuspended = 0x00000004;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint BelowNormalPriorityClass = 0x00004000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const int StartfUseStdHandles = 0x00000100;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint ShareAll = 0x7;
    private const uint CreateAlways = 2;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x80;
    private const int AttributeHandleList = 0x00020002;
    private const int AttributeDesktopAppPolicy = 0x00020012;
    private const int DesktopAppBreakawayDisableProcessTree = 0x2;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;
    private const uint ResumeFailed = 0xFFFFFFFF;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, int length, out int returned);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "QueryInformationJobObject")]
    private static extern bool QueryAccounting(IntPtr job, int infoClass, ref BasicAccountingInformation info, int length, out int returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
        IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref StartupInfoEx startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    private static System.ComponentModel.Win32Exception Failure(string operation, int error)
    {
        string reason = new System.ComponentModel.Win32Exception(error).Message;
        return new System.ComponentModel.Win32Exception(error, operation + " failed with Win32 error " + error + ": " + reason);
    }

    private static void Check(bool succeeded, string operation)
    {
        if (!succeeded)
        {
            throw Failure(operation, Marshal.GetLastWin32Error());
        }
    }

    // A handle the command inherits, to a file every process may read, write and delete while it is open, so the gate
    // can read the log's size and tail while the command writes it.
    private static IntPtr OpenInheritable(string path, uint access, uint disposition)
    {
        var attributes = new SecurityAttributes();
        attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
        attributes.InheritHandle = true;
        IntPtr handle = CreateFileW(path, access, ShareAll, ref attributes, disposition, FileAttributeNormal, IntPtr.Zero);
        Check(handle != InvalidHandle, "CreateFileW(" + path + ")");
        return handle;
    }

    // Creates the command suspended, in the given directory and with this process's environment and console, its standard
    // input from NUL, its output to output and its errors to error. It inherits those three handles and no other
    // (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), and the desktop app policy keeps every process it and its descendants create
    // inside the desktop app runtime, so the children of a packaged app such as the Store's pwsh do not leave the job
    // the process is put in (PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY). Without belowNormal the process takes its
    // priority class from this one.
    public static Command StartSuspended(string commandLine, string directory, string output, string error, bool belowNormal)
    {
        IntPtr input = IntPtr.Zero, stdout = IntPtr.Zero, stderr = IntPtr.Zero;
        IntPtr handles = IntPtr.Zero, policy = IntPtr.Zero, list = IntPtr.Zero;
        bool listReady = false;
        try
        {
            input = OpenInheritable("NUL", GenericRead, OpenExisting);
            stdout = OpenInheritable(output, GenericWrite, CreateAlways);
            stderr = OpenInheritable(error, GenericWrite, CreateAlways);
            handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
            Marshal.WriteIntPtr(handles, 0, input);
            Marshal.WriteIntPtr(handles, IntPtr.Size, stdout);
            Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, stderr);
            policy = Marshal.AllocHGlobal(sizeof(int));
            Marshal.WriteInt32(policy, DesktopAppBreakawayDisableProcessTree);
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list, 2, 0, ref size), "InitializeProcThreadAttributeList");
            listReady = true;
            Check(UpdateProcThreadAttribute(list, 0, (IntPtr)AttributeHandleList, handles, (IntPtr)(3 * IntPtr.Size),
                IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(HANDLE_LIST)");
            Check(UpdateProcThreadAttribute(list, 0, (IntPtr)AttributeDesktopAppPolicy, policy, (IntPtr)sizeof(int),
                IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(DESKTOP_APP_POLICY)");
            var startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.AttributeList = list;
            uint flags = CreateSuspended | CreateUnicodeEnvironment | ExtendedStartupInfoPresent;
            if (belowNormal)
            {
                flags |= BelowNormalPriorityClass;
            }
            ProcessInformation created;
            Check(CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero,
                directory, ref startup, out created), "CreateProcessW(" + commandLine + ")");
            return new Command { Id = created.dwProcessId, Process = created.hProcess, Thread = created.hThread };
        }
        finally
        {
            if (listReady)
            {
                DeleteProcThreadAttributeList(list);
            }
            Marshal.FreeHGlobal(list);
            Marshal.FreeHGlobal(handles);
            Marshal.FreeHGlobal(policy);
            Release(input);
            Release(stdout);
            Release(stderr);
        }
    }

    // Puts the suspended command in the job, then lets it run, so nothing it starts can run outside the job. A command
    // that cannot be put in the job or resumed is terminated before the error is thrown.
    public static void AssignAndResume(IntPtr job, Command command)
    {
        if (!AssignProcessToJobObject(job, command.Process))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(command.Process, 1);
            throw Failure("AssignProcessToJobObject", error);
        }
        if (ResumeThread(command.Thread) == ResumeFailed)
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(command.Process, 1);
            throw Failure("ResumeThread", error);
        }
    }

    // The job's accounting, nested jobs included: the kernel plus user time of every process it has held, those that
    // have exited included, in 100 ns units, and how many processes are in it now.
    public static long[] JobAccounting(IntPtr job)
    {
        var info = new BasicAccountingInformation();
        int returned;
        Check(QueryAccounting(job, JobObjectBasicAccountingInformation, ref info, Marshal.SizeOf(typeof(BasicAccountingInformation)),
            out returned), "QueryInformationJobObject(JobObjectBasicAccountingInformation)");
        return new long[] { info.TotalUserTime + info.TotalKernelTime, info.ActiveProcesses };
    }

    // The machine's idle, kernel (idle included) and user time, in 100 ns units.
    public static long[] SystemTimes()
    {
        long idle, kernel, user;
        if (!GetSystemTimes(out idle, out kernel, out user))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return new long[] { idle, kernel, user };
    }

    public static List<Entry> Snapshot()
    {
        var entries = new List<Entry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapProcess, 0);
        if (snapshot == InvalidHandle)
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            var entry = new ProcessEntry32();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            bool more = Process32FirstW(snapshot, ref entry);
            while (more)
            {
                entries.Add(new Entry { Id = (int)entry.ProcessId, ParentId = (int)entry.ParentProcessId, Name = entry.ExeFile });
                more = Process32NextW(snapshot, ref entry);
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return entries;
    }

    // One process's creation time (FILETIME) and kernel plus user time, both in 100 ns units; false when it cannot be
    // opened: another user's or a protected process, or one that exited after it was listed.
    public static bool TryGetTimes(int processId, out long creation, out long cpu)
    {
        creation = 0;
        cpu = 0;
        IntPtr process = OpenProcess(QueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            long exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                return false;
            }
            cpu = kernel + user;
            return true;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    // One process's command line (ProcessCommandLineInformation, Windows 8.1 and later), or null when it cannot be read.
    public static string CommandLine(int processId)
    {
        IntPtr process = OpenProcess(QueryLimitedInformation, false, processId);
        if (process == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            int needed;
            NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out needed);
            if (needed <= 0)
            {
                return null;
            }
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, needed, out needed) != 0)
                {
                    return null;
                }
                var text = (UnicodeString)Marshal.PtrToStructure(buffer, typeof(UnicodeString));
                return text.Buffer == IntPtr.Zero ? string.Empty : Marshal.PtrToStringUni(text.Buffer, text.Length / 2);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    // A new job under the given name whose processes may break away when they ask to, and are not killed when its handle
    // closes. The name is how StopTree finds the job from the gate's pid, so a name another job already holds is an error.
    public static IntPtr CreateJob(string name)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
        if (job == IntPtr.Zero)
        {
            throw Failure("CreateJobObjectW(" + name + ")", Marshal.GetLastWin32Error());
        }
        if (Marshal.GetLastWin32Error() == ErrorAlreadyExists)
        {
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(ErrorAlreadyExists, "CreateJobObjectW(" + name + ") found a job of that name already");
        }
        var info = new ExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitBreakawayOk;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimitInformation))))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        return job;
    }

    // Every process in the job and in the jobs nested inside it. The list's header is two counts, the processes the job
    // holds and the ids the buffer holds; the buffer grows until the second reaches the first.
    public static int[] JobProcessIds(IntPtr job)
    {
        int capacity = 64;
        while (true)
        {
            int length = 8 + capacity * IntPtr.Size;
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.WriteInt64(buffer, 0, 0);
                int returned;
                bool read = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, length, out returned);
                int error = read ? 0 : Marshal.GetLastWin32Error();
                if (!read && error != ErrorMoreData)
                {
                    throw new System.ComponentModel.Win32Exception(error);
                }
                int assigned = Marshal.ReadInt32(buffer, 0);
                int listed = Marshal.ReadInt32(buffer, 4);
                if (read && listed >= assigned)
                {
                    var ids = new int[listed];
                    for (int i = 0; i < listed; i++)
                    {
                        ids[i] = (int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
                    }
                    return ids;
                }
                capacity = Math.Max(capacity * 2, assigned + 16);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    // The processes under root in one snapshot, root included, each with its depth and creation time; null when root is
    // not in the snapshot, and root alone when its creation time cannot be read. A process counts as a child only when it
    // was created at or after its parent, so a process that took over a dead parent's pid adopts none of that parent's
    // children; one whose creation time cannot be read is left out with everything under it.
    private static List<TreeNode> ProcessTree(int root)
    {
        var children = new Dictionary<int, List<int>>();
        bool found = false;
        foreach (Entry entry in Snapshot())
        {
            found |= entry.Id == root;
            if (entry.Id == entry.ParentId)
            {
                continue;
            }
            List<int> list;
            if (!children.TryGetValue(entry.ParentId, out list))
            {
                list = new List<int>();
                children[entry.ParentId] = list;
            }
            list.Add(entry.Id);
        }
        if (!found)
        {
            return null;
        }
        long created, cpu;
        TryGetTimes(root, out created, out cpu);
        var tree = new List<TreeNode> { new TreeNode { Id = root, Depth = 0, Created = created } };
        if (created == 0)
        {
            return tree;
        }
        var seen = new HashSet<int> { root };
        for (int i = 0; i < tree.Count; i++)
        {
            TreeNode parent = tree[i];
            List<int> list;
            if (!children.TryGetValue(parent.Id, out list))
            {
                continue;
            }
            foreach (int id in list)
            {
                long childCreated;
                if (!seen.Contains(id) && TryGetTimes(id, out childCreated, out cpu) && childCreated >= parent.Created)
                {
                    seen.Add(id);
                    tree.Add(new TreeNode { Id = id, Depth = parent.Depth + 1, Created = childCreated });
                }
            }
        }
        return tree;
    }

    // Terminates the job a gate with this pid created, when there is one, and adds the processes it held to members.
    private static void StopGateJob(int id, StopResult result, HashSet<int> members)
    {
        string name = "Local\\gate-job-" + id;
        IntPtr job = OpenJobObjectW(JobObjectQuery | JobObjectTerminate, false, name);
        if (job == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorFileNotFound)
            {
                result.Failures.Add(Failure("OpenJobObjectW(" + name + ")", error).Message);
            }
            return;
        }
        try
        {
            try
            {
                foreach (int member in JobProcessIds(job))
                {
                    members.Add(member);
                }
            }
            catch (System.ComponentModel.Win32Exception listing)
            {
                result.Failures.Add("listing the processes of " + name + " failed: " + listing.Message);
            }
            if (TerminateJobObject(job, StopExitCode))
            {
                result.Jobs++;
            }
            else
            {
                result.Failures.Add(Failure("TerminateJobObject(" + name + ")", Marshal.GetLastWin32Error()).Message);
            }
        }
        finally
        {
            CloseHandle(job);
        }
    }

    // Terminates one process of the tree unless it has ended, or its pid now belongs to a process created after the
    // snapshot. A process a terminated job held is given up to waitMs to end first, since a job's termination is
    // asynchronous, so only a process this pass had to stop itself is counted.
    private static void StopProcess(TreeNode node, int waitMs, StopResult result)
    {
        IntPtr process = OpenProcess(ProcessTerminate | QueryLimitedInformation | Synchronize, false, node.Id);
        if (process == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != ErrorInvalidParameter)
            {
                result.Failures.Add(Failure("OpenProcess(" + node.Id + ")", error).Message);
            }
            return;
        }
        try
        {
            long created, exit, kernel, user;
            bool same = GetProcessTimes(process, out created, out exit, out kernel, out user) && created == node.Created;
            if (!same || WaitForSingleObject(process, (uint)waitMs) == WaitObject0)
            {
                return;
            }
            if (TerminateProcess(process, StopExitCode))
            {
                result.Processes++;
                return;
            }
            int error = Marshal.GetLastWin32Error();
            if (WaitForSingleObject(process, 1000) != WaitObject0)
            {
                result.Failures.Add(Failure("TerminateProcess(" + node.Id + ")", error).Message);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    // Stops every gate under root and every process of the tree: first the job of each process in the tree that is a
    // gate (Local\gate-job-<pid>), which ends the processes whose parent chain is already broken, then each process of
    // the tree still running, deepest first, except self. Null when root is not a live process.
    public static StopResult StopTree(int root, int self)
    {
        List<TreeNode> tree = ProcessTree(root);
        if (tree == null)
        {
            return null;
        }
        var result = new StopResult();
        var members = new HashSet<int>();
        foreach (TreeNode node in tree)
        {
            StopGateJob(node.Id, result, members);
        }
        tree.Sort((a, b) => b.Depth.CompareTo(a.Depth));
        var clock = System.Diagnostics.Stopwatch.StartNew();
        foreach (TreeNode node in tree)
        {
            if (node.Id == self)
            {
                continue;
            }
            int wait = members.Contains(node.Id) ? Math.Max(0, JobEndMilliseconds - (int)clock.ElapsedMilliseconds) : 0;
            StopProcess(node, wait, result);
        }
        return result;
    }

    public static void TerminateJob(IntPtr job, uint exitCode)
    {
        if (!TerminateJobObject(job, exitCode))
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    public static void Release(IntPtr handle)
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
        }
    }
}
'@

# Loads the class from the cache, compiling it into the cache first when the file is not there. The compile goes to a
# file of this gate's own and is then moved into place; a move that finds the file there already lost a race to another
# gate, whose copy is as good, and the own copy is deleted either way.
function Import-CachedNativeType {
    param([string]$TypeName)
    $folder = if ($env:GATE_TEST_NATIVE_CACHE) { $env:GATE_TEST_NATIVE_CACHE } else { Join-Path $env:LOCALAPPDATA 'gate' }
    $path = Join-Path $folder "$TypeName.dll"
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force $folder | Out-Null
        $own = Join-Path $folder "$TypeName.$PID.$([guid]::NewGuid().ToString('N')).tmp"
        $wrote = $false
        try {
            Add-Type -TypeDefinition $nativeSource.Replace('__GATE_NATIVE__', $TypeName) -OutputAssembly $own
            try {
                [System.IO.File]::Move($own, $path)
                $wrote = $true
            }
            catch [System.IO.IOException] { if (-not (Test-Path -LiteralPath $path)) { throw } }
        }
        finally {
            Remove-Item -LiteralPath $own -ErrorAction SilentlyContinue
        }
        if ($wrote) { Remove-StaleNative -Folder $folder -Keep "$TypeName.dll" }
    }
    if (-not ($TypeName -as [type])) { Add-Type -Path $path }
}

# After a gate put a new version in the cache: every other version's dll, and every own copy a gate left behind over an
# hour ago, is deleted. A dll a running gate has loaded is locked and stays for a later gate to delete; any file that
# cannot be deleted is left without a word.
function Remove-StaleNative {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Deletes only the gate''s own cache files, documented above; there is nothing for a caller to confirm.')]
    param([string]$Folder, [string]$Keep)
    $cutoff = [DateTime]::UtcNow.AddHours(-1)
    foreach ($file in @(Get-ChildItem -LiteralPath $Folder -File -Filter 'GateNative_*' -ErrorAction SilentlyContinue)) {
        $oldVersion = $file.Name -like '*.dll' -and $file.Name -ne $Keep
        $leftOver = $file.Name -like '*.tmp' -and $file.LastWriteTimeUtc -lt $cutoff
        if ($oldVersion -or $leftOver) { Remove-Item -LiteralPath $file.FullName -ErrorAction SilentlyContinue }
    }
}

# The native class for this version of the source, loaded or compiled on first use in a session. A cache that cannot be
# used costs the gate the compile, never the run.
function Get-NativeType {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($nativeSource)
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA1]::HashData($bytes)).Substring(0, 8)
    $typeName = 'GateNative_' + $hash
    if ($typeName -as [type]) { return $typeName -as [type] }
    try {
        Import-CachedNativeType -TypeName $typeName
    }
    catch {
        Write-Gate "gate: native cache unusable ($($_.Exception.Message)); compiled in memory"
    }
    if (-not ($typeName -as [type])) { Add-Type -TypeDefinition $nativeSource.Replace('__GATE_NATIVE__', $typeName) }
    return $typeName -as [type]
}

# The wrapper's own commentary goes to standard error, so a caller reading the command's output
# from the screen is not handed the gate's lines in the middle of it.
function Write-Gate {
    param([string]$Line)
    [Console]::Error.WriteLine($Line)
}

# CreateProcess takes one command line, which the command splits back into its arguments, so each argument is
# written here the way the Windows command-line rules read it back into one argv entry (Parsing C command-line
# arguments: https://learn.microsoft.com/cpp/c-language/parsing-c-command-line-arguments). An argument that is empty or
# holds whitespace or a quote - a test filter, a path under Program Files, a -Command script - is wrapped in quotes; a
# quote inside becomes \", and a run of backslashes before a quote, the closing one included, is doubled, since only
# there are backslashes read as escapes. Any other argument is passed as it is.
function Format-Argument {
    param([string]$Value)
    if ($Value -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = $Value -replace '(\\*)"', { $_.Groups[1].Value * 2 + '\"' }
    $escaped = $escaped -replace '(\\+)$', { $_.Groups[1].Value * 2 }
    return '"' + $escaped + '"'
}

# On Windows a bare command name is resolved to the first file on PATH that Windows can start (an extension PATHEXT
# lists). An extensionless script earlier on PATH - the bash shims a Claude Code plugin puts in front of `uv` and
# `python` for the Bash tool, which a pwsh started from Bash inherits - is otherwise what the name resolves to, and
# CreateProcess cannot run it. A name with an extension or a directory is taken as written.
function Resolve-Runnable {
    param([string]$Name)
    if ([System.IO.Path]::GetExtension($Name) -or [System.IO.Path]::GetDirectoryName($Name)) {
        return $Name
    }
    $runnable = $env:PATHEXT -split ';'
    $found = Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue |
        Where-Object { $runnable -contains $_.Extension } |
        Select-Object -First 1
    if ($found) { return $found.Source }
    return $Name
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

# Splits the words into this script's options and the command. Returns $null, having said why, for an option it cannot
# read.
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
        # that is not an option of this script's.
        if (-not $word.StartsWith('-')) {
            return @{ Options = $options; Command = @($Words | Select-Object -Skip $read) }
        }
        $taken = Read-Option -Options $options -Words $Words -At $read
        if ($taken -eq 0) { return $null }
        $read += $taken
    }
    return @{ Options = $options; Command = @() }
}

function Test-WholeNumber {
    param([string]$Value)
    $number = 0
    $style = [System.Globalization.NumberStyles]::None
    return [int]::TryParse($Value, $style, [cultureinfo]::InvariantCulture, [ref]$number) -and $number -gt 0
}

function Test-Duration {
    param([string]$Value)
    $number = 0.0
    $style = [System.Globalization.NumberStyles]::AllowDecimalPoint
    return [double]::TryParse($Value, $style, [cultureinfo]::InvariantCulture, [ref]$number) -and $number -gt 0
}

# Every input that is missing or cannot be read, one line each, so a caller learns all of them from one run.
function Get-InputProblem {
    param([hashtable]$Options, [object[]]$Command)
    $problems = [System.Collections.Generic.List[string]]::new()
    if (-not $Options['Log']) {
        $problems.Add('gate: missing -Log <path>: every gate writes its whole output to a log, e.g. -Log .tmp/test.log')
    }
    if (-not $Options['TimeoutSeconds']) {
        $problems.Add('gate: missing -TimeoutSeconds <n>: every gate needs a ceiling in seconds (a whole number above 0); there is no default')
    }
    $slotProblem = Get-SlotProblem $Options['Slot']
    if ($slotProblem) { $problems.Add($slotProblem) }
    if ($Command.Count -lt 1) {
        $problems.Add('gate: missing the command: put it after --, e.g. -- dotnet test')
    }
    foreach ($name in 'TimeoutSeconds', 'StallSeconds', 'Tail') {
        $value = $Options[$name]
        if ($value -and -not (Test-WholeNumber $value)) {
            $problems.Add("gate: -$name must be a whole number above 0, got '$value'")
        }
    }
    foreach ($problem in (Get-EnvironmentProblem)) { $problems.Add($problem) }
    return , $problems
}

# The line for a -Slot that is missing or neither kind, or $null for heavy or light in any case.
function Get-SlotProblem {
    param([string]$Value)
    if (-not $Value) {
        return 'gate: missing -Slot heavy|light: heavy for a command that keeps many threads busy (a build, a parallel test run), ' +
        'light for one that keeps one or two busy (a serial test run, one headless engine run)'
    }
    if ($Value -notin $slotPools.Keys) { return "gate: -Slot must be heavy or light, got '$Value'" }
    return $null
}

function Get-EnvironmentProblem {
    foreach ($pool in $slotPools.Values) {
        $value = [Environment]::GetEnvironmentVariable($pool.Variable)
        if ($value -and -not (Test-WholeNumber $value)) {
            "gate: $($pool.Variable) must be a whole number above 0, got '$value'"
        }
    }
    if ($env:GATE_SAMPLE_SECONDS -and -not (Test-Duration $env:GATE_SAMPLE_SECONDS)) {
        "gate: GATE_SAMPLE_SECONDS must be a number of seconds above 0, got '$env:GATE_SAMPLE_SECONDS'"
    }
    if ($env:GATE_TEST_SLOT_PREFIX -and $env:GATE_TEST_SLOT_PREFIX -cnotmatch '^[A-Za-z0-9-]{1,32}$') {
        "gate: GATE_TEST_SLOT_PREFIX must be up to 32 letters, digits and dashes, got '$env:GATE_TEST_SLOT_PREFIX'"
    }
}

function Get-SlotCount {
    param([string]$Kind)
    $pool = $slotPools[$Kind]
    $set = [Environment]::GetEnvironmentVariable($pool.Variable)
    if ($set) { return [int]$set }
    return [math]::Max(1, [math]::Floor(([Environment]::ProcessorCount - 1) / $pool.Threads))
}

# True when this thread now owns the mutex. A gate killed while holding a slot abandons its mutex, and the wait that
# reports the abandonment has handed ownership to this one, so it counts as taken, and is said on the screen and in
# the log.
function Request-Mutex {
    param([System.Threading.Mutex]$Mutex, [string]$Name, [System.Collections.Generic.List[string]]$Notes)
    try {
        return $Mutex.WaitOne(0)
    }
    catch [System.Threading.AbandonedMutexException] {
        $line = "gate: took $Name, which a killed gate had left held"
        Write-Gate $line
        $Notes.Add($line)
        return $true
    }
}

# Holds one of the machine's slots of the kind given, waiting for one when all of that kind are held; returns the mutex
# and the lines for the log.
function Enter-Slot {
    param([string]$Kind)
    $count = Get-SlotCount $Kind
    $prefix = "Local\$($env:GATE_TEST_SLOT_PREFIX)$($slotPools[$Kind].Prefix)"
    $notes = [System.Collections.Generic.List[string]]::new()
    $waiting = $false
    while ($true) {
        for ($slot = 0; $slot -lt $count; $slot++) {
            $name = "$prefix$slot"
            $mutex = [System.Threading.Mutex]::new($false, $name)
            if (Request-Mutex -Mutex $mutex -Name $name -Notes $notes) {
                return [pscustomobject]@{ Mutex = $mutex; Notes = $notes }
            }
            $mutex.Dispose()
        }
        if (-not $waiting) {
            $waiting = $true
            $line = "gate: waiting for a $Kind slot ($count busy)"
            Write-Gate $line
            $notes.Add($line)
        }
        Start-Sleep -Seconds 2
    }
}

function Exit-Slot {
    param($Slot)
    if ($Slot) {
        $Slot.Mutex.ReleaseMutex()
        $Slot.Mutex.Dispose()
    }
}

# The command as one command line, each word written by Format-Argument. The program is Resolve-Runnable's file, one
# given with a directory read against the caller's location, and a .cmd or .bat runs through cmd.exe /d /s /c, the way
# CreateProcess's documentation says to run a batch file.
function Get-CommandLine {
    param([object[]]$Command)
    $file = Resolve-Runnable ([string]$Command[0])
    if ([System.IO.Path]::GetDirectoryName($file)) {
        $file = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($file)
    }
    $words = @($file) + @($Command | Select-Object -Skip 1 | ForEach-Object { [string]$_ })
    $line = @($words | ForEach-Object { Format-Argument $_ }) -join ' '
    if ([System.IO.Path]::GetExtension($file) -in '.cmd', '.bat') {
        $shell = $env:ComSpec ?? (Join-Path $env:SystemRoot 'System32\cmd.exe')
        return "$(Format-Argument $shell) /d /s /c `"$line`""
    }
    return $line
}

# Starts the command suspended in the caller's location, below normal priority when the gate runs above it, and with
# the slot marked held; puts it in the job and only then lets it run, so every process it starts is created inside the
# job. The environment is inherited when the process is created, so the gate takes its own back straight after, which
# matters to a caller that ran it in its own session with &.
function Start-Command {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Starts the command this gate was asked to run; there is nothing for a caller to confirm.')]
    param([object[]]$Command, [IntPtr]$Job, [string]$Log, [string]$ErrLog)
    $line = Get-CommandLine $Command
    $directory = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
    $belowNormal = $aboveBelowNormal -contains [string](Get-Process -Id $PID).PriorityClass
    $saved = @{}
    foreach ($name in $commandEnvironment.Keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    try {
        foreach ($name in $commandEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $commandEnvironment[$name]) }
        $started = $script:Native::StartSuspended($line, $directory, $Log, $ErrLog, $belowNormal)
    }
    finally {
        # PowerShell hands a .NET string parameter '' for $null, which would leave an unset variable set and empty;
        # NullString passes a real null, which removes it.
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, ($saved[$name] ?? [NullString]::Value)) }
    }
    try {
        $script:Native::AssignAndResume($Job, $started)
    }
    catch {
        $started.Dispose()
        throw
    }
    return $started
}

function New-Watch {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Returns a new object; it changes no state outside this gate.')]
    param($Process, [IntPtr]$Job, [hashtable]$Options, [long]$Since,
        [System.Collections.Generic.List[string]]$Notes)
    $sample = if ($env:GATE_SAMPLE_SECONDS) { [double]::Parse($env:GATE_SAMPLE_SECONDS, [cultureinfo]::InvariantCulture) } else { 5.0 }
    return [pscustomobject]@{
        Process       = $Process
        Job           = $Job
        Files         = @($Options['Log'], "$($Options['Log']).err")
        Timeout       = [int]$Options['TimeoutSeconds']
        Stall         = [int]$Options['StallSeconds']
        Since         = $Since
        SampleMs      = [int][math]::Max(100, $sample * 1000)
        Cores         = [Environment]::ProcessorCount
        Clock         = [System.Diagnostics.Stopwatch]::StartNew()
        LastAt        = 0.0
        LastProgress  = 0.0
        Adjusted      = 0.0
        LastFree      = 1.0
        SamplerFailed = $false
        Size          = 0L
        SystemTimes   = $script:Native::SystemTimes()
        JobCpu        = $script:Native::JobAccounting($Job)[0]
        TreeIds       = @{}
        ServerCpu     = @{}
        CommandLines  = @{}
        Lowered       = @{}
        Notes         = $Notes
    }
}

# The command's tree: every process in its job, each created at or after the gate started the command, so a process
# that took over a pid between the job's list and the lookup is not adopted. Returns a set of pids; the tree's CPU time
# comes from the job's accounting instead, which also counts the processes that have exited.
function Get-Tree {
    param($Watch)
    $ids = @{}
    foreach ($id in $script:Native::JobProcessIds($Watch.Job)) {
        $created = 0L
        $used = 0L
        # A process that exited since the list was taken cannot be opened; that is expected on every sample.
        if ($script:Native::TryGetTimes($id, [ref]$created, [ref]$used) -and $created -ge $Watch.Since) { $ids[$id] = $true }
    }
    return $ids
}

function Test-NewProcess {
    param([hashtable]$Before, [hashtable]$After)
    foreach ($id in $After.Keys) {
        if (-not $Before.ContainsKey($id)) { return $true }
    }
    return $false
}

function Test-BuildServerLine {
    param([string]$Line)
    return $Line -match 'VBCSCompiler\.dll' -or ($Line -match 'MSBuild\.dll' -and $Line -match 'nodemode')
}

# Whether a process outside the job is a build server: VBCSCompiler.exe, or a dotnet.exe running VBCSCompiler.dll or an
# MSBuild node. A dotnet.exe's command line is read once per process.
function Test-BuildServer {
    param($Watch, $Entry, [string]$Key)
    if ($Entry.Name -eq 'VBCSCompiler.exe') { return $true }
    if ($Entry.Name -ne 'dotnet.exe') { return $false }
    if (-not $Watch.CommandLines.ContainsKey($Key)) { $Watch.CommandLines[$Key] = $script:Native::CommandLine($Entry.Id) }
    return Test-BuildServerLine $Watch.CommandLines[$Key]
}

# Lowers a build server above below-normal priority to below-normal, once per process; one that cannot be lowered is
# named once and left as it is.
function Set-ServerPriority {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Lowering build servers is what every gate does, documented above; there is nothing to confirm.')]
    param($Watch, [int]$Id, [string]$Name, [string]$Key)
    if ($Watch.Lowered.ContainsKey($Key)) { return }
    $Watch.Lowered[$Key] = $true
    try {
        $server = [System.Diagnostics.Process]::GetProcessById($Id)
        if ($aboveBelowNormal -contains [string]$server.PriorityClass) { $server.PriorityClass = 'BelowNormal' }
    }
    catch [System.ArgumentException], [System.InvalidOperationException] {
        # The server exited since the snapshot, which leaves nothing to lower and nothing worth a line.
        return
    }
    catch {
        $line = "gate: could not lower $Name ${Id}: $($_.Exception.Message)"
        Write-Gate $line
        $Watch.Notes.Add($line)
    }
}

# The build servers outside the job. Every one found is lowered to below-normal, but only those started since the gate
# started its command are returned, as pid -> CPU time: on a machine where other sessions build, the servers their
# builds left running gain CPU on every sample, and counting them would keep a hung command from ever reading as
# stalled.
function Get-BuildServer {
    param($Watch, $Entries, [hashtable]$Tree)
    $cpu = @{}
    foreach ($entry in $Entries) {
        if ($Tree.ContainsKey($entry.Id) -or ($entry.Name -ne 'VBCSCompiler.exe' -and $entry.Name -ne 'dotnet.exe')) { continue }
        $created = 0L
        $used = 0L
        # Another user's process, or one that exited since the snapshot, cannot be opened; that is expected, and a build
        # server this gate cannot read is not one its command is using.
        if (-not $script:Native::TryGetTimes($entry.Id, [ref]$created, [ref]$used)) { continue }
        $key = "$($entry.Id):$created"
        if (-not (Test-BuildServer -Watch $Watch -Entry $entry -Key $key)) { continue }
        Set-ServerPriority -Watch $Watch -Id $entry.Id -Name $entry.Name -Key $key
        if ($created -ge $Watch.Since) { $cpu[$entry.Id] = $used }
    }
    return $cpu
}

# How far one set of processes moved between two samples: the CPU time gained in 100 ns, whether a process seen before
# gained any, and whether one appeared.
function Measure-Cpu {
    param([hashtable]$Before, [hashtable]$After)
    $gained = 0L
    $rose = $false
    $appeared = $false
    foreach ($id in $After.Keys) {
        if (-not $Before.ContainsKey($id)) {
            $appeared = $true
            $gained += $After[$id]
            continue
        }
        $delta = $After[$id] - $Before[$id]
        if ($delta -gt 0) {
            $rose = $true
            $gained += $delta
        }
    }
    return [pscustomobject]@{ Gained = $gained; Rose = $rose; Appeared = $appeared }
}

function Test-LogGrew {
    param($Watch)
    $size = 0L
    foreach ($file in $Watch.Files) {
        $info = [System.IO.FileInfo]::new($file)
        if ($info.Exists) { $size += $info.Length }
    }
    $grew = $size -ne $Watch.Size
    $Watch.Size = $size
    return $grew
}

# The share of the machine not busy with work outside the command's job over the last interval, never below 5%.
function Get-FreeShare {
    param($Watch, [long[]]$Times, [long]$TreeGained, [double]$Interval)
    $idle = $Times[0] - $Watch.SystemTimes[0]
    $total = ($Times[1] - $Watch.SystemTimes[1]) + ($Times[2] - $Watch.SystemTimes[2])
    $busy = if ($total -gt 0) { 1.0 - ($idle / $total) } else { 0.0 }
    $treeCores = ($TreeGained / 1e7) / $Interval
    $others = [math]::Max(0.0, $busy * $Watch.Cores - $treeCores)
    return [math]::Max(0.05, ($Watch.Cores - $others) / $Watch.Cores)
}

# One sample: what moved since the last one, and the load-adjusted clock advanced by it.
function Update-Watch {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Updates this gate''s own watch object; it changes no state outside it.')]
    param($Watch)
    if ($env:GATE_TEST_SAMPLER_FAIL -eq '1') { throw 'GATE_TEST_SAMPLER_FAIL=1 makes every sample fail (self-test only)' }
    $now = $Watch.Clock.Elapsed.TotalSeconds
    $interval = [math]::Max(0.001, $now - $Watch.LastAt)
    $times = $script:Native::SystemTimes()
    $entries = $script:Native::Snapshot()
    $jobCpu = $script:Native::JobAccounting($Watch.Job)[0]
    $tree = Get-Tree $Watch
    $servers = Get-BuildServer -Watch $Watch -Entries $entries -Tree $tree
    $treeGained = $jobCpu - $Watch.JobCpu
    $appeared = Test-NewProcess -Before $Watch.TreeIds -After $tree
    $serverMove = Measure-Cpu -Before $Watch.ServerCpu -After $servers
    $grew = Test-LogGrew $Watch
    if ($grew -or $treeGained -gt 0 -or $appeared -or $serverMove.Rose) { $Watch.LastProgress = $now }
    $free = Get-FreeShare -Watch $Watch -Times $times -TreeGained $treeGained -Interval $interval
    $Watch.Adjusted += $interval * $free
    $Watch.LastFree = $free
    $Watch.LastAt = $now
    $Watch.SystemTimes = $times
    $Watch.JobCpu = $jobCpu
    $Watch.TreeIds = $tree
    $Watch.ServerCpu = $servers
}

# One sample, or none once a sample has failed: from then on the watch goes by wall time alone, which is all the
# backstop needs, so a sampler that throws cannot leave the command running unwatched.
function Step-Sampler {
    param($Watch)
    if ($Watch.SamplerFailed) { return }
    try {
        Update-Watch $Watch
    }
    catch {
        $Watch.SamplerFailed = $true
        $line = "gate: sampler failed: $($_.Exception.Message); watching by wall time only"
        Write-Gate $line
        $Watch.Notes.Add($line)
    }
}

function Get-FreePercent {
    param($Watch)
    if ($Watch.LastAt -le 0) { return 100 }
    return [math]::Round(100 * $Watch.Adjusted / $Watch.LastAt)
}

# The kill line for the first of the three reasons that holds, or $null while none does. Once the sampler has failed
# only the backstop is read, since the stall and the load-adjusted clock no longer move.
function Get-KillLine {
    param($Watch, [string]$Spoken)
    $wall = $Watch.Clock.Elapsed.TotalSeconds
    $quiet = $wall - $Watch.LastProgress
    $free = Get-FreePercent $Watch
    $adjusted = [math]::Round($Watch.Adjusted)
    $sampled = -not $Watch.SamplerFailed
    if ($sampled -and $quiet -ge $Watch.Stall) {
        return "gate: STALLED: no output and no CPU for $([math]::Round($quiet)) s (machine free $free% on average); " +
            "killed $Spoken and its children"
    }
    if ($sampled -and $Watch.Adjusted -ge $Watch.Timeout) {
        return "gate: TIMED OUT after $($Watch.Timeout) s of load-adjusted time (wall $([math]::Round($wall)) s, " +
            "machine free $free% on average); killed $Spoken and its children"
    }
    if ($wall -ge 5 * $Watch.Timeout) {
        $load = if ($sampled) { "load-adjusted $adjusted s, machine free $free% on average" } else { 'machine load unknown: the sampler failed' }
        return "gate: BACKSTOP: $([math]::Round($wall)) s of wall time (5 x $($Watch.Timeout) s ceiling, $load); " +
            "killed $Spoken and its children"
    }
    return $null
}

# Terminates every process in the command's job, the command's own among them, and waits for the command to be gone:
# the kill is asynchronous, so the redirected files are written for a moment after it.
function Stop-Command {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Kills the job of the command this gate started; there is no state of the caller''s to confirm.')]
    param($Watch)
    $count = $script:Native::JobAccounting($Watch.Job)[1]
    $script:Native::TerminateJob($Watch.Job, 124)
    $Watch.Notes.Add("gate: terminated the job's $count processes")
    if (-not $Watch.Process.WaitForExit(5000)) {
        $Watch.Notes.Add('gate: the command was still running 5 s after its job was terminated')
    }
}

# Waits for the command, sampling it; kills its job on the first kill reason and returns that line, or returns $null
# once it has exited on its own.
function Watch-Command {
    param($Watch, [string]$Spoken)
    while (-not $Watch.Process.WaitForExit($Watch.SampleMs)) {
        Step-Sampler $Watch
        $kill = Get-KillLine -Watch $Watch -Spoken $Spoken
        if (-not $kill) { continue }
        # A command that ended on its own since the wait above keeps its own status.
        if ($Watch.Process.HasExited) { break }
        Stop-Command $Watch
        return $kill
    }
    # The stretch since the last sample is counted at the share the last sample found.
    $now = $Watch.Clock.Elapsed.TotalSeconds
    $Watch.Adjusted += ($now - $Watch.LastAt) * $Watch.LastFree
    $Watch.LastAt = $now
    return $null
}

# Two files while the process runs, so the output reads first and the errors after it; one file to read afterwards,
# with the gate's own lines at its end.
function Complete-Log {
    param([string]$Log, [string[]]$Notes)
    $errLog = "$Log.err"
    if (Test-Path $errLog) {
        $errors = Get-Content -Path $errLog -Raw
        if ($errors) { Add-Content -Path $Log -Value $errors }
        Remove-Item $errLog -ErrorAction SilentlyContinue
    }
    foreach ($note in $Notes) { Add-Content -Path $Log -Value $note }
}

# The failure markers, the tail and the verdict; returns the gate's exit status.
function Write-Verdict {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
        Justification = 'The tail and the verdict are for the console; the gate''s output is the log, not the pipeline.')]
    param([hashtable]$Options, [int]$Status, [bool]$Killed, [string]$Passed)
    $log = $Options['Log']
    $scan = -not $Killed -and -not $Options['NoMarkers']
    if ($scan -and $Status -eq 0 -and (Select-String -Path $log -Pattern $markers -Quiet)) {
        Write-Gate "gate: command exited 0 but its log reports a failure -> $log"
        $Status = 1
    }
    if ($scan -and $Status -ne 0) {
        Select-String -Path $log -Pattern $markers |
            Select-Object -First 40 |
            ForEach-Object { Write-Host "$($_.LineNumber):$($_.Line)" }
    }
    Get-Content -Path $log -Tail ([int]$Options['Tail']) | ForEach-Object { Write-Host $_ }
    if ($Status -eq 0) {
        Write-Host "$Passed Full output: $log"
    }
    else {
        Write-Gate "gate: FAILED (status $Status). Full output: $log"
    }
    return $Status
}

# After a failure in the gate itself: the job and the command are killed, and the error goes to the log, after the
# lines gathered so far, before the caller sees it. A kill or a log line that fails here must not hide the error that
# brought the gate here.
function Stop-AfterFailure {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Kills the command this gate started after the gate failed; there is nothing to confirm.')]
    param($Process, [IntPtr]$Job, [string]$Log, [System.Management.Automation.ErrorRecord]$Failure, [string[]]$Notes)
    $lines = @($Notes) + @("gate: the gate failed while running the command: $($Failure.Exception.Message)")
    try {
        $script:Native::TerminateJob($Job, 124)
        if (-not $Process.WaitForExit(5000)) { $lines += 'gate: the command was still running 5 s after its job was terminated' }
    }
    catch {
        $lines += "gate: and could not terminate the command's job: $($_.Exception.Message)"
    }
    try {
        Complete-Log -Log $Log -Notes $lines
    }
    catch {
        Write-Gate "gate: could not write to $Log after the failure: $($_.Exception.Message)"
    }
    foreach ($line in $lines) { Write-Gate $line }
}

# Watches the command already in its job to its end or its kill; returns the gate's exit status.
function Complete-Watched {
    param($Process, [IntPtr]$Job, [hashtable]$Options, [long]$Since, [System.Collections.Generic.List[string]]$Notes)
    $watch = New-Watch -Process $Process -Job $Job -Options $Options -Since $Since -Notes $Notes
    $kill = Watch-Command -Watch $watch -Spoken ($Options['Spoken'])
    $notes = @($watch.Notes)
    if ($kill) {
        Write-Gate $kill
        $notes += $kill
    }
    Complete-Log -Log $Options['Log'] -Notes $notes
    $status = if ($kill) { 124 } else { $Process.ExitCode }
    $wall = [math]::Round($watch.Clock.Elapsed.TotalSeconds)
    $passed = "gate: passed in $wall s (load-adjusted $([math]::Round($watch.Adjusted)) s, ceiling $($watch.Timeout) s)."
    return Write-Verdict -Options $Options -Status $status -Killed ([bool]$kill) -Passed $passed
}

# Runs the command in a job of its own under the watchdog once a slot is held; returns the gate's exit status. Every
# handle the job holds is released on the way out, whatever happened, and a gate stopped before it finished (Ctrl+C,
# Stop-Job on a job running it in its own session) terminates the job first, so the command does not outlive it.
function Invoke-Watched {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingEmptyCatchBlock', '',
        Justification = 'The terminate on a stop runs while the stop is under way, with nowhere left to report to.')]
    param([object[]]$Command, [hashtable]$Options, [string[]]$Notes)
    $log = $Options['Log']
    $Options['Spoken'] = $Command -join ' '
    $gathered = [System.Collections.Generic.List[string]]::new()
    foreach ($note in $Notes) { $gathered.Add($note) }
    $completed = $false
    $process = $null
    $job = $script:Native::CreateJob("Local\gate-job-$PID")
    try {
        $since = [DateTime]::UtcNow.ToFileTimeUtc()
        $process = Start-Command -Command $Command -Job $job -Log $log -ErrLog "$log.err"
        try {
            $status = Complete-Watched -Process $process -Job $job -Options $Options -Since $since -Notes $gathered
            $completed = $true
            return $status
        }
        catch {
            Stop-AfterFailure -Process $process -Job $job -Log $log -Failure $_ -Notes $gathered
            throw
        }
    }
    finally {
        if (-not $completed) {
            # A stop is already in progress and there is nowhere to report a failed terminate to.
            try { $script:Native::TerminateJob($job, 124) } catch { }
        }
        if ($process) { $process.Dispose() }
        $script:Native::Release($job)
    }
}

function Write-Usage {
    foreach ($line in $usage) { Write-Gate $line }
}

# -StopTree <pid>, the whole of the words: stops the gates under the process and then its tree; returns the exit status.
function Invoke-StopTree {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '',
        Justification = 'Stops the tree its caller named, which is what the caller asked for; there is nothing to confirm.')]
    param([object[]]$Words)
    $value = if ($Words.Count -ge 2) { [string]$Words[1] } else { '' }
    $problem = if ($Words.Count -ne 2) { 'gate: -StopTree takes one process id and nothing else' }
    elseif (-not (Test-WholeNumber $value)) { "gate: -StopTree needs a process id, got '$value'" }
    if (-not $problem) {
        $script:Native = Get-NativeType
        $result = $script:Native::StopTree([int]$value, $PID)
        if ($null -eq $result) { $problem = "gate: -StopTree: no live process has the id $value" }
    }
    if ($problem) {
        Write-Gate $problem
        Write-Usage
        return 2
    }
    foreach ($failure in $result.Failures) { Write-Gate "gate: could not stop: $failure" }
    [Console]::Out.WriteLine("gate: stopped $($result.Jobs) gate job(s) and $($result.Processes) process(es) under $value")
    if ($result.Failures.Count -gt 0) { return 1 }
    return 0
}

function Invoke-Main {
    param([object[]]$Words)
    if ($Words.Count -gt 0 -and [string]$Words[0] -eq '-StopTree') { return Invoke-StopTree $Words }
    $parsed = Read-Argument $Words
    $problems = if ($parsed) { Get-InputProblem -Options $parsed.Options -Command $parsed.Command } else { @() }
    if (-not $parsed -or $problems.Count -gt 0) {
        foreach ($problem in $problems) { Write-Gate $problem }
        Write-Usage
        Write-Gate $requiredLine
        return 2
    }
    $options = $parsed.Options
    $options['Slot'] = $options['Slot'].ToLowerInvariant()
    # Read against the caller's location once, before anything uses it: a caller in its own session that moved with
    # Set-Location has a location that .NET's own current directory, which a FileInfo reads from, does not follow.
    $options['Log'] = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($options['Log'])
    $log = $options['Log']
    $logDir = Split-Path -Parent $log
    if ($logDir -and -not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Force $logDir | Out-Null
    }
    Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
    $script:Native = Get-NativeType

    $notes = @()
    $slot = $null
    if ($env:GATE_SLOT_HELD -ne '1') {
        $slot = Enter-Slot -Kind $options['Slot']
        $notes = @($slot.Notes)
    }
    try {
        return Invoke-Watched -Command $parsed.Command -Options $options -Notes $notes
    }
    finally {
        Exit-Slot $slot
    }
}

exit (Invoke-Main -Words $args)
