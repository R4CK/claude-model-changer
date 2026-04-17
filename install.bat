@echo off
REM Claude Model Changer - installer (cmd.exe wrapper)
REM Delegates to install.ps1 with a sane execution policy.

setlocal
set "PLUGIN_DIR=%~dp0"
set "PS1=%PLUGIN_DIR%install.ps1"

if not exist "%PS1%" (
    echo [FAIL] install.ps1 not found next to install.bat
    exit /b 1
)

where powershell >nul 2>&1
if errorlevel 1 (
    echo [FAIL] powershell.exe not found on PATH. Cannot continue.
    echo        Please run install.ps1 manually from a PowerShell session.
    exit /b 1
)

echo === Claude Model Changer - Installer (via install.bat) ===
echo Delegating to PowerShell...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
    echo.
    echo [FAIL] Installer exited with code %RC%.
    exit /b %RC%
)

endlocal
exit /b 0
