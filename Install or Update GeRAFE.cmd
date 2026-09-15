@echo off
setlocal
title Install or Update GeRAFE

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1"
set "GERAFE_SETUP_EXIT=%ERRORLEVEL%"

echo.
if not "%GERAFE_SETUP_EXIT%"=="0" (
  echo GeRAFE setup did not complete. Review the message above.
) else (
  echo GeRAFE is ready. Open it from Start or its pinned taskbar icon.
)
echo.
pause
exit /b %GERAFE_SETUP_EXIT%
