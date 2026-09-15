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
$appUserModelId = 'org.arielraskin.gerafe'
$previousCargoTargetDirectory = $env:CARGO_TARGET_DIR

if (-not ('GeRAFE.WindowsIntegration.ShortcutIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace GeRAFE.WindowsIntegration
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    internal struct PropertyKey
    {
        internal Guid FormatId;
        internal uint PropertyId;

        internal PropertyKey(Guid formatId, uint propertyId)
        {
            FormatId = formatId;
            PropertyId = propertyId;
        }
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PropVariant
    {
        [FieldOffset(0)]
        internal ushort VariantType;

        [FieldOffset(8)]
        internal IntPtr PointerValue;

        [FieldOffset(8)]
        internal ulong Size;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        void GetCount(out uint propertyCount);
        void GetAt(uint propertyIndex, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    [ClassInterface(ClassInterfaceType.None)]
    internal class ShellLink
    {
    }

    public static class ShortcutIdentity
    {
        private const ushort VariantWideString = 31;
        private static readonly PropertyKey AppUserModelIdKey = new PropertyKey(
            new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            5);

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern void SHChangeNotify(
            uint eventId,
            uint flags,
            string item1,
            IntPtr item2);

        public static void SetAppUserModelId(string shortcutPath, string appUserModelId)
        {
            object shellLink = new ShellLink();
            try
            {
                IPersistFile persistFile = (IPersistFile)shellLink;
                const int readWrite = 2;
                persistFile.Load(shortcutPath, readWrite);

                IPropertyStore propertyStore = (IPropertyStore)shellLink;
                PropertyKey key = AppUserModelIdKey;
                PropVariant value = new PropVariant
                {
                    VariantType = VariantWideString,
                    PointerValue = Marshal.StringToCoTaskMemUni(appUserModelId)
                };
                try
                {
                    propertyStore.SetValue(ref key, ref value);
                    propertyStore.Commit();
                    persistFile.Save(shortcutPath, true);
                }
                finally
                {
                    PropVariantClear(ref value);
                }
            }
            finally
            {
                Marshal.FinalReleaseComObject(shellLink);
            }

            const uint updateItem = 0x00002000;
            const uint pathWide = 0x0005;
            SHChangeNotify(updateItem, pathWide, shortcutPath, IntPtr.Zero);
        }

        public static void RefreshShellIconCache()
        {
            const uint associationChanged = 0x08000000;
            const uint flush = 0x1000;
            SHChangeNotify(associationChanged, flush, null, IntPtr.Zero);
        }

    }
}
'@
}

try {
  $env:CARGO_TARGET_DIR = $buildRoot
  Push-Location -LiteralPath $repositoryRoot
  try {
    & cargo.exe clean --manifest-path 'src-tauri\Cargo.toml' --package gerafe --release
    if ($LASTEXITCODE -ne 0) {
      throw "Could not refresh GeRAFE's native release resources (cargo exit code $LASTEXITCODE)."
    }
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

[GeRAFE.WindowsIntegration.ShortcutIdentity]::SetAppUserModelId($shortcutPath, $appUserModelId)
$startMenuShell = New-Object -ComObject Shell.Application
$shortcutFolder = $null
$shortcutItem = $null
try {
  $shortcutFolder = $startMenuShell.Namespace((Split-Path -Parent $shortcutPath))
  $shortcutItem = $shortcutFolder.ParseName((Split-Path -Leaf $shortcutPath))
  $installedShortcutAppId = $shortcutItem.ExtendedProperty('System.AppUserModel.ID')
} finally {
  if ($null -ne $shortcutItem) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutItem)
  }
  if ($null -ne $shortcutFolder) {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutFolder)
  }
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($startMenuShell)
}
if ($installedShortcutAppId -ne $appUserModelId) {
  throw "The Start Menu shortcut has AppUserModelID '$installedShortcutAppId' instead of '$appUserModelId'."
}
[GeRAFE.WindowsIntegration.ShortcutIdentity]::RefreshShellIconCache()

Write-Host ''
Write-Host "Installed GeRAFE: $installedExecutable"
Write-Host "Start Menu shortcut: $shortcutPath"
Write-Host "Windows application identity: $installedShortcutAppId"
Write-Host 'Refreshed the Windows shell icon cache.'
Write-Host 'Open GeRAFE from Start, then right-click its taskbar icon and choose Pin to taskbar.'
