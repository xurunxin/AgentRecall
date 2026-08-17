# verify-config.ps1
#
# End-to-end check: are .bridge.env and the running bridge in sync?
#
# Reports (always read-only, never modifies):
#   1. The raw contents of .bridge.env (what you wrote to disk)
#   2. What the bridge's /health actually reports (what is in memory)
#   3. The bridge process(es): pid, started-at, command line
#   4. Diff: any field where (1) and (2) disagree is flagged
#
# Usage:
#   powershell -File "G:\...\http-bridge\verify-config.ps1"
#   powershell -File "G:\...\http-bridge\verify-config.ps1" -Port 8080

[CmdletBinding()]
param(
    [int]$Port = 7781
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir ".bridge.env"
$RunCmd  = Join-Path $ScriptDir ".run-bridge.cmd"

function Read-EnvFile {
    if (-not (Test-Path $EnvFile)) { return $null }
    try { return (Get-Content $EnvFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Read-BridgeHealth {
    try {
        return Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
    } catch {
        return $null
    }
}

function Read-BridgeProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*bridge.mjs*" -and $_.CommandLine -like "*$Port*" } |
        ForEach-Object {
            [PSCustomObject]@{
                Pid = $_.ProcessId
                Started = $_.CreationDate
                Cmd = $_.CommandLine
            }
        }
}

$ok = $true

Write-Host "==============================================================="
Write-Host " agent-recall HTTP bridge: .env vs runtime"
Write-Host "==============================================================="
Write-Host "  port       : $Port"
Write-Host "  env file   : $EnvFile"
Write-Host "  run cmd    : $RunCmd"
Write-Host ""

# 1) .env
Write-Host "[1/4] .bridge.env (raw, what is on disk)"
Write-Host "---------------------------------------------------------------"
if (Test-Path $EnvFile) {
    $fi = Get-Item $EnvFile -Force
    Write-Host ("  size   = {0} bytes" -f $fi.Length)
    Write-Host ("  mtime  = {0}" -f $fi.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss.fff"))
    Write-Host ""
    $envObj = Read-EnvFile
    if ($envObj) {
        $envObj | Format-List | Out-String | ForEach-Object { Write-Host ("  " + $_) }
    } else {
        Write-Host "  (parse failed: not valid JSON)" -ForegroundColor Red
        $ok = $false
    }
} else {
    Write-Host "  (file missing)" -ForegroundColor Yellow
    $envObj = $null
}
Write-Host ""

# 2) /health
Write-Host "[2/4] bridge /health (what the running process reports)"
Write-Host "---------------------------------------------------------------"
$h = Read-BridgeHealth
if ($h) {
    Write-Host ("  mcp_home   = " + $h.mcp_home)
    Write-Host ("  mcp_actor  = " + $h.mcp_actor)
    Write-Host ("  mcp_profile= " + $h.mcp_profile)
    Write-Host ("  uptime_s   = " + $h.uptime_s)
    Write-Host ("  sessions   = " + $h.active_sessions)
} else {
    Write-Host "  bridge not responding on http://127.0.0.1:$Port" -ForegroundColor Red
    Write-Host "  (the bridge is not running)" -ForegroundColor Red
    $ok = $false
}
Write-Host ""

# 3) Processes
Write-Host "[3/4] bridge process(es)"
Write-Host "---------------------------------------------------------------"
$procs = @(Read-BridgeProcesses)
if ($procs.Count -eq 0) {
    Write-Host "  (no node bridge.mjs process found for port $Port)" -ForegroundColor Yellow
} else {
    foreach ($p in $procs) {
        Write-Host ("  pid     = {0}" -f $p.Pid)
        Write-Host ("  started = {0}" -f $p.Started)
        Write-Host ("  cmd     = {0}" -f $p.Cmd)
        Write-Host ""
    }
}
Write-Host ""

# 4) Diff
Write-Host "[4/4] diff (.env vs /health)"
Write-Host "---------------------------------------------------------------"
if ($envObj -and $h) {
    $checks = @(
        @{ name = "AGENT_RECALL_HOME";  env = $envObj.AGENT_RECALL_HOME;  rt = $h.mcp_home },
        @{ name = "AGENT_RECALL_ACTOR"; env = $envObj.AGENT_RECALL_ACTOR; rt = $h.mcp_actor },
        @{ name = "AGENT_RECALL_PROFILE"; env = $envObj.AGENT_RECALL_PROFILE; rt = $h.mcp_profile }
    )
    foreach ($c in $checks) {
        $envVal = $c.env
        $rtVal  = $c.rt
        if ($envVal -eq $rtVal) {
            Write-Host ("  [OK]   {0} = {1}" -f $c.name, $envVal) -ForegroundColor Green
        } else {
            Write-Host ("  [MISMATCH] {0}" -f $c.name) -ForegroundColor Red
            Write-Host ("           .env has : {0}" -f ($envVal ?? "<missing>"))
            Write-Host ("           bridge has: {0}" -f ($rtVal ?? "<missing>"))
            Write-Host "           -> bridge is long-running; only reads .env at start."
            Write-Host "           -> run: powershell -File install-windows-autostart.ps1 -RunNow"
            $ok = $false
        }
    }
} elseif (-not $h) {
    Write-Host "  bridge not running; diff skipped" -ForegroundColor Yellow
    $ok = $false
} else {
    Write-Host "  .env parse failed or missing; diff skipped" -ForegroundColor Yellow
    $ok = $false
}

Write-Host ""
Write-Host "==============================================================="
if ($ok) {
    Write-Host " RESULT: in sync" -ForegroundColor Green
    exit 0
} else {
    Write-Host " RESULT: out of sync or unreachable" -ForegroundColor Red
    Write-Host " hint:    powershell -File install-windows-autostart.ps1 -RunNow"
    exit 1
}
