@echo off
setlocal
REM The Start Menu entry runs THIS, not natalia-cef-desktop.exe alone.
REM That binary's only URL is the dev server at 127.0.0.1:5178, and nothing in
REM an install listens there, so a shortcut to it exits and the user sees a
REM program that will not open. This starts the runtime and the web server
REM first, then hands the host a URL that exists.
REM
REM If the native window host dies, the same URL opens in the default browser.
REM The window is what the user is owed; WHICH window is a preference, and a
REM crashed host must not take the app down with it. The reason is written to
REM the log either way, because a silent fallback hides a real defect.
REM
REM cmd.exe parsing notes, each of which cost a real failure:
REM   - no REM with parentheses anywhere near a for-block: parentheses close the
REM     block, and the rest of the line becomes commands
REM   - no subshell calls inside the wait loop: use ping for the delay
set "APP_DIR=%~dp0"
set "RUNTIME_PORT=8797"
set "WEB_PORT=8790"
set "LOG=%TEMP%\natalia-launcher.log"

REM The app creates its own config home on every launch, so a first run of a
REM fresh install has a directory and a schema-valid config before any read.

echo [natalia] starting runtime on port %RUNTIME_PORT% >> "%LOG%"
start "" /b "%APP_DIR%natalia.exe" serve --port %RUNTIME_PORT%
echo [natalia] starting web server on port %WEB_PORT% >> "%LOG%"
start "" /b "%APP_DIR%natalia.exe" serve-web --root "%APP_DIR%web" --port %WEB_PORT%

REM Wait for the web server before handing its URL to a window. A window that
REM loads before its listener exists shows a blank page and never retries.
for /l %%i in (1,1,40) do (
  curl -fsS "http://127.0.0.1:%WEB_PORT%/" >nul 2>&1 && goto :ready
  ping -n 1 -w 250 127.0.0.1 >nul 2>&1
)
echo [natalia] the web server did not come up on port %WEB_PORT% >> "%LOG%"
echo [natalia] see %TEMP%\natalia-web.log
pause
exit /b 1

:ready
echo [natalia] web server ready >> "%LOG%"
"%APP_DIR%natalia-cef-desktop.exe" --url="http://127.0.0.1:%WEB_PORT%/" --user-data-dir="%LOCALAPPDATA%\Natalia\cef-user-data"
set "HOST_CODE=%ERRORLEVEL%"
echo [natalia] window host exited with %HOST_CODE% >> "%LOG%"

if "%HOST_CODE%"=="0" goto :done
echo [natalia] window host failed with %HOST_CODE%, opening the app in the default browser >> "%LOG%"
start "" "http://127.0.0.1:%WEB_PORT%/"

:done
REM The window closed; the two background servers go with it.
taskkill /f /im natalia.exe >nul 2>&1
endlocal
