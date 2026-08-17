# install-windows-autostart.ps1
#
# 把 agent-recall HTTP 桥注册为"登录时自动启动"的服务
#
# 三种机制(自动选最适合的,推荐顺序):
#   1) Task Scheduler             [推荐,需要管理员,完全静默,支持失败重启]
#   2) HKCU\...\Run 注册表项     [非管理员 fallback,但启动时弹一个 cmd 窗口]
#   3) Startup folder 快捷方式     [非管理员 fallback,类似 RunKey]
#
# 推荐用 Task Scheduler,因为:
#   - Task Scheduler 通过 svchost 直接拉起指定程序,完全没有 cmd 中间层
#   - 失败自动重启(可配 interval / count)
#   - 可以用 schtasks /run 手动触发,跟 RunKey 一样的命令行体验
#   - 不需要引号包 cmd /c,绝对静默
#
# 用法:
#   .\install-windows-autostart.ps1                       # 注册(默认 task,如 admin)
#   .\install-windows-autostart.ps1 -Port 8080
#   .\install-windows-autostart.ps1 -Profile core
#   .\install-windows-autostart.ps1 -Method runkey        # 强制用 RunKey
#   .\install-windows-autostart.ps1 -Uninstall            # 卸载
#   .\install-windows-autostart.ps1 -Status               # 查看状态
#   .\install-windows-autostart.ps1 -RunNow               # 立刻启动

[CmdletBinding()]
param(
    [int]$Port = 7781,
    [ValidateSet("core", "extended", "admin")]
    [string]$Profile = "extended",
    [string]$Actor = "agent:http-bridge",
    [string]$DataHome = "$env:USERPROFILE\.agent-recall-http-bridge",
    [ValidateSet("auto", "runkey", "startup", "task")]
    [string]$Method = "auto",
    [switch]$UseBinary,           # prefer dist-bin/agent-recall-http-bridge-<plat>.exe (if present)
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeJs = Join-Path $ScriptDir "bridge.mjs"
$NodeExe = (Get-Command node).Source
$EnvFile = Join-Path $ScriptDir ".bridge.env"
$ShortcutName = "agent-recall-http-bridge.lnk"
$RunKeyName = "agent-recall-http-bridge"
$TaskName = "agent-recall-http-bridge"
$ProjectRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$DistBinDir = Join-Path $ProjectRoot "dist-bin"
$PlatTag = if ($IsWindows -or $env:OS -match "Windows") {
    "win32-x64"
} elseif ($IsLinux) {
    "linux-x64"
} elseif ($IsMacOS) {
    if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
        "darwin-arm64"
    } else { "darwin-x64" }
} else { "win32-x64" }
$BinExt = if ($PlatTag.StartsWith("win32")) { ".exe" } else { "" }
$BridgeExe = Join-Path $DistBinDir "agent-recall-http-bridge-$PlatTag$BinExt"

# Resolve which launcher to use: bun single-file binary (preferred,
# no Node.js required on the host) or `node bridge.mjs` (dev /
# fallback).  Both honour the same --project-root / port convention.
#
# Default: node.  The current `bun --compile` binary has a known
# Windows-only "exit 0 right after listen" issue (bun runtime treats
# empty event loop as "task finished" before HTTP server's listening
# callback fires), so the binary path is gated behind an explicit
# -UseBinary switch or AGENT_RECALL_BRIDGE_BINARY=1 env.  When that
# Windows issue is fixed upstream we can flip the default back.
function Resolve-Launcher {
    param([int]$Port)
    $useBinary = [bool]$UseBinary -or ($env:AGENT_RECALL_BRIDGE_BINARY -eq "1")
    if ($useBinary -and (Test-Path $BridgeExe)) {
        return @{
            Mode = "binary"
            Command = $BridgeExe
            Arguments = @("$Port")
            WorkingDirectory = $ScriptDir
            CmdFile = $null
        }
    }
    if ($useBinary -and -not (Test-Path $BridgeExe)) {
        Write-Host "  [launcher] binary requested but $BridgeExe not found; using node" -ForegroundColor Yellow
    }
    return @{
        Mode = "node"
        Command = $NodeExe
        Arguments = @($BridgeJs, "$Port")
        WorkingDirectory = $ScriptDir
        CmdFile = Join-Path $ScriptDir ".run-bridge.cmd"
    }
}

# ---- 检测权限 ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# ---- 辅助 ----
function Write-EnvFile {
    @{
        AGENT_RECALL_HOME = $DataHome
        AGENT_RECALL_PROFILE = $Profile
        AGENT_RECALL_ACTOR = $Actor
        AGENT_RECALL_SUPPRESS_MCP_DEPRECATION = "1"
        MCP_HTTP_PORT = "$Port"
    } | ConvertTo-Json | Out-File -Encoding utf8 $EnvFile
    Write-Host "  env file: $EnvFile" -ForegroundColor Green
}

function Get-Bridge-CommandLine {
    # Returns a .cmd wrapper used by RunKey / Startup shortcut /
    # manual Start-Process.  Picks the binary launcher if available
    # (no Node.js dependency on the host), otherwise falls back to
    # the Node.js launcher that runs bridge.mjs.
    $launcher = Resolve-Launcher -Port $Port
    if ($launcher.Mode -eq "binary") {
        # Binary mode: still emit a .cmd wrapper so the path is stable
        # for the RunKey value, but it just exec's the binary
        # (Windows GUI subsystem + .cmd wrapper is the same flash-free
        # pattern as the Node.js fallback).
        $cmdFile = $launcher.CmdFile
        if (-not $cmdFile) { $cmdFile = Join-Path $ScriptDir ".run-bridge.cmd" }
        $args = $launcher.Arguments -join " "
        @"
@echo off
REM agent-recall HTTP MCP bridge (binary mode, no Node.js needed)
cd /d "$ScriptDir"
"$($launcher.Command)" $args
"@ | Out-File -Encoding ascii $cmdFile
        return $cmdFile
    }
    # Node mode: thin wrapper around `node bridge.mjs`.  No `set`
    # instructions; env flows through .bridge.env.
    $cmdFile = $launcher.CmdFile
    $args = $launcher.Arguments -join " "
    @"
@echo off
REM agent-recall HTTP MCP bridge (env loaded from .bridge.env by bridge.mjs)
cd /d "$ScriptDir"
"$($launcher.Command)" $args
"@ | Out-File -Encoding ascii $cmdFile
    return $cmdFile
}

# ---- 注册方式 ----

function Install-RunKey {
    $cmd = Get-Bridge-CommandLine
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    if (-not (Test-Path $regPath)) {
        New-Item -Path $regPath -Force | Out-Null
    }
    # 注册表值用 cmd.exe /c 包一层,这样注册表 key 不需要引号转义
    $regValue = "cmd.exe /c `"$cmd`""
    Set-ItemProperty -Path $regPath -Name $RunKeyName -Value $regValue -Type String -Force
    Write-Host "  [RunKey] HKCU\...\Run\$RunKeyName = $regValue" -ForegroundColor Green
}

function Install-StartupShortcut {
    $cmd = Get-Bridge-CommandLine
    $startupDir = [Environment]::GetFolderPath("Startup")
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $startupDir $ShortcutName))
    $shortcut.TargetPath = $cmd
    $shortcut.WorkingDirectory = $ScriptDir
    $shortcut.WindowStyle = 7  # 隐藏窗口
    $shortcut.Description = "agent-recall HTTP MCP bridge (port $Port)"
    $shortcut.Save()
    Write-Host "  [Startup] $startupDir\$ShortcutName -> $cmd" -ForegroundColor Green
}

function Install-TaskScheduler {
    if (-not $isAdmin) {
        Write-Host "  [TaskScheduler] needs admin (UAC); falling back to RunKey" -ForegroundColor Yellow
        return $false
    }

    # Resolve launcher: prefer single-file binary (no Node.js needed
    # on the host) over `node bridge.mjs`.  The same XML body works for
    # both — only the <Command> / <Arguments> differ.
    $launcher = Resolve-Launcher -Port $Port
    if ($launcher.Mode -eq "binary") {
        Write-Host "  [TaskScheduler] launcher: bun single-file binary" -ForegroundColor DarkGray
    } else {
        Write-Host "  [TaskScheduler] launcher: node bridge.mjs (binary not found at $BridgeExe)" -ForegroundColor DarkGray
    }

    # Build a complete task XML.  Going through XML (instead of schtasks
    # /create with command-line flags) gives us:
    #   - LogonTrigger with 30s delay (user is settled when we fire)
    #   - RestartOnFailure (3 retries, 1 minute apart) — the schtasks
    #     command-line syntax does not expose this
    #   - RunLevel=LeastPrivilege, no UAC prompt on the user side
    #   - MultipleInstancesPolicy=IgnoreNew so an accidental manual
    #     launch does not fight the running bridge
    #   - Hidden Console off (we never allocate a console)
    $user = "$env:USERDOMAIN\$env:USERNAME"
    $xmlFile = Join-Path $ScriptDir ".task.xml"

    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$user</Author>
    <Description>agent-recall HTTP MCP bridge (Streamable HTTP) on http://127.0.0.1:$Port.  Silent launch: no cmd window.</Description>
    <URI>\$TaskName</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>$user</UserId>
      <Delay>PT30S</Delay>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$($launcher.Command)</Command>
      <Arguments>$(($launcher.Arguments -join ' '))</Arguments>
      <WorkingDirectory>$ScriptDir</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

    $xml | Out-File -Encoding utf8 $xmlFile
    schtasks.exe /delete /tn $TaskName /f 2>$null | Out-Null
    $output = schtasks.exe /create /tn $TaskName /xml $xmlFile /f 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [TaskScheduler] create failed: $output" -ForegroundColor Red
        return $false
    }
    $launcherMode = $launcher.Mode
    Write-Host "  [TaskScheduler] registered: $TaskName (LogonTrigger+30s, RestartOnFailure x3, no cmd window, launcher=$launcherMode)" -ForegroundColor Green

    # When task mode is active, the previous RunKey would cause a double
    # launch (RunKey fires one bridge, then Task fires another — the
    # second one EADDRINUSE's and dies).  Remove the RunKey if present.
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $prop = Get-ItemProperty -Path $regPath -Name $RunKeyName -ErrorAction SilentlyContinue
    if ($prop) {
        Remove-ItemProperty -Path $regPath -Name $RunKeyName -Force
        Write-Host "  [TaskScheduler] removed old RunKey entry to avoid double-launch" -ForegroundColor Green
    }
    return $true
}

function Uninstall-All {
    # Stop the bridge first so file handles are released
    Stop-Bridge
    # Run key
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    if (Test-Path $regPath) {
        $prop = Get-ItemProperty -Path $regPath -Name $RunKeyName -ErrorAction SilentlyContinue
        if ($prop) {
            Remove-ItemProperty -Path $regPath -Name $RunKeyName -Force
            Write-Host "  [RunKey] removed" -ForegroundColor Yellow
        }
    }
    # Startup shortcut
    $startupDir = [Environment]::GetFolderPath("Startup")
    $shortcutPath = Join-Path $startupDir $ShortcutName
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath -Force
        Write-Host "  [Startup] removed: $shortcutPath" -ForegroundColor Yellow
    }
    # Task Scheduler
    $existing = schtasks.exe /query /tn $TaskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        schtasks.exe /delete /tn $TaskName /f | Out-Null
        Write-Host "  [TaskScheduler] removed: $TaskName" -ForegroundColor Yellow
    }
    # Generated install artefacts — but NOT .bridge.env, which is the
    # user's configuration data and must survive a reinstall.
    foreach ($f in @((Join-Path $ScriptDir ".run-bridge.cmd"), (Join-Path $ScriptDir ".task.xml"))) {
        if (Test-Path $f) {
            Remove-Item $f -Force
            Write-Host "  [file] removed: $f" -ForegroundColor Yellow
        }
    }
    if (Test-Path $EnvFile) {
        Write-Host "  [kept] $EnvFile (your config — re-run with -DataHome / -Actor to change)" -ForegroundColor DarkGray
    }
}

function Show-Status {
    Write-Host "[status] config files:" -ForegroundColor Cyan
    foreach ($f in @($EnvFile, (Join-Path $ScriptDir ".run-bridge.cmd"))) {
        if (Test-Path $f) {
            Write-Host "  $f  ($(Get-Item $f).Length bytes)"
        } else {
            Write-Host "  $f  (not present)" -ForegroundColor DarkGray
        }
    }
    Write-Host ""
    Write-Host "[status] RunKey:" -ForegroundColor Cyan
    $regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $prop = Get-ItemProperty -Path $regPath -Name $RunKeyName -ErrorAction SilentlyContinue
    if ($prop) {
        Write-Host "  HKCU\...\Run\$RunKeyName = $($prop.$RunKeyName)" -ForegroundColor Green
    } else {
        Write-Host "  (not set)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "[status] Startup shortcut:" -ForegroundColor Cyan
    $shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) $ShortcutName
    if (Test-Path $shortcutPath) {
        Write-Host "  $shortcutPath  (exists)" -ForegroundColor Green
    } else {
        Write-Host "  (not present)" -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "[status] Task Scheduler:" -ForegroundColor Cyan
    schtasks.exe /query /tn $TaskName 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Host "  (not present)" -ForegroundColor DarkGray }
    Write-Host ""
    Write-Host "[status] Current bridge process:" -ForegroundColor Cyan
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*bridge.mjs*" } |
        ForEach-Object { Write-Host "  pid=$($_.ProcessId)  cmd=$($_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)))" }
    if (-not (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*bridge.mjs*" })) {
        Write-Host "  (no bridge process running)" -ForegroundColor DarkGray
    }
}

function Stop-Bridge {
    # Three-layer kill — handles the case where cmdline-matching alone misses
    # a stuck process (e.g. orphaned cmd.exe wrapper, or a process whose
    # command line isn't visible to the current CIM session).
    $killed = @()
    # 1) node.exe running bridge.mjs
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*bridge.mjs*" } |
        ForEach-Object {
            $killed += "node pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    # 2) cmd.exe wrapping .run-bridge.cmd (orphan wrappers)
    Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*run-bridge.cmd*" } |
        ForEach-Object {
            $killed += "cmd pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    # 3) port 7781 fallback — kill whoever is LISTENING on the port
    $occupying = & netstat.exe -ano 2>$null |
        Select-String "127\.0\.0\.1:$Port.*LISTENING" |
        ForEach-Object { ($_ -split '\s+')[-1] } |
        Where-Object { $_ -match '^\d+$' }
    foreach ($occPid in $occupying) {
        $killed += "port pid=$occPid"
        Stop-Process -Id $occPid -Force -ErrorAction SilentlyContinue
    }
    if ($killed.Count -gt 0) {
        Write-Host ("[run-now] stopped: " + ($killed -join ", ")) -ForegroundColor DarkGray
    } else {
        Write-Host "[run-now] no prior bridge to stop" -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 2
}

function Start-BridgeNow {
    # 停掉旧实例(三重保险,见 Stop-Bridge)
    Stop-Bridge

    # 如果 task 已注册,直接用 schtasks /run 触发 — 让 task 来拉起 node,
    # 这样它仍然在 task 的 RestartOnFailure 保护下;也避免我们手动启的进程
    # 跟 task 冲突。
    $taskExists = schtasks.exe /query /tn $TaskName 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[run-now] triggering Task Scheduler task $TaskName ..." -ForegroundColor Cyan
        $r = schtasks.exe /run /tn $TaskName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[run-now] task /run failed: $r" -ForegroundColor Red
            return
        }
    } else {
        # 没 task 注册 — 走老的"直接 cmd 启"路径(给 RunKey/Startup shortcut 用)
        $cmd = Get-Bridge-CommandLine
        Write-Host "[run-now] no task registered; starting via: $cmd" -ForegroundColor Cyan
        $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"$cmd`"" -WorkingDirectory $ScriptDir -WindowStyle Hidden -PassThru
        Write-Host "[run-now] spawned pid=$($proc.Id)" -ForegroundColor Green
    }

    # 等一下,看 health
    Start-Sleep -Seconds 4
    try {
        $h = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 5
        $currentPid = (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*bridge.mjs*" -and $_.CommandLine -like "*$Port*" } |
            Select-Object -First 1).ProcessId
        if ($h.uptime_s -lt 30 -and $currentPid -ne $null) {
            Write-Host "[run-now] bridge up (pid=$currentPid, uptime=$($h.uptime_s)s):" -ForegroundColor Green
            $h | ConvertTo-Json | Write-Host
        } else {
            Write-Host "[run-now] WARN: bridge responded but uptime=$($h.uptime_s)s is suspicious" -ForegroundColor Yellow
            Write-Host "[run-now]   listener=$currentPid — old process may still be holding the port" -ForegroundColor Yellow
            $h | ConvertTo-Json | Write-Host
        }
    } catch {
        Write-Host "[run-now] bridge not responding yet: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# ---- 入口 ----
if ($Uninstall) {
    Write-Host "=== uninstall ===" -ForegroundColor Yellow
    Uninstall-All
    Write-Host "DONE" -ForegroundColor Green
} elseif ($Status) {
    Write-Host "=== status ===" -ForegroundColor Cyan
    Show-Status
} elseif ($RunNow) {
    # -RunNow semantics:
    #   - no explicit param: leave .bridge.env untouched; just restart the bridge
    #   - with -DataHome / -Actor / -Port / -Profile: update only those keys;
    #     other keys are read back from the existing .env so a partial override
    #     does not stomp unrelated fields
    $envParamMap = @{
        DataHome = "AGENT_RECALL_HOME"
        Profile  = "AGENT_RECALL_PROFILE"
        Actor    = "AGENT_RECALL_ACTOR"
        Port     = "MCP_HTTP_PORT"
    }
    $existing = $null
    if (Test-Path $EnvFile) {
        try { $existing = Get-Content $EnvFile -Raw | ConvertFrom-Json } catch { $existing = $null }
    }
    $hasExplicit = $false
    foreach ($k in $envParamMap.Keys) {
        if ($PSBoundParameters.ContainsKey($k)) {
            $hasExplicit = $true
        } elseif ($existing -and $existing.PSObject.Properties.Name -contains $envParamMap[$k]) {
            # read back so Write-EnvFile won't reset unspecified keys to defaults
            $existingKey = $envParamMap[$k]
            $value = $existing.$existingKey
            Set-Variable -Name $k -Value $value -Scope 0
        }
    }
    if ($hasExplicit) {
        # build the "updated keys" list as a separate variable to avoid
        # nested $(...) inside a double-quoted Write-Host string
        $updated = @()
        foreach ($k in $envParamMap.Keys) {
            if ($PSBoundParameters.ContainsKey($k)) { $updated += $k }
        }
        $updatedList = $updated -join ", "
        Write-Host "[run-now] explicit param detected, partial update" -ForegroundColor Cyan
        Write-Host ("[run-now]   updated keys: " + $updatedList) -ForegroundColor DarkGray
        Write-EnvFile
        Get-Bridge-CommandLine | Out-Null
    } else {
        if ($existing) {
            Write-Host "[run-now] no override; keeping existing .bridge.env" -ForegroundColor DarkGray
        } else {
            Write-Host "[run-now] .bridge.env missing; generating from defaults" -ForegroundColor Yellow
            Write-EnvFile
            Get-Bridge-CommandLine | Out-Null
        }
    }
    Write-Host "=== run-now ===" -ForegroundColor Cyan
    Start-BridgeNow
} else {
    Write-Host "=== install (port=$Port profile=$Profile actor=$Actor dataHome=$DataHome) ===" -ForegroundColor Cyan
    Write-Host "  isAdmin=$isAdmin  method=$Method"
    Write-Host ""
    Write-Host "[1/2] writing config ..." -ForegroundColor Cyan
    Write-EnvFile
    Get-Bridge-CommandLine | Out-Null
    Write-Host ""
    Write-Host "[2/2] registering autostart ..." -ForegroundColor Cyan
    $chosen = $Method
    if ($chosen -eq "auto") {
        if ($isAdmin) { $chosen = "task" }
        else { $chosen = "runkey" }
    }
    switch ($chosen) {
        "runkey"  { Install-RunKey }
        "startup" { Install-StartupShortcut }
        "task"    {
            $ok = Install-TaskScheduler
            if (-not $ok) {
                Write-Host "  [install] task creation failed; falling back to RunKey" -ForegroundColor Yellow
                Install-RunKey
            }
        }
    }
    Write-Host ""
    Write-Host "DONE" -ForegroundColor Green
    # v1.1.6 follow-up E1 (issue #42, plan bfbd2cb):
    # these three Write-Host lines previously had CJK labels
    # inside the double-quoted string (验证 / 启动 / 卸载) plus a
    # nested `$PSCommandPath` interpolation. PowerShell 5.1's
    # tokenizer throws `MissingArrayIndexExpression` /
    # `ParserError` on the CJK + $(...) collision (see agent
    # memory "PowerShell 5.1 CJK + nested subexpression parse
    # bug"). The labels are hoisted to ASCII; the CJK lives in
    # this comment so the installer's CLI output is still
    # human-friendly when an operator runs it with a
    # CJK-aware console.
    Write-Host "  Verify:    powershell -File `"$PSCommandPath`" -Status"
    Write-Host "  RunNow:    powershell -File `"$PSCommandPath`" -RunNow"
    Write-Host "  Uninstall: powershell -File `"$PSCommandPath`" -Uninstall"
}
