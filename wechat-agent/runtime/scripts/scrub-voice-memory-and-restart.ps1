# Wait for DSH to exit, scrub only the old "no microphone" claims from social
# session histories, then start DSH again.
$ErrorActionPreference = 'Stop'
$workspace = 'D:\Administrator\Documents\data\workspace'
$python = 'C:\Users\Administrator\.dsh\napcat-boot\tts-venv\Scripts\python.exe'
$scrub = Join-Path $workspace 'scripts\scrub-voice-memory.py'
$logFile = Join-Path $workspace 'state\scrub-voice-memory.log'
$exe = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

function Log([string]$line) {
    $text = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' ' + $line
    Add-Content -LiteralPath $logFile -Value $text -Encoding UTF8
}

try {
    Log 'helper started; waiting for DeepSeek Harness to exit'
    $deadline = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    if (@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) {
        Log 'DSH still running after 15 minutes; aborting'
        exit 1
    }
    Log 'DSH stopped; scrubbing session histories'
    & $python $scrub 2>&1 | ForEach-Object { Log ('scrub: ' + $_) }
    Log ('scrub exit code: ' + $LASTEXITCODE)
    Log 'launching DSH'
    Start-Process -FilePath $exe
} catch {
    Log ('failed: ' + $_.Exception.Message)
    try { Start-Process -FilePath $exe } catch {}
}
