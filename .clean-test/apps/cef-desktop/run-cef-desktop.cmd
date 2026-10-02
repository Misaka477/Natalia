@echo off
REM Natalia CEF desktop launcher — the Windows counterpart of run-cef-desktop.sh.
REM
REM Starts the runtime, the static web server for apps/web/dist, and the CEF
REM window that points at it. Everything it does is the same as the Linux
REM script's; only the mechanics differ:
REM   - `LD_LIBRARY_PATH=.` becomes PATH, and the binary carries .exe;
REM   - the ozone/wayland switch is dropped (Windows has its own compositor);
REM   - SIGTERM/wait/kill are replaced by taskkill /T /F, which kills the tree.

setlocal enabledelayedexpansion
cd /d "%~dp0..\.."

set RUNTIME_PORT=%NATALIA_RUNTIME_PORT%
if "%RUNTIME_PORT%"=="" set RUNTIME_PORT=8790
set WEB_PORT=%NATALIA_WEB_PORT%
if "%WEB_PORT%"=="" set WEB_PORT=5178

if "%NATALIA_FAST_EXECUTION_LOAD%"=="" set NATALIA_FAST_EXECUTION_LOAD=1
if "%NATALIA_BROWSER_BRIDGE_URL%"=="" set NATALIA_BROWSER_BRIDGE_URL=http://127.0.0.1:18765

REM bun is a global runtime (the house standard: plain `bun`, never npx).
where bun >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.bun\bin\bun.exe" set PATH=%USERPROFILE%\.bun\bin;%PATH%
)
where bun >nul 2>nul
if errorlevel 1 (
  echo [cef-desktop] bun not found - expected at %%USERPROFILE%%\.bun\bin\bun.exe ^(install from https://bun.sh^) >&2
  exit /b 1
)

echo [cef-desktop] starting runtime on 127.0.0.1:%RUNTIME_PORT%
start "natalia-runtime" /b bun apps\cli\src\main.ts serve %RUNTIME_PORT%
set RUNTIME_TITLE=natalia-runtime

echo [cef-desktop] starting web server on 127.0.0.1:%WEB_PORT%
start "natalia-web" /b bun apps\cef-desktop\serve-web.ts
set WEB_TITLE=natalia-web

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
  taskkill /FI "WINDOWTITLE eq %RUNTIME_TITLE%*" /T /F >nul 2>nul
  taskkill /FI "WINDOWTITLE eq %WEB_TITLE%*" /T /F >nul 2>nul
  exit /b 1
)

REM A custom user-data dir per platform keeps the CEF profile out of the repo.
if "%NATALIA_CEF_USER_DATA_DIR%"=="" set NATALIA_CEF_USER_DATA_DIR=%LOCALAPPDATA%\natalia-cef
set PATH=apps\cef-desktop\build\output;%PATH%
start "" apps\cef-desktop\build\output\natalia-cef-desktop.exe --url="http://127.0.0.1:%WEB_PORT%/" --user-data-dir="%NATALIA_CEF_USER_DATA_DIR%"

echo [cef-desktop] the CEF window is running; close it, then stop the servers with:
echo   taskkill /FI "WINDOWTITLE eq %RUNTIME_TITLE%*" /T /F
echo   taskkill /FI "WINDOWTITLE eq %WEB_TITLE%*" /T /F
endlocal
