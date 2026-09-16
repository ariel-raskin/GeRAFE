[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'GeRAFE desktop development currently supports Windows only.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$buildRoot = Join-Path $localAppData 'GeRAFE\dev-target'
$tauriCommand = Join-Path $repositoryRoot 'node_modules\.bin\tauri.cmd'
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR

if (-not (Test-Path -LiteralPath $tauriCommand -PathType Leaf)) {
  throw 'Tauri is not installed. Run npm install from the GeRAFE repository first.'
}

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null

try {
  $env:CARGO_TARGET_DIR = $buildRoot
  Push-Location $repositoryRoot
  try {
    & $tauriCommand dev
    if ($LASTEXITCODE -ne 0) {
      throw "Tauri development process exited with code $LASTEXITCODE."
    }
  }
  finally {
    Pop-Location
  }
}
finally {
  if ($null -eq $previousCargoTargetDirectory) {
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
  }
  else {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDirectory
  }
}
