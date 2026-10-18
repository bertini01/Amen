<#
.SYNOPSIS
  Packages Amen as an MSIX for the Microsoft Store.

.DESCRIPTION
  Builds the release exe (unless -SkipBuild), lays it out with the manifest and
  icons, indexes resources, and packs src-tauri\target\msix\Amen_<ver>_x64.msix.

  The package is left UNSIGNED on purpose: the Store signs MSIX packages itself.

  -Dev     uses a throwaway local identity so the package can be built before the
           Partner Center product exists.
  -Register installs the unpacked layout for this user (needs Windows Developer
           Mode) so the packaged app can be tested exactly as the Store runs it.

.EXAMPLE
  .\scripts\package-msix.ps1                  # Store build, identity from store-identity.json
  .\scripts\package-msix.ps1 -Dev -Register   # local test install
#>
param(
    [switch]$SkipBuild,
    [switch]$Dev,
    [switch]$Register
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$msixDir = Join-Path $root "packaging\msix"
$outDir = Join-Path $root "src-tauri\target\msix"
$layout = Join-Path $outDir "layout"
$icons = Join-Path $root "src-tauri\icons"
$exe = Join-Path $root "src-tauri\target\release\amen.exe"

# --- Windows SDK tools -------------------------------------------------------
$sdkBin = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*" -Directory |
    Sort-Object { [version]$_.Name } -Descending |
    Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
    Select-Object -First 1
if (-not $sdkBin) { throw "Windows 10/11 SDK not found (need makeappx.exe and makepri.exe)." }
$makeappx = Join-Path $sdkBin.FullName "x64\makeappx.exe"
$makepri = Join-Path $sdkBin.FullName "x64\makepri.exe"

# --- Version: MSIX wants four parts and the Store reserves the last one -----
$appVersion = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$parts = $appVersion.Split("-")[0].Split(".")
if ($parts.Count -ne 3) { throw "Expected a three-part version in tauri.conf.json, got '$appVersion'." }
$version = "$($parts -join '.').0"

# --- Identity -----------------------------------------------------------------
if ($Dev) {
    $identity = @{ DisplayName = "Amen (dev)"; IdentityName = "Amen.Dev"; Publisher = "CN=AmenDev"; PublisherDisplayName = "Amen (dev)" }
} else {
    $identity = Get-Content (Join-Path $msixDir "store-identity.json") -Raw | ConvertFrom-Json
    foreach ($key in "DisplayName", "IdentityName", "Publisher", "PublisherDisplayName") {
        if ($identity.$key -like "REPLACE_ME*") {
            throw "Fill in '$key' in packaging\msix\store-identity.json from Partner Center (or pass -Dev for a local build)."
        }
    }
}

# --- Build --------------------------------------------------------------------
if (-not $SkipBuild) {
    Push-Location $root
    try {
        npx tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }
    } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "Missing $exe. Build first or drop -SkipBuild." }

# --- Layout -------------------------------------------------------------------
if ($Register) {
    # Re-registering over a layout that is still installed fails, so remove it first.
    Get-AppxPackage -Name $identity.IdentityName | Remove-AppxPackage
}
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
$assets = Join-Path $layout "Assets"
New-Item -ItemType Directory -Force $assets | Out-Null

Copy-Item $exe $layout
foreach ($name in "StoreLogo", "Square44x44Logo", "Square150x150Logo") {
    Copy-Item (Join-Path $icons "$name.png") $assets
}

# Unplated taskbar / Start-list icons. Without these Windows draws the icon
# small on a coloured plate.
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile((Join-Path $icons "icon.png"))
try {
    foreach ($size in 16, 24, 32, 48, 256) {
        $bitmap = New-Object System.Drawing.Bitmap $size, $size
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($source, 0, 0, $size, $size)
        $graphics.Dispose()
        $bitmap.Save((Join-Path $assets "Square44x44Logo.targetsize-${size}_altform-unplated.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        $bitmap.Dispose()
    }
} finally { $source.Dispose() }

$manifest = Get-Content (Join-Path $msixDir "AppxManifest.xml") -Raw
$manifest = $manifest.Replace("{{DisplayName}}", [System.Security.SecurityElement]::Escape($identity.DisplayName)).
    Replace("{{IdentityName}}", $identity.IdentityName).
    Replace("{{Publisher}}", [System.Security.SecurityElement]::Escape($identity.Publisher)).
    Replace("{{PublisherDisplayName}}", [System.Security.SecurityElement]::Escape($identity.PublisherDisplayName)).
    Replace("{{Version}}", $version)
Set-Content (Join-Path $layout "AppxManifest.xml") $manifest -Encoding utf8

# --- Resource index (lets Windows pick the qualified icon files) ---------------
$priConfig = Join-Path $outDir "priconfig.xml"
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o | Out-Null
& $makepri new /pr $layout /cf $priConfig /of (Join-Path $layout "resources.pri") /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makepri failed." }

# --- Pack ----------------------------------------------------------------------
$suffix = if ($Dev) { "_dev" } else { "" }
$package = Join-Path $outDir "Amen_${version}_x64$suffix.msix"
& $makeappx pack /d $layout /p $package /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed." }
Write-Host "Packed $package (version $version, identity $($identity.IdentityName))"

if ($Register) {
    Add-AppxPackage -Register (Join-Path $layout "AppxManifest.xml")
    Write-Host "Registered for this user. Launch 'Amen' from Start."
}
