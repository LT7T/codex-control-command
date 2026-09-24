[CmdletBinding()]
param()

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$configPath = Join-Path $PSScriptRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw "Missing control centre config: $configPath" }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$port = [int]$config.port
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'ControlCenter.mjs'))
$connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $connection) { Write-Output 'Codex Command and Control is not running.'; return }

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
if (-not $process -or
    [System.IO.Path]::GetFileName($process.ExecutablePath) -ne 'node.exe' -or
    -not $process.CommandLine -or
    $process.CommandLine.IndexOf($serverPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "Port $port belongs to another program; it was not stopped."
}

Stop-Process -Id $process.ProcessId -ErrorAction Stop
Write-Output 'Codex Command and Control stopped.'
