[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$ShowResult,
    [ValidateRange(0, 10000)]
    [int]$DelayMilliseconds = 0
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Test-PathStartsWith {
    param([AllowNull()][string]$Candidate, [AllowNull()][string]$Root)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $normalRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
        $normalCandidate = [System.IO.Path]::GetFullPath($Candidate)
        return $normalCandidate.StartsWith($normalRoot, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Get-CodexAppProcesses($Package) {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        $_.Name -eq 'ChatGPT.exe' -and (Test-PathStartsWith -Candidate $_.ExecutablePath -Root $Package.InstallLocation)
    })
}

function Get-CodexRuntimeProcesses($Package, [string[]]$RuntimeRoots) {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
        if ($_.Name -ne 'codex.exe') { return $false }
        if (Test-PathStartsWith -Candidate $_.ExecutablePath -Root $Package.InstallLocation) { return $true }
        foreach ($root in $RuntimeRoots) {
            if (Test-PathStartsWith -Candidate $_.ExecutablePath -Root $root) { return $true }
        }
        return $false
    })
}

function Wait-ForExit([scriptblock]$GetProcesses, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $remaining = @(& $GetProcesses)
        if ($remaining.Count -eq 0) { return @() }
        Start-Sleep -Milliseconds 350
    } while ((Get-Date) -lt $deadline)
    return @(& $GetProcesses)
}

function Get-ControlCenterProcess {
    $configPath = Join-Path $PSScriptRoot 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $port = [int]$config.port
    $serverPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'ControlCenter.mjs'))
    $connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $connection) { return $null }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    if ($candidate -and
        [System.IO.Path]::GetFileName($candidate.ExecutablePath) -eq 'node.exe' -and
        $candidate.CommandLine -and
        $candidate.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $candidate
    }
    return $null
}

function Show-Outcome([string]$Message, [bool]$Failed) {
    if (-not $ShowResult) { return }
    Add-Type -AssemblyName System.Windows.Forms
    $icon = if ($Failed) { [System.Windows.Forms.MessageBoxIcon]::Error } else { [System.Windows.Forms.MessageBoxIcon]::Information }
    [System.Windows.Forms.MessageBox]::Show($Message, 'Codex Command and Control', 'OK', $icon) | Out-Null
}

try {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object { [version]$_.Version } -Descending | Select-Object -First 1
    if (-not $package) { throw 'The supported OpenAI Codex Windows package is not installed.' }
    $runtimeRoots = @(
        (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'),
        (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin')
    )
    $appProcesses = @(Get-CodexAppProcesses -Package $package)
    $runtimeProcesses = @(Get-CodexRuntimeProcesses -Package $package -RuntimeRoots $runtimeRoots)
    $controlProcess = Get-ControlCenterProcess
    $result = [ordered]@{
        Tool = 'Codex Command and Control'
        DryRun = [bool]$DryRun
        PackageVersion = $package.Version.ToString()
        AppProcessIds = @($appProcesses.ProcessId)
        RuntimeProcessIds = @($runtimeProcesses.ProcessId)
        ControlCenterProcessId = if ($controlProcess) { $controlProcess.ProcessId } else { $null }
        Success = $false
        Error = $null
    }

    if (-not $DryRun) {
        if ($DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
        foreach ($process in $appProcesses) {
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        }
        $remainingApps = @(Wait-ForExit -GetProcesses { Get-CodexAppProcesses -Package $package } -TimeoutSeconds 15)
        if ($remainingApps.Count -gt 0) { throw "Some Codex desktop processes did not exit: $($remainingApps.ProcessId -join ', ')" }

        foreach ($process in @(Get-CodexRuntimeProcesses -Package $package -RuntimeRoots $runtimeRoots)) {
            if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
        }
        $remainingRuntimes = @(Wait-ForExit -GetProcesses { Get-CodexRuntimeProcesses -Package $package -RuntimeRoots $runtimeRoots } -TimeoutSeconds 10)
        if ($remainingRuntimes.Count -gt 0) { throw "Some Codex runtime processes did not exit: $($remainingRuntimes.ProcessId -join ', ')" }

        if ($controlProcess -and (Get-Process -Id $controlProcess.ProcessId -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $controlProcess.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    $result.Success = $true
    $message = if ($DryRun) { 'Dry run complete. Nothing was stopped.' } else { 'Local Codex work was stopped and the Codex app was closed.' }
    $result | ConvertTo-Json -Depth 4 -Compress
    Show-Outcome -Message $message -Failed $false
}
catch {
    $message = $_.Exception.Message
    Show-Outcome -Message $message -Failed $true
    Write-Error $message
    exit 1
}
