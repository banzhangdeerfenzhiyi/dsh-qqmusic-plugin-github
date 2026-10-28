param([switch]$Deploy)
# Rebuild the custom WeChatAgent hook (with native voice support) without
# touching any file that the WeChatAgent release manifest manages.
#
# The app's bootstrap deployment rewrites scripts/build-hook.ps1 and
# scripts/native-hook/* from resources/project whenever it runs, so the trusted
# copies of the patched sources live in scripts/native-hook-voice/ and the app
# template was updated to the same content. This script only builds from
# state/hook/build-source, which deployment never touches.
$ErrorActionPreference = 'Stop'
$ws = 'D:\Administrator\Documents\data\workspace'
$keep = Join-Path $ws 'scripts\native-hook-voice'
$bs = Join-Path $ws 'state\hook\build-source'
$native = Join-Path $ws 'state\hook\native'
$vendor = 'D:\Administrator\Documents\app\resources\vendor\hook'
$appProject = 'D:\Administrator\Documents\app\resources\project'

foreach ($file in @('wechatagent_hook.cpp', 'voice_sender.cpp', 'voice_trace.cpp')) {
    Copy-Item -LiteralPath (Join-Path $keep $file) -Destination (Join-Path $bs ('src\' + $file)) -Force
}
foreach ($file in @('voice_sender.h', 'voice_trace.h')) {
    Copy-Item -LiteralPath (Join-Path $keep $file) -Destination (Join-Path $bs ('include\' + $file)) -Force
}

$project = Join-Path $bs 'x64_Version_dll.vcxproj'
$vcx = Get-Content -LiteralPath $project -Raw -Encoding UTF8
foreach ($entry in @('voice_trace.cpp', 'voice_sender.cpp')) {
    $needle = '<ClCompile Include="src\' + $entry + '" />'
    if ($vcx -notmatch [regex]::Escape($needle)) {
        $vcx = $vcx -replace '(?s)(<ClCompile Include="src\\http_routes\.cpp" />)', ('$1<ClCompile Include="src\' + $entry + '" />')
    }
}
[IO.File]::WriteAllText($project, $vcx, [Text.UTF8Encoding]::new($false))

$msbuild = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
if (-not (Test-Path -LiteralPath $msbuild)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msbuild = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1)
}
if (-not $msbuild) { throw 'MSBuild not found' }
& $msbuild $project /m /t:Build /p:Configuration=Release /p:Platform=x64 /p:PlatformToolset=v145 /v:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw 'Hook build failed' }

$dll = Join-Path $bs 'x64\Release\version.dll'
$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Force -Path $native | Out-Null
Copy-Item -LiteralPath $dll -Destination (Join-Path $native 'version.dll') -Force
$manifest = Get-Content -LiteralPath (Join-Path $native 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.sha256 = $hash
[IO.File]::WriteAllText((Join-Path $native 'build.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

# The app re-installs vendor/hook/version.dll over state/hook/native on every
# bootstrap; keeping the vendor copy in sync makes our build the deployed one.
if (Test-Path -LiteralPath $vendor) {
    Copy-Item -LiteralPath $dll -Destination (Join-Path $vendor 'version.dll') -Force
    $vendorManifest = Get-Content -LiteralPath (Join-Path $vendor 'build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $vendorManifest.sha256 = $hash
    [IO.File]::WriteAllText((Join-Path $vendor 'build.json'), ($vendorManifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    Write-Output 'vendor hook updated'
}

Write-Output ('voice hook built: sha256=' + $hash)
if ($Deploy) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ws 'scripts\deploy-hook.ps1')
}
