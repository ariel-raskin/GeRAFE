@echo off
setlocal
set "GERAFE_EXE=%~dp0src-tauri\target\release\gerafe.exe"

if not exist "%GERAFE_EXE%" (
  echo GeRAFE has not been built yet.
  echo Run npm run desktop:build from this folder, then try again.
  pause
  exit /b 1
)

start "" "%GERAFE_EXE%"
