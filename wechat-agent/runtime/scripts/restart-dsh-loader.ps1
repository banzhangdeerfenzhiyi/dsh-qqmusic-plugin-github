# Restart DSH shortly after this reply is delivered, so the fixed voice plugin
# module is loaded. No files are modified.
$ErrorActionPreference = 'Stop'
$exe = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
$logFile = 'D:\Administrator\Documents\data\workspace\state\dsh-auto-restart.log'
function Log([string]$line) {
    $text = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz') + ' ' + $line
    Add-Content -LiteralPath $logFile -Value $text -Encoding UTF8
}
try {
    Log 'auto restart scheduled; waiting 60s for the reply to be delivered'
    Start-Sleep -Seconds 60
    $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -lt (Get-Date) })
    Log ('stopping ' + $running.Count + ' DeepSeek Harness processes')
    $running | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
    Start-Sleep -Seconds 3
    $left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Milliseconds 500 }
    Log 'launching DSH'
    Start-Process -FilePath $exe
} catch {
    Log ('failed: ' + $_.Exception.Message)
    try { Start-Process -FilePath $exe } catch {}
}
