@echo off
setlocal
set "GERAFE_EXE=%LOCALAPPDATA%\Programs\GeRAFE\gerafe.exe"

if not exist "%GERAFE_EXE%" (
  echo GeRAFE has not been installed locally yet.
  echo Run npm run desktop:install-local from this folder, then try again.
  pause
  exit /b 1
)

start "" "%GERAFE_EXE%"
