# D2 (install study): the Windows face of the one-command install.
#
#   install.ps1 [-From <dir | https://…>] [-NataliaHome <dir>]
#
# The same guarantees as install.sh, in PowerShell's own idioms: every file
# verified against SHA256SUMS before the destination is touched, only
# versions/<version> and bin/ are written, the installed binary must answer
# --version or the install rolls back, and stores/ logs/ config.json belong
# to uninstall/purge — never to this script.
#
# Layout difference with intent: bin/natalia.exe is a COPY, not a symlink —
# creating symlinks on Windows needs privileges a clean machine may not
# grant an installer, and "works without asking for more" beats symmetry.

param(
  [string]$From = $(if ($env:NATALIA_INSTALL_BASE) { $env:NATALIA_INSTALL_BASE } else { "https://natalia.dev/releases" }),
  # NOT `-Home`: PowerShell's automatic $Home (the user's profile home) is
  # read-only, and a parameter of that name is a WriteError on every Windows
  # run — the CI's pwsh gate caught it; an installer that could never have run
  # had shipped with it.
  [string]$NataliaHome = $(if ($env:NATALIA_HOME) { $env:NATALIA_HOME } else { Join-Path $env:USERPROFILE ".natalia" })
)

$ErrorActionPreference = "Stop"

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("natalia-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage -Force | Out-Null

function Get-RemoteFile {
  param([string]$Relative, [string]$Destination)
  if (Test-Path -LiteralPath $From -PathType Container) {
    Copy-Item -LiteralPath (Join-Path $From $Relative) -Destination $Destination
  } else {
    $uri = "$($From.TrimEnd('/'))/$Relative"
    Invoke-WebRequest -Uri $uri -OutFile $Destination -UseBasicParsing
  }
}

try {
  # 1. Plain-text metadata first: VERSION + SHA256SUMS carry the version,
  #    the file list and the digests — no JSON parsing in an installer.
  Get-RemoteFile "VERSION" (Join-Path $stage "VERSION")
  $version = (Get-Content -LiteralPath (Join-Path $stage "VERSION") -Raw).Trim()
  if (-not $version) { throw "empty VERSION" }
  Get-RemoteFile "SHA256SUMS" (Join-Path $stage "SHA256SUMS")

  # 2. Fetch the listed files into staging.
  $filesRoot = Join-Path $stage "files"
  New-Item -ItemType Directory -Path $filesRoot -Force | Out-Null
  $entries = @()
  foreach ($line in (Get-Content -LiteralPath (Join-Path $stage "SHA256SUMS"))) {
    if ($line -match '^\s*([0-9a-fA-F]{64})\s+(.+?)\s*$') {
      $hash = $Matches[1]
      $file = $Matches[2]
      $entries += ,@($hash, $file)
      $dest = Join-Path $filesRoot $file
      New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force | Out-Null
      Get-RemoteFile $file $dest
    }
  }
  if ($entries.Count -eq 0) { throw "SHA256SUMS listed no files" }

  # 3. Verify BEFORE touching the destination.
  foreach ($entry in $entries) {
    $hash, $file = $entry
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $filesRoot $file)).Hash.ToLowerInvariant()
    if ($actual -ne $hash.ToLowerInvariant()) {
      Write-Error "checksum verification FAILED for $file — nothing was installed"
      exit 1
    }
  }

  # 4. Land it: only versions/<version> and bin/ are ours to write.
  $target = Join-Path (Join-Path $NataliaHome "versions") $version
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
  Copy-Item -Path (Join-Path $filesRoot "*") -Destination $target -Recurse -Force
  $binDir = Join-Path $NataliaHome "bin"
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $target "natalia.exe") -Destination (Join-Path $binDir "natalia.exe") -Force

  # 5. Immediately usable, or the install did not happen.
  $installed = & (Join-Path $binDir "natalia.exe") --version
  if ($LASTEXITCODE -ne 0 -or "$($installed)".Trim() -ne $version) {
    Write-Error "installed binary reports '$installed', expected '$version' — rolling back"
    Remove-Item -LiteralPath $target -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $binDir "natalia.exe") -Force
    exit 1
  }

  Write-Output "natalia $version installed at $(Join-Path $binDir 'natalia.exe')"
  if (Test-Path -LiteralPath (Join-Path $NataliaHome "stores")) {
    Write-Output "existing stores preserved untouched at $(Join-Path $NataliaHome 'stores')"
  }
  Write-Output "next: natalia doctor   # first run: platform report + provider guidance"
}
finally {
  if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  }
}
