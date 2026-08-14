# build-portaudio-asio.ps1
#
# Rebuilds naudiodon's bundled PortAudio DLL WITH real ASIO support and installs
# it into node_modules. Needed because:
#   - `npm install` alone only compiles the naudiodon.node JS binding; it links
#     against naudiodon's PREBUILT portaudio_x64.dll, which ships with
#     PA_USE_ASIO=0 hardcoded (MME/WASAPI/WDM-KS only, confirmed by inspecting
#     node_modules/naudiodon/portaudio/msvc/portaudio.vcxproj).
#   - Steinberg's ASIO SDK cannot be legally redistributed, so naudiodon can't
#     just ship an ASIO-enabled binary -- it has to be built locally against a
#     copy of the SDK you obtained yourself. See docs/DECISIONS.md.
#
# Run this any time `node_modules` is wiped/reinstalled (e.g. `npm ci`, or
# `rm -rf node_modules && npm install`) and live ASIO audio stops working --
# a plain `npm install` will silently put the non-ASIO DLL back.
#
# Prerequisites (one-time):
#   - VS Build Tools with the "Desktop development with C++" workload
#     (provides MSVC + a Windows SDK -- node-gyp needs this too).
#   - wing-brain/.audio-build/ASIO-SDK.zip -- the Steinberg ASIO SDK zip,
#     downloaded and license-accepted by a human at
#     https://www.steinberg.net/developers/asiosdk-open/ (or the proprietary
#     path at .../prorietary-sdk/). Not fetched automatically by this script
#     on purpose -- accepting that license is not something to automate.
#   - git and npm on PATH; run from anywhere, paths below are self-relative.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\build-portaudio-asio.ps1

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot   # wing-brain/
$BuildRoot  = Join-Path $RepoRoot '.audio-build'
$SdkZip     = Join-Path $BuildRoot 'ASIO-SDK.zip'
$SdkDir     = Join-Path $BuildRoot 'ASIOSDK2'
$PaDir      = Join-Path $BuildRoot 'portaudio'
$PaMsvcDir  = Join-Path $PaDir 'build\msvc'
$NaudiodonDir = Join-Path $RepoRoot 'node_modules\naudiodon'
$NaudiodonBin = Join-Path $NaudiodonDir 'portaudio\bin'

if (-not (Test-Path $NaudiodonDir)) {
  throw "node_modules\naudiodon not found -- run 'npm install' in wing-brain\ first."
}
if (-not (Test-Path $SdkZip)) {
  throw "Missing $SdkZip -- download the ASIO SDK yourself (see script header) and save it there."
}

# --- 1. Extract SDK, apply known bug patch (see PortAudio's ASIO-README.txt:
#        deleteDrvStruct() in asiolist.cpp uses `delete` on an array-new'd
#        pointer; must be `delete []` or it can crash on some SDK versions) ---
if (Test-Path $SdkDir) { Remove-Item -Recurse -Force $SdkDir }
$ExtractTmp = Join-Path $BuildRoot 'sdk-extract-tmp'
if (Test-Path $ExtractTmp) { Remove-Item -Recurse -Force $ExtractTmp }
Expand-Archive -Path $SdkZip -DestinationPath $ExtractTmp
$InnerDir = Get-ChildItem $ExtractTmp -Directory | Select-Object -First 1
Move-Item $InnerDir.FullName $SdkDir
Remove-Item -Recurse -Force $ExtractTmp

$AsioListPath = Join-Path $SdkDir 'host\pc\asiolist.cpp'
(Get-Content $AsioListPath) -replace '\bdelete lpdrv;', 'delete [] lpdrv;' | Set-Content $AsioListPath

# --- 2. Fresh shallow clone of PortAudio (naudiodon only ships bin+include,
#        not the src/ tree its own vcxproj expects) ---
# NB: git writes its normal progress ("Cloning into...") to stderr. With
# $ErrorActionPreference = 'Stop' that gets promoted into a terminating error
# even on success, so run it under 'Continue' and check $LASTEXITCODE instead.
if (Test-Path $PaDir) { Remove-Item -Recurse -Force $PaDir }
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
git clone --depth 1 https://github.com/PortAudio/portaudio.git $PaDir 2>&1 | Out-Null
$cloneExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($cloneExit -ne 0) { throw "git clone failed (exit $cloneExit)." }

New-Item -ItemType Directory -Force -Path $PaMsvcDir | Out-Null
Copy-Item (Join-Path $NaudiodonDir 'portaudio\msvc\build.bat') $PaMsvcDir
Copy-Item (Join-Path $NaudiodonDir 'portaudio\msvc\portaudio.vcxproj') $PaMsvcDir
Copy-Item (Join-Path $NaudiodonDir 'portaudio\msvc\portaudio.def') $PaMsvcDir

# --- 3. Patch naudiodon's vcxproj: retarget toolset to what's actually
#        installed, enable ASIO, wire in the SDK + a PortAudio source file
#        the vcxproj predates (pa_win_version.c, split out of pa_win_util.c
#        upstream after naudiodon's vcxproj was last updated) ---
$VcxPath = Join-Path $PaMsvcDir 'portaudio.vcxproj'
$vcx = Get-Content $VcxPath -Raw

$vcx = $vcx -replace '<PlatformToolset>v140</PlatformToolset>', '<PlatformToolset>v145</PlatformToolset>'
$vcx = $vcx -replace '<WindowsTargetPlatformVersion>8\.1</WindowsTargetPlatformVersion>', '<WindowsTargetPlatformVersion>10.0</WindowsTargetPlatformVersion>'
$vcx = $vcx -replace 'PA_USE_ASIO=0', 'PA_USE_ASIO=1'
$vcx = $vcx -replace [regex]::Escape('<AdditionalIncludeDirectories>..\..\src\common;..\..\include;.\;..\..\src\os\win;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>'), '<AdditionalIncludeDirectories>..\..\src\common;..\..\include;.\;..\..\src\os\win;..\..\..\ASIOSDK2\common;..\..\..\ASIOSDK2\host;..\..\..\ASIOSDK2\host\pc;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>'
$vcx = $vcx -replace [regex]::Escape('<ClCompile Include="..\..\src\common\pa_allocation.c" />'), "<ClCompile Include=`"..\..\src\hostapi\asio\pa_asio.cpp`" />`r`n    <ClCompile Include=`"..\..\..\ASIOSDK2\common\asio.cpp`" />`r`n    <ClCompile Include=`"..\..\..\ASIOSDK2\host\asiodrivers.cpp`" />`r`n    <ClCompile Include=`"..\..\..\ASIOSDK2\host\pc\asiolist.cpp`" />`r`n    <ClCompile Include=`"..\..\src\common\pa_allocation.c`" />"
$vcx = $vcx -replace [regex]::Escape('<ClCompile Include="..\..\src\os\win\pa_win_util.c" />'), "<ClCompile Include=`"..\..\src\os\win\pa_win_util.c`" />`r`n    <ClCompile Include=`"..\..\src\os\win\pa_win_version.c`" />"
$vcx = $vcx -replace [regex]::Escape('<AdditionalDependencies>ksuser.lib;%(AdditionalDependencies)</AdditionalDependencies>'), '<AdditionalDependencies>ksuser.lib;ole32.lib;%(AdditionalDependencies)</AdditionalDependencies>'

Set-Content -Path $VcxPath -Value $vcx -NoNewline

if ($vcx -notmatch 'ASIOSDK2\\common;\.\.\\\.\.\\\.\.\\ASIOSDK2\\host') {
  throw "AdditionalIncludeDirectories patch didn't match -- naudiodon's vcxproj may have changed. Inspect $VcxPath manually."
}

# --- 4. Build Release|x64 ---
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstallPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsInstallPath) { throw "No VS install with the C++ (VC.Tools.x86.x64) component found. Install the 'Desktop development with C++' workload first." }
$msbuild = Join-Path $vsInstallPath 'MSBuild\Current\Bin\MSBuild.exe'

Push-Location $PaMsvcDir
try {
  & $msbuild -nologo -p:Configuration=Release -p:Platform=x64 portaudio.vcxproj
  if ($LASTEXITCODE -ne 0) { throw "MSBuild failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}

# --- 5. Install into naudiodon and rebuild the JS binding against it ---
$BuiltDll = Join-Path $PaMsvcDir 'x64\Release\portaudio_x64.dll'
$BuiltLib = Join-Path $PaMsvcDir 'x64\Release\portaudio_x64.lib'
Copy-Item $BuiltDll (Join-Path $NaudiodonBin 'portaudio_x64.dll') -Force
Copy-Item $BuiltLib (Join-Path $NaudiodonBin 'portaudio_x64.lib') -Force

Push-Location $RepoRoot
try {
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  npm rebuild naudiodon 2>&1 | Out-Null
  $rebuildExit = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  if ($rebuildExit -ne 0) { throw "npm rebuild naudiodon failed (exit $rebuildExit)." }
} finally {
  Pop-Location
}

# --- 6. Verify ---
# naudiodon's own device/host-API enumeration prints diagnostic chatter to
# stderr (see the ASIO driver COM enumerator) -- same 'Continue' treatment.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$check = node -e "const n = require('naudiodon'); const apis = n.getHostAPIs().HostAPIs.map(a => a.name); console.log('RESULT:' + apis.join(','))" 2>&1 | Select-String '^RESULT:'
$ErrorActionPreference = $prevEAP
Write-Host "Host APIs: $check"
if ($check -match 'ASIO') {
  Write-Host "PASS -- ASIO is compiled in. Device count depends on what's physically connected/drivers installed." -ForegroundColor Green
} else {
  throw "ASIO not present after rebuild. Output: $check"
}
