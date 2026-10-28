# Lift the logged-in QQ Music client's web cookie out of its process memory and
# print it as JSON. Used by tools/lift-cookie.mjs; no user interaction needed.
#
# Why this works: the Windows client keeps its web-session cookie in memory as a
# plain "Cookie:" header for its embedded requests (qqmusic_uin / qqmusic_key),
# so scanning readable committed pages finds a live session without any
# scan-code UI. All messages are ASCII so Windows PowerShell 5.1 parses the file
# whatever the codepage is.
param([switch]$Json)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Add-Type -Path (Join-Path $here 'QqMemScan.cs')

$proc = Get-Process QQMusic -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) {
    if ($Json) { Write-Output '{"ok":false,"error":"QQMusicNotRunning"}' } else { Write-Output 'QQ Music client is not running; open and log in first.' }
    exit 2
}

$hits = [QqMemScan]::Scan($proc.Id, @('qqmusic_key=', 'qqmusic_uin=', 'wxopenid='), 2500MB)
if ($hits.Count -eq 0) {
    if ($Json) { Write-Output '{"ok":false,"error":"CookieNotFound"}' } else { Write-Output 'No session cookie found in memory (client not logged in?).' }
    exit 3
}

$best = $null
foreach ($hit in $hits) {
    $text = $hit.Substring($hit.IndexOf('|') + 1)
    $uinMatch = [regex]::Match($text, 'qqmusic_uin=(\d{3,})')
    if (-not $uinMatch.Success) { continue }
    $keyMatch = [regex]::Match($text, 'qqmusic_key=([A-Za-z0-9_\-]{40,})')
    if (-not $keyMatch.Success) { continue }
    $openid = [regex]::Match($text, 'wxopenid=([A-Za-z0-9_\-]+)')
    $candidate = "qqmusic_fromtag=54257;qqmusic_uin=$($uinMatch.Groups[1].Value);qqmusic_key=$($keyMatch.Groups[1].Value)"
    if ($openid.Success) { $candidate += ";wxopenid=$($openid.Groups[1].Value);tmeLoginType=2" }
    $entry = [pscustomobject]@{ uin = $uinMatch.Groups[1].Value; key = $keyMatch.Groups[1].Value; raw = $candidate; hasOpenid = $openid.Success }
    if ($null -eq $best -or ($entry.hasOpenid -and -not $best.hasOpenid)) { $best = $entry }
}

if ($null -eq $best) {
    if ($Json) { Write-Output '{"ok":false,"error":"ParseFailed"}' } else { Write-Output 'Cookie-like strings found but none parsed.' }
    exit 4
}

if ($Json) {
    [pscustomobject]@{ ok = $true; uin = $best.uin; key = $best.key; raw = $best.raw } | ConvertTo-Json -Compress
} else {
    Write-Output "uin=$($best.uin)"
    Write-Output "keyLength=$($best.key.Length)"
    Write-Output "cookie=$($best.raw)"
}
