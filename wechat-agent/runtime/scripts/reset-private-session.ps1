# One-shot maintenance: reset ONLY the private chat's social session while DSH is
# not running, then start DSH again.
#
# Run from a scheduled task so it survives the DSH shutdown:
#   1. wait until no DeepSeek Harness process is running (max 15 min)
#   2. back up + edit state/accounts/*/dsh-sessions.json
#        - delete conversations["wechat:private:<改为你的私聊 chatKey>"]
#        - bump profiles["wechat:private:<改为你的私聊 chatKey>"].generation
#   3. launch DeepSeek Harness again
#   4. remove this scheduled task and leave a log
$ErrorActionPreference = 'Stop'
$workspace = 'D:\Administrator\Documents\data\workspace'
$accountDir = Join-Path $workspace 'state\accounts'
$stateFile = (Get-ChildItem $accountDir -Directory | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'dsh-sessions.json' })
$chatKey = 'wechat:private:<改为你的私聊 chatKey>'
$logFile = Join-Path $workspace 'state\reset-private-session.log'
$exe = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$taskName = 'DSH-Voice-Reset-Private-Session'

function Log([string]$line) {
    $text = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' ' + $line
    Add-Content -LiteralPath $logFile -Value $text -Encoding UTF8
}

try {
    Log 'started; waiting for DeepSeek Harness to exit'
    $deadline = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $deadline) {
        $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
        if ($running.Count -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
        Log 'DSH still running after 15 minutes; aborting without changing state'
        exit 1
    }
    Log 'DSH is not running; editing session mapping'

    $data = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldSession = $data.conversations.PSObject.Properties[$chatKey].Value
    if (-not $oldSession) {
        Log 'no mapping for the private chat; nothing to reset'
    } else {
        Copy-Item -LiteralPath $stateFile -Destination ($stateFile + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
        $profile = $data.profiles.PSObject.Properties[$chatKey].Value
        $generation = 0
        if ($null -ne $profile -and $null -ne $profile.generation) { $generation = [int]$profile.generation }
        $data.conversations.PSObject.Properties.Remove($chatKey)
        $newProfile = [ordered]@{}
        if ($null -ne $profile) {
            foreach ($property in $profile.PSObject.Properties) {
                if ($property.Name -in @('generation', 'initializations', 'compactions', 'cache', 'context')) { continue }
                $newProfile[$property.Name] = $property.Value
            }
        }
        $newProfile['generation'] = $generation + 1
        $newProfile['initializations'] = 0
        $newProfile['compactions'] = 0
        $newProfile['cache'] = [pscustomobject]@{}
        $data.profiles | Add-Member -NotePropertyName $chatKey -NotePropertyValue ([pscustomobject]$newProfile) -Force
        $json = $data | ConvertTo-Json -Depth 40
        $temp = $stateFile + '.tmp'
        [IO.File]::WriteAllText($temp, $json + "`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $stateFile -Force
        Log ('reset private chat: oldSession=' + $oldSession + ' newGeneration=' + ($generation + 1))
    }

    Log 'launching DSH'
    Start-Process -FilePath $exe
    Start-Sleep -Seconds 3
} catch {
    Log ('failed: ' + $_.Exception.Message)
} finally {
    try { schtasks /delete /tn $taskName /f | Out-Null } catch {}
}

