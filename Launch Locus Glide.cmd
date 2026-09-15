@echo off
setlocal
set "LOCUS_GLIDE_EXE=%~dp0src-tauri\target\release\locus-glide.exe"

if not exist "%LOCUS_GLIDE_EXE%" (
  echo Locus Glide has not been built yet.
  echo Run npm run desktop:build from this folder, then try again.
  pause
  exit /b 1
)

start "" "%LOCUS_GLIDE_EXE%"
