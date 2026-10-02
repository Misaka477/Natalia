@echo off
REM Natalia CEF desktop launcher - the Windows counterpart of run-cef-desktop.sh.
REM
REM Starts the runtime, the static web server for apps/web/dist, and the CEF
REM window that points at it. Everything it does is the same as the Linux
REM script's; only the mechanics differ:
REM   - `LD_LIBRARY_PATH=.` becomes PATH, and the binary carries .exe;
REM   - the ozone/wayland switch is dropped (Windows has its own compositor);
REM   - SIGTERM/wait/kill are replaced by taskkill /T /F, which kills the tree;
REM   - the config/workspace-registry env the .sh exports (repo-local .natalia)
REM     is exported here too: without it the registry lands in the user profile,
REM     which is NOT where the Linux side keeps it, and the workspace the repo
REM     was tested with is not the one that runs.

setlocal enabledelayedexpansion
cd /d "%~dp0..\.."

set RUNTIME_PORT=%NATALIA_RUNTIME_PORT%
if "%RUNTIME_PORT%"=="" set RUNTIME_PORT=8790
set WEB_PORT=%NATALIA_WEB_PORT%
if "%WEB_PORT%"=="" set WEB_PORT=5178

if "%NATALIA_FAST_EXECUTION_LOAD%"=="" set NATALIA_FAST_EXECUTION_LOAD=1
if "%NATALIA_BROWSER_BRIDGE_URL%"=="" set NATALIA_BROWSER_BRIDGE_URL=http://127.0.0.1:18765
REM The Linux launcher pins BOTH config paths into the repo's .natalia; the
REM runtime otherwise resolves them under the user profile, and a fresh clone
REM starts with no workspace at all there.
if "%NATALIA_CONFIG%"=="" set "NATALIA_CONFIG=%CD%\.natalia\global-config.json"
if "%NATALIA_WORKSPACES_FILE%"=="" set "NATALIA_WORKSPACES_FILE=%CD%\.natalia\workspaces.json"

REM bun is a global runtime (the house standard: plain `bun`, never npx).
REM NOTE: no parenthesized block around the PATH patch below. cmd expands
REM %PATH% when it parses a block, and a PATH containing spaces or parens
REM ("C:\Program Files (x86)") breaks the block structure with a bare
REM "\Windows was unexpected at this time." - `||` keeps it all on one line.
where bun >nul 2>nul
where bun >nul 2>nul || if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
where bun >nul 2>nul
if errorlevel 1 (
  echo [cef-desktop] bun not found - expected at %%USERPROFILE%%\.bun\bin\bun.exe ^(install from https://bun.sh^) >&2
  exit /b 1
)

echo [cef-desktop] starting runtime on 127.0.0.1:%RUNTIME_PORT%
REM The .sh tracks PIDs (start/exec ^&, then $!) and stops them with SIGTERM,
REM waiting past the runtime's own shutdown watchdog before escalating. This
REM is the same shape: Start-Process -PassThru gives the real PID (a /b child
REM has no window title a WINDOWTITLE filter can match, which is why the old
REM title-based cleanup never matched anything and left the servers running).
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "Start-Process -FilePath 'bun' -ArgumentList 'apps\cli\src\main.ts','serve','%RUNTIME_PORT%' -PassThru | Select-Object -ExpandProperty Id"`) do set RUNTIME_PID=%%p
echo [cef-desktop] runtime pid %RUNTIME_PID%

echo [cef-desktop] starting web server on 127.0.0.1:%WEB_PORT%
for /f "usebackq tokens=*" %%p in (`powershell -NoProfile -Command "Start-Process -FilePath 'bun' -ArgumentList 'apps\cef-desktop\serve-web.ts' -PassThru | Select-Object -ExpandProperty Id"`) do set WEB_PID=%%p
echo [cef-desktop] web pid %WEB_PID%

REM Wait for both servers the way the Linux script does.
for /l %%i in (1,1,50) do (
  curl -fsS "http://127.0.0.1:%RUNTIME_PORT%/healthz" >nul 2>nul
  if not errorlevel 1 (
    curl -fsS "http://127.0.0.1:%WEB_PORT%/" >nul 2>nul
    if not errorlevel 1 goto ready
  )
  timeout /t 1 /nobreak >nul
)

:ready
echo [cef-desktop] starting CEF window
if not exist "apps\cef-desktop\build\output\natalia-cef-desktop.exe" (
  echo [cef-desktop] the CEF binary is not built: run scripts\build-cef-windows.ps1 >&2
  taskkill /PID %RUNTIME_PID% /T >nul 2>&1
  taskkill /PID %WEB_PID% /T >nul 2>&1
  exit /b 1
)

REM A custom user-data dir per platform keeps the CEF profile out of the repo.
if "%NATALIA_CEF_USER_DATA_DIR%"=="" set NATALIA_CEF_USER_DATA_DIR=%LOCALAPPDATA%\natalia-cef
REM Elevated terminals (a VS Code started as Administrator - the usual Windows
REM dev setup) cannot spawn CEF's sandboxed GPU/renderer children: the
REM restricted-token creation is refused, the GPU process dies with
REM -2147483645 and the window opens and closes instantly. The Chromium
REM --no-sandbox switch is the sanctioned escape for that case, and this
REM launcher adds it exactly when the shell is elevated (the same test
REM `net session` uses: it only succeeds with an administrator token).
set CEF_EXTRA=
net session >nul 2>nul
if not errorlevel 1 set CEF_EXTRA=--no-sandbox
REM The Linux script's `cd "$OUT_DIR"`: the CEF runtime resolves its resources
REM (libcef.dll's helpers, icudtl.dat, the .pak files, locales/) relative to
REM the WORKING DIRECTORY, not the exe's path. A PATH entry alone lets the
REM window's GPU process die and the browser time out — the window opens and
REM closes instantly. So the launcher cds into the output dir exactly like the
REM .sh does (LD_LIBRARY_PATH=. is the POSIX spelling of the same need).
pushd "apps\cef-desktop\build\output"

REM The window runs in the FOREGROUND (the .sh's model), so this script outlives
REM it and can clean up after it. `start` would detach it and leave the servers
REM orphaned - on Windows an orphaned server keeps its port and its
REM dist\ts\plugin-store handles for as long as the session lives, which is
REM what made `refresh:plugin-store` fail with EACCES while a runtime was up.
REM
REM The `1>NUL 2>NUL` is load-bearing, not cosmetics: the CEF GPU subprocess
REM inherits this process's stdio, and when that is a PIPE (or a ConPTY, which
REM is what an integrated terminal such as VS Code's gives a .cmd) the GPU
REM process dies at init with -2147483645, the browser times out, and the
REM window opens and closes instantly. NUL is a device every child can open.
REM The window's own log goes to its --log-file, so nothing is lost.
natalia-cef-desktop.exe --url="http://127.0.0.1:%WEB_PORT%/" --user-data-dir="%NATALIA_CEF_USER_DATA_DIR%" %CEF_EXTRA% %* 1>NUL 2>NUL

popd

echo [cef-desktop] the CEF window closed; stopping the servers
REM The .sh's shutdown: SIGTERM first (the runtime flushes journal/session/SQLite
REM state on a clean stop - a force-kill skips that flush and the next start
REM reads half-written state), wait past the runtime's own hard watchdog
REM (~20s), and only then escalate. Graceful taskkill is the same signal.
taskkill /PID %RUNTIME_PID% /T >nul 2>&1
taskkill /PID %WEB_PID% /T >nul 2>&1
timeout /t 20 /nobreak >nul
taskkill /PID %RUNTIME_PID% /T /F >nul 2>&1
taskkill /PID %WEB_PID% /T /F >nul 2>&1
endlocal
