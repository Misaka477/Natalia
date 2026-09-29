#Requires -Version 5
<#
.SYNOPSIS
  Builds the Windows CEF desktop binary (self-compile on Windows).

.DESCRIPTION
  The Linux counterpart is `npm run desktop:cef:build` (a bash + cmake pair in
  apps/cef-desktop/package.json). This is the Windows half, and it is three
  steps that must happen in order:

    1. fetch the Windows CEF binary distribution (scripts/fetch-cef-windows.ts),
       because libcef is a per-platform Chromium build nobody commits;
    2. configure and build with CMake, using the generator this host has
       (Visual Studio, or Ninja with clang-cl);
    3. verify the POST_BUILD copy landed the runtime next to the .exe.

  The build's platform branches live in apps/cef-desktop/CMakeLists.txt (per
  platform: SDK root, artifact names, system libraries, entry-point source, and
  the shape of the runtime copy).

.PARAMETER Config
  Release or Debug. Release is the default.

.PARAMETER SkipFetch
  Use the CEF distribution already in .cef-windows/.

.EXAMPLE
  pwsh -NoProfile -File scripts\build-cef-windows.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet("Release", "Debug")]
  [string]$Config = "Release",
  [switch]$SkipFetch
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $root "apps\cef-desktop\build"

function Need($Command, $Hint) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Command not found: $Hint"
  }
}

# --- 1. the CEF SDK ---------------------------------------------------------
if (-not $SkipFetch) {
  Write-Host "[cef-windows] fetching the CEF distribution"
  & bun "$root\scripts\fetch-cef-windows.ts"
  if ($LASTEXITCODE -ne 0) { throw "the CEF fetch failed" }
}
$cefHeader = Join-Path $root ".cef-windows\include\cef_version.h"
if (-not (Test-Path $cefHeader)) {
  throw "no CEF SDK at .cef-windows\ - run scripts\fetch-cef-windows.ts first"
}

# --- 2. the build -----------------------------------------------------------
Need bun "install from https://bun.sh (the repo's standard runtime)"
Need cmake "install CMake 3.16+"
$generator = $null
if (Get-Command ninja -ErrorAction SilentlyContinue) {
  $generator = "Ninja"
} elseif (Get-Command msbuild -ErrorAction SilentlyContinue) {
  $generator = "Visual Studio 17 2022"
} else {
  throw "no generator: install Ninja, or msbuild (a Visual Studio/Build Tools install)"
}
Write-Host "[cef-windows] generator: $generator, config: $Config"

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null
Push-Location $buildDir
try {
  if ($generator -eq "Ninja") {
    # clang-cl is the default when Ninja is the generator: a plain MSVC
    # developer prompt is not required, and clang-cl links CEF's MSVC-format
    # .lib files directly.
    $clang = if (Get-Command clang-cl -ErrorAction SilentlyContinue) { "clang-cl" } else { $null }
    if (-not $clang) { throw "clang-cl not found (install LLVM for Windows)" }
    & cmake .. -G Ninja -DCMAKE_BUILD_TYPE=$Config -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl
  } else {
    & cmake .. -G $generator -A x64
  }
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
  & cmake --build . --config $Config --parallel
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
} finally {
  Pop-Location
}

# --- 3. the landing check ---------------------------------------------------
$exe = Join-Path $buildDir "output\natalia-cef-desktop.exe"
$libcef = Join-Path $buildDir "output\libcef.dll"
if (-not (Test-Path $exe)) { throw "the build produced no executable: $exe" }
if (-not (Test-Path $libcef)) { throw "the CEF runtime was not copied beside the executable: $libcef" }
Write-Host "[cef-windows] built $exe"
Write-Host "[cef-windows] run it with: apps\cef-desktop\run-cef-desktop.cmd"
