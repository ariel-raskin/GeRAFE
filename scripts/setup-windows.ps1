[CmdletBinding()]
param(
  [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RequiredCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [string]$InstallMessage
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "$Name was not found. $InstallMessage"
  }
  return $command
}

if ($env:OS -ne 'Windows_NT') {
  throw 'GeRAFE desktop setup currently supports Windows only.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-RequiredCommand `
  -Name 'node.exe' `
  -InstallMessage 'Install Node.js 22 LTS or newer from https://nodejs.org/ and reopen this setup.'
$npmCommand = Get-RequiredCommand `
  -Name 'npm.cmd' `
  -InstallMessage 'Install Node.js 22 LTS or newer from https://nodejs.org/ and reopen this setup.'
$rustupCommand = Get-RequiredCommand `
  -Name 'rustup.exe' `
  -InstallMessage 'Install Rust with rustup from https://rustup.rs/ and reopen this setup.'
$cargoCommand = Get-RequiredCommand `
  -Name 'cargo.exe' `
  -InstallMessage 'Install Rust with rustup from https://rustup.rs/ and reopen this setup.'

$nodeVersionText = (& $nodeCommand.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.') {
  throw "Could not determine the installed Node.js version from '$nodeVersionText'."
}
$nodeMajorVersion = [int]$Matches.major
$nodeMinorVersion = [int]$Matches.minor
if ($nodeMajorVersion -lt 22 -or ($nodeMajorVersion -eq 22 -and $nodeMinorVersion -lt 12)) {
  throw "GeRAFE requires Node.js 22.12 or newer; this computer has $nodeVersionText. Install a current Node.js LTS release from https://nodejs.org/."
}

$vsWhereCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
)
$vsWhere = $vsWhereCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $vsWhere) {
  throw 'Microsoft C++ Build Tools were not found. Install Visual Studio Build Tools with Desktop development with C++ from https://visualstudio.microsoft.com/visual-cpp-build-tools/.'
}

$visualStudioPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($visualStudioPath)) {
  throw 'The Visual Studio C++ toolchain was not found. Modify Visual Studio Build Tools and enable Desktop development with C++ and a Windows SDK.'
}
$visualStudioPath = $visualStudioPath.Trim()

$rustupVersion = (& $rustupCommand.Source --version 2>&1 | Select-Object -First 1).ToString().Trim()
$cargoVersion = (& $cargoCommand.Source --version 2>&1 | Select-Object -First 1).ToString().Trim()

Write-Host 'GeRAFE Windows prerequisites found:'
Write-Host "  Node.js:       $nodeVersionText"
Write-Host "  npm:           $((& $npmCommand.Source --version).Trim())"
Write-Host "  rustup:        $rustupVersion"
Write-Host "  Cargo:         $cargoVersion"
Write-Host "  C++ toolchain: $visualStudioPath"
Write-Host "  Source:        $repositoryRoot"

if ($CheckOnly) {
  Write-Host ''
  Write-Host 'Prerequisite check passed. No dependencies were installed and no application was built.'
  return
}

$running = Get-Process -Name 'gerafe' -ErrorAction SilentlyContinue
if ($running) {
  throw 'Close GeRAFE before installing or updating it, then run this setup again.'
}

Push-Location -LiteralPath $repositoryRoot
try {
  Write-Host ''
  Write-Host 'Installing the exact JavaScript dependencies recorded by the project...'
  & $npmCommand.Source ci
  if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE."
  }

  Write-Host ''
  Write-Host 'Building and installing GeRAFE for this Windows account...'
  & $npmCommand.Source run desktop:install-local
  if ($LASTEXITCODE -ne 0) {
    throw "The GeRAFE local installation failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$installedExecutable = Join-Path $localAppData 'Programs\GeRAFE\gerafe.exe'
if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
  throw "Setup completed without finding the installed application at $installedExecutable."
}

Write-Host ''
Write-Host 'Setup complete.'
Write-Host "Installed application: $installedExecutable"
Write-Host 'Open GeRAFE from Start. The first time on this computer, right-click its running taskbar icon and choose Pin to taskbar.'
