# Natalia CEF desktop launcher (Windows) - the PowerShell counterpart of
# run-cef-desktop.sh. Same shape as the Linux script, same order, same exits:
#   - the servers start first and the CEF window runs in the FOREGROUND;
#   - `finally` is the trap: it runs on the window closing, on Ctrl+C, and on
#     any error, and it stops the children before the job closes the rest -
#     which is the whole reason this is a .ps1 and not a .cmd (a .cmd cannot
#     trap anything: Ctrl+C only prompts "terminate batch job?" and the kids
#     survive).

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$outputDir = Join-Path $repoRoot "apps\cef-desktop\build\output"
$runtimePort = if ($env:NATALIA_RUNTIME_PORT) { $env:NATALIA_RUNTIME_PORT } else { 8790 }
$webPort = if ($env:NATALIA_WEB_PORT) { $env:NATALIA_WEB_PORT } else { 5178 }

Set-Location $repoRoot

# bun is a global runtime (the house standard: plain `bun`, never npx). The
# same fallback the .sh performs, for a PATH that lacks it.
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $bunDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME ".bun" }
  $env:Path = "$bunDir\bin;$env:Path"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "[cef-desktop] bun not found - expected at $HOME\.bun\bin\bun (install from https://bun.sh)"
  exit 1
}

if (-not $env:NATALIA_FAST_EXECUTION_LOAD) { $env:NATALIA_FAST_EXECUTION_LOAD = "1" }
if (-not $env:NATALIA_BROWSER_BRIDGE_URL) { $env:NATALIA_BROWSER_BRIDGE_URL = "http://127.0.0.1:18765" }
# The .sh pins BOTH config paths into the repo's .natalia; without them the
# workspace registry lands in the user profile, which is not where the repo
# was tested.
if (-not $env:NATALIA_CONFIG) { $env:NATALIA_CONFIG = Join-Path $repoRoot ".natalia\global-config.json" }
if (-not $env:NATALIA_WORKSPACES_FILE) { $env:NATALIA_WORKSPACES_FILE = Join-Path $repoRoot ".natalia\workspaces.json" }

# ---------------------------------------------------------------------------
# The parent-child contract the shell script gets for free (one bash, one
# SIGTERM, one `wait`) has to be built by hand on Windows, because a process
# tree is not a process group: the CEF browser spawns detached renderers and
# the terminal host spawns wezterm / mux-server children, and closing the
# launcher used to leave all of them holding ports and hundreds of megabytes.
# This launcher owns a Job Object; every child it starts is assigned to it;
# closing the job (the launcher exiting for ANY reason - window close,
# Ctrl+C, error, even a hard kill of this process) closes the whole tree.
# The finally still stops the children politely first - the job is the
# guarantee, not the policy.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NataliaJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

  private const uint PROCESS_SET_QUOTA = 0x0100;
  private const uint PROCESS_TERMINATE = 0x0001;
  private const int JobObjectExtendedLimitInformation = 9;
  private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Explicit)]
  private struct BasicLimitInformation {
    [FieldOffset(0)] public long PerProcessUserTimeLimit;
    [FieldOffset(8)] public long PerJobUserTimeLimit;
    [FieldOffset(16)] public uint LimitFlags;
    [FieldOffset(24)] public ulong MinimumWorkingSetSize;
    [FieldOffset(32)] public ulong MaximumWorkingSetSize;
    [FieldOffset(40)] public uint ActiveProcessLimit;
    [FieldOffset(44)] public long Affinity;
    [FieldOffset(52)] public uint PriorityClass;
    [FieldOffset(56)] public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimitInformation {
    public BasicLimitInformation Basic;
    public IO_COUNTERS Io;
  }

  public static IntPtr Create() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return IntPtr.Zero;
    var info = new ExtendedLimitInformation();
    info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int size = Marshal.SizeOf(info);
    IntPtr mem = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, mem, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, mem, (uint)size)) {
        CloseHandle(job);
        return IntPtr.Zero;
      }
    } finally {
      Marshal.FreeHGlobal(mem);
    }
    return job;
  }

  public static void Add(IntPtr job, int pid) {
    if (job == IntPtr.Zero) return;
    IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, (uint)pid);
    if (h != IntPtr.Zero) {
      AssignProcessToJobObject(job, h);
      CloseHandle(h);
    }
  }

  public static void Close(IntPtr job) {
    if (job != IntPtr.Zero) CloseHandle(job);
  }
}
'@

$job = $null
try {
  # Created inside a try so the finally owns it. A shell that already runs
  # inside a job (VS Code's terminal, a CI agent) can refuse the assignment;
  # that is fine, the finally's explicit stop is the fallback.
  $job = [NataliaJob]::Create()
} catch {
  $job = $null
}

$runtime = $null
$web = $null
try {
  Write-Output "[cef-desktop] starting runtime on 127.0.0.1:$runtimePort"
  $runtime = Start-Process -FilePath "bun" -ArgumentList "apps\cli\src\main.ts","serve","$runtimePort" -PassThru

  Write-Output "[cef-desktop] starting web server on 127.0.0.1:$webPort"
  $web = Start-Process -FilePath "bun" -ArgumentList "apps\cef-desktop\serve-web.ts" -PassThru

  [NataliaJob]::Add($job, $runtime.Id)
  [NataliaJob]::Add($job, $web.Id)

  # Wait for both servers the way the Linux script does.
  $ready = $false
  for ($attempt = 0; $attempt -lt 50 -and -not $ready; $attempt++) {
    Start-Sleep -Milliseconds 200
    try {
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$runtimePort/healthz" -TimeoutSec 2 -UseBasicParsing
      $null = Invoke-WebRequest -Uri "http://127.0.0.1:$webPort/" -TimeoutSec 2 -UseBasicParsing
      $ready = $true
    } catch { }
  }
  if (-not $ready) {
    Write-Error "[cef-desktop] the servers did not become ready; check the runtime output above"
    exit 1
  }

  $exe = Join-Path $outputDir "natalia-cef-desktop.exe"
  if (-not (Test-Path $exe)) {
    Write-Error "[cef-desktop] the CEF binary is not built: run scripts\build-cef-windows.ps1"
    exit 1
  }

  if (-not $env:NATALIA_CEF_USER_DATA_DIR) {
    $env:NATALIA_CEF_USER_DATA_DIR = Join-Path $env:LOCALAPPDATA "natalia-cef"
  }
  # Elevated shells cannot spawn CEF's sandboxed GPU/renderer children (the
  # restricted-token creation is refused, the GPU process dies at init and the
  # window opens and closes instantly). The switch is Chromium's sanctioned
  # escape, added exactly when this shell is elevated.
  $cefExtra = @()
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $cefExtra += "--no-sandbox"
  }

  Write-Output "[cef-desktop] starting CEF window"
  # The stdio goes to files (not the console, not a pipe): the CEF GPU
  # subprocess inherits these handles, and a pipe/ConPTY handle there kills
  # that process at init with -2147483645 - the window opening and closing
  # instantly. Start-Process forbids the same path for both streams, so the
  # two log files double as the crash witness.
  $logDir = $env:NATALIA_CEF_USER_DATA_DIR
  if (-not (Test-Path $logDir)) { $null = New-Item -ItemType Directory -Path $logDir -Force }
  $windowOut = Join-Path $logDir "window-stdout.log"
  $windowErr = Join-Path $logDir "window-stderr.log"
  $exeArgs = @(
    "--url", "http://127.0.0.1:$webPort/",
    "--user-data-dir", $env:NATALIA_CEF_USER_DATA_DIR
  ) + $cefExtra
  Push-Location $outputDir
  try {
    $window = Start-Process -FilePath $exe -ArgumentList $exeArgs -PassThru -RedirectStandardOutput $windowOut -RedirectStandardError $windowErr
    # The window joins the job too: its renderers/GPU/utility subprocesses are
    # detached children of the BROWSER process, so closing the browser alone
    # leaves them behind - the job closes the whole tree instead.
    [NataliaJob]::Add($job, $window.Id)
    # A POLLING wait, deliberately: a blocking $window.WaitForExit() is a .NET
    # call that Ctrl+C cannot interrupt, so the finally below would never run
    # and the servers would outlive the terminal. A bounded wait inside a loop
    # lets PowerShell stop between polls - Ctrl+C then reaches the finally,
    # which is the .sh's trap-equivalent.
    while (-not $window.WaitForExit(500)) { }
  } finally {
    Pop-Location
  }
  Write-Output "[cef-desktop] the CEF window closed; stopping the servers"
}
finally {
  # Stop politely first: the runtime journals append-only and the SQLite store
  # is crash-safe, so a hard stop is survivable - but the terminal's wezterm
  # panes and the object-store daemon flush real state, so give them a beat.
  foreach ($proc in @($runtime, $web)) {
    if ($proc -and -not $proc.HasExited) {
      & taskkill /PID $proc.Id /T 2>$null | Out-Null
    }
  }
  Start-Sleep -Seconds 2
  foreach ($proc in @($runtime, $web)) {
    if ($proc -and -not $proc.HasExited) {
      & taskkill /PID $proc.Id /T /F 2>$null | Out-Null
    }
  }
  # Whatever outlived the explicit stop (CEF's detached renderers, a wedged
  # wezterm child) dies with the job. Closing the job is the guarantee for the
  # exits the finally CANNOT see - a hard kill of this launcher, a crashed
  # shell, a closed terminal window - because the OS tears the job down when
  # the last handle to it (this process) closes.
  [NataliaJob]::Close($job)
  # The job closes on its last handle; a child that detached in the instant
  # before the OS tore the job down (CEF GPU process, a late wezterm spawn)
  # can outlive it by a hair. The image-name sweep is the backstop: this is
  # the launcher's own desktop instance and the script exits right after, so
  # there is nothing else to collide with.
  & taskkill /IM natalia-cef-desktop.exe /F 2>$null | Out-Null
  & taskkill /IM wezterm.exe /F 2>$null | Out-Null
  & taskkill /IM wezterm-gui.exe /F 2>$null | Out-Null
  & taskkill /IM wezterm-mux-server.exe /F 2>$null | Out-Null
}
