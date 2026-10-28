param([switch]$RelaunchOnly)
$ErrorActionPreference = 'Stop'
$client = 'D:\Administrator\Documents\data\workspace\state\hook\wechat-4.1.10.27'
$native = 'D:\Administrator\Documents\data\workspace\state\hook\native'
$exe = Join-Path $client 'Weixin.exe'
$token = (Get-Content (Join-Path $client 'wechatagent-hook.token') -Raw).Trim()
function Stop-BotWeChat {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($client, [StringComparison]::OrdinalIgnoreCase) })
    if ($procs.Count) {
        Write-Output ("stopping bot WeChat pids: " + ($procs.ProcessId -join ','))
        $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        for ($i=0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            $left = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($client, [StringComparison]::OrdinalIgnoreCase) })
            if (-not $left.Count) { break }
        }
    }
}
function Start-BotWeChat {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $p = Start-Process -FilePath $exe -ArgumentList 'StartPort=30001 CallBackURL="http://127.0.0.1:8766/unused"' -WorkingDirectory $client -PassThru
        Write-Output ("started bot WeChat pid=" + $p.Id + " attempt=" + $attempt)
        for ($i = 0; $i -lt 12; $i++) {
            Start-Sleep -Seconds 1
            if (Get-Process -Id $p.Id -ErrorAction SilentlyContinue) { return }
        }
        Write-Output 'launcher exited within 12s; retrying'
    }
    throw 'bot WeChat process could not be kept alive'
}
function Wait-Hook([int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:30001/WeChatAgent/health' -Headers @{Authorization=('Bearer '+$token)} -TimeoutSec 2
            if ($health.startupState -eq 'ready' -and $health.pid) {
                Write-Output ('hook ready pid=' + $health.pid + ' version=' + $health.version + ' accounts=' + ($health.databaseAccounts -join ','))
                return $health
            }
        } catch {}
        Start-Sleep -Milliseconds 800
    } while ((Get-Date) -lt $deadline)
    throw 'hook did not become ready in time'
}

function Get-ClientAcl($Client) { return (Get-Acl -LiteralPath $Client) }
function Set-ClientAcl($Client, $Acl) { Set-Acl -LiteralPath $Client -AclObject $Acl }
function Open-ClientForWrite($Client) {
    $backupFile = 'D:\Administrator\Documents\data\workspace\state\hook\client-pin-acl.json'
    $saved = Get-Content -LiteralPath $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([IO.Path]::GetFullPath($saved.path) -ne $Client) { throw 'saved pin permissions belong to a different directory' }
    $acl = Get-Acl -LiteralPath $Client
    $script:restoreSddl = $saved.sddl
    $acl.SetSecurityDescriptorSddlForm($saved.sddl)
    Set-Acl -LiteralPath $Client -AclObject $acl
    Write-Output 'released client directory write protection'
}
function Close-ClientAfterWrite($Client) {
    $acl = Get-Acl -LiteralPath $Client
    $acl.SetSecurityDescriptorSddlForm($script:restoreSddl)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $Client -AclObject $acl
    Write-Output 're-pinned client directory'
}

Stop-BotWeChat
if (-not $RelaunchOnly) {
    $dll = Join-Path $native 'version.dll'
    if (-not (Test-Path -LiteralPath $dll)) { throw 'built version.dll missing' }
    Open-ClientForWrite $client
    try {
        Copy-Item -LiteralPath $dll -Destination (Join-Path $client 'version.dll') -Force
    } finally {
        Close-ClientAfterWrite $client
    }
    Write-Output ('deployed version.dll sha256=' + (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant())
}
Start-BotWeChat
$health = Wait-Hook 120
# health JSON is the deployment confirmation for this turn
$health | ConvertTo-Json -Depth 4
