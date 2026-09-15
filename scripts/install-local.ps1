[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'The GeRAFE local installer currently supports Windows only.'
}

$running = Get-Process -Name 'gerafe' -ErrorAction SilentlyContinue
if ($running) {
  throw 'Close GeRAFE before installing an updated build, then run this command again.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$startMenuPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
$buildRoot = Join-Path $localAppData 'GeRAFE\build-target'
$buildExecutable = Join-Path $buildRoot 'release\gerafe.exe'
$installDirectory = Join-Path $localAppData 'Programs\GeRAFE'
$installedExecutable = Join-Path $installDirectory 'gerafe.exe'
$shortcutPath = Join-Path $startMenuPrograms 'GeRAFE.lnk'
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR

try {
  $env:CARGO_TARGET_DIR = $buildRoot
  Push-Location -LiteralPath $repositoryRoot
  try {
    & npm.cmd run desktop:build
    if ($LASTEXITCODE -ne 0) {
      throw "The GeRAFE desktop build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
} finally {
  $env:CARGO_TARGET_DIR = $previousCargoTargetDirectory
}

if (-not (Test-Path -LiteralPath $buildExecutable -PathType Leaf)) {
  throw "The build completed without producing $buildExecutable."
}

New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Copy-Item -LiteralPath $buildExecutable -Destination $installedExecutable -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $null
try {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $installedExecutable
  $shortcut.WorkingDirectory = $installDirectory
  $shortcut.IconLocation = "$installedExecutable,0"
  $shortcut.Description = 'GeRAFE — Genomic Renderer and Figure Editor'
  $shortcut.WindowStyle = 1
  $shortcut.Save()
} finally {
  if ($null -ne $shortcut) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
  }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}

Write-Host ''
Write-Host "Installed GeRAFE: $installedExecutable"
Write-Host "Start Menu shortcut: $shortcutPath"
Write-Host 'Open GeRAFE from Start, then right-click its taskbar icon and choose Pin to taskbar.'
